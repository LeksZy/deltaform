import { describe, expect, it } from 'vitest';
import type { Position } from '../src/shared/types.js';
import { blackScholes, currentInventory, decompose, hedgePayoff, lpValue, modelLp, normalizeAtomicBin, weightedPayoff } from '../src/quant/math.js';
import { annotatedNarrowRangeFixture, demoPosition, mixedBinExample } from '../src/quant/fixtures.js';

const oneBin = (x: number, y: number): Position => ({ ...mixedBinExample(), bins: [{ id: 0, price: 200, x, y }], benchmarkX: x, benchmarkY: y });
describe('DLMM terminal identity with independent direct terminal inventory', () => {
  for (const [x, y] of [[3, 0], [0, 700], [1.25, 175]]) {
    it(`replicates ${x} SOL + ${y} USDC below, at and above the bin`, () => {
      const p = oneBin(x!, y!), weights = decompose([p]).weights;
      for (const s of [0, 10, 199.999, 200, 200.001, 450, 100_000]) {
        // Conservation p*x+y yields independent terminal token balances.
        const finalX = s < 200 ? x! + y! / 200 : s > 200 ? 0 : x!;
        const finalY = s < 200 ? 0 : s > 200 ? 200 * x! + y! : y!;
        const terminal = finalX * s + finalY;
        expect(lpValue([p], s)).toBeCloseTo(terminal, 9);
        expect(weightedPayoff(weights, s)).toBeCloseTo(x! * s + y! - terminal, 8);
      }
    });
  }
  it('matches a hand-calculated asymmetric mixed-bin example', () => {
    const p = mixedBinExample();
    // H = 2 P180 + C200 + P200 + 2 C220.
    const answers = [[100, 260, 600], [180, 20, 1080], [200, 0, 1160], [210, 10, 1180], [220, 20, 1200], [300, 260, 1200]];
    for (const [s, hedge, lp] of answers) {
      expect(hedgePayoff([p], s!)).toBeCloseTo(hedge!, 9);
      expect(lpValue([p], s!)).toBeCloseTo(lp!, 9);
    }
    expect(decompose([p]).weights).toEqual([{ strike: 180, type: 'put', quantity: 2 }, { strike: 200, type: 'call', quantity: 1 }, { strike: 200, type: 'put', quantity: 1 }, { strike: 220, type: 'call', quantity: 2 }]);
  });
  it('retains the original terminal benchmark while current inventory updates', () => {
    const p = mixedBinExample(); p.benchmarkBins = structuredClone(p.bins);
    p.bins = [{ id: 1, price: 200, x: 0.4, y: 300 }]; p.baseFees = 0.1;
    expect(currentInventory([p], 200).delta).toBeCloseTo(0.5);
    expect(hedgePayoff([p], 300)).toBeCloseTo(260);
    expect(decompose([p]).benchmarkDelta).toBe(3);
    expect(decompose([p]).inventoryDelta).toBeCloseTo(0.5);
  });
  it('normalizes atomic decimals and inverted SOL/USDC orientation', () => {
    const direct = normalizeAtomicBin({ id: -100, rawPrice: '0.2', xAtomic: '1250000000', yAtomic: '250000000', xDecimals: 9, yDecimals: 6, baseIsX: true });
    const inverse = normalizeAtomicBin({ id: 100, rawPrice: '5', xAtomic: '250000000', yAtomic: '1250000000', xDecimals: 6, yDecimals: 9, baseIsX: false });
    expect(direct).toEqual({ id: -100, price: 200, x: 1.25, y: 250 });
    expect(inverse.price).toBe(direct.price); expect(inverse.x).toBe(direct.x); expect(inverse.y).toBe(direct.y);
  });
  it('matches 69-bin decomposition on a dense out-of-range grid', () => {
    const p = demoPosition(), d = decompose([p]);
    expect(p.bins).toHaveLength(69);
    for (let s = 0; s <= 1000; s += 3.7) expect(weightedPayoff(d.weights, s)).toBeCloseTo(hedgePayoff([p], s), 7);
    const narrow = annotatedNarrowRangeFixture();
    expect(narrow.poolPrice).toBe(207.87);
    expect(narrow.bins[35]!.price / narrow.bins[34]!.price).toBeCloseTo(1.0001, 10);
  });
});

describe('model Greeks are distinct from inventory delta and terminal kink masses', () => {
  it('matches an independently published standard Black-Scholes numerical benchmark', () => {
    const c = blackScholes('call', 100, 100, 1, 0.2, 0.05), p = blackScholes('put', 100, 100, 1, 0.2, 0.05);
    expect(c.price).toBeCloseTo(10.450583572, 4);
    expect(p.price).toBeCloseTo(5.573526022, 4);
    expect(c.delta).toBeCloseTo(0.636830651, 5);
    expect(c.gamma).toBeCloseTo(0.018762017, 6);
    expect(c.vega).toBeCloseTo(0.375240347, 6);
    expect(c.theta).toBeCloseTo(-6.414027546 / 365.25, 6);
  });
  it('obeys put-call parity and independently finite-differenced delta, vega and gamma', () => {
    const s = 203, k = 200, t = 0.1, v = 0.7, h = 0.01;
    const c = blackScholes('call', s, k, t, v), p = blackScholes('put', s, k, t, v);
    expect(c.price - p.price).toBeCloseTo(s - k, 8);
    const up = blackScholes('call', s + h, k, t, v).price, down = blackScholes('call', s - h, k, t, v).price;
    expect((up - down) / (2 * h)).toBeCloseTo(c.delta, 4);
    expect((up + down - 2 * c.price) / h ** 2).toBeCloseTo(c.gamma, 4);
    const vegaFD = (blackScholes('call', s, k, t, v + 1e-4).price - blackScholes('call', s, k, t, v - 1e-4).price) / 0.02;
    expect(vegaFD).toBeCloseTo(c.vega, 4);
  });
  it('LP model has negative gamma while instantaneous accounting has only actual inventory delta', () => {
    const p = mixedBinExample(0), future = modelLp([p], 200, 30 * 86400_000, 0, 0.75);
    expect(future.gamma).toBeLessThan(0); expect(future.vega).toBeLessThan(0); expect(future.theta).toBeGreaterThan(0);
    expect(currentInventory([p], 200).delta).toBe(3);
    expect(future.delta).not.toBe(3);
    expect(modelLp([p], 200, 0, 0).value).toBeCloseTo(1160);
  });
});
