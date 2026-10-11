import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, initialState, type ExecutionResult, type LiveGateway, type OrderIntent } from '../server/engine';
import { Store } from '../server/store';
import { demoMarket, mixedBinExample } from '../src/quant/fixtures';
import type { OptionHolding } from '../src/shared/types';
import { modelOption } from '../src/quant/math';

let now = Date.UTC(2026, 8, 27, 12);
const stores: Store[] = [];
const engines: Engine[] = [];
beforeEach(() => {
  now = Date.UTC(2026, 8, 27, 12);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  engines.splice(0).forEach(e => e.stop());
  stores.splice(0).forEach(s => s.close());
  vi.restoreAllMocks();
});
function paper(mixed = false) {
  const store = new Store(':memory:'); stores.push(store);
  const engine = new Engine(store); engines.push(engine);
  if (mixed) {
    const p = mixedBinExample(now);
    engine.addHypothetical(p.name, p.bins); engine.paperPrice(200);
  }
  return engine;
}
function liveHarness() {
  const engine = paper();
  const position = mixedBinExample(now); position.source = 'live'; position.owner = 'mock-solana-owner';
  position.benchmarkBins = structuredClone(position.bins);
  engine.state = initialState('live'); engine.state.positions = [position]; engine.state.selectedIds = [position.id];
  engine.state.market = { ...demoMarket(now, 200), source: 'live', poolPrice: 200 };
  engine.state.accounts.hyperliquid = { address: '0x' + 'a'.repeat(40), verified: true, connectedAt: now };
  engine.state.accounts.meteora = { address: position.owner, verified: true, connectedAt: now };
  engine.state.balances.collateral = 10_000;
  engine.state.hedge.settings.maxOrderNotional = 10_000;
  engine.state.hedge.settings.deltaEmergency = 1000;
  engine.store.set('activeMode', 'live'); engine.updateDelta(); engine.save();
  const venue = {
    actualPerp: 0, holdings: [] as OptionHolding[], orders: [] as OrderIntent[], reconciliations: [] as string[],
    onOrder: undefined as ((intent: OrderIntent) => Promise<ExecutionResult>) | undefined,
    onReconcile: undefined as ((intent: OrderIntent) => Promise<ExecutionResult>) | undefined,
  };
  const gateway: LiveGateway = {
    ready: () => null,
    market: async () => ({ ...demoMarket(now, 200), source: 'live', poolPrice: 200 }),
    positions: async () => [{ ...structuredClone(position), snapshotAt: now }],
    portfolio: async () => ({ positions: [{ ...structuredClone(position), snapshotAt: now }],
      holdings: venue.holdings.map(h => ({ ...structuredClone(h), instrument: { ...structuredClone(h.instrument), timestamp: now } })),
      actualPerp: venue.actualPerp, collateral: 10_000, entryPrice: 200 }),
    order: async intent => {
      venue.orders.push(structuredClone(intent));
      if (venue.onOrder) return venue.onOrder(intent);
      venue.actualPerp += intent.quantity;
      return { status: 'filled', filled: Math.abs(intent.quantity), price: 200 };
    },
    reconcile: async intent => {
      venue.reconciliations.push(intent.cloid);
      return venue.onReconcile ? venue.onReconcile(intent) : { status: 'unknown', filled: 0, price: 0 };
    },
    cancel: async () => undefined,
  };
  engine.gateway = gateway;
  return { engine, venue, gateway };
}

describe('paper engine integration and accounting', () => {
  it('keeps protected live reviews bounded in time and refuses paper quote freshness bypasses', () => {
    const e = paper(true);
    let fit = e.quote({ expiry: e.state.market.instruments[0]!.expiry, coverage: 1, budget: 2000, maxLegs: 10, objective: 'payoff', maxUndercoverage: null });
    expect(() => e.validateQuote(fit.id, true)).toThrow('only available for live');
    e.state.mode = 'live';
    e.state.market.source = 'live';
    e.state.market.instruments = e.state.market.instruments.map(i => ({ ...i, source: 'live' }));
    fit = e.quote(fit.settings);
    now += 30000;
    expect(() => e.validateQuote(fit.id)).toThrow('expired');
    expect(e.validateQuote(fit.id, true).id).toBe(fit.id);
    now += 90000;
    expect(() => e.validateQuote(fit.id, true)).toThrow('expired');
  });
  it('completes a capped initial hedge across cycles before committing the anchor', async () => {
    const e = paper(); e.risk({ maxOrderNotional: 1000 });
    await e.enable();
    expect(e.state.hedge.actualPerp).toBeLessThan(0);
    expect(Math.abs(e.state.hedge.actualPerp) * e.state.market.perpMark).toBeLessThanOrEqual(1000 + 1e-8);
    expect(e.state.hedge.anchor).toBeNull();
    expect(e.state.events.some(x => x.type === 'hedge-complete')).toBe(false);
    for (let j = 0; j < 25 && e.state.hedge.anchor === null; j++) await e.tick();
    expect(e.state.hedge.anchor).toBe(e.state.market.referencePrice);
    expect(Math.abs(e.state.hedge.currentDelta)).toBeLessThan(0.05);
    expect(e.state.events.filter(x => x.type === 'order-intent').length).toBeGreaterThan(1);
    expect(e.state.intent).toBeNull();
  });

  it('holds between alpha thresholds and hedges the residual on both up and down triggers', async () => {
    const e = paper(true); e.risk({ maxOrderNotional: 10_000, deltaEmergency: 1000 });
    await e.enable(); expect(e.state.hedge.actualPerp).toBe(-3); expect(e.state.hedge.anchor).toBe(200);
    now += 6000; e.paperPrice(201); await e.tick();
    expect(e.state.hedge.actualPerp).toBe(-3); expect(e.state.hedge.anchor).toBe(200);
    now += 6000; e.paperPrice(202); await e.tick();
    expect(e.state.hedge.actualPerp).toBe(-2); expect(e.state.hedge.anchor).toBe(202);
    const orders = e.state.events.filter(x => x.type === 'order-intent');
    expect(orders[0]!.data?.quantity).toBe(1); // Difference, not another whole short.
    now += 6000; e.paperPrice(199.98); await e.tick();
    expect(e.state.hedge.actualPerp).toBe(-4); expect(e.state.hedge.anchor).toBe(199.98);
  });

  it('only includes filled option quantities in delta and records premiums once', async () => {
    const e = paper(true), initialDelta = e.state.hedge.currentDelta, cash = e.state.balances.reserves;
    const fit = e.quote({ expiry: e.state.market.instruments[0]!.expiry, coverage: 1, budget: 2000, maxLegs: 10, objective: 'superhedge', maxUndercoverage: 0 });
    expect(e.state.holdings).toHaveLength(0); expect(e.state.hedge.currentDelta).toBe(initialDelta);
    e.executePaperQuote(fit.id);
    const optionDelta = e.state.holdings.reduce((s, h) => s + h.quantity * h.instrument.multiplier * h.instrument.greeks!.delta, 0);
    expect(e.state.hedge.currentDelta).toBeCloseTo(3 + optionDelta, 10);
    expect(e.state.balances.reserves).toBeCloseTo(cash - fit.totalCost, 10);
    expect(e.state.balances.optionPremiums).toBeCloseTo(fit.cost, 10);
    expect(e.state.balances.costs).toBeCloseTo(fit.fees, 10);
    expect(() => e.executePaperQuote(fit.id)).toThrow(/changed/);
    e.risk({ maxOrderNotional: 10_000 }); await e.enable();
    expect(Math.abs(e.state.hedge.currentDelta)).toBeLessThan(0.05);
  });

  it('accrues funding while paused and closes with correct realized P&L and fees', async () => {
    const e = paper(true); e.risk({ maxOrderNotional: 10_000 }); await e.enable();
    const originalSize = e.state.hedge.actualPerp, entry = e.state.perpEntry;
    e.pause();
    const originalOrders = e.state.events.filter(x => x.type === 'order-intent').length;
    now += 3600_000; await e.tick();
    const hourFunding = -originalSize * 200 * 0.0000125;
    expect(e.state.balances.funding).toBeCloseTo(hourFunding, 9);
    expect(e.state.events.filter(x => x.type === 'order-intent')).toHaveLength(originalOrders);
    now += 1800_000; e.paperPrice(180); // Funding through the jump uses the prior price.
    expect(e.state.balances.funding).toBeCloseTo(hourFunding * 1.5, 9);
    const closePrice = e.state.market.perpMark * 1.0001;
    await e.closeHedge();
    expect(e.state.hedge.actualPerp).toBeCloseTo(0, 9);
    expect(e.state.balances.perpRealized).toBeCloseTo(originalSize * (closePrice - entry), 9);
    expect(e.state.balances.collateral).toBeCloseTo(10_000 + e.state.balances.funding + e.state.balances.perpRealized - e.state.balances.costs, 8);
    const finalFunding = e.state.balances.funding; now += 3600_000; await e.tick();
    expect(e.state.balances.funding).toBeCloseTo(finalFunding, 9);
  });

  it('preserves benchmark time/price and rejects changed bin allocations until explicit rebase', async () => {
    const e = paper(true), p = e.selected()[0]!, originalTime = p.benchmarkAt, originalPrice = p.benchmarkPrice;
    const settings = { expiry: e.state.market.instruments[0]!.expiry, coverage: 1, budget: 2000, maxLegs: 10, objective: 'superhedge' as const, maxUndercoverage: 0 };
    now += 10_000; e.paperPrice(205);
    expect(p.benchmarkAt).toBe(originalTime); expect(p.benchmarkPrice).toBe(originalPrice);
    const quote = e.quote(settings);
    p.bins[0]!.y -= 20; p.bins[1]!.y += 20; // Same total principal, different allocation.
    expect(() => e.validateQuote(quote.id)).toThrow(/original IL benchmark/);
    expect(() => e.quote(settings)).toThrow(/explicitly rebase/);
    await e.refresh(); expect(() => e.quote(settings)).toThrow(/explicitly rebase/);
    e.rebase(); expect(p.benchmarkAt).toBe(now); expect(p.benchmarkPrice).toBe(205);
    expect(() => e.quote(settings)).not.toThrow();
  });

  it('refreshes both model mark and Greeks for a held expiry absent from the current chain', () => {
    const e = paper(true), instrument = e.state.market.instruments.find(i => i.type === 'call' && i.strike === 200)!;
    const holding = { instrument: { ...instrument, name: 'HELD-EXPIRY-NOT-IN-ROLLING-FIXTURE', multiplier: 2, mark: 1 }, quantity: 3, averagePrice: 1 };
    e.state.holdings = [holding]; e.paperPrice(240);
    const expected = modelOption(holding.instrument, 240).price;
    expect(holding.instrument.mark).toBeCloseTo(expected / 2, 8);
    expect(e.publicState().accounting!.optionsValue).toBeCloseTo(3 * expected, 8);
    expect(e.state.market.status.paperOptionMarks).toMatch(/hypothetical/);
  });

  it('keeps complete audit history beyond the UI tail, resets and restarts', () => {
    const e = paper();
    for (let j = 0; j < 1005; j++) e.event('test', `Event ${j}`);
    expect(e.state.events).toHaveLength(1000); expect(e.store.history('paper')).toHaveLength(1005);
    e.reset(); const restarted = new Engine(e.store); engines.push(restarted);
    expect(restarted.state.events).toHaveLength(1);
    expect(restarted.store.history('paper').some(event => event.message === 'Event 0')).toBe(true);
    expect(restarted.store.history('paper')).toHaveLength(1006);
  });
});

describe('paper execution driven by live public prices', () => {
  it('fetches public market data while never calling account, agent or order methods', async () => {
    const e = paper(true);
    const market = vi.fn(async () => ({ ...demoMarket(now, 210), source: 'live' as const, poolPrice: 210 }));
    const forbidden = vi.fn(async () => { throw new Error('Private/trading method must not be used in paper mode'); });
    e.gateway = { market, positions: forbidden, portfolio: forbidden, order: forbidden, reconcile: forbidden, cancel: forbidden, ready: () => { throw new Error('No live authorization should be requested'); } };
    await e.paperFeed('live');
    expect(e.state.paperDataSource).toBe('live'); expect(e.state.source).toBe('live');
    expect(e.state.market.referencePrice).toBe(210); expect(e.selected()[0]!.bins[1]!.x).toBe(0);
    expect(() => e.paperPrice(220)).toThrow(/disabled/);
    e.risk({ maxOrderNotional: 10_000 }); await e.enable();
    expect(e.state.hedge.actualPerp).toBe(-2); expect(e.state.events.some(event => event.type === 'perp-fill' && event.message.startsWith('paper'))).toBe(true);
    expect(market.mock.calls.length).toBeGreaterThan(1); expect(forbidden).not.toHaveBeenCalled();
    await expect(e.paperFeed('fixture')).rejects.toThrow(/Pause/);
    e.pause(); await expect(e.paperFeed('fixture')).rejects.toThrow(/Close paper positions or reset/);
    e.save(); const restored = new Engine(e.store); engines.push(restored);
    expect(restored.state.paperDataSource).toBe('live');
  });
  it('keeps the existing feed when live public prices are stale', async () => {
    const e = paper(true), oldPrice = e.state.market.referencePrice;
    const forbidden = async () => { throw new Error('Unexpected private operation'); };
    e.gateway = { market: async () => ({ ...demoMarket(now - 120_000, 210), source: 'live', poolPrice: 210 }), positions: forbidden, portfolio: forbidden,
      order: forbidden, reconcile: forbidden, cancel: forbidden, ready: () => null };
    await expect(e.paperFeed('live')).rejects.toThrow(/Fresh public live prices/);
    expect(e.state.paperDataSource).toBe('fixture'); expect(e.state.market.referencePrice).toBe(oldPrice);
  });
  it('uses fresh quoted Greeks without IV and suspends when a missing chain holding has no model inputs', async () => {
    const e = paper(true), instrument = e.state.market.instruments.find(i => i.type === 'call' && i.strike === 200)!;
    const noIv = { ...instrument, iv: null, mark: 8 };
    e.state.holdings = [{ instrument: noIv, quantity: 1, averagePrice: 8 }];
    const fresh = { ...demoMarket(now, 200), source: 'live' as const, poolPrice: 200, instruments: [noIv] };
    const forbidden = async () => { throw new Error('Unexpected private operation'); };
    e.gateway = { market: async () => fresh, positions: forbidden, portfolio: forbidden, order: forbidden, reconcile: forbidden, cancel: forbidden, ready: () => null };
    e.state.paperDataSource = 'live';
    await expect(e.refresh()).resolves.toBeDefined();
    expect(e.publicState().accounting!.optionsValue).toBe(8);
    fresh.instruments = [];
    await e.enable();
    expect(e.state.hedge.status).toBe('suspended'); expect(e.state.hedge.actualPerp).toBe(0);
    expect(e.state.holdings[0]!.instrument.timestamp).toBe(0);
    expect(e.publicState().accounting!.optionsValue).toBe(8); // Retained, explicitly stale observed mark.
    e.state.holdings[0]!.instrument.mark = null; e.state.holdings[0]!.instrument.greeks = null; e.updateDelta();
    expect(e.publicState().accounting!.optionsValue).toBeNull();
    expect(e.publicState().accounting!.equity).toBeNull();
    expect(e.publicState().accounting!.pnl).toBeNull();
    expect(e.publicState().accounting!.valuationComplete).toBe(false);
    expect(() => e.pause()).not.toThrow(); // Missing marks must not prevent emergency controls.
  });
});

describe('mocked live reconciliation, with no venue calls', () => {
  it('persists an ambiguous intent across restart and never resubmits before resolution', async () => {
    const { engine: e, venue, gateway } = liveHarness();
    venue.onOrder = async () => { throw new Error('simulated transport timeout'); };
    await e.enable();
    expect(venue.orders).toHaveLength(1); expect(e.state.hedge.status).toBe('suspended');
    const id = e.state.intent!.cloid;
    const restarted = new Engine(e.store); engines.push(restarted); restarted.gateway = gateway;
    expect(restarted.state.intent!.cloid).toBe(id);
    await restarted.tick(); await restarted.tick();
    expect(venue.orders).toHaveLength(1);
    expect(venue.reconciliations).toEqual([id, id]);
    expect(restarted.state.hedge.anchor).toBeNull();
    venue.onReconcile = async intent => { venue.actualPerp = intent.quantity; return { status: 'filled', filled: Math.abs(intent.quantity), price: 200 }; };
    await restarted.tick();
    expect(restarted.state.intent).toBeNull(); expect(restarted.state.hedge.anchor).toBe(200);
    await restarted.tick(); expect(venue.orders).toHaveLength(1);
  });

  it('does not advance anchor for duplicate partial observations or terminal partial fills', async () => {
    const { engine: e, venue } = liveHarness();
    venue.onOrder = async () => ({ status: 'unknown', filled: 0, price: 0 });
    await e.enable(); const firstId = e.state.intent!.cloid;
    venue.onReconcile = async () => { venue.actualPerp = -1; return { status: 'resting', filled: 1, price: 200 }; };
    await e.tick(); await e.tick();
    expect(e.state.intent!.appliedFill).toBe(1); expect(e.state.hedge.anchor).toBeNull();
    expect(e.state.events.filter(x => x.type === 'perp-fill')).toHaveLength(1);
    expect(venue.orders).toHaveLength(1);
    venue.onReconcile = async () => ({ status: 'partial', filled: 1, price: 200 });
    await e.tick(); expect(e.state.intent).toBeNull(); expect(e.state.hedge.anchor).toBeNull();
    venue.onOrder = undefined; await e.tick();
    expect(venue.orders).toHaveLength(2); expect(venue.orders[1]!.cloid).not.toBe(firstId);
    expect(venue.orders[1]!.quantity).toBe(-2); expect(e.state.hedge.actualPerp).toBe(-3);
    expect(e.state.hedge.anchor).toBe(200);
  });

  it('reconciles externally filled options and triggers below alpha/emergency thresholds', async () => {
    const { engine: e, venue } = liveHarness(); await e.enable();
    const revision = e.state.revision, initialHedgeTime = e.state.hedge.lastHedgeAt;
    const instrument = e.state.market.instruments.find(i => i.type === 'call' && i.strike === 200)!;
    venue.holdings = [{ instrument: { ...instrument, source: 'live', greeks: { delta: 0.2, gamma: 0.01, vega: 1, theta: -0.1 } }, quantity: 1, averagePrice: 12 }];
    now += 2000; await e.tick();
    expect(e.state.revision).toBeGreaterThan(revision);
    expect(venue.orders).toHaveLength(2); expect(venue.orders[1]!.quantity).toBeCloseTo(-0.2, 9);
    expect(venue.orders[1]!.reason).toBe('Portfolio changed');
    expect(e.state.hedge.actualPerp).toBeCloseTo(-3.2, 9);
    expect(e.state.hedge.lastHedgeAt).toBeGreaterThan(initialHedgeTime!);
  });

  it('retains an intent after invalid fill price and handles a definite rejection without retry', async () => {
    const { engine: e, venue } = liveHarness();
    venue.onOrder = async intent => ({ status: 'filled', filled: Math.abs(intent.quantity), price: NaN });
    await e.enable(); expect(e.state.intent).not.toBeNull(); expect(e.state.hedge.reason).toMatch(/invalid execution price/);
    expect(e.state.hedge.anchor).toBeNull(); expect(Number.isFinite(e.state.balances.collateral)).toBe(true);
    venue.onReconcile = async () => ({ status: 'rejected', filled: 0, price: 0, reason: 'mock insufficient margin' });
    await e.tick(); expect(e.state.intent).toBeNull(); expect(e.state.hedge.enabled).toBe(false);
    await e.tick(); expect(venue.orders).toHaveLength(1);
  });

  it('suspends on missing, expired or stale option Greeks before issuing automatic orders', async () => {
    for (const condition of ['missing', 'expired', 'stale']) {
      const { engine: e, venue, gateway } = liveHarness();
      const instrument = e.state.market.instruments.find(i => i.type === 'call' && i.strike === 200)!;
      venue.holdings = [{ instrument: { ...instrument, source: 'live', greeks: condition === 'missing' ? null : instrument.greeks,
        expiry: condition === 'expired' ? now - 1000 : instrument.expiry }, quantity: 1, averagePrice: 12 }];
      if (condition === 'stale') {
        const freshPortfolio = gateway.portfolio;
        gateway.portfolio = async s => { const result = await freshPortfolio(s); result.holdings[0]!.instrument.timestamp = now - 60_000; return result; };
      }
      await e.enable();
      expect(venue.orders).toHaveLength(0); expect(e.state.hedge.status).toBe('suspended');
      expect(e.state.hedge.anchor).toBeNull();
    }
  });

  it('backs off repeated worker connection failures without issuing orders', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { engine: e, venue, gateway } = liveHarness();
      e.state.hedge.enabled = true;
      const portfolio = vi.fn(async () => { throw new Error('Mock account connection unavailable'); });
      gateway.portfolio = portfolio;
      e.start();
      now += 2000; await vi.advanceTimersByTimeAsync(2000); expect(portfolio).toHaveBeenCalledTimes(1);
      now += 2000; await vi.advanceTimersByTimeAsync(2000); expect(portfolio).toHaveBeenCalledTimes(2);
      now += 2000; await vi.advanceTimersByTimeAsync(2000); expect(portfolio).toHaveBeenCalledTimes(2);
      now += 2000; await vi.advanceTimersByTimeAsync(2000); expect(portfolio).toHaveBeenCalledTimes(3);
      expect(e.state.events.filter(event => event.type === 'retry')).toHaveLength(3);
      expect(venue.orders).toHaveLength(0);
      e.stop();
    } finally { vi.useRealTimers(); }
  });
  it('evaluates freshness after asynchronous reads instead of at the beginning of the cycle', async () => {
    const fresh = liveHarness();
    fresh.gateway.market = async () => { now += 10_000; return { ...demoMarket(now, 200), source: 'live', poolPrice: 200 }; };
    await fresh.engine.enable();
    expect(fresh.venue.orders).toHaveLength(1); // A fresh response is not mistakenly future-dated.
    const stale = liveHarness(), oldPortfolio = stale.gateway.portfolio;
    stale.gateway.portfolio = async s => { now += 40_000; return oldPortfolio(s); };
    await stale.engine.enable();
    expect(stale.venue.orders).toHaveLength(0); // Market became stale while waiting for account reconciliation.
    expect(stale.engine.state.hedge.reason).toMatch(/stale/);
  });
  it('retains the completion anchor after a slow confirmed fill until fresh risk reconciliation', async () => {
    const { engine: e, venue } = liveHarness();
    venue.onOrder = async intent => {
      now += 40_000; venue.actualPerp += intent.quantity;
      return { status: 'filled', filled: Math.abs(intent.quantity), price: 200 };
    };
    await e.enable();
    expect(e.state.hedge.actualPerp).toBe(-3); expect(e.state.intent).toBeNull();
    expect(e.state.hedge.anchor).toBeNull(); expect(e.state.hedge.status).toBe('suspended');
    expect(e.state.hedge.reason).toMatch(/Fill confirmed; anchor retained/);
    await e.tick();
    expect(e.state.hedge.anchor).toBe(200); expect(e.state.hedge.status).toBe('running');
    expect(venue.orders).toHaveLength(1); // Reconciliation completes without another hedge order.
  });
});
