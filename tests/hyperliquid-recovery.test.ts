import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/venues/hyperliquid', () => ({ hyperliquidInfo: vi.fn() }));
import { hyperliquidInfo } from '../src/venues/hyperliquid';
import { inspectHyperliquidRecovery } from '../src/venues/hyperliquid-recovery';

const owner = '0x1111111111111111111111111111111111111111';
const now = 1_800_000_000_000;
const intent = { cloid: '0xabcdefabcdefabcdefabcdefabcdefab', underlying: 'SOL', quantity: -2, createdAt: now - 180_000, appliedFill: 0 };
const start = intent.createdAt - 1_000;
const mockInfo = vi.mocked(hyperliquidInfo);
type Request = { type: string; user?: string; oid?: string; startTime?: number; endTime?: number; aggregateByTime?: boolean };
type Overrides = Record<string, unknown | ((request: Request) => unknown)>;
function order(overrides: Record<string, unknown> = {}) {
  return { coin: 'SOL', side: 'A', limitPx: '120', sz: '2', oid: 42, timestamp: intent.createdAt, cloid: intent.cloid, ...overrides };
}
function historical(overrides: Record<string, unknown> = {}, orderOverrides: Record<string, unknown> = {}) {
  return { order: order(orderOverrides), status: 'filled', statusTimestamp: intent.createdAt, ...overrides };
}
function fill(id = 1, time = intent.createdAt, underlying = 'ETH') {
  return { coin: underlying, time, oid: id + 50_000, tid: id, side: 'A', px: '120', sz: '1' };
}
function responses(overrides: Overrides = {}) {
  const defaults: Overrides = { orderStatus: { status: 'unknownOid' }, frontendOpenOrders: [], historicalOrders: [],
    clearinghouseState: { assetPositions: [] }, userFillsByTime: [] };
  mockInfo.mockImplementation(async raw => {
    const request = raw as Request;
    const value = Object.hasOwn(overrides, request.type) ? overrides[request.type] : defaults[request.type];
    if (typeof value === 'function') return value(request);
    if (value instanceof Error) throw value;
    return value as any;
  });
}
beforeEach(() => { mockInfo.mockReset(); responses(); });

describe('read-only Hyperliquid orphan-intent evidence', () => {
  it('allows an aged unknown ID only with complete empty evidence and keeps the legacy outcome unknown', async () => {
    const result = await inspectHyperliquidRecovery(owner, intent, now);
    expect(result).toMatchObject({ checkedAt: now, orderStatus: 'unknownOid', eligible: true, actualPerp: 0,
      fillsComplete: true, fillsSinceIntentCount: 0, openOrderCount: 0, matchingHistoricalOrderCount: 0, blockers: [] });
    expect(result.observation).toMatch(/legacy outcome remains unknown/);
    expect(result.observation).toMatch(/does not prove rejection or non-execution/);
    expect(JSON.stringify(result)).not.toContain(owner);
    const requests = mockInfo.mock.calls.map(([request]) => request as Request);
    expect(requests.map(request => request.type).sort()).toEqual(['clearinghouseState', 'frontendOpenOrders', 'historicalOrders', 'orderStatus', 'orderStatus', 'userFillsByTime'].sort());
    expect(requests.every(request => request.user === owner)).toBe(true);
    expect(requests.filter(request => request.type === 'orderStatus').every(request => request.oid === intent.cloid)).toBe(true);
    expect(requests.find(request => request.type === 'userFillsByTime')).toMatchObject({ startTime: start, endTime: now, aggregateByTime: false });
  });

  it.each(['filled', 'canceled', 'open', 'rejected', 'iocCancelRejected'])('blocks a known %s status instead of treating it as an orphan', async knownStatus => {
    responses({ orderStatus: { status: 'order', order: historical({ status: knownStatus }) } });
    const result = await inspectHyperliquidRecovery(owner, intent, now);
    expect(result.orderStatus).toBe(knownStatus);
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('The venue has a known order status; normal reconciliation is required.');
  });

  it.each([null, [], {}, { status: 'filled' }, { status: 'unknownOid', order: {} }, { status: 'order', order: {} }, { status: 'future-status' }])('blocks malformed status %j', async response => {
    responses({ orderStatus: response });
    const result = await inspectHyperliquidRecovery(owner, intent, now);
    expect(result).toMatchObject({ eligible: false, orderStatus: 'unavailable' });
    expect(result.blockers).toContain('Order status could not be verified.');
  });

  it('rechecks the cloid after the other evidence and blocks newly visible orders', async () => {
    let count = 0;
    responses({ orderStatus: () => ++count === 1 ? { status: 'unknownOid' } : { status: 'order', order: historical() } });
    const result = await inspectHyperliquidRecovery(owner, intent, now);
    expect(result).toMatchObject({ orderStatus: 'filled', eligible: false });
    expect((mockInfo.mock.calls.at(-1)![0] as Request).type).toBe('orderStatus');
  });

  it('blocks when the final status lookup fails without exposing remote errors', async () => {
    let count = 0;
    responses({ orderStatus: () => { if (++count === 2) throw new Error(`remote error ${owner} secret`); return { status: 'unknownOid' }; } });
    const result = await inspectHyperliquidRecovery(owner, intent, now);
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('Final order status could not be verified.');
    expect(JSON.stringify(result)).not.toMatch(/secret|111111/);
  });

  it('blocks any account open order, even on another market', async () => {
    responses({ frontendOpenOrders: [order({ coin: 'ETH', cloid: null })] });
    expect(await inspectHyperliquidRecovery(owner, intent, now)).toMatchObject({ eligible: false, openOrderCount: 1 });
  });

  it('matches historical client IDs without case sensitivity', async () => {
    responses({ historicalOrders: [historical({}, { cloid: `0x${intent.cloid.slice(2).toUpperCase()}` })] });
    expect(await inspectHyperliquidRecovery(owner, intent, now)).toMatchObject({ eligible: false, matchingHistoricalOrderCount: 1 });
  });

  it('reports the capped historical response without describing it as complete history', async () => {
    responses({ historicalOrders: Array.from({ length: 2_000 }, (_, id) => historical({}, { oid: id, coin: 'ETH', cloid: null })) });
    const result = await inspectHyperliquidRecovery(owner, intent, now);
    expect(result).toMatchObject({ eligible: true, historicalOrdersTruncated: true, matchingHistoricalOrderCount: 0 });
    expect(result.observation).toContain('not complete history');
  });

  it('blocks an unidentifiable same-market historical order in the intent window', async () => {
    responses({ historicalOrders: [historical({}, { cloid: null })] });
    const result = await inspectHyperliquidRecovery(owner, intent, now);
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('A recent same-market historical order has no client ID and cannot be excluded.');
  });

  it('returns observed signed position without treating zero or a pre-existing position as execution proof', async () => {
    responses({ clearinghouseState: { assetPositions: [{ position: { coin: 'SOL', szi: '-3.5' } }, { position: { coin: 'ETH', szi: '10' } }] } });
    expect(await inspectHyperliquidRecovery(owner, intent, now)).toMatchObject({ actualPerp: -3.5, eligible: true });
  });

  it.each([
    ['frontendOpenOrders', {}], ['frontendOpenOrders', [{}]], ['historicalOrders', {}], ['historicalOrders', [{}]],
    ['clearinghouseState', {}], ['clearinghouseState', { assetPositions: [{}] }],
    ['clearinghouseState', { assetPositions: [{ position: { coin: 'SOL', szi: null } }] }],
    ['clearinghouseState', { assetPositions: [{ position: { coin: 'SOL', szi: '1' } }, { position: { coin: 'SOL', szi: '-1' } }] }],
    ['userFillsByTime', {}], ['userFillsByTime', [{}]],
  ])('fails closed for malformed %s data', async (type, value) => {
    responses({ [type as string]: value });
    const result = await inspectHyperliquidRecovery(owner, intent, now);
    expect(result.eligible).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    if (type === 'clearinghouseState') expect(result.actualPerp).toBeNull();
  });

  it.each(['orderStatus', 'frontendOpenOrders', 'historicalOrders', 'clearinghouseState', 'userFillsByTime'])('fails closed for a network failure from %s', async type => {
    responses({ [type]: new Error(`network failure ${owner}`) });
    const result = await inspectHyperliquidRecovery(owner, intent, now);
    expect(result.eligible).toBe(false);
    expect(JSON.stringify(result)).not.toContain(owner);
    if (type === 'userFillsByTime') expect(result.fillsComplete).toBe(false);
  });

  it('enforces the exact 120-second minimum and no locally applied fill', async () => {
    expect((await inspectHyperliquidRecovery(owner, { ...intent, createdAt: now - 119_999 }, now)).eligible).toBe(false);
    expect((await inspectHyperliquidRecovery(owner, { ...intent, createdAt: now - 120_000 }, now)).eligible).toBe(true);
    expect((await inspectHyperliquidRecovery(owner, { ...intent, appliedFill: .001 }, now)).eligible).toBe(false);
  });

  it.each([{ createdAt: now + 1 }, { createdAt: NaN }, { quantity: 0 }, { quantity: Infinity }, { appliedFill: -1 }, { underlying: 'not-supported' }, { cloid: 'not-a-client-id' }])('rejects invalid intent input %j without any remote request', async patch => {
    expect((await inspectHyperliquidRecovery(owner, { ...intent, ...patch }, now)).eligible).toBe(false);
    expect(mockInfo).not.toHaveBeenCalled();
  });
});

describe('complete, inclusive fill inspection', () => {
  it('blocks every same-market fill, including a fill at the safety-window boundary or fixed end', async () => {
    responses({ userFillsByTime: [fill(1, start, 'SOL'), fill(2, now, 'SOL')] });
    expect(await inspectHyperliquidRecovery(owner, intent, now)).toMatchObject({ eligible: false, fillsComplete: true, fillsSinceIntentCount: 2 });
  });

  it('continues a 500-block page at its last timestamp, deduplicates overlap, and retains fixed endTime', async () => {
    const page = Array.from({ length: 500 }, (_, id) => fill(id, start + id));
    let count = 0;
    responses({ userFillsByTime: (request: Request) => {
      expect(request.endTime).toBe(now);
      if (count++ === 0) { expect(request.startTime).toBe(start); return page; }
      expect(request.startTime).toBe(start + 499);
      return [page[499], fill(500, start + 499, 'SOL'), fill(501, start + 500)];
    } });
    expect(await inspectHyperliquidRecovery(owner, intent, now)).toMatchObject({ eligible: false, fillsComplete: true, fillsSinceIntentCount: 1 });
    expect(count).toBe(2);
  });

  it('paginates a 2,000-row response even when it has fewer than 500 timestamps', async () => {
    const page = Array.from({ length: 2_000 }, (_, id) => fill(id, start + Math.floor(id / 20)));
    let count = 0;
    responses({ userFillsByTime: (request: Request) => {
      if (count++ === 0) return page;
      expect(request.startTime).toBe(start + 99);
      return page.slice(-20);
    } });
    expect(await inspectHyperliquidRecovery(owner, intent, now)).toMatchObject({ eligible: true, fillsComplete: true });
    expect(count).toBe(2);
  });

  it('blocks a saturated single timestamp that cannot be paginated without losing rows', async () => {
    const page = Array.from({ length: 2_000 }, (_, id) => fill(id, start));
    responses({ userFillsByTime: page });
    expect(await inspectHyperliquidRecovery(owner, intent, now)).toMatchObject({ eligible: false, fillsComplete: false });
    expect(mockInfo.mock.calls.filter(([raw]) => (raw as Request).type === 'userFillsByTime')).toHaveLength(1);
  });

  it('treats the documented shared 500-element cap as potentially full even with one timestamp', async () => {
    responses({ userFillsByTime: Array.from({ length: 500 }, (_, id) => fill(id, start)) });
    expect(await inspectHyperliquidRecovery(owner, intent, now)).toMatchObject({ eligible: false, fillsComplete: false });
  });

  it('never marks a partial feed complete when a later page fails', async () => {
    let count = 0;
    responses({ userFillsByTime: () => {
      if (count++ === 0) return Array.from({ length: 500 }, (_, id) => fill(id, start + id));
      throw new Error('timeout');
    } });
    expect(await inspectHyperliquidRecovery(owner, intent, now)).toMatchObject({ eligible: false, fillsComplete: false });
  });

  it('fails closed if an inclusive boundary disappears between pages', async () => {
    let count = 0;
    responses({ userFillsByTime: () => count++ === 0 ? Array.from({ length: 500 }, (_, id) => fill(id, start + id)) : [] });
    expect(await inspectHyperliquidRecovery(owner, intent, now)).toMatchObject({ eligible: false, fillsComplete: false });
  });

  it('stops after a bounded number of full pages', async () => {
    const all = Array.from({ length: 6_000 }, (_, id) => fill(id, start + id));
    let count = 0;
    responses({ userFillsByTime: (request: Request) => { count++; return all.filter(row => row.time >= request.startTime!).slice(0, 500); } });
    expect(await inspectHyperliquidRecovery(owner, intent, now)).toMatchObject({ eligible: false, fillsComplete: false });
    expect(count).toBe(10);
  });

  it('does not claim complete coverage when all 10,000 retained fills lie in the window', async () => {
    const all = Array.from({ length: 10_000 }, (_, id) => fill(id, start + Math.floor(id / 20)));
    responses({ userFillsByTime: (request: Request) => all.filter(row => row.time >= request.startTime!).slice(0, 2_000) });
    expect(await inspectHyperliquidRecovery(owner, intent, now)).toMatchObject({ eligible: false, fillsComplete: false });
  });

  it.each([
    [fill(1, start - 1)], [fill(1, now + 1)], [fill(2, start + 1), fill(1, start)],
    [{ ...fill(), coin: null }], [{ ...fill(), sz: 'NaN' }], [{ ...fill(), side: 'invalid' }],
    [fill(), fill()], [{ ...fill(), tid: Number.MAX_SAFE_INTEGER + 1 }],
  ].map(rows => [rows]))('blocks out-of-window, unordered, duplicate, or malformed fills %j', async rows => {
    responses({ userFillsByTime: rows });
    expect(await inspectHyperliquidRecovery(owner, intent, now)).toMatchObject({ eligible: false, fillsComplete: false });
  });
});
