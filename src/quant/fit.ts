import { resolveLpModel } from './risk-model';
import { gammaLots } from './gamma';
import Decimal from 'decimal.js';
import type { FitResult, FitSettings, Greeks, HedgeLeg, OptionHolding, OptionInstrument, PayoffPoint, Position, Source } from '../shared/types.js';
import { addGreeks, modelLp, decompose, hedgePayoff, holdValue, lpValue, modelOption, optionPayoff, validatePositions, ZERO_GREEKS } from './math.js';

export function scenarioGrid(positions: Position[], instruments: OptionInstrument[], spot: number): number[] {
  validatePositions(positions);
  instruments = instruments.filter(i => i.underlying === positions[0]!.base);
  const prices = positions.flatMap(p => (p.benchmarkBins ?? p.bins).map(b => b.price));
  const max = Math.max(spot, ...prices, ...instruments.map(i => i.strike)) * 2;
  return [...new Set([0, ...Array.from({ length: 101 }, (_, j) => max * j / 100), spot, ...prices, ...instruments.map(i => i.strike)])].sort((a, b) => a - b);
}
export function payoffPoints(positions: Position[], holdings: OptionHolding[], legs: HedgeLeg[], spot: number, expiry: number, totalCost = 0, grid?: number[]): PayoffPoint[] {
  validatePositions(positions);
  const underlying = positions[0]!.base;
  if (legs.some(l => l.instrument.underlying !== underlying || l.instrument.expiry !== expiry)) throw new Error('Proposed payoff legs must share the selected underlying and expiry.');
  const matching = holdings.filter(h => h.instrument.expiry === expiry && h.instrument.underlying === underlying);
  return (grid ?? scenarioGrid(positions, [...matching.map(h => h.instrument), ...legs.map(l => l.instrument)], spot)).map(price => {
    const hold = holdValue(positions, price), lp = lpValue(positions, price), theoretical = hold - lp;
    const fitted = matching.reduce((n, h) => n + h.quantity * optionPayoff(h.instrument, price), 0) + legs.reduce((n, l) => n + l.quantity * optionPayoff(l.instrument, price), 0);
    const existingBasis = matching.reduce((n, h) => n + h.quantity * h.averagePrice * h.instrument.multiplier, 0);
    return { price, hold, lp, il: -theoretical, theoretical, fitted, residual: fitted - theoretical,
      netPnl: lp + fitted - totalCost - existingBasis - holdValue(positions, spot) };
  });
}
export interface ExecutableCost { cost: number; fee: number; filledQuantity: number; available: number; averagePrice: number | null }
/** Ladders expressed as [USDC/base premium, contract quantity]; multiplication occurs once. */
export function executableCost(instrument: OptionInstrument, quantity: number): ExecutableCost {
  const levels = (instrument.asks?.length ? instrument.asks : instrument.ask !== null ? [[instrument.ask, instrument.askSize]] : [])
    .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p! >= 0 && q! > 0).sort((a, b) => a[0]! - b[0]!);
  let remaining = quantity, cost = new Decimal(0), available = 0;
  for (const [p, q] of levels) {
    available += q!;
    const take = Math.max(0, Math.min(remaining, q!));
    cost = cost.plus(new Decimal(p!).mul(take).mul(instrument.multiplier)); remaining -= take;
  }
  const filledQuantity = quantity - Math.max(0, remaining), value = cost.toNumber();
  const fee = instrument.feeModel && filledQuantity > 0
    ? instrument.feeModel.fixed + Math.min(instrument.feeModel.underlyingRate * instrument.feeModel.spot * filledQuantity * instrument.multiplier,
      instrument.feeModel.premiumCapRate * value)
    : value * instrument.feeRate;
  return { cost: value, fee, filledQuantity, available,
    averagePrice: filledQuantity ? value / (filledQuantity * instrument.multiplier) : null };
}
function roundDown(q: number, step: number): number { return new Decimal(Math.max(0, q)).div(step).floor().mul(step).toNumber(); }
function roundUp(q: number, step: number): number { return new Decimal(Math.max(0, q)).div(step).ceil().mul(step).toNumber(); }
function fingerprint(value: unknown): string {
  const s = JSON.stringify(value); let hash = 2166136261;
  for (let j = 0; j < s.length; j++) hash = Math.imul(hash ^ s.charCodeAt(j), 16777619);
  return (hash >>> 0).toString(16);
}
export function hedgeFingerprint(positions: Position[], instruments: OptionInstrument[], holdings: OptionHolding[], settings: FitSettings): string {
  return fingerprint({ positions, instruments, holdings, settings });
}

export function fitHedge(positions: Position[], instruments: OptionInstrument[], holdings: OptionHolding[], settings: FitSettings, spot: number, now = Date.now(), maxDataAgeMs = 30_000): FitResult {
  validatePositions(positions);
  const underlying = positions[0]!.base;
  // Venue account discovery may contain many underlyings; a fit has one price axis.
  const excludedHoldings = holdings.filter(h => h.instrument.underlying !== underlying && h.quantity !== 0).length;
  instruments = instruments.filter(i => i.underlying === underlying);
  holdings = holdings.filter(h => h.instrument.underlying === underlying);
  if (!(settings.coverage >= 0 && settings.coverage <= 1) || !Number.isFinite(settings.budget) || settings.budget < 0 || !Number.isInteger(settings.maxLegs) || settings.maxLegs < 0 || settings.expiry <= now || !(spot > 0)) throw new Error('Invalid expiry, coverage, budget, maximum legs or spot.');
  if (settings.maxUndercoverage !== null && (!Number.isFinite(settings.maxUndercoverage) || settings.maxUndercoverage < 0)) throw new Error('Maximum undercoverage must be nonnegative USDC or null.');
  if (holdings.some(h => !Number.isFinite(h.quantity) || !Number.isFinite(h.averagePrice) || h.instrument.multiplier <= 0 || !Number.isFinite(h.instrument.multiplier))) throw new Error('Existing positions contain invalid contract quantities, multipliers or cost basis.');
  const source: Source = instruments.some(i => i.source === 'live') && instruments.every(i => i.source === 'live') ? 'live' : instruments.some(i => i.source === 'hypothetical') ? 'hypothetical' : 'fixture';
  const reasons: string[] = [], notes = ['Fit errors refer to the selected coverage fraction; residual IL chart uses full IL.',
    settings.objective === 'gamma' ? 'Current gamma fit uses a hard residual tolerance followed by executable cost; terminal payoff errors are separate diagnostics.' : 'Payoff fit uses squared USDC error, a documented premium penalty, listed strikes and post-rounding checks.',
    'Maximum errors are measured on a grid containing every payoff kink and both finite tails. Upper-tail slope error separately describes prices beyond the grid.',
    'Terminal matching does not imply live gamma neutrality. Projected automatic perpetual P&L is excluded from terminal plots.'];
  const decomposition = decompose(positions);
  if (excludedHoldings) notes.push(`${excludedHoldings} held option positions on other underlyings are excluded from this fit and remain in their respective asset risk groups.`);
  if (instruments.some(i => i.feeModel?.kind === 'bybit')) notes.push('Bybit fees use the public non-VIP index-notional rate capped by premium; the account rate is checked before purchase. Delivery fees are excluded from gross terminal payoff.');
  else if (instruments.some(i => i.feeModel)) notes.push('Fees include the quoted per-leg fixed fee and index-notional fee capped by premium. Additional orders or requotes can add fixed fees.');
  const matching = holdings.filter(h => h.instrument.expiry === settings.expiry && h.instrument.underlying === positions[0]!.base);
  if (holdings.some(h => h.instrument.expiry !== settings.expiry)) notes.push('Positions at other expiries remain in account risk but are excluded from same-horizon terminal hedge coverage.');
  const candidates = instruments.filter(i => i.underlying === positions[0]!.base && i.expiry === settings.expiry && i.expiry > now
    && i.multiplier > 0 && i.minSize > 0 && i.sizeStep > 0 && i.ask !== null && i.ask >= 0 && Number.isFinite(i.ask)
    && [i.multiplier, i.minSize, i.sizeStep, i.strike, i.timestamp, i.feeRate].every(Number.isFinite) && i.strike > 0 && i.feeRate >= 0
    && (!i.feeModel || Object.values(i.feeModel).filter(v => typeof v === 'number').every(v => Number.isFinite(v) && Number(v) >= 0) && i.feeModel.spot > 0)
    && now - i.timestamp <= 60_000 && i.timestamp <= now + 5000 && executableCost(i, 0).available >= i.minSize);
  if (!candidates.length && settings.coverage > 0) reasons.push('No fresh, fillable listed options at the selected expiry.');
  const grid = scenarioGrid(positions, [...candidates, ...matching.map(h => h.instrument)], spot);
  const targets = grid.map(p => settings.coverage * hedgePayoff(positions, p));
  const baseline = grid.map(p => matching.reduce((sum, h) => sum + h.quantity * optionPayoff(h.instrument, p), 0));
  const maxPayoff = Math.max(1, ...targets.map(Math.abs));
  const scale = maxPayoff;
  const matrix = candidates.map(i => grid.map(p => optionPayoff(i, p) / scale));
  const targetVector = targets.map(v => v / scale), fitBaseline = baseline.map(v => v / scale);
  let gammaRisk: FitResult['gammaRisk'];
  const quantities = candidates.map(() => 0);
  const limits = candidates.map(i => roundDown(executableCost(i, 0).available, i.sizeStep));
  const premiumScale = Math.max(1, holdValue(positions, spot));
  const totalCostFor = (qs: number[]) => qs.reduce((v, q, j) => { const c = executableCost(candidates[j]!, q); return v + c.cost + c.fee; }, 0);
  if (settings.objective === 'gamma') {
    const config = settings.gamma ?? { expiry: 0, ivMode: 'market' as const, ivPercent: 70, tolerance: 0.01 };
    if (!Number.isFinite(config.tolerance) || config.tolerance < 0 || config.tolerance > 1e12 || !['market','manual'].includes(config.ivMode)) throw new Error('Invalid gamma model or tolerance');
    const model = resolveLpModel(instruments, spot, config, settings.expiry, maxDataAgeMs, now, underlying);
    if (model.iv == null || model.expiry <= now) throw new Error('Gamma target requires a fresh market IV or valid manual IV and a future LP horizon');
    const lp = modelLp(positions.map(p => ({...p, benchmarkBins:p.bins})), spot, model.expiry, now, model.iv).gamma;
    let existing = 0;
    for (const h of holdings.filter(h => h.quantity !== 0)) {
      const i = instruments.find(i => i.name === h.instrument.name && i.venue === h.instrument.venue && i.network === h.instrument.network) ?? h.instrument;
      if (i.expiry <= now || !i.greeks || !Number.isFinite(i.greeks.gamma) || now-i.timestamp > maxDataAgeMs || i.timestamp > now+5000) throw new Error(`Fresh gamma is unavailable for held ${i.name}; reconcile before quoting`);
      existing += h.quantity*i.multiplier*i.greeks.gamma;
    }
    const unitGamma = candidates.map(i => i.greeks && Number.isFinite(i.greeks.gamma) && i.greeks.gamma >= 0 && now-i.timestamp <= maxDataAgeMs ? i.multiplier*i.greeks.gamma : 0);
    const target = lp*(1-settings.coverage), before = lp+existing;
    const fitted = gammaLots(candidates, unitGamma, target-before, config.tolerance, settings, executableCost);
    fitted.forEach((q,j) => { quantities[j]=q; });
    const added = fitted.reduce((v,q,j)=>v+q*unitGamma[j]!,0), after=before+added;
    gammaRisk = {lp,existing,before,added,after,target,error:Math.abs(after-target),tolerance:config.tolerance,iv:model.iv,expiry:model.expiry,ivSource:model.ivSource};
    if (gammaRisk.error > config.tolerance+1e-10) reasons.push(`No basket within gamma tolerance found under budget, depth, minimum lots and leg limits: residual ${after.toFixed(6)}, target ${target.toFixed(6)}, tolerance ${config.tolerance} ${underlying}/$. Long-only purchases cannot reduce an already excessive positive gamma.`);
    notes.push('Current net gamma fit: current LP bins at the displayed IV/horizon plus signed filled option venue gamma at every expiry. At 100% coverage the target is zero; partial coverage leaves the stated fraction of LP gamma. Perpetual gamma is zero.');
    notes.push('Discrete bounded search prioritizes gamma tolerance, then executable cost; it does not prove global optimality or infeasibility. Gamma is a quote-time sensitivity, not a promise of future neutrality or terminal IL replication.');
  } else if (settings.objective === 'superhedge') {
    // Constructive dominance: move calls DOWN in strike and puts UP. Aggregate before lot rounding.
    for (const w of decomposition.weights) {
      const eligible = candidates.map((i, j) => ({ i, j })).filter(({ i }) => i.type === w.type && (w.type === 'call' ? i.strike <= w.strike + 1e-9 : i.strike >= w.strike - 1e-9));
      eligible.sort((a, b) => Math.abs(a.i.strike - w.strike) - Math.abs(b.i.strike - w.strike));
      const chosen = eligible[0];
      if (!chosen && w.quantity * settings.coverage > 1e-10) reasons.push(`No dominating ${w.type} strike for bin ${w.strike.toFixed(6)}.`);
      else if (chosen) quantities[chosen.j] = quantities[chosen.j]! + settings.coverage * w.quantity / chosen.i.multiplier;
    }
    for (let j = 0; j < candidates.length; j++) {
      const i = candidates[j]!, existing = matching.filter(h => h.instrument.name === i.name).reduce((v, h) => v + h.quantity, 0);
      const required = Math.max(0, quantities[j]! - existing);
      quantities[j] = required <= 1e-12 ? 0 : Math.max(roundUp(i.minSize, i.sizeStep), roundUp(required, i.sizeStep));
      if (quantities[j]! > limits[j]! + 1e-9) { quantities[j] = limits[j]!; reasons.push(`Insufficient quoted depth for conservative ${i.name}.`); }
    }
    // A nearest-bin construction may exceed the leg limit even when a wider,
    // more expensive two-leg superhedge exists. Try all single-strike choices
    // that dominate each complete call/put side before declaring failure.
    const combinedAt = (qs: number[], p: number) => matching.reduce((v, h) => v + h.quantity * optionPayoff(h.instrument, p), 0)
      + qs.reduce((v, q, j) => v + q * optionPayoff(candidates[j]!, p), 0);
    const dominates = (qs: number[]) => grid.every((p, j) => combinedAt(qs, p) + 1e-7 >= targets[j]!)
      && matching.filter(h => h.instrument.type === 'call').reduce((v, h) => v + h.quantity * h.instrument.multiplier, 0)
        + qs.reduce((v, q, j) => v + (candidates[j]!.type === 'call' ? q * candidates[j]!.multiplier : 0), 0)
        + 1e-8 >= settings.coverage * (decomposition.affineSpot + decomposition.weights.filter(w => w.type === 'call').reduce((v, w) => v + w.quantity, 0));
    const allowed = (qs: number[]) => qs.filter(q => q > 1e-10).length <= settings.maxLegs && totalCostFor(qs) <= settings.budget + 1e-8 && dominates(qs);
    if (!allowed(quantities)) {
      const callWeights = decomposition.weights.filter(w => w.type === 'call'), putWeights = decomposition.weights.filter(w => w.type === 'put');
      const callChoices = callWeights.length ? candidates.map((i, j) => ({ i, j })).filter(({ i }) => i.type === 'call' && i.strike <= Math.min(...callWeights.map(w => w.strike))) : [null];
      const putChoices = putWeights.length ? candidates.map((i, j) => ({ i, j })).filter(({ i }) => i.type === 'put' && i.strike >= Math.max(...putWeights.map(w => w.strike))) : [null];
      let fallback: number[] | null = null, fallbackCost = Infinity;
      for (const call of callChoices) for (const put of putChoices) {
        const test = candidates.map(() => 0);
        for (const [choice, required] of [[call, callWeights.reduce((v, w) => v + w.quantity, 0)], [put, putWeights.reduce((v, w) => v + w.quantity, 0)]] as const) {
          if (!choice) continue;
          const existing = matching.filter(h => h.instrument.name === choice.i.name).reduce((v, h) => v + h.quantity, 0);
          const raw = Math.max(0, required * settings.coverage / choice.i.multiplier - existing);
          test[choice.j] = raw > 1e-10 ? Math.max(roundUp(raw, choice.i.sizeStep), roundUp(choice.i.minSize, choice.i.sizeStep)) : 0;
        }
        if (test.some((q, j) => q > limits[j]! + 1e-9) || !allowed(test)) continue;
        const cost = totalCostFor(test);
        if (cost < fallbackCost) { fallback = test; fallbackCost = cost; }
      }
      if (fallback) {
        for (let j = 0; j < quantities.length; j++) quantities[j] = fallback[j]!;
        for (let j = reasons.length - 1; j >= 0; j--) if (reasons[j]!.includes('dominating') || reasons[j]!.includes('quoted depth for conservative')) reasons.splice(j, 1);
        notes.push('Used a wider consolidated conservative basket to satisfy the leg/depth/budget constraints.');
      }
    }
    if (Math.abs(decomposition.affineCash) > 1e-6 || Math.abs(decomposition.affineSpot) > 1e-8) notes.push('Original benchmark affine correction requires explicit dominance checks; it is not silently represented as an option.');
  } else if (candidates.length && settings.maxLegs > 0) {
    // Warm start by interpolating neighboring listed strikes. Exact listed strikes
    // recover the analytic basket immediately; sparse brackets preserve tail slopes.
    for (const w of decomposition.weights) {
      const sameType = candidates.map((i, j) => ({ i, j })).filter(({ i }) => i.type === w.type).sort((a, b) => a.i.strike - b.i.strike);
      const lower = sameType.filter(({ i }) => i.strike <= w.strike).at(-1), upper = sameType.find(({ i }) => i.strike >= w.strike);
      if (lower && upper && lower.i.strike < upper.i.strike) {
        const lowerWeight = (upper.i.strike - w.strike) / (upper.i.strike - lower.i.strike);
        quantities[lower.j] += settings.coverage * w.quantity * lowerWeight / lower.i.multiplier;
        quantities[upper.j] += settings.coverage * w.quantity * (1 - lowerWeight) / upper.i.multiplier;
      } else {
        const chosen = lower ?? upper;
        if (chosen) quantities[chosen.j] += settings.coverage * w.quantity / chosen.i.multiplier;
      }
    }
    for (let j = 0; j < quantities.length; j++) {
      const existing = matching.filter(h => h.instrument.name === candidates[j]!.name).reduce((s, h) => s + h.quantity, 0);
      quantities[j] = Math.min(limits[j]!, Math.max(0, quantities[j]! - existing));
    }
    const residual = targetVector.map((v, r) => fitBaseline[r]! + quantities.reduce((s, q, j) => s + q * matrix[j]![r]!, 0) - v);
    const disabled = new Set<number>();
    // Convex continuous coordinate descent before executable lot projection and cardinality reduction.
    for (let outer = 0; outer < 2; outer++) {
      for (let iteration = 0; iteration < 350; iteration++) {
        let maxChange = 0;
        for (let j = 0; j < candidates.length; j++) {
          if (disabled.has(j)) continue;
          const column = matrix[j]!, norm = column.reduce((v, a) => v + a * a, 0);
          if (norm < 1e-18) continue;
          const gradient = column.reduce((v, a, r) => v + a * residual[r]!, 0);
          const pricePenalty = 0.001 * targetVector.length * candidates[j]!.ask! * candidates[j]!.multiplier / premiumScale;
          const next = Math.max(0, Math.min(limits[j]!, quantities[j]! - (gradient + pricePenalty / 2) / norm));
          const change = next - quantities[j]!;
          if (change) { quantities[j] = next; for (let r = 0; r < residual.length; r++) residual[r] = residual[r]! + change * column[r]!; }
          maxChange = Math.max(maxChange, Math.abs(change));
        }
        if (maxChange < 1e-7) break;
      }
      const active = quantities.map((q, j) => ({ j, impact: q * Math.sqrt(matrix[j]!.reduce((v, a) => v + a * a, 0)) })).filter(x => x.impact > 1e-8).sort((a, b) => b.impact - a.impact);
      for (const { j } of active.slice(settings.maxLegs)) { const q = quantities[j]!; quantities[j] = 0; disabled.add(j); for (let r = 0; r < residual.length; r++) residual[r] = residual[r]! - q * matrix[j]![r]!; }
    }
    const cost = totalCostFor(quantities), budgetFactor = cost > settings.budget ? settings.budget / cost : 1;
    for (let j = 0; j < quantities.length; j++) {
      const i = candidates[j]!, q = roundDown(quantities[j]! * budgetFactor, i.sizeStep);
      quantities[j] = q >= i.minSize - 1e-10 ? q : 0;
    }
    // Fixed order fees do not scale with quantity. Project using exact swept cost
    // after scaling, dropping the least-important leg if fees alone exceed budget.
    for (let iteration = 0; totalCostFor(quantities) > settings.budget + 1e-8 && iteration < 5000; iteration++) {
      let chosen = -1, bestRatio = Infinity, replacement = 0;
      for (let j = 0; j < quantities.length; j++) {
        if (quantities[j]! <= 0) continue;
        const i = candidates[j]!, next = roundDown(quantities[j]! - i.sizeStep + 1e-12, i.sizeStep), legal = next >= i.minSize - 1e-9 ? next : 0;
        const before = executableCost(i, quantities[j]!), after = executableCost(i, legal);
        const saved = before.cost + before.fee - after.cost - after.fee;
        if (saved <= 0) continue;
        const lost = (quantities[j]! - legal) * Math.sqrt(matrix[j]!.reduce((v, a) => v + a * a, 0));
        if (lost / saved < bestRatio) { chosen = j; bestRatio = lost / saved; replacement = legal; }
      }
      if (chosen < 0) break;
      quantities[chosen] = replacement;
    }
    // Discrete improvement: add one legal lot only if it improves objective and satisfies exact ladder cost.
    const loss = (qs: number[]) => {
      const error = targetVector.reduce((v, target, r) => { const diff = fitBaseline[r]! + qs.reduce((s, q, j) => s + q * matrix[j]![r]!, 0) - target; return v + diff * diff; }, 0) / targetVector.length;
      return error + 0.001 * totalCostFor(qs) / premiumScale;
    };
    let bestLoss = loss(quantities);
    for (let step = 0; step < 300; step++) {
      let bestIndex = -1, bestQ = 0, improved = bestLoss;
      const legs = quantities.filter(q => q > 0).length;
      for (let j = 0; j < quantities.length; j++) {
        const i = candidates[j]!;
        if (quantities[j] === 0 && legs >= settings.maxLegs) continue;
        const q = quantities[j] === 0 ? roundUp(i.minSize, i.sizeStep) : quantities[j]! + i.sizeStep;
        if (q > limits[j]! + 1e-8) continue;
        const test = [...quantities]; test[j] = q;
        if (totalCostFor(test) > settings.budget + 1e-8) continue;
        const candidateLoss = loss(test);
        if (candidateLoss < improved - 1e-12) { improved = candidateLoss; bestIndex = j; bestQ = q; }
      }
      if (bestIndex < 0) break;
      quantities[bestIndex] = bestQ; bestLoss = improved;
    }
  }
  const legs: HedgeLeg[] = quantities.flatMap((quantity, j) => {
    if (quantity <= 1e-10) return [];
    const instrument = candidates[j]!, quote = executableCost(instrument, quantity);
    return [{ instrument, quantity, existingQuantity: matching.filter(h => h.instrument.name === instrument.name).reduce((s, h) => s + h.quantity, 0), cost: quote.cost, fee: quote.fee }];
  });
  const cost = legs.reduce((s, l) => s + l.cost, 0), fees = legs.reduce((s, l) => s + l.fee, 0), totalCost = cost + fees;
  if (totalCost > settings.budget + 1e-8) reasons.push('Executable conservative hedge exceeds the budget.');
  if (legs.length > settings.maxLegs) reasons.push('Conservative hedge exceeds the maximum number of legs.');
  const points = payoffPoints(positions, matching, legs, spot, settings.expiry, totalCost, grid);
  const errors = points.map(p => p.fitted - p.theoretical * settings.coverage);
  const maxError = Math.max(0, ...errors.map(Math.abs)), maxUndercoverage = Math.max(0, ...errors.map(e => -e));
  const weights = grid.map(p => 0.05 + Math.exp(-0.5 * (Math.log(Math.max(p, 0.01) / spot) / 0.35) ** 2));
  const weightedError = Math.sqrt(errors.reduce((s, e, j) => s + weights[j]! * e * e, 0) / weights.reduce((s, w) => s + w, 0));
  const optionSlopes = (type: 'call' | 'put') => matching.filter(h => h.instrument.type === type).reduce((s, h) => s + h.quantity * h.instrument.multiplier, 0)
    + legs.filter(l => l.instrument.type === type).reduce((s, l) => s + l.quantity * l.instrument.multiplier, 0);
  const targetUpper = decomposition.affineSpot + decomposition.weights.filter(w => w.type === 'call').reduce((s, w) => s + w.quantity, 0);
  const targetLower = decomposition.affineSpot - decomposition.weights.filter(w => w.type === 'put').reduce((s, w) => s + w.quantity, 0);
  const upperTailSlopeError = optionSlopes('call') - targetUpper * settings.coverage;
  const lowerTailSlopeError = -optionSlopes('put') - targetLower * settings.coverage;
  if (settings.maxUndercoverage !== null && maxUndercoverage > settings.maxUndercoverage + 1e-6) reasons.push(`Maximum scenario undercoverage ${maxUndercoverage.toFixed(2)} USDC exceeds the configured bound.`);
  if (settings.maxUndercoverage !== null && upperTailSlopeError < -1e-8) reasons.push('Negative upper-tail slope residual creates unbounded undercoverage beyond the finite scenario grid.');
  if (settings.objective === 'superhedge' && (maxUndercoverage > 1e-6 || upperTailSlopeError < -1e-8)) reasons.push('Candidate basket does not dominate the target over all nonnegative terminal prices.');
  if (settings.objective === 'superhedge' && !reasons.length) notes.push('Dominance verified at every joint kink, S=0, and the upper-tail slope; therefore the stated idealized payoff is superhedged for all S≥0.');
  let greeks: Greeks = { ...ZERO_GREEKS };
  for (const leg of legs) greeks = addGreeks(greeks, leg.instrument.greeks ? addGreeks(ZERO_GREEKS, leg.instrument.greeks, leg.instrument.multiplier) : modelOption(leg.instrument, spot, now, leg.instrument.iv ?? 0.75), leg.quantity);
  if (source !== 'live') notes.push('Synthetic/paper quotes are not executable on Bybit.');
  if (instruments.some(i => i.venue === 'bybit')) notes.push('Bybit options settle in USDT. The displayed USD/USDC comparison assumes USDT and USDC parity; stablecoin and cross-venue index basis remain unhedged. A terminal fit is approximate across these numeraires.');
  const createdAt = now, fp = hedgeFingerprint(positions, instruments, holdings, settings);
  if (settings.objective === 'payoff' && settings.maxUndercoverage !== null
      && (maxUndercoverage > settings.maxUndercoverage + 1e-6 || upperTailSlopeError < -1e-8)) {
    const conservative = fitHedge(positions, instruments, holdings, { ...settings, objective: 'superhedge' }, spot, now);
    if (conservative.feasible) return { ...conservative, id: `hedge-${now}-${fp}`, settings, fingerprint: fp,
      notes: [...conservative.notes, `The ${settings.objective} approximation missed the required undercoverage bound; a feasible conservative basket was selected to respect the hard constraint.`] };
  }
  return { id: `hedge-${now}-${fp}`, createdAt, expiresAt: Math.min(now + 15_000, ...legs.map(l => l.instrument.timestamp + 60_000)), source,
    legs, cost, fees, totalCost, feasible: reasons.length === 0, reasons: [...new Set(reasons)], maxError, weightedError, maxUndercoverage,
    lowerTailSlopeError, upperTailSlopeError, points, settings, fingerprint: fp, greeks, notes, gammaRisk };
}
