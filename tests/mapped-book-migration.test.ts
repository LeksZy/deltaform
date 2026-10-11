import { afterEach, describe, expect, it, vi } from 'vitest';
import { capitalScope } from '../server/capital-tracking';
import { Engine, initialState, type InternalState } from '../server/engine';
import { blankBook, migrateMultiAsset, type StoredAssetBook } from '../server/multi-asset';
import { Store } from '../server/store';
import { TOKEN_MAPPINGS, USDC_MINT } from '../src/shared/assets';
import type { Position } from '../src/shared/types';

const mint = TOKEN_MAPPINGS.find(token => token.underlying === 'HYPE')!.mint;
const oldKey = `unmapped:${mint}`;
const watchOnly = { status: 'watch-only' as const, reason: 'Unverified mint', requiresBasisMonitoring: true };
const stores: Store[] = [];
const now = Date.UTC(2026, 8, 30, 10);
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.restoreAllMocks(); });
function store() { const value = new Store(':memory:'); stores.push(value); return value; }
function position(id = 'legacy-lp'): Position {
  return { id, pool: 'legacy-pool', owner: 'legacy-owner', name: `${oldKey} / USDC`, source: 'live',
    base: oldKey, quote: 'USDC', baseMint: mint, quoteMint: USDC_MINT, underlying: undefined,
    hedgeMapping: watchOnly, snapshotAt: now - 1000, bins: [{ id: 7, price: 30, x: 2, y: 4 }],
    benchmarkBins: [{ id: 7, price: 30, x: 3, y: 1 }], benchmarkAt: now - 100_000,
    benchmarkPrice: 29, benchmarkX: 3, benchmarkY: 1, baseFees: .1, quoteFees: 2, poolPrice: 30,
    notes: ['Original LP benchmark', watchOnly.reason] };
}
function legacyState() {
  const state = initialState('live');
  state.schemaVersion = 2;
  const legacy = blankBook('SOL', 'live');
  legacy.positions = [position()]; legacy.selectedIds = ['legacy-lp']; legacy.source = 'live';
  legacy.paperDataSource = 'live'; legacy.market.referencePrice = 30; legacy.market.poolPrice = 30;
  legacy.market.timestamp = now - 1000; legacy.market.status = { support: watchOnly.reason };
  legacy.hedge.settings.maxBasisBps = 77;
  legacy.fitSettings = { expiry: now + 86400000, coverage: .8, budget: 500, maxLegs: 2, objective: 'payoff', maxUndercoverage: null };
  legacy.modelSettings = { expiry: now + 86400000, ivMode: 'manual', ivPercent: 64, daysAhead: 2 };
  legacy.revision = 4;
  state.books = { [oldKey]: legacy, HYPE: blankBook('HYPE', 'live') };
  Object.assign(state, legacy);
  state.activeUnderlying = oldKey;
  return { state, legacy };
}

describe('exact-mint legacy book migration', () => {
  it('moves an active HYPE LP, keeps its IL benchmark and capital scope, and remains paused across restart', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const db = store(); const { state, legacy } = legacyState();
    const scope = capitalScope(state);
    const tracking = { baseline: { scopeKey: scope, equity: 1000 }, flows: [] };
    db.set('activeMode', 'live'); db.set('state:live', state); db.set('capitalTracking:live', tracking);
    const engine = new Engine(db);
    const mapped = engine.state.books!.HYPE;
    expect(engine.state.activeUnderlying).toBe('HYPE');
    expect(engine.state.positions).toBe(mapped.positions);
    expect(mapped.positions).toHaveLength(1);
    expect(mapped.positions[0]).toMatchObject({ id: 'legacy-lp', base: 'HYPE', underlying: 'HYPE',
      baseMint: mint, hedgeMapping: { status: 'proxy', requiresBasisMonitoring: true },
      benchmarkBins: legacy.positions[0]!.benchmarkBins, benchmarkAt: legacy.positions[0]!.benchmarkAt,
      benchmarkPrice: 29, benchmarkX: 3, benchmarkY: 1 });
    expect(mapped.selectedIds).toEqual(['legacy-lp']);
    expect(mapped.hedge.settings.maxBasisBps).toBe(77);
    expect(mapped.fitSettings).toEqual(legacy.fitSettings);
    expect(mapped.modelSettings).toEqual(legacy.modelSettings);
    expect(mapped.hedge).toMatchObject({ enabled: false, status: 'paused', pendingOrder: null });
    expect(mapped.intent).toBeNull(); expect(mapped.fit).toBeNull();
    expect(mapped.market).toMatchObject({ referencePrice: 30, timestamp: 0, perpSizeStep: 0 });
    expect(engine.state.books![oldKey]).toBeUndefined();
    expect(capitalScope(engine.state)).toBe(scope);
    expect(db.get('capitalTracking:live')).toEqual(tracking);
    expect(db.get<{ book: StoredAssetBook }>(`archive:mapped-book:live:${mint}`)?.book).toEqual(legacy);
    expect(engine.state.events.some(event => event.type === 'order-intent')).toBe(false);

    const again = new Engine(db);
    expect(again.state.books!.HYPE.positions).toHaveLength(1);
    expect(again.state.books!.HYPE.revision).toBe(mapped.revision);
    expect(again.state.books![oldKey]).toBeUndefined();
    expect(capitalScope(again.state)).toBe(scope);
  });

  it('deduplicates a previously imported position by ID while retaining the older benchmark', () => {
    const db = store(); const { state } = legacyState();
    const current = { ...position(), base: 'HYPE', underlying: 'HYPE', snapshotAt: now,
      bins: [{ id: 7, price: 31, x: 1, y: 31 }], benchmarkX: 1, benchmarkY: 31 };
    state.books!.HYPE.positions = [current, { ...position('other-lp'), base: 'HYPE', underlying: 'HYPE' }];
    state.books!.HYPE.selectedIds = ['other-lp'];
    const migrated = migrateMultiAsset(db, state);
    const target = migrated.books!.HYPE;
    expect(target.positions.map(p => p.id)).toEqual(['legacy-lp', 'other-lp']);
    expect(target.positions[0]).toMatchObject({ bins: current.bins, snapshotAt: now, benchmarkX: 3, benchmarkY: 1 });
    expect(target.selectedIds).toEqual(['other-lp', 'legacy-lp']);
    expect(migrated.books![oldKey]).toBeUndefined();
    expect(migrated.activeUnderlying).toBe('HYPE');
    expect(target.hedge.enabled).toBe(false);
  });

  it('leaves unverified or inconsistent mints watch-only and retains unresolved exposure', () => {
    const db = store(); const { state } = legacyState();
    const unknownKey = 'unmapped:unverified-mint';
    const unknown = structuredClone(state.books![oldKey]);
    unknown.positions[0]!.baseMint = 'unverified-mint';
    state.books![unknownKey] = unknown;
    state.books![oldKey].positions[0]!.baseMint = 'ticker-spoof';
    migrateMultiAsset(db, state);
    expect(state.books![oldKey].positions).toHaveLength(1);
    expect(state.books![unknownKey].positions).toHaveLength(1);
    expect(db.get(`archive:mapped-book:live:${mint}`)).toBeUndefined();

    state.books![oldKey].positions[0]!.baseMint = mint;
    state.books![oldKey].hedge.pendingOrder = 'unresolved';
    migrateMultiAsset(db, state);
    expect(state.books![oldKey].positions).toHaveLength(1);
    expect(state.books!.HYPE.positions).toHaveLength(0);
  });
});
