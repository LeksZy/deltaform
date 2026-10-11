import { resolveLpModel } from '../quant/risk-model';
import type { AppState, Greeks, Position } from '../shared/types';
import { currentInventory, modelLp, validatePositions } from '../quant/math';

export interface ModelSettings { expiry: number; ivMode: 'market' | 'manual'; ivPercent: number; daysAhead: number }
export interface RiskRow {
  id: string; underlying: string; venue: 'Meteora' | 'Bybit' | 'Hyperliquid'; label: string; quantity: string;
  value: number | null; executionDelta: number | null; greeks: Greeks | null;
  timestamp: number | null; stale: boolean; convention: string;
}
export function riskUnderlying(state: AppState, positions: Position[] = state.positions.filter(p => state.selectedIds.includes(p.id))): string {
  return state.activeUnderlying ?? positions[0]?.base ?? state.holdings[0]?.instrument.underlying ?? state.market.instruments[0]?.underlying ?? 'SOL';
}
export function riskInputs(state: AppState, settings: ModelSettings, fallbackExpiry: number, now = Date.now()) {
  return resolveLpModel(state.market.instruments, state.market.referencePrice, settings, fallbackExpiry, state.hedge.settings.maxDataAgeMs, now, riskUnderlying(state));
}
function total(values: (number | null)[]) { return values.some(v => v == null || !Number.isFinite(v)) ? null : (values as number[]).reduce((s, v) => s + v, 0); }
export function aggregateRisk(rows: RiskRow[]) {
  if (new Set(rows.map(r => r.underlying)).size > 1) throw new Error('Raw Greeks cannot be aggregated across different underlyings; use cash scenarios.');
  const keys = ['delta', 'gamma', 'vega', 'theta'] as const;
  return { executionDelta: total(rows.map(r => r.executionDelta)), value: total(rows.map(r => r.value)),
    greeks: rows.some(r => r.greeks === null) ? null : Object.fromEntries(keys.map(k => [k, total(rows.map(r => r.greeks![k]))])) as unknown as Greeks,
    stale: rows.some(r => r.stale) };
}
export function portfolioRisk(state: AppState, positions: Position[], expiry: number, iv: number | null, now = Date.now()) {
  if (positions.length) validatePositions(positions);
  const underlying = riskUnderlying(state, positions);
  if (positions.some(p => p.base !== underlying)) throw new Error('Selected position underlying differs from the active risk book.');
  const spot = state.market.referencePrice, maxAge = state.hedge.settings.maxDataAgeMs;
  const staleAt = (t: number | null) => !t || now - t > maxAge || t > now + 5000;
  const rows: RiskRow[] = positions.map(p => {
    const inventory = currentInventory([p], spot);
    let greeks: Greeks | null = null;
    if (iv != null && expiry > now && spot > 0) {
      // Current owned inventory determines risk; frozen benchmark lots remain solely for IL attribution.
      const model = modelLp([{ ...p, benchmarkBins: p.bins }], spot, expiry, now, iv);
      greeks = { delta: model.delta + p.baseFees, gamma: model.gamma, vega: model.vega, theta: model.theta };
    }
    return { id: p.id, underlying, venue: 'Meteora', label: `${p.name} · ${p.id.slice(0, 6)}…`, quantity: `${inventory.x.toFixed(4)} ${underlying} + ${inventory.y.toFixed(2)} ${p.quote}`,
      value: inventory.value, executionDelta: inventory.delta, greeks, timestamp: p.snapshotAt,
      stale: staleAt(p.snapshotAt), convention: 'Inventory Δ; future-value LP model Δ/Γ/ν/Θ' };
  });
  for (const h of state.holdings.filter(h => h.quantity !== 0 && h.instrument.underlying === underlying)) {
    const i = state.market.instruments.find(i => i.underlying === underlying && i.name === h.instrument.name && i.venue === h.instrument.venue && i.network === h.instrument.network) ?? h.instrument;
    const weight = h.quantity * i.multiplier;
    const usable = i.expiry > now && i.greeks && Object.values(i.greeks).every(Number.isFinite);
    const greeks = usable ? { delta: i.greeks!.delta * weight, gamma: i.greeks!.gamma * weight, vega: i.greeks!.vega * weight, theta: i.greeks!.theta * weight } : null;
    rows.push({ id: i.name, underlying, venue: 'Bybit', label: i.name, quantity: `${Number(h.quantity.toFixed(8))} × ${i.multiplier} ${underlying}`,
      value: i.mark != null && i.expiry > now ? i.mark * weight : null, executionDelta: greeks?.delta ?? null, greeks,
      timestamp: i.timestamp, stale: staleAt(i.timestamp) || (state.mode === 'live' && staleAt(state.capabilities.bybitAccount?.checkedAt ?? null)), convention: i.expiry <= now ? 'Expired · reconcile settlement' : 'Venue Greeks · filled quantity only' });
  }
  const quantity = state.hedge.actualPerp;
  const snapshot = state.hedge.accountSnapshot;
  const accountTime = snapshot && snapshot.owner.toLowerCase() === state.accounts.hyperliquid?.address.toLowerCase() ? snapshot.timestamp : null;
  const observedAt = accountTime ?? state.hedge.lastHedgeAt;
  const known = state.mode === 'paper' || observedAt != null || quantity !== 0;
  const perpPnl = state.portfolio ? state.portfolio.assets.find(a => a.underlying === underlying)?.perpUnrealized
    : state.accounting?.perpUnrealized;
  rows.push({ id: `${underlying}-PERP`, underlying, venue: 'Hyperliquid', label: `${underlying} perpetual`, quantity: known ? `${quantity.toFixed(4)} ${underlying}` : 'Not reconciled',
    value: known ? perpPnl ?? (quantity === 0 ? 0 : null) : null, executionDelta: known ? quantity : null,
    greeks: known ? { delta: quantity, gamma: 0, vega: 0, theta: 0 } : null, timestamp: observedAt,
    stale: state.mode === 'live' && staleAt(observedAt), convention: 'Stored actual size · value is unrealized P&L; funding separate' });
  return { rows, total: aggregateRisk(rows), subtotals: (['Meteora', 'Bybit', 'Hyperliquid'] as const).map(venue => ({ venue, ...aggregateRisk(rows.filter(r => r.venue === venue)) })) };
}
