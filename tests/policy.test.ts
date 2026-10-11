import { describe, expect, it } from 'vitest';
import { applyPerpFill, DEFAULT_RISK, evaluateHedge, isStrictPositionReduction, type PolicyInput } from '../server/policy';
import { demoMarket } from '../src/quant/fixtures';
import { Store, SerialQueue } from '../server/store';

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  const now = 1_780_000_000_000;
  const market = demoMarket(now, 200); market.poolPrice = 200;
  return { market, now, nonPerpDelta: 10, benchmarkDelta: 10, collateral: 10000,
    hedge: { enabled: true, status: 'running', reason: '', anchor: 200, lastHedgeAt: now - 10000,
      actualPerp: -10, desiredPerp: -10, currentDelta: 0, targetDelta: 0, pendingOrder: null,
      settings: { ...DEFAULT_RISK, deltaEmergency: 100 } }, ...overrides };
}
describe('automatic hedge policy', () => {
  it('does not trade inside alpha bands', () => { expect(evaluateHedge(input()).action).toBe('wait'); });
  it('hedges at the upper and lower percentage thresholds', () => {
    for (const price of [202, 198]) {
      const v = input(); v.market.referencePrice = v.market.poolPrice = v.market.perpMark = v.market.optionIndex = price;
      v.nonPerpDelta = 12;
      const d = evaluateHedge(v); expect(d.action).toBe('order'); expect(d.quantity).toBeCloseTo(-2);
    }
  });
  it('recalculates net delta rather than adding another full hedge on a large jump', () => {
    const v = input(); v.market.referencePrice = v.market.poolPrice = v.market.perpMark = v.market.optionIndex = 230;
    v.nonPerpDelta = 8; expect(evaluateHedge(v).quantity).toBeCloseTo(2);
  });
  it('uses original HODL delta as an optional target', () => {
    const v = input({ force: true }); v.hedge.settings.targetMode = 'preserve-hodl';
    const d = evaluateHedge(v); expect(d.target).toBe(10); expect(d.desired).toBe(0); expect(d.quantity).toBe(10);
  });
  it('rejects stale Greeks even if spot is fresh', () => {
    const v = input(); v.dataTimestamps = [v.now - 31000]; expect(evaluateHedge(v).action).toBe('suspend');
  });
  it('suspends on basis divergence and local margin shortage', () => {
    const a = input(); a.market.optionIndex = 180; expect(evaluateHedge(a).action).toBe('suspend');
    const b = input(); b.collateral = 200; expect(evaluateHedge(b).reason).toContain('collateral');
  });
  it('does not send another order while the previous outcome is ambiguous', () => {
    const v = input({ force: true }); v.hedge.pendingOrder = '0xabc'; expect(evaluateHedge(v).action).toBe('wait');
  });
  it('uses executable deadband on triggered no-order completion', () => {
    const v = input({ force: true }); v.nonPerpDelta = 10.01; expect(evaluateHedge(v).action).toBe('complete');
  });
  it('caps each order, keeping the larger target for subsequent reconciliation', () => {
    const v = input({ force: true }); v.hedge.actualPerp = 0; v.hedge.settings.maxOrderNotional = 500;
    const d = evaluateHedge(v); expect(d.action).toBe('order'); expect(Math.abs(d.quantity) * v.market.perpMark).toBeLessThanOrEqual(500); expect(d.desired).toBe(-10);
  });
  it('honors cooldown, but portfolio-change reconciliation bypasses it', () => {
    const v = input(); v.hedge.lastHedgeAt = v.now - 500; v.nonPerpDelta = 12; v.market.referencePrice = v.market.optionIndex = v.market.poolPrice = v.market.perpMark = 202;
    expect(evaluateHedge(v).reason).toContain('cooldown'); v.portfolioChanged = true; expect(evaluateHedge(v).action).toBe('order');
  });
  it('initial enable uses the current exposure and never an arbitrary entry price', () => {
    const v = input(); v.hedge.anchor = null; v.hedge.actualPerp = 0; v.nonPerpDelta = 7.5;
    expect(evaluateHedge(v).quantity).toBe(-7.5);
  });
  it('does not declare completion when the order cap prevents trading a single lot', () => {
    const v = input({ force: true }); v.hedge.actualPerp = 0;
    v.market.perpSizeStep = 1; v.hedge.settings.maxOrderNotional = 100;
    expect(evaluateHedge(v).action).toBe('suspend');
    expect(evaluateHedge(v).reason).toMatch(/below one executable/);
    v.nonPerpDelta = 0.25; v.hedge.settings.maxOrderNotional = 1000;
    expect(evaluateHedge(v).action).toBe('complete'); // The residual itself is smaller than a lot.
    v.market.perpSizeStep = Infinity;
    expect(evaluateHedge(v).action).toBe('suspend');
  });
  it.each([
    { actual: -10, desired: -8, quantity: 2 },
    { actual: 10, desired: 8, quantity: -2 },
    { actual: -10, desired: 0, quantity: 10 },
    { actual: 10, desired: 0, quantity: -10 },
  ])('allows a triggered reduction from $actual to $desired without collateral', ({ actual, desired, quantity }) => {
    const v = input({ force: true, collateral: 0, nonPerpDelta: -desired });
    v.hedge.actualPerp = actual;
    // The remaining exposure can exceed a limit lowered after opening the position.
    v.hedge.settings.maxPerpNotional = 1000;
    const d = evaluateHedge(v);
    expect(d.action).toBe('order');
    expect(d.quantity).toBe(quantity);
    expect(d.desired).toBe(desired);
  });
  it.each([
    { actual: -10, desired: -12 },
    { actual: 10, desired: 12 },
    { actual: -10, desired: 1 },
    { actual: 10, desired: -1 },
    { actual: 0, desired: -1 },
  ])('retains collateral checks for $actual to $desired', ({ actual, desired }) => {
    const v = input({ force: true, collateral: 0, nonPerpDelta: -desired });
    v.hedge.actualPerp = actual;
    // Even when the first capped slice of a reversal reduces, its target is not exempt.
    v.hedge.settings.maxOrderNotional = 200;
    const d = evaluateHedge(v);
    expect(d.action).toBe('suspend');
    expect(d.reason).toContain('collateral');
  });
  it('does not create a reduction trigger from insufficient margin or excess exposure', () => {
    const v = input({ collateral: 0, nonPerpDelta: 8 });
    v.hedge.settings.maxPerpNotional = 1000;
    expect(evaluateHedge(v).action).toBe('wait');
    expect(evaluateHedge(v).reason).toContain('trigger bands');
  });
  it('preserves cooldown and order caps for reductions with insufficient margin', () => {
    const v = input({ collateral: 0, nonPerpDelta: 8 });
    v.market.referencePrice = v.market.optionIndex = v.market.poolPrice = v.market.perpMark = 202;
    v.hedge.lastHedgeAt = v.now - 500;
    expect(evaluateHedge(v).reason).toContain('cooldown');
    v.hedge.lastHedgeAt = v.now - 10000;
    v.hedge.settings.maxOrderNotional = 202;
    const d = evaluateHedge(v);
    expect(d.action).toBe('order');
    expect(d.quantity).toBe(1);
    expect(d.desired).toBe(-8);
  });
  it('does not bypass stale, invalid, pending, basis, or lot checks for reductions', () => {
    const v = input({ force: true, collateral: 0, nonPerpDelta: 8 });
    v.dataTimestamps = [v.now - 31000];
    expect(evaluateHedge(v).reason).toContain('stale');
    v.dataTimestamps = [];
    v.collateral = NaN;
    expect(evaluateHedge(v).reason).toContain('Invalid');
    v.collateral = 0;
    v.hedge.pendingOrder = 'existing-intent';
    expect(evaluateHedge(v).reason).toContain('Reconciling existing order');
    v.hedge.pendingOrder = null;
    v.market.optionIndex = 180;
    expect(evaluateHedge(v).reason).toContain('basis');
    v.market.optionIndex = 200;
    v.hedge.settings.maxOrderNotional = 1;
    v.market.perpSizeStep = 1;
    expect(evaluateHedge(v).reason).toContain('below one executable');
    v.market.perpSizeStep = Infinity;
    expect(evaluateHedge(v).reason).toContain('size precision');
  });
  it('confirms no-order completion after a reduction without requiring new margin', () => {
    const v = input({ force: true, collateral: 0, nonPerpDelta: 8 });
    v.hedge.actualPerp = -8;
    v.hedge.settings.maxPerpNotional = 1000;
    const complete = evaluateHedge(v);
    expect(complete.action).toBe('complete');
    expect(complete.quantity).toBe(0);
    // Completion still requires a trigger, executable metadata, and reconciled fills.
    v.force = false;
    expect(evaluateHedge(v).action).toBe('suspend');
    v.force = true;
    v.hedge.pendingOrder = 'awaiting-fill';
    expect(evaluateHedge(v).action).toBe('wait');
    v.hedge.pendingOrder = null;
    v.market.perpSizeStep = Infinity;
    expect(evaluateHedge(v).action).toBe('suspend');
  });
});

describe('strict position reduction classification', () => {
  it('accepts either side and closes, but excludes equal size, increases, reversals and invalid inputs', () => {
    for (const [actual, next] of [[10, 9], [-10, -9], [10, 0], [-10, 0]]) {
      expect(isStrictPositionReduction(actual, next)).toBe(true);
    }
    for (const [actual, next] of [[10, 10], [-10, -11], [10, -1], [-10, 1], [0, 0], [0, 1], [Infinity, 0], [10, NaN]]) {
      expect(isStrictPositionReduction(actual, next)).toBe(false);
    }
  });
});

describe('perpetual accounting', () => {
  it('realizes the correct signed P&L on partial close and reversal', () => {
    const a = applyPerpFill(-10, 200, 4, 180); expect(a).toEqual({ actual: -6, entry: 200, realized: 80 });
    const b = applyPerpFill(-6, 200, 8, 210); expect(b).toEqual({ actual: 2, entry: 210, realized: -60 });
  });
  it('averages additions and zeroes the entry on complete close', () => {
    expect(applyPerpFill(2, 100, 2, 200).entry).toBe(150);
    expect(applyPerpFill(-2, 100, 2, 80)).toEqual({ actual: 0, entry: 0, realized: 40 });
  });
});

describe('durable state and serialized operations', () => {
  it('preserves unresolved intents and anchors without rounding', () => {
    const store = new Store(':memory:');
    store.set('state', { anchor: 201.2345678, intent: { cloid: 'persistent-id', filled: 0.1 } });
    expect(store.get('state')).toEqual({ anchor: 201.2345678, intent: { cloid: 'persistent-id', filled: 0.1 } }); store.close();
  });
  it('serializes racing mutations and recovers from rejection', async () => {
    const q = new SerialQueue(), result: number[] = [];
    await Promise.allSettled([q.run(async () => { await new Promise(r => setTimeout(r, 10)); result.push(1); }), q.run(() => { throw new Error('expected'); }), q.run(() => result.push(3))]);
    expect(result).toEqual([1, 3]);
  });
});
