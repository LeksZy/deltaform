import { describe, expect, it } from 'vitest';
import { UNDERLYINGS } from '../src/shared/assets';
import type { FitSettings, Greeks, OptionInstrument } from '../src/shared/types';
import { demoAssetMarket, demoAssetPosition, demoMarket, demoPosition, mixedBinExample, multiAssetFixtures } from '../src/quant/fixtures';
import { decompose, lpValue, weightedPayoff } from '../src/quant/math';
import { fitHedge, payoffPoints } from '../src/quant/fit';
import { resolveLpModel } from '../src/quant/risk-model';
import { aggregateCashScenario } from '../src/client/cash-greeks';
import { aggregateRisk, portfolioRisk } from '../src/client/portfolio-risk';
import { initialState } from '../server/engine';

const now = Date.UTC(2026, 8, 30), expiry = now + 30 * 86400_000;
const fitSettings: FitSettings = { expiry, coverage: 1, budget: 100000, maxLegs: 4, objective: 'payoff', maxUndercoverage: .00001 };
function option(base: string, type: 'call' | 'put', strike: number): OptionInstrument {
  return { ...demoMarket(now).instruments[0]!, name: `${base}-${strike}-${type}`, underlying: base, type, strike, expiry,
    ask: 1, asks: [[1, 100]], askSize: 100, bid: .9, mark: 1, feeRate: 0, minSize: 1, sizeStep: 1, multiplier: 1,
    greeks: { delta: .5, gamma: .01, vega: .1, theta: -.01 } };
}

describe('underlying-specific DLMM decomposition and fit', () => {
  it('retains the existing SOL fixture and creates deterministic distinct study markets for all eight assets', () => {
    expect(demoAssetPosition('SOL', now)).toEqual(demoPosition(now));
    expect(demoAssetMarket('SOL', now, 200)).toEqual(demoMarket(now, 200));
    const all = multiAssetFixtures(now);
    expect(all.map(a => a.underlying)).toEqual(UNDERLYINGS);
    expect(all).toEqual(multiAssetFixtures(now));
    expect(new Set(all.map(a => a.position.id)).size).toBe(8);
    for (const { underlying, position, market } of all) {
      expect(market.instruments.every(i => i.underlying === underlying && i.source === 'fixture')).toBe(true);
      const weights = decompose([position]).weights;
      for (const factor of [0, .4, .9, 1, 1.1, 2, 10]) {
        const price = position.poolPrice * factor;
        // Independently conserve each bin's p*x+y and choose terminal one-sided inventory.
        const terminal = position.bins.reduce((sum, b) => sum + (price < b.price ? price * (b.x + b.y / b.price) : b.price * b.x + b.y), 0);
        const held = position.benchmarkX * price + position.benchmarkY;
        expect(lpValue([position], price)).toBeCloseTo(terminal, 7);
        expect(weightedPayoff(weights, price)).toBeCloseTo(held - terminal, 7);
      }
      expect(position.bins[35]!.price / position.bins[34]!.price).toBeCloseTo(1.005, 12);
    }
  });
  it('rejects mixed underlying axes and volatile quote pairs', () => {
    expect(() => decompose([demoAssetPosition('BTC', now), demoAssetPosition('SOL', now)])).toThrow(/one underlying/);
    expect(() => fitHedge([demoAssetPosition('BTC', now), demoAssetPosition('SOL', now)], [], [], fitSettings, 100, now)).toThrow(/one underlying/);
    expect(() => decompose([{ ...demoPosition(now), quote: 'ETH' }])).toThrow(/stablecoin quote/);
    expect(() => decompose([{ ...demoPosition(now), base: 'cbBTC' }])).toThrow(/verified token mapping/);
    expect(decompose([{ ...demoPosition(now), quote: 'USDT' }]).notes.join(' ')).toContain('parity');
  });
  it.each(UNDERLYINGS)('fits %s only and ignores other assets at the same strikes and expiry', underlying => {
    const p = { ...mixedBinExample(now), base: underlying };
    const chain = [option(underlying, 'put', 180), option(underlying, 'call', 200), option(underlying, 'put', 200), option(underlying, 'call', 220)];
    const other = option(underlying === 'BTC' ? 'SOL' : 'BTC', 'call', 200);
    const foreign = { instrument: other, quantity: 100, averagePrice: 1 };
    const result = fitHedge([p], [...chain, other], [foreign], fitSettings, 200, now);
    expect(result.feasible).toBe(true);
    expect(result.legs.every(l => l.instrument.underlying === underlying)).toBe(true);
    expect(result.legs.reduce((sum, l) => sum + l.quantity, 0)).toBe(6);
    expect(result.maxUndercoverage).toBeCloseTo(0, 8);
    expect(result.points.find(p => p.price === 200)?.fitted).toBe(0);
    const baseline = payoffPoints([p], [foreign], [], 200, expiry, 0, [100, 200, 400]);
    expect(baseline.map(p => p.fitted)).toEqual([0, 0, 0]);
    expect(() => payoffPoints([p], [], [{ instrument: other, quantity: 1, existingQuantity: 0, cost: 1, fee: 0 }], 200, expiry)).toThrow(/underlying and expiry/);
  });
  it('selects ATM IV within the requested underlying and refuses an ambiguous mixed chain', () => {
    const btc = { ...option('BTC', 'call', 100), iv: .4 }, sol = { ...option('SOL', 'call', 100), iv: .9 };
    const settings = { expiry, ivMode: 'market' as const, ivPercent: 70 };
    expect(resolveLpModel([sol, btc], 100, settings, expiry, 60000, now, 'BTC').iv).toBe(.4);
    expect(resolveLpModel([sol, btc], 100, settings, expiry, 60000, now).iv).toBeNull();
  });
  it('does not allow another underlying gamma to reduce the selected hedge requirement', () => {
    const annualExpiry = now + 365.25 * 86400_000;
    const p = { ...mixedBinExample(now), base: 'BTC', bins: [{ id: 0, price: 100, x: 1, y: 0 }], benchmarkX: 1, benchmarkY: 0 };
    const gamma = .3969525475 / 20;
    const btc = { ...option('BTC', 'call', 100), expiry: annualExpiry, iv: .2, greeks: { delta: .5, gamma, vega: .1, theta: -.01 } };
    const sol = { ...btc, underlying: 'SOL', name: 'SOL-foreign', greeks: { ...btc.greeks, gamma: 100 } };
    const result = fitHedge([p], [btc, sol], [{ instrument: sol, quantity: 10, averagePrice: 1 }], {
      ...fitSettings, expiry: annualExpiry, objective: 'gamma', gamma: { expiry: annualExpiry, ivMode: 'manual', ivPercent: 20, tolerance: .0001 },
    }, 100, now);
    expect(result.gammaRisk!.existing).toBe(0);
    expect(result.feasible).toBe(true); expect(result.legs[0]!.quantity).toBe(1);
  });
  it('accepts a cash-equivalent gamma tolerance for low-price underlyings', () => {
    const p = { ...mixedBinExample(now), base: 'DOGE', bins: [{ id: 0, price: .1, x: 1000, y: 0 }], benchmarkX: 1000, benchmarkY: 0 };
    const rawTolerance = 2 * 1 / (.01 * .1) ** 2; // $1 quadratic P&L for a 1% DOGE price change.
    const result = fitHedge([p], [option('DOGE', 'call', .1)], [], { ...fitSettings, objective: 'gamma', maxUndercoverage: null,
      gamma: { expiry, ivMode: 'manual', ivPercent: 20, tolerance: rawTolerance } }, .1, now);
    expect(result.gammaRisk!.tolerance).toBe(2000000);
    expect(.5 * result.gammaRisk!.tolerance * (.01 * .1) ** 2).toBe(1);
    expect(result.feasible).toBe(true);
  });
});

describe('asset risk boundaries and cash aggregation', () => {
  it('isolates rows, labels and inventory delta to the selected book', () => {
    const state = initialState('paper');
    const position = { ...mixedBinExample(now), base: 'BTC' };
    state.activeUnderlying = 'BTC'; state.positions = [position]; state.selectedIds = [position.id]; state.market.referencePrice = 200;
    state.market.instruments = [option('BTC', 'call', 200), option('SOL', 'call', 200)];
    state.holdings = state.market.instruments.map(instrument => ({ instrument, quantity: 1, averagePrice: 1 }));
    state.hedge.actualPerp = -2;
    const risk = portfolioRisk(state, [position], expiry, .4, now);
    expect(risk.rows.map(r => r.underlying)).toEqual(['BTC', 'BTC', 'BTC']);
    expect(risk.rows[0]!.quantity).toContain('BTC');
    expect(risk.rows[2]!.label).toBe('BTC perpetual');
    expect(risk.total.executionDelta).toBe(1.5);
    expect(() => aggregateRisk([risk.rows[0]!, { ...risk.rows[1]!, underlying: 'SOL' }])).toThrow(/Raw Greeks/);
    state.accounting = { equity: 1000, perpUnrealized: 99, optionsValue: 1, initialCapital: 1000, pnl: 0, scope: 'all' };
    state.portfolio = { assets: [{ underlying: 'BTC', perpUnrealized: 7 }] } as NonNullable<typeof state.portfolio>;
    expect(portfolioRisk(state, [position], expiry, .4, now).rows.find(r => r.venue === 'Hyperliquid')!.value).toBe(7);
  });
  it('sums cash scenario changes from independent asset polynomials without cancelling native quantities', () => {
    const btcGreeks: Greeks = { delta: .2, gamma: .00002, vega: 3, theta: -2 };
    const dogeGreeks: Greeks = { delta: -20000, gamma: 400000, vega: 4, theta: -1 };
    const assets = [{ underlying: 'BTC', spot: 10000, executionDelta: .4, greeks: btcGreeks },
      { underlying: 'DOGE', spot: .1, executionDelta: -10000, greeks: dogeGreeks }];
    const result = aggregateCashScenario(assets, { pricePercent: 1, ivPoints: 2, days: 1,
      byUnderlying: { BTC: { pricePercent: 2 }, DOGE: { pricePercent: -1 } } });
    // V_BTC(S) = .00001*S²; V_DOGE(S) = -60000*S + 200000*S².
    const btcValue = (s: number) => .00001 * s * s;
    const btcChange = btcValue(10200) - btcValue(10000);
    const dogeValue = (s: number) => -60000 * s + 200000 * s * s;
    const dogeChange = dogeValue(.099) - dogeValue(.1);
    expect(result.totals.deltaPnl).toBeCloseTo(60, 10);
    expect(result.totals.gammaPnl).toBeCloseTo(.6, 10);
    expect(result.totals.deltaPnl! + result.totals.gammaPnl!).toBeCloseTo(btcChange + dogeChange, 8);
    expect(result.totals.executionCashDelta).toBe(3000);
    expect(result.totals.vegaPnl).toBe(14); expect(result.totals.thetaPnl).toBe(-3);
    expect(result.totals.totalPnl).toBeCloseTo(71.6, 10);
    expect(result.totals).not.toHaveProperty('delta'); expect(result.totals).not.toHaveProperty('gamma');
  });
  it('preserves unknowns, reports staleness and prevents duplicate books', () => {
    const asset = { underlying: 'BTC', spot: 10000, executionDelta: .2, greeks: null, stale: true };
    const result = aggregateCashScenario([asset]);
    expect(result.totals.totalPnl).toBeNull(); expect(result.totals.executionCashDelta).toBe(2000); expect(result.stale).toBe(true);
    expect(() => aggregateCashScenario([asset, asset])).toThrow(/once/);
  });
});
