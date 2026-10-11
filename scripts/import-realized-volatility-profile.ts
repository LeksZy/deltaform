import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { RV_CACHE_PATH, cacheFromMinuteProfile } from '../server/realized-volatility';

const args = process.argv.slice(2), allowed = new Set(['--input', '--start', '--end', '--output']);
if (args.includes('--help')) {
  console.log('Import a prior rounded minute-of-day log-return research CSV with explicit historical UTC dates.\nUsage: npx tsx scripts/import-realized-volatility-profile.ts --input path.csv --start YYYY-MM-DD --end YYYY-MM-DD [--output data/realized-volatility.json]\nThis records aggregate-profile provenance; it cannot verify original raw candles.');
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) if (!allowed.has(args[i]!) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('Invalid arguments. Use --help.');
const value = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const input = value('--input'), startText = value('--start'), endText = value('--end');
if (!input || !startText || !endText) throw new Error('--input, --start and --end are required; dates cannot be inferred from the profile.');
const parseDate = (text: string) => {
  const time = Date.parse(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== text) throw new Error('Use valid YYYY-MM-DD dates.');
  return time;
};
const cache = cacheFromMinuteProfile(readFileSync(resolve(input), 'utf8'), parseDate(startText), parseDate(endText), basename(input));
const output = resolve(value('--output') ?? RV_CACHE_PATH), temp = `${output}.${process.pid}.tmp`;
mkdirSync(dirname(output), { recursive: true }); writeFileSync(temp, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, output);
console.log(`Imported ${Object.keys(cache.assets).length} rounded profiles for ${startText} to ${endText} UTC (exclusive). Raw candles remain unverified. Cache: ${output}`);
