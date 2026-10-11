# DLMM impermanent loss and listed-option replication

## Scope, source and conventions

The mathematical reference is Deng, Zong and Wang, [*Static Replication of Impermanent Loss for Concentrated Liquidity Provision in Decentralised Markets*](https://arxiv.org/abs/2205.12043), arXiv:2205.12043v2, March 2023. The reference studies concentrated constant-product liquidity and static replication with European options. Its replication principle provides background; its continuous-liquidity treatment is **not** the discrete DLMM bin weight. The project's DLMM result below is derived directly from constant-sum conservation.

Official implementation sources include [Meteora formulas](https://docs.meteora.ag/core-products/dlmm/formulas), the [DLMM SDK](https://github.com/MeteoraAg/dlmm-sdk), [Bybit V5 instruments](https://bybit-exchange.github.io/docs/v5/market/instrument), and [Hyperliquid documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/). Read these alongside the dated [multi-asset venue contract](MULTI_ASSET_VENUES.md) and [Bybit adapter details](BYBIT_API.md). The calculations here deliberately do not assert current liquidity in any listed market.

The worked example uses SOL/USDC. Let X be SOL, Y be USDC, and S be USDC per SOL. The same bin formulas apply to a supported economic underlying paired with a canonical stablecoin. Quantities are human token units; values and errors use the quote currency. Cross-venue dollar comparisons use the explicit stablecoin-parity approximation described below. A snapshot fixes the user's redeemable share of every bin, after applying on-chain ownership shares. Pool liquidity-share integers are not token quantities or a USD notional. A common option maturity T defines a terminal payoff comparison.

The adapter retains SDK integer quantities until conversion through decimal arithmetic. The numerical optimizer and chart surface use JavaScript doubles; their explicit boundary is a normalized `Bin {id, price, x, y}`. This avoids treating raw lamports as human units, but does not claim that floating point is suitable for constructing on-chain transactions. Adapter order rounding uses instrument lot increments and limits.

For on-chain token X/Y decimals dX,dY and raw bin price pRaw measured in Y atoms per X atom:

```
pHuman = pRaw * 10^(dX-dY)
pRaw(binId) = (1 + binStep/10000)^binId
```

For a reversed USDC/SOL pool, invert the human price and swap the human token balances. Preserve the actual bin ID; do not infer a ladder from an approximate UI midpoint. `normalizeAtomicBin` and `binPrice` implement these conversion boundaries. The Meteora adapter obtains actual bins and token decimals from the SDK.

## Single-bin derivation

For the user-owned inventory `(x_i,y_i)` in a fixed bin with exchange price `p_i`, define its economic constant-sum value:

```
ell_i = p_i*x_i + y_i.
```

Assume fee-free swaps, fixed LP shares and bins, no repositioning or new flows, a common external terminal price S, and sufficient arbitrage to exhaust a mispriced bin. At S < p_i, traders sell the base asset into that bin; the final user-owned inventory is `(ell_i/p_i,0)`. At S > p_i, traders buy the base asset; it is `(0,ell_i)`. At S = p_i, any composition satisfying `p_i*x+y=ell_i` has the same value. Thus terminal inventory is not unique at the kink, but terminal value is unique:

```
V_i(S) = ell_i * min(S/p_i,1).
```

The frozen outside-pool holding is `x_i*S+y_i`. Its loss relative to the LP is:

```
H_i(S) = x_i*S+y_i-V_i(S)
       = x_i*(S-p_i)^+ + (y_i/p_i)*(p_i-S)^+.
```

Proof by cases:

* If `S < p_i`, subtract `(x_i+y_i/p_i)*S` from `x_i*S+y_i`; the result is `(y_i/p_i)*(p_i-S)`.
* If `S > p_i`, subtract `p_i*x_i+y_i`; the result is `x_i*(S-p_i)`.
* At `S=p_i`, both expressions are zero, including mixed inventory.

Therefore buy `x_i` base units of a call at `p_i` and `y_i/p_i` base units of a put at `p_i`. Calls and puts are required simultaneously for a mixed active bin. This corrects any one-sided shorthand that silently omits the active bin's other token.

The LP itself can be represented as either:

```
V_i(S) = x_i*S+y_i - x_i*C_i(S) - (y_i/p_i)*P_i(S)
       = (ell_i/p_i)*S - (ell_i/p_i)*C_i(S)
       = ell_i - (ell_i/p_i)*P_i(S).
```

Here `C_i(S)=(S-p_i)^+` and `P_i(S)=(p_i-S)^+` are unit *terminal payoffs*, not current option premiums. The last two expressions follow put-call payoff parity. They have different spot/cash decompositions but identical terminal value.

## Aggregation, benchmark and sign

For an unchanged original lot:

```
X0 = sum_i x_i; Y0 = sum_i y_i
V_hold(S) = X0*S+Y0
V_LP(S) = sum_i V_i(S)
IL(S) = V_LP(S)-V_hold(S)
H(S) = -IL(S) = sum_i H_i(S).
```

Under these assumptions `H>=0` and signed `IL<=0`. This is a dollar loss, not a percentage. When needed, a percentage must specify its denominator: original capital or the terminal HODL value are different conventions.

`benchmarkBins`, `benchmarkX` and `benchmarkY` retain the original snapshot. Current `bins` may refresh independently for accounting and delta hedging. `lpValue`, `hedgePayoff` and `decompose` use original `benchmarkBins ?? bins`; `currentInventory` always uses actual current bins. The app provides an explicit rebase action. Refreshing the spot price must not silently reset historical IL to zero.

If a persisted benchmark differs from the frozen original bins, the exact difference includes:

```
H(S) = sum_i H_i(S) + (benchmarkX-sum x_i)*S + (benchmarkY-sum y_i).
```

`decompose` exposes `affineSpot` and `affineCash`, and flags the mismatch. A long-only vanilla portfolio may not represent that affine component. In particular a negative target payoff should not be relabeled “positive protection.” Deposits, withdrawals and repositioning need separate benchmark lots and cash-flow attribution; unexplained ownership/bin changes invalidate the original fixed-position projection until reconciled.

Fees and rewards are excluded from terminal IL. Base-token fees contribute delta if included in the current account boundary. Quote-token fees do not. Do not subtract the IL difference again from a P&L calculation already using actual LP inventory value.

## Worked mixed-bin example

| Bin price | Initial SOL | Initial USDC | Long hedge |
|---:|---:|---:|---|
| 180 | 0 | 360 | 2 puts at 180 |
| 200 | 1 | 200 | 1 call + 1 put at 200 |
| 220 | 2 | 0 | 2 calls at 220 |

The original holding is `3*S+560`. The bin economic values are 360, 400 and 440 USDC.

| Terminal SOL price | HODL value | Fee-free LP value | Signed IL | Hedge payoff |
|---:|---:|---:|---:|---:|
| 100 | 860 | 600 | -260 | 260 |
| 180 | 1100 | 1080 | -20 | 20 |
| 200 | 1160 | 1160 | 0 | 0 |
| 210 | 1190 | 1180 | -10 | 10 |
| 220 | 1220 | 1200 | -20 | 20 |
| 300 | 1460 | 1200 | -260 | 260 |

`mixedBinExample()` is the deterministic executable fixture. The independent tests compute terminal token balances directly, rather than deriving expected values through the decomposition under test.

`annotatedNarrowRangeFixture()` is a synthetic normalized one-basis-point ladder with equal `2000/69` quote value per bin and a mixed midpoint. It is an illustrative study fixture, not a reconstruction of an account. The main SOL demo uses 69 actual-formula geometric bins at 50 basis points around 200 USDC to make the payoff shape legible; it is separately labeled synthetic.

## Three distinct Greeks conventions

1. **Current inventory accounting.** `V_current = X_actual*S + Y_actual`. Instantaneous marked-inventory delta is `X_actual`, plus included base fees. Direct accounting gamma, vega and theta are zero while that inventory is frozen. Trading through a bin changes inventory; the worker reconciles after observed inventory/price changes.
2. **Idealized terminal scenario.** Away from bin strikes, `dV_LP/dS = sum_{p_i>S} ell_i/p_i`. At each bin, the slope drops by `ell_i/p_i`. In distributional notation:

   `V_LP'' = -sum_i (ell_i/p_i)*Dirac(p_i)` and `H'' = +sum_i (ell_i/p_i)*Dirac(p_i)`.

   The application's exact terminal curvature is represented by strike weights. There is no exact ordinary finite gamma at a kink. A finite-difference bump spanning bins would be a scenario statistic whose result depends on bump width.
3. **Future-payoff model.** `modelLp` applies a zero-interest Black–Scholes lognormal expectation to the static terminal representation at a specified horizon and IV. Its smooth Greeks describe that model, not instantaneous observed inventory. Its model gamma and vega are negative and model theta typically positive at zero rates. They may be combined with smooth option Greeks only as a labeled model sensitivity using compatible horizons and IV conventions.

`blackScholes` reports delta in base units per unit option, gamma in base units per USDC move, vega in USDC per **one IV percentage point**, theta in USDC per **calendar day** (365.25 days/year). `modelOption` multiplies price and Greeks by the contract multiplier. `OptionInstrument.greeks` is normalized per underlying unit; quantities and multipliers are applied when aggregating it. The UI must never multiply `modelOption` a second time by the multiplier.

The current option chain can supply live Greeks; missing/stale Greeks must be visible and cannot silently authorize automated trading from a stale model. The scenario model's flat 75% IV default is explicit, editable, and not a volatility forecast. A zero-time payoff has a conventional one-sided delta away from strike; settled account positions must be removed/replaced with actual settlement cash, rather than re-marked against later prices.

## Listed-strike fit and executable cost

Only matching-underlying, selected-expiry, fresh instruments with valid lot metadata and displayed ask depth enter the fit. Existing positions of that expiry contribute signed payoff before incremental purchases are optimized. Existing longs reduce required incremental purchases. Existing shorts increase account risk even though new quantities are constrained nonnegative. Other-expiry options remain in account Greeks but do not count as same-horizon terminal coverage.

For option contract multiplier m, a theoretical base-unit weight w corresponds to `w/m` contracts. Bid/ask premiums in the normalized schema are quote-stablecoin amounts per underlying unit; active Bybit contracts use USDT. Under the stated parity approximation, `quantity * m * premium` is the comparable dollar-equivalent cost. A filled option's terminal payoff is `quantity * m * intrinsic`. Depth is swept in ascending ask price. Unavailable depth, a stale quote or a model price never becomes an executable quote.

The finite grid includes S=0, every original bin strike, every relevant listed strike, current price, and a dense grid reaching twice the highest strike/current price. Payoffs are piecewise linear, so the maximum absolute or one-sided error on that finite interval occurs at a joint breakpoint. The two reported tail slope errors supplement finite-interval error; negative residual upper-tail slope means unbounded undercoverage as S grows, even if finite-grid errors appear small.

Primary payoff optimization minimizes approximately:

```
mean((basketPayoff-targetPayoff)^2 / maxTargetPayoff^2)
+ 0.001 * executableIncrementalCost / currentHODLValue.
```

The code warm-starts by interpolating same-type neighboring strikes, then uses nonnegative continuous coordinate descent, reduces the active set to the configured leg count, applies depth and budget scaling, rounds down to legal lots/minimum orders, and performs legal-lot discrete improvement. This is a transparent heuristic for the mixed-integer problem, **not a certificate of global optimality**. Rounded, executable results are re-evaluated for cost, errors, undercoverage and tails. A requested maximum undercoverage can make the result infeasible. The fit's `feasible` flag means its declared constraints pass, not that replication is exact or economically attractive. Even available exact-strike replication may be traded against the small premium penalty in payoff mode.

Reported `weightedError` is a spot-centered log-price weighted RMS in USDC; `maxError` and `maxUndercoverage` are dollar amounts. Coverage is a fraction of full H. Error diagnostics use this fraction, while the residual IL chart continues to show `basketPayoff-fullH` so unprotected exposure remains visible.

The conservative mode moves each required call to a listed strike no higher than its bin strike and each required put to a strike no lower, then rounds contract quantities up. These strike moves dominate the original option payoff. Existing same-instrument positions offset the planned quantity. If the nearest-strike basket violates constraints, the solver also checks wider consolidated call/put baskets that can satisfy a tighter leg limit. The final combined basket must still dominate at every joint kink, S=0 and in the upper-tail slope; short existing options, missing depth, budget and leg constraints can defeat this check. A feasible conservative basket can also replace a payoff approximation that misses an explicit hard undercoverage bound; the result identifies this fallback. Failure returns a candidate with explicit reasons. It does not claim that no alternative global superhedge exists.

Execution quotes include available asks and a venue fee model. Bybit's public non-VIP options taker estimate is `min(0.0003 * index * underlyingQuantity, 0.07 * premium)` with no per-order fixed fee. The authenticated account fee rate is checked before execution. Fixture fees remain explicitly synthetic. The shared model also retains historical Derive fixed-fee calculations for archived tests, but Derive is no longer an active venue. Indicative quotes expire after at most 15 seconds; a protected purchase review can hold the same price limits for two minutes while fresh prices, fees, cash and depth are rechecked. Bybit enforces the IOC limit price, while the application's fee reserve is not a venue-enforced fee cap. Delivery/exercise fees are excluded from the plotted gross terminal option payoff and must be allowed for separately.

Supported Bybit contracts use the quote, settlement and multiplier returned by venue discovery; the active adapter accepts USDT quote and settlement. Payoff fitting across USDC/USDT pools and combined dollar valuation use the explicit approximation `1 USDT = 1 USDC = 1 USD`. A live USDC/USDT spot feed monitors current basis and suspends execution above configured bounds. This filter does not remove future stablecoin basis or differences between a wrapped token and an option settlement index. Even a mathematically dominant listed-strike basket is a superhedge only inside the stated common-price/parity model, not exact cross-currency protection.

## Limits of static protection

The bin identity does not price earned fees, rewards, funding, execution slippage, rounding or transfer fees. Dynamic swap fees create an arbitrage band; delayed arbitrage leaves bins incompletely converted; integer rounding and transfer-tax tokens change exact realized balances. LP share changes, auto-recentering, withdrawals and new deposits require separate lots/flows. Different indices, wrapped-asset basis, stablecoin depegging, expiry settlement conventions and venue failures can break common-price assumptions. Volatile/volatile pairs and unverified proxy hedges are unsupported. A verified wrapper mapping still carries basis and redemption risk.

At the current external price, the ideal terminal LP value can already be below the raw inventory mark if the pool has not arbitraged to that price. It must not be used as the observed accounting balance. No assumption of cross-venue atomic execution or automatic collateral transfer appears in this mathematics.

Purchasing H restores the original terminal HODL payoff, before premium and other costs. It does not make that portfolio dollar-neutral. The separate Hyperliquid worker hedges the absolute current delta for each underlying, or preserves its original HODL delta when that mode is explicitly selected. Dynamically traded perpetual P&L is path dependent and cannot be represented as a unique endpoint-only payoff curve.

## Current gamma-neutral fitting

The `gamma` objective targets current net gamma. The dashboard and optimizer share `resolveLpModel`: selected LP horizon, fresh nearest-ATM IV at that horizon or an explicit manual IV, identical zero-rate lognormal valuation, and current owned bins rather than historical benchmark inventory. Historical benchmarks continue to govern IL payoff attribution.

Let `G_LP` be this current LP model gamma, `G_existing` the sum of signed filled contract quantities × verified multiplier × fresh venue gamma across **all held expiries**, and `c` the coverage fraction. The target is `(1-c)*G_LP`, so at 100% coverage the requested net gamma is zero. New options at the selected purchase expiry contribute `sum(q_j*m_j*gamma_j)`. A basket satisfies the target only when the absolute difference between resulting net gamma and target is within the user-configured tolerance. New dashboard defaults convert a $1 quadratic P&L tolerance for a 1% price move into raw gamma via `2 / (0.01*S)^2`; explicitly saved raw tolerances remain unchanged. Linear perpetual gamma is zero. Expired or missing held-option gamma requires reconciliation; missing market IV has no 75% fallback.

A bounded discrete beam search buys only legal long lots within executable ask depth, cost including estimated fees, premium budget and maximum legs. It prioritizes reaching the tolerance, then cost. It examines near-residual lot sizes, minimum lots and affordable sizes, retaining both low-cost and low-error partial baskets. It is a heuristic: failure means no qualifying basket was found, not mathematical proof that no basket exists. A failed target is marked infeasible and cannot be purchased through the cover action. Already-neutral exposure needs no purchase; excessive positive gamma cannot be removed by buying more positive-gamma options.

The quote records LP/filled/proposed/net gamma, target, tolerance, model IV, horizon and source. The exact reviewed basket is re-evaluated against current in-memory market and reconciled holdings before preparation and submission; moved or stale Greeks require a new quote. Quote-time gamma neutrality is local and temporary. It does not match the terminal IL payoff, promise neutrality after price/time/IV changes, or authorize automatic option rebalancing. All-or-nothing cross-leg fills are not guaranteed. Distant cheap options can satisfy local gamma while adding substantial tail exposure, delta or decay; terminal residual metrics and per-leg Greeks remain visible for review.

## Multiple underlyings and cash scenarios

Each asset book has one canonical economic underlying from BTC, ETH, SOL, XAUT, HYPE, XRP, MNT and DOGE. Multiple pools for that underlying can enter one decomposition after exact mint/orientation/decimal normalization. USDC and USDT quantities share the explicit parity numeraire. This mathematical support list does not assert live liquidity or that every named token is a verified representation of the asset. Venue mapping and basis checks determine executable support separately.

Decomposition and fitting reject a collection containing different underlyings. Option candidates, held-option payoff, gamma and ATM-IV calibration are filtered by the selected economic underlying. Other-asset holdings remain in their own risk books. Proposed terminal-payoff legs must match both underlying and expiry. The eight-asset fixtures use deterministic geometric bins, mixed active inventory and synthetic quotes; fixture prices and contract lots are study inputs rather than exchange specifications.

Raw asset delta and gamma are never summed across assets. Let `S_a` be an asset's USD-equivalent price, `d_a` its model delta and `g_a` its model gamma. For a joint scenario with fractional price shock `r_a`, IV change `v_a` in percentage points and elapsed calendar days `t`, the local additive estimate is:

```
price contribution_a = d_a * S_a * r_a + 0.5 * g_a * (S_a * r_a)^2
IV contribution_a    = vega_a * v_a
time contribution_a  = theta_a * t
portfolio change     = sum_a(price contribution_a + IV contribution_a + time contribution_a)
```

The UI's gamma cash value is the quadratic contribution for a 1% move: `0.5 * g_a * (0.01*S_a)^2`. Vega and theta are already cash amounts per IV percentage point and per calendar day, and are summed after applying option contract quantities and multipliers exactly once. A common 1% shock is a declared scenario; a zero summed cash delta does not eliminate asset-specific exposures. Each perpetual hedge continues to use its own actual LP inventory delta plus filled-option delta, with an independent anchor.

The joint price estimate pairs model delta with model gamma. Current inventory execution delta is shown separately: substituting execution delta into the first-order term while retaining model gamma would mix different valuation functions. The estimate includes no cross-gamma, empirical correlation model, wrapper/settlement basis shock, transaction cost, funding or future rehedging path. Unknown sensitivities propagate as unavailable; stale observations remain flagged. Duplicate underlying entries are rejected by the pure cash-scenario aggregator.

`currentInventory(..., includeFees=true)` includes uncollected base and quote fees in the displayed LP mark, and includes base-token fees in execution delta. The separate fees column is a subset of that LP value. It must not be added a second time to equity. Collected fees belong to their destination account/cash flow and cannot also remain in uncollected balances. Shared Bybit cash and Hyperliquid equity are counted once at account level; an underlying row does not receive a fabricated share of cash, collateral or account P&L.

Capital tracking hashes all selected LP identities across the asset books and shared account/network identities. Switching the displayed underlying leaves that boundary unchanged. Migration preserves the exact legacy single-SOL hash. Capturing an opening baseline requires fresh live observations for every book with selected LP, filled options or perpetual exposure and no pending hedge in any book. Empty unselected books do not make an otherwise complete account baseline stale.
