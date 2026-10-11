import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, initialState, type InternalState, type LiveGateway, type OrderIntent } from '../server/engine';
import { HEDGE_RECOVERY_REVIEW_MS, HedgeRecovery, type HedgeRecoveryArchive } from '../server/hedge-recovery';
import { Store } from '../server/store';
import { demoAssetMarket, demoAssetPosition } from '../src/quant/fixtures';
import type { RecoveryConfirmation, RecoveryEvidence } from '../src/shared/hedge-recovery';

const owner = `0x${'1'.repeat(40)}`;
const cloid = `0x${'2'.repeat(32)}`;
let now = Date.UTC(2026, 9, 1, 12);
const stores: Store[] = [];
beforeEach(() => {
  now = Date.UTC(2026, 9, 1, 12);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubEnv('HYPERLIQUID_NETWORK', 'mainnet');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network access in local recovery test'); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  stores.splice(0).forEach(store => store.close());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

function harness(underlying: 'SOL' | 'HYPE' = 'HYPE') {
  const store = new Store(':memory:'); stores.push(store);
  store.set('activeMode', 'live'); store.set('state:live', initialState('live'));
  const engine = new Engine(store); engine.selectAsset(underlying);
  const position = demoAssetPosition(underlying, now);
  position.source = 'live'; position.owner = 'mock-solana-owner';
  position.benchmarkBins = structuredClone(position.bins); position.benchmarkAt = now; position.benchmarkPrice = position.poolPrice;
  engine.state.positions = [position]; engine.state.selectedIds = [position.id];
  engine.state.market = { ...demoAssetMarket(underlying, now), source: 'live' };
  engine.state.accounts.hyperliquid = { address: owner, verified: true, connectedAt: now };
  engine.state.accounts.meteora = { address: position.owner, verified: true, connectedAt: now };
  engine.state.globalPaused = true;
  engine.state.hedge.anchor = 41;
  engine.state.hedge.actualPerp = -3;
  engine.state.hedge.status = 'suspended';
  engine.state.hedgedRevision = 8;
  engine.state.intent = { underlying, cloid, quantity: -.2, price: 42, createdAt: now - 60_000, reason: 'Unknown outcome', appliedFill: 0 };
  engine.state.hedge.pendingOrder = cloid;
  engine.state.books!.BTC.hedge.actualPerp = -.1;
  engine.state.books!.BTC.hedge.anchor = 70000;
  engine.state.books!.BTC.market = { ...demoAssetMarket('BTC', now), source: 'live' };
  const gateway = {
    market: vi.fn(async () => structuredClone(engine.state.market)),
    positions: vi.fn(async () => [structuredClone(position)]),
    portfolio: vi.fn(async () => ({ positions: [structuredClone(position)], holdings: [], actualPerp: -3,
      collateral: 750, entryPrice: 42, accountTimestamp: now })),
    ready: vi.fn(() => null),
    order: vi.fn(async () => { throw new Error('Recovery must never order'); }),
    reconcile: vi.fn(async () => { throw new Error('Recovery must never use the execution reconciler'); }),
    cancel: vi.fn(async () => { throw new Error('Recovery must never cancel'); }),
  } satisfies LiveGateway;
  engine.gateway = gateway; engine.updateDelta(); engine.save();
  const evidence: RecoveryEvidence = { checkedAt: now, orderStatus: 'unknownOid', openOrderCount: 0,
    matchingHistoricalOrderCount: 0, historicalOrdersTruncated: false, fillsSinceIntentCount: 0,
    fillsComplete: true, actualPerp: -3, eligible: true, blockers: [], observation: 'No matching accepted order was observed.' };
  const inspect = vi.fn(async (_owner: string, _intent: OrderIntent) => structuredClone(evidence));
  const recovery = new HedgeRecovery(engine, store, inspect);
  const confirm = async () => {
    const review = await recovery.preview();
    return { review, input: { reviewId: review.id, clientOrderId: review.clientOrderId, acknowledgeUnknown: true } satisfies RecoveryConfirmation };
  };
  return { store, engine, gateway, evidence, inspect, recovery, confirm };
}

function expectPending(h: ReturnType<typeof harness>) {
  expect(h.engine.state.intent?.cloid).toBe(cloid);
  expect(h.engine.state.hedge.pendingOrder).toBe(cloid);
  expect(h.store.get<InternalState>('state:live')?.intent?.cloid).toBe(cloid);
  expect(h.store.get(`hedgeRecoveryArchive:${cloid}`)).toBeUndefined();
  expect(h.gateway.order).not.toHaveBeenCalled();
  expect(h.gateway.cancel).not.toHaveBeenCalled();
  expect(h.gateway.reconcile).not.toHaveBeenCalled();
}

describe('explicit local recovery of an unknown hedge intent', () => {
  it('previews read-only evidence without changing the pending intent and replaces older reviews for this book', async () => {
    const h = harness(), intent = structuredClone(h.engine.state.intent);
    const first = await h.recovery.preview(), second = await h.recovery.preview();
    expect(second).toMatchObject({ underlying: 'HYPE', clientOrderId: cloid, quantity: -.2,
      intentCreatedAt: intent!.createdAt, createdAt: now, expiresAt: now + HEDGE_RECOVERY_REVIEW_MS });
    expect(second.warning).toMatch(/do not prove/);
    expect(h.inspect).toHaveBeenLastCalledWith(owner, intent);
    expect(h.gateway.portfolio).not.toHaveBeenCalled();
    expect(h.store.get(`hedgeRecoveryReview:${first.id}`)).toBeUndefined();
    expect(h.store.get(`hedgeRecoveryReview:${second.id}`)).toBeDefined();
    await expect(h.recovery.confirm({ reviewId: first.id, clientOrderId: cloid, acknowledgeUnknown: true })).rejects.toThrow(/not found or replaced/);
    expectPending(h);
  });

  it.each(['global', 'selected', 'other'] as const)('requires every automation paused (%s guard)', async guard => {
    const h = harness();
    if (guard === 'global') h.engine.state.globalPaused = false;
    if (guard === 'selected') h.engine.state.hedge.enabled = true;
    if (guard === 'other') h.engine.state.books!.SOL.hedge.enabled = true;
    await expect(h.recovery.preview()).rejects.toThrow(/Pause all/);
    expect(h.inspect).not.toHaveBeenCalled(); expectPending(h);
  });

  it.each(['paper', 'unsupported', 'other intent', 'basket', 'applied fill', 'mismatched cloid', 'unknown underlying'] as const)('blocks an unsafe local context: %s', async guard => {
    const h = harness();
    if (guard === 'paper') h.engine.state.mode = 'paper';
    if (guard === 'unsupported') h.engine.selectAsset('BTC');
    if (guard === 'other intent') h.engine.state.books!.SOL.intent = { ...h.engine.state.intent!, underlying: 'SOL' };
    if (guard === 'basket') h.store.set('bybitBasketPending', { id: 'pending' });
    if (guard === 'applied fill') h.engine.state.intent!.appliedFill = .1;
    if (guard === 'mismatched cloid') h.engine.state.hedge.pendingOrder = `0x${'3'.repeat(32)}`;
    if (guard === 'unknown underlying') h.engine.state.intent!.underlying = undefined;
    await expect(h.recovery.preview()).rejects.toThrow();
    expect(h.inspect).not.toHaveBeenCalled();
    expect(h.store.get(`hedgeRecoveryArchive:${cloid}`)).toBeUndefined();
  });

  it.each(['account', 'network', 'intent', 'selection', 'quantity', 'enabled'] as const)('requires a fresh review after %s changes', async change => {
    const h = harness(), { input } = await h.confirm();
    if (change === 'account') h.engine.state.accounts.hyperliquid!.address = `0x${'a'.repeat(40)}`;
    if (change === 'network') vi.stubEnv('HYPERLIQUID_NETWORK', 'testnet');
    if (change === 'intent') h.engine.state.intent!.quantity = -.3;
    if (change === 'selection') h.engine.state.selectedIds = [];
    if (change === 'quantity') h.engine.state.books!.BTC.hedge.actualPerp = -.2;
    if (change === 'enabled') h.engine.state.books!.SOL.hedge.enabled = true;
    await expect(h.recovery.confirm(input)).rejects.toThrow(/changed|Pause all/);
    expect(h.inspect).toHaveBeenCalledTimes(1); expectPending(h);
  });

  it('rejects expiry, mismatched confirmation, and missing acknowledgement', async () => {
    const h = harness(), { input } = await h.confirm();
    await expect(h.recovery.confirm({ ...input, clientOrderId: `0x${'9'.repeat(32)}` })).rejects.toThrow(/not found/);
    await expect(h.recovery.confirm({ ...input, acknowledgeUnknown: false } as unknown as RecoveryConfirmation)).rejects.toThrow(/acknowledgement/);
    now += HEDGE_RECOVERY_REVIEW_MS;
    await expect(h.recovery.confirm(input)).rejects.toThrow(/expired/);
    expectPending(h);
  });

  it.each(['open order', 'fill', 'history', 'incomplete', 'known status', 'read error', 'different position'] as const)('refreshes the evidence and preserves the intent when there is a %s', async change => {
    const h = harness(), { input } = await h.confirm();
    if (change === 'open order') h.evidence.openOrderCount = 1;
    if (change === 'fill') h.evidence.fillsSinceIntentCount = 1;
    if (change === 'history') h.evidence.matchingHistoricalOrderCount = 1;
    if (change === 'incomplete') h.evidence.fillsComplete = false;
    if (change === 'known status') h.evidence.orderStatus = 'filled';
    if (change === 'different position') h.evidence.actualPerp = -3.2;
    if (change === 'read error') h.inspect.mockRejectedValueOnce(new Error('Read unavailable'));
    await expect(h.recovery.confirm(input)).rejects.toThrow();
    expect(h.inspect).toHaveBeenCalledTimes(2);
    expect(h.gateway.portfolio).not.toHaveBeenCalled(); expectPending(h);
  });

  it('returns blocked preview evidence for review without allowing confirmation', async () => {
    const h = harness(); h.evidence.eligible = false; h.evidence.blockers = ['Fills read unavailable'];
    const { review, input } = await h.confirm();
    expect(review.evidence.blockers).toEqual(['Fills read unavailable']);
    await expect(h.recovery.confirm(input)).rejects.toThrow(/Fills read unavailable/);
    expect(h.inspect).toHaveBeenCalledTimes(1); expectPending(h);
  });

  it('rechecks intent and pause guards after each awaited read', async () => {
    const h = harness(), { input } = await h.confirm();
    h.inspect.mockImplementationOnce(async () => { h.engine.state.globalPaused = false; return h.evidence; });
    await expect(h.recovery.confirm(input)).rejects.toThrow(/Pause all/);
    expect(h.gateway.portfolio).not.toHaveBeenCalled(); expectPending(h);
  });

  it('keeps the intent when read-only portfolio reconciliation fails', async () => {
    const h = harness(), { input } = await h.confirm();
    h.gateway.portfolio.mockRejectedValueOnce(new Error('Account reconciliation unavailable'));
    await expect(h.recovery.confirm(input)).rejects.toThrow(/reconciliation unavailable/);
    expectPending(h);
  });

  it('keeps the intent when the reconciled position differs from fresh evidence', async () => {
    const h = harness(), { input } = await h.confirm();
    h.gateway.portfolio.mockResolvedValueOnce({ positions: structuredClone(h.engine.state.positions), holdings: [],
      actualPerp: -3.2, collateral: 750, entryPrice: 42, accountTimestamp: now });
    await expect(h.recovery.confirm(input)).rejects.toThrow(/differs from the evidence/);
    expect(h.engine.state.hedge.actualPerp).toBe(-3.2); expectPending(h);
  });

  it('revalidates safety after reconciliation and refuses expired evidence', async () => {
    const h = harness(), { input } = await h.confirm();
    const original = h.gateway.portfolio.getMockImplementation()!;
    h.gateway.portfolio.mockImplementationOnce(async () => { const result = await original(); now += HEDGE_RECOVERY_REVIEW_MS; return result; });
    await expect(h.recovery.confirm(input)).rejects.toThrow(/expired/);
    expectPending(h);
  });

  it.each(['pause', 'selection', 'pending'] as const)('revalidates %s after portfolio reconciliation', async change => {
    const h = harness(), { input } = await h.confirm();
    const original = h.gateway.portfolio.getMockImplementation()!;
    h.gateway.portfolio.mockImplementationOnce(async () => {
      const result = await original();
      if (change === 'pause') h.engine.state.books!.SOL.hedge.enabled = true;
      if (change === 'selection') h.engine.state.selectedIds = [];
      if (change === 'pending') h.engine.state.books!.SOL.hedge.pendingOrder = `0x${'4'.repeat(32)}`;
      return result;
    });
    await expect(h.recovery.confirm(input)).rejects.toThrow(/Pause all|changed|pending order/);
    expectPending(h);
  });

  it.each(['open order', 'known status', 'fill', 'position'] as const)('preserves the intent when a new %s appears during portfolio reconciliation', async change => {
    const h = harness(), { input } = await h.confirm();
    const original = h.gateway.portfolio.getMockImplementation()!;
    h.gateway.portfolio.mockImplementationOnce(async () => {
      const result = await original();
      if (change === 'open order') h.evidence.openOrderCount = 1;
      if (change === 'known status') h.evidence.orderStatus = 'open';
      if (change === 'fill') h.evidence.fillsSinceIntentCount = 1;
      if (change === 'position') h.evidence.actualPerp = -3.2;
      return result;
    });
    await expect(h.recovery.confirm(input)).rejects.toThrow(/does not permit|position changed/);
    expect(h.inspect).toHaveBeenCalledTimes(3);
    expect(h.gateway.portfolio).toHaveBeenCalledTimes(1);
    expectPending(h);
  });

  it.each(['pause', 'account', 'other exposure'] as const)('revalidates %s after the final evidence read', async change => {
    const h = harness(), { input } = await h.confirm();
    h.inspect.mockResolvedValueOnce(structuredClone(h.evidence)).mockImplementationOnce(async () => {
      if (change === 'pause') h.engine.state.globalPaused = false;
      if (change === 'account') h.engine.state.accounts.hyperliquid!.address = `0x${'a'.repeat(40)}`;
      if (change === 'other exposure') h.engine.state.books!.BTC.hedge.actualPerp = -.2;
      return structuredClone(h.evidence);
    });
    await expect(h.recovery.confirm(input)).rejects.toThrow(/Pause all|changed/);
    expect(h.inspect).toHaveBeenCalledTimes(3); expectPending(h);
  });

  it('archives the final observations taken after portfolio reconciliation', async () => {
    const h = harness(), { input } = await h.confirm();
    const original = h.gateway.portfolio.getMockImplementation()!;
    h.gateway.portfolio.mockImplementationOnce(async () => {
      const result = await original(); now += 1000;
      h.evidence.checkedAt = now; h.evidence.observation = 'Final check after account reconciliation.';
      return result;
    });
    await h.recovery.confirm(input);
    const archive = h.store.get<HedgeRecoveryArchive>(`hedgeRecoveryArchive:${cloid}`)!;
    expect(archive.evidence).toEqual(h.evidence);
    expect(archive.evidence.checkedAt).toBeGreaterThan(archive.review.evidence.checkedAt);
    expect(h.store.history('live').find(event => event.type === 'hedge-recovery')?.data?.evidence).toEqual(h.evidence);
  });

  it.each(['archive', 'state', 'audit'] as const)('rolls back archive, audit, and memory together when %s storage fails', async failure => {
    const h = harness(), { input } = await h.confirm();
    const set = h.store.set.bind(h.store), append = h.store.appendEvent.bind(h.store);
    let stateWrites = 0;
    vi.spyOn(h.store, 'set').mockImplementation((key, value) => {
      if (failure === 'archive' && key.startsWith('hedgeRecoveryArchive:')) throw new Error('Archive disk failure');
      if (failure === 'state' && key === 'state:live' && ++stateWrites === 2) throw new Error('State disk failure');
      set(key, value);
    });
    vi.spyOn(h.store, 'appendEvent').mockImplementation((mode, event) => {
      if (failure === 'audit' && event.type === 'hedge-recovery') throw new Error('Audit disk failure');
      append(mode, event);
    });
    await expect(h.recovery.confirm(input)).rejects.toThrow(/disk failure/);
    expectPending(h);
    expect(h.store.history('live').filter(event => event.type === 'hedge-recovery')).toHaveLength(0);
    expect(h.engine.state.events.filter(event => event.type === 'hedge-recovery')).toHaveLength(0);
    expect(h.store.get(`hedgeRecoveryReview:${input.reviewId}`)).toBeDefined();
  });

  it.each(['SOL', 'HYPE'] as const)('archives only the local %s intent, preserves exposure and anchor, and confirms idempotently', async underlying => {
    const h = harness(underlying), originalIntent = structuredClone(h.engine.state.intent), before = structuredClone(h.engine.state);
    const tick = vi.spyOn(h.engine, 'tick'), enable = vi.spyOn(h.engine, 'enable');
    const { input, review } = await h.confirm();
    const result = await h.recovery.confirm(input);
    expect(result.hedge).toMatchObject({ enabled: false, status: 'paused', pendingOrder: null, actualPerp: -3, anchor: 41 });
    expect(h.engine.state.intent).toBeNull(); expect(h.engine.state.hedgedRevision).toBe(-1);
    expect(h.engine.state.globalPaused).toBe(true);
    expect(h.engine.state.positions).toEqual(before.positions);
    expect(h.engine.state.books!.BTC.hedge.actualPerp).toBe(-.1);
    expect(h.engine.state.books!.BTC.hedge.anchor).toBe(70000);
    expect(h.engine.state.hedge.currentDelta).toBeCloseTo(before.hedge.currentDelta);
    const archive = h.store.get<HedgeRecoveryArchive>(`hedgeRecoveryArchive:${cloid}`)!;
    expect(archive).toMatchObject({ outcome: 'abandoned-unknown', intent: originalIntent, review,
      evidence: h.evidence, acknowledgeUnknown: true, owner, network: 'mainnet', actualPerp: -3, anchor: 41 });
    const audit = h.store.history('live').filter(event => event.type === 'hedge-recovery');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toMatchObject({ reviewId: review.id, outcome: 'abandoned-unknown', acknowledgeUnknown: true });
    const restarted = new Engine(h.store);
    expect(restarted.state.intent).toBeNull(); expect(restarted.state.hedge.pendingOrder).toBeNull();
    await expect(new HedgeRecovery(restarted, h.store, h.inspect).confirm(input)).resolves.toMatchObject({ hedge: { pendingOrder: null } });
    expect(h.inspect).toHaveBeenCalledTimes(3); expect(h.gateway.portfolio).toHaveBeenCalledTimes(1);
    expect(h.store.history('live').filter(event => event.type === 'hedge-recovery')).toHaveLength(1);
    expect(h.gateway.order).not.toHaveBeenCalled(); expect(h.gateway.cancel).not.toHaveBeenCalled();
    expect(h.gateway.reconcile).not.toHaveBeenCalled(); expect(tick).not.toHaveBeenCalled(); expect(enable).not.toHaveBeenCalled();
  });

  it('still requires global pause for an idempotent confirmation', async () => {
    const h = harness(), { input } = await h.confirm();
    await h.recovery.confirm(input); h.engine.state.globalPaused = false;
    await expect(h.recovery.confirm(input)).rejects.toThrow(/Pause all/);
    expect(h.store.history('live').filter(event => event.type === 'hedge-recovery')).toHaveLength(1);
  });

  it('discloses truncated historical observations while retaining unknownOid and complete fills as required evidence', async () => {
    const h = harness(); h.evidence.historicalOrdersTruncated = true;
    const { input } = await h.confirm();
    await h.recovery.confirm(input);
    expect(h.store.get<HedgeRecoveryArchive>(`hedgeRecoveryArchive:${cloid}`)?.evidence.historicalOrdersTruncated).toBe(true);
  });

  it('allows ordinary market and LP inventory refreshes without invalidating an unchanged recovery target', async () => {
    const h = harness(), { input } = await h.confirm();
    h.engine.state.market.timestamp += 10_000; h.engine.state.market.perpMark += 1;
    h.engine.state.positions[0]!.bins[0]!.y += .001;
    await h.recovery.confirm(input);
    expect(h.engine.state.intent).toBeNull();
  });
});
