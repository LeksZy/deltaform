# Dependency verification

Checked **11 October 2026 (Europe/Moscow)** using the current lockfile and `npm audit --json`. Direct versions are pinned in `package.json`; `package-lock.json` records the dependency tree. Use `npm ci` for installation.

## Current audit result

The audit reports **seven affected package entries: five high and two critical**, with zero moderate, low or informational entries. Package entries include dependent packages, so this is not seven independent root advisories. The machine-readable summary is [dependency-audit.json](dependency-audit.json).

| Root advisory | Reported chain | Audit fix metadata |
| --- | --- | --- |
| [`bigint-buffer` buffer overflow](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) | `bigint-buffer` → `@solana/buffer-layout-utils` → `@solana/spl-token` → `@meteora-ag/dlmm`; four high entries | No fix reported for the current chain |
| [`shell-quote` command injection](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) | `shell-quote` → `concurrently`; two critical entries | Audit suggests `concurrently` 9.2.5 |
| [`source-map-js` denial of service](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | `source-map-js`; one high entry | Fix available according to audit metadata |

These are the audit's classifications and proposed fixes at the stated date. Reachability and exploitability in this application were not established by this showcase task. The audit is not clean, and passing tests do not remove these findings.

The current manifest retains scoped overrides for Anchor's `toml`, Solana web3.js's `jayson`, and MetaMask's `uuid` dependency. This showcase did not upgrade dependencies or claim remediation; the older September audit counts have been superseded by the current result.

## Runtime and validation

Public setup instructions target Node **22.13+** or **24 LTS**. This task used the existing Node **23.7.0** and npm **10.9.2** environment, where typechecking, all 658 tests, and the production build passed. The runtime emitted its experimental SQLite warning and the build retained its bundle-size advisory. Passing on this existing runtime is not an additional supported-version claim.

The source archive is checked separately for file completeness, exclusion of private data, local documentation links, and paper-only launch behavior; see [VALIDATION.md](VALIDATION.md).

A future dependency change should receive focused compatibility and audit checks, followed by the application's existing tests and build. No production security audit, private exchange execution, or live order validation was performed here.
