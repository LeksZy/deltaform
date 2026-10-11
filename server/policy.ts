import type { HedgeState, MarketSnapshot, RiskSettings } from '../src/shared/types';

export const DEFAULT_RISK: RiskSettings = {
  alphaPercent: 1, targetMode: 'dollar-neutral', deltaDeadband: 0.02,
  notionalDeadband: 10, cooldownMs: 5000, maxOrderNotional: 3000,
  maxPerpNotional: 15000, maxLeverage: 2, marginBuffer: 0.25,
  maxSlippageBps: 30, maxDataAgeMs: 30000, maxBasisBps: 150, deltaEmergency: 2,
};
export interface PolicyInput {
  hedge: HedgeState; market: MarketSnapshot; nonPerpDelta: number; benchmarkDelta: number;
  collateral: number; now: number; force?: boolean; portfolioChanged?: boolean;
  dataTimestamps?: number[];
}
export type Decision = { action: 'wait' | 'suspend' | 'complete' | 'order'; reason: string; desired: number; target: number; delta: number; quantity: number };

/** A smaller position on the same side, including closing to zero. Never a reversal. */
export function isStrictPositionReduction(actual: number, next: number): boolean {
  return Number.isFinite(actual) && Number.isFinite(next) && actual !== 0
    && Math.abs(next) < Math.abs(actual)
    && (next === 0 || Math.sign(next) === Math.sign(actual));
}

export function evaluateHedge(input: PolicyInput): Decision {
  const { hedge: h, market: m, now } = input;
  const r = h.settings;
  const target = r.targetMode === 'preserve-hodl' ? input.benchmarkDelta : 0;
  const desired = target - input.nonPerpDelta;
  const delta = input.nonPerpDelta + h.actualPerp;
  const result = (action: Decision['action'], reason: string, quantity = 0): Decision => ({ action, reason, desired, target, delta, quantity });
  const numbers = [m.referencePrice, m.poolPrice, m.optionIndex, m.perpMark, input.nonPerpDelta, input.benchmarkDelta, h.actualPerp, input.collateral];
  if (numbers.some(x => !Number.isFinite(x)) || m.referencePrice <= 0 || m.perpMark <= 0) return result('suspend', 'Invalid market or portfolio data');
  if ([m.timestamp, ...(input.dataTimestamps || [])].some(t => !Number.isFinite(t) || now - t > r.maxDataAgeMs || t > now + 5000)) return result('suspend', 'Required prices, positions, or Greeks are stale');
  if (m.instruments.some(i => i.venue === 'bybit') && (!Number.isFinite(m.stablecoinBasisBps) || Math.abs(m.stablecoinBasisBps!) > r.maxBasisBps)) return result('suspend', 'USDT/USDC settlement basis is unavailable or exceeds the configured limit');
  const basis = Math.max(...[m.poolPrice, m.optionIndex, m.perpMark].map(p => Math.abs(p / m.referencePrice - 1) * 10000));
  if (basis > r.maxBasisBps) return result('suspend', `Cross-venue basis ${basis.toFixed(1)} bps exceeds ${r.maxBasisBps} bps`);
  if (h.pendingOrder) return result('wait', 'Reconciling existing order before submitting another');
  const reductionTarget = isStrictPositionReduction(h.actualPerp, desired);
  const move = h.anchor == null ? Infinity : Math.abs(m.referencePrice / h.anchor - 1) * 100;
  const residual = desired - h.actualPerp;
  const emergency = Math.abs(delta - target) >= r.deltaEmergency;
  const triggered = input.force || input.portfolioChanged || h.anchor == null || move + 1e-10 >= r.alphaPercent || emergency;
  const cooldown = !input.force && !input.portfolioChanged && !emergency && !!h.lastHedgeAt && now - h.lastHedgeAt < r.cooldownMs;
  const sizeStep = m.perpSizeStep;
  const precisionValid = sizeStep > 0 && Number.isFinite(sizeStep) && m.perpMinNotional >= 0 && Number.isFinite(m.perpMinNotional);
  const withinTolerance = Math.abs(residual) <= r.deltaDeadband || Math.abs(residual) * m.perpMark < Math.max(r.notionalDeadband, m.perpMinNotional) || Math.abs(residual) < sizeStep;
  // Confirm a completed cycle after a fill even if the remaining position is over
  // a limit. This exception cannot authorize an order or manufacture a trigger.
  const noOrderCompletion = triggered && !cooldown && precisionValid && withinTolerance;
  // A reduction releases exposure/margin even if the remaining position exceeds a
  // limit. It still requires an ordinary hedge trigger and all execution checks.
  if (!reductionTarget && !noOrderCompletion && Math.abs(desired) * m.perpMark > r.maxPerpNotional) return result('suspend', 'Desired perpetual exposure exceeds the configured cap');
  const marginRequired = Math.abs(desired) * m.perpMark / Math.min(r.maxLeverage,m.perpMaxLeverage??r.maxLeverage,h.venueLeverage??r.maxLeverage);
  if (!reductionTarget && !noOrderCompletion && (input.collateral <= 0 || marginRequired > input.collateral * (1 - r.marginBuffer))) return result('suspend', 'Insufficient venue-local collateral including the margin buffer');
  if (!triggered) return result('wait', 'Price and delta are within the configured trigger bands');
  if (cooldown) return result('wait', 'Hedge cooldown');
  if (!precisionValid) return result('suspend', 'Missing perpetual size precision or minimum notional');
  const capped = Math.min(Math.abs(residual), r.maxOrderNotional / m.perpMark);
  const quantity = Math.sign(residual) * Math.floor((capped + 1e-12) / sizeStep) * sizeStep;
  if (withinTolerance) return result('complete', 'Residual delta is within the executable tolerance');
  if (quantity === 0) return result('suspend', 'Order cap is below one executable perpetual lot; residual delta remains unhedged');
  if (Math.abs(quantity) * m.perpMark < m.perpMinNotional) return result('suspend', 'Order cap is below the venue minimum trade notional');
  if (reductionTarget && !isStrictPositionReduction(h.actualPerp, h.actualPerp + quantity)) return result('suspend', 'Rounded reduction would not strictly reduce the current perpetual position');
  return result('order', input.portfolioChanged ? 'Portfolio changed' : h.anchor == null ? 'Initial hedge' : emergency ? 'Delta deviation trigger' : `Price moved ${move.toFixed(2)}% from anchor`, quantity);
}

export function applyPerpFill(actual: number, entry: number, quantity: number, price: number) {
  if (actual === 0 || Math.sign(actual) === Math.sign(quantity)) {
    const next = actual + quantity;
    return { actual: next, entry: (Math.abs(actual) * entry + Math.abs(quantity) * price) / Math.abs(next), realized: 0 };
  }
  const closed = Math.min(Math.abs(actual), Math.abs(quantity));
  const realized = closed * Math.sign(actual) * (price - entry);
  const next = actual + quantity;
  return { actual: next, entry: Math.abs(next) < 1e-10 ? 0 : Math.sign(next) === Math.sign(actual) ? entry : price, realized };
}
