# Short math note: how the hedge works

The options hedge addresses LP payoff curvature; the perpetual separately manages directional exposure. These calculations apply to one underlying at a time.

## 1. Options cover the terminal LP shortfall

For one frozen bin, let $p$ be its exchange price, $x$ its original base-token amount, $y$ its quote-token amount, and $S_T$ the price at option expiry. Under fixed ownership, unchanged bins and fee-free arbitrage:

$$
V_{\mathrm{LP}}(S_T)=(px+y)\min(S_T/p,1),\qquad B(S_T)=xS_T+y.
$$

Writing $(z)^+=\max(z,0)$, the shortfall against holding the original tokens is

$$
H(S_T)=B(S_T)-V_{\mathrm{LP}}(S_T)
=x(S_T-p)^++\frac{y}{p}(p-S_T)^+.
$$

So the ideal hedge buys **$x$ underlying units of calls and $y/p$ underlying units of puts**, both at strike $p$ and expiry $T$. Sum these weights across bins. Convert underlying units to venue contracts using their multipliers.

**Synthetic example:** $p=200$, $x=1$, $y=200$ gives one call plus one put. At $S_T=150$, LP value is 300 and options pay 50, matching HODL's 350. At $S_T=250$, LP value is 400 and options pay 50, matching HODL's 450. Both exclude premiums and fees.

This restores the HODL payoff, **not zero price exposure**: the combined ideal payoff still has delta $X_0=\sum_i x_i$. The executable basket approximates this identity with listed strikes, depth, lots, budget and expiry constraints. Changed benchmarks can also require a cash/spot correction.

## 2. Which Greeks are hedged?

| Greek | Meaning | Role in Deltaform |
| --- | --- | --- |
| Delta $\Delta=\partial V/\partial S$ | Directional price exposure | The perpetual worker targets actual inventory plus filled-option delta |
| Gamma $\Gamma=\partial^2 V/\partial S^2$ | How delta changes with price | Long options offset negative LP model gamma; current gamma mode explicitly targets the residual |
| Vega $\nu=\partial V/\partial\sigma$ | Sensitivity to implied volatility | Long options add positive vega against negative LP model vega; residuals are displayed, without an independent target |
| Theta $\Theta=\partial V/\partial t$ | Value change as calendar time passes | Long-option decay opposes positive LP model theta; residuals are displayed, without an independent target |

These LP sensitivities come from the project's **zero-rate lognormal terminal-value model**, not a derivative of the observed token balance. An exact basket with identical model assumptions, IV and expiry cancels model gamma, vega and theta. Practical baskets need not; model theta is not fee income. Displayed vega is quote value per **one IV percentage point** ($\nu/100$ for decimal IV); theta is quote value per calendar day.

Current gamma fitting uses **current owned bins** at the selected horizon and manual/fresh ATM IV. Signed filled-option gamma includes all expiries. For coverage fraction $c$, it seeks

$$
\left|\Gamma_{\mathrm{LP}}^{\mathrm{model}}+\Gamma_{\mathrm{filled\ options}}
 +\Gamma_{\mathrm{new\ options}}-(1-c)\Gamma_{\mathrm{LP}}^{\mathrm{model}}\right|\leq\varepsilon.
$$

At $c=1$, the target is zero gamma within tolerance **at quote time**. This does not guarantee terminal IL coverage or continuing Greek neutrality.

## 3. The perpetual adjusts actual delta

The desired signed perpetual quantity, in base units, is

$$
h^*=\Delta_{\mathrm{target}}-
\left(X_{\mathrm{current}}+f_{\mathrm{base}}+\Delta_{\mathrm{filled\ options}}\right).
$$

Here $X_{\mathrm{current}}$ is current bin base inventory excluding fees; $f_{\mathrm{base}}$ is included accrued base-token fees. The target is zero in dollar-neutral mode, or original HODL delta in preserve-HODL mode. The worker uses **actual inventory delta**, not smooth LP model delta, and rebalances on price/portfolio/deviation triggers subject to execution limits. A fixed-size linear perpetual adds delta, with zero gamma/vega/theta in this price model; funding remains separate.

Profitability remains open: LP fees must justify premiums, funding, trading/delivery fees, slippage and residual risk. Theta already affects option marks and must not be deducted again as a separate cash charge.

See the [full derivation](MATH.md), [strategy details](STRATEGY.md), and implementations in [math.ts](../src/quant/math.ts), [fit.ts](../src/quant/fit.ts) and [policy.ts](../server/policy.ts).
