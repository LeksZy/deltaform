import { createHash, randomUUID } from 'node:crypto';
import type { AppState, CapitalTracking, CapitalFlow } from '../src/shared/types';
import type { AssetBook } from '../src/shared/multi-asset';

export const CAPITAL_TRACKING_KEY = 'capitalTracking:live';
type CapitalBook = Pick<AssetBook, 'positions' | 'selectedIds' | 'holdings' | 'market' | 'hedge'>;
/** The displayed book is authoritative; persisted copies can lag until the next stash. */
function capitalBooks(state: AppState): CapitalBook[] {
  const active = state.activeUnderlying ?? 'SOL';
  return [...Object.entries(state.books ?? {}).filter(([underlying]) => underlying !== active).map(([, book]) => book), state];
}
function hasCapitalExposure(book: CapitalBook) {
  return book.selectedIds.length > 0 || book.holdings.some(h => h.quantity !== 0) || book.hedge.actualPerp !== 0 || pendingCapitalOrder(book);
}
function pendingCapitalOrder(book: CapitalBook) {
  return Boolean(book.hedge.pendingOrder || (book as CapitalBook & { intent?: unknown }).intent || book.hedge.status === 'executing');
}
function selectedCapitalPositions(state: AppState) {
  return capitalBooks(state).flatMap(book => book.positions.filter(p => book.selectedIds.includes(p.id)));
}
function capitalSnapshotInputs(state: AppState) {
  const books = capitalBooks(state).filter(hasCapitalExposure);
  const observations = books.map(book => ({ book, times: [book.market.timestamp,
    book.hedge.accountSnapshot?.owner.toLowerCase() === state.accounts.hyperliquid?.address.toLowerCase() ? book.hedge.accountSnapshot?.timestamp : undefined,
    ...book.positions.filter(p => book.selectedIds.includes(p.id)).map(p => p.snapshotAt),
    ...book.holdings.filter(h => h.quantity !== 0).map(h => h.instrument.timestamp)] }));
  const maxAccountAge = Math.min(state.hedge.settings.maxDataAgeMs, ...books.map(book => book.hedge.settings.maxDataAgeMs));
  return { observations, accountTime: state.capabilities.bybitAccount?.checkedAt, maxAccountAge };
}
export function capitalScope(state: AppState): string {
  // Quantities, bin allocation, option expiry and perp size may change through trading.
  // Accounts, networks and selected LP identities define the measured capital boundary.
  return createHash('sha256').update(JSON.stringify({
    accounts: Object.fromEntries(['meteora', 'bybit', 'hyperliquid'].map(venue => {
      const v = venue as keyof AppState['accounts'];
      const address = state.accounts[v]?.address;
      return [venue, address ? (venue === 'hyperliquid' ? address.toLowerCase() : address) : null];
    })), optionsVenue: state.optionsVenue, bybitNetwork: state.capabilities.bybitNetwork ?? null,
    pools: selectedCapitalPositions(state).map(p => [p.id, p.pool, p.owner]).sort(),
  })).digest('hex');
}
export function captureCapitalBaseline(state: AppState, now = Date.now()): CapitalTracking {
  if (state.mode !== 'live') throw new Error('This capital tracker is for live mode');
  const accounting = state.accounting;
  if (!accounting?.valuationComplete || accounting.equity == null || !Number.isFinite(accounting.equity) || accounting.equity <= 0)
    throw new Error('A complete positive portfolio valuation is required to start tracking');
  if (state.optionsMigration?.blocked) throw new Error('Resolve the options migration before starting capital tracking');
  const books = capitalBooks(state), exposed = books.filter(hasCapitalExposure);
  if (!selectedCapitalPositions(state).length || exposed.some(book => book.selectedIds.some(id => !book.positions.some(p => p.id === id && p.source === 'live'))))
    throw new Error('Select reconciled live Meteora positions before starting tracking');
  if (['meteora', 'bybit', 'hyperliquid'].some(v => !state.accounts[v as keyof AppState['accounts']]?.verified))
    throw new Error('Verify all three venue accounts before starting tracking');
  if (books.some(pendingCapitalOrder)) throw new Error('Reconcile the pending hedge order in every asset book before capturing starting capital');
  const inputs = capitalSnapshotInputs(state);
  const times = [inputs.accountTime, ...inputs.observations.flatMap(observation => observation.times)];
  if (capitalSnapshotsStale(state, now))
    throw new Error('Refresh markets and reconcile all venue snapshots before starting tracking');
  if (exposed.some(book => book.holdings.some(h => h.quantity !== 0 && (h.instrument.source !== 'live' || h.instrument.expiry <= now || h.instrument.mark == null || !Number.isFinite(h.instrument.mark) || h.instrument.mark < 0))))
    throw new Error('Live option marks are required for the starting snapshot');
  return { baseline: { id: randomUUID(), startedAt: now, equity: accounting.equity,
    scopeKey: capitalScope(state), scope: accounting.scope, currency: 'USDT equivalent',
    snapshotTimes: times as number[] }, flows: [] };
}
export function trackedPnl(state: AppState, tracking: CapitalTracking | undefined, equity: number | null, at = Date.now()) {
  if (!tracking) return { pnl: null, netFlows: 0, reason: 'Starting capital has not been recorded' };
  const netFlows = tracking.flows.filter(f => !f.reversedAt && f.effectiveAt <= at).reduce((n, f) => n + (f.kind === 'deposit' ? f.amount : -f.amount), 0);
  const reason = capitalScope(state) !== tracking.baseline.scopeKey ? 'Tracked accounts or selected LP positions changed; restore the original scope or explicitly start a new baseline'
    : equity == null || !Number.isFinite(equity) ? 'Current portfolio valuation is incomplete' : null;
  return { pnl: reason ? null : equity! - tracking.baseline.equity - netFlows, netFlows, reason };
}
export function addCapitalFlow(tracking: CapitalTracking, flow: CapitalFlow, now = Date.now()): CapitalTracking {
  if (!Number.isFinite(flow.amount) || flow.amount <= 0 || flow.amount > 1e9 || !Number.isFinite(flow.effectiveAt)
    || flow.effectiveAt < tracking.baseline.startedAt || flow.effectiveAt > now + 1000
    || !['deposit', 'withdrawal'].includes(flow.kind) || !flow.id || !flow.note.trim() || flow.note.length > 300 || flow.reversedAt)
    throw new Error('Record a positive deposit/withdrawal amount and note, dated between the baseline and now');
  const existing = tracking.flows.find(f => f.id === flow.id);
  if (existing) {
    if (JSON.stringify({ ...existing, recordedAt: 0 }) !== JSON.stringify({ ...flow, recordedAt: 0 })) throw new Error('Cash-flow ID already records a different movement');
    return tracking;
  }
  return { ...tracking, flows: [...tracking.flows, flow] };
}
export function reverseCapitalFlow(tracking: CapitalTracking, id: string, now = Date.now()): CapitalTracking {
  if (!tracking.flows.some(f => f.id === id)) throw new Error('Cash-flow entry not found');
  return { ...tracking, flows: tracking.flows.map(f => f.id === id && !f.reversedAt ? { ...f, reversedAt: now } : f) };
}
export function capitalSnapshotsStale(state: AppState, now = Date.now()) {
  const { observations, accountTime, maxAccountAge } = capitalSnapshotInputs(state);
  const stale = (t: number | undefined, maxAge: number) => !t || !Number.isFinite(t) || now - t > maxAge || t > now + 5000;
  return stale(accountTime, maxAccountAge) || observations.some(({ book, times }) => book.market.source !== 'live'
    || times.some(t => stale(t, book.hedge.settings.maxDataAgeMs)));
}
