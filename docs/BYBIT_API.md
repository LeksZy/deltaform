# Bybit V5 options adapter

Bybit is Deltaform's active options venue. The adapter in `src/venues/bybit.ts` discovers contracts for the selected economic underlying, normalizes their units, validates the account boundary, and prepares explicit long-option purchases. The eight-asset catalog does not guarantee a complete live strategy for every asset; see [venue support](MULTI_ASSET_VENUES.md).

## Market data and units

Discovery joins V5 instrument metadata and tickers by exact symbol. It checks underlying, strike, option type, expiry, USDT quote/settlement, quantity increments, minimum size and price tick. Metadata is fetched again before execution. Missing Greeks remain unavailable; a mark without positive executable ask depth is not a quote. Preflight checks up to 25 ask levels within the reviewed limit.

Normalized quantity is in the stated underlying, with multiplier 1. Premium and settlement are USDT. Delta is in underlying units; gamma is underlying units per dollar move; vega is dollars per IV percentage point; theta is dollars per calendar day. LP model sensitivities and current option Greeks retain their separate valuation conventions.

A public mainnet probe on 27 September 2026 at approximately 19:31 UTC observed 364 SOL USDT contracts, 353 with best-ask quotes, a 1 SOL minimum quantity and a 0.01 USDT price tick. These are dated observations, not current liquidity guarantees. Sources: [instruments](https://bybit-exchange.github.io/docs/v5/market/instrument), [tickers](https://bybit-exchange.github.io/docs/v5/market/tickers), [orderbook](https://bybit-exchange.github.io/docs/v5/market/orderbook), and [Greek conventions](https://www.bybit.com/en/help-center/article/Option-Greeks).

## Authentication and account boundary

The implementation supports system-generated HMAC keys on the global mainnet and testnet endpoints. Credentials belong in the server environment. GET signatures bind the exact encoded query; POST signatures bind the exact JSON body, timestamp and five-second receive window. RSA keys, regional endpoints and demo-trading accounts are outside this adapter's scope. Source: [V5 integration guide](https://bybit-exchange.github.io/docs/v5/guide).

Account validation requires Unified Trading Account 2.0 in cross or portfolio margin. Purchases require read/write OptionsTrade permission with withdrawals disabled. Other exchange grants remain exchange permissions; application spending limits do not narrow them.

The adapter includes supported option holdings across underlying groups, including existing shorts, and stablecoin wallet cash once. It rejects unmapped derivative exposure, unrelated open orders, borrowing/debt and accrued interest. Discovery mode can display extra nonstable assets separately, while strategy execution remains blocked. Wallet cash is counted separately from option marks to avoid double counting equity; purchases also require prefunded USDT and adequate venue-local margin.

Only authenticated `GET /v5/account/info` may omit the usual top-level response time. The parser then records local request-start time as `local-request-start`, also exposed through `accountInfoTimestampSource`. It does not use the configuration's `updatedTime` as snapshot freshness. A malformed supplied time fails. Market quotes, balances and order acknowledgments still require valid venue timestamps. Source: [account information](https://bybit-exchange.github.io/docs/v5/account/account-info).

## Fees, basis and reviewed orders

Public fitting estimates the published non-VIP taker fee as `min(0.0003 * index, 0.07 * premium) * underlyingQuantity`. Execution preparation checks the selected underlying's authenticated fee rate. The displayed fee reserve is an application estimate, not an exchange-enforced fee cap. Delivery charges are disclosed through instrument metadata and excluded from gross terminal payoff plots. Sources: [option fees](https://www.bybit.com/en/help-center/article/Bybit-Option-Fees-Explained) and [fee-rate API](https://bybit-exchange.github.io/docs/v5/account/fee-rate).

Combined accounting assumes approximate USDT/USDC/USD parity. A fresh USDCUSDT spot BBO constrains stablecoin basis; absent, stale or excessive basis blocks execution. This check does not eliminate future depegging, wrapper basis or differences between settlement indices.

`server/bybit-options.ts` persists the reviewed basket, fixed prices, quantities, account/network binding and credential fingerprint before submission. Each leg uses a unique persistent `orderLinkId` and a `Buy` / `Limit` / `IOC` order. Prices never follow a rising ask automatically. Preflight rechecks identity, permissions, holdings, expiry, depth, fees, basis and funds immediately before submission. Source: [create order](https://bybit-exchange.github.io/docs/v5/order/create-order).

An acknowledgment is not a fill. Partial, rejected or unresolved legs stop the remaining basket. Recovery queries the same persistent identifier through realtime orders and history, then reconciles actual holdings. An absent record remains unknown and does not authorize a replacement order. Baskets and venues are not atomic; option purchases and rolls are always explicit. Sources: [realtime orders](https://bybit-exchange.github.io/docs/v5/order/open-order), [order history](https://bybit-exchange.github.io/docs/v5/order/order-list), and [error codes](https://bybit-exchange.github.io/docs/v5/error).

## Evidence boundary

Adapter tests use synthetic account responses, independent HMAC vectors and mocked orders. They cover normalization, account exclusions, timestamp behavior, limits, partial fills, account changes and ambiguous recovery. Historical development checks include public-market probes and authenticated read-only schema/discovery checks; successful live purchases and complete exchange fill/fee reconciliation remain unverified. See [verification scope](VERIFICATION.md) and [current validation](VALIDATION.md).
