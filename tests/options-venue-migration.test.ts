import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, initialState, migrateOptionsVenue, type InternalState, type LiveGateway } from '../server/engine';
import { DEFAULT_RISK, evaluateHedge, type PolicyInput } from '../server/policy';
import { Store } from '../server/store';
import { demoMarket, mixedBinExample } from '../src/quant/fixtures';
import type { FitResult, OptionHolding } from '../src/shared/types';

const now = Date.UTC(2026, 8, 27, 12);
const stores: Store[] = [];
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.restoreAllMocks(); });
function store() { const result = new Store(':memory:'); stores.push(result); return result; }

/** Construct the old persisted shape deliberately, rather than calling the migration itself. */
function legacy(mode: 'paper' | 'live' = 'live'): InternalState {
  const state = initialState(mode);
  delete (state as Partial<InternalState>).optionsVenue;
  const position = mixedBinExample(now - 86_400_000);
  position.source = mode === 'live' ? 'live' : 'fixture';
  position.owner = 'historical-solana-owner';
  position.benchmarkBins = structuredClone(position.bins);
  position.benchmarkAt = now - 86_400_000;
  position.benchmarkPrice = 200;
  // A later inventory mix must not silently become the initial IL benchmark.
  const active = position.bins.find(bin => bin.x > 0 && bin.y > 0)!;
  active.x += 0.125; active.y -= active.price * 0.125;
  position.snapshotAt = now;
  state.positions = [position]; state.selectedIds = [position.id];
  state.accounts = {
    meteora: { address: position.owner, verified: true, connectedAt: now - 1000 },
    hyperliquid: { address: '0x' + '1'.repeat(40), verified: true, connectedAt: now - 1000 },
    derive: { address: '0x' + '2'.repeat(40), verified: true, connectedAt: now - 1000, subaccountId: 17 },
  } as InternalState['accounts'];
  state.market = demoMarket(now, 200);
  state.market.instruments = state.market.instruments.map(instrument => ({ ...instrument, venue: 'derive' }));
  state.fit = { id: 'reviewed-on-derive', fingerprint: 'legacy-fingerprint' } as FitResult;
  state.hedge.enabled = true; state.hedge.status = 'running'; state.hedge.anchor = 199;
  state.hedge.actualPerp = -2.5; state.perpEntry = 195;
  state.balances = { collateral: 1234, reserves: 50, optionPremiums: 12, perpRealized: 3, funding: -0.7, costs: 0.9 };
  state.liveAttribution = { optionPremiums: 12, perpRealized: 3, funding: -0.7, costs: 0.9, scope: 'Historical Derive and Hyperliquid book' };
  state.events = [{ id: 'historic-event', timestamp: now - 1000, type: 'options-fill', message: 'Derive fill observed' }];
  state.revision = 7; state.hedgedRevision = 7;
  return state;
}
function legacyHolding(state: InternalState, quantity: number): OptionHolding {
  return { instrument: { ...state.market.instruments[0]!, venue: 'derive' }, quantity, averagePrice: 3 };
}

describe('options venue migration', () => {
  it('archives the old live book and preserves LP benchmarks, Hyperliquid exposure and unresolved intent without transferring Derive cash', () => {
    const db = store(), old = legacy();
    old.intent = { cloid: '0x' + 'a'.repeat(32), quantity: -1, price: 200, createdAt: now - 500, reason: 'Initial hedge', appliedFill: 0.25 };
    old.hedge.pendingOrder = old.intent.cloid;
    const original = structuredClone(old);
    const migrated = migrateOptionsVenue(db, old);
    expect(old).toEqual(original);
    expect(db.get<{ archivedAt: number; state: InternalState }>('archive:derive:live')).toEqual({ archivedAt: now, state: original });
    expect(migrated.optionsVenue).toBe('bybit');
    expect(migrated.optionsMigration?.blocked).toBe(false);
    expect(migrated.hedge).toMatchObject({ enabled: false, status: 'paused', anchor: null, actualPerp: -2.5, pendingOrder: old.intent.cloid });
    expect(migrated.intent).toEqual(original.intent);
    expect(migrated.perpEntry).toBe(195);
    expect(migrated.positions).toEqual(original.positions);
    expect(migrated.positions[0]!.benchmarkBins).not.toEqual(migrated.positions[0]!.bins);
    expect(migrated.selectedIds).toEqual(original.selectedIds);
    expect(migrated.accounts).toEqual({ meteora: original.accounts.meteora, hyperliquid: original.accounts.hyperliquid, bybit: null });
    expect(migrated.balances).toEqual({ ...original.balances, reserves: 0 });
    expect(migrated.liveAttribution).toBeUndefined();
    expect(migrated.fit).toBeNull();
    expect(migrated.market).toMatchObject({ timestamp: 0, optionIndex: 0, instruments: [] });
    expect(migrated.capabilities.liveExecution).toBe(false);
    expect(migrated.capabilities.bybitExecution).toBe(false);
    expect(migrated.events).toEqual(original.events);
  });

  it.each([1, -1])('quarantines a nonzero signed Derive position (%s) instead of relabeling or dropping its risk', quantity => {
    const db = store(), old = legacy(); old.holdings = [legacyHolding(old, quantity)];
    const migrated = migrateOptionsVenue(db, old);
    expect(migrated.optionsMigration?.blocked).toBe(true);
    expect(migrated.optionsMigration?.reason).toMatch(/Legacy Derive/);
    expect(migrated.holdings).toEqual(old.holdings);
    expect(migrated.holdings[0]!.instrument.venue).toBe('derive');
    expect(migrated.hedge.enabled).toBe(false);
    expect(migrated.accounts.bybit).toBeNull();
  });

  it('blocks unresolved Derive baskets even when the current holdings snapshot is empty', () => {
    const db = store(), old = legacy();
    const pending = { owner: old.accounts.derive!.address, statuses: ['unknown'], orders: [{ nonce: 'persisted-derive-nonce' }] };
    db.set('deriveBasketPending', 'old-request'); db.set('basket:old-request', pending);
    const migrated = migrateOptionsVenue(db, old);
    expect(migrated.optionsMigration?.blocked).toBe(true);
    expect(migrated.hedge.enabled).toBe(false);
    expect(db.get('deriveBasketPending')).toBe('old-request');
    expect(db.get('basket:old-request')).toEqual(pending);
  });

  it('does not block a flat legacy book solely because a zero-quantity instrument remains in its snapshot', () => {
    const db = store(), old = legacy(); old.holdings = [legacyHolding(old, 0)];
    const migrated = migrateOptionsVenue(db, old);
    expect(migrated.optionsMigration?.blocked).toBe(false);
    expect(migrated.holdings).toEqual([]);
    expect(migrated.balances.reserves).toBe(0);
  });

  it('archives the prior paper book and starts a fresh paused demo without rewriting historical events', () => {
    const db = store(), old = legacy('paper'); old.holdings = [legacyHolding(old, 3)];
    db.appendEvent('paper', old.events[0]!);
    const migrated = migrateOptionsVenue(db, old);
    expect(db.get<{ state: InternalState }>('archive:derive:paper')!.state).toEqual(old);
    expect(migrated.mode).toBe('paper'); expect(migrated.optionsVenue).toBe('bybit');
    expect(migrated.optionsMigration?.blocked).toBe(false);
    expect(migrated.holdings).toEqual([]); expect(migrated.fit).toBeNull();
    expect(migrated.hedge).toMatchObject({ enabled: false, status: 'paused', actualPerp: 0, anchor: null, pendingOrder: null });
    expect(migrated.intent).toBeNull();
    expect(migrated.balances.reserves).toBe(5000);
    expect(migrated.accounts.bybit).toBeNull();
    expect(db.history('paper')).toEqual(old.events);
  });

  it('is idempotent and never overwrites the original archive on later startup', () => {
    const db = store(), old = legacy();
    const migrated = migrateOptionsVenue(db, old);
    migrated.balances.reserves = 123; migrated.revision = 41;
    const archive = db.get('archive:derive:live');
    const again = migrateOptionsVenue(db, migrated);
    expect(again).toEqual(migrated);
    db.set('activeMode', 'live'); db.set('state:live', migrated);
    const restarted = new Engine(db);
    expect(restarted.state.balances.reserves).toBe(123);
    expect(restarted.state.revision).toBe(41);
    expect(restarted.state.optionsMigration).toEqual(migrated.optionsMigration);
    expect(db.get('archive:derive:live')).toEqual(archive);
    expect((archive as { state: InternalState }).state.balances.reserves).toBe(50);
  });

  it('migrates a previously unopened live book when switching modes', async () => {
    const db = store(), old = legacy();
    db.set('state:live', old);
    const engine = new Engine(db);
    expect(engine.state.mode).toBe('paper');
    await engine.mode('live');
    expect(engine.state.optionsVenue).toBe('bybit');
    expect(engine.state.hedge.enabled).toBe(false);
    expect(engine.state.balances.reserves).toBe(0);
    expect(engine.state.positions).toEqual(old.positions);
    expect(db.get<{ state: InternalState }>('archive:derive:live')!.state).toEqual(old);
  });

  it('refreshes public data after legacy live restart without resuming account calls or orders', async () => {
    const db = store(), old = legacy();
    db.set('activeMode', 'live'); db.set('state:live', old);
    const engine = new Engine(db);
    const market = vi.fn(async () => ({ ...demoMarket(now, 200), source: 'live' as const }));
    const forbidden = vi.fn(async () => { throw new Error('Private access or execution must not occur'); });
    engine.gateway = { market, ready: vi.fn(() => null), positions: forbidden, portfolio: forbidden, order: forbidden, reconcile: forbidden, cancel: forbidden } satisfies LiveGateway;
    await engine.tick(true);
    expect(market).toHaveBeenCalledOnce();
    expect(forbidden).not.toHaveBeenCalled();
    expect(engine.gateway.ready).not.toHaveBeenCalled();
    expect(engine.state.hedge.enabled).toBe(false);
    expect(engine.state.hedge.anchor).toBeNull();
  });
});

function bybitPolicyInput(basis?: number): PolicyInput {
  const market = demoMarket(now, 200);
  market.referencePrice = market.poolPrice = market.optionIndex = market.perpMark = 200;
  market.instruments = market.instruments.map(instrument => ({ ...instrument, venue: 'bybit', quoteCoin: 'USDT', settleCoin: 'USDT' }));
  market.stablecoinBasisBps = basis;
  return { market, now, nonPerpDelta: 10, benchmarkDelta: 10, collateral: 10000, force: true,
    hedge: { enabled: true, status: 'running', reason: '', anchor: null, lastHedgeAt: null,
      actualPerp: 0, desiredPerp: -10, currentDelta: 10, targetDelta: 0, pendingOrder: null, settings: { ...DEFAULT_RISK } } };
}
describe('Bybit stablecoin settlement basis policy', () => {
  it.each([undefined, NaN, Infinity, -Infinity, 150.01, -150.01])('suspends even at an initial forced hedge when basis is %s', basis => {
    const result = evaluateHedge(bybitPolicyInput(basis));
    expect(result.action).toBe('suspend');
    expect(result.reason).toMatch(/USDT\/USDC settlement basis/);
    expect(result.quantity).toBe(0);
  });
  it.each([0, 149.99, -149.99, 150, -150])('allows a hedge only when the measured basis (%s bps) satisfies the configured limit', basis => {
    const result = evaluateHedge(bybitPolicyInput(basis));
    expect(result.action).toBe('order');
    expect(result.quantity).toBe(-10);
  });
});
