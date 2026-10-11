# Scenario simulator

`src/quant/simulation.ts` exposes `scenarioSurface` and `simulateStrategies`. These functions are deterministic analytical scenarios, not a historical performance claim.

## Model surface

`scenarioSurface(positions, holdings, spot, expiry, iv, now)` returns 81 prices from 35% to 165% of spot. At each price it computes the zero-rate lognormal value of the frozen original DLMM terminal portfolio, currently selected options' model value, and their combined smooth model delta/gamma. The IV and valuation date are explicit. The LP model is described in `MATH.md`; this output must be labeled “pre-expiry model,” separately from observed inventory value and terminal payout.

## Path comparison

`simulateStrategies(positions, market, settings)` compares three strategies on three deterministic paths:

* LP only;
* LP with dynamic dollar-neutral perpetual hedging;
* LP with the selected-expiry listed-strike option basket and dynamic perpetual hedging.

The paths are oscillation, a rally leaving the original range, and a downward gap with funding/basis stress. Each includes oscillations to exercise repeated bin crossings. Options are acquired at swept synthetic/live quoted asks plus their fee estimate. Future marks use the snapshot IV; the simulator does not forecast an IV surface. Cash settlement uses the first simulated observation at/after expiry, so settlement has time-step approximation error. Protection is not rolled automatically.

Default numerical assumptions:

| Parameter | Default |
|---|---:|
| Horizon | 30 calendar days |
| Steps | 120 |
| Alpha trigger | 1% from last completed simulated hedge |
| Perpetual spread cost | 4 bps of traded notional |
| Perpetual fee | 3.5 bps of traded notional |
| Fill latency | one simulation step |
| Basis amplitude | 15 bps; multiplied by 8 during gap stress |
| LP fee rate | assumed 20% annualized only while in range |
| Dedicated perp collateral | 50% of original LP capital |
| Idle reserves | 20% of original LP capital |
| Margin flag threshold | illustrative 20% of perp notional |

The supplied market's hourly funding rate is used. The stressed gap path flips funding negative at three times the rate's magnitude. A short perp therefore pays in that stress. The base-case funding rate is not assumed to persist in an actual deployment.

The bin inventory model fully arbitrages each original bin at each observation. Below its strike, a bin holds `ell/p` base; above its strike it holds `ell` quote. A mixed bin exactly at its strike retains its original composition. The hedge target is this actual modeled inventory plus the filled options' delta; it never hedges the relative IL delta. A price gap crossing several bins can produce a large delta jump. The configured latency means a hedge target computed at one step fills at a later price. Lot and minimum notional constraints are applied.

LP fee income is deliberately an explicit assumed annual accrual while the spot remains inside the aggregate range. Candle prices alone cannot identify swaps, active-bin volume, ownership, dynamic fees or adversarial flow. The simulator does not reconstruct those details or claim to predict fee APR. The user should replace this fee assumption with verified event-level replay before treating results as strategy evidence.

## Accounting and output

Every strategy uses the same capital denominator: original LP holding value plus the option premium allowance, venue collateral and idle reserves. Unused cash has zero yield. Output contains path-level final P&L, return on this committed capital, maximum drawdown, execution costs, assumed LP fees, funding, hedge count, maximum illustrative margin, a margin-breach flag, and the full path series.

At every observation:

```
P&L = current modeled LP value - initial HODL value
    + earned LP fees
    + current option value or settlement cash - paid option premium
    + cumulative perp price P&L + net funding
    - option trading fees - perp execution costs.
```

IL is not subtracted again. Theta is not charged again: option value decay already incorporates it. Premium is deducted once; option fees are separate. A fully funded margin flag is computed from local perp collateral and perp P&L/funding, not from hypothetical transfers of gains on other venues. The simulator records a flag instead of pretending to reconstruct exchange liquidation mechanics.

These are illustrative scenarios. Slippage and fees are simplified, orderbook evolution is not simulated, volatility dynamics are held fixed, staking/wrapped-token basis and transfers are unsupported, and the margin threshold is not a live exchange risk engine. End-point P&L can differ substantially across paths even at the same final spot because hedging and funding are path dependent.

## Validation

Quant tests cover independent direct bin balances, pure and mixed bins, an asymmetric hand-calculated three-bin example, 69 geometric bins, decimal/orientation normalization, benchmark retention, an external standard Black–Scholes numerical benchmark, finite-differenced Greeks, executable depth/fees, rounded fitting, existing option reuse, sparse superhedge dominance, infeasible budget/depth/expiry/undercoverage, stale quotes, gamma mode, and a closed-path no-fee LP accounting identity.

The simulator is useful for comparing assumptions and stress behavior. It is not sufficient evidence that the live strategy is profitable, delta-neutral under outages, or protected by an exact listed-option hedge.
