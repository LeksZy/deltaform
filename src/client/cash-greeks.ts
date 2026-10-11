import type { Greeks } from '../shared/types';

export type GreekDisplay = 'cash' | 'raw';
export type DisplayGreeks = Record<keyof Greeks, number | null>;

export function greekHeaders(underlying: string, mode: GreekDisplay) {
  return mode === 'cash' ? ['Δ exposure · USDT', `Γ P&L · 1% ${underlying}`, 'ν · USDT/IV pt', 'Θ · USDT/day']
    : [`Δ · ${underlying}`, `Γ · ${underlying}/USDT`, 'ν · USDT/IV pt', 'Θ · USDT/day'];
}
export const cashGreekHeaders = greekHeaders('SOL', 'cash');
export const rawGreekHeaders = greekHeaders('SOL', 'raw');
export function greekConvention(underlying: string) {
  return `USDT equivalents at 1:1 USDC/USD parity. Cash Δ = Δ × S (exposure); linear P&L for +1% ${underlying} = cash Δ / 100. Γ P&L = ½ Γ × (0.01 S)², the quadratic contribution for either ±1% ${underlying}, excluding delta. Vega is per +1 IV percentage point; theta is per calendar day. Local sensitivities, not a full scenario revaluation.`;
}
export const cashGreekConvention = greekConvention('SOL');
export function greekDigits(value: number, mode: GreekDisplay): number {
  return mode === 'raw' || (value !== 0 && Math.abs(value) < .01) ? 4 : 2;
}

/** Display conversion only: never feeds execution, optimization, or accounting. */
export function cashDelta(delta: number | null | undefined, spot: number): number | null {
  return delta != null && Number.isFinite(delta) && Number.isFinite(spot) && spot > 0 ? delta * spot : null;
}
export function displayGreeks(greeks: Greeks | null | undefined, spot: number, mode: GreekDisplay): DisplayGreeks {
  const value = (key: keyof Greeks) => greeks && Number.isFinite(greeks[key]) ? greeks[key] : null;
  const raw = { delta: value('delta'), gamma: value('gamma'), vega: value('vega'), theta: value('theta') };
  if (mode === 'raw') return raw;
  return { ...raw, delta: cashDelta(raw.delta, spot),
    gamma: raw.gamma != null && Number.isFinite(spot) && spot > 0 ? 0.5 * raw.gamma * (spot * 0.01) ** 2 : null };
}

export interface CashScenarioAsset {
  underlying: string; spot: number; executionDelta: number | null; greeks: Greeks | null; stale?: boolean;
}
export interface CashScenarioShocks {
  pricePercent?: number; ivPoints?: number; days?: number;
  byUnderlying?: Record<string, { pricePercent?: number; ivPoints?: number }>;
}
/** Cash Taylor contributions for a declared joint shock; raw units never cross asset boundaries.
 * The price term uses model delta with model gamma. Inventory execution delta is separately shown.
 * No cross-gamma, correlation estimate or future hedge execution is implied. */
export function aggregateCashScenario(assets: CashScenarioAsset[], shocks: CashScenarioShocks = {}) {
  if (new Set(assets.map(a => a.underlying)).size !== assets.length) throw new Error('Each underlying must appear once in an account cash scenario.');
  const pricePercent = shocks.pricePercent ?? 1, ivPoints = shocks.ivPoints ?? 1, days = shocks.days ?? 0;
  if (![pricePercent, ivPoints, days].every(Number.isFinite) || days < 0) throw new Error('Scenario shocks must be finite and days nonnegative.');
  const sum = (values: (number | null)[]) => values.some(v => v == null || !Number.isFinite(v)) ? null : (values as number[]).reduce((v, n) => v + n, 0);
  const perAsset = assets.map(asset => {
    const priceShock = shocks.byUnderlying?.[asset.underlying]?.pricePercent ?? pricePercent;
    const ivShock = shocks.byUnderlying?.[asset.underlying]?.ivPoints ?? ivPoints;
    if (![priceShock, ivShock].every(Number.isFinite)) throw new Error('Per-asset scenario shocks must be finite.');
    const cash = displayGreeks(asset.greeks, asset.spot, 'cash');
    const deltaPnl = cash.delta == null ? null : cash.delta * priceShock / 100;
    const gammaPnl = cash.gamma == null ? null : cash.gamma * priceShock ** 2;
    const vegaPnl = cash.vega == null ? null : cash.vega * ivShock;
    const thetaPnl = cash.theta == null ? null : cash.theta * days;
    return { underlying: asset.underlying, pricePercent: priceShock, ivPoints: ivShock,
      cashDelta: cash.delta, executionCashDelta: cashDelta(asset.executionDelta, asset.spot),
      gammaPnl1Pct: cash.gamma, vegaPerPoint: cash.vega, thetaPerDay: cash.theta,
      deltaPnl, gammaPnl, vegaPnl, thetaPnl, totalPnl: sum([deltaPnl, gammaPnl, vegaPnl, thetaPnl]), stale: asset.stale ?? false };
  });
  const keys = ['cashDelta', 'executionCashDelta', 'gammaPnl1Pct', 'vegaPerPoint', 'thetaPerDay', 'deltaPnl', 'gammaPnl', 'vegaPnl', 'thetaPnl', 'totalPnl'] as const;
  return { pricePercent, ivPoints, days, perAsset,
    totals: Object.fromEntries(keys.map(key => [key, sum(perAsset.map(a => a[key]))])) as Record<typeof keys[number], number | null>,
    stale: perAsset.some(a => a.stale),
    convention: 'USDT equivalents at stablecoin parity. Each asset receives the stated price and IV shock. Price contributions use LP future-value and option model Greeks; execution exposure uses current inventory. Additive local Taylor estimate; excludes cross-gamma, basis, fees, funding and future hedging.' };
}
