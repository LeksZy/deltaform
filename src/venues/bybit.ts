import { createHash, createHmac, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { BybitExcludedAsset, FitResult, OptionExecutionSettings, OptionHolding, OptionInstrument } from '../shared/types.js';
import { optionExecutionPreview, type OptionExecutionCap } from '../shared/option-execution.js';
import { finite, positive, jsonRequest, VenueError } from './http.js';
import { isUnderlying, requireUnderlying, type Underlying } from '../shared/assets.js';

export interface BybitAuth { apiKey: string; apiSecret: string }
export interface BybitPermissions { canTrade: boolean; readOnly: boolean; message: string }
export interface BybitAccount {
  accountId: string; holdings: OptionHolding[]; openOrders: Record<string, unknown>[]; optionCash: number;
  availableBalance: number | null; timestamp: number; permissions: BybitPermissions; usdtCash: number;
  accountInfoTimestampSource?: 'venue' | 'local-request-start';
  excludedAssets?: BybitExcludedAsset[]; riskBlockers?: string[];
}
export interface BybitInstrumentRaw {
  symbol: string; status: string; baseCoin: string; quoteCoin: string; settleCoin: string; optionsType: string;
  deliveryTime: string; deliveryFeeRate: string;
  priceFilter: { minPrice: string; maxPrice: string; tickSize: string };
  lotSizeFilter: { minOrderQty: string; maxOrderQty: string; qtyStep: string };
}
export interface BybitTickerRaw {
  symbol: string; bid1Price: string; bid1Size: string; ask1Price: string; ask1Size: string; markPrice: string;
  indexPrice: string; markIv: string; delta?: string; gamma?: string; vega?: string; theta?: string;
}
type Params = Record<string, string | number | boolean>;
interface Envelope<T> { retCode: number; result: T; time: number; timestampSource: 'venue' | 'local-request-start' }
interface Page<T> { category?: string; list: T[]; nextPageCursor?: string }
const MAX_QUOTE_AGE_MS = 15_000;
const TAKER_RATE = .0003, PREMIUM_FEE_CAP = .07;

export function bybitConfig() {
  const network = process.env.BYBIT_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
  return { version: 'v5' as const, network, base: network === 'testnet' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com',
    maxStablecoinBasisBps: positive(process.env.BYBIT_MAX_STABLECOIN_BASIS_BPS ?? '50', 'stablecoin basis limit') } as const;
}
export function bybitOrderRejectionReason(code: number): string {
  if ([10003, 10004, 10005, 33004].includes(code)) return 'API key, signature, environment or permission was rejected. Check the configured Bybit key and OptionsTrade permission.';
  if ([10002].includes(code)) return 'Request timestamp was rejected. Synchronize the server clock before retrying a reviewed order.';
  if ([110004, 110007, 110012, 110044, 110045].includes(code)) return 'Insufficient venue-local wallet balance or available margin. Check the Unified Trading Account.';
  if ([10009, 10010].includes(code)) return 'API IP access was rejected. Check the key IP allowlist and Bybit account access requirements.';
  if ([10006, 10429].includes(code)) return 'Bybit rate limit reached. Pause requests and reconcile any in-flight order.';
  if ([10014, 110072].includes(code)) return 'Duplicate request/order identifier. Reconcile the original order; do not create a replacement blindly.';
  if ([10000, 10016, 10019].includes(code)) return 'Bybit timed out or is restarting. The order outcome may be unknown; reconcile its persistent orderLinkId.';
  return 'Bybit rejected the request. Reconcile the account and review venue rules before preparing another hedge.';
}
export class BybitApiError extends VenueError {
  constructor(public method: string, public code: number) {
    super('Bybit', `${method}: venue code ${code}. ${bybitOrderRejectionReason(code)}`, undefined,
      [10000, 10014, 10016, 10019, 110072].includes(code));
  }
}
/** Raw API error text is deliberately never retained: it may echo signed parameters. */
export function signBybitRequest(auth: BybitAuth, timestamp: string, payload: string, recvWindow = '5000'): string {
  return createHmac('sha256', auth.apiSecret).update(timestamp + auth.apiKey + recvWindow + payload).digest('hex');
}
function validAuth(auth: BybitAuth) {
  if (!auth || typeof auth.apiKey !== 'string' || typeof auth.apiSecret !== 'string' || !auth.apiKey.trim() || !auth.apiSecret.trim()
    || auth.apiKey.length > 512 || auth.apiSecret.length > 4096) throw new VenueError('Bybit', 'Configure a server-side HMAC API key and secret. RSA keys are not supported by this adapter.');
}
export function bybitAuthFingerprint(auth: BybitAuth) { validAuth(auth); return createHash('sha256').update(auth.apiKey).digest('hex'); }
export async function bybitRequest<T>(method: 'GET' | 'POST', route: string, params: Params = {}, auth?: BybitAuth): Promise<Envelope<T>> {
  if (!/^\/v5\/[a-z/-]+$/.test(route)) throw new VenueError('Bybit', 'Invalid adapter route');
  const payload = method === 'GET' ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : JSON.stringify(params);
  const headers: Record<string, string> = {};
  if (auth) {
    validAuth(auth); const timestamp = String(Date.now());
    Object.assign(headers, { 'X-BAPI-API-KEY': auth.apiKey, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': '5000',
      'X-BAPI-SIGN': signBybitRequest(auth, timestamp, payload), 'X-BAPI-SIGN-TYPE': '2' });
  }
  const requestedAt = Date.now();
  const result = await jsonRequest<{ retCode: number; result: T; time?: unknown }>('Bybit', bybitConfig().base + route + (method === 'GET' && payload ? `?${payload}` : ''), method === 'POST' ? params : undefined, headers);
  if (!result || !Number.isSafeInteger(result.retCode)) throw new VenueError('Bybit', 'Unexpected response envelope; reconcile before retrying', undefined, method === 'POST');
  if (result.retCode !== 0) throw new BybitApiError(route, result.retCode);
  if (!result.result || typeof result.result !== 'object' || Array.isArray(result.result))
    throw new VenueError('Bybit', `${route}: missing or invalid result metadata`, undefined, method === 'POST');
  // This configuration endpoint documents no envelope timestamp. updatedTime is
  // the last settings change, not freshness. Bound this authenticated read by its
  // local request START; never manufacture a timestamp for quotes, cash or orders.
  if (method === 'GET' && route === '/v5/account/info' && auth && !Object.hasOwn(result, 'time'))
    return { ...result, time: requestedAt, timestampSource: 'local-request-start' };
  if (!Number.isSafeInteger(result.time) || Number(result.time) <= 0)
    throw new VenueError('Bybit', `${route}: missing or invalid response timestamp`, undefined, method === 'POST');
  return { ...result, time: result.time as number, timestampSource: 'venue' };
}
async function pages<T>(route: string, params: Params, auth?: BybitAuth): Promise<T[]> {
  const all: T[] = [], seen = new Set<string>(); let cursor = '';
  for (let page = 0; page < 40; page++) {
    const { result } = await bybitRequest<Page<T>>('GET', route, { ...params, ...(cursor ? { cursor } : {}) }, auth);
    if (!Array.isArray(result.list) || (params.category && result.category !== undefined && result.category !== params.category)) throw new VenueError('Bybit', 'Unexpected paginated response');
    all.push(...result.list); cursor = result.nextPageCursor ?? '';
    if (!cursor) return all;
    if (typeof cursor !== 'string' || seen.has(cursor)) throw new VenueError('Bybit', 'Repeated or invalid pagination cursor');
    seen.add(cursor);
  }
  throw new VenueError('Bybit', 'Pagination safety bound exceeded; account/market snapshot is incomplete');
}
function fresh(timestamp: number) {
  if (!Number.isSafeInteger(timestamp) || Date.now() - timestamp > MAX_QUOTE_AGE_MS || timestamp > Date.now() + 5_000)
    throw new VenueError('Bybit', 'Market data is stale or the server clock differs; refresh before execution');
}
function nonnegative(value: unknown, label: string) { const n = finite(value, label); if (n < 0) throw new VenueError('Bybit', `Negative ${label}`); return n; }
function optionalNonnegative(value: unknown, label: string) { return value === undefined || value === '' ? 0 : nonnegative(value, label); }
export function bybitSymbolUnderlying(symbol: string): Underlying {
  const match = /^(BTC|ETH|SOL|XAUT|HYPE|XRP|MNT|DOGE)-\d{1,2}[A-Z]{3}\d{2}-\d+(?:\.\d+)?-[CP]-USDT$/.exec(symbol);
  if (!match || !isUnderlying(match[1])) throw new VenueError('Bybit', 'Unsupported option symbol or settlement currency');
  return match[1];
}
function symbolParts(raw: BybitInstrumentRaw) {
  const underlying = bybitSymbolUnderlying(raw.symbol);
  const match = /^(?:BTC|ETH|SOL|XAUT|HYPE|XRP|MNT|DOGE)-(\d{1,2}[A-Z]{3}\d{2})-(\d+(?:\.\d+)?)-(C|P)-USDT$/.exec(raw.symbol);
  if (!match || raw.baseCoin !== underlying || raw.quoteCoin !== 'USDT' || raw.settleCoin !== 'USDT'
    || raw.optionsType !== (match[3] === 'C' ? 'Call' : 'Put')) throw new VenueError('Bybit', 'Only verified supported options quoted and settled in USDT are supported; other or legacy settlement contracts require explicit mapping');
  const months: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const date = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(match[1])!;
  const expiry = positive(raw.deliveryTime, 'option delivery timestamp');
  const expectedDay = Date.UTC(2000 + Number(date[3]), months[date[2]], Number(date[1]));
  if (!Number.isSafeInteger(expiry) || !Number.isFinite(expectedDay) || Math.floor(expiry / 86_400_000) !== expectedDay / 86_400_000)
    throw new VenueError('Bybit', 'Option symbol date disagrees with delivery metadata');
  return { underlying, strike: positive(match[2], 'strike'), expiry, type: match[3] === 'C' ? 'call' as const : 'put' as const };
}
export function normalizeBybitInstrument(raw: BybitInstrumentRaw, ticker?: BybitTickerRaw, timestamp = 0): OptionInstrument {
  const parts = symbolParts(raw);
  if (ticker && ticker.symbol !== raw.symbol) throw new VenueError('Bybit', 'Ticker and contract mismatch');
  const askSize = ticker ? nonnegative(ticker.ask1Size, 'ask size') : 0;
  const askPrice = ticker ? nonnegative(ticker.ask1Price, 'ask price') : 0;
  const bidPrice = ticker ? nonnegative(ticker.bid1Price, 'bid price') : 0;
  const bidSize = ticker ? nonnegative(ticker.bid1Size, 'bid size') : 0;
  const ask = askPrice > 0 && askSize > 0 ? askPrice : null, bid = bidPrice > 0 && bidSize > 0 ? bidPrice : null;
  const greekNames = ['delta', 'gamma', 'vega', 'theta'] as const;
  const greeks = ticker && greekNames.every(k => ticker[k] !== undefined && ticker[k] !== '' && Number.isFinite(Number(ticker[k])))
    ? { delta: Number(ticker.delta), gamma: Number(ticker.gamma), vega: Number(ticker.vega), theta: Number(ticker.theta) } : null;
  if (greeks && (Math.abs(greeks.delta) > 1.000001 || greeks.gamma < 0 || greeks.vega < 0)) throw new VenueError('Bybit', 'Invalid option Greek units or values');
  return { name: raw.symbol, venue: 'bybit', network: bybitConfig().network, quoteCoin: 'USDT', settleCoin: 'USDT', ...parts, multiplier: 1,
    minSize: positive(raw.lotSizeFilter.minOrderQty, 'minimum order quantity'), sizeStep: positive(raw.lotSizeFilter.qtyStep, 'quantity step'),
    tickSize: positive(raw.priceFilter.tickSize, 'price tick'), bid, ask, askSize: ask === null ? 0 : askSize,
    mark: ticker ? nonnegative(ticker.markPrice, 'mark') : null, iv: ticker && Number(ticker.markIv) > 0 ? positive(ticker.markIv, 'implied volatility') : null,
    greeks, timestamp, source: 'live', asks: ask === null ? [] : [[ask, askSize]], feeRate: TAKER_RATE,
    feeModel: { kind: 'bybit', fixed: 0, underlyingRate: TAKER_RATE, premiumCapRate: PREMIUM_FEE_CAP, spot: ticker ? positive(ticker.indexPrice, `${parts.underlying} index`) : 0 },
    settlement: `USDT cash, European; quantity is ${parts.underlying} units (multiplier 1). Vega per 1 IV percentage point; theta per day. USDT/USDC parity is approximate. Delivery fee metadata: ${nonnegative(raw.deliveryFeeRate, 'delivery fee rate')}; terminal payoff excludes delivery fees.` };
}
export function bybitTakerFee(quantity: number, price: number, index: number, rate = TAKER_RATE): number {
  return new Decimal(nonnegative(quantity, 'quantity')).mul(Decimal.min(new Decimal(nonnegative(rate, 'fee rate')).mul(positive(index, 'index')),
    new Decimal(nonnegative(price, 'option price')).mul(PREMIUM_FEE_CAP))).toNumber();
}
export async function getBybitStablecoinBasis() {
  const { result, time } = await bybitRequest<Page<Record<string, string>>>('GET', '/v5/market/tickers', { category: 'spot', symbol: 'USDCUSDT' });
  fresh(time);
  if (!Array.isArray(result.list) || result.list.length !== 1 || result.list[0].symbol !== 'USDCUSDT') throw new VenueError('Bybit', 'USDC/USDT basis feed unavailable');
  const t = result.list[0], bid = positive(t.bid1Price, 'USDC/USDT bid'), ask = positive(t.ask1Price, 'USDC/USDT ask');
  if (bid > ask) throw new VenueError('Bybit', 'USDC/USDT book is crossed');
  return { stablecoinBasisBps: ((bid + ask) / 2 - 1) * 10_000, timestamp: time };
}
async function requireStablecoinBasis() {
  const basis = await getBybitStablecoinBasis();
  if (Math.abs(basis.stablecoinBasisBps) > bybitConfig().maxStablecoinBasisBps) throw new VenueError('Bybit', 'USDT/USDC basis exceeds the configured limit; approximate parity hedge execution is suspended');
  return basis;
}
export async function getBybitMarket(underlying: Underlying = 'SOL') {
  requireUnderlying(underlying);
  const raws = await pages<BybitInstrumentRaw>('/v5/market/instruments-info', { category: 'option', baseCoin: underlying, status: 'Trading', limit: 1000 });
  const active = raws.filter(r => r.baseCoin === underlying && r.status === 'Trading' && Number(r.deliveryTime) > Date.now());
  if (!active.length) throw new VenueError('Bybit', `No active ${underlying} options listed in the configured environment`);
  const [{ result, time }, basis] = await Promise.all([
    bybitRequest<Page<BybitTickerRaw>>('GET', '/v5/market/tickers', { category: 'option', baseCoin: underlying }), getBybitStablecoinBasis()]);
  fresh(time); if (!Array.isArray(result.list)) throw new VenueError('Bybit', 'Option chain schema unavailable');
  const tickers = new Map(result.list.map(t => [t.symbol, t]));
  const instruments = active.map(raw => normalizeBybitInstrument(raw, tickers.get(raw.symbol), tickers.has(raw.symbol) ? time : 0));
  const indices = instruments.filter(i => i.timestamp > 0).map(i => i.feeModel!.spot).sort((a, b) => a - b);
  if (!indices.length || indices.at(-1)! / indices[0] > 1.005) throw new VenueError('Bybit', `Missing or inconsistent ${underlying} option index values`);
  return { instruments, index: indices[Math.floor(indices.length / 2)], timestamp: Math.min(time, basis.timestamp), rawInstruments: active,
    stablecoinBasisBps: basis.stablecoinBasisBps,
    status: `${instruments.length} ${underlying} options; ${instruments.filter(i => i.ask === null).length} without executable best-ask depth. V5 ${bybitConfig().network}; USDT settlement. USDT/USDC parity approximation; basis ${basis.stablecoinBasisBps.toFixed(2)} bps. Fees use public non-VIP ceiling, account rate checked before execution.` };
}

async function permissions(auth: BybitAuth): Promise<{ accountId: string; permissions: BybitPermissions }> {
  const { result: key } = await bybitRequest<any>('GET', '/v5/user/query-api', {}, auth);
  if (![0, 1].includes(key.readOnly) || !key.permissions || !Array.isArray(key.permissions.Options) || !Array.isArray(key.permissions.Wallet))
    throw new VenueError('Bybit', 'API-key permissions could not be verified');
  if (key.permissions.Wallet.includes('Withdraw')) throw new VenueError('Bybit', 'This key permits withdrawals. Configure a separate API key with withdrawals disabled before connecting Deltaform.');
  const uid = String(key.userIDInt64 && key.userIDInt64 !== '0' ? key.userIDInt64 : key.userID ?? '');
  if (!/^\d+$/.test(uid) || BigInt(uid) <= 0n) throw new VenueError('Bybit', 'API-key account UID unavailable');
  const readOnly = key.readOnly === 1, canTrade = !readOnly && key.permissions.Options.includes('OptionsTrade');
  return { accountId: uid, permissions: { canTrade, readOnly,
    message: canTrade ? 'API key grants OptionsTrade and has withdrawals disabled. Other configured key grants remain venue permissions; Deltaform only submits reviewed options buys.'
      : 'Account reads connected. Enable OptionsTrade on a separate read/write API key with withdrawals disabled to submit a reviewed purchase.' } };
}
/** Checks every supported derivative category and every wallet coin; never filter to one underlying before risk validation. */
export async function getBybitAccount(auth: BybitAuth, options: { mode?: 'strategy' | 'discovery' } = {}): Promise<BybitAccount> {
  const [access, { result: info, time: infoTime, timestampSource: accountInfoTimestampSource }, { result: wallet, time: walletTime }, optionPositions, optionOrders, inversePositions, inverseOrders, spotOrders, linearInstruments] = await Promise.all([
    permissions(auth), bybitRequest<any>('GET', '/v5/account/info', {}, auth), bybitRequest<Page<any>>('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }, auth),
    pages<any>('/v5/position/list', { category: 'option', limit: 200 }, auth), pages<any>('/v5/order/realtime', { category: 'option', openOnly: 0, limit: 50 }, auth),
    pages<any>('/v5/position/list', { category: 'inverse', limit: 200 }, auth), pages<any>('/v5/order/realtime', { category: 'inverse', openOnly: 0, limit: 50 }, auth),
    pages<any>('/v5/order/realtime', { category: 'spot', openOnly: 0, limit: 50 }, auth),
    pages<any>('/v5/market/instruments-info', { category: 'linear', limit: 1000 })]);
  if (![5, 6].includes(info.unifiedMarginStatus) || !['REGULAR_MARGIN', 'PORTFOLIO_MARGIN'].includes(info.marginMode))
    throw new VenueError('Bybit', 'Use a dedicated Unified Trading Account 2.0 in cross or portfolio margin; legacy and isolated account modes are not mapped');
  const settlements = new Set<string>(['USDT', 'USDC']);
  for (const instrument of linearInstruments) {
    if (typeof instrument.settleCoin !== 'string' || !/^[A-Z0-9]{2,20}$/.test(instrument.settleCoin)) throw new VenueError('Bybit', 'Linear settlement metadata unavailable');
    settlements.add(instrument.settleCoin);
  }
  const linearPositions: any[] = [], linearOrders: any[] = [];
  for (const settleCoin of settlements) {
    linearPositions.push(...await pages<any>('/v5/position/list', { category: 'linear', settleCoin, limit: 200 }, auth));
    linearOrders.push(...await pages<any>('/v5/order/realtime', { category: 'linear', settleCoin, openOnly: 0, limit: 50 }, auth));
  }
  if ([...inversePositions, ...linearPositions].some(p => nonnegative(p.size, 'derivative position size') !== 0) || inverseOrders.length || linearOrders.length || spotOrders.length)
    throw new VenueError('Bybit', 'Other derivatives or spot/derivative open orders exist in this account. Use a dedicated supported-options account; their delta and contingent exposure are not mapped.');
  if (!Array.isArray(wallet.list) || wallet.list.length !== 1 || wallet.list[0].accountType !== 'UNIFIED' || !Array.isArray(wallet.list[0].coin)) throw new VenueError('Bybit', 'Unified wallet schema unavailable');
  const w = wallet.list[0]; let optionCash = new Decimal(0), usdtCash = 0;
  const excludedAssets: BybitExcludedAsset[] = [];
  for (const coin of w.coin) {
    if (typeof coin.coin !== 'string' || !/^[A-Z0-9]{1,32}$/.test(coin.coin)) throw new VenueError('Bybit', 'Invalid wallet coin metadata');
    const balance = finite(coin.walletBalance, 'wallet balance'), equity = finite(coin.equity, 'coin equity');
    if (['borrowAmount', 'spotBorrow', 'accruedInterest'].some(k => optionalNonnegative(coin[k], k) > 0) || balance < 0)
      throw new VenueError('Bybit', 'Borrowing, debt or accrued interest exists. Repay it or select a dedicated unlevered options account; cash cannot be counted without liability mapping.');
    if (!['USDT', 'USDC'].includes(coin.coin) && (balance !== 0 || equity !== 0 || optionalNonnegative(coin.locked, 'locked coin balance') !== 0))
      excludedAssets.push({ coin: coin.coin, quantity: balance,
        usdValue: coin.usdValue === undefined || coin.usdValue === '' ? null : nonnegative(coin.usdValue, 'excluded asset USD value') });
    if (['USDT', 'USDC'].includes(coin.coin)) optionCash = optionCash.plus(balance);
    if (coin.coin === 'USDT') usdtCash = balance;
  }
  const riskBlockers = excludedAssets.length ? [`Extra Unified-account assets (${excludedAssets.slice(0, 8).map(a => a.coin).join(', ')}${excludedAssets.length > 8 ? ', …' : ''}) are outside the supported options strategies. Account inspection is available; options purchases and automatic hedging require supported options with USDT/USDC cash only.`] : [];
  if (riskBlockers.length && options.mode !== 'discovery') throw new VenueError('Bybit', riskBlockers[0]);
  if (finite(w.totalPerpUPL, 'perpetual P&L') !== 0) throw new VenueError('Bybit', 'Unmapped derivative P&L remains in this Unified account');
  for (const order of optionOrders) bybitSymbolUnderlying(String(order.symbol));
  const holdings: OptionHolding[] = [];
  for (const p of optionPositions) {
    const size = nonnegative(p.size, 'option position size'); if (size === 0) continue;
    if (!['Buy', 'Sell'].includes(p.side)) throw new VenueError('Bybit', 'Unknown option position direction');
    const { raw, ticker, timestamp } = await getInstrumentMarket(p.symbol);
    holdings.push({ instrument: normalizeBybitInstrument(raw, ticker, timestamp), quantity: (p.side === 'Buy' ? 1 : -1) * size, averagePrice: nonnegative(p.avgPrice, 'average option price') });
  }
  const timestamp = Math.min(infoTime, walletTime); fresh(timestamp);
  return { ...access, holdings, openOrders: optionOrders, optionCash: optionCash.toNumber(), usdtCash,
    availableBalance: w.totalAvailableBalance === '' || w.totalAvailableBalance === undefined ? null : nonnegative(w.totalAvailableBalance, 'available balance'), timestamp, accountInfoTimestampSource, excludedAssets, riskBlockers };
}
async function getInstrumentMarket(symbol: string) {
  bybitSymbolUnderlying(symbol);
  const [{ result: metadata }, { result: quotes, time }] = await Promise.all([
    bybitRequest<Page<BybitInstrumentRaw>>('GET', '/v5/market/instruments-info', { category: 'option', symbol }),
    bybitRequest<Page<BybitTickerRaw>>('GET', '/v5/market/tickers', { category: 'option', symbol })]);
  fresh(time);
  if (metadata.list?.length !== 1 || quotes.list?.length !== 1 || metadata.list[0].symbol !== symbol || quotes.list[0].symbol !== symbol) throw new VenueError('Bybit', 'Exact option metadata/ticker unavailable');
  return { raw: metadata.list[0], ticker: quotes.list[0], timestamp: time };
}
async function feeRate(auth: BybitAuth, underlying: Underlying = 'SOL') {
  const { result } = await bybitRequest<Page<{ baseCoin: string; takerFeeRate: string }>>('GET', '/v5/account/fee-rate', { category: 'option', baseCoin: underlying }, auth);
  if (!Array.isArray(result.list) || result.list.length !== 1 || result.list[0].baseCoin !== underlying) throw new VenueError('Bybit', `Account ${underlying}-options fee rate unavailable`);
  return nonnegative(result.list[0].takerFeeRate, 'account taker fee rate');
}
export interface PreparedBybitOrder {
  instrument: string; quantity: number; limitPrice: number; maxFee: number; estimatedFee: number;
  accountId: string; authFingerprint: string; network: 'mainnet' | 'testnet'; createdAt: number; expiresAt: number; orderLinkId: string;
  params: { category: 'option'; symbol: string; side: 'Buy'; orderType: 'Limit'; qty: string; price: string; timeInForce: 'IOC'; orderLinkId: string };
}
async function validateExecutionMarket(cap: Pick<OptionExecutionCap, 'instrument' | 'quantity' | 'limitPrice'>, rate: number, maxFee: number) {
  const { raw, ticker, timestamp } = await getInstrumentMarket(cap.instrument), i = normalizeBybitInstrument(raw, ticker, timestamp);
  if (raw.status !== 'Trading' || i.expiry <= Date.now() || i.ask === null || i.ask > cap.limitPrice) throw new VenueError('Bybit', 'Option is unavailable or ask moved above the reviewed price cap; refresh the hedge');
  if (cap.quantity < i.minSize || cap.quantity > positive(raw.lotSizeFilter.maxOrderQty, 'maximum order quantity') || !new Decimal(cap.quantity).mod(i.sizeStep).isZero()
    || cap.limitPrice < positive(raw.priceFilter.minPrice, 'minimum price') || cap.limitPrice > positive(raw.priceFilter.maxPrice, 'maximum price') || !new Decimal(cap.limitPrice).mod(i.tickSize).isZero())
    throw new VenueError('Bybit', 'Reviewed size or price violates current venue lot/tick/price limits');
  const { result: book } = await bybitRequest<{ s: string; ts: number; a: [string, string][] }>('GET', '/v5/market/orderbook', { category: 'option', symbol: cap.instrument, limit: 25 });
  fresh(book.ts);
  if (book.s !== cap.instrument || !Array.isArray(book.a)) throw new VenueError('Bybit', 'Option orderbook schema unavailable');
  let depth = new Decimal(0), previous = 0;
  for (const [price, size] of book.a) {
    const p = positive(price, 'book ask'); if (p < previous) throw new VenueError('Bybit', 'Unsorted option orderbook'); previous = p;
    const q = positive(size, 'book quantity'); if (p <= cap.limitPrice) depth = depth.plus(q);
  }
  if (depth.lt(cap.quantity)) throw new VenueError('Bybit', 'Insufficient live ask depth inside the reviewed price cap; refresh the hedge');
  const fee = bybitTakerFee(cap.quantity, cap.limitPrice, i.feeModel!.spot, rate);
  if (fee > maxFee + 1e-9) throw new VenueError('Bybit', 'Current account fee exceeds the reviewed reserve; refresh the hedge');
  return { estimatedFee: bybitTakerFee(cap.quantity, i.ask, i.feeModel!.spot, rate), checkedAt: Math.min(timestamp, book.ts) };
}
export async function prepareBybitOrders(fit: FitResult, auth: BybitAuth, execution: OptionExecutionSettings = { mode: 'quoted-ask', maxSlippagePercent: 0 }): Promise<PreparedBybitOrder[]> {
  const preview = optionExecutionPreview(fit, execution);
  if (!fit.feasible || fit.source !== 'live' || preview.expiresAt <= Date.now() || !preview.legs.length
    || fit.legs.some(l => l.instrument.venue !== 'bybit' || l.instrument.network !== bybitConfig().network)) throw new VenueError('Bybit', 'A current feasible live Bybit hedge review for this network is required');
  if (!preview.withinBudget) throw new VenueError('Bybit', 'Reviewed maximum premium plus fee reserve exceeds the budget');
  await requireStablecoinBasis();
  const underlyings = new Set(fit.legs.map(l => bybitSymbolUnderlying(l.instrument.name)));
  if (underlyings.size !== 1 || fit.legs.some(l => l.instrument.underlying !== bybitSymbolUnderlying(l.instrument.name)))
    throw new VenueError('Bybit', 'Each reviewed basket must contain one verified underlying with consistent contract metadata');
  const underlying = [...underlyings][0];
  const account = await getBybitAccount(auth), rate = await feeRate(auth, underlying);
  if (!account.permissions.canTrade) throw new VenueError('Bybit', account.permissions.message);
  if (account.openOrders.length) throw new VenueError('Bybit', 'Reconcile all existing option open orders before preparing a new basket');
  if (account.availableBalance === null || account.availableBalance < preview.maxTotalCost || account.usdtCash < preview.maxTotalCost)
    throw new VenueError('Bybit', 'Insufficient available Unified margin or prefunded USDT cash for the reviewed maximum cost; automatic borrowing is not used');
  const prepared: PreparedBybitOrder[] = [];
  for (const cap of preview.legs) {
    const checked = await validateExecutionMarket(cap, rate, cap.maxFees), orderLinkId = `df-${randomUUID().replaceAll('-', '')}`;
    prepared.push({ instrument: cap.instrument, quantity: cap.quantity, limitPrice: cap.limitPrice, maxFee: cap.maxFees, ...checked,
      accountId: account.accountId, authFingerprint: bybitAuthFingerprint(auth), network: bybitConfig().network, createdAt: Date.now(), expiresAt: preview.expiresAt, orderLinkId,
      params: { category: 'option', symbol: cap.instrument, side: 'Buy', orderType: 'Limit', qty: new Decimal(cap.quantity).toFixed(), price: new Decimal(cap.limitPrice).toFixed(), timeInForce: 'IOC', orderLinkId } });
  }
  return prepared;
}
function assertPrepared(p: PreparedBybitOrder, auth: BybitAuth, requireUnexpired: boolean) {
  if (p.network !== bybitConfig().network || p.authFingerprint !== bybitAuthFingerprint(auth)) throw new VenueError('Bybit', 'Prepared order account key or environment changed');
  if (requireUnexpired && p.expiresAt <= Date.now()) throw new VenueError('Bybit', 'Order review expired; create a fresh quote');
  if (!/^[A-Za-z0-9_-]{1,36}$/.test(p.orderLinkId) || p.params.orderLinkId !== p.orderLinkId || p.params.symbol !== p.instrument
    || p.params.category !== 'option' || p.params.side !== 'Buy' || p.params.orderType !== 'Limit' || p.params.timeInForce !== 'IOC'
    || Object.keys(p.params).some(k => !['category', 'symbol', 'side', 'orderType', 'qty', 'price', 'timeInForce', 'orderLinkId'].includes(k))
    || !new Decimal(p.params.qty).eq(p.quantity) || !new Decimal(p.params.price).eq(p.limitPrice) || p.quantity <= 0 || p.limitPrice <= 0)
    throw new VenueError('Bybit', 'Prepared order no longer matches the reviewed bounded purchase');
}
/** Caller must persist this intent before invoking. This function performs exactly one order submission. */
export async function executeBybitOrder(prepared: PreparedBybitOrder, auth: BybitAuth) {
  assertPrepared(prepared, auth, true);
  try {
    const basis = await requireStablecoinBasis();
    const market = await validateExecutionMarket(prepared, await feeRate(auth, bybitSymbolUnderlying(prepared.instrument)), prepared.maxFee);
    // The user may withdraw funds, add debt, or trade elsewhere during review or between basket legs.
    const access = await getBybitAccount(auth);
    if (access.accountId !== prepared.accountId || !access.permissions.canTrade) throw new VenueError('Bybit', 'Account identity or OptionsTrade permission changed');
    if (access.openOrders.length) throw new VenueError('Bybit', 'Existing open option orders must be reconciled before this purchase');
    const reserve = new Decimal(prepared.limitPrice).mul(prepared.quantity).plus(prepared.maxFee);
    if (access.availableBalance === null || reserve.gt(access.availableBalance) || reserve.gt(access.usdtCash))
      throw new VenueError('Bybit', 'Insufficient current Unified margin or prefunded USDT cash; the order was not sent and borrowing is not used');
    assertPrepared(prepared, auth, true); fresh(Math.min(basis.timestamp, market.checkedAt, access.timestamp));
  } catch (error) {
    throw new VenueError('Bybit', `Order not sent: ${error instanceof VenueError ? error.message : 'Market/account preflight failed'}`);
  }
  const { result } = await bybitRequest<{ orderId: string; orderLinkId: string }>('POST', '/v5/order/create', prepared.params, auth);
  if (typeof result.orderId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(result.orderId) || result.orderLinkId !== prepared.orderLinkId)
    throw new VenueError('Bybit', 'Order acknowledgment mismatch; reconcile persistent orderLinkId before any retry', undefined, true);
  return { orderId: result.orderId, orderLinkId: result.orderLinkId, status: 'acknowledged' as const };
}
export interface BybitOrderReconciliation {
  resolved: boolean; terminal: boolean; status: string; filled: number; price: number | null; fee: number | null; orderId: string | null;
}
export async function reconcileBybitOrder(auth: BybitAuth, prepared: PreparedBybitOrder): Promise<BybitOrderReconciliation> {
  assertPrepared(prepared, auth, false);
  let found = await pages<any>('/v5/order/realtime', { category: 'option', orderLinkId: prepared.orderLinkId, limit: 50 }, auth);
  if (!found.length) found = await pages<any>('/v5/order/history', { category: 'option', orderLinkId: prepared.orderLinkId, limit: 50 }, auth);
  if (!found.length) return { resolved: false, terminal: false, status: 'unknown', filled: 0, price: null, fee: null, orderId: null };
  if (found.length !== 1) throw new VenueError('Bybit', 'Conflicting order records; keep the basket suspended');
  const o = found[0];
  if (o.orderLinkId !== prepared.orderLinkId || o.symbol !== prepared.instrument || o.side !== 'Buy' || !new Decimal(nonnegative(o.qty, 'order quantity')).eq(prepared.quantity))
    throw new VenueError('Bybit', 'Reconciled order does not match the persisted account intent');
  const filled = nonnegative(o.cumExecQty, 'cumulative fill quantity'), price = filled > 0 ? positive(o.avgPrice, 'average fill price') : null;
  if (filled > prepared.quantity || (price !== null && price > prepared.limitPrice + 1e-9)) throw new VenueError('Bybit', 'Fill values exceed the reviewed size or limit; manual account review required');
  const terminal = ['Filled', 'Cancelled', 'Rejected', 'Deactivated', 'PartiallyFilledCanceled'].includes(o.orderStatus);
  if (!terminal && !['New', 'PartiallyFilled', 'Untriggered', 'Triggered', 'Created'].includes(o.orderStatus))
    throw new VenueError('Bybit', 'Unrecognized order status; keep the basket suspended and reconcile again');
  if (typeof o.orderId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(o.orderId)) throw new VenueError('Bybit', 'Invalid venue order identifier');
  if (o.orderStatus === 'Filled' && filled !== prepared.quantity) throw new VenueError('Bybit', 'Filled order has inconsistent cumulative quantity');
  const fee = o.cumExecFee === '' || o.cumExecFee === undefined ? null : nonnegative(o.cumExecFee, 'execution fee');
  return { resolved: true, terminal, status: String(o.orderStatus), filled, price, fee, orderId: String(o.orderId) };
}
