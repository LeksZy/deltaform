import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { initialState } from '../server/engine';
import { MultiAssetOverview, relevantAssetKeys, sortAssetKeys } from '../src/client/MultiAssetOverview';
import type { AssetOverview } from '../src/shared/multi-asset';
import type { AppState } from '../src/shared/types';

function row(underlying: string, overrides: Partial<AssetOverview> = {}): AssetOverview {
  return { underlying, lpValue: 0, optionsValue: 0, perpSize: 0, fees: 0, pnl: null,
    pnlReason: 'No allocation', perpUnrealized: 0, cashDelta: 0, gammaPnl1Pct: 0, vega: 0, theta: 0,
    status: 'paused', enabled: false, reason: 'Paused', timestamp: 1000, supportStatus: 'ready',
    supportReasons: [], realizedVolatility: null, ...overrides };
}

describe('sortable underlying risk table', () => {
  it('keeps selected, unpriced and watch-only exposures while hiding unused books', () => {
    const state: AppState = initialState('paper');
    const unmapped = 'unmapped:imported-mint';
    const book = { positions: [], selectedIds: [], holdings: [], market: state.market, fit: null, source: 'fixture' as const, hedge: { ...state.hedge, enabled: false, actualPerp: 0, pendingOrder: null } };
    const imported = { ...state.positions[0]!, id: 'imported-position', base: 'Imported token', underlying: unmapped };
    state.activeUnderlying = 'BTC';
    state.books = {
      BTC: { ...book },
      ETH: { ...book, holdings: [{ instrument: { ...state.market.instruments[0]!, underlying: 'ETH', mark: 0 }, quantity: 2, averagePrice: 1 }] },
      SOL: { ...book },
      HYPE: { ...book, hedge: { ...book.hedge, pendingOrder: 'pending-hedge' } },
      XAUT: { ...book, hedge: { ...book.hedge, enabled: true } },
      XRP: { ...book, positions: [imported] },
      MNT: { ...book, hedge: { ...book.hedge, actualPerp: -.5 } },
      [unmapped]: { ...book, positions: [imported], selectedIds: [imported.id] },
    };
    state.portfolio = { assets: [row('ETH', { optionsValue: 0 }), row('SOL'), row('DOGE', { fees: .01 }), row(unmapped, { lpValue: null, supportStatus: 'watch-only' })], globalPaused: false,
      limits: { maxGrossPerpNotional: 1000, maxLeverage: 2, marginBuffer: .2 }, grossPerpNotional: 0, marginRequired: 0,
      commonShock: { pricePercent: 1, ivPoints: 1, deltaPnl: 0, gammaPnl: 0, vegaPnl: 0, thetaPerDay: 0, totalPnl: 0 } };
    expect(relevantAssetKeys(state)).toEqual(['BTC', 'ETH', 'XAUT', 'HYPE', 'MNT', 'DOGE', unmapped]);
    const html = renderToStaticMarkup(createElement(MultiAssetOverview, { state, select: () => {}, busy: false }));
    expect(html).toContain('aria-label="Risk table scope"');
    expect(html).toContain('aria-pressed="true">Positions</button>');
    expect(html).toContain('aria-pressed="false">All assets</button>');
    expect(html).toContain(`aria-label="Select ${unmapped}"`);
    expect(html).not.toContain('aria-label="Select SOL"');
    expect(html).not.toContain('aria-label="Select XRP"');
    state.books!.ETH!.holdings[0]!.instrument.mark = NaN;
    state.portfolio.assets[0]!.optionsValue = null;
    expect(relevantAssetKeys(state)).toContain('ETH');
  });
  it('sorts signed exposure numerically and leaves unknowns after genuine zero in both directions', () => {
    const keys = ['HYPE', 'SOL', 'ETH', 'BTC', 'MNT', 'XAUT'];
    const assets = [row('HYPE', { cashDelta: null }), row('SOL', { cashDelta: 0 }), row('ETH', { cashDelta: -200 }), row('BTC', { cashDelta: 35 }), row('MNT', { cashDelta: NaN })];
    expect(sortAssetKeys(keys, assets, { key: 'cashDelta', direction: 'asc' })).toEqual(['ETH', 'SOL', 'BTC', 'HYPE', 'MNT', 'XAUT']);
    expect(sortAssetKeys(keys, assets, { key: 'cashDelta', direction: 'desc' })).toEqual(['BTC', 'SOL', 'ETH', 'HYPE', 'MNT', 'XAUT']);
    expect(keys).toEqual(['HYPE', 'SOL', 'ETH', 'BTC', 'MNT', 'XAUT']);
  });
  it('keeps tied rows stable and sorts by the status the trader actually sees', () => {
    const keys = ['XAUT', 'BTC', 'SOL'];
    const assets = [row('XAUT', { status: 'paused', supportStatus: 'watch-only' }), row('BTC'), row('SOL')];
    expect(sortAssetKeys(keys, assets, { key: 'fees', direction: 'desc' })).toEqual(keys);
    expect(sortAssetKeys(keys, assets, { key: 'status', direction: 'asc' })).toEqual(['BTC', 'SOL', 'XAUT']);
  });
  it('sorts visible age with freshest first in ascending order and keeps missing timestamps last', () => {
    const keys = ['SOL', 'BTC', 'ETH'];
    const assets = [row('SOL', { timestamp: 0 }), row('BTC', { timestamp: 1000 }), row('ETH', { timestamp: 3000 })];
    expect(sortAssetKeys(keys, assets, { key: 'timestamp', direction: 'asc' })).toEqual(['ETH', 'BTC', 'SOL']);
    expect(sortAssetKeys(keys, assets, { key: 'timestamp', direction: 'desc' })).toEqual(['BTC', 'ETH', 'SOL']);
  });
  it('exposes sortable headers and keeps the scenario secondary without hiding missing P&L', () => {
    const state = initialState('paper');
    state.portfolio = { assets: [row('SOL')], globalPaused: true,
      limits: { maxGrossPerpNotional: 1000, maxLeverage: 2, marginBuffer: .2 }, grossPerpNotional: 0, marginRequired: 0,
      commonShock: { pricePercent: 1, ivPoints: 1, deltaPnl: 0, gammaPnl: 0, vegaPnl: 0, thetaPerDay: 0, totalPnl: 0 } };
    const html = renderToStaticMarkup(createElement(MultiAssetOverview, { state, select: () => {}, busy: false }));
    expect(html.match(/class="asset-sort"/g)).toHaveLength(12);
    expect(html.match(/aria-sort="ascending"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Sort by Cash Δ"');
    expect(html).toContain('title="No allocation">—</td>');
    expect(html.indexOf('<details')).toBeLessThan(html.indexOf('aria-label="Common portfolio shock"'));
    expect(html).toContain('Actual filled options at current marks; excludes proposed purchases');
  });
});
