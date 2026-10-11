import type { FitSettings, MarketSnapshot, OptionHolding, Position } from '../shared/types.js';
import { fitHedge } from './fit.js';
import { currentInventory, holdValue, lpValue, modelLp, modelOption, validatePositions } from './math.js';

export function scenarioSurface(positions: Position[], holdings: OptionHolding[], spot: number, expiry: number, iv = 0.75, now = Date.now()) {
  validatePositions(positions);
  holdings = holdings.filter(h => h.instrument.underlying === positions[0]!.base);
  return Array.from({ length: 81 }, (_, j) => {
    const price = spot * (0.35 + j * 1.3 / 80), lp = modelLp(positions, price, expiry, now, iv);
    let optionsValue = 0, delta = lp.delta, gamma = lp.gamma;
    for (const holding of holdings) {
      const option = modelOption(holding.instrument, price, now, iv);
      optionsValue += holding.quantity * option.price;
      delta += holding.quantity * option.delta; gamma += holding.quantity * option.gamma;
    }
    return { price, lpModel: lp.value, optionsValue, totalValue: lp.value + optionsValue, delta, gamma };
  });
}

export interface SimulationSettings {
  alphaPercent?: number; steps?: number; horizonDays?: number; annualLpFeeRate?: number;
  spreadBps?: number; feeBps?: number; latencySteps?: number; basisBps?: number;
  collateral?: number; reserves?: number; fit?: FitSettings; now?: number;
}
export interface StrategyComparison {
  name: string; path: string; strategy: string; finalPnl: number; maxDrawdown: number; costs: number;
  feesEarned: number; funding: number; hedgeCount: number; maxPerpMargin: number;
  totalCapital: number; returnOnCapital: number; marginBreached: boolean;
  series: { time: number; price: number; pnl: number; lp: number; options: number; perpPnl: number; perp: number; delta: number }[];
}

/** Deterministic scenario simulation, NOT a historical DLMM fee reconstruction. */
export function simulateStrategies(positions: Position[], market: MarketSnapshot, settings: SimulationSettings = {}) {
  validatePositions(positions);
  const now = settings.now ?? market.timestamp, spot = market.referencePrice;
  const steps = Math.max(12, Math.min(1000, settings.steps ?? 120)), horizonDays = settings.horizonDays ?? 30;
  const totalMs = horizonDays * 86400_000, alpha = (settings.alphaPercent ?? 1) / 100;
  const spreadBps = settings.spreadBps ?? 4, feeBps = settings.feeBps ?? 3.5, latency = Math.max(0, Math.round(settings.latencySteps ?? 1));
  const availableExpiry = [...new Set(market.instruments.filter(i => i.underlying === positions[0]!.base).map(i => i.expiry))].filter(t => t > now).sort((a, b) => a - b)[0];
  if (!availableExpiry) return { points: [], comparisons: [], notes: ['No listed future expiry is available for this scenario.'] };
  const initialValue = holdValue(positions, spot);
  const fitSettings = settings.fit ?? { expiry: availableExpiry, coverage: 1, budget: initialValue * 0.15, maxLegs: 10, objective: 'payoff', maxUndercoverage: null };
  const fit = fitHedge(positions, market.instruments, [], fitSettings, spot, now);
  const optionHoldings: OptionHolding[] = fit.legs.map(l => ({ instrument: l.instrument, quantity: l.quantity, averagePrice: l.cost / (l.quantity * l.instrument.multiplier) }));
  const collateral = settings.collateral ?? initialValue * 0.5, reserves = settings.reserves ?? initialValue * 0.2;
  const totalCapital = initialValue + collateral + reserves + fit.totalCost;
  const scenarios = [
    { name: 'Oscillation', price: (t: number) => spot * Math.exp(0.11 * Math.sin(10 * Math.PI * t) + 0.025 * Math.sin(34 * Math.PI * t)) },
    { name: 'Rally and range exit', price: (t: number) => spot * Math.exp(0.45 * t + 0.04 * Math.sin(12 * Math.PI * t)) },
    { name: 'Gap down and basis stress', price: (t: number) => spot * Math.exp(-0.2 * t - (t >= 0.45 ? 0.28 : 0) + 0.025 * Math.sin(12 * Math.PI * t)) },
  ];
  const comparisons: StrategyComparison[] = [];
  const bins = positions.flatMap(p => p.benchmarkBins ?? p.bins), low = Math.min(...bins.map(b => b.price)), high = Math.max(...bins.map(b => b.price));
  const inventoryAt = (price: number) => bins.reduce((delta, b) => delta + (price < b.price ? b.x + b.y / b.price : price === b.price ? b.x : 0), 0);
  for (const path of scenarios) for (const strategy of ['LP only', 'LP + perps', 'LP + options + perps']) {
    const useOptions = strategy.includes('options'), usePerps = strategy.includes('perps');
    let perp = 0, perpPnl = 0, funding = 0, feesEarned = 0, costs = useOptions ? fit.fees : 0;
    let anchor = spot, lastPrice = spot, lastPerpPrice = spot, peakPnl = 0, maxDrawdown = 0, hedgeCount = 0, maxPerpMargin = 0, marginBreached = false;
    let pending: { due: number; target: number } | null = null;
    let settledOptions = 0, settlementDone = false;
    const series: StrategyComparison['series'] = [];
    for (let step = 0; step <= steps; step++) {
      const t = step / steps, price = path.price(t), time = now + totalMs * t;
      const baseBasis = (settings.basisBps ?? 15) / 10_000;
      const basis = path.name.includes('basis') && t >= 0.45 && t <= 0.6 ? baseBasis * 8 : baseBasis * Math.sin(2 * Math.PI * t);
      const perpPrice = price * (1 + basis);
      if (step > 0) {
        perpPnl += perp * (perpPrice - lastPerpPrice);
        const hourlyFunding = path.name.includes('basis') && t >= 0.45 ? -Math.abs(market.fundingRate) * 3 : market.fundingRate;
        funding -= perp * perpPrice * hourlyFunding * (horizonDays * 24 / steps);
        if (price >= low && price <= high) feesEarned += initialValue * (settings.annualLpFeeRate ?? 0.2) * horizonDays / (365.25 * steps);
      }
      let optionValue = settledOptions, optionDelta = 0;
      if (useOptions && !settlementDone) {
        optionValue = 0;
        for (const h of optionHoldings) {
          const mark = modelOption(h.instrument, price, time);
          optionValue += h.quantity * mark.price;
          if (time < h.instrument.expiry) optionDelta += h.quantity * mark.delta;
        }
        if (time >= fitSettings.expiry) { settledOptions = optionValue; settlementDone = true; }
      }
      const nonPerpDelta = inventoryAt(price) + optionDelta;
      if (pending && step >= pending.due) {
        const difference = pending.target - perp;
        costs += Math.abs(difference) * perpPrice * (spreadBps + feeBps) / 10_000;
        perp = pending.target; anchor = price; pending = null; hedgeCount++;
      }
      if (usePerps && !pending && (step === 0 || Math.abs(price / anchor - 1) >= alpha || (settlementDone && step > 0 && series[step - 1]!.options !== settledOptions))) {
        const desired = Math.round(-nonPerpDelta / market.perpSizeStep) * market.perpSizeStep;
        if (Math.abs(desired - perp) * perpPrice >= market.perpMinNotional) {
          pending = { due: step + latency, target: desired };
          if (latency === 0) {
            costs += Math.abs(desired - perp) * perpPrice * (spreadBps + feeBps) / 10_000;
            perp = desired; anchor = price; pending = null; hedgeCount++;
          }
        } else anchor = price;
      }
      const lp = lpValue(positions, price), pnl = lp - initialValue + feesEarned + optionValue - (useOptions ? fit.cost : 0) + perpPnl + funding - costs;
      peakPnl = Math.max(peakPnl, pnl); maxDrawdown = Math.max(maxDrawdown, peakPnl - pnl);
      const marginRequirement = Math.abs(perp) * perpPrice * 0.2;
      maxPerpMargin = Math.max(maxPerpMargin, marginRequirement);
      if (collateral + perpPnl + funding - costs < marginRequirement) marginBreached = true;
      series.push({ time, price, pnl, lp, options: optionValue, perpPnl, perp, delta: nonPerpDelta + perp });
      lastPrice = price; lastPerpPrice = perpPrice;
    }
    const finalPnl = series.at(-1)!.pnl;
    comparisons.push({ name: `${path.name} · ${strategy}`, path: path.name, strategy, finalPnl, maxDrawdown, costs,
      feesEarned, funding, hedgeCount, maxPerpMargin, totalCapital, returnOnCapital: finalPnl / totalCapital, marginBreached, series });
    void lastPrice;
  }
  return { points: scenarioSurface(positions, optionHoldings, spot, fitSettings.expiry, 0.75, now), comparisons, fit,
    notes: ['Deterministic scenario study, not a backtest. DLMM inventory uses arbitrage-equilibrated fixed original bins.',
      `LP fees assumed ${(settings.annualLpFeeRate ?? 0.2) * 100}% annualized while inside the range; no claim to reconstruct historical swap fees.`,
      `Perp execution costs ${spreadBps + feeBps} bps; ${latency} simulation-step latency; actual lot/minimum size. Funding is the snapshot hourly rate with negative-funding stress.`,
      'Options bought at ladder asks plus fees, marked with snapshot IV, settled at the first simulated observation at/after expiry. Time-step settlement approximation is explicit.',
      'Dollar-neutral hedge targets actual fee-free bin inventory plus filled option delta. Prices crossing several bins produce inventory jumps.',
      'Common capital includes LP, options premium allowance, venue collateral and reserves for every strategy; no yield assumed on idle cash.',
      'Margin flag uses illustrative 20% notional requirement, not exchange liquidation reconstruction. No automatic liquidation is modeled.',
      `Hedge proposal ${fit.feasible ? 'meets declared fit constraints' : 'has infeasible constraints; comparisons use candidate basket and must not be treated as executable'}.`,
      'No IL subtraction, theta subtraction or duplicate premium expense occurs in P&L. Perp P&L follows the simulated path.'] };
}
