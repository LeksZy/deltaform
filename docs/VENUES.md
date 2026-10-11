# Active venue integration contract

Deltaform combines Meteora DLMM positions, Bybit V5 options and matching Hyperliquid native perpetuals. Bybit is the active options adapter. Derive source and tests remain historical compatibility material; Derive is not an alternate active execution route. Venue migration neither transfers funds nor closes existing positions.

## Per-asset support gates

The catalog and synthetic demo cover BTC, ETH, SOL, XAUT, HYPE, XRP, MNT and DOGE. Live use requires an exact verified Solana token mapping, canonical USDC/USDT quote asset, usable Bybit options, a matching native Hyperliquid perpetual for automatic hedging, fresh data, acceptable basis and supported account exposure.

The configured registry includes native wrapped SOL, cbBTC/Portal WBTC, Portal ETH, XAUt0 and one verified Sunrise/Wormhole NTT HYPE mint. Wrappers retain bridge, custody, redemption and price-basis risk. XRP/MNT/DOGE imports with unverified Solana representations remain watch-only. The 30 September 2026 probe found no matching native XAUT perpetual; the application does not substitute another gold market. A display symbol alone cannot establish identity. See the dated [support matrix and primary sources](MULTI_ASSET_VENUES.md).

## Meteora inventory and benchmark

The official SDK reads owned bins, token decimals and accrued fees. Pool orientation is normalized, while actual bin IDs and ownership quantities are retained. Volatile/volatile pairs require a joint model and are unsupported here. Unknown tokens paired with an accepted stablecoin can be inspected without authorizing a hedge mapping.

Current inventory is used for accounting and execution delta. Original benchmark bins remain fixed for terminal IL attribution until an explicit rebase. Deposits, withdrawals or allocation changes require benchmark review; ordinary fee-free bin conversion does not reset historical IL. The future-value LP model, terminal bin payoff and observed inventory mark are distinct. See [mathematics](MATH.md).

## Bybit options and account scope

The V5 adapter discovers the selected underlying's actual instruments, USDT settlement, expiry, lots, ticks, executable asks and Greeks. Long incremental purchases may reuse existing holdings in the fit; all supported filled exposure contributes to risk. Missing or stale values remain unavailable.

Server-side HMAC configuration is separate from wallet ownership. Account validation requires Unified Trading Account 2.0 in cross or portfolio margin. OptionsTrade permission, withdrawals disabled, prefunded USDT and adequate local margin are required for purchases. Other derivatives, unrelated orders, debt and unsupported assets block strategy execution; discovery can display extra assets separately. Stablecoin wallet cash and option marks are counted once. See [Bybit API behavior](BYBIT_API.md).

The server persists an exact reviewed basket and submits bounded `Buy` / `Limit` / `IOC` orders. Every leg is rechecked before submission. Acknowledgments, fills and account reconciliation are separate states. Partial or ambiguous execution stops subsequent legs and uses the existing client identifiers for recovery. There is no atomic basket, automatic cap widening, automatic option purchase or expiry roll.

## Hyperliquid hedge and shared collateral

Each asset has its own actual inventory delta, filled-option delta, target, price anchor and persistent order intent. The worker hedges absolute current delta in dollar-neutral mode, or preserves the original base-token benchmark in HODL mode. Initial enable, portfolio changes, large residual delta and configured price moves can trigger reconciliation. Anchors advance only after confirmed completion within tolerance.

Wallet ownership and trading authorization are separate. The owner explicitly approves a separate server agent; its generated key is encrypted locally. The owner wallet's private key stays in the wallet. Orders use bounded execution and durable client identifiers; ambiguous results reconcile before another order.

Collateral is shared at account level. Unified Account uses canonical shared USDC rather than adding legacy perp equity again; standard modes use their separate perp equity. Other asset books reserve their current, desired and pending margin before a new hedge. Unsupported DEX exposure, isolated margin, unmanaged orders, non-USDC collateral and unsupported account modes block execution. Account snapshots are not atomic across endpoints.

Stale feeds, invalid authorization, unsafe margin or excessive basis suspend new automatic orders. Pause leaves existing positions open. Cancellation and the separate bounded reduce-only close action require their own reconciliation. No automatic liquidation or collateral transfer is performed. See [order recovery](order-recovery.md).

## Accounting, deployment and evidence

Cash Greeks are scenario sensitivities expressed in a common approximate stablecoin numeraire; raw deltas and gammas are never added across assets. Shared Bybit cash and Hyperliquid equity are counted once. Current P&L uses a recorded opening boundary and external-flow ledger; incomplete history is not presented as a historical equity curve.

Public markets are polled by the persistent local backend, including while trading is paused. Polling latency, fees, funding, wrapper basis, differing indices and non-atomic fills remain material risks. The app is a single-user local service; internet hosting requires a separate authentication and secret-management design.

Paper demonstrations and mocked execution tests do not certify live trading. Public probes are dated observations. No full eight-asset live-support or production-readiness claim is made. See [verification scope](VERIFICATION.md), [current validation](VALIDATION.md), [simulation assumptions](SIMULATION.md) and [dependency findings](DEPENDENCIES.md).
