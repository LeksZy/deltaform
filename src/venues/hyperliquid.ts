import { normalizeHyperliquidCollateral } from './hyperliquid-collateral';
import { readHyperliquidDexStates } from './hyperliquid-dex-state';
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';
import { ApproveAgentTypes, ApiRequestError } from '@nktkas/hyperliquid/api/exchange';
import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSignature, recoverTypedDataAddress, type Hex, type Address } from 'viem';
import Decimal from 'decimal.js';
import { jsonRequest, positive, finite, VenueError } from './http.js';
import { isUnderlying, requireUnderlying, type Underlying } from '../shared/assets.js';
import { EIP712_DOMAIN_FIELDS } from '../shared/eip712.js';

export type HlNetwork = 'mainnet' | 'testnet';
export function hlNetwork(): HlNetwork { return process.env.HYPERLIQUID_NETWORK === 'testnet' ? 'testnet' : 'mainnet'; }
const url = (network = hlNetwork()) => network === 'testnet' ? 'https://api.hyperliquid-testnet.xyz' : 'https://api.hyperliquid.xyz';
export async function hyperliquidInfo<T = any>(body: unknown, network = hlNetwork()): Promise<T> {
  return jsonRequest<T>('Hyperliquid', `${url(network)}/info`, body);
}
export interface HyperliquidMarket { coin: string; asset: number; mark: number; oracle: number; funding: number; sizeStep: number; szDecimals: number; minNotional: number; maxLeverage: number; timestamp: number }
export async function getHyperliquidMarket(underlying: Underlying = 'SOL'): Promise<HyperliquidMarket> {
  requireUnderlying(underlying);
  const [meta, contexts] = await hyperliquidInfo<[{ universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[] }, { markPx: string; oraclePx: string; funding: string }[]]>({ type: 'metaAndAssetCtxs' });
  const asset = meta.universe.findIndex(i => i.name === underlying && !i.isDelisted);
  if (asset < 0) throw new VenueError('Hyperliquid', `${underlying} perpetual is not currently listed on the native DEX; proxy or HIP-3 gold markets are not interchangeable`);
  const m = meta.universe[asset]; const c = contexts[asset];
  return { coin: m.name, asset, mark: positive(c.markPx, `${underlying} perp mark`), oracle: positive(c.oraclePx, `${underlying} perp oracle`),
    funding: finite(c.funding, 'funding'), sizeStep: new Decimal(10).pow(-m.szDecimals).toNumber(), szDecimals: m.szDecimals,
    minNotional: 10, maxLeverage: m.maxLeverage, timestamp: Date.now() };
}
export interface HyperliquidPosition { coin: string; size: number; entryPrice: number | null; unrealizedPnl: number; marginUsed: number; leverage: number; supported: boolean }
export function normalizeHyperliquidPositions(state: any): HyperliquidPosition[] {
  if (!Array.isArray(state?.assetPositions)) throw new VenueError('Hyperliquid', 'Missing account positions');
  return state.assetPositions.map(({ position: p }: any) => {
    if (typeof p?.coin !== 'string' || !p.coin) throw new VenueError('Hyperliquid', 'Invalid position coin');
    return { coin: p.coin, size: finite(p.szi, 'perpetual size'), entryPrice: p.entryPx == null ? null : positive(p.entryPx, 'entry price'),
      unrealizedPnl: finite(p.unrealizedPnl ?? '0', 'unrealized P&L'), marginUsed: finite(p.marginUsed ?? '0', 'position margin'),
      leverage: positive(p.leverage?.value ?? '1', 'leverage'), supported: isUnderlying(p.coin) };
  });
}
export async function getHyperliquidAccount(address: string, underlying: Underlying = 'SOL') {
  requireUnderlying(underlying);
  const [state, openOrders, fills, spot, agents, mode] = await Promise.all([
    hyperliquidInfo({ type: 'clearinghouseState', user: address }),
    hyperliquidInfo({ type: 'frontendOpenOrders', user: address }),
    hyperliquidInfo({ type: 'userFills', user: address }),
    hyperliquidInfo({ type: 'spotClearinghouseState', user: address }),
    hyperliquidInfo({ type: 'extraAgents', user: address }),
    hyperliquidInfo({ type: 'userAbstraction', user: address }),
  ]);
  const collateral = normalizeHyperliquidCollateral(mode, state, spot, Date.now(), underlying);
  let snapshotAt=Date.now();
  if(mode==='unifiedAccount') {
    const all=await readHyperliquidDexStates(address,hlNetwork()==='testnet');
    snapshotAt=Math.min(snapshotAt,all.at);
    for(const [dex,dexState] of all.states) if(dex && (dexState.assetPositions.some(p=>finite(p.position.szi,'DEX position size')!==0) || finite(dexState.marginSummary.totalMarginUsed,'DEX margin')>0)) throw new VenueError('Hyperliquid',`Other DEX exposure (${dex}) shares Unified Account collateral. Use a dedicated native-perpetual hedge account; cross-DEX exposure is not mapped.`);
  }
  const allPositions = normalizeHyperliquidPositions(state);
  const selected = allPositions.find(p => p.coin === underlying);
  return { address, underlying, allPositions, actualPerp: selected?.size ?? 0,
    equity: collateral.equity, collateralInfo: {...collateral,timestamp:snapshotAt},
    marginUsed: finite(state.marginSummary.totalMarginUsed, 'HL margin'),
    withdrawable: finite(state.withdrawable, 'HL withdrawable'),
    timestamp: snapshotAt, state, openOrders, fills, spot, agents };
}

export interface HyperliquidFundingEvent {
  time: number; hash: string; coin: Underlying; usdc: number; fundingRate: number; positionSize: number;
}
export interface HyperliquidFillEvent {
  time: number; hash: string; tradeId: string; orderId: string; coin: Underlying; side: 'B' | 'A';
  size: number; price: number; closedPnl: number; fee: number; feeToken: string;
  /** Informational subset of fee, never added again to costs. */
  builderFee: number | null;
}
export interface HyperliquidHistoryFeed<T> {
  rows: T[]; available: boolean; pages: number; paginationPartial: boolean; error: string | null;
}
export interface HyperliquidAttribution {
  owner: string; coin: Underlying; sinceTime: number; untilTime: number; timestamp: number;
  funding: HyperliquidHistoryFeed<HyperliquidFundingEvent>;
  fills: HyperliquidHistoryFeed<HyperliquidFillEvent>;
  totals: { funding: number | null; perpRealized: number | null; costs: number | null };
  completeSinceRequestedStart: null; scope: string; warnings: string[];
}

/** Bounded read-only owner history. This includes manual SOL trades, not just this worker's orders. */
export async function getHyperliquidAttribution(owner: string, sinceTime: number,
  options: { maxPages?: number; untilTime?: number; underlying?: Underlying } = {}): Promise<HyperliquidAttribution> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new VenueError('Hyperliquid', 'Invalid history owner address');
  const underlying = requireUnderlying(options.underlying ?? 'SOL');
  const untilTime = options.untilTime ?? Date.now();
  const maxPages = options.maxPages ?? 5;
  if (!Number.isSafeInteger(sinceTime) || sinceTime < 0 || !Number.isSafeInteger(untilTime) || untilTime < sinceTime
    || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new VenueError('Hyperliquid', 'Invalid history time range or page limit');
  const text = (value: unknown, label: string): string => {
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') throw new Error(`Missing ${label}`);
    return String(value).trim();
  };
  async function history<T>(type: 'userFunding' | 'userFillsByTime', normalize: (row: any) => T | null,
    identity: (row: T) => string): Promise<HyperliquidHistoryFeed<T>> {
    const unique = new Map<string, T>(); let pages = 0; let cursor = sinceTime; let paginationPartial = false;
    try {
      while (pages < maxPages) {
        const raw = await hyperliquidInfo<any[]>({ type, user: owner, startTime: cursor, endTime: untilTime,
          ...(type === 'userFillsByTime' ? { aggregateByTime: false } : {}) });
        pages++;
        if (!Array.isArray(raw)) throw new Error(`${type} response is not an array`);
        if (!raw.length) break;
        const times = raw.map(row => {
          const time = finite(row?.time, 'history time');
          if (!Number.isSafeInteger(time) || time < cursor || time > untilTime) throw new Error('History response is outside its requested time window');
          return time;
        });
        for (const row of raw) {
          const normalized = normalize(row);
          if (normalized) unique.set(identity(normalized), normalized);
        }
        // Documentation permits caps by element count OR distinct blocks. Treat 500
        // timestamps conservatively as saturation even where the fills cap is 2,000.
        const saturated = raw.length >= (type === 'userFunding' ? 500 : 2000) || new Set(times).size >= 500;
        if (!saturated) break;
        const next = Math.max(...times);
        // Pagination is inclusive. Retain the last timestamp and deduplicate; +1 could
        // omit another trade in the boundary millisecond. A saturated single instant
        // cannot be paginated safely and is explicitly reported as incomplete.
        if (next <= cursor || pages >= maxPages) { paginationPartial = true; break; }
        cursor = next;
      }
      return { rows: [...unique.values()], available: true, pages, paginationPartial, error: null };
    } catch (error) {
      return { rows: [...unique.values()], available: false, pages, paginationPartial: true, error: String(error) };
    }
  }
  const [funding, fills] = await Promise.all([
    history<HyperliquidFundingEvent>('userFunding', row => row?.delta?.coin !== underlying ? null : {
      coin: underlying, time: finite(row.time, 'funding time'), hash: text(row.hash, 'funding hash'),
      usdc: finite(row.delta.usdc, 'funding USDC'), fundingRate: finite(row.delta.fundingRate, 'funding rate'),
      positionSize: finite(row.delta.szi, 'funding position size'),
    }, row => `${row.time}:${row.hash}:${row.coin}`),
    history<HyperliquidFillEvent>('userFillsByTime', row => {
      if (row?.coin !== underlying) return null;
      if (row.side !== 'B' && row.side !== 'A') throw new Error('Unknown fill side');
      return { coin: underlying, time: finite(row.time, 'fill time'), hash: text(row.hash, 'fill hash'),
        tradeId: text(row.tid, 'trade ID'), orderId: text(row.oid, 'order ID'), side: row.side,
        size: positive(row.sz, 'fill size'), price: positive(row.px, 'fill price'),
        closedPnl: finite(row.closedPnl, 'fill realized P&L'), fee: finite(row.fee, 'fill fee'),
        feeToken: text(row.feeToken, 'fee token'), builderFee: row.builderFee == null ? null : finite(row.builderFee, 'builder fee') };
    }, row => `${row.time}:${row.tradeId}:${row.orderId}`),
  ]);
  funding.rows.sort((a, b) => a.time - b.time); fills.rows.sort((a, b) => a.time - b.time);
  const sum = (values: number[]) => values.reduce((n, v) => n.plus(v), new Decimal(0)).toNumber();
  const warnings = ['Only the 10,000 most recent account fills are retained by this API; complete history since the requested start cannot be proven.',
    `Includes every ${underlying} fill and funding event returned for this owner, including manual trades. Excludes deposits, withdrawals, other markets, options premiums and fees, and chain transaction costs.`,
    'Realized P&L is the venue closedPnl on fills in this window; it may close inventory opened before monitoring began.'];
  if (funding.paginationPartial || fills.paginationPartial) warnings.push('At least one history feed is partial or unavailable; totals describe returned rows only.');
  if (fills.rows.some(f => f.feeToken !== 'USDC')) warnings.push(`A ${underlying} fee is denominated outside USDC; costs are unavailable until its conversion is defined.`);
  return { owner: owner.toLowerCase(), coin: underlying, sinceTime, untilTime, timestamp: Date.now(), funding, fills,
    totals: { funding: funding.available ? sum(funding.rows.map(f => f.usdc)) : null,
      perpRealized: fills.available ? sum(fills.rows.map(f => f.closedPnl)) : null,
      costs: fills.available && fills.rows.every(f => f.feeToken === 'USDC') ? sum(fills.rows.map(f => f.fee)) : null },
    completeSinceRequestedStart: null,
    scope: `Hyperliquid owner ${underlying} activity returned for ${new Date(sinceTime).toISOString()} through ${new Date(untilTime).toISOString()}; includes manual trades; not lifetime strategy P&L.`, warnings };
}

export function prepareHyperliquidAgentApproval(agentAddress: string, nonce: number, network: HlNetwork = hlNetwork(), agentName = 'DLMMHedge') {
  const action = { type: 'approveAgent', signatureChainId: '0xa4b1', hyperliquidChain: network === 'mainnet' ? 'Mainnet' : 'Testnet',
    agentAddress: agentAddress.toLowerCase() as Address, agentName, nonce };
  const typedData = {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 42161, verifyingContract: '0x0000000000000000000000000000000000000000' as Address },
    types: { ...ApproveAgentTypes, EIP712Domain: EIP712_DOMAIN_FIELDS }, primaryType: 'HyperliquidTransaction:ApproveAgent' as const, message: action,
  };
  return { action, typedData, network };
}
export async function submitHyperliquidAgentApproval(masterAddress: string, agentAddress: string, nonce: number, signature: Hex, network: HlNetwork = hlNetwork(), agentName = 'DLMMHedge') {
  const { action, typedData } = prepareHyperliquidAgentApproval(agentAddress, nonce, network, agentName);
  const recovered = await recoverTypedDataAddress({ ...typedData, domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) }, signature });
  if (recovered.toLowerCase() !== masterAddress.toLowerCase()) throw new VenueError('Hyperliquid', 'Agent approval signature does not match owner');
  const split = parseSignature(signature);
  const result = await jsonRequest<any>('Hyperliquid', `${url(network)}/exchange`, {
    action, nonce, signature: { r: split.r, s: split.s, v: Number(split.v ?? (27 + (split.yParity ?? 0))) },
  });
  if (result.status !== 'ok') throw new VenueError('Hyperliquid', `Agent approval rejected: ${String(result.response)}`);
  return result;
}

function client(agentKey: Hex) {
  return new ExchangeClient({ wallet: privateKeyToAccount(agentKey), transport: new HttpTransport({ isTestnet: hlNetwork() === 'testnet', timeout: 15_000 }) });
}
export interface HyperliquidOrder { coin?: Underlying; size: number; limitPrice: number; clientOrderId: Hex; reduceOnly?: boolean }
/** Caller persists order intent before calling. size is signed underlying units, clientOrderId is a durable 16-byte hex ID. */
export async function executeHyperliquidOrder(agentKey: Hex, order: HyperliquidOrder) {
  if (!/^0x[0-9a-fA-F]{32}$/.test(order.clientOrderId)) throw new Error('Expected 16-byte client order ID');
  const market = await getHyperliquidMarket(order.coin ?? 'SOL');
  const size = formatSize(Math.abs(order.size), market.szDecimals);
  if (Number(size) * order.limitPrice < market.minNotional) throw new VenueError('Hyperliquid', 'Order below $10 minimum notional');
  const price = formatPrice(order.limitPrice, market.szDecimals, 'perp');
  let result;
  try {
    result = await client(agentKey).order({ orders: [{ a: market.asset, b: order.size > 0, p: price, s: size,
      r: order.reduceOnly ?? false, t: { limit: { tif: 'Ioc' } }, c: order.clientOrderId }], grouping: 'na' });
  } catch (error) {
    // SDK throws on a definitive exchange rejection. Preserve the distinction from timeout,
    // because an unaccepted order has no cloid to find in subsequent orderStatus calls.
    if (error instanceof ApiRequestError) return { result: null, status: { error: error.message },
      requestedSize: Number(size), price: Number(price), clientOrderId: order.clientOrderId };
    throw error;
  }
  const status = result.response.data.statuses[0];
  return { result, status, requestedSize: Number(size), price: Number(price), clientOrderId: order.clientOrderId };
}
export async function reconcileHyperliquidOrder(address: string, clientOrderId: Hex) {
  const order = await hyperliquidInfo({ type: 'orderStatus', user: address, oid: clientOrderId });
  // An unknown ID after a timeout is unresolved, not permission to issue a new ID.
  return { order, resolved: order.status !== 'unknownOid' };
}
export async function cancelHyperliquidOrder(agentKey: Hex, clientOrderId: Hex, underlying: Underlying = 'SOL') {
  const market = await getHyperliquidMarket(underlying);
  return client(agentKey).cancelByCloid({ cancels: [{ asset: market.asset, cloid: clientOrderId }] });
}
