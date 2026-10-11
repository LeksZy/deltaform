# Running Deltaform locally

For a portfolio walkthrough, use the [isolated paper demo](DEMO.md). It needs no configuration or accounts.

## Full persistent application

Use Node 22.13+ or 24 LTS and npm:

```sh
npm ci
npm run build
npm start
```

Open http://127.0.0.1:8787/. A new database starts in synthetic paper mode. The full service loads local `.env` settings and stores paper/live books, capital tracking, anchors, pending intentions, and audit history in SQLite. The background worker belongs to the backend process, so closing the browser does not stop it.

For frontend development, `npm run dev` serves the UI on http://127.0.0.1:5173/ with the API on port 8787.

If configuration is needed, copy `.env.example` to `.env` only when `.env` does not already exist. Preserve an existing database and encryption key. The example has blank credentials and live execution disabled. Paper operation does not need a generated agent encryption key or exchange account.

The application binds to loopback and rejects foreign Host/Origin headers and non-JSON mutations. It is designed for one user on one machine. Public hosting is outside this showcase's deployment model.

## Paper and live boundaries

- Paper books and live books are stored separately. The isolated showcase harness also uses a separate temporary database.
- Options purchases are explicit. Only perpetual delta hedging is automated after it is enabled.
- Live public market reads can be used with simulated execution in the full application; those paper fills are still synthetic.
- Live operation requires compatible accounts, verified LP ownership/token mappings, venue permissions, fresh data, suitable margin, and the server execution flag. Implemented checks do not establish a successful funded-account trading workflow.
- Pause stops new hedge automation and keeps positions open. Close hedge is a separate bounded action. Options rolling, liquidity recentering, and fund transfers are outside the automated workflow.

This guide documents implementation boundaries; the public walkthrough uses paper mode throughout.

## Persistence and recovery

Keep the same database and local encryption key across restarts. A worker lock prevents two execution services from sharing one database. The engine reconciles durable pending intentions before issuing new orders. Unknown or partially filled option orders retain their original identifiers and require reconciliation rather than blind replacement.

Changing accounts, networks, or LP selection can alter the capital-tracking boundary. Restore the original scope or capture a new baseline explicitly. Recording external cash flows affects the accounting ledger; it sends no transaction.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

See [VALIDATION.md](VALIDATION.md) for the current measured result and its limits. Public venue probes are separate network reads and are not part of the offline showcase checks.
