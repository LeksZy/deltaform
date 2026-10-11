import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHyperliquidAttribution } from '../src/venues/hyperliquid';

const owner = '0x1111111111111111111111111111111111111111';
const funding = (time: number, coin = 'SOL') => ({ time, hash: `0xf${time}`, delta: { type: 'funding', coin, usdc: '-0.25', fundingRate: '.0001', szi: '10' } });
const fill = (time: number, feeToken = 'USDC') => ({ time, hash: `0xf${time}`, coin: 'SOL', tid: time, oid: time + 1, side: 'A', sz: '1.5', px: '120', closedPnl: '7.25', fee: '.10', feeToken, builderFee: '.02' });
function stub(fundingRows: unknown, fillRows: unknown) {
  const mock = vi.fn(async (_url: string, init: RequestInit) => ({ ok: true, json: async () => JSON.parse(String(init.body)).type === 'userFunding' ? fundingRows : fillRows }));
  vi.stubGlobal('fetch', mock); return mock;
}
afterEach(() => vi.unstubAllGlobals());

describe('Hyperliquid bounded P&L attribution', () => {
  it('keeps funding signs, excludes other markets, and does not add builder fees twice', async () => {
    const mock = stub([funding(1100), funding(1200, 'ETH')], [fill(1300, ' USDC'), { ...fill(1400), coin: 'BTC' }]);
    const result = await getHyperliquidAttribution(owner, 1000, { untilTime: 2000 });
    expect(result.totals).toEqual({ funding: -.25, perpRealized: 7.25, costs: .1 });
    expect(result.funding.rows).toHaveLength(1); expect(result.fills.rows[0].builderFee).toBe(.02);
    expect(result.completeSinceRequestedStart).toBeNull(); expect(result.scope).toContain('includes manual trades');
    expect(mock.mock.calls.map(c => JSON.parse(String(c[1].body))).find(b => b.type === 'userFillsByTime'))
      .toMatchObject({ startTime: 1000, endTime: 2000, aggregateByTime: false });
  });
  it('returns unknown fees in unsupported currencies and independent unknown values on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      if (JSON.parse(String(init.body)).type === 'userFunding') throw new Error('unavailable');
      return { ok: true, json: async () => [fill(1100, 'SOL')] };
    }));
    const result = await getHyperliquidAttribution(owner, 1000, { untilTime: 2000 });
    expect(result.totals).toEqual({ funding: null, perpRealized: 7.25, costs: null });
    expect(result.funding.available).toBe(false); expect(result.funding.error).toContain('request failed');
  });
  it('deduplicates inclusive page boundaries without omitting subsequent events', async () => {
    const starts: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.type !== 'userFunding') return { ok: true, json: async () => [] };
      starts.push(body.startTime);
      return { ok: true, json: async () => starts.length === 1 ? Array.from({ length: 500 }, (_, i) => funding(1000 + i)) : [funding(1499), funding(1500)] };
    }));
    const result = await getHyperliquidAttribution(owner, 1000, { untilTime: 2000 });
    expect(starts).toEqual([1000, 1499]); expect(result.funding.rows).toHaveLength(501);
    expect(result.totals.funding).toBe(-125.25); expect(result.funding.paginationPartial).toBe(false);
  });
  it('marks a page cap as partial and rejects malformed amounts instead of displaying zero', async () => {
    stub(Array.from({ length: 500 }, (_, i) => funding(1000 + i)), [{ ...fill(1100), closedPnl: null }]);
    const result = await getHyperliquidAttribution(owner, 1000, { untilTime: 2000, maxPages: 1 });
    expect(result.funding.paginationPartial).toBe(true); expect(result.totals.funding).toBe(-125);
    expect(result.fills.available).toBe(false); expect(result.totals.perpRealized).toBeNull();
  });
  it('does not loop or skip forward when one saturated timestamp cannot be paginated', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ ...funding(1000), hash: `0x${i}` }));
    const mock = stub(rows, []);
    const result = await getHyperliquidAttribution(owner, 1000, { untilTime: 2000 });
    expect(result.funding.paginationPartial).toBe(true); expect(mock).toHaveBeenCalledTimes(2);
  });
});
