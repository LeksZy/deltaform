import { resolveMeteoraPair, STABLECOINS, TOKEN_MAPPINGS } from '../src/shared/assets';
import type { Position } from '../src/shared/types';
import type { InternalState } from './engine';
import type { StoredAssetBook } from './multi-asset';
import type { Store } from './store';

const UNMAPPED_PREFIX = 'unmapped:';
const ACTIVE_BOOK_FIELDS = ['source', 'paperDataSource', 'positions', 'selectedIds', 'holdings', 'market', 'fit', 'hedge',
  'perpEntry', 'lastFundingAt', 'revision', 'hedgedRevision', 'intent'] as const;

function mappedPosition(old: Position, current: Position | undefined, underlying: string): Position {
  const mapping = resolveMeteoraPair(old.baseMint!, old.quoteMint!);
  const latest = current && current.snapshotAt > old.snapshotAt ? current : old;
  const oldReason = old.hedgeMapping?.reason;
  const notes = [...new Set([...(old.notes ?? []), ...(latest.notes ?? [])].filter(note => note !== oldReason)
    .concat(mapping.hedgeMapping.reason))];
  return {
    ...latest, base: underlying, underlying, hedgeMapping: mapping.hedgeMapping,
    name: latest.name.startsWith(`${UNMAPPED_PREFIX}${old.baseMint} / `)
      ? `${underlying}${latest.name.slice(`${UNMAPPED_PREFIX}${old.baseMint}`.length)}` : latest.name,
    notes,
    // A newer mapped discovery is useful for current inventory, but must not reset the IL baseline.
    benchmarkBins: old.benchmarkBins ?? old.bins, benchmarkAt: old.benchmarkAt ?? old.snapshotAt,
    benchmarkPrice: old.benchmarkPrice ?? old.poolPrice,
    benchmarkX: old.benchmarkX, benchmarkY: old.benchmarkY,
  };
}

/** Move exact-mint legacy LPs to their verified economic book without creating an order or enabling a hedge. */
export function migrateVerifiedMappedBooks(store: Store, state: InternalState): InternalState {
  const books = state.books;
  if (!books) return state;
  for (const [legacyKey, legacy] of Object.entries(books)) {
    if (!legacyKey.startsWith(UNMAPPED_PREFIX)) continue;
    const mint = legacyKey.slice(UNMAPPED_PREFIX.length);
    const token = TOKEN_MAPPINGS.find(candidate => candidate.mint === mint);
    const target = token && books[token.underlying];
    if (!token || !target) continue;
    const move = legacy.positions.filter(position => position.source === 'live' && position.baseMint === mint
      && STABLECOINS.some(stablecoin => stablecoin.mint === position.quoteMint));
    if (!move.length) continue;
    // A watch-only LP book should have no venue exposure. Retain anomalous books for review.
    if (legacy.holdings.some(holding => holding.quantity !== 0) || legacy.hedge.actualPerp !== 0
      || legacy.intent || legacy.hedge.pendingOrder || target.intent || target.hedge.pendingOrder) continue;

    const archiveKey = `archive:mapped-book:${state.mode}:${mint}`;
    if (!store.get(archiveKey)) store.set(archiveKey, {
      archivedAt: Date.now(), from: legacyKey, to: token.underlying, book: structuredClone(legacy),
    });

    const destinationWasEmpty = target.positions.length === 0 && target.selectedIds.length === 0
      && target.holdings.every(holding => holding.quantity === 0) && target.hedge.actualPerp === 0
      && !target.intent && !target.hedge.pendingOrder;
    const merged = new Map(target.positions.map(position => [position.id, position]));
    for (const position of move) merged.set(position.id, mappedPosition(position, merged.get(position.id), token.underlying));
    target.positions = [...merged.values()];
    const movedIds = new Set(move.map(position => position.id));
    target.selectedIds = [...new Set([...target.selectedIds, ...legacy.selectedIds.filter(id => movedIds.has(id))])];
    if (destinationWasEmpty) {
      target.source = legacy.source;
      target.paperDataSource = legacy.paperDataSource;
      target.hedge.settings = structuredClone(legacy.hedge.settings);
      if (legacy.fitSettings) target.fitSettings = structuredClone(legacy.fitSettings);
      if (legacy.modelSettings) target.modelSettings = structuredClone(legacy.modelSettings);
      // Keep the watch-only pool price for valuation, but require new mapped venue discovery.
      target.market = { ...legacy.market, timestamp: 0, optionIndex: 0, perpMark: 0, perpSizeStep: 0,
        instruments: [], status: { support: `Exact ${token.underlying} mint mapped; refresh venue data before trading.` } };
    }
    target.fit = null;
    target.revision = Math.max(target.revision, legacy.revision) + 1;
    target.hedgedRevision = -1;
    target.hedge.enabled = false;
    target.hedge.status = target.intent || target.hedge.pendingOrder ? 'suspended' : 'paused';
    target.hedge.reason = 'Mint mapping changed; review and explicitly enable automation after refreshing venues';
    target.hedge.anchor = null;

    legacy.positions = legacy.positions.filter(position => !movedIds.has(position.id));
    legacy.selectedIds = legacy.selectedIds.filter(id => !movedIds.has(id));
    legacy.hedge.enabled = false;
    legacy.hedge.status = 'paused';
    legacy.hedge.reason = 'Mint mapping changed; review the remaining watch-only positions';
    if (!legacy.positions.length) delete books[legacyKey];
    if (state.activeUnderlying === legacyKey) {
      for (const field of ACTIVE_BOOK_FIELDS) (state as any)[field] = (target as any)[field];
      state.activeUnderlying = token.underlying;
    }
  }
  return state;
}
