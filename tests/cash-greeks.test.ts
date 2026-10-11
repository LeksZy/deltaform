import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cashDelta, displayGreeks } from '../src/client/cash-greeks';
import { PortfolioRisk } from '../src/client/TradingRisk';
import { initialState } from '../server/engine';

describe('USDT-equivalent Greek presentation', () => {
  it('matches a separately revalued quadratic portfolio for ±1% SOL moves', () => {
    // Value = 10 + 2 S - .03 S²: at S=200, delta=-10, gamma=-.06.
    const value = (spot: number) => 10 + 2 * spot - .03 * spot ** 2;
    const cash = displayGreeks({ delta: -10, gamma: -.06, vega: 3, theta: -2 }, 200, 'cash');
    expect(cash.delta).toBe(-2000); // -10 SOL of signed exposure at 200 USDT/SOL.
    expect(cash.gamma).toBeCloseTo(-.12, 12);
    expect(value(202) - value(200)).toBeCloseTo(cash.delta! / 100 + cash.gamma!, 10);
    expect(value(198) - value(200)).toBeCloseTo(-cash.delta! / 100 + cash.gamma!, 10);
    expect(cash.vega).toBe(3); expect(cash.theta).toBe(-2);
  });
  it('cash scales price-dependent sensitivities and leaves already cash-normalized vega/theta unchanged', () => {
    const g = { delta: .5, gamma: .04, vega: .3, theta: -.02 };
    expect(displayGreeks(g, 100, 'cash')).toEqual({ delta: 50, gamma: .02, vega: .3, theta: -.02 });
    expect(displayGreeks(g, 200, 'cash')).toEqual({ delta: 100, gamma: .08, vega: .3, theta: -.02 });
    expect(displayGreeks(g, 200, 'raw')).toEqual(g);
    expect(g).toEqual({ delta: .5, gamma: .04, vega: .3, theta: -.02 });
  });
  it('preserves missing values and does not manufacture exposure without a valid spot', () => {
    expect(displayGreeks(null, 100, 'cash')).toEqual({ delta: null, gamma: null, vega: null, theta: null });
    for (const spot of [0, -1, NaN, Infinity]) {
      expect(cashDelta(1, spot)).toBeNull();
      expect(displayGreeks({ delta: 1, gamma: .1, vega: 2, theta: -1 }, spot, 'cash'))
        .toEqual({ delta: null, gamma: null, vega: 2, theta: -1 });
    }
    expect(cashDelta(null, 100)).toBeNull();
    expect(cashDelta(NaN, 100)).toBeNull();
    expect(cashDelta(0, 100)).toBe(0);
  });
  it('renders compact position and total risk in cash while retaining an accessible raw toggle', () => {
    const state = initialState('paper'); state.holdings = []; state.hedge.actualPerp = -2;
    state.market.referencePrice = 100;
    const props = { state, positions: [], model: { expiry: 0, ivMode: 'manual' as const, ivPercent: 70, daysAhead: 0 },
      fallbackExpiry: Date.now() + 86400000, setGreekDisplay: () => {} };
    const cash = renderToStaticMarkup(createElement(PortfolioRisk, { ...props, greekDisplay: 'cash' }));
    expect(cash).toContain('Model / venue Δ · USDT'); expect(cash).toContain('Gamma P&amp;L · 1% SOL');
    expect(cash).toContain('Inventory / execution Δ · USDT'); expect(cash).toContain('ν · USDT/IV pt');
    expect(cash).toContain('Θ · USDT/day');
    expect(cash).toContain('1:1 USDC/USD parity'); expect(cash).toContain('aria-pressed="true">Cash · USDT');
    expect(cash).not.toContain('Hyperliquid subtotal'); // One-position groups do not repeat their row.
    for (const label of ['SOL perpetual', 'SOL total']) {
      const row = cash.match(new RegExp(`<tr[^>]*><td>(?:<strong>)?${label}.*?</tr>`))?.[0];
      expect(row?.match(/-200\.00/g)).toHaveLength(2); // Model and execution exposure independently.
    }
    const raw = renderToStaticMarkup(createElement(PortfolioRisk, { ...props, greekDisplay: 'raw' }));
    expect(raw).toContain('Inventory / execution Δ · SOL'); expect(raw).toContain('Model / venue Δ · SOL');
    expect(raw).toContain('Γ · SOL/USDT'); expect(raw).toContain('aria-pressed="true">Raw units');
    expect(raw).not.toContain('Model / venue Δ · USDT');
    for (const label of ['SOL perpetual', 'SOL total']) {
      const row = raw.match(new RegExp(`<tr[^>]*><td>(?:<strong>)?${label}.*?</tr>`))?.[0];
      expect(row?.match(/-2\.0000<\/td>/g)).toHaveLength(2); // Both delta columns retain underlying units.
    }
  });
});
