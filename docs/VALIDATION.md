# Showcase validation

Prepared **11 October 2026 (Europe/Moscow)**. This report records checks performed for the public showcase and distinguishes them from historical observations and unverified live execution.

## Automated acceptance

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `ENABLE_LIVE_EXECUTION=false npm test` | 658 tests passed across 42 files |
| `npm run build` | Passed; 2,951 modules transformed |
| `npm audit --json` | Completed with unresolved findings: five high and two critical package entries |

The execution environment was the existing Node 23.7.0 and npm 10.9.2 installation. Public setup targets Node 22.13+ or 24 LTS. Node emitted the experimental SQLite warning. Vite reported an existing main chunk of approximately 840 kB before gzip and a chunk-size advisory; the build succeeded. The [dependency record](DEPENDENCIES.md) describes the current audit without claiming production readiness.

The tests cover independently computed bin payoffs, smooth model sensitivities, executable fitting and gamma tolerance, venue units/schema validation, accounting boundaries, multi-asset execution, authorization gates, partial and ambiguous orders, restart recovery, and persistent storage. Authenticated venue/order responses are mocked or fixture-based. The suite does not establish actual exchange acceptance or profitable live behavior.

## Isolated browser walkthrough

The current production frontend was served by `scripts/ui-qa.ts` on a separate loopback port with a new temporary SQLite database. The harness did not load `.env`, instantiate the live Gateway, connect wallets/accounts, or permit live mode/public-market feeds. Only the real paper Engine and synthetic fixtures were used.

Verified through the interface:

1. Eight synthetic asset books, the SOL 69-bin position, per-asset risk rows, and disconnected venue accounts.
2. A six-leg terminal IL quote, premium/fee and residual-risk review, and explicit simulated purchase. Filled options appeared in actual holdings only after confirmation.
3. Initial paper perpetual hedging completed in capped cycles. Actual quantity, residual, and anchor reflected the completed hedge.
4. A +1.5% paper reference-price move generated a new order-intent event with the alpha-trigger reason, a simulated fill, and an updated anchor/residual.
5. Terminal payoff and pre-expiry model views rendered separately. The model view explicitly included fixed current perpetual size and showed local sensitivities.
6. Pause All displayed all-paused state and retained the synthetic positions.
7. The browser error log contained no errors during this walkthrough.

This is paper UI/workflow validation. No live order, wallet signature, API permission change, capital transfer, or private account read was performed to prepare these screenshots.

## Screenshot provenance

| Image | Captured state |
| --- | --- |
| [paper-overview.jpg](showcase/paper-overview.jpg) | Initial eight-asset paper portfolio; no option/perp fills |
| [paper-options-review.jpg](showcase/paper-options-review.jpg) | Explicit paper purchase confirmation for synthetic option contracts |
| [paper-payoff.jpg](showcase/paper-payoff.jpg) | Filled synthetic option basket, completed initial paper hedge, terminal payoff workspace |

Every balance, price, fee, option contract, position and fill in these images is synthetic. Screenshot amounts and expiry are illustrative and can differ on another launch as time to expiry changes. None show real accounts, wallet addresses, credentials or historical trading performance. The images were visually inspected before inclusion.

## Historical evidence and live limits

Earlier development records describe public read-only venue probes and authenticated read-only account discovery/reconciliation. Those checks are documented observations at their original dates and were not repeated here. The public [source record](SOURCES.md) and [verification summary](VERIFICATION.md) retain their scope without personal account details.

Public reads demonstrate endpoint access and response normalization at a moment in time. Authenticated reads demonstrate only the recorded account/schema behavior. Existing holdings do not establish that this application's order path created them. Actual multi-asset order submission, fills, final fees, venue-side recovery and strategy profitability remain unverified by this showcase.

## Public package

`npm run showcase:package` produces an allowlisted archive with source, tests, reviewed documentation, three synthetic images, and file hashes. Private state, configuration, development prompts, prior document snapshots, historical screenshots, Git history, dependencies, and built output are excluded. The initial publication package contained **131 reviewed files plus one manifest**; later documentation updates are listed in the current manifest. A fresh extraction passed manifest SHA-256 checks, exclusion checks, and all local Markdown/image links. From that extracted source, a clean `npm ci` succeeded, all **658 tests across 42 files** passed again, and `npm run build` passed with TypeScript checking. Fresh-install tests also emitted upstream `punycode` deprecation warnings on the existing Node 23 runtime.

The extracted `npm run demo:showcase` launcher also passed a separate-port smoke check: paper health, eight asset books, disconnected accounts, and `liveExecution=false`. A live-mode request returned HTTP 409 and the application remained in paper mode.

The same packaging command is included in the archive so later publication copies can be rebuilt from the documented allowlist. These implementation and packaging checks were completed before publication. The reviewed source snapshot was subsequently published to [LeksZy/deltaform](https://github.com/LeksZy/deltaform); publication does not add live-trading validation.
