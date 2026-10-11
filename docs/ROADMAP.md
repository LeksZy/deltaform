# Research roadmap

Deltaform already implements bin-level IL decomposition, constrained option fitting, current gamma targeting, persistent perpetual hedging, multi-asset risk accounting and paper workflows. The next work should strengthen evidence for the strategy's economics and reliability.

The items below are future work, grounded in documented limitations. They are not claims of completed validation or commitments to profitable results.

## 1. Replace assumed LP fees with historical event evidence

**Current gap:** The [scenario simulator](SIMULATION.md) accrues an explicitly assumed annual fee rate while prices remain in range. Price candles cannot reconstruct swaps, bin inventory, ownership, dynamic fees or rewards.

**Next step:** Build a reproducible replay for a clearly defined position and observation window using actual swap/bin and ownership events. Reconcile inventory changes, earned fees, deposits, withdrawals and repositioning against independent snapshots. Preserve missing-data flags rather than filling gaps with invented fees.

**Evidence needed:** A sourced dataset, exact accounting boundary, reconciliation report and reproducible comparison against the existing analytical scenarios. This is the prerequisite for presenting historical strategy performance.

## 2. Measure hedge economics across realistic conditions

**Current gap:** Deterministic scenarios use snapshot IV, simplified execution costs and an illustrative margin threshold. They do not reconstruct changing orderbooks, volatility surfaces or exchange liquidation mechanics.

**Next step:** Study sensitivity to listed-strike spacing, legal lots, option premiums, IV changes, expiry, alpha, funding, slippage and latency using observed inputs where available. Include dedicated venue collateral and idle reserves in the capital denominator. Add settlement charges and basis shocks to the economic assessment.

**Evidence needed:** Clearly separated observed data and assumptions, cost attribution without duplicate premium/IL/decay charges, and outcomes across paths and stresses. Report whether measured fees cover measured hedge costs within the chosen boundary; retain negative and inconclusive results.

## 3. Validate authenticated execution and recovery

**Current gap:** The repository contains venue adapters, order intents, quote revalidation and mocked recovery tests. Dated public reads and authenticated read-only checks do not certify actual multi-asset order acceptance, partial fills, final fees or restart recovery at a venue.

**Next step:** Continue from documented account/API observations with a separately authorized, controlled execution-validation plan in an appropriate venue environment. Reconcile acknowledgments, client order IDs, positions, partial fills, fees and unknown outcomes before evaluating unattended operation. Keep public examples synthetic and free of account identifiers or credentials.

**Evidence needed:** A dated, sanitized report that identifies the environment and exact behavior exercised. Execution reliability and profitable strategy performance remain separate findings.

## 4. Complete defensible flow and P&L attribution

**Current gap:** Account capital and recorded flows exist, but the application lacks a complete flow-adjusted equity history. Shared cash and costs prevent defensible per-asset P&L in some cases. Rewards and external wallet assets are outside the current valuation boundary.

**Next step:** Reconcile deposits, withdrawals, option premiums and settlements, perpetual fills and funding, collected/uncollected LP fees and any benchmark changes for a defined account boundary. Specify how shared costs are allocated before presenting per-asset returns or a historical P&L curve.

**Evidence needed:** An audit trail linking changes in equity to flows and attributed P&L, with unknown values left unavailable. Selected LP ownership changes must not silently reset past performance.

## 5. Maintain a dated live-support record

**Current gap:** Eight deterministic demo assets do not imply eight live strategies. Economic grouping requires exact mint and wrapper verification, current venue instruments, basis checks and account compatibility. The [support matrix](MULTI_ASSET_VENUES.md) records dated observations; availability can change.

**Next step:** Recheck the existing asset mappings and venue routes before any new execution validation. Preserve wrapper/redemption and stablecoin/index basis assumptions, record unavailable markets explicitly, and avoid proxy substitutions without a separately justified model. Refresh historical volatility only through the documented cache workflow and keep its completeness/provenance visible.

**Evidence needed:** Reproducible read-only probes and dated sources tied to exact token identities and instruments. Add assets to the validated strategy only when the whole route is supported; a symbol or successful demo is insufficient.

## 6. Quantify approximation and model sensitivity

**Current gap:** Payoff and gamma fitting use bounded heuristics. The current gamma target depends on a specified LP horizon and flat IV; quote-time neutrality is temporary and does not prove terminal protection. Cross-asset cash scenarios omit cross-gamma, empirical correlations and future rehedging paths.

**Next step:** Compare small fitting problems with exhaustive legal-lot solutions to measure heuristic gaps. Stress the LP horizon/IV choice and track how net gamma and terminal residuals move after price, inventory and time changes. Keep inventory execution delta and model sensitivities separate in every comparison.

**Evidence needed:** Reproducible approximation diagnostics, including tail slopes, infeasible cases and model sensitivity. Explain the conditions under which each objective is useful rather than presenting one hedge metric as universal protection.

## Scope

The priority is a credible portfolio and research showcase of the existing strategy. Automated option rolling, LP repositioning, cross-venue transfers and a broader trading platform are outside this roadmap. The public demo remains in paper mode; new claims should follow new evidence.
