# Recovering an unresolved Hyperliquid intent

The explicit local archival workflow currently supports SOL and HYPE books.
General persisted-order reconciliation is separate from this archival action.

An intent is saved before submission. An interrupted connection or sleeping host
can leave the result unknown. `unknownOid` means the venue cannot find the client
ID; it is not a confirmation of cancellation or non-submission.

Use **Pause All**, select the affected underlying, and open **Recover pending
order**. The preview performs read-only venue checks. Review the original order,
current perpetual position, open orders, historical-order matches, and fills since
the intent. A review expires after two minutes and confirmation checks the venue
again. New fills, open orders, incomplete data, changed account/order identity,
or a changed perpetual position prevent archival.

**Archive unresolved record** is an explicit local bookkeeping action. It does
not submit, resend, cancel, or close a venue order. It stores the original intent,
review and fresh evidence with the outcome `abandoned-unknown`, records an audit
event, and clears the local pending blocker atomically. The historical outcome
remains unknown. Available historical orders can be truncated; a review must not
be interpreted as proof the original request was never accepted.

All automation must remain paused throughout recovery and stays paused afterward.
The account is reconciled before archival; a subsequent explicit enable computes
a new hedge from current inventory, options and actual perpetual positions. The
old order is never replayed. Keep the host awake and connected during unattended
operation, or run the worker on an always-on host. A browser-independent worker
still stops making progress when its computer sleeps.

Recovery preserves the P&L baseline, positions, risk settings and last successful
hedge anchor. The new cycle must reconcile current exposure, including option
settlement since the interrupted order. Recovery cannot resolve a real open
order, an evidenced fill, or an exchange/account response that remains invalid.
