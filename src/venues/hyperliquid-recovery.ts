import { isUnderlying } from '../shared/assets';
import type { RecoveryEvidence } from '../shared/hedge-recovery';
import { hyperliquidInfo } from './hyperliquid';

interface RecoveryIntent { cloid: string; underlying: string; quantity: number; createdAt: number; appliedFill: number }
type JsonObject = Record<string, unknown>;
const MIN_INTENT_AGE_MS = 120_000;
const MAX_FILL_PAGES = 10;
const MAX_RETAINED_FILLS = 10_000;
const CLOID = /^0x[0-9a-fA-F]{32}$/;
const ORDER_STATUSES = new Set(['open', 'filled', 'canceled', 'triggered', 'rejected', 'marginCanceled',
  'vaultWithdrawalCanceled', 'openInterestCapCanceled', 'selfTradeCanceled', 'reduceOnlyCanceled',
  'siblingFilledCanceled', 'delistedCanceled', 'liquidatedCanceled', 'scheduledCancel', 'tickRejected',
  'minTradeNtlRejected', 'perpMarginRejected', 'reduceOnlyRejected', 'badAloPxRejected', 'iocCancelRejected',
  'badTriggerPxRejected', 'marketOrderNoLiquidityRejected', 'positionIncreaseAtOpenInterestCapRejected',
  'positionFlipAtOpenInterestCapRejected', 'tooAggressiveAtOpenInterestCapRejected', 'openInterestIncreaseRejected',
  'insufficientSpotBalanceRejected', 'oracleRejected', 'perpMaxPositionRejected']);

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
  return value as JsonObject;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid timestamp');
  return value;
}
function decimal(value: unknown): number {
  if ((typeof value !== 'string' && typeof value !== 'number') ||
    (typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value))) throw new Error('Invalid decimal');
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error('Invalid decimal');
  return result;
}
function identifier(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value) && value.length <= 20) return value;
  throw new Error('Invalid identifier');
}
function coin(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9@:_./-]{1,64}$/.test(value)) throw new Error('Invalid coin');
  return value;
}
function order(value: unknown) {
  const row = object(value), name = coin(row.coin), time = timestamp(row.timestamp);
  identifier(row.oid);
  if ((row.side !== 'A' && row.side !== 'B') || decimal(row.sz) < 0 || decimal(row.limitPx) < 0) throw new Error('Invalid order');
  if (row.cloid !== undefined && row.cloid !== null && (typeof row.cloid !== 'string' || !CLOID.test(row.cloid))) throw new Error('Invalid cloid');
  return { coin: name, timestamp: time, cloid: typeof row.cloid === 'string' ? row.cloid.toLowerCase() : null };
}
function historicalOrder(value: unknown) {
  const row = object(value), normalized = order(row.order);
  if (typeof row.status !== 'string' || !ORDER_STATUSES.has(row.status)) throw new Error('Invalid order status');
  timestamp(row.statusTimestamp);
  return { ...normalized, status: row.status };
}
function status(value: unknown): string {
  const row = object(value);
  // An unknown lookup with contradictory fields is not a valid missing-order response.
  if (row.status === 'unknownOid' && Object.keys(row).length === 1) return 'unknownOid';
  if (row.status === 'order') return historicalOrder(row.order).status;
  throw new Error('Invalid order lookup');
}
function position(value: unknown, underlying: string): number {
  const state = object(value);
  if (!Array.isArray(state.assetPositions)) throw new Error('Missing positions');
  const seen = new Set<string>();
  let actual = 0;
  for (const item of state.assetPositions) {
    const row = object(object(item).position), name = coin(row.coin), size = decimal(row.szi);
    if (seen.has(name)) throw new Error('Duplicate position');
    seen.add(name);
    if (name === underlying) actual = size;
  }
  return actual;
}

interface Fill { key: string; fingerprint: string; time: number; coin: string }
function fill(value: unknown, start: number, end: number): Fill {
  const row = object(value), name = coin(row.coin), time = timestamp(row.time);
  if (time < start || time > end || (row.side !== 'A' && row.side !== 'B')) throw new Error('Invalid fill window or side');
  const size = decimal(row.sz), price = decimal(row.px);
  if (size <= 0 || price <= 0) throw new Error('Invalid fill amount');
  const key = `${name}:${identifier(row.oid)}:${identifier(row.tid)}:${time}`;
  return { key, time, coin: name, fingerprint: `${row.side}:${size}:${price}` };
}

/**
 * Read-only evidence for an explicitly confirmed LOCAL retirement of an orphan intent.
 * unknownOid is not proof of rejection or non-execution. No exchange mutation is made.
 * Contracts: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 * Time endpoints paginate inclusively, with caps by rows/blocks; fills retain only 10,000.
 */
export async function inspectHyperliquidRecovery(owner: string, intent: RecoveryIntent, now = Date.now()): Promise<RecoveryEvidence> {
  const evidence: RecoveryEvidence = {
    checkedAt: now, orderStatus: 'unavailable', openOrderCount: 0, matchingHistoricalOrderCount: 0,
    historicalOrdersTruncated: false, fillsSinceIntentCount: 0, fillsComplete: false,
    actualPerp: null, eligible: false, blockers: [], observation: '',
  };
  const block = (message: string) => { if (!evidence.blockers.includes(message)) evidence.blockers.push(message); };
  const finish = () => {
    evidence.eligible = evidence.blockers.length === 0;
    evidence.observation = evidence.eligible
      ? 'No evidence of this intent was found in the checked venue responses. The legacy outcome remains unknown; this does not prove rejection or non-execution.'
      : 'Recovery evidence is incomplete or conflicting. The legacy outcome remains unknown; no non-execution conclusion can be drawn.';
    if (evidence.historicalOrdersTruncated) evidence.observation += ' Historical orders are limited to the latest 2,000 and are not complete history.';
    return evidence;
  };
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner) || !intent || !CLOID.test(intent.cloid) || !isUnderlying(intent.underlying)
    || !Number.isFinite(intent.quantity) || intent.quantity === 0 || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(intent.createdAt) || intent.createdAt < 0 || intent.createdAt > now
    || !Number.isFinite(intent.appliedFill) || intent.appliedFill < 0) {
    block('Invalid recovery owner, intent, or time range.');
    return finish();
  }
  if (now - intent.createdAt < MIN_INTENT_AGE_MS) block('Intent must be at least 120 seconds old.');
  if (intent.appliedFill !== 0) block('The intent already has a locally applied fill.');
  const startTime = Math.max(0, intent.createdAt - 1_000);
  const read = async (message: string, work: () => Promise<void>) => {
    try { await work(); } catch { block(message); }
  };
  await Promise.all([
    read('Order status could not be verified.', async () => {
      evidence.orderStatus = status(await hyperliquidInfo<unknown>({ type: 'orderStatus', user: owner, oid: intent.cloid }));
      if (evidence.orderStatus !== 'unknownOid') block('The venue has a known order status; normal reconciliation is required.');
    }),
    read('Open orders could not be verified.', async () => {
      const rows = await hyperliquidInfo<unknown>({ type: 'frontendOpenOrders', user: owner });
      if (!Array.isArray(rows)) throw new Error('Invalid open orders');
      rows.forEach(order);
      evidence.openOrderCount = rows.length;
      if (rows.length) block('The account has open orders.');
    }),
    read('Historical orders could not be verified.', async () => {
      const rows = await hyperliquidInfo<unknown>({ type: 'historicalOrders', user: owner });
      if (!Array.isArray(rows) || rows.length > 2_000) throw new Error('Invalid historical orders');
      evidence.historicalOrdersTruncated = rows.length === 2_000;
      const historical = rows.map(historicalOrder);
      evidence.matchingHistoricalOrderCount = historical.filter(row => row.cloid === intent.cloid.toLowerCase()).length;
      if (evidence.matchingHistoricalOrderCount) block('The intent has a matching historical order.');
      if (historical.some(row => row.cloid === null && row.coin === intent.underlying && row.timestamp >= startTime)) {
        block('A recent same-market historical order has no client ID and cannot be excluded.');
      }
    }),
    read('Perpetual position could not be verified.', async () => {
      evidence.actualPerp = position(await hyperliquidInfo<unknown>({ type: 'clearinghouseState', user: owner }), intent.underlying);
    }),
    read('Fill history could not be verified completely.', async () => {
      const seen = new Map<string, Fill>();
      let cursor = startTime;
      let boundaryKeys: string[] = [];
      for (let page = 0; page < MAX_FILL_PAGES; page++) {
        const rows = await hyperliquidInfo<unknown>({ type: 'userFillsByTime', user: owner,
          startTime: cursor, endTime: now, aggregateByTime: false });
        if (!Array.isArray(rows) || rows.length > 2_000) throw new Error('Invalid fills');
        const parsed = rows.map(row => fill(row, cursor, now));
        const pageKeys = new Set(parsed.map(row => row.key));
        if (pageKeys.size !== parsed.length || boundaryKeys.some(key => !pageKeys.has(key))) throw new Error('Missing or duplicate fill boundary');
        let previousTime = cursor;
        for (const row of parsed) {
          if (row.time < previousTime) throw new Error('Unordered fills');
          previousTime = row.time;
          const previous = seen.get(row.key);
          if (previous && previous.fingerprint !== row.fingerprint) throw new Error('Conflicting fill');
          if (!previous) {
            seen.set(row.key, row);
            if (row.coin === intent.underlying) evidence.fillsSinceIntentCount++;
          }
        }
        if (seen.size >= MAX_RETAINED_FILLS) throw new Error('Fill retention limit reached');
        // The endpoint-specific maximum is 2,000, but the shared pagination
        // contract also permits a 500-element/block cap. Treat either as full.
        const saturated = rows.length >= 500;
        if (!saturated) { evidence.fillsComplete = true; break; }
        const lastTime = parsed[parsed.length - 1]!.time;
        // Never advance by +1: more fills may share the boundary millisecond.
        // A saturated timestamp without forward progress cannot be safely exhausted.
        if (lastTime <= cursor) throw new Error('Ambiguous fill boundary');
        cursor = lastTime;
        boundaryKeys = parsed.filter(row => row.time === cursor).map(row => row.key);
      }
      if (!evidence.fillsComplete) throw new Error('Fill page limit reached');
    }),
  ]);
  if (evidence.fillsSinceIntentCount) block('The account has same-market fills in the intent window.');
  // Recheck the authoritative cloid lookup after the other reads to catch an order
  // becoming visible during inspection. The read set is evidence, not an atomic snapshot.
  if (evidence.orderStatus === 'unknownOid') {
    await read('Final order status could not be verified.', async () => {
      evidence.orderStatus = status(await hyperliquidInfo<unknown>({ type: 'orderStatus', user: owner, oid: intent.cloid }));
      if (evidence.orderStatus !== 'unknownOid') block('The venue has a known order status; normal reconciliation is required.');
    });
  }
  return finish();
}
