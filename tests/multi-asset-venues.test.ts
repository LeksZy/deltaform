import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNDERLYINGS, resolveMeteoraPair, SOL_MINT, USDC_MINT, USDT_MINT, TOKEN_MAPPINGS } from '../src/shared/assets';
import { bybitSymbolUnderlying, normalizeBybitInstrument, getBybitMarket, type BybitInstrumentRaw } from '../src/venues/bybit';
import { getMeteoraPools, normalizeOwnedBins } from '../src/venues/meteora';
import { getHyperliquidMarket, normalizeHyperliquidPositions } from '../src/venues/hyperliquid';
import { normalizeHyperliquidCollateral } from '../src/venues/hyperliquid-collateral';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const raw: BybitInstrumentRaw = { symbol: 'BTC-30OCT26-80000-P-USDT', status: 'Trading', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT',
  optionsType: 'Put', deliveryTime: String(Date.UTC(2026, 9, 30, 8)), deliveryFeeRate: '.00015',
  priceFilter: { minPrice: '5', maxPrice: '1110000', tickSize: '5' }, lotSizeFilter: { minOrderQty: '.01', maxOrderQty: '500', qtyStep: '.01' } };

describe('verified economic underlying registry', () => {
  it('resolves exact wrapped BTC mint with custody basis flagged in either pool orientation', () => {
    const mint = TOKEN_MAPPINGS.find(t => t.symbol === 'cbBTC')!.mint;
    expect(resolveMeteoraPair(mint, USDC_MINT)).toMatchObject({ underlying: 'BTC', inverted: false, baseDecimals: 8, hedgeMapping: { status: 'proxy', requiresBasisMonitoring: true } });
    expect(resolveMeteoraPair(USDT_MINT, mint)).toMatchObject({ underlying: 'BTC', inverted: true, quote: 'USDT' });
  });
  it('maps only the registered Sunrise HYPE mint as a nine-decimal proxy in either orientation', () => {
    const mint = '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g';
    expect(resolveMeteoraPair(mint, USDC_MINT)).toMatchObject({ underlying: 'HYPE', base: 'HYPE', baseDecimals: 9,
      hedgeMapping: { status: 'proxy', requiresBasisMonitoring: true } });
    expect(resolveMeteoraPair(USDC_MINT, mint)).toMatchObject({ underlying: 'HYPE', inverted: true, baseDecimals: 9,
      hedgeMapping: { status: 'proxy', requiresBasisMonitoring: true } });
    expect(resolveMeteoraPair('AnotherHypeMint', USDC_MINT)).toMatchObject({ underlying: undefined,
      hedgeMapping: { status: 'watch-only' } });
  });
  it('does not authorize a ticker-spoofed or unverified mint', () => {
    expect(resolveMeteoraPair('BTC', USDC_MINT)).toMatchObject({ underlying: undefined, base: 'unmapped:BTC', hedgeMapping: { status: 'watch-only' } });
    expect(() => resolveMeteoraPair(SOL_MINT, 'USDC')).toThrow(/volatile\/volatile/);
    expect(() => resolveMeteoraPair(USDT_MINT, USDC_MINT)).toThrow(/volatile\/stablecoin/);
  });
  it('converts mixed eight-decimal wrapped asset bins with six-decimal inverted quote', () => {
    expect(normalizeOwnedBins([{ binId: 12, pricePerToken: '.00002', positionXAmount: '12500000', positionYAmount: '25000000' }], 6, 8, true))
      .toEqual([{ id: 12, price: 50000, x: .25, y: 12.5 }]);
  });
  it('independently rejects indexer rows outside the requested exact mint filters', async () => {
    const entry = (address: string, x: string, y: string) => ({ address, name: 'untrusted display SOL-USDC', token_x: { address: x }, token_y: { address: y }, current_price: 120, pool_config: { bin_step: 10 }, tvl: 100, volume: { '24h': 20 } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [entry('real', SOL_MINT, USDC_MINT), entry('fake', 'spoof', USDC_MINT)] })));
    const pools = await getMeteoraPools('SOL');
    expect(pools.map(p => p.address)).toEqual(['real']);
  });
});

describe('Bybit multiple option underlyings', () => {
  it.each(UNDERLYINGS)('preserves %s contract quantity and verifies symbol metadata', underlying => {
    const symbol = `${underlying}-30OCT26-10-P-USDT`;
    const option = normalizeBybitInstrument({ ...raw, symbol, baseCoin: underlying });
    expect(option).toMatchObject({ underlying, strike: 10, multiplier: 1, quoteCoin: 'USDT', settleCoin: 'USDT', minSize: .01, sizeStep: .01 });
    expect(bybitSymbolUnderlying(symbol)).toBe(underlying);
    expect(() => normalizeBybitInstrument({ ...raw, symbol, baseCoin: 'UNMAPPED' })).toThrow(/mapping/);
  });
  it('rejects legacy settlement and unsupported underlyings', () => {
    expect(() => bybitSymbolUnderlying('BTC-30OCT26-80000-P')).toThrow(/settlement/);
    expect(() => bybitSymbolUnderlying('FAKE-30OCT26-80000-P-USDT')).toThrow(/symbol/);
  });
  it('requests the selected underlying and refuses accidental cross-asset chain responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const u = new URL(input);
      expect(u.searchParams.get('baseCoin')).toBe('ETH');
      return Response.json({ retCode: 0, time: Date.now(), result: { category: 'option', list: [raw] } });
    }));
    await expect(getBybitMarket('ETH')).rejects.toThrow(/No active ETH/);
  });
});

describe('Hyperliquid native market and shared collateral boundaries', () => {
  it('uses dynamic asset indices and selected market precision', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([
      { universe: [{ name: 'SOL', szDecimals: 2, maxLeverage: 20 }, { name: 'BTC', szDecimals: 5, maxLeverage: 40 }] },
      [{ markPx: '120', oraclePx: '121', funding: '.00001' }, { markPx: '80000', oraclePx: '80001', funding: '.00002' }],
    ])));
    expect(await getHyperliquidMarket('BTC')).toMatchObject({ asset: 1, coin: 'BTC', mark: 80000, sizeStep: .00001, maxLeverage: 40 });
    await expect(getHyperliquidMarket('XAUT')).rejects.toThrow(/not interchangeable/);
  });
  it('keeps unrelated positions visible, including unsupported positions', () => {
    expect(normalizeHyperliquidPositions({ assetPositions: [
      { position: { coin: 'SOL', szi: '-2', entryPx: '120', unrealizedPnl: '-2', marginUsed: '24', leverage: { value: 10 } } },
      { position: { coin: 'BTC', szi: '.1', entryPx: '80000', unrealizedPnl: '5', marginUsed: '800', leverage: { value: 10 } } },
      { position: { coin: 'UNMAPPED', szi: '3', entryPx: '1', unrealizedPnl: '0', marginUsed: '3' } },
    ] })).toMatchObject([{ coin: 'SOL', size: -2, supported: true }, { coin: 'BTC', size: .1, supported: true }, { coin: 'UNMAPPED', size: 3, supported: false }]);
  });
  it('releases account position margin once while keeping unrelated order holds reserved', () => {
    const state = { assetPositions: [
      { position: { coin: 'SOL', marginUsed: '100', leverage: { type: 'cross' } } },
      { position: { coin: 'BTC', marginUsed: '200', leverage: { type: 'cross' } } },
    ] };
    const spot = { balances: [{ coin: 'USDC', token: 0, total: '1000', hold: '350' }] };
    const collateral = normalizeHyperliquidCollateral('unifiedAccount', state, spot, 1, 'BTC');
    expect(collateral.policyCollateral).toBe(850);
    expect(collateral.accountPolicyCollateral).toBe(950);
    expect(collateral.equity).toBe(1000);
  });
});
