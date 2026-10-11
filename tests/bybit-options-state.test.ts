import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BybitOptions, type BybitBasket, type BybitOptionsClient } from '../server/bybit-options';
import { Engine, initialState, type LiveGateway } from '../server/engine';
import { Gateway } from '../server/live';
import type { AgentVault } from '../server/secrets';
import { Store } from '../server/store';
import { mixedBinExample } from '../src/quant/fixtures';
import type { FitResult, OptionExecutionSettings, OptionHolding, OptionInstrument } from '../src/shared/types';
import type { BybitAccount, BybitOrderReconciliation, PreparedBybitOrder } from '../src/venues/bybit';
import { VenueError } from '../src/venues/http';

let now = Date.UTC(2026, 8, 27, 12);
const stores: Store[] = [];
const execution: OptionExecutionSettings = { mode: 'quoted-ask', maxSlippagePercent: 0 };
beforeEach(() => {
  now = Date.UTC(2026, 8, 27, 12);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubEnv('ENABLE_LIVE_EXECUTION', 'true'); vi.stubEnv('BYBIT_NETWORK', 'mainnet');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('These state tests must never call a real venue'); }));
});
afterEach(() => { stores.splice(0).forEach(s => s.close()); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function instrument(type: 'call' | 'put', strike: number): OptionInstrument {
  return { venue: 'bybit', name: `TEST-SOL-${strike}-${type}`, underlying: 'SOL', type, strike,
    expiry: now + 30 * 86_400_000, quoteCoin: 'USDT', settleCoin: 'USDT', settlement: 'Synthetic test instrument',
    multiplier: 1, minSize: 0.1, sizeStep: 0.1, tickSize: 0.01, bid: 4, ask: 5, askSize: 10, asks: [[5, 10]], mark: 4.5,
    iv: 0.7, greeks: { delta: type === 'call' ? 0.4 : -0.2, gamma: 0.01, vega: 0.1, theta: -0.1 },
    timestamp: now, source: 'live', feeRate: 0.0003,
    feeModel: { kind: 'bybit', fixed: 0, underlyingRate: 0.0003, premiumCapRate: 0.07, spot: 200 } };
}
function orderState(overrides: Partial<BybitOrderReconciliation> = {}): BybitOrderReconciliation {
  return { resolved: false, terminal: false, status: 'unknown', filled: 0, price: null, fee: null, orderId: null, ...overrides };
}
function harness() {
  const db = new Store(':memory:'); stores.push(db);
  const engine = new Engine(db);
  engine.state = initialState('live');
  const position = mixedBinExample(now);
  Object.assign(position, { source: 'live', owner: 'test-solana-owner', benchmarkBins: structuredClone(position.bins), benchmarkAt: now, benchmarkPrice: 200 });
  engine.state.positions = [position]; engine.state.selectedIds = [position.id];
  engine.state.accounts.bybit = { address: 'test-account-1', verified: true, connectedAt: now };
  engine.state.accounts.meteora = { address: position.owner!, verified: true, connectedAt: now };
  engine.state.accounts.hyperliquid = { address: '0x' + '1'.repeat(40), verified: true, connectedAt: now };
  engine.state.market = { source: 'live', timestamp: now, referencePrice: 200, poolPrice: 200, optionIndex: 200, perpMark: 200,
    fundingRate: 0, instruments: [instrument('put', 180), instrument('call', 220)], perpSizeStep: 0.01, perpMinNotional: 10, stablecoinBasisBps: 0, status: {} };
  const venue = { holdings: [] as OptionHolding[], openOrders: [] as Record<string, unknown>[], cash: 1000, credentialFingerprint: 'test-credential-1' };
  const gateway = {
    auth: vi.fn(() => ({ apiKey: 'synthetic-test-key', apiSecret: 'synthetic-test-secret' })),
    credentialFingerprint: vi.fn(() => venue.credentialFingerprint),
    bybitAccount: vi.fn(async (): Promise<BybitAccount> => ({ accountId: 'test-account-1', holdings: structuredClone(venue.holdings),
      openOrders: structuredClone(venue.openOrders), optionCash: venue.cash, usdtCash: venue.cash, availableBalance: venue.cash,
      timestamp: now, permissions: { canTrade: true, readOnly: false, message: 'Synthetic authorization' } })),
    positions: vi.fn(async () => [{ ...structuredClone(position), snapshotAt: now }]),
  } satisfies Pick<Gateway, 'auth' | 'credentialFingerprint' | 'bybitAccount' | 'positions'>;
  let nextPrepared = 0, nextQuote = 0;
  const client = {
    prepare: vi.fn<BybitOptionsClient['prepare']>(async fit => fit.legs.map(leg => {
      const orderLinkId = `test-order-${++nextPrepared}`;
      return { instrument: leg.instrument.name, quantity: leg.quantity, limitPrice: 5, maxFee: 0.5, estimatedFee: 0.06,
        accountId: 'test-account-1', authFingerprint: 'test-api-key-hash', network: 'mainnet', createdAt: now, expiresAt: fit.expiresAt, orderLinkId,
        params: { category: 'option', symbol: leg.instrument.name, side: 'Buy', orderType: 'Limit', qty: String(leg.quantity), price: '5', timeInForce: 'IOC', orderLinkId } };
    })),
    execute: vi.fn<BybitOptionsClient['execute']>(async order => {
      // A crash after dispatch must leave the exact intent durably recoverable.
      const id = db.get<string>('bybitBasketPending'); expect(id).toBeTruthy();
      const basket = db.get<BybitBasket>('bybitBasket:' + id)!;
      const index = basket.orders.findIndex(o => o.orderLinkId === order.orderLinkId);
      expect(index).toBeGreaterThanOrEqual(0); expect(basket.statuses[index]).toBe('submitting');
      expect(basket.orders[index]).toEqual(order);
      return { orderId: 'exchange-' + order.orderLinkId, orderLinkId: order.orderLinkId, status: 'acknowledged' };
    }),
    reconcile: vi.fn<BybitOptionsClient['reconcile']>(async () => orderState()),
  } satisfies BybitOptionsClient;
  function quote(target = engine): FitResult {
    const fit: FitResult = { id: `test-quote-${++nextQuote}`, createdAt: now, expiresAt: now + 15_000, source: 'live', feasible: true,
      legs: target.state.market.instruments.map(i => ({ instrument: { ...i, timestamp: now }, quantity: 2, existingQuantity: 0, cost: 10, fee: 0.12 })),
      cost: 20, fees: 0.24, totalCost: 20.24, reasons: [], maxError: 0, weightedError: 0, maxUndercoverage: 0,
      lowerTailSlopeError: 0, upperTailSlopeError: 0, points: [], settings: { expiry: target.state.market.instruments[0]!.expiry,
        coverage: 1, budget: 100, maxLegs: 4, objective: 'payoff', maxUndercoverage: null }, fingerprint: target.currentFingerprint(),
      greeks: { delta: 0.4, gamma: 0.04, vega: 0.4, theta: -0.4 }, notes: ['Synthetic two-leg execution state test'] };
    target.state.fit = fit; target.save(); return fit;
  }
  function showFill(order: PreparedBybitOrder, quantity: number) {
    const i = engine.state.market.instruments.find(i => i.name === order.instrument)!;
    venue.holdings = venue.holdings.filter(h => h.instrument.name !== order.instrument);
    if (quantity) venue.holdings.push({ instrument: structuredClone(i), quantity, averagePrice: 5 });
  }
  const service = new BybitOptions(engine, db, gateway, client);
  engine.updateDelta(); db.set('activeMode', 'live'); engine.save();
  return { db, engine, venue, gateway, client, service, quote, showFill };
}

describe('Bybit basket preparation and persisted identity', () => {
  it('prepares a durable confirmation without submitting anything or adding planned delta', async () => {
    const h = harness(), delta = h.engine.state.hedge.currentDelta;
    const prepared = await h.service.prepare(h.quote().id, execution);
    const basket = h.db.get<BybitBasket>('bybitBasket:' + prepared.requestId)!;
    expect(prepared.requiresConfirmation).toBe(true);
    expect(h.client.execute).not.toHaveBeenCalled(); expect(h.client.reconcile).not.toHaveBeenCalled();
    expect(basket).toMatchObject({ venue: 'bybit', network: 'mainnet', accountId: 'test-account-1', credentialFingerprint: 'test-credential-1', statuses: ['prepared', 'prepared'], fills: [0, 0] });
    expect(new Set(basket.orders.map(o => o.orderLinkId)).size).toBe(2);
    expect(basket.orders.map(o => o.orderLinkId)).toEqual(prepared.orders.map(o => o.orderLinkId));
    expect(h.engine.state.holdings).toEqual([]); expect(h.engine.state.hedge.currentDelta).toBe(delta);
    expect(h.db.get('bybitBasketPending')).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['account', 'credentials', 'network'] as const)('rejects submission after %s changes before any venue order', async change => {
    const h = harness(), prepared = await h.service.prepare(h.quote().id, execution);
    if (change === 'account') h.engine.state.accounts.bybit!.address = 'another-account';
    if (change === 'credentials') h.venue.credentialFingerprint = 'rotated-test-credential';
    if (change === 'network') vi.stubEnv('BYBIT_NETWORK', 'testnet');
    await expect(h.service.submit(prepared.requestId)).rejects.toThrow(/account, credentials or network changed/);
    expect(h.client.execute).not.toHaveBeenCalled(); expect(h.client.reconcile).not.toHaveBeenCalled();
    expect(h.db.get('bybitBasketPending')).toBeUndefined();
  });

  it('refuses a historical Derive request and migration quarantine instead of dispatching it on Bybit', async () => {
    const h = harness();
    h.db.set('basket:historical-id', { owner: 'old-derive-owner', orders: [{ instrument: 'SOL-OLD', nonce: 42 }], statuses: ['prepared'] });
    await expect(h.service.submit('historical-id')).rejects.toThrow(/Bybit basket/);
    h.engine.state.optionsMigration = { blocked: true, archivedAt: now, reason: 'Legacy Derive exposure needs reconciliation' };
    await expect(h.service.prepare(h.quote().id, execution)).rejects.toThrow(/Legacy Derive/);
    expect(h.client.prepare).not.toHaveBeenCalled(); expect(h.client.execute).not.toHaveBeenCalled();
  });

  it('rejects expiry and changed actual option quantities after preparation', async () => {
    const expired = harness(), prepared = await expired.service.prepare(expired.quote().id, execution);
    now += 15_000;
    await expect(expired.service.submit(prepared.requestId)).rejects.toThrow(/expired/);
    expect(expired.client.execute).not.toHaveBeenCalled();
    const changed = harness(), next = await changed.service.prepare(changed.quote().id, execution);
    changed.venue.holdings = [{ instrument: changed.engine.state.market.instruments[0]!, quantity: -1, averagePrice: 5 }];
    await expect(changed.service.submit(next.requestId)).rejects.toThrow(/portfolio.*changed/);
    expect(changed.client.execute).not.toHaveBeenCalled(); expect(changed.db.get('bybitBasketPending')).toBeUndefined();
  });

  it('rejects an already expired quote without preparing exchange orders', async () => {
    const h = harness(), fit = h.quote(); now = fit.expiresAt;
    await expect(h.service.prepare(fit.id, execution)).rejects.toThrow(/expired/);
    expect(h.client.prepare).not.toHaveBeenCalled(); expect(h.client.execute).not.toHaveBeenCalled();
  });

  it('invalidates an earlier confirmation when a replacement quote is reviewed, even if holdings are unchanged', async () => {
    const h = harness(), prepared = await h.service.prepare(h.quote().id, execution);
    h.quote();
    await expect(h.service.submit(prepared.requestId)).rejects.toThrow(/quote changed/);
    expect(h.client.execute).not.toHaveBeenCalled();
    expect(h.db.get('bybitBasketPending')).toBeUndefined();
  });
});

describe('Bybit account discovery and strategy readiness', () => {
  it('keeps verified key grants separate from extra-asset trading restrictions and prevents worker orders', async () => {
    const h = harness();
    vi.stubEnv('BYBIT_API_KEY', 'synthetic-test-key'); vi.stubEnv('BYBIT_API_SECRET', 'synthetic-test-secret');
    const gateway = new Gateway(h.db, { configured: true, status: () => ({ approved: true }) } as unknown as AgentVault, () => h.engine.state);
    const account: BybitAccount = { accountId: 'test-account-1', holdings: [], openOrders: [], optionCash: 1000,
      usdtCash: 1000, availableBalance: 1500, timestamp: now, permissions: { canTrade: true, readOnly: false, message: 'Synthetic' },
      excludedAssets: [{ coin: 'MNT', quantity: 2, usdValue: 500 }], riskBlockers: ['MNT is outside the SOL strategy'] };
    gateway.cacheBybitAccount(account);
    expect(gateway.capabilities(h.engine.state)).toMatchObject({ bybitAuthenticated: true, bybitExecution: false,
      bybitAccount: { canTrade: false, keyCanTrade: true, strategyReady: false, optionCash: 1000 } });
    expect(gateway.ready(h.engine.state)).toContain('MNT');
    h.engine.state.capabilities = gateway.capabilities(h.engine.state);
    expect(h.engine.publicState().accounting!.scope).toContain('MNT');
    const blockedCapital = h.engine.publicState().accounting!.equity;
    const forbidden = vi.fn(async () => { throw new Error('Account restrictions must stop automatic execution'); });
    h.engine.gateway = { market: async () => structuredClone(h.engine.state.market), ready: s => gateway.ready(s),
      positions: forbidden, portfolio: forbidden, order: forbidden, reconcile: forbidden, cancel: forbidden } satisfies LiveGateway;
    h.engine.state.hedge.enabled = true;
    await h.engine.tick(true);
    expect(forbidden).not.toHaveBeenCalled(); expect(h.engine.state.hedge.status).toBe('suspended');
    gateway.cacheBybitAccount({ ...account, excludedAssets: [], riskBlockers: [] });
    expect(gateway.capabilities(h.engine.state)).toMatchObject({ bybitExecution: true, bybitAccount: { strategyReady: true } });
    h.engine.state.capabilities = gateway.capabilities(h.engine.state);
    expect(h.engine.publicState().accounting!.equity).toBe(blockedCapital);
    expect(gateway.ready(h.engine.state)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Bybit sequential execution and recovery', () => {
  it('completes only after every acknowledged leg is filled and reflected in actual account quantities', async () => {
    const h = harness();
    h.client.reconcile.mockImplementation(async (_auth, order) => {
      h.showFill(order, order.quantity);
      h.venue.cash -= order.quantity * 5 + 0.12;
      return orderState({ resolved: true, terminal: true, status: 'Filled', filled: order.quantity, price: 5, fee: 0.12, orderId: order.orderLinkId });
    });
    const prepared = await h.service.prepare(h.quote().id, execution);
    expect(await h.service.submit(prepared.requestId)).toEqual({ complete: true, reason: null });
    expect(h.client.execute.mock.calls.map(([order]) => order.orderLinkId)).toEqual(prepared.orders.map(order => order.orderLinkId));
    expect(h.db.get<BybitBasket>('bybitBasket:' + prepared.requestId)!.fills).toEqual([2, 2]);
    expect(h.db.get('bybitBasketPending')).toBeUndefined();
    expect(h.engine.state.holdings.map(h => h.quantity)).toEqual([2, 2]);
    expect(h.engine.state.hedge.currentDelta).toBeCloseTo(3 + 2 * -0.2 + 2 * 0.4);
    expect(h.engine.state.balances.reserves).toBeCloseTo(979.76);
    await expect(h.service.submit(prepared.requestId)).rejects.toThrow(/already submitted/);
    expect(h.client.execute).toHaveBeenCalledTimes(2);
  });

  it('treats asynchronous acknowledgment as unresolved and stops the remaining legs', async () => {
    const h = harness(), prepared = await h.service.prepare(h.quote().id, execution);
    const result = await h.service.submit(prepared.requestId);
    expect(result.complete).toBe(false); expect(h.client.execute).toHaveBeenCalledTimes(1);
    expect(h.db.get('bybitBasketPending')).toBe(prepared.requestId);
    expect(h.db.get<BybitBasket>('bybitBasket:' + prepared.requestId)!.statuses).toEqual(['unknown', 'prepared']);
    expect(h.engine.state.holdings).toEqual([]);
    await expect(h.service.submit(prepared.requestId)).rejects.toThrow(/already submitted/);
    await expect(h.service.prepare(h.quote().id, execution)).rejects.toThrow(/requires reconciliation/);
    expect(h.client.execute).toHaveBeenCalledTimes(1);
  });

  it('stops after a terminal partial fill and reconciles the actual signed baseline without buying the next leg', async () => {
    const h = harness();
    h.venue.holdings = [{ instrument: h.engine.state.market.instruments[0]!, quantity: -0.5, averagePrice: 5 }];
    h.engine.state.holdings = structuredClone(h.venue.holdings);
    h.client.reconcile.mockImplementation(async (_auth, order) => {
      h.showFill(order, 0.25); // Existing -0.5 plus the newly filled +0.75.
      return orderState({ resolved: true, terminal: true, status: 'PartiallyFilledCanceled', filled: 0.75, price: 5, fee: 0.045, orderId: 'partial-order' });
    });
    const prepared = await h.service.prepare(h.quote().id, execution);
    expect((await h.service.submit(prepared.requestId)).complete).toBe(false);
    expect(h.client.execute).toHaveBeenCalledTimes(1); expect(h.engine.state.holdings[0]!.quantity).toBe(0.25);
    expect(h.db.get<BybitBasket>('bybitBasket:' + prepared.requestId)!.fills).toEqual([0.75, 0]);
    expect(h.db.get('bybitBasketPending')).toBeUndefined();
    await expect(h.service.submit(prepared.requestId)).rejects.toThrow(/already submitted/);
  });

  it('stops a definitively rejected first order without inventing a fill or sending the second', async () => {
    const h = harness(), prepared = await h.service.prepare(h.quote().id, execution);
    h.client.execute.mockRejectedValueOnce(new VenueError('Bybit', 'Insufficient margin', 400, false));
    const result = await h.service.submit(prepared.requestId);
    expect(result.complete).toBe(false); expect(result.reason).toMatch(/Insufficient margin/);
    expect(h.client.execute).toHaveBeenCalledTimes(1); expect(h.client.reconcile).not.toHaveBeenCalled();
    expect(h.db.get<BybitBasket>('bybitBasket:' + prepared.requestId)!.statuses).toEqual(['rejected', 'prepared']);
    expect(h.db.get('bybitBasketPending')).toBeUndefined(); expect(h.engine.state.holdings).toEqual([]);
  });

  it('retains an ambiguous timeout across restarts and only reads the original order ID', async () => {
    const h = harness(), prepared = await h.service.prepare(h.quote().id, execution);
    h.client.execute.mockRejectedValueOnce(new VenueError('Bybit', 'Timed out after dispatch', undefined, true));
    await h.service.submit(prepared.requestId);
    const originalId = prepared.orders[0]!.orderLinkId;
    const restartedEngine = new Engine(h.db), restarted = new BybitOptions(restartedEngine, h.db, h.gateway, h.client);
    await expect(restarted.reconcile()).rejects.toThrow(/remains unresolved/);
    await expect(restarted.submit(prepared.requestId)).rejects.toThrow(/already submitted/);
    expect(h.client.execute).toHaveBeenCalledTimes(1);
    expect(h.client.reconcile.mock.calls.map(([, order]) => order.orderLinkId)).toEqual([originalId]);
    expect(h.db.get('bybitBasketPending')).toBe(prepared.requestId);
    h.client.reconcile.mockImplementation(async (_auth, order) => {
      h.showFill(order, 2);
      return orderState({ resolved: true, terminal: true, status: 'Filled', filled: 2, price: 5, fee: 0.12, orderId: 'recovered-order' });
    });
    expect((await restarted.reconcile()).complete).toBe(true);
    expect(h.db.get('bybitBasketPending')).toBeUndefined();
    expect(restartedEngine.state.holdings[0]!.quantity).toBe(2);
    const next = await restarted.prepare(h.quote(restartedEngine).id, execution);
    expect(next.orders[0]!.orderLinkId).not.toBe(originalId);
    expect(h.client.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps a post-ack reconciliation error ambiguous even when that read error is definite', async () => {
    const h = harness(), prepared = await h.service.prepare(h.quote().id, execution);
    h.client.reconcile.mockRejectedValueOnce(new VenueError('Bybit', 'History authorization unavailable', 401, false));
    await h.service.submit(prepared.requestId);
    expect(h.db.get<BybitBasket>('bybitBasket:' + prepared.requestId)!.statuses).toEqual(['unknown', 'prepared']);
    expect(h.db.get('bybitBasketPending')).toBe(prepared.requestId);
    expect(h.client.execute).toHaveBeenCalledTimes(1);
  });

  it('does not double count repeated cumulative fills, and waits for a terminal order before unlocking purchases', async () => {
    const h = harness();
    h.client.reconcile.mockImplementation(async (_auth, order) => {
      h.showFill(order, 0.5);
      return orderState({ resolved: true, terminal: false, status: 'PartiallyFilled', filled: 0.5, price: 5, fee: 0.03, orderId: 'open-partial' });
    });
    const prepared = await h.service.prepare(h.quote().id, execution);
    await h.service.submit(prepared.requestId);
    const delta = h.engine.state.hedge.currentDelta;
    await expect(h.service.reconcile()).rejects.toThrow(/remains unresolved/);
    await expect(h.service.reconcile()).rejects.toThrow(/remains unresolved/);
    expect(h.db.get<BybitBasket>('bybitBasket:' + prepared.requestId)!.fills).toEqual([0.5, 0]);
    expect(h.engine.state.holdings[0]!.quantity).toBe(0.5); expect(h.engine.state.hedge.currentDelta).toBe(delta);
    expect(h.client.execute).toHaveBeenCalledTimes(1);
    h.client.reconcile.mockResolvedValue(orderState({ resolved: true, terminal: true, status: 'PartiallyFilledCanceled', filled: 0.5, price: 5, fee: 0.03, orderId: 'open-partial' }));
    expect((await h.service.reconcile()).complete).toBe(true);
    const reads = h.client.reconcile.mock.calls.length;
    expect((await h.service.reconcile()).complete).toBe(true);
    expect(h.client.reconcile).toHaveBeenCalledTimes(reads); expect(h.client.execute).toHaveBeenCalledTimes(1);
  });

  it('retains pending state when terminal fills have not reached account positions, blocking the automatic worker', async () => {
    const h = harness();
    h.client.reconcile.mockImplementation(async (_auth, order) => orderState({ resolved: true, terminal: true, status: 'Filled', filled: order.quantity, price: 5, fee: 0.12, orderId: order.orderLinkId }));
    const prepared = await h.service.prepare(h.quote().id, execution);
    expect((await h.service.submit(prepared.requestId)).complete).toBe(false);
    expect(h.client.execute).toHaveBeenCalledTimes(2);
    expect(h.db.get('bybitBasketPending')).toBe(prepared.requestId);
    expect(h.engine.state.holdings).toEqual([]);
    await expect(h.service.reconcile()).rejects.toThrow(/remains unresolved/);
    const realReady = new Gateway(h.db, {} as AgentVault, () => h.engine.state);
    const forbidden = vi.fn(async () => { throw new Error('An unresolved option basket must block private hedge reconciliation and orders'); });
    h.engine.gateway = { market: async () => structuredClone(h.engine.state.market), ready: state => realReady.ready(state),
      positions: forbidden, portfolio: forbidden, order: forbidden, reconcile: forbidden, cancel: forbidden } satisfies LiveGateway;
    h.engine.state.hedge.enabled = true;
    await h.engine.tick(true);
    expect(forbidden).not.toHaveBeenCalled(); expect(h.engine.state.hedge.status).toBe('suspended');
    expect(h.engine.state.hedge.anchor).toBeNull();
    for (const order of prepared.orders) h.showFill(order, 2);
    expect((await h.service.reconcile()).complete).toBe(true);
    expect(h.db.get('bybitBasketPending')).toBeUndefined();
    expect(h.engine.state.holdings).toHaveLength(2); expect(h.client.execute).toHaveBeenCalledTimes(2);
  });

  it('refuses to clear pending state while an external order remains open', async () => {
    const h = harness();
    h.client.reconcile.mockImplementation(async (_auth, order) => {
      h.showFill(order, 2);
      return orderState({ resolved: true, terminal: true, status: 'Filled', filled: 2, price: 5, fee: 0.12, orderId: order.orderLinkId });
    });
    const prepared = await h.service.prepare(h.quote().id, execution);
    h.gateway.bybitAccount.mockImplementation(async () => ({ accountId: 'test-account-1', holdings: structuredClone(h.venue.holdings),
      openOrders: h.client.execute.mock.calls.length ? [{ orderId: 'external-open-order' }] : [], optionCash: 1000, usdtCash: 1000,
      availableBalance: 1000, timestamp: now, permissions: { canTrade: true, readOnly: false, message: 'Synthetic' } }));
    expect((await h.service.submit(prepared.requestId)).complete).toBe(false);
    expect(h.db.get('bybitBasketPending')).toBe(prepared.requestId);
    await expect(h.service.reconcile()).rejects.toThrow(/remains unresolved/);
    expect(h.client.execute).toHaveBeenCalledTimes(2);
  });
});
