import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { initialState } from '../server/engine';
import { MultiAssetOverview, PortfolioLimitsPanel } from '../src/client/MultiAssetOverview';
import { PortfolioRisk, WatchOnlyRisk } from '../src/client/TradingRisk';
import { AccountingPanel, PayoffPanel, terminalPoints } from '../src/client/App';
import { ASSET_CODES, type AssetOverview } from '../src/shared/multi-asset';

function fixture() {
  const state = initialState('paper');
  const now = Date.now();
  state.activeUnderlying = 'BTC';
  state.portfolio = {
    assets: ASSET_CODES.map((underlying): AssetOverview => ({ underlying, lpValue: 1000, fees: 2, optionsValue: 30,
      perpSize: underlying === 'BTC' ? -.01 : 0, perpUnrealized: 0, pnl: null, pnlReason: 'No per-asset capital allocation',
      cashDelta: 0, gammaPnl1Pct: -.04, vega: 3, theta: -1,
      status: 'paused', enabled: false, reason: 'Paused', timestamp: now,
      supportStatus: underlying === 'XAUT' ? 'watch-only' : 'ready', supportReasons: underlying === 'XAUT' ? ['Wrapped-token basis has not been verified'] : [], realizedVolatility: null })),
    globalPaused: true, limits: { maxGrossPerpNotional: 9000, maxLeverage: 3, marginBuffer: .2 }, grossPerpNotional: 3000,
    marginRequired: 1000, commonShock: { pricePercent: 1, ivPoints: 2, deltaPnl: 0, gammaPnl: -.32, vegaPnl: 48, thetaPerDay: -8, totalPnl: 47.68 },
  };
  state.positions = []; state.selectedIds = []; state.holdings = []; state.market.instruments = []; state.fit = null;
  return state;
}

describe('multi-underlying terminal presentation', () => {
  it('keeps the dashboard usable when the selected live book has no LP position', () => {
    const state = fixture();
    state.mode = 'live';
    state.activeUnderlying = 'ETH';
    expect(terminalPoints([], state)).toEqual([]);
    state.holdings = [{ instrument: { ...initialState('paper').market.instruments[0]!, underlying: 'ETH' }, quantity: 1, averagePrice: 1 }];
    expect(terminalPoints([], state)).toEqual([]);
    const html = renderToStaticMarkup(createElement(PayoffPanel, { state, points: [], positions: [], modelSettings: { expiry: 0, ivMode: 'manual', ivPercent: 50, daysAhead: 0 }, modelExpiry: Date.now() + 86400000, greekDisplay: 'cash' }));
    expect(html).toContain('No Meteora liquidity selected');
    expect(html).toContain('Filled options and perps remain in the risk table.');
  });
  it('renders every underlying with a scoped selector and preserves unknown P&L and RV', () => {
    const html = renderToStaticMarkup(createElement(MultiAssetOverview, { state: fixture(), select: () => {}, busy: false }));
    for (const asset of ASSET_CODES) expect(html).toContain(`aria-label="Select ${asset}"`);
    expect(html).toMatch(/aria-label="Select BTC"[^>]*aria-pressed="true"/);
    expect(html).toContain('title="No per-asset capital allocation">—</td>');
    expect(html).toContain('No verified complete 30-day minute-return series');
    expect(html).toContain('Wrapped-token basis has not been verified');
    expect(html).toContain('Common shock'); expect(html).toContain('+47.68');
    expect(html).not.toContain('Total delta · BTC');
  });
  it('blocks asset selection during execution and exposes shared margin separately', () => {
    const state = fixture();
    const html = renderToStaticMarkup(createElement(MultiAssetOverview, { state, select: () => {}, busy: true }));
    expect(html.match(/class="asset-select"[^>]*disabled=""/g)).toHaveLength(8);
    const limits = renderToStaticMarkup(createElement(PortfolioLimitsPanel, { state, save: () => {}, busy: false }));
    expect(limits).toContain('All underlying books share these limits');
    expect(limits).toContain('$3,000.00'); expect(limits).toContain('$1,000.00');
  });
  it('uses selected BTC units in position risk, including cash shock descriptions', () => {
    const state = fixture(); state.hedge.actualPerp = -.01; state.market.referencePrice = 80000;
    const html = renderToStaticMarkup(createElement(PortfolioRisk, { state, positions: [], model: { expiry: 0, ivMode: 'manual', ivPercent: 50, daysAhead: 0 }, fallbackExpiry: Date.now() + 86400000, greekDisplay: 'cash', setGreekDisplay: () => {} }));
    expect(html).toContain('BTC positions &amp; risk'); expect(html).toContain('BTC perpetual');
    expect(html).toContain('Gamma P&amp;L · 1% BTC'); expect(html).toContain('-800.00');
    expect(html).not.toContain('SOL perpetual'); expect(html).not.toContain('1% SOL');
  });
  it('offers two payoff modes and retains detailed curves within controls', () => {
    const html = renderToStaticMarkup(createElement(PayoffPanel, { state: fixture(), points: [], positions: [], modelSettings: { expiry: 0, ivMode: 'manual', ivPercent: 50, daysAhead: 0 }, modelExpiry: Date.now() + 86400000, greekDisplay: 'cash' }));
    expect(html).toContain('Terminal payoff'); expect(html).toContain('Pre-expiry risk');
    expect(html).toContain('Curves &amp; markers'); expect(html).toContain('Net terminal P&amp;L');
    expect(html).not.toContain('P&amp;L history'); expect(html).not.toContain('Give your liquidity an upside');
  });
  it('preserves unsupported imported tokens as selectable watch-only inventory', () => {
    const state = fixture();
    const underlying = 'unmapped:mint123';
    state.portfolio!.assets.push({ ...state.portfolio!.assets[0]!, underlying, supportStatus: 'watch-only', supportReasons: ['No verified underlying mapping'] });
    state.activeUnderlying = underlying;
    const position = { ...initialState('paper').positions[0]!, base: 'UNKNOWN', underlying, hedgeMapping: { status: 'watch-only' as const, reason: 'No verified underlying mapping', requiresBasisMonitoring: true } };
    const table = renderToStaticMarkup(createElement(MultiAssetOverview, { state, select: () => {}, busy: false }));
    expect(table).toMatch(/aria-label="Select unmapped:mint123"[^>]*aria-pressed="true"/);
    const inventory = renderToStaticMarkup(createElement(WatchOnlyRisk, { state, positions: [position] }));
    expect(inventory).toContain('UNKNOWN'); expect(inventory).toContain('Pool-marked inventory only');
  });
  it('reports account-wide LP values and fees even with another book selected', () => {
    const state = fixture();
    const html = renderToStaticMarkup(createElement(AccountingPanel, { state, positions: [] }));
    expect(html).toContain('Account capital &amp; attribution');
    expect(html).toContain('<span>LP inventory mark</span><strong>$8,000.00</strong>');
    expect(html).toContain('<span>LP accrued fees</span><strong class="green">$16.00</strong>');
  });
});
