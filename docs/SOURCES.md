# Sources and evidence record

Source access dates and market probes below were recorded during 26–30 September 2026. These are historical observations, not current market checks. Availability, account rules and exchange behavior require fresh verification before live use.

## Mathematical scope

The research reference is Deng, Zong and Wang, *Static Replication of Impermanent Loss for Concentrated Liquidity Provision in Decentralised Markets*, arXiv:2205.12043v2, March 2023. Its static-replication principle concerns concentrated constant-product liquidity. Deltaform's discrete DLMM bin weights are derived directly from constant-sum conservation, with assumptions and independent examples in [MATH.md](MATH.md). The research reference does not establish live profitability or exact executable protection.

## Primary implementation references

| Area | Sources used | Local evidence |
| --- | --- | --- |
| Meteora bin math and ownership | [DLMM formulas](https://docs.meteora.ag/core-products/dlmm/formulas), [SDK reference](https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/reference), [official SDK](https://github.com/MeteoraAg/dlmm-sdk), [Data API](https://docs.meteora.ag/developer-guides/dlmm/api-reference/overview) | `src/venues/meteora.ts`; bin normalization and independent quant tests. |
| Bybit public markets and units | [instruments](https://bybit-exchange.github.io/docs/v5/market/instrument), [tickers](https://bybit-exchange.github.io/docs/v5/market/tickers), [orderbook](https://bybit-exchange.github.io/docs/v5/market/orderbook), [Greeks](https://www.bybit.com/en/help-center/article/Option-Greeks), [option fees](https://www.bybit.com/en/help-center/article/Bybit-Option-Fees-Explained) | `src/venues/bybit.ts`; unit, metadata, depth and fee fixtures. |
| Bybit authentication and recovery | [integration guide](https://bybit-exchange.github.io/docs/v5/guide), [account info](https://bybit-exchange.github.io/docs/v5/account/account-info), [fee rate](https://bybit-exchange.github.io/docs/v5/account/fee-rate), [create order](https://bybit-exchange.github.io/docs/v5/order/create-order) | Independent HMAC vectors; timestamp/account-boundary tests; `server/bybit-options.ts` and mocked recovery tests. |
| Hyperliquid native markets and execution | [info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint), [exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint), [API wallets and nonces](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets), [tick/lot sizes](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size), [SDK source](https://github.com/nktkas/hyperliquid) | Native-market normalization, typed-data fixtures, execution-policy and durable recovery tests. |
| Hyperliquid shared collateral | [account abstraction modes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes), [WebSocket subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions) | `src/venues/hyperliquid-collateral.ts`, bounded all-DEX reads and collateral fixtures. |
| Solana wallet discovery | [Jupiter extension integration](https://developers.jup.ag/docs/tool-kits/wallet-kit/jupiter-wallet-extension), [Wallet Standard registry](https://github.com/wallet-standard/wallet-standard), [Solana wallet features](https://github.com/anza-xyz/wallet-standard) | Registry, challenge/signature and account-change tests with mocked providers. |

Exact token issuer/bridge registries and dated mapping checks are recorded in [MULTI_ASSET_VENUES.md](MULTI_ASSET_VENUES.md). Public mint and deployment addresses establish protocol identity; they do not establish hedgeability, redemption safety or executable liquidity.

## Dated public observations

- On 27 September 2026 at approximately 19:31 UTC, public Bybit SOL discovery recorded 364 listed USDT options, 353 with best-ask quotes, a 1 SOL minimum quantity and a 0.01 USDT price tick. The public artifact is [venue-verification.json](venue-verification.json).
- Historical Meteora public pool/SDK reads validated canonical token orientation, decimals and bin metadata. These checks did not certify account ownership or every pool's economic behavior.
- The 30 September 2026 multi-asset probes normalized public Bybit markets for all eight catalog groups and Hyperliquid native markets for seven. No native XAUT perpetual was found in that probe. Exact-mint checks and the HYPE bridge mapping are documented separately in the [support record](MULTI_ASSET_VENUES.md).
- Public Hyperliquid info/history probes checked endpoint shapes, native market metadata and empty-response handling. They do not establish complete funded-account history or successful order execution.

These are point-in-time observations. Counts, quotes, lot sizes and mappings are revalidated by the applicable adapters and policies rather than treated as permanent market specifications.

## Limits of the evidence

Current implementation and test results belong in [VALIDATION.md](VALIDATION.md). Historical development also included authenticated read-only schema/discovery checks, which are distinct from mocked execution tests and successful live trading. No live order acceptance, full fill/fee lifecycle or complete unattended multi-asset strategy is certified here. See [VERIFICATION.md](VERIFICATION.md) and [SIMULATION.md](SIMULATION.md).
