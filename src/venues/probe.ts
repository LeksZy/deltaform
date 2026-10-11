/** Read-only integration probe: npx tsx src/venues/probe.ts. Never authenticates or submits orders. */
import { writeFile, mkdir } from 'node:fs/promises';
import { getMeteoraPools } from './meteora.js';
import { getBybitMarket, bybitConfig } from './bybit.js';
import { getHyperliquidMarket } from './hyperliquid.js';

const checks: Record<string, unknown> = { checkedAt: new Date().toISOString(), mode: 'unauthenticated read-only', bybit: bybitConfig() };
const result = await Promise.allSettled([getMeteoraPools(), getBybitMarket(), getHyperliquidMarket()]);
for (let i = 0; i < result.length; i++) {
  const name = ['meteora', 'bybit', 'hyperliquid'][i]; const r = result[i];
  if (r.status === 'rejected') { checks[name] = { ok: false, reason: String(r.reason) }; continue; }
  const v = r.value;
  checks[name] = name === 'meteora' && Array.isArray(v) ? { ok: true, count: v.length, pools: v.slice(0, 5) }
    : name === 'bybit' && 'instruments' in v ? { ok: true, status: v.status, index: v.index,
      count: v.instruments.length, withAsk: v.instruments.filter(i => i.ask !== null).length,
      sample: v.instruments.filter(i => i.ask !== null).slice(0, 2), timestamp: v.timestamp }
    : { ok: true, ...v };
}
await mkdir('docs', { recursive: true });
await writeFile('docs/venue-verification.json', JSON.stringify(checks, null, 2) + '\n');
console.log(JSON.stringify(checks, null, 2));
