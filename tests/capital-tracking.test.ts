import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine, initialState } from '../server/engine';
import { Store } from '../server/store';
import { demoAssetMarket, demoAssetPosition, demoPosition } from '../src/quant/fixtures';
import { CAPITAL_TRACKING_KEY, addCapitalFlow, capitalScope, capitalSnapshotsStale, captureCapitalBaseline, reverseCapitalFlow, trackedPnl } from '../server/capital-tracking';
import type { AppState, CapitalFlow } from '../src/shared/types';
import type { AssetBook } from '../src/shared/multi-asset';
import { createHash } from 'node:crypto';

const now = Date.UTC(2026, 8, 28, 12);
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); vi.restoreAllMocks(); });
function live() {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const store = new Store(':memory:'); stores.push(store);
  const state = initialState('live'), position = demoPosition(now);
  position.source = 'live'; position.owner = 'SolanaOwner'; position.bins = [{ id: 0, price: 100, x: 2, y: 100 }];
  position.baseFees = 0; position.quoteFees = 0;
  state.positions = [position]; state.selectedIds = [position.id];
  state.accounts = { meteora: { address: 'SolanaOwner', verified: true, connectedAt: now },
    bybit: { address: '1234', verified: true, connectedAt: now }, hyperliquid: { address: '0xABC', verified: true, connectedAt: now } };
  state.capabilities.bybitNetwork = 'mainnet';
  state.capabilities.bybitAccount = { accountId: '1234', checkedAt: now, canTrade: true, readOnly: false, availableBalance: 50, optionCash: 50, message: 'test' };
  state.market = { ...state.market, source: 'live', referencePrice: 100, perpMark: 100, timestamp: now };
  state.balances.collateral = 500; state.balances.reserves = 50;
  state.hedge.accountSnapshot = { owner: '0xabc', timestamp: now };
  store.set('activeMode', 'live'); store.set('state:live', state);
  const engine = new Engine(store);
  return { engine, store };
}
function start(e: Engine) {
  const snapshot = e.publicState(), tracking = captureCapitalBaseline(snapshot, now);
  e.store.set(CAPITAL_TRACKING_KEY, tracking);
  return tracking;
}
function movement(kind: CapitalFlow['kind'], amount: number, id = 'flow'): CapitalFlow {
  return { id, kind, amount, effectiveAt: now, recordedAt: now, note: 'External transfer' };
}
describe('Live capital baseline and external-flow accounting', () => {
  it('starts at zero, persists across engine restart and keeps IL benchmark independent', async () => {
    const { engine: e, store } = live();
    expect(e.publicState().accounting!.pnl).toBeNull();
    const beforeBins = structuredClone(e.state.positions[0].benchmarkBins), tracking = start(e);
    expect(tracking.baseline.equity).toBe(850); // 300 LP + 500 HL + 50 Bybit.
    expect(e.publicState().accounting).toMatchObject({ pnl: 0, initialCapital: 850, pnlStartedAt: now, netCapitalFlows: 0, pnlStale: false });
    e.state.balances.collateral += 5; e.save();
    const restarted = new Engine(store);
    expect(restarted.publicState().accounting!.pnl).toBe(5);
    expect(restarted.state.positions[0].benchmarkBins).toEqual(beforeBins);
    const id = restarted.publicState().capitalTracking!.baseline.id;
    await restarted.startCapitalTracking(); // Retry returns original baseline without venue calls.
    expect(restarted.publicState().capitalTracking!.baseline.id).toBe(id);
  });
  it('does not treat deposits and withdrawals as profits or losses or change venue balances', () => {
    const { engine: e } = live(); start(e);
    e.state.balances.collateral += 100;
    e.recordCapitalFlow(movement('deposit', 100));
    expect(e.state.balances.collateral).toBe(600); expect(e.publicState().accounting!.pnl).toBe(0);
    e.state.balances.reserves -= 25;
    e.recordCapitalFlow(movement('withdrawal', 25, 'withdraw'));
    expect(e.state.balances.reserves).toBe(25); expect(e.publicState().accounting!.pnl).toBe(0);
    e.state.balances.collateral += 10;
    expect(e.publicState().accounting).toMatchObject({ pnl: 10, netCapitalFlows: 75 });
  });
  it('records cash flows idempotently and reverses mistakes without moving funds', () => {
    const { engine: e } = live(); start(e);
    e.recordCapitalFlow(movement('deposit', 100));
    e.recordCapitalFlow(movement('deposit', 100));
    expect(e.publicState().capitalTracking!.flows).toHaveLength(1);
    expect(e.publicState().accounting!.pnl).toBe(-100);
    expect(() => e.recordCapitalFlow(movement('deposit', 50))).toThrow('different movement');
    e.reverseCapitalFlowEntry('flow'); e.reverseCapitalFlowEntry('flow');
    expect(e.publicState().accounting!.pnl).toBe(0);
    expect(e.publicState().capitalTracking!.flows[0].reversedAt).toBe(now);
    expect(e.state.balances.collateral).toBe(500);
  });
  it('counts premiums, fees, funding and perp P&L once through marked capital', () => {
    const { engine: e } = live(); start(e);
    const instrument = { ...e.state.market.instruments[0], source: 'live' as const, mark: 10, timestamp: now, multiplier: 1 };
    e.state.holdings = [{ instrument, quantity: 1, averagePrice: 10 }];
    e.state.balances.reserves -= 10;
    e.state.balances.optionPremiums = 10;
    expect(e.publicState().accounting!.pnl).toBe(0); // Purchase exchanges cash for an equal-valued asset.
    e.state.balances.reserves -= 1; e.state.balances.costs = 1;
    e.state.balances.collateral += 2; e.state.balances.funding = 2;
    expect(e.publicState().accounting!.pnl).toBe(1);
    e.state.hedge.actualPerp = -1; e.state.perpEntry = 100; e.state.market.perpMark = 95;
    e.state.balances.collateral += 5; // Live venue equity already contains the 5 unrealized P&L.
    expect(e.publicState().accounting).toMatchObject({ pnl: 6, perpUnrealized: 5 });
  });
  it('withholds P&L on scope changes but not trading changes; respects Solana case and network', () => {
    const { engine: e } = live(); start(e);
    const scope = capitalScope(e.state);
    e.state.hedge.actualPerp = -2; e.state.positions[0].bins[0].x = 3;
    expect(capitalScope(e.state)).toBe(scope);
    e.state.accounts.hyperliquid!.address = '0xabc'; expect(capitalScope(e.state)).toBe(scope);
    e.state.accounts.meteora!.address = 'solanaowner';
    expect(e.publicState().accounting!.pnl).toBeNull();
    e.state.accounts.meteora!.address = 'SolanaOwner'; e.state.capabilities.bybitNetwork = 'testnet';
    expect(e.publicState().accounting!.pnl).toBeNull();
    e.state.capabilities.bybitNetwork = 'mainnet'; e.state.selectedIds = [];
    expect(e.publicState().accounting!.pnlUnavailableReason).toContain('selected LP positions changed');
  });
  it('refuses incomplete, stale, unverified or in-flight opening snapshots', () => {
    const { engine: e } = live(); const snapshot = e.publicState();
    for (const modify of [
      (s: AppState) => { s.accounting!.equity = null; },
      (s: AppState) => { s.market.timestamp = now - 100000; },
      (s: AppState) => { s.accounts.bybit!.verified = false; },
      (s: AppState) => { s.hedge.pendingOrder = 'pending'; },
      (s: AppState) => { s.positions[0].source = 'fixture'; },
      (s: AppState) => { s.hedge.accountSnapshot!.owner = '0xother'; },
    ]) { const s = structuredClone(snapshot); modify(s); expect(() => captureCapitalBaseline(s, now)).toThrow(); }
    start(e); e.state.holdings = [{ instrument: { ...e.state.market.instruments[0], mark: null, iv: null }, quantity: 1, averagePrice: 1 }];
    expect(e.publicState().accounting!.pnl).toBeNull();
  });
  it('rejects future, pre-baseline and invalid flows; historical arithmetic only includes effective movements', () => {
    const { engine: e } = live(); const tracking = start(e);
    for (const f of [{ ...movement('deposit', 1), effectiveAt: now - 1 }, { ...movement('deposit', 1), effectiveAt: now + 2000 },
      movement('deposit', -1), movement('deposit', NaN), { ...movement('deposit', 1), note: '' }]) {
      expect(() => addCapitalFlow(tracking, f, now)).toThrow();
    }
    const ledger = { ...tracking, baseline: { ...tracking.baseline, equity: 1000 }, flows: [movement('deposit', 100), movement('withdrawal', 25, 'out')] };
    expect(trackedPnl(e.state, ledger, 1085, now)).toMatchObject({ pnl: 10, netFlows: 75 });
    expect(trackedPnl(e.state, ledger, 1000, now - 1)).toMatchObject({ pnl: 0, netFlows: 0 });
    expect(() => reverseCapitalFlow(ledger, 'unknown', now)).toThrow('not found');
  });
  it('keeps paper baseline accounting separate from the live ledger', () => {
    const { engine: e, store } = live(); start(e);
    e.state = initialState('paper');
    expect(e.publicState().accounting!.pnl).toBeCloseTo(0, 8);
    expect(e.publicState().capitalTracking).toBeUndefined();
    expect(store.get(CAPITAL_TRACKING_KEY)).toBeDefined();
  });
  it('updates monitored capital while paused without calling order execution', async () => {
    const { engine: e } = live(); start(e);
    const order = vi.fn(), reconcile = vi.fn();
    e.gateway = { ready: () => null, market: async () => e.state.market, positions: async () => e.state.positions,
      portfolio: vi.fn(async () => ({ positions: e.state.positions, holdings: [], actualPerp: 0, collateral: 510, entryPrice: 0, optionCash: 50, accountTimestamp: now })),
      order, reconcile, cancel: vi.fn() };
    await e.tick();
    expect(e.publicState().accounting!.pnl).toBe(10);
    expect(order).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled(); expect(e.state.hedge.enabled).toBe(false);
    await e.tick(); expect(e.gateway.portfolio).toHaveBeenCalledTimes(1);
  });
});

function capitalBook(underlying: string, empty = false): AssetBook {
  const base = initialState('live'), p = { ...demoAssetPosition(underlying, now), source: 'live' as const, owner: 'SolanaOwner' };
  return { source: 'live', positions: empty ? [] : [p], selectedIds: empty ? [] : [p.id], holdings: [], fit: null,
    market: { ...demoAssetMarket(underlying, now), source: 'live', timestamp: empty ? 0 : now },
    hedge: { ...base.hedge, accountSnapshot: empty ? undefined : { owner: '0xABC', timestamp: now } } };
}
function capitalState(): AppState {
  const sol = capitalBook('SOL'), btc = capitalBook('BTC');
  return { ...initialState('live'), ...sol, activeUnderlying: 'SOL', books: { SOL: structuredClone(sol), BTC: btc, DOGE: capitalBook('DOGE', true) },
    accounts: { meteora: { address: 'SolanaOwner', verified: true, connectedAt: now },
      bybit: { address: '1234', verified: true, connectedAt: now }, hyperliquid: { address: '0xABC', verified: true, connectedAt: now } },
    capabilities: { ...initialState('live').capabilities, bybitNetwork: 'mainnet', bybitAccount: { accountId: '1234', checkedAt: now,
      canTrade: true, readOnly: false, availableBalance: 100, optionCash: 100, message: 'test' } },
    accounting: { equity: 10000, valuationComplete: true, perpUnrealized: 0, optionsValue: 0, initialCapital: 0, pnl: null, scope: 'All selected asset books + shared cash once' } };
}
describe('multi-asset capital scope and snapshot completeness', () => {
  it('retains the legacy single-SOL scope hash exactly and ignores untouched empty books', () => {
    const state = capitalState(); delete state.books!.BTC;
    const oldHash = createHash('sha256').update(JSON.stringify({
      accounts: { meteora: 'SolanaOwner', bybit: '1234', hyperliquid: '0xabc' }, optionsVenue: 'bybit', bybitNetwork: 'mainnet',
      pools: state.positions.map(p => [p.id, p.pool, p.owner]).sort(),
    })).digest('hex');
    expect(capitalScope(state)).toBe(oldHash);
    expect(capitalSnapshotsStale(state, now)).toBe(false);
    expect(captureCapitalBaseline(state, now).baseline.scopeKey).toBe(oldHash);
    expect(state.books!.DOGE.market.timestamp).toBe(0);
  });
  it('measures every selected LP identity and remains stable when the viewed book changes', () => {
    const state = capitalState(), scope = capitalScope(state), baseline = captureCapitalBaseline(state, now);
    state.books!.SOL = { ...state.books!.SOL!, positions: state.positions, selectedIds: state.selectedIds, hedge: state.hedge };
    Object.assign(state, state.books!.BTC, { activeUnderlying: 'BTC' });
    expect(capitalScope(state)).toBe(scope);
    expect(trackedPnl(state, baseline, 10005, now).pnl).toBe(5);
    state.books!.SOL!.selectedIds = [];
    expect(capitalScope(state)).not.toBe(scope);
    expect(trackedPnl(state, baseline, 10005, now).pnl).toBeNull();
  });
  it('uses top-level active changes before a stale stored copy and forbids pending orders in another book', () => {
    const state = capitalState(), scope = capitalScope(state);
    state.selectedIds = [];
    expect(capitalScope(state)).not.toBe(scope);
    state.books!.BTC!.hedge.pendingOrder = 'btc-inflight';
    expect(() => captureCapitalBaseline(state, now)).toThrow(/pending hedge order/);
  });
  it('requires freshness for holdings-only and perp-only exposure even without a selected LP', () => {
    for (const exposure of ['option', 'perp'] as const) {
      const state = capitalState(), btc = state.books!.BTC!;
      btc.selectedIds = []; btc.positions = [];
      if (exposure === 'option') btc.holdings = [{ instrument: { ...btc.market.instruments[0]!, source: 'live' }, quantity: 1, averagePrice: 1 }];
      else btc.hedge.actualPerp = -.1;
      expect(capitalSnapshotsStale(state, now)).toBe(false);
      btc.hedge.accountSnapshot!.timestamp = now - 100000;
      expect(capitalSnapshotsStale(state, now)).toBe(true);
      expect(() => captureCapitalBaseline(state, now)).toThrow(/Refresh markets/);
    }
  });
  it('rejects inactive fixture holdings, expired options, unmarked options, wrong-owner snapshots and stale positions', () => {
    const mutations = [
      (book: AssetBook) => { book.positions[0]!.source = 'fixture'; },
      (book: AssetBook) => { book.positions[0]!.snapshotAt = now - 100000; },
      (book: AssetBook) => { book.hedge.accountSnapshot!.owner = '0xOTHER'; },
      (book: AssetBook) => { book.holdings = [{ instrument: book.market.instruments[0]!, quantity: 1, averagePrice: 1 }]; },
      (book: AssetBook) => { book.holdings = [{ instrument: { ...book.market.instruments[0]!, source: 'live', expiry: now - 1 }, quantity: 1, averagePrice: 1 }]; },
      (book: AssetBook) => { book.holdings = [{ instrument: { ...book.market.instruments[0]!, source: 'live', mark: null }, quantity: 1, averagePrice: 1 }]; },
    ];
    for (const mutate of mutations) {
      const state = capitalState(); mutate(state.books!.BTC!);
      expect(() => captureCapitalBaseline(state, now)).toThrow();
    }
  });
});
