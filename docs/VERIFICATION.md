# Verification scope

Dated checks, commands and results are recorded in [VALIDATION.md](VALIDATION.md). Local implementation tests and historical network observations have different verification scopes. The network observations below were recorded during September 2026 and are not current market checks.

## Local implementation evidence

The application includes mathematical decomposition, fixed benchmarks, current inventory accounting, model Greeks, constrained listed-option fitting, independent per-asset hedges, shared-margin controls, persistent order recovery and a synthetic paper workflow.

Tests cover independent bin balances and mixed-bin examples, token decimals/orientation, external numerical option benchmarks, finite-differenced Greeks, budgets/depth/lot constraints, infeasible hedges, current-gamma fitting, multi-asset separation, account exclusions, starting-snapshot capital flows, shared collateral, partial fills, ambiguous outcomes and restart recovery. Authenticated exchange responses and order submissions in these tests are injected fixtures. Deterministic test keys and signing vectors establish local schema behavior, not exchange acceptance.

The [isolated UI harness](UI_QA.md) uses a temporary database, synthetic accounts and the paper engine with live execution disabled. Historical browser checks exercised quoting, simulated purchase, delta hedging, pause, stale/empty/error states and partial-fill display states. These checks do not certify wallet-extension signing or exchange fills. Paper scenario returns are analytical illustrations, not a historical performance claim; see [simulation assumptions](SIMULATION.md).

## Historical network observations

- The 27 September 2026 public venue probe recorded Bybit SOL instrument/BBO metadata and Meteora/Hyperliquid public responses. The dated public artifact is [venue-verification.json](venue-verification.json).
- The 30 September 2026 multi-asset support review used public market and exact-mint reads. It distinguished verified token representations, watch-only imports and the unavailable matching native XAUT perpetual. See [MULTI_ASSET_VENUES.md](MULTI_ASSET_VENUES.md).
- Development records include authenticated read-only account schema/discovery checks. Those reads informed endpoint-specific timestamp normalization and account-boundary handling. They do not certify the complete funded-account execution lifecycle.

All observations are limited to their recorded time, endpoint and scope. Public market accessibility and successful account reads do not imply order acceptance, usable liquidity or ongoing authorization.

## Remaining live verification

Successful live order submission, complete fill/fee reconciliation, expiry settlement, real authorization/revocation and unattended multi-asset trading are not certified by these records. Partial or unknown orders require reconciliation; venue baskets are not atomic. Private account compatibility remains subject to the supported account and exposure boundaries in [VENUES.md](VENUES.md) and [BYBIT_API.md](BYBIT_API.md).

No profitability, permanent delta/gamma neutrality, exact practical IL elimination, complete historical equity series or full eight-asset live support is claimed. Stablecoin parity, model assumptions, funding, fees, latency, wrapper basis and venue failures remain relevant limitations.

The service targets one user on one local machine. Internet deployment, multi-host operation and a production security audit are outside the current deployment evidence. Dependency findings are dated separately in [DEPENDENCIES.md](DEPENDENCIES.md).
