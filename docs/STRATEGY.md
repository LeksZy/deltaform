# Deltaform strategy

Deltaform studies whether Meteora DLMM fee income can justify the cost of option protection and perpetual hedging. The project connects a bin-level mathematical model to constrained Bybit option proposals, an independent Hyperliquid delta worker, and a dashboard for inspecting risk and accounting.

The research question is open. A mathematically correct terminal payoff identity, a feasible quote, and a functioning paper hedge do not establish profitable live performance.

## Three different hedge objectives

| Objective | Exposure used | What the implementation targets | Practical limit |
|---|---|---|---|
| Terminal IL protection | Frozen original LP bins and holding benchmark | Listed-option payoff at one selected expiry approximates the LP's loss relative to holding the original tokens | Sparse strikes, lots, depth, premiums, settlement basis and expiry affect protection |
| Current gamma targeting | Current owned LP bins in a specified horizon/IV model, plus filled option Greeks | Net gamma at quote time approaches the configured target within tolerance | A local sensitivity changes with price, time, inventory and IV |
| Perpetual delta hedging | Actual current LP base inventory and included base fees, plus filled option delta | Total current delta approaches zero, or the explicitly selected original HODL delta | Polling, price gaps, execution latency, lots, limits and venue collateral leave residual exposure |

These objectives answer different questions. Buying the ideal terminal IL hedge restores the original token holding payoff before costs. That holding still has directional exposure. Conversely, a basket that offsets current model gamma can have a poor terminal IL fit. Perpetuals have zero gamma in the linear price model and their trading P&L depends on the path.

## Fixed-bin terminal IL

For one original bin, let `p_i` be its exchange price, `x_i` the user's base-token quantity and `y_i` the quote-token quantity. Prices and balances are normalized to human token units, including the pool's orientation and token decimals.

Under fee-free swaps, fixed ownership and bins, no new flows or repositioning, a common external price `S`, and sufficient arbitrage:

```text
ell_i = p_i * x_i + y_i
V_i(S) = ell_i * min(S / p_i, 1)

H_i(S) = x_i * S + y_i - V_i(S)
       = x_i * max(S - p_i, 0)
       + (y_i / p_i) * max(p_i - S, 0)
```

The ideal loss hedge therefore buys `x_i` underlying units of calls and `y_i / p_i` underlying units of puts at the bin price. A mixed bin needs both. These are terminal option payoffs; they are not the option's current premium or exchange contract count.

For the unchanged original lot:

```text
V_hold(S) = X0 * S + Y0
V_LP(S) = sum_i V_i(S)
signed IL(S) = V_LP(S) - V_hold(S)
H(S) = -signed IL(S) = sum_i H_i(S)
```

This is a quote-currency loss against the original holding benchmark, before fees and hedge costs. It does not measure total account P&L.

The implementation preserves `benchmarkBins`, `benchmarkX` and `benchmarkY` while current bins refresh. A spot-price refresh does not reset the original loss. If benchmark quantities differ from the frozen bins, the target also has an affine correction:

```text
H(S) = sum_i H_i(S)
     + (benchmarkX - sum_i x_i) * S
     + (benchmarkY - sum_i y_i)
```

Long vanilla options alone may not reproduce this correction. Deposits, withdrawals, ownership changes and repositioning need reconciled benchmarks and cash-flow attribution. The app exposes an explicit rebase rather than silently redefining the original position.

The [short math note](MATH_NOTE.md) summarizes the option hedge and Greeks. The full derivation, mixed-bin example and conventions are in [MATH.md](MATH.md). The executable identity and normalization live in [math.ts](../src/quant/math.ts), with independently calculated terminal balances in [quant.math.test.ts](../tests/quant.math.test.ts).

## From theoretical weights to an executable proposal

The fitter handles one economic underlying at a time. Candidate purchases must match the selected underlying and expiry, have fresh quotes, valid multiplier and lot metadata, and available ask depth. New quantities are long-only. Existing signed same-expiry holdings enter the terminal payoff target; other expiries remain in account risk.

It sweeps displayed ask levels and includes estimated trading fees in the purchase budget. A base-unit weight is converted to contracts using the instrument multiplier. Minimum quantities, lot increments, depth, premium budget and maximum legs constrain the final basket.

The payoff objective uses a squared payoff-error objective with a small premium penalty, then applies executable constraints, lot rounding and discrete improvement. It reports weighted error, maximum error, undercoverage and tail slope errors. A small error on the finite plot cannot hide an upper-tail shortfall that grows without bound.

The conservative objective moves calls to lower listed strikes and puts to higher listed strikes, rounds upward, and checks payoff dominance at joint breakpoints and in the upper tail. Available depth, budget, existing shorts or the leg limit can prevent a qualifying basket. The algorithms are heuristics; a failed search does not prove that every possible basket is infeasible.

`feasible` means the declared checks pass. It does not mean exact replication, a guaranteed fill, or attractive economics. Quote review and account revalidation precede submission. Each option leg is a separate order, so partial fills can leave a different portfolio from the reviewed proposal.

See [fit.ts](../src/quant/fit.ts), [quant.fit.test.ts](../tests/quant.fit.test.ts) and [Bybit adapter details](BYBIT_API.md).

## Current gamma targeting

The current gamma objective uses the same LP horizon and IV resolution as the dashboard. It values **current owned bins**, rather than the historical benchmark, through a zero-rate lognormal terminal-value model. IV comes from a fresh nearest-ATM quote at that horizon or an explicit manual setting. Missing market IV cannot silently become the scenario simulator's default IV.

With coverage fraction `c`:

```text
G_before = G_LP_model + G_filled_options
G_target = (1 - c) * G_LP_model
G_after = G_before + sum_j quantity_j * multiplier_j * venue_gamma_j

qualifying basket: abs(G_after - G_target) <= configured tolerance
```

At 100% coverage, the requested net gamma is zero. Signed filled option holdings at all expiries for that underlying contribute to current gamma; only the selected purchase expiry supplies new candidates. A bounded discrete search prioritizes the tolerance and then executable cost within legal lots, depth, budget and leg limits. Long-only purchases cannot remove already excessive positive gamma.

The exact reviewed basket is checked again before purchase. Gamma is measured in underlying units per dollar-equivalent price move, so raw gamma values from different assets are not added together. The terminal LP payoff has kinks at bin prices; its exact curvature is a set of strike weights rather than this smooth finite gamma.

A successful quote-time gamma fit does not maintain future neutrality, replicate terminal IL, or automatically rebalance options. Its additional delta, decay and terminal residuals still matter. See [gamma.ts](../src/quant/gamma.ts), [risk-model.ts](../src/quant/risk-model.ts) and [gamma-fit.test.ts](../tests/gamma-fit.test.ts).

## Persistent delta hedging

The worker uses current base inventory, included uncollected base fees, filled option delta and the actual perpetual position. Quote-token fees have no base delta. Proposed unfilled options are excluded from actual risk.

```text
non_perp_delta = current_LP_base + included_base_fees + filled_option_delta
desired_perp = target_delta - non_perp_delta

dollar-neutral target_delta = 0
preserve-HODL target_delta = original benchmark base quantity

price trigger: abs(S_now / S_anchor - 1) >= alpha_percent / 100
```

Each underlying has its own anchor and target. Initial enable, portfolio changes and large delta deviations can also trigger reconciliation. Deadbands, legal lot sizes, maximum orders and exposures, freshness, basis, authorization and venue-local collateral checks constrain trading.

The backend persists order intents and reconciles outcomes before creating further orders. The anchor advances after confirmed completion within tolerance, including a valid no-order completion. Partial fills and unresolved outcomes retain it. A restart recovers stored intentions; it does not assume an unknown order failed. Shared Hyperliquid margin is reserved across asset books, while each asset keeps an independent risk target.

Pause stops new automation and leaves exposure in place. A separate close action handles the perpetual position. The worker does not automatically roll options, recenter DLMM liquidity or transfer collateral between venues.

See [policy.ts](../server/policy.ts), [engine.ts](../server/engine.ts), [policy tests](../tests/policy.test.ts) and [execution recovery](order-recovery.md).

## Accounting and research evidence

The dashboard separates observed inventory from smooth model risk and terminal scenarios. It tracks account capital, recorded flows, current P&L attribution and per-asset sensitivities. Shared cash and venue equity are counted once. Accrued LP fees are part of the LP mark; the displayed fees column is not additional equity. Per-asset P&L remains unavailable where shared cash and costs cannot be defensibly allocated.

Account scenarios convert each asset's delta and gamma into cash effects for stated percentage shocks. They do not sum incompatible raw deltas or assume one asset cancels another's execution exposure. Realized volatility is a separately dated historical cache with source and completeness metadata, not a live IV forecast; see [REALIZED_VOLATILITY.md](REALIZED_VOLATILITY.md).

The eight-asset paper demo covers BTC, ETH, SOL, XAUT, HYPE, XRP, MNT and DOGE with deterministic synthetic bins and quotes. It demonstrates the architecture, calculations and workflows. Full live support separately depends on exact token identity, suitable pools and options, a matching native perpetual, basis checks and account compatibility. The demo does not establish eight executable live strategies. The dated evidence is in [MULTI_ASSET_VENUES.md](MULTI_ASSET_VENUES.md).

The path simulator compares LP alone, LP with perps, and LP with options and perps on three deterministic paths. Its fee accrual, funding stress, spread, latency and margin inputs are explicit assumptions. It is not an event-level historical DLMM replay or a backtest. Even an infeasible candidate can appear in its diagnostic comparisons, with that status disclosed. See [SIMULATION.md](SIMULATION.md).

Automated tests exercise independently calculated bin payoffs and Greeks, constrained fitting, current gamma, accounting, policy and recovery using fixtures and mocked execution. Recorded public reads and limited authenticated read-only checks establish only the behavior described in their dated records. Actual authenticated multi-asset order acceptance and fills have not been established by those checks. Existing account positions are not evidence that the project executed those trades.

## What must pay for the hedge

The strategy's economic comparison must account for option premiums, trading and delivery fees, option decay already reflected in marks, perpetual spread and slippage, funding, venue collateral, idle reserves, and any transfer or redemption costs. Funding can be a cost or income. Premiums and IL must not be deducted twice from an inventory-based P&L calculation.

Fixed bins, complete arbitrage and common prices are idealizations. Discrete strikes, changing liquidity, stablecoin parity, wrapped-token/index basis, expiry mismatch, partial fills, outages and venue risk can leave residual losses. Gains on one venue cannot be assumed to fund collateral on another.

Deltaform makes these tradeoffs inspectable. Establishing whether fees cover the full cost and risk of protection requires stronger historical and execution evidence; the focused next steps are in [ROADMAP.md](ROADMAP.md).
