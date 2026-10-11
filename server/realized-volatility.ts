import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isUnderlying, type Underlying } from '../src/shared/assets';
import type { AssetOverview } from '../src/shared/multi-asset';

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
export const RV_CACHE_PATH = 'data/realized-volatility.json';
export const BYBIT_KLINE_SOURCE = 'https://api.bybit.com/v5/market/kline';
export const RV_METHOD = 'rms-of-consecutive-one-minute-close-log-returns';
export interface MinuteClose { startTime: number; close: number }
export interface ReturnStatistics {
  expectedReturns: number; observedReturns: number; expectedCandles: number; observedCandles: number | null;
  duplicateCandles: number | null; missingReturns: number; missingCandles: number | null;
  missingReturnRanges: { start: number; end: number }[];
  sumSquaredReturns: number; meanMinuteLogReturn: number | null; rmsMinuteLogReturn: number | null;
  annualized: number | null; complete: boolean;
}
export interface RealizedVolatilityEntry {
  underlying: Underlying; symbol: string; status: 'complete' | 'incomplete' | 'unavailable';
  retrievedAt: number; venueTime: number | null; error: string | null; statistics: ReturnStatistics | null;
}
export interface RealizedVolatilityCache {
  schemaVersion: 1; generatedAt: number; source: typeof BYBIT_KLINE_SOURCE; category: 'spot'; quote: 'USDT';
  intervalMs: 60000; method: typeof RV_METHOD; annualizationDays: 365;
  provenance: { kind: 'public-klines' } | { kind: 'rounded-minute-profile'; sourceFile: string; sha256: string; note: string };
  window: { start: number; end: number; days: 30; timezone: 'UTC' };
  assets: Partial<Record<Underlying, RealizedVolatilityEntry>>;
}

/** [start,end) selects candle start times. The first return needs the preceding candle.
 * A gap is excluded, never replaced by a zero or a multi-minute jump. */
export function calculateMinuteReturns(candles: MinuteClose[], start: number, end: number): ReturnStatistics {
  if (![start, end].every(t => Number.isSafeInteger(t) && t % MINUTE_MS === 0) || end <= start) throw new Error('RV window must contain aligned whole minutes.');
  const expectedReturns = (end - start) / MINUTE_MS;
  if (expectedReturns > 366 * 1440) throw new Error('RV window exceeds the bounded calculation limit.');
  const closes = new Map<number, number>();
  let duplicateCandles = 0;
  for (const candle of candles) {
    if (!Number.isSafeInteger(candle.startTime) || candle.startTime % MINUTE_MS || !Number.isFinite(candle.close) || candle.close <= 0) throw new Error('RV candles require minute-aligned timestamps and positive closes.');
    if (candle.startTime < start - MINUTE_MS || candle.startTime >= end) continue;
    if (closes.has(candle.startTime)) {
      if (closes.get(candle.startTime) !== candle.close) throw new Error('Conflicting closed candles at the same timestamp.');
      duplicateCandles++;
    }
    closes.set(candle.startTime, candle.close);
  }
  let observedReturns = 0, sumReturns = 0, sumSquaredReturns = 0;
  const missingReturnRanges: { start: number; end: number }[] = [];
  for (let timestamp = start; timestamp < end; timestamp += MINUTE_MS) {
    const previous = closes.get(timestamp - MINUTE_MS), current = closes.get(timestamp);
    if (previous === undefined || current === undefined) {
      const last = missingReturnRanges.at(-1);
      if (last?.end === timestamp) last.end += MINUTE_MS;
      else missingReturnRanges.push({ start: timestamp, end: timestamp + MINUTE_MS });
      continue;
    }
    const value = Math.log(current) - Math.log(previous);
    observedReturns++; sumReturns += value; sumSquaredReturns += value * value;
  }
  const complete = observedReturns === expectedReturns;
  const rmsMinuteLogReturn = observedReturns ? Math.sqrt(sumSquaredReturns / observedReturns) : null;
  return { expectedReturns, observedReturns, expectedCandles: expectedReturns + 1, observedCandles: closes.size,
    duplicateCandles, missingReturns: expectedReturns - observedReturns, missingCandles: expectedReturns + 1 - closes.size,
    missingReturnRanges, sumSquaredReturns, meanMinuteLogReturn: observedReturns ? sumReturns / observedReturns : null,
    rmsMinuteLogReturn, annualized: complete ? rmsMinuteLogReturn! * Math.sqrt(365 * 1440) : null, complete };
}

/** Complete UTC days only; timezone and sampling convention are retained in the artifact. */
export function fullUtcWindow(now = Date.now()) {
  const end = Math.floor(now / DAY_MS) * DAY_MS;
  return { start: end - 30 * DAY_MS, end, days: 30 as const, timezone: 'UTC' as const };
}

/** Validate metadata and independently rederive the reported aggregate from stored moments. */
export function cachedVolatilityRows(input: unknown, now = Date.now()): Record<string, AssetOverview['realizedVolatility']> {
  if (!input || typeof input !== 'object') return {};
  const cache = input as RealizedVolatilityCache, window = cache.window;
  if (cache.schemaVersion !== 1 || cache.source !== BYBIT_KLINE_SOURCE || cache.category !== 'spot' || cache.quote !== 'USDT'
    || cache.intervalMs !== MINUTE_MS || cache.method !== RV_METHOD || cache.annualizationDays !== 365
    || !Number.isFinite(cache.generatedAt) || cache.generatedAt > now + MINUTE_MS || !window
    || window.timezone !== 'UTC' || window.days !== 30 || !Number.isSafeInteger(window.start) || !Number.isSafeInteger(window.end)
    || window.start % DAY_MS !== 0 || window.end % DAY_MS !== 0 || window.end - window.start !== 30 * DAY_MS || window.end > now
    || !cache.assets || typeof cache.assets !== 'object'
    || !['public-klines', 'rounded-minute-profile'].includes(cache.provenance?.kind)) return {};
  const imported = cache.provenance.kind === 'rounded-minute-profile';
  if (cache.provenance.kind === 'rounded-minute-profile'
    && (!/^[a-f0-9]{64}$/.test(cache.provenance.sha256) || !cache.provenance.sourceFile || !cache.provenance.note)) return {};
  const rows: Record<string, AssetOverview['realizedVolatility']> = {};
  for (const [underlying, entry] of Object.entries(cache.assets)) {
    if (!isUnderlying(underlying) || !entry || entry.underlying !== underlying || entry.symbol !== `${underlying}USDT`
      || entry.status !== 'complete' || entry.error !== null || !Number.isFinite(entry.retrievedAt) || entry.retrievedAt < window.end
      || entry.retrievedAt > cache.generatedAt + MINUTE_MS) continue;
    const s = entry.statistics;
    if (!s || !s.complete || s.expectedReturns !== 43200 || s.observedReturns !== 43200 || s.expectedCandles !== 43201
      || (imported ? s.observedCandles !== null || s.missingCandles !== null : s.observedCandles !== 43201 || s.missingCandles !== 0)
      || s.missingReturns !== 0 || !Array.isArray(s.missingReturnRanges) || s.missingReturnRanges.length !== 0
      || !Number.isFinite(s.sumSquaredReturns) || s.sumSquaredReturns < 0 || !Number.isFinite(s.annualized)) continue;
    const annualized = Math.sqrt(s.sumSquaredReturns / s.observedReturns * 365 * 1440);
    if (Math.abs(annualized - s.annualized!) > Math.max(1e-10, annualized * 1e-9)) continue;
    rows[underlying] = { annualized, start: window.start, end: window.end, samples: s.observedReturns,
      source: imported
        ? `Bybit spot · imported rounded 1m log-return profile · historical 30-day window supplied on import · imported ${new Date(entry.retrievedAt).toISOString()} · raw candles unverified · 365-day annualization`
        : `Bybit spot 1m closes · cached historical 30-day sample · retrieved ${new Date(entry.retrievedAt).toISOString()} · 365-day annualization` };
  }
  return rows;
}

/** Explicit migration of the user's prior research export. Dates are supplied, never inferred.
 * Counts describe the profile; original candles cannot be verified from aggregated RMS values. */
export function cacheFromMinuteProfile(csv: string, start: number, end: number, sourceFile: string, generatedAt = Date.now()): RealizedVolatilityCache {
  if (![start, end].every(t => Number.isSafeInteger(t) && t % DAY_MS === 0) || end - start !== 30 * DAY_MS || end > generatedAt) throw new Error('Import requires an explicit historical 30-day UTC window.');
  const lines = csv.trim().split(/\r?\n/), header = lines.shift()?.split(',');
  const columns = ['symbol', 'utc_minute', 'observations', 'mean_return_bps', 'rms_return_bps'];
  if (!header || columns.some((name, index) => header[index] !== name)) throw new Error('Unexpected minute-profile CSV schema.');
  const stats = new Map<Underlying, { slots: Set<string>; squares: number; returns: number; mean: number }>();
  for (const line of lines) {
    const [symbol, minute, countText, meanText, rmsText] = line.split(',');
    const underlying = symbol?.replace(/USDT$/, ''), count = Number(countText), mean = Number(meanText) / 10000, rms = Number(rmsText) / 10000;
    if (!underlying || !isUnderlying(underlying) || symbol !== `${underlying}USDT` || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(minute ?? '')
      || count !== 30 || !Number.isFinite(mean) || !Number.isFinite(rms) || rms < 0 || Math.abs(mean) > rms + 1e-9) throw new Error('Profile import requires valid complete 30-observation minute buckets.');
    const value = stats.get(underlying) ?? { slots: new Set<string>(), squares: 0, returns: 0, mean: 0 };
    if (value.slots.has(minute!)) throw new Error(`Duplicate ${underlying} profile minute.`);
    value.slots.add(minute!); value.squares += count * rms * rms; value.returns += count; value.mean += count * mean;
    stats.set(underlying, value);
  }
  const cache: RealizedVolatilityCache = { schemaVersion: 1, generatedAt, source: BYBIT_KLINE_SOURCE, category: 'spot', quote: 'USDT', intervalMs: 60000,
    method: RV_METHOD, annualizationDays: 365, window: { start, end, days: 30, timezone: 'UTC' },
    provenance: { kind: 'rounded-minute-profile', sourceFile, sha256: createHash('sha256').update(csv).digest('hex'),
      note: 'Imported aggregate RMS log returns rounded in the source CSV; UTC dates supplied explicitly. Original candle prices, timestamps and missing-candle validation cannot be recovered from this export.' }, assets: {} };
  if (stats.size === 0) throw new Error('No complete profiles in input.');
  for (const [underlying, value] of stats) {
    if (value.slots.size !== 1440 || value.returns !== 43200) throw new Error(`Incomplete ${underlying} minute profile.`);
    const rmsMinuteLogReturn = Math.sqrt(value.squares / value.returns);
    cache.assets[underlying] = { underlying, symbol: `${underlying}USDT`, status: 'complete', retrievedAt: generatedAt, venueTime: null, error: null,
      statistics: { expectedReturns: 43200, observedReturns: 43200, expectedCandles: 43201, observedCandles: null,
        duplicateCandles: null, missingReturns: 0, missingCandles: null, missingReturnRanges: [], sumSquaredReturns: value.squares,
        meanMinuteLogReturn: value.mean / value.returns, rmsMinuteLogReturn, annualized: rmsMinuteLogReturn * Math.sqrt(365 * 1440), complete: true } };
  }
  return cache;
}

let fileCache: { path: string; stamp: string; rows: ReturnType<typeof cachedVolatilityRows> } | undefined;
/** Read only when the cache changes. No network I/O or CSV statistics on dashboard polls. */
export function researchVolatility(path = RV_CACHE_PATH): Record<string, AssetOverview['realizedVolatility']> {
  const absolute = resolve(path);
  try {
    const info = statSync(absolute), stamp = `${info.mtimeMs}:${info.size}`;
    if (fileCache?.path === absolute && fileCache.stamp === stamp) return fileCache.rows;
    if (info.size > 4_000_000) return {};
    const rows = cachedVolatilityRows(JSON.parse(readFileSync(absolute, 'utf8')));
    fileCache = { path: absolute, stamp, rows };
    return rows;
  } catch { return {}; }
}

export interface KlineFetchOptions {
  fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; maxPages?: number; timeoutMs?: number; pageDelayMs?: number;
}
/** Bounded public reads only. Credential/header/signing configuration is deliberately absent. */
export async function fetchBybitMinuteCloses(underlying: Underlying, start: number, end: number, options: KlineFetchOptions = {}) {
  if (!isUnderlying(underlying) || ![start, end].every(Number.isSafeInteger) || end <= start || start % MINUTE_MS || end % MINUTE_MS || end - start > 30 * DAY_MS) throw new Error('Invalid bounded kline request.');
  const request = options.fetch ?? fetch, sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxPages = options.maxPages ?? 50;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 60) throw new Error('Kline page limit must be between 1 and 60.');
  const symbol = `${underlying}USDT`, first = start - MINUTE_MS, candles: MinuteClose[] = [];
  let cursor = end - 1, venueTime: number | null = null, pages = 0;
  while (cursor >= first) {
    if (++pages > maxPages) throw new Error(`Bybit ${symbol}: bounded pagination limit reached.`);
    const url = new URL(BYBIT_KLINE_SOURCE);
    url.search = new URLSearchParams({ category: 'spot', symbol, interval: '1', start: String(first), end: String(cursor), limit: '1000' }).toString();
    let payload: any;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await request(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 15000) });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < 3) { await sleep(300 * 2 ** attempt); continue; }
          throw new Error(`Bybit ${symbol}: HTTP ${response.status}.`);
        }
        payload = await response.json();
        if ([10006, 10016].includes(payload?.retCode) && attempt < 3) { await sleep(300 * 2 ** attempt); continue; }
        if (payload?.retCode !== 0) throw new Error(`Bybit ${symbol}: venue error ${Number.isFinite(payload?.retCode) ? payload.retCode : 'invalid response'}.`);
        break;
      } catch (error) {
        const isNetwork = error instanceof TypeError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name));
        if (isNetwork && attempt < 3) { await sleep(300 * 2 ** attempt); continue; }
        throw error;
      }
    }
    if (payload?.result?.symbol !== symbol || payload.result.category !== 'spot' || !Array.isArray(payload.result.list)
      || payload.result.list.length > 1000 || !Number.isFinite(payload.time)) throw new Error(`Bybit ${symbol}: unexpected kline schema.`);
    venueTime = payload.time;
    const rows = payload.result.list;
    if (!rows.length) break;
    let oldest = Infinity;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 5) throw new Error(`Bybit ${symbol}: invalid candle row.`);
      const timestamp = Number(row[0]), close = Number(row[4]);
      if (!Number.isSafeInteger(timestamp) || timestamp % MINUTE_MS || !Number.isFinite(close) || close <= 0
        || timestamp < first || timestamp > cursor || timestamp + MINUTE_MS > payload.time) throw new Error(`Bybit ${symbol}: invalid, out-of-window or unclosed candle.`);
      oldest = Math.min(oldest, timestamp); candles.push({ startTime: timestamp, close });
    }
    if (!(oldest - 1 < cursor)) throw new Error(`Bybit ${symbol}: pagination did not advance.`);
    cursor = oldest - 1;
    if (cursor >= first) await sleep(options.pageDelayMs ?? 120);
  }
  return { candles, venueTime, pages };
}
