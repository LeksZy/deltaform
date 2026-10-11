import type { MarketSnapshot, OptionHolding, OptionInstrument, Position } from '../shared/types.js';
import { binPrice, blackScholes, YEAR_MS } from './math.js';
import { UNDERLYINGS, isUnderlying, type Underlying } from '../shared/assets.js';

export function demoPosition(now = Date.now()): Position {
  // Actual protocol geometric convention; ID -322 approximates 200 with 9/6 decimals at 50 bps.
  const centerId = -322, center = binPrice(centerId, 50), bins = [];
  for (let id = centerId - 34; id <= centerId + 34; id++) {
    const price = binPrice(id, 50), distance = id - centerId;
    const value = 150 + 70 * Math.exp(-distance * distance / 500);
    bins.push({ id, price, x: distance > 0 ? value / price : distance === 0 ? value / price * 0.4 : 0,
      y: distance < 0 ? value : distance === 0 ? value * 0.6 : 0 });
  }
  return { id: 'fixture-sol-usdc-69-bins', pool: 'fixture:not-an-onchain-pool', name: 'SOL / USDC · 69-bin study', source: 'fixture',
    base: 'SOL', quote: 'USDC', snapshotAt: now, bins, baseFees: 0.018, quoteFees: 3.42,
    poolPrice: center, benchmarkX: bins.reduce((n, b) => n + b.x, 0), benchmarkY: bins.reduce((n, b) => n + b.y, 0),
    notes: ['Deterministic fixture; no account or pool is represented.', '50 bps geometric bins, asymmetric active-bin mixture, fees excluded from IL.', 'Quote-denominated economic allocation is an illustrative fixture, not a claim about protocol liquidity-share integers.'] };
}
export function mixedBinExample(now = Date.now()): Position {
  return { id: 'mixed-bin-example', pool: 'fixture:mixed', name: 'Three-bin algebra example', source: 'fixture', base: 'SOL', quote: 'USDC', snapshotAt: now,
    bins: [{ id: 1, price: 180, x: 0, y: 360 }, { id: 2, price: 200, x: 1, y: 200 }, { id: 3, price: 220, x: 2, y: 0 }],
    baseFees: 0, quoteFees: 0, poolPrice: 200, benchmarkX: 3, benchmarkY: 560,
    notes: ['Independent worked example: H = 2 P180 + C200 + P200 + 2 C220.'] };
}
export function demoMarket(now = Date.now(), spot = 200): MarketSnapshot {
  const expiry = Date.UTC(new Date(now + 30 * 86400_000).getUTCFullYear(), new Date(now + 30 * 86400_000).getUTCMonth(), new Date(now + 30 * 86400_000).getUTCDate(), 8);
  const instruments: OptionInstrument[] = [];
  for (const strike of [100, 140, 160, 180, 190, 200, 210, 220, 240, 260, 300]) {
    for (const type of ['call', 'put'] as const) {
      const iv = 0.72 + Math.abs(Math.log(strike / spot)) * 0.15;
      const g = blackScholes(type, spot, strike, (expiry - now) / YEAR_MS, iv);
      const ask = Math.ceil((g.price * 1.035 + 0.05) * 100) / 100;
      instruments.push({ name: `FIXTURE-SOL-${new Date(expiry).toISOString().slice(0, 10)}-${strike}-${type === 'call' ? 'C' : 'P'}`, underlying: 'SOL', type,
        strike, expiry, multiplier: 1, minSize: 0.1, sizeStep: 0.1, tickSize: 0.01, bid: Math.max(0, Math.floor((g.price * 0.965 - 0.05) * 100) / 100),
        ask, askSize: 50, asks: [[ask, 20], [ask + 0.1, 30]], mark: g.price, iv, greeks: g,
        timestamp: now, source: 'fixture', settlement: 'Illustrative USDC cash payout; not a listed instrument.', feeRate: 0.001 });
    }
  }
  return { source: 'fixture', timestamp: now, referencePrice: spot, poolPrice: demoPosition(now).poolPrice, optionIndex: spot,
    perpMark: spot * 1.0002, fundingRate: 0.0000125, instruments, perpSizeStep: 0.01, perpMinNotional: 10,
    status: { meteora: 'deterministic fixture', bybit: 'synthetic option chain; not executable live', hyperliquid: 'paper market' } };
}
export function demoHoldings(_market?: MarketSnapshot): OptionHolding[] { return []; }

// Study values, not live prices or venue contract specifications.
const ASSET_FIXTURE: Record<Underlying, { reference: number; decimals: number; iv: number }> = {
  BTC: { reference: 60000, decimals: 8, iv: .45 }, ETH: { reference: 3000, decimals: 8, iv: .6 },
  SOL: { reference: 200, decimals: 9, iv: .72 }, XAUT: { reference: 2600, decimals: 6, iv: .2 },
  HYPE: { reference: 25, decimals: 9, iv: .85 }, XRP: { reference: .6, decimals: 6, iv: .7 },
  MNT: { reference: .7, decimals: 8, iv: .8 }, DOGE: { reference: .12, decimals: 8, iv: .9 },
};

/** Canonical economic underlyings only: fixtures do not attest any wrapped-token mapping. */
export function demoAssetPosition(underlying: string, now = Date.now()): Position {
  if (!isUnderlying(underlying)) throw new Error(`Unsupported fixture underlying ${underlying}.`);
  if (underlying === 'SOL') return demoPosition(now);
  const { reference, decimals } = ASSET_FIXTURE[underlying];
  const centerId = Math.round(Math.log(reference / 10 ** (decimals - 6)) / Math.log(1.005));
  const bins = Array.from({ length: 69 }, (_, index) => {
    const id = centerId + index - 34, distance = index - 34, price = binPrice(id, 50, decimals, 6);
    const value = 150 + 70 * Math.exp(-distance * distance / 500);
    return { id, price, x: distance > 0 ? value / price : distance === 0 ? .4 * value / price : 0,
      y: distance < 0 ? value : distance === 0 ? .6 * value : 0 };
  });
  const center = binPrice(centerId, 50, decimals, 6);
  return { id: `fixture-${underlying.toLowerCase()}-usdc-69-bins`, pool: `fixture:${underlying.toLowerCase()}:not-an-onchain-pool`,
    name: `${underlying} / USDC · 69-bin study`, source: 'fixture', base: underlying, quote: 'USDC', snapshotAt: now,
    bins, baseFees: 3.6 / center, quoteFees: 3.42, poolPrice: center,
    benchmarkX: bins.reduce((n, b) => n + b.x, 0), benchmarkY: bins.reduce((n, b) => n + b.y, 0),
    notes: ['Deterministic multi-asset fixture; no account, wrapper mapping or live pool is represented.',
      `50 bps geometric bins with ${decimals}/6 illustrative decimals and a mixed active bin.`, 'Study prices, fee balances and ownership quantities are synthetic.'] };
}

export function demoAssetMarket(underlying: string, now = Date.now(), spot = demoAssetPosition(underlying, now).poolPrice): MarketSnapshot {
  if (!isUnderlying(underlying)) throw new Error(`Unsupported fixture underlying ${underlying}.`);
  if (underlying === 'SOL') return demoMarket(now, spot);
  const template = demoMarket(now, 200), scale = spot / 200;
  const sizeStep = 10 ** Math.floor(Math.log10(20 / spot)), tickSize = 10 ** Math.floor(Math.log10(spot * .00005));
  const instruments = template.instruments.map(i => {
    const strike = Number((i.strike * scale).toPrecision(10));
    const iv = ASSET_FIXTURE[underlying].iv + Math.abs(Math.log(strike / spot)) * .15;
    const g = blackScholes(i.type, spot, strike, (i.expiry - now) / YEAR_MS, iv);
    const ask = Number((Math.ceil((g.price * 1.035 + spot * .00025) / tickSize) * tickSize).toPrecision(12));
    const available = Math.floor(10000 / spot / sizeStep) * sizeStep;
    return { ...i, name: `FIXTURE-${underlying}-${new Date(i.expiry).toISOString().slice(0, 10)}-${strike}-${i.type === 'call' ? 'C' : 'P'}`,
      underlying, strike, iv, greeks: g, minSize: sizeStep, sizeStep, tickSize, ask, askSize: available,
      bid: Math.max(0, Math.floor((g.price * .965 - spot * .00025) / tickSize) * tickSize), mark: g.price,
      asks: [[ask, available * .4], [ask + tickSize, available * .6]] as [number, number][],
      settlement: 'Illustrative stablecoin cash payout; contract specification and liquidity are synthetic.' };
  });
  return { ...template, referencePrice: spot, poolPrice: demoAssetPosition(underlying, now).poolPrice, optionIndex: spot,
    perpMark: spot * 1.0002, instruments, perpSizeStep: sizeStep / 10 };
}

export function multiAssetFixtures(now = Date.now()) {
  return UNDERLYINGS.map(underlying => ({ underlying, position: demoAssetPosition(underlying, now), market: demoAssetMarket(underlying, now) }));
}

/** Synthetic narrow-range ladder; equal bin allocations are explicit assumptions. */
export function annotatedNarrowRangeFixture(now = Date.now()): Position {
  const center = 207.87, bins = Array.from({ length: 69 }, (_, j) => {
    const price = center * (1.0001 ** (j - 34)), amount = 2000 / 69;
    return { id: j - 34, price, x: j >= 34 ? amount / price * (j === 34 ? 0.5 : 1) : 0, y: j <= 34 ? amount * (j === 34 ? 0.5 : 1) : 0 };
  });
  return { id: 'annotated-narrow-range-approximation', pool: 'fixture:annotated', name: 'Synthetic narrow range · equal-value bins', source: 'fixture', base: 'SOL', quote: 'USDC',
    snapshotAt: now, bins, baseFees: 0, quoteFees: 0, poolPrice: center, benchmarkX: bins.reduce((s, b) => s + b.x, 0), benchmarkY: bins.reduce((s, b) => s + b.y, 0),
    notes: ['Synthetic illustration: center 207.87, bin step 1 bps, 69 bins, assumed total allocation 2000 USDC.',
      'Equal quote value per bin and mixed center are assumptions. No account, screenshot balances, or recovered ownership is represented.',
      'This normalized synthetic ladder is not an on-chain reconstruction.'] };
}
