import Decimal from 'decimal.js';
import type { Bin, Greeks, OptionHolding, OptionInstrument, Position } from '../shared/types.js';
import { isUnderlying } from '../shared/assets.js';

export const YEAR_MS = 365.25 * 86400_000;
export const ZERO_GREEKS: Greeks = { delta: 0, gamma: 0, vega: 0, theta: 0 };
const dec = (v: number | string) => new Decimal(v);
export interface OptionWeight { strike: number; type: 'call' | 'put'; quantity: number }
export interface Decomposition {
  weights: OptionWeight[]; cash: number; spot: number; inventoryDelta: number;
  benchmarkDelta: number; affineCash: number; affineSpot: number; notes: string[];
}

export function validatePositions(positions: Position[]): void {
  if (!positions.length) throw new Error('Select at least one position.');
  const base = positions[0]!.base;
  for (const p of positions) {
    if (p.base !== base) throw new Error('Positions must share one underlying; calculate and hedge each underlying separately.');
    if (!['USDC', 'USDT'].includes(p.quote)) throw new Error('Positions require a supported USDC/USDT stablecoin quote; volatile/volatile pairs are unsupported.');
    if (!isUnderlying(p.base)) throw new Error(`Unsupported economic underlying ${p.base}; a verified token mapping is required.`);
    if (![p.benchmarkX, p.benchmarkY, p.baseFees, p.quoteFees].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Invalid position inventory or benchmark.');
    for (const b of [...p.bins, ...(p.benchmarkBins ?? [])]) {
      if (![b.price, b.x, b.y].every(Number.isFinite) || b.price <= 0 || b.x < 0 || b.y < 0) throw new Error('Bins require a positive price and nonnegative finite human-unit balances.');
    }
  }
}

/** Boundary for SDK integer balances; rawPrice is Y atom / X atom. */
export function normalizeAtomicBin(input: {
  id: number; rawPrice: string; xAtomic: string; yAtomic: string;
  xDecimals: number; yDecimals: number; baseIsX: boolean;
}): Bin {
  const { id, xDecimals, yDecimals, baseIsX } = input;
  if (![xDecimals, yDecimals].every(d => Number.isInteger(d) && d >= 0 && d <= 30)) throw new Error('Invalid token decimals.');
  const price = dec(input.rawPrice).mul(dec(10).pow(xDecimals - yDecimals));
  const x = dec(input.xAtomic).div(dec(10).pow(xDecimals));
  const y = dec(input.yAtomic).div(dec(10).pow(yDecimals));
  if (price.lte(0) || x.lt(0) || y.lt(0)) throw new Error('Invalid atomic inventory.');
  const result = baseIsX ? { id, price: price.toNumber(), x: x.toNumber(), y: y.toNumber() }
    : { id, price: dec(1).div(price).toNumber(), x: y.toNumber(), y: x.toNumber() };
  if (![result.price, result.x, result.y].every(Number.isFinite) || result.price <= 0) throw new Error('Numeric model boundary overflow.');
  return result;
}

/** Geometric raw protocol price, subsequently adjusted for token decimals. */
export function binPrice(id: number, binStep: number, xDecimals = 9, yDecimals = 6): number {
  if (!Number.isInteger(id) || binStep <= 0 || !Number.isFinite(binStep)) throw new Error('Invalid bin ID or step.');
  return dec(1).plus(dec(binStep).div(10000)).pow(id).mul(dec(10).pow(xDecimals - yDecimals)).toNumber();
}

export function lpValue(positions: Position[], price: number): number {
  if (!Number.isFinite(price) || price < 0) throw new Error('Scenario price must be finite and nonnegative.');
  return positions.reduce((sum, p) => sum + (p.benchmarkBins ?? p.bins).reduce((v, b) => v + (b.price * b.x + b.y) * Math.min(price / b.price, 1), 0), 0);
}
export function holdValue(positions: Position[], price: number): number {
  return positions.reduce((v, p) => v + p.benchmarkX * price + p.benchmarkY, 0);
}
export function hedgePayoff(positions: Position[], price: number): number { return holdValue(positions, price) - lpValue(positions, price); }
export function currentInventory(positions: Position[], price: number, includeFees = true) {
  let x = new Decimal(0), y = new Decimal(0);
  for (const p of positions) {
    for (const b of p.bins) { x = x.plus(b.x); y = y.plus(b.y); }
    if (includeFees) { x = x.plus(p.baseFees); y = y.plus(p.quoteFees); }
  }
  return { x: x.toNumber(), y: y.toNumber(), value: x.mul(price).plus(y).toNumber(), delta: x.toNumber() };
}

export function decompose(positions: Position[]): Decomposition {
  validatePositions(positions);
  const weights: OptionWeight[] = [];
  let initialX = new Decimal(0), initialY = new Decimal(0), benchmarkX = new Decimal(0), benchmarkY = new Decimal(0);
  for (const p of positions) {
    benchmarkX = benchmarkX.plus(p.benchmarkX); benchmarkY = benchmarkY.plus(p.benchmarkY);
    for (const b of p.benchmarkBins ?? p.bins) {
      initialX = initialX.plus(b.x); initialY = initialY.plus(b.y);
      if (b.x > 0) weights.push({ strike: b.price, type: 'call', quantity: b.x });
      if (b.y > 0) weights.push({ strike: b.price, type: 'put', quantity: dec(b.y).div(b.price).toNumber() });
    }
  }
  weights.sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type));
  const affineSpot = benchmarkX.minus(initialX).toNumber(), affineCash = benchmarkY.minus(initialY).toNumber();
  const notes = ['Hedge weights are underlying units, not venue contract counts.', 'Terminal gamma is a measure at the bin strikes; it is not live smooth gamma.', 'Fixed shares, fee-free arbitrage, common price and unchanged bin allocation are assumed.'];
  if (positions.some(p => p.quote === 'USDT')) notes.push('USDT/USDC quantities are compared at parity in the common USD-equivalent scenario; stablecoin basis is excluded.');
  if (Math.abs(affineSpot) > 1e-8 || Math.abs(affineCash) > 1e-6) notes.push('Benchmark differs from snapshot inventory: H includes an affine cash/spot correction; vanilla long options alone may not replicate it.');
  return { weights, cash: initialY.toNumber(), spot: initialX.toNumber(), inventoryDelta: currentInventory(positions, 0).delta,
    benchmarkDelta: benchmarkX.toNumber(), affineCash, affineSpot, notes };
}

export function optionPayoff(instrument: Pick<OptionInstrument, 'strike' | 'type' | 'multiplier'>, price: number): number {
  return instrument.multiplier * Math.max(instrument.type === 'call' ? price - instrument.strike : instrument.strike - price, 0);
}
export function weightedPayoff(weights: OptionWeight[], price: number): number {
  return weights.reduce((v, w) => v + w.quantity * Math.max(w.type === 'call' ? price - w.strike : w.strike - price, 0), 0);
}
function normalPdf(x: number): number { return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI); }
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const value = 1 - normalPdf(x) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? value : 1 - value;
}
/** Vega per one percentage point IV; theta per calendar day; price in USDC/base. */
export function blackScholes(type: 'call' | 'put', spot: number, strike: number, timeYears: number, iv: number, rate = 0): Greeks & { price: number } {
  if (!(spot >= 0 && strike > 0 && timeYears >= 0 && iv >= 0) || ![spot, strike, timeYears, iv, rate].every(Number.isFinite)) throw new Error('Invalid valuation inputs.');
  if (timeYears === 0 || iv === 0 || spot === 0) {
    const discountedK = strike * Math.exp(-rate * timeYears), callDelta = spot > discountedK ? 1 : spot < discountedK ? 0 : 0.5;
    return { price: Math.max(type === 'call' ? spot - discountedK : discountedK - spot, 0), delta: type === 'call' ? callDelta : callDelta - 1, gamma: 0, vega: 0, theta: 0 };
  }
  const rootT = Math.sqrt(timeYears), d1 = (Math.log(spot / strike) + (rate + iv * iv / 2) * timeYears) / (iv * rootT), d2 = d1 - iv * rootT;
  const discount = Math.exp(-rate * timeYears), density = normalPdf(d1);
  const call = spot * normalCdf(d1) - strike * discount * normalCdf(d2);
  const delta = type === 'call' ? normalCdf(d1) : normalCdf(d1) - 1;
  const theta = (-spot * density * iv / (2 * rootT) + (type === 'call' ? -rate * strike * discount * normalCdf(d2) : rate * strike * discount * normalCdf(-d2))) / 365.25;
  return { price: type === 'call' ? call : call - spot + strike * discount, delta,
    gamma: density / (spot * iv * rootT), vega: spot * density * rootT / 100, theta };
}
export function addGreeks(a: Greeks, b: Greeks, weight = 1): Greeks {
  return { delta: a.delta + b.delta * weight, gamma: a.gamma + b.gamma * weight, vega: a.vega + b.vega * weight, theta: a.theta + b.theta * weight };
}
export function modelOption(instrument: OptionInstrument, spot: number, now = Date.now(), ivOverride?: number) {
  const iv = ivOverride ?? instrument.iv;
  if (iv === null || !Number.isFinite(iv) || iv < 0) throw new Error(`No valid IV for ${instrument.name}.`);
  const model = blackScholes(instrument.type, spot, instrument.strike, Math.max(0, instrument.expiry - now) / YEAR_MS, iv);
  return { price: model.price * instrument.multiplier, ...addGreeks(ZERO_GREEKS, model, instrument.multiplier) };
}
export function modelLp(positions: Position[], spot: number, expiry: number, now = Date.now(), iv = 0.75) {
  const decomposition = decompose(positions);
  let value = decomposition.spot * spot + decomposition.cash;
  let greeks: Greeks = { ...ZERO_GREEKS, delta: decomposition.spot };
  for (const w of decomposition.weights) {
    const option = blackScholes(w.type, spot, w.strike, Math.max(0, expiry - now) / YEAR_MS, iv);
    value -= w.quantity * option.price; greeks = addGreeks(greeks, option, -w.quantity);
  }
  return { value, ...greeks };
}
export function portfolioGreeks(positions: Position[], holdings: OptionHolding[], spot: number, now = Date.now(), ivOverride?: number, expiry?: number) {
  validatePositions(positions);
  const base = positions[0]!.base;
  holdings = holdings.filter(h => h.instrument.underlying === base);
  const inventory: Greeks = { ...ZERO_GREEKS, delta: currentInventory(positions, spot).delta };
  let options = { ...ZERO_GREEKS };
  const unknown: string[] = [];
  for (const h of holdings) {
    const i = h.instrument;
    if (ivOverride === undefined && i.greeks && now - i.timestamp <= 60_000 && i.expiry > now) options = addGreeks(options, i.greeks, h.quantity * i.multiplier);
    else if (i.iv !== null || ivOverride !== undefined) options = addGreeks(options, modelOption(i, spot, now, ivOverride), h.quantity);
    else unknown.push(i.name);
  }
  const horizon = expiry ?? holdings.find(h => h.instrument.expiry > now)?.instrument.expiry ?? now + 30 * 86400_000;
  const model = modelLp(positions, spot, horizon, now, ivOverride ?? 0.75);
  return { inventory, options, model, total: addGreeks(inventory, options), modelTotal: addGreeks(model, options), unknown,
    conventions: { delta: base, gamma: `${base} / USD equivalent`, vega: 'USD equivalent / 1 IV percentage point', theta: 'USD equivalent / calendar day', lpModel: 'Zero-rate lognormal terminal value; stablecoins at parity; excludes fees and rewards.' } };
}
