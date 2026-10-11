import { describe, expect, it } from 'vitest';
import type { FitSettings, OptionInstrument } from '../src/shared/types.js';
import { demoMarket, mixedBinExample } from '../src/quant/fixtures.js';
import { executableCost, fitHedge } from '../src/quant/fit.js';
import { simulateStrategies } from '../src/quant/simulation.js';

const now = Date.UTC(2026, 8, 27), market = demoMarket(now), expiry = market.instruments[0]!.expiry;
const settings: FitSettings = { expiry, coverage: 1, budget: 5000, maxLegs: 10, objective: 'payoff', maxUndercoverage: null };
const chain = () => market.instruments.map(i => ({ ...i, feeRate: 0, minSize: 0.01, sizeStep: 0.01 }));
describe('executable constrained options fit', () => {
  it('prices swept depth, contract multiplier, and fees exactly once', () => {
    const i: OptionInstrument = { ...chain()[0]!, ask: 2, multiplier: 3, feeRate: 0.01, asks: [[2, 1], [2.5, 2]] };
    const cost = executableCost(i, 2);
    expect(cost.cost).toBe(13.5); expect(cost.fee).toBeCloseTo(0.135); expect(cost.averagePrice).toBe(2.25);
    expect(executableCost(i, 7).filledQuantity).toBe(3);
  });
  it('uses Derive fixed and capped index-notional fees instead of a premium-proportional fee', () => {
    const i: OptionInstrument = { ...chain()[0]!, ask: 2, multiplier: 1, asks: [[2, 10]], feeRate: 0.0003,
      feeModel: { kind: 'derive', fixed: 0.5, underlyingRate: 0.0003, premiumCapRate: 0.125, spot: 200 } };
    expect(executableCost(i, 2).fee).toBeCloseTo(0.62);
    expect(executableCost({ ...i, ask: 0.1, asks: [[0.1, 10]] }, 2).fee).toBeCloseTo(0.525);
    expect(executableCost(i, 0).fee).toBe(0);
  });
  it('fits listed strikes after cost regularization and reports residual errors after rounding', () => {
    const p = mixedBinExample(now), result = fitHedge([p], chain(), [], settings, 200, now);
    expect(result.feasible).toBe(true); expect(result.legs.every(l => l.quantity >= 0)).toBe(true);
    expect(result.totalCost).toBeLessThanOrEqual(settings.budget);
    expect(result.maxError).toBeLessThan(2);
    expect(result.upperTailSlopeError).toBeCloseTo(0, 1);
    for (const p of result.points) expect(Math.abs(p.fitted - p.theoretical)).toBeLessThan(2);
    const exact = fitHedge([p], chain(), [], { ...settings, objective: 'superhedge' }, 200, now);
    expect(exact.maxError).toBeLessThan(1e-8);
  });
  it('uses existing long protection so repeat fit need not buy the same options', () => {
    const instruments = chain(), p = mixedBinExample(now);
    const existing = [
      { k: 180, type: 'put', q: 2 }, { k: 200, type: 'call', q: 1 }, { k: 200, type: 'put', q: 1 }, { k: 220, type: 'call', q: 2 },
    ].map(x => ({ instrument: instruments.find(i => i.strike === x.k && i.type === x.type)!, quantity: x.q, averagePrice: 1 }));
    const result = fitHedge([p], instruments, existing, settings, 200, now);
    expect(result.legs).toHaveLength(0); expect(result.maxError).toBeLessThan(1e-9);
  });
  it('honors budget, lot size and maximum leg count after optimization', () => {
    const result = fitHedge([mixedBinExample(now)], chain(), [], { ...settings, budget: 20, maxLegs: 2 }, 200, now);
    expect(result.totalCost).toBeLessThanOrEqual(20 + 1e-9); expect(result.legs.length).toBeLessThanOrEqual(2);
    for (const l of result.legs) expect(l.quantity / l.instrument.sizeStep).toBeCloseTo(Math.round(l.quantity / l.instrument.sizeStep), 7);
    expect(result.maxUndercoverage).toBeGreaterThan(0);
  });
  it('does not overspend when fixed fees remain after quantity scaling', () => {
    const expensiveFees = chain().map(i => ({ ...i, feeModel: { kind: 'derive' as const, fixed: 5, underlyingRate: 0.0003, premiumCapRate: 0.125, spot: 200 } }));
    const result = fitHedge([mixedBinExample(now)], expensiveFees, [], { ...settings, budget: 6 }, 200, now);
    expect(result.totalCost).toBeLessThanOrEqual(6 + 1e-8);
    expect(result.feasible).toBe(true);
    const bad = chain().map(i => ({ ...i, feeRate: NaN }));
    expect(fitHedge([mixedBinExample(now)], bad, [], settings, 200, now).feasible).toBe(false);
  });
  it('conservative sparse-strike hedge dominates on all kinks and upper tail', () => {
    const sparse = chain().filter(i => i.strike % 40 === 0);
    const result = fitHedge([mixedBinExample(now)], sparse, [], { ...settings, objective: 'superhedge' }, 200, now);
    expect(result.feasible).toBe(true); expect(result.maxUndercoverage).toBeLessThan(1e-8);
    expect(result.upperTailSlopeError).toBeGreaterThanOrEqual(-1e-8);
  });
  it('finds a wider two-leg superhedge when per-bin strikes exceed the leg limit', () => {
    const result = fitHedge([mixedBinExample(now)], chain(), [], { ...settings, objective: 'superhedge', maxLegs: 2 }, 200, now);
    expect(result.feasible).toBe(true); expect(result.legs).toHaveLength(2);
    expect(result.maxUndercoverage).toBeLessThan(1e-8);
    expect(result.notes.join(' ')).toMatch(/consolidated/);
  });
  it('uses conservative protection when cost-regularized fit violates a hard undercoverage constraint', () => {
    const result = fitHedge([mixedBinExample(now)], chain(), [], { ...settings, maxUndercoverage: 0 }, 200, now);
    expect(result.feasible).toBe(true); expect(result.maxUndercoverage).toBeLessThan(1e-8);
    expect(result.settings.objective).toBe('payoff');
  });
  it('does not invent feasibility when expiry, depth, budget or full-tail coverage fails', () => {
    expect(fitHedge([mixedBinExample(now)], chain(), [], { ...settings, expiry: expiry + 1 }, 200, now).feasible).toBe(false);
    const constrained = fitHedge([mixedBinExample(now)], chain(), [], { ...settings, budget: 1, objective: 'superhedge' }, 200, now);
    expect(constrained.feasible).toBe(false); expect(constrained.reasons.join(' ')).toMatch(/budget/);
    const noDepth = fitHedge([mixedBinExample(now)], chain().map(i => ({ ...i, asks: [], askSize: 0 })), [], settings, 200, now);
    expect(noDepth.feasible).toBe(false);
    const tail = fitHedge([mixedBinExample(now)], chain(), [], { ...settings, budget: 0, maxUndercoverage: 1000 }, 200, now);
    expect(tail.feasible).toBe(false); expect(tail.reasons.join(' ')).toMatch(/upper-tail/);
  });
  it('rejects stale quotes and separately computes model gamma fitting', () => {
    const stale = fitHedge([mixedBinExample(now)], chain().map(i => ({ ...i, timestamp: now - 70_000 })), [], settings, 200, now);
    expect(stale.feasible).toBe(false);
    const gamma = fitHedge([mixedBinExample(now)], chain(), [], { ...settings, objective: 'gamma' }, 200, now);
    expect(gamma.notes.join(' ')).toMatch(/Current net gamma fit/); expect(gamma.legs.length).toBeGreaterThan(0);
    expect(Number.isFinite(gamma.maxError)).toBe(true);
  });
});
describe('scenario accounting', () => {
  it('compares all strategies across paths with finite P&L and funded capital', () => {
    const result = simulateStrategies([mixedBinExample(now)], market, { now, steps: 24, annualLpFeeRate: 0 });
    expect(result.comparisons).toHaveLength(9);
    const lpOnly = result.comparisons.find(c => c.path === 'Oscillation' && c.strategy === 'LP only')!;
    expect(lpOnly.finalPnl).toBeCloseTo(0, 6); // Closed path, no fees and zero duplicate IL deduction.
    for (const c of result.comparisons) {
      expect(Number.isFinite(c.finalPnl)).toBe(true); expect(c.totalCapital).toBeGreaterThan(1160);
      expect(c.returnOnCapital).toBeCloseTo(c.finalPnl / c.totalCapital);
    }
    expect(result.notes.join(' ')).toMatch(/not a backtest/);
  });
});
