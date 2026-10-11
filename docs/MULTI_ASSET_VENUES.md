# Multi-asset venue contract

Reviewed and probed on 2026-09-30. All development probes were public read-only requests; no orders, signatures, transfers, or API-key changes were submitted.

## Asset identity and support

`src/shared/assets.ts` defines the eight economic groups and an exact Solana mint registry. A matching display symbol is never enough to normalize an LP into a hedge group. Canonical USDC and USDT are the accepted quote assets. On-chain mint decimals must agree with the registered decimals; SDK bin prices retain their actual bin IDs and prices are reciprocated when the stablecoin is token X.

| Group | Verified Solana representation | Bybit active USDT options in probe | Native Hyperliquid perp |
| --- | --- | ---: | --- |
| BTC | Coinbase cbBTC; Wormhole Portal WBTC | 658 | Listed |
| ETH | Wormhole Portal ETH | 558 | Listed |
| SOL | Wrapped native SOL | 320 | Listed |
| XAUT | XAUt0 | 348 | Not listed; automatic perp hedge unavailable |
| HYPE | Sunrise/Wormhole NTT Solana HYPE mint (proxy) | 320 | Listed |
| XRP | Exact issuer/bridge mapping not yet enabled | 276 | Listed |
| MNT | Exact issuer/bridge mapping not yet enabled | 324 | Listed |
| DOGE | Exact issuer/bridge mapping not yet enabled | 268 | Listed |

These counts describe one point in time, not executable liquidity or future availability. Market discovery always queries the configured venue. Native Hyperliquid XAUT discovery deliberately fails instead of selecting GOLD, PAXG, or a HIP-3 market with different settlement/account semantics.

Verified wrappers retain `hedgeMapping.status = proxy` and `requiresBasisMonitoring = true`. Their registry identity establishes what they represent; it does not eliminate bridge/custody/redemption risk. Pool/index/perpetual basis must remain within configured limits before automation. An unregistered token paired with a canonical stablecoin can be imported as `unmapped:<mint>` with watch-only status; it cannot be assigned to BTC or another group by its symbol. Volatile/volatile pools remain unsupported because their payoff needs a joint model.

Mint sources, accessed 2026-09-30:

- [Native wrapped SOL](https://solana.com/docs/tokens/basics/sync-native).
- [Coinbase cbBTC issuer registry](https://www.coinbase.com/cbbtc): `cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij`.
- [Wormhole official source-token registry](https://github.com/wormhole-foundation/wormhole-token-list/blob/main/content/by_source.csv): Ethereum WETH `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2` maps to Solana `7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs`; Ethereum WBTC `0x2260fac5e5542a773aa44fbcfedf7c193bc2c599` maps to `3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh`.
- [XAUt0 developer deployment registry](https://usdt0.gitbook.io/xaut0/technical-documentation/developer): token `AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P`; this is the token mint, not its OFT program address.
- [Pump's published pair-asset register](https://pump.fun/docs/custom-pairs) lists Solana mint `98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g` as Hyperliquid HYPE, listed by Sunrise (Wormhole Labs). [Wormhole's HYPE NTT announcement](https://wormhole.com/blog/hype-goes-natively-multichain-with-wormhole-ntt) confirms Solana distribution. Finalized Solana `getAccountInfo` at slot 451945638 verified 9 decimals and SPL Token Program ownership. The on-chain NTT manager configuration for `NttMjdaP1RnzrqFMjspEBaqRv7N2X2JTbVmLMSXGHhK` names this mint; its derived `token_authority` PDA matches the mint authority `3X46pk5u5gLfppNRyPF5PcKyuHYrA2pHnyJK5HRLPzfi`. The Solana manager's peer for Wormhole chain 47 names HyperEVM manager `0x452A2613f9200dB250Ec30d15643f4535934Ea77`; a read-only HyperEVM contract call identified its token as [WHYPE `0x555...5555`](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/wrapped-hype) and its chain-1 peer as the same Solana manager. This supports exact economic grouping and a configured redemption route, not a guarantee of timely or costless redemption. [NTT's trimmed-amount code](https://github.com/wormhole-foundation/native-token-transfers/blob/main/solana/modules/ntt-messages/src/trimmed_amount.rs) limits transferable precision to eight decimals, with potential source dust. Bridge availability, rate limits, fees and pool/index basis remain separate risks. The mapping never applies to a different HYPE-symbol mint.
- [Circle USDC contracts](https://developers.circle.com/stablecoins/usdc-contract-addresses) and [USDT0 Solana page](https://usdt0.to/ecosystem/solana) identify the canonical stablecoin mints.

Public Solana `getMultipleAccounts` with `jsonParsed`/`confirmed` verified the original seven configured mints: SOL 9 decimals; stablecoins 6; cbBTC, Portal WBTC and ETH 8; XAUt0 6. A separate finalized `getAccountInfo` verified HYPE 9 decimals and SPL Token Program ownership. Position reads use mint-account decimals and SDK transfer-fee-adjusted accrued fees; terminal fee-free replication does not model future transfer/bridge fees.

## Adapter contracts

- `getBybitMarket(underlying = 'SOL')` uses V5 `baseCoin` discovery with pagination, verifies symbol/base/quote/settlement/date consistency, and preserves each contract's live lot and tick increments. Option quantity is in the stated underlying with multiplier 1; prices, premiums and settlement are USDT. Legacy contracts without the `-USDT` settlement suffix are refused. A prepared basket must contain exactly one economic underlying; execution looks up that underlying's authenticated fee schedule. `getBybitAccount` returns every supported option holding and counts stablecoin cash once. Unmapped derivatives, debt and nonstable collateral still block trading.
- `getHyperliquidMarket(underlying = 'SOL')` finds the native DEX asset index dynamically. Order `coin` and cancel `underlying` select that same market; caller must persist the coin with each intent. `getHyperliquidAccount(address, underlying = 'SOL')` returns the selected `actualPerp` plus `allPositions` (`coin`, signed `size`, `entryPrice`, `unrealizedPnl`, `marginUsed`, `leverage`, `supported`). Unsupported native positions remain visible. Attribution accepts `options.underlying` and includes manual trades in that market.
- Hyperliquid collateral is account-level. `policyCollateral` retains the selected-position replacement calculation; `accountPolicyCollateral` releases existing native cross margin once, while reserving unrelated order holds. The orchestrator must subtract other books' margin reservations once before executing a selected book. Unified cross-DEX exposure remains blocked until it has a complete collateral model.
- `getMeteoraPools(underlying = 'SOL')` paginates exact mint pairs in both orientations and independently checks returned mints before accepting a row. `getMeteoraPositions(owner, pool?, underlying?)` loads all recognized groups when the optional group is omitted; explicit group selection narrows the result. Imported unknown stablecoin pairs carry a watch-only mapping. `getMeteoraPool` returns normalized group/orientation/mapping metadata.

## Official API references and verification

All references accessed 2026-09-30:

- [Bybit V5 instruments](https://bybit-exchange.github.io/docs/v5/market/instrument), [tickers](https://bybit-exchange.github.io/docs/v5/market/tickers), [account fee rate](https://bybit-exchange.github.io/docs/v5/account/fee-rate), [order create](https://bybit-exchange.github.io/docs/v5/order/create-order). Production `GET /v5/market/instruments-info` and `/v5/market/tickers` normalized successfully through the actual adapter for all eight groups, including USDT settlement and per-contract quantity/tick filters. [Bybit's official options FAQ](https://www.bybit.com/en/help-center/article/FAQ-Options-Trading) expresses order quantities directly in each underlying: minimum BTC 0.01, ETH 0.1, SOL 1, MNT 10, XRP 10, DOGE 100, XAUT 0.1, HYPE 1. These exactly matched the public API minima and establish that the API quantity already represents underlying units; the normalized quantity multiplier is 1, rather than the minimum lot quantity. [Bybit's current derivatives guide](https://www.bybit.com/en/learn/derivatives/derivatives-trading-on-bybit) confirms USDT cash settlement across these eight option underlyings.
- [Hyperliquid info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint). Production `POST /info` with `metaAndAssetCtxs` normalized all seven listed native assets; XAUT returned the explicit unsupported response. Installed SDK remains `@nktkas/hyperliquid 0.33.3`.
- [Meteora formulas](https://docs.meteora.ag/core-products/dlmm/formulas), [official DLMM SDK](https://github.com/MeteoraAg/dlmm-sdk), [Data API reference](https://github.com/MeteoraAg/docs/blob/main/developer-guides/dlmm/api-reference/overview.mdx). Installed SDK remains `@meteora-ag/dlmm 1.9.14`. Actual adapter discovery returned 117 canonical SOL/USDC and SOL/USDT pools. A Python HTTP client received an edge HTTP 403, while the application's Node adapter succeeded; accessibility can depend on client/network.

Verification covers symbol mismatch, all eight Bybit normalizers, multiple holdings with cash counted once, exact-mint filtering against spoofed indexer rows, inverted mixed bins with different decimals, independent Hyperliquid market indices, missing XAUT, unknown positions, and shared margin reservations. These are mocked adapter/state tests plus the public reads above. No authenticated multi-asset order submission or fill was tested; live execution is not certified production-ready.
