import Decimal from 'decimal.js';
import type { FitResult, OptionExecutionSettings } from './types.js';

export const PROTECTED_REVIEW_MS = 120_000;
export interface OptionExecutionCap {
  instrument: string; quantity: number; quotedAsk: number; limitPrice: number; maxFeePerUnit: string;
  maxPremium: number; maxFees: number;
}
export interface OptionExecutionPreview {
  legs: OptionExecutionCap[]; maxPremium: number; maxFees: number; maxTotalCost: number;
  expiresAt: number; budget: number; withinBudget: boolean;
}
/** Limits stay anchored to the reviewed quote, never chase a moving ask. */
export function optionExecutionPreview(fit: FitResult, settings: OptionExecutionSettings): OptionExecutionPreview {
  if (!['quoted-ask', 'marketable-ioc'].includes(settings.mode) || !Number.isFinite(settings.maxSlippagePercent)
    || settings.maxSlippagePercent < 0 || settings.maxSlippagePercent > 50) throw new Error('Option price tolerance must be between 0% and 50%');
  const legs = fit.legs.filter(l => l.quantity > 0).map(l => {
    const i = l.instrument;
    if (i.ask == null || !Number.isFinite(i.ask) || i.ask <= 0 || !Number.isFinite(i.tickSize) || i.tickSize <= 0
      || !Number.isFinite(l.quantity) || l.quantity <= 0 || i.multiplier !== 1) throw new Error(`Invalid execution units or ask for ${i.name}`);
    const ask = new Decimal(i.ask), quantity = new Decimal(l.quantity);
    const limit = ask.mul(1 + (settings.mode === 'marketable-ioc' ? settings.maxSlippagePercent / 100 : 0))
      .div(i.tickSize).floor().mul(i.tickSize);
    if (limit.lt(ask)) throw new Error(`Quoted ask is not aligned to the venue price tick for ${i.name}`);
    const model = i.feeModel;
    if (!model || ![model.fixed, model.underlyingRate, model.spot].every(n => Number.isFinite(n) && n >= 0) || model.spot <= 0)
      throw new Error(`Verified venue fee metadata is required for ${i.name}`);
    // Conservative per-unit fee reserve. Legacy Derive encodes this in the order signature;
    // Bybit has no such order field, so its adapter rechecks the account fee rate and cash.
    // A small index buffer allows ordinary movement during review; fresh venue checks may refuse it.
    const maxFeePerUnit = new Decimal(model.fixed).div(quantity)
      .plus(new Decimal(model.underlyingRate).mul(2).mul(Decimal.max(new Decimal(model.spot).mul('1.02'), limit)))
      .plus('0.000001').toDecimalPlaces(12, Decimal.ROUND_CEIL).toFixed();
    return { instrument: i.name, quantity: l.quantity, quotedAsk: i.ask, limitPrice: limit.toNumber(), maxFeePerUnit,
      maxPremium: limit.mul(quantity).toNumber(), maxFees: new Decimal(maxFeePerUnit).mul(quantity).toNumber() };
  });
  const maxPremium = Decimal.sum(0, ...legs.map(l => l.maxPremium)).toNumber();
  const maxFees = Decimal.sum(0, ...legs.map(l => l.maxFees)).toNumber();
  const maxTotalCost = new Decimal(maxPremium).plus(maxFees).toNumber();
  return { legs, maxPremium, maxFees, maxTotalCost, budget: fit.settings.budget,
    withinBudget: new Decimal(maxTotalCost).lte(fit.settings.budget),
    expiresAt: settings.mode === 'marketable-ioc' ? fit.createdAt + PROTECTED_REVIEW_MS : fit.expiresAt };
}
