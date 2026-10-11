import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BYBIT_KLINE_SOURCE, DAY_MS, MINUTE_MS, RV_METHOD, cacheFromMinuteProfile, cachedVolatilityRows, calculateMinuteReturns,
  fetchBybitMinuteCloses, fullUtcWindow, researchVolatility, type RealizedVolatilityCache } from '../server/realized-volatility';

const end = Date.UTC(2026, 8, 30), start = end - 30 * DAY_MS;
const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function completeCache(): RealizedVolatilityCache {
  const candles = Array.from({ length: 43201 }, (_, i) => ({ startTime: start + (i - 1) * MINUTE_MS, close: 100 * Math.exp(i * .00001) }));
  return { schemaVersion: 1, generatedAt: end + 1000, source: BYBIT_KLINE_SOURCE, category: 'spot', quote: 'USDT', intervalMs: 60000,
    method: RV_METHOD, annualizationDays: 365, provenance: { kind: 'public-klines' }, window: { start, end, days: 30, timezone: 'UTC' },
    assets: { BTC: { underlying: 'BTC', symbol: 'BTCUSDT', status: 'complete', retrievedAt: end + 1000, venueTime: end + 500,
      error: null, statistics: calculateMinuteReturns(candles, start, end) } } };
}
describe('realized volatility from consecutive minute closes', () => {
  it('matches independent log-return arithmetic and uses 365 calendar days', () => {
    const prices = [100, 100 * Math.exp(.01), 100 * Math.exp(-.01), 100 * Math.exp(-.005)];
    const candles = prices.map((close, i) => ({ startTime: start + (i - 1) * MINUTE_MS, close })).reverse();
    const stats = calculateMinuteReturns(candles, start, start + 3 * MINUTE_MS);
    const squareSum = .01 ** 2 + (-.02) ** 2 + .005 ** 2;
    expect(stats.sumSquaredReturns).toBeCloseTo(squareSum, 13);
    expect(stats.meanMinuteLogReturn).toBeCloseTo(-.005 / 3, 13);
    expect(stats.annualized).toBeCloseTo(Math.sqrt(squareSum / 3 * 365 * 1440), 11);
    expect(stats).toMatchObject({ complete: true, observedReturns: 3, observedCandles: 4, missingReturns: 0 });
    expect(fullUtcWindow(end + 13 * 3600000)).toEqual({ start, end, days: 30, timezone: 'UTC' });
  });
  it('does not bridge missing minutes or replace their returns with zeros', () => {
    const stats = calculateMinuteReturns([
      { startTime: start - MINUTE_MS, close: 100 }, { startTime: start + MINUTE_MS, close: 121 },
      { startTime: start + 2 * MINUTE_MS, close: 133.1 },
    ], start, start + 3 * MINUTE_MS);
    expect(stats).toMatchObject({ complete: false, observedReturns: 1, missingCandles: 1, missingReturns: 2, annualized: null });
    expect(stats.sumSquaredReturns).toBeCloseTo(Math.log(1.1) ** 2, 12);
    expect(stats.missingReturnRanges).toEqual([{ start, end: start + 2 * MINUTE_MS }]);
  });
  it('deduplicates consistent candles and rejects conflicting duplicates and bad prices', () => {
    const seed = { startTime: start - MINUTE_MS, close: 100 }, next = { startTime: start, close: 101 };
    expect(calculateMinuteReturns([seed, next, next], start, start + MINUTE_MS).duplicateCandles).toBe(1);
    expect(() => calculateMinuteReturns([seed, next, { ...next, close: 102 }], start, start + MINUTE_MS)).toThrow(/Conflicting/);
    expect(() => calculateMinuteReturns([seed, { ...next, close: 0 }], start, start + MINUTE_MS)).toThrow(/positive closes/);
  });
});

describe('historical RV cache and explicit profile migration', () => {
  it('validates completeness, supplied dates, method and moments before publishing RV', () => {
    const cache = completeCache(), rows = cachedVolatilityRows(cache, end + 1000);
    expect(rows.BTC!.annualized).toBeCloseTo(.00001 * Math.sqrt(525600), 11);
    expect(rows.BTC).toMatchObject({ start, end, samples: 43200 });
    expect(rows.BTC!.source).toContain('cached historical');
    for (const mutate of [
      (c: any) => { c.annualizationDays = 252; }, (c: any) => { c.window.end += DAY_MS; },
      (c: any) => { c.assets.BTC.statistics.observedReturns--; }, (c: any) => { c.assets.BTC.statistics.annualized = 9; },
      (c: any) => { c.assets.BTC.status = 'incomplete'; },
    ]) { const changed = structuredClone(cache); mutate(changed); expect(cachedVolatilityRows(changed, end + 1000)).toEqual({}); }
  });
  it('records rounded-profile provenance without claiming original candle verification', () => {
    const lines = ['symbol,utc_minute,observations,mean_return_bps,rms_return_bps', ...Array.from({ length: 1440 }, (_, i) =>
      `BTCUSDT,${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')},30,0,2`)];
    const text = lines.join('\n'), imported = cacheFromMinuteProfile(text, start, end, 'profile.csv', end + 1000);
    expect(imported.provenance.kind).toBe('rounded-minute-profile');
    expect(imported.assets.BTC!.statistics!.observedCandles).toBeNull();
    const rows = cachedVolatilityRows(imported, end + 1000);
    expect(rows.BTC!.annualized).toBeCloseTo(.0002 * Math.sqrt(525600), 12);
    expect(rows.BTC!.source).toContain('raw candles unverified');
    expect(() => cacheFromMinuteProfile(text, start, end + DAY_MS, 'profile.csv', end + DAY_MS)).toThrow(/30-day/);
    expect(() => cacheFromMinuteProfile(lines.slice(0, -1).join('\n'), start, end, 'profile.csv', end + 1000)).toThrow(/Incomplete/);
    expect(() => cacheFromMinuteProfile(`${text}\n${lines[1]}`, start, end, 'profile.csv', end + 1000)).toThrow(/Duplicate/);
  });
  it('shows fresh installs as unavailable, reuses parsed data, and sees atomic cache replacements', () => {
    const folder = mkdtempSync(join(tmpdir(), 'deltaform-rv-')); folders.push(folder); const path = join(folder, 'cache.json');
    expect(researchVolatility(path)).toEqual({});
    const cache = completeCache(); writeFileSync(path, JSON.stringify(cache));
    const first = researchVolatility(path); expect(first.BTC).toBeDefined(); expect(researchVolatility(path)).toBe(first);
    writeFileSync(path, JSON.stringify({ ...cache, assets: {} })); utimesSync(path, new Date(), new Date(Date.now() + 1000));
    expect(researchVolatility(path)).toEqual({});
  });
});

function payload(rows: [number, number][], time = start + 3 * MINUTE_MS) {
  return { retCode: 0, time, result: { symbol: 'BTCUSDT', category: 'spot', list: rows.map(([t, p]) => [String(t), String(p), String(p), String(p), String(p), '0', '0']) } };
}
describe('bounded public Bybit pagination', () => {
  it('paginates backwards to the pre-window close and obtains exactly consecutive returns', async () => {
    const mock = vi.fn().mockResolvedValueOnce(Response.json(payload([[start + MINUTE_MS, 121], [start, 110]])))
      .mockResolvedValueOnce(Response.json(payload([[start - MINUTE_MS, 100]])));
    const sleep = vi.fn(async () => {});
    const result = await fetchBybitMinuteCloses('BTC', start, start + 2 * MINUTE_MS, { fetch: mock, sleep });
    expect(result.pages).toBe(2); expect(calculateMinuteReturns(result.candles, start, start + 2 * MINUTE_MS).observedReturns).toBe(2);
    const first = mock.mock.calls[0]![0] as URL, second = mock.mock.calls[1]![0] as URL;
    expect(first.origin + first.pathname).toBe(BYBIT_KLINE_SOURCE); expect(first.searchParams.get('category')).toBe('spot');
    expect(first.searchParams.get('start')).toBe(String(start - MINUTE_MS)); expect(second.searchParams.get('end')).toBe(String(start - 1));
    expect(mock.mock.calls[0]![1]).not.toHaveProperty('headers');
  });
  it('retries rate limits with bounded backoff and does not retry access denial', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(Response.json(payload([[start, 110], [start - MINUTE_MS, 100]])));
    const sleep = vi.fn(async () => {});
    await fetchBybitMinuteCloses('BTC', start, start + MINUTE_MS, { fetch: mock, sleep });
    expect(mock).toHaveBeenCalledTimes(2); expect(sleep).toHaveBeenCalledWith(300);
    const blocked = vi.fn(async () => new Response('', { status: 403 }));
    await expect(fetchBybitMinuteCloses('BTC', start, start + MINUTE_MS, { fetch: blocked, sleep })).rejects.toThrow(/HTTP 403/);
    expect(blocked).toHaveBeenCalledTimes(1);
  });
  it('enforces page bounds and rejects open or incompatible candles', async () => {
    const fetch = vi.fn(async () => Response.json(payload([[start, 100]])));
    await expect(fetchBybitMinuteCloses('BTC', start, start + MINUTE_MS, { fetch, sleep: async () => {}, maxPages: 1 })).rejects.toThrow(/pagination limit/);
    expect(fetch).toHaveBeenCalledTimes(1);
    const open = vi.fn(async () => Response.json(payload([[start, 100]], start + 1)));
    await expect(fetchBybitMinuteCloses('BTC', start, start + MINUTE_MS, { fetch: open })).rejects.toThrow(/unclosed/);
    const wrong = vi.fn(async () => Response.json({ ...payload([]), result: { symbol: 'ETHUSDT', category: 'spot', list: [] } }));
    await expect(fetchBybitMinuteCloses('BTC', start, start + MINUTE_MS, { fetch: wrong })).rejects.toThrow(/schema/);
  });
});
