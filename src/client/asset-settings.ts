import type { FitSettings } from '../shared/types';
import type { ModelSettings } from './portfolio-risk';

/** Convert a quadratic USDT P&L budget for a 1% price move to raw gamma units. */
export function gammaToleranceFromCash(spot: number, cashTolerance = 1): number {
  if (!Number.isFinite(spot) || spot <= 0) throw new Error('A positive reference price is required to configure gamma tolerance.');
  if (!Number.isFinite(cashTolerance) || cashTolerance < 0) throw new Error('Gamma cash tolerance must be a finite nonnegative amount.');
  return 2 * cashTolerance / (0.01 * spot) ** 2;
}

export function gammaToleranceCash(spot: number, rawTolerance: number): number {
  return .5 * rawTolerance * (0.01 * spot) ** 2;
}

export function gammaTolerance(settings: FitSettings, spot: number): number {
  // An explicitly configured raw tolerance, including zero, is never rescaled on load.
  return settings.gamma?.tolerance ?? gammaToleranceFromCash(spot);
}

export function assetFitPayload(settings: FitSettings, model: ModelSettings, spot: number): FitSettings {
  if (settings.objective !== 'gamma' && !settings.gamma) return settings;
  return { ...settings, gamma: { expiry: model.expiry, ivMode: model.ivMode, ivPercent: model.ivPercent,
    tolerance: gammaTolerance(settings, spot) } };
}
