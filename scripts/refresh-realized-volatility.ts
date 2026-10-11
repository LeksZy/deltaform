import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { UNDERLYINGS } from '../src/shared/assets';
import { BYBIT_KLINE_SOURCE, RV_CACHE_PATH, RV_METHOD, calculateMinuteReturns, fetchBybitMinuteCloses, fullUtcWindow,
  type RealizedVolatilityCache } from '../server/realized-volatility';

// Run with: npx tsx scripts/refresh-realized-volatility.ts [--end YYYY-MM-DD] [--output path]
const args = process.argv.slice(2), allowed = new Set(['--end', '--output', '--help']);
if (args.includes('--help')) {
  console.log('Refresh 30 complete UTC days of 1m Bybit spot realized volatility for BTC ETH SOL XAUT HYPE XRP MNT DOGE.\nUsage: npx tsx scripts/refresh-realized-volatility.ts [--end YYYY-MM-DD] [--output data/realized-volatility.json]\nThe end date is exclusive. Public reads only; no credentials or trades.');
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) if (!allowed.has(args[i]!) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('Invalid arguments. Use --help.');
const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const now = Date.now(), requestedEnd = value('--end'), end = requestedEnd ? Date.parse(`${requestedEnd}T00:00:00.000Z`) : fullUtcWindow(now).end;
if (!Number.isFinite(end) || end > fullUtcWindow(now).end || (requestedEnd && new Date(end).toISOString().slice(0, 10) !== requestedEnd)) throw new Error('--end must be a valid completed UTC date, exclusive.');
const window = fullUtcWindow(end), output = resolve(value('--output') ?? RV_CACHE_PATH);
const cache: RealizedVolatilityCache = { schemaVersion: 1, generatedAt: now, source: BYBIT_KLINE_SOURCE, category: 'spot', quote: 'USDT',
  intervalMs: 60000, method: RV_METHOD, annualizationDays: 365, provenance: { kind: 'public-klines' }, window, assets: {} };
console.log(`Public Bybit spot 1m closes: ${new Date(window.start).toISOString()} to ${new Date(window.end).toISOString()} (exclusive).`);
for (const underlying of UNDERLYINGS) {
  try {
    const fetched = await fetchBybitMinuteCloses(underlying, window.start, window.end);
    const statistics = calculateMinuteReturns(fetched.candles, window.start, window.end);
    cache.assets[underlying] = { underlying, symbol: `${underlying}USDT`, status: statistics.complete ? 'complete' : 'incomplete',
      retrievedAt: Date.now(), venueTime: fetched.venueTime, error: null, statistics };
    console.log(`${underlying}: ${statistics.observedReturns}/${statistics.expectedReturns} consecutive returns; ${statistics.missingReturns} missing; ${statistics.annualized == null ? 'RV unavailable' : `${(statistics.annualized * 100).toFixed(2)}% annualized`}.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Public market-data fetch failed';
    cache.assets[underlying] = { underlying, symbol: `${underlying}USDT`, status: 'unavailable', retrievedAt: Date.now(), venueTime: null,
      error: reason.slice(0, 300), statistics: null };
    console.error(`${underlying}: unavailable (${reason.slice(0, 300)})`);
  }
}
cache.generatedAt = Date.now();
if (!Object.values(cache.assets).some(asset => asset?.statistics?.observedReturns)) {
  throw new Error('No returns were retrieved. Existing cache was preserved.');
}
mkdirSync(dirname(output), { recursive: true });
const temp = `${output}.${process.pid}.tmp`;
writeFileSync(temp, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
renameSync(temp, output);
console.log(`Saved historical research cache: ${output}. Incomplete assets display no 30-day RV; see recorded missing intervals/errors.`);
if (Object.values(cache.assets).some(asset => asset?.status !== 'complete')) process.exitCode = 2;
