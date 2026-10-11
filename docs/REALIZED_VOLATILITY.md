# Cached 30-day realized volatility

The asset overview displays a historical sample from `data/realized-volatility.json`. It does not recompute minute statistics on dashboard polls or advertise a cached sample as a rolling live measure. The tooltip gives the UTC observation window, sample count, price source, retrieval/import date and 365-day annualization. Missing or invalid cache entries appear unavailable on a fresh install.

## Refresh from public prices

From the repository root, run:

```sh
npx tsx scripts/refresh-realized-volatility.ts
```

This requests BTCUSDT, ETHUSDT, SOLUSDT, XAUTUSDT, HYPEUSDT, XRPUSDT, MNTUSDT and DOGEUSDT spot candles from Bybit's public V5 endpoint. It uses the last 30 completed UTC calendar days and excludes the current partial day. To reproduce an older period, supply its exclusive ending date:

```sh
npx tsx scripts/refresh-realized-volatility.ts --end 2026-09-30
```

An optional `--output path` changes the destination for research exports; the application reads the default path above. The script does not load wallet credentials or submit trades. It performs sequential requests, up to 50 pages of 1,000 candles per asset, four attempts per request, bounded timeouts/backoff, and a small delay between pages. Authentication/access denials are reported without retrying. An unsupported or inaccessible market is recorded as unavailable.

The cache is replaced atomically after fetching all assets. A totally failed refresh preserves the previous file. A partly successful refresh records unavailable/incomplete assets in the new common window; it exits with code 2 and never substitutes a different observation period for an individual asset. The running app detects the changed file without restarting. Keep a copy of an earlier artifact if needed for research comparison.

## Estimator and completeness

Bybit timestamps candles by their opening time. For every candle opening at `t` in `[start, end)`, calculate `r_t = log(close_t / close_(t - 60 seconds))`. This requires the complete 43,200 minutes plus one preceding closed candle. Repeated identical candles are deduplicated; conflicting duplicates, malformed prices or still-open candles fail validation.

```
minute RMS = sqrt(sum(r_t²) / N)
annualized realized volatility = minute RMS × sqrt(365 × 24 × 60)
```

This is uncentered realized variation, not sample standard deviation after subtracting the mean. The cache stores the sum of squared returns and the reader independently reconstructs the displayed value. Percent formatting occurs in the UI; an annualized value of `0.60` means 60%.

Gaps are never filled with zero returns or bridged by multi-minute moves. The artifact records expected/observed candles and returns, duplicate counts, and contiguous ranges of missing returns. A missing interior candle invalidates both adjacent returns. A raw-data cache entry is displayed as 30-day RV only when all 43,200 consecutive returns and 43,201 closes are present.

Prices are centralized-exchange spot proxies for the economic underlyings. The result does not measure the price of a specific Meteora pool, a wrapped token's basis, fees, hedging execution cost or option-implied volatility. An asset without a complete Bybit spot series has no displayed estimate.

## Import a prior aggregate profile

An existing minute-of-day research CSV can be imported with explicit dates:

```sh
npx tsx scripts/import-realized-volatility-profile.ts \
  --input data/realized-vol-30d-minute-profile.csv \
  --start 2026-08-31 --end 2026-09-30
```

The import requires 1,440 unique UTC-minute buckets, each with 30 observations per asset, using `symbol,utc_minute,observations,mean_return_bps,rms_return_bps` as its first five columns. It reconstructs squared-return moments from the rounded bucket RMS values and preserves a SHA-256 digest and source filename. These dates are supplied by the caller, not recovered from the CSV. Aggregate profiles cannot verify the original candles or chronological gaps; their candle counts remain null and the UI explicitly says **imported rounded profile; raw candles unverified**. This import is useful for retaining prior research, not evidence of a new API download. No such profile is automatically loaded from fixture data.

## Verification and sources

The official [Bybit V5 kline documentation](https://bybit-exchange.github.io/docs/v5/market/kline) was checked on 30 September 2026. It specifies spot category selection, millisecond bounds, one-minute interval, reverse timestamp ordering and a maximum 1,000 rows per request. A read-only `BTCUSDT` two-candle probe returned the documented symbol/category/list/time fields. No full 30-day network download was performed during this implementation.

`tests/realized-volatility.test.ts` checks an independent known log-return calculation, gaps, duplicate detection, full-window counts, cache metadata, explicit profile provenance, reverse pagination, bounded retries, HTTP 403 handling and open-candle rejection. Network tests use mocked responses; the small public schema probe is separate from those tests.
