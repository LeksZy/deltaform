import { randomInt } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, encodeAbiParameters, getAddress, http, isAddress, parseAbi, parseUnits, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import type { DeriveTradingAccess, FitResult, OptionExecutionSettings, OptionHolding, OptionInstrument } from '../shared/types.js';
import { optionExecutionPreview, type OptionExecutionCap } from '../shared/option-execution.js';
import { EIP712_DOMAIN_FIELDS, assertWalletSigningDomain } from '../shared/eip712.js';
import Decimal from 'decimal.js';
import { jsonRequest, positive, finite, VenueError } from './http.js';

export interface DeriveAuth { wallet: string; timestamp: string; signature: Hex; signer?: string }
export class DeriveApiError extends VenueError {
  constructor(public method: string, public code: number, message: string, status?: number, ambiguous = false) {
    super('Derive', `${method}: ${code} ${message}`, status, ambiguous);
  }
}
export function deriveOrderRejectionReason(code: number): string {
  if (code === 14031) return 'Unauthorized key scope. The Derive session does not permit this order. For v2, private/order requires Admin; account and read_only scopes cannot trade. Register the connected signer with Admin in Derive, review its broad permissions, then sign fresh authentication and quote again.';
  if (code === 11000) return 'Insufficient funds or margin in the selected Derive subaccount. Check local collateral, existing exposure and order costs.';
  if (code === 14030) return 'Session key expired. Renew authorization in Derive, then sign fresh authentication and quote again.';
  return 'The venue rejected this request. Inspect its order/account state and review the remaining hedge.';
}
export interface DeriveInstrumentRaw {
  instrument_name: string; instrument_type: string; is_active: boolean; base_currency: string; quote_currency: string;
  tick_size: string; minimum_amount: string; maximum_amount: string; amount_step: string; base_fee: string;
  taker_fee_rate: string; maker_fee_rate: string; mark_price_fee_rate_cap: string;
  base_asset_address: Address; base_asset_sub_id: string;
  option_details: { expiry: number; strike: string; option_type: 'C' | 'P'; index: string } | null;
}
type CompactTicker = { t: number; A: string; a: string; B: string; b: string; I: string; M: string;
  minp?: string; maxp?: string;
  option_pricing?: { d: string; g: string; v: string; t: string; i: string } | null };
type ExpandedTicker = { instrument_name: string; timestamp: number; best_ask_amount: string; best_ask_price: string;
  best_bid_amount: string; best_bid_price: string; index_price: string; mark_price: string;
  min_price?: string; max_price?: string;
  option_pricing?: { delta: string; gamma: string; vega: string; theta: string; iv: string } | null };
type Ticker = CompactTicker | ExpandedTicker;
function expiryDate(raw: DeriveInstrumentRaw): number {
  if (!raw.option_details) throw new VenueError('Derive', 'Option expiry metadata missing');
  return Number(new Date(raw.option_details.expiry * 1000).toISOString().slice(0, 10).replaceAll('-', ''));
}
async function executionChain(raw: DeriveInstrumentRaw): Promise<Record<string, Ticker>> {
  // v2 get_ticker currently supplies valuation/metadata but zero BBO fields even when
  // the contemporaneous get_tickers chain has live bids/asks. Use the quote feed itself.
  const data = await deriveRpc<{ tickers: Record<string, Ticker> }>('public/get_tickers',
    { currency: raw.base_currency, instrument_type: 'option', expiry_date: expiryDate(raw) });
  if (!data || !data.tickers || typeof data.tickers !== 'object') throw new VenueError('Derive', 'Execution chain response is unavailable');
  return data.tickers;
}
function compactTicker(ticker: Ticker, instrument: string): CompactTicker {
  if (!ticker || typeof ticker !== 'object') throw new VenueError('Derive', `Missing ticker for ${instrument}`);
  if ('timestamp' in ticker) {
    if (ticker.instrument_name !== instrument) throw new VenueError('Derive', `Ticker instrument mismatch for ${instrument}`);
    const p = ticker.option_pricing;
    return { t: ticker.timestamp, A: ticker.best_ask_amount, a: ticker.best_ask_price,
      B: ticker.best_bid_amount, b: ticker.best_bid_price, I: ticker.index_price, M: ticker.mark_price,
      minp: ticker.min_price, maxp: ticker.max_price,
      option_pricing: p ? { d: p.delta, g: p.gamma, v: p.vega, t: p.theta, i: p.iv } : null };
  }
  return ticker as CompactTicker;
}
export function deriveConfig() {
  const version = process.env.DERIVE_API_VERSION === 'v3' ? 'v3' : 'v2';
  const network = process.env.DERIVE_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
  return { version, network,
    base: version === 'v2' ? (network === 'mainnet' ? 'https://api.lyra.finance' : 'https://api-demo.lyra.finance')
      : (network === 'mainnet' ? 'https://api.derive.xyz/v3' : 'https://testnet.api.derive.xyz/v3'),
    chainId: version === 'v3' ? (network === 'mainnet' ? 1 : 11155111) : (network === 'mainnet' ? 957 : 901),
  } as const;
}
export async function deriveRpc<T = any>(method: string, params: unknown, auth?: DeriveAuth): Promise<T> {
  const config = deriveConfig();
  const prefix = config.version === 'v3' ? 'X-Derive' : 'X-Lyra';
  const headers = auth ? { [`${prefix}Wallet`]: auth.wallet, [`${prefix}Timestamp`]: auth.timestamp, [`${prefix}Signature`]: auth.signature } : {};
  let body: { result?: T; error?: { code: number; message: string; data?: unknown } };
  try {
    body = await jsonRequest('Derive', `${config.base}/${method}`, params, headers);
  } catch (error) {
    if (!(error instanceof VenueError)) throw error;
    if (typeof error.details?.code === 'number') {
      throw new DeriveApiError(method, error.details.code,
        error.details.message ?? `HTTP ${error.status}; venue request rejected`, error.status, error.ambiguous);
    }
    const separateSigner = config.version === 'v2' && auth?.signer && auth.wallet.toLowerCase() !== auth.signer.toLowerCase();
    const guidance = separateSigner && [401, 403].includes(error.status ?? 0)
      ? ' The selected account wallet differs from your signing wallet. Derive v2 smart-wallet access uses an authorized API/session signer; local wallet ownership verification does not register one. Check signer access and the account’s session permissions in Derive.' : '';
    throw new VenueError('Derive', `${method} (${config.version} ${config.network}): ${error.message.replace(/^Derive: /, '')}${guidance}`,
      error.status, error.ambiguous, error.details);
  }
  if (body.error) throw new DeriveApiError(method, body.error.code, body.error.message);
  if (!('result' in body)) throw new VenueError('Derive', 'Missing result envelope; API compatibility check failed');
  return body.result as T;
}

export function normalizeDeriveInstrument(raw: DeriveInstrumentRaw, snapshot?: Ticker): OptionInstrument {
  if (raw.instrument_type !== 'option' || raw.base_currency !== 'SOL' || raw.quote_currency !== 'USDC' || !raw.option_details) {
    throw new VenueError('Derive', 'Unsupported contract currency or settlement units');
  }
  const ticker = snapshot ? compactTicker(snapshot, raw.instrument_name) : undefined;
  const d = raw.option_details; const p = ticker?.option_pricing;
  try {
    const ask = ticker && Number(ticker.a) > 0 && Number(ticker.A) > 0 ? finite(ticker.a, 'ask') : null;
    const bid = ticker && Number(ticker.b) > 0 && Number(ticker.B) > 0 ? finite(ticker.b, 'bid') : null;
    const greeks = p && ['d', 'g', 'v', 't'].every(k => p[k as keyof typeof p] != null && p[k as keyof typeof p] !== '' && Number.isFinite(Number(p[k as keyof typeof p])))
      ? { delta: Number(p.d), gamma: Number(p.g), vega: Number(p.v), theta: Number(p.t) } : null;
    return { name: raw.instrument_name, underlying: raw.base_currency, type: d.option_type === 'C' ? 'call' : 'put',
      strike: positive(d.strike, 'strike'), expiry: d.expiry * 1000, multiplier: 1,
      minSize: positive(raw.minimum_amount, 'minimum quantity'), sizeStep: positive(raw.amount_step, 'quantity step'),
      tickSize: positive(raw.tick_size, 'tick size'), bid, ask, askSize: ask === null ? 0 : Number(ticker!.A),
      mark: ticker ? finite(ticker.M, 'mark') : null, iv: p ? positive(p.i, 'IV') : null, greeks,
      timestamp: ticker?.t ?? 0, source: 'live', asks: ask === null ? [] : [[ask, Number(ticker!.A)]],
      settlement: 'USDC cash; SOL-USD index, European expiry. Amount is SOL units; multiplier 1.',
      // Display only: actual fee is non-linear and includes a per-order base fee; use deriveTakerFee.
      feeRate: Number(raw.taker_fee_rate),
      feeModel: { kind: 'derive', fixed: Number(raw.base_fee), underlyingRate: Number(raw.taker_fee_rate),
        premiumCapRate: Number(raw.mark_price_fee_rate_cap), spot: ticker ? positive(ticker.I, 'index price') : 0 },
    };
  } catch (error) { throw new VenueError('Derive', `Cannot parse ticker for ${raw.instrument_name}: ${error instanceof Error ? error.message : 'Unexpected response schema'}`); }
}
export function deriveTakerFee(quantity: number, price: number, spot: number, raw?: Pick<DeriveInstrumentRaw, 'taker_fee_rate' | 'mark_price_fee_rate_cap' | 'base_fee'>): number {
  if (quantity <= 0) return 0;
  return Number(raw?.base_fee ?? .5) + Math.min(Number(raw?.taker_fee_rate ?? .0003) * spot * quantity,
    Number(raw?.mark_price_fee_rate_cap ?? .125) * price * quantity);
}

export async function getDeriveMarket() {
  const raws: DeriveInstrumentRaw[] = [];
  for (let page = 1; page <= 20; page++) {
    const data = await deriveRpc<{ instruments: DeriveInstrumentRaw[]; pagination: { num_pages: number } }>('public/get_all_instruments',
      { currency: 'SOL', instrument_type: 'option', expired: false, page, page_size: 1000 });
    raws.push(...data.instruments);
    if (page >= data.pagination.num_pages) break;
    if (page === 20) throw new VenueError('Derive', 'Instrument pagination exceeded safety bound');
  }
  const active = raws.filter(i => i.is_active && i.option_details && i.option_details.expiry * 1000 > Date.now());
  if (!active.length) throw new VenueError('Derive', 'No active SOL options currently listed');
  const expiries = [...new Set(active.map(i => new Date(i.option_details!.expiry * 1000).toISOString().slice(0, 10).replaceAll('-', '')))];
  const tickers: Record<string, Ticker> = {};
  // One chain call per expiry, bounded sequentially to respect public API request budgets.
  for (const expiry of expiries) {
    const data = await deriveRpc<{ tickers: Record<string, Ticker> }>('public/get_tickers', { currency: 'SOL', instrument_type: 'option', expiry_date: Number(expiry) });
    Object.assign(tickers, data.tickers);
  }
  const currency = await deriveRpc<{ spot_price: string }>('public/get_currency', { currency: 'SOL' });
  const instruments = active.map(r => normalizeDeriveInstrument(r, tickers[r.instrument_name]));
  const missing = instruments.filter(i => i.ask === null).length;
  return { instruments, index: positive(currency.spot_price, 'SOL index'), timestamp: Date.now(),
    status: `${instruments.length} listed SOL options; ${missing} without executable best-ask depth. ${deriveConfig().version} ${deriveConfig().network}.`,
    rawInstruments: active };
}

/** A fresh personal_sign over timestamp authenticates reads; no trading authorization is implied. */
export function prepareDeriveLogin(wallet: string, signer = wallet) {
  const timestamp = Date.now().toString();
  return { wallet, signer, timestamp, message: timestamp, method: 'personal_sign', config: deriveConfig() };
}
export interface DeriveWalletCandidate {
  wallet: string; signer: string; version: 'v2' | 'v3'; network: 'mainnet' | 'testnet';
  source: 'default-smart-wallet' | 'connected-owner'; deployed: boolean | null; registrationVerified: false; message: string;
}
const DERIVE_V2_ACCOUNT_FACTORY = '0x000000893A26168158fbeaDD9335Be5bC96592E2' as const;
const DERIVE_V2_ACCOUNT_FACTORY_ABI = parseAbi(['function getAddress(address owner,uint256 salt) view returns (address)']);
/** Public RPC calls only. A predicted default wallet is not proof of venue registration or authorization. */
export async function lookupDeriveAccountWallet(signer: string): Promise<DeriveWalletCandidate> {
  if (!isAddress(signer)) throw new VenueError('Derive', 'A valid connected EVM signer address is required');
  const config = deriveConfig(), owner = getAddress(signer);
  if (config.version === 'v3') return { wallet: owner, signer: owner, version: config.version, network: config.network,
    source: 'connected-owner', deployed: null, registrationVerified: false,
    message: 'Derive v3 uses the registered owner address. This is your connected signer; account registration will be checked when you sign in. Enter a different owner if you use a multisig.' };
  if (config.network !== 'mainnet') throw new VenueError('Derive', 'Default smart-wallet discovery is verified only for v2 mainnet. Enter the account wallet from your Derive testnet account.');
  const client = createPublicClient({ transport: http(process.env.DERIVE_RPC_URL || 'https://rpc.lyra.finance', { timeout: 10000, retryCount: 0 }) });
  try {
    if (await client.getChainId() !== config.chainId) throw new Error('RPC is on the wrong network; Derive v2 mainnet requires chain 957');
    const factoryCode = await client.getBytecode({ address: DERIVE_V2_ACCOUNT_FACTORY });
    if (!factoryCode || factoryCode === '0x') throw new Error('Verified account factory is unavailable on this RPC');
    const wallet = getAddress(await client.readContract({ address: DERIVE_V2_ACCOUNT_FACTORY, abi: DERIVE_V2_ACCOUNT_FACTORY_ABI,
      functionName: 'getAddress', args: [owner, 0n] }));
    const code = await client.getBytecode({ address: wallet });
    const deployed = Boolean(code && code !== '0x');
    return { wallet, signer: owner, version: config.version, network: config.network, source: 'default-smart-wallet', deployed,
      registrationVerified: false, message: `Predicted default Derive v2 account wallet for this signer. ${deployed ? 'Its contract is deployed.' : 'Its contract is not deployed at this address.'} Venue registration is not confirmed until authentication succeeds. Replace this address if you use a custom account wallet.` };
  } catch (error) {
    throw new VenueError('Derive', `Read-only account-wallet lookup failed: ${error instanceof Error ? error.message : 'RPC unavailable'}. You can enter the account address from Derive manually.`);
  }
}
export async function getDeriveAccount(auth: DeriveAuth, subaccountId?: number) {
  let subaccounts: { subaccount_ids: number[]; wallet?: string };
  try {
    subaccounts = await deriveRpc('private/get_subaccounts', { wallet: auth.wallet }, auth);
  } catch (error) {
    if (!(error instanceof DeriveApiError) || error.code !== 14000) throw error;
    const config = deriveConfig();
    throw new VenueError('Derive', `No ${config.version} ${config.network} account was found for ${auth.wallet}. ${config.version === 'v2'
      ? 'Enter the Derive account wallet address (often a smart-contract wallet), which can differ from the connected signing wallet.'
      : 'Use the registered owner address of your Derive v3 account.'} Check the selected network, and leave the subaccount ID blank to discover it. Local wallet verification does not create a Derive account. If no venue account exists, complete setup on Derive itself. Venue error: private/get_subaccounts 14000 Account not found.`);
  }
  if (!subaccounts || !Array.isArray(subaccounts.subaccount_ids)
    || subaccounts.subaccount_ids.some(id => !Number.isSafeInteger(id) || id < 0)
    || new Set(subaccounts.subaccount_ids).size !== subaccounts.subaccount_ids.length
    || (subaccounts.wallet !== undefined && (typeof subaccounts.wallet !== 'string' || subaccounts.wallet.toLowerCase() !== auth.wallet.toLowerCase()))) {
    throw new VenueError('Derive', 'Unexpected subaccount discovery schema or account wallet mismatch; account reconciliation failed closed');
  }
  if (subaccountId !== undefined && (!Number.isSafeInteger(subaccountId) || subaccountId < 0)) throw new VenueError('Derive', 'Subaccount ID must be a nonnegative integer returned by Derive');
  const selected = subaccountId ?? subaccounts.subaccount_ids[0];
  if (selected === undefined) return { subaccountIds: [], subaccountId: null, holdings: [] as OptionHolding[], openOrders: [], portfolio: null, timestamp: Date.now() };
  if (!subaccounts.subaccount_ids.includes(selected)) throw new VenueError('Derive', 'Selected subaccount does not belong to connected wallet');
  const [portfolio, orders] = await Promise.all([
    deriveRpc<any>('private/get_subaccount', { subaccount_id: selected }, auth),
    deriveRpc<any>('private/get_open_orders', { subaccount_id: selected }, auth),
  ]);
  if (!Array.isArray(portfolio.positions) || !Array.isArray(portfolio.collaterals) || !Array.isArray(orders.orders)) {
    throw new VenueError('Derive', 'Unexpected private account schema; position, collateral and order reconciliation failed closed');
  }
  const unsupportedPositions = (portfolio.positions ?? []).filter((p: any) =>
    Number(p.amount) !== 0 && (p.instrument_type !== 'option' || !p.instrument_name.startsWith('SOL-')));
  const collaterals = portfolio.collaterals;
  const unsupportedCollateral = collaterals.filter((c: any) => Number(c.amount) !== 0 &&
    !['USDC', 'USDC-NL'].includes(c.currency ?? c.asset_name ?? c.instrument_name));
  if (unsupportedPositions.length || unsupportedCollateral.length) throw new VenueError('Derive',
    'Account aggregation requires only SOL options and USDC collateral in the selected subaccount. Other derivatives, SOL/volatile collateral, or unrecognized collateral need explicit delta mapping. Select a dedicated subaccount.');
  const holdings: OptionHolding[] = [];
  for (const p of portfolio.positions ?? []) {
    if (p.instrument_type !== 'option' || !p.instrument_name.startsWith('SOL-')) continue;
    const [raw, ticker] = await Promise.all([
      deriveRpc<DeriveInstrumentRaw>('public/get_instrument', { instrument_name: p.instrument_name }),
      deriveRpc<Ticker>('public/get_ticker', { instrument_name: p.instrument_name }),
    ]);
    holdings.push({ instrument: normalizeDeriveInstrument(raw, ticker), quantity: finite(p.amount, 'option position amount'), averagePrice: finite(p.average_price, 'average option price') });
  }
  return { subaccountIds: subaccounts.subaccount_ids, subaccountId: selected, holdings,
    openOrders: orders.orders ?? orders, portfolio, collaterals, timestamp: Date.now() };
}

/** Inspect only the direct browser signer's venue scope, never the worker's separate read-only key. */
export async function getDeriveTradingAccess(auth: DeriveAuth): Promise<DeriveTradingAccess> {
  const config = deriveConfig(), signer = auth.signer ?? auth.wallet;
  if (!isAddress(auth.wallet) || !isAddress(signer)) throw new VenueError('Derive', 'Valid account wallet and trading signer are required');
  const base = { wallet: getAddress(auth.wallet), signer: getAddress(signer), version: config.version, network: config.network, checkedAt: Date.now() };
  if (config.version !== 'v2') return { ...base, scope: 'unknown', expirySec: null, canTrade: null,
    message: 'This scope inspection supports v2. v3 uses different protocol/off-chain scopes; no v2 Admin permission is inferred for v3.' };
  if (base.wallet === base.signer) return { ...base, scope: 'owner', expirySec: null, canTrade: true,
    message: 'Direct owner signing. The venue still checks order authorization, balances and margin on each request.' };
  const response = await deriveRpc<{ public_session_keys: { public_session_key: string; scope: string; expiry_sec: number }[] }>('private/session_keys', { wallet: auth.wallet }, auth);
  if (!response || !Array.isArray(response.public_session_keys) || response.public_session_keys.some(key =>
    !key || !isAddress(key.public_session_key) || typeof key.scope !== 'string' || !Number.isSafeInteger(key.expiry_sec) || key.expiry_sec <= 0))
    throw new VenueError('Derive', 'Unexpected session-key scope schema. Trading permission could not be verified; no order was sent.');
  const matching = response.public_session_keys.filter(key => key.public_session_key.toLowerCase() === signer.toLowerCase());
  if (matching.length > 1) throw new VenueError('Derive', 'Conflicting session-key records for the trading signer. Check permissions in Derive; no order was sent.');
  const key = matching[0];
  if (!key) return { ...base, scope: 'unregistered', expirySec: null, canTrade: false,
    message: 'Derive did not list the connected trading signer. Register its public address in Derive with the permissions required for v2 order execution, then authenticate again.' };
  const scope = ['admin', 'account', 'read_only'].includes(key.scope) ? key.scope as 'admin' | 'account' | 'read_only' : 'unknown';
  const active = key.expiry_sec * 1000 > Date.now();
  const canTrade = active && scope === 'admin';
  return { ...base, scope, expirySec: key.expiry_sec, canTrade,
    message: !active ? 'The connected signer registration has expired. Renew it in Derive and sign fresh authentication.'
      : canTrade ? 'Derive lists active Admin scope for this signer. Admin grants broad account powers, including withdrawals; this check does not change permissions or guarantee an order fill.'
        : `Connected signer scope is ${scope}. Derive v2 private/order requires Admin. Review/register this same public signer address with Admin in the official Derive app, then sign fresh authentication. Admin includes trading and withdrawals; use a reviewed expiry. The separate worker read-only key should remain read-only.` };
}
export async function requireDeriveTradingAccess(auth: DeriveAuth): Promise<DeriveTradingAccess> {
  const access = await getDeriveTradingAccess(auth);
  if (access.canTrade === false) throw new VenueError('Derive', `${access.message} No orders were sent.`);
  return access;
}

export interface PreparedDeriveOrder { params: Record<string, unknown>; typedData: ReturnType<typeof buildDeriveOrderTypedData>; instrument: string; quantity: number; limitPrice: number; estimatedFee: number }
const ACTION_TYPES = { EIP712Domain: EIP712_DOMAIN_FIELDS, Action: [
  { name: 'subaccountId', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'module', type: 'address' },
  { name: 'data', type: 'bytes' }, { name: 'expiry', type: 'uint256' }, { name: 'owner', type: 'address' }, { name: 'signer', type: 'address' },
] } as const;
export function buildDeriveOrderTypedData(raw: DeriveInstrumentRaw, owner: string, subaccountId: number, quantity: string, price: string, maxFeePerUnit: string, nonce: string, expiry: number, signer = owner) {
  const config = deriveConfig();
  const legacyTestnet = config.version === 'v2' && config.network === 'testnet';
  const data = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'int256' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }],
    [raw.base_asset_address, BigInt(raw.base_asset_sub_id), parseUnits(price, 18), parseUnits(quantity, 18), parseUnits(maxFeePerUnit, 18), BigInt(subaccountId), true]);
  return { domain: { name: 'Matching', version: '1.0', chainId: config.chainId,
    verifyingContract: (legacyTestnet ? '0x3cc154e220c2197c5337b7Bd13363DD127Bc0C6E' : '0xeB8d770ec18DB98Db922E9D83260A585b9F0DeAD') as Address },
    primaryType: 'Action' as const, types: { ...ACTION_TYPES },
    message: { subaccountId: subaccountId.toString(), nonce,
      module: (legacyTestnet ? '0x87F2863866D85E3192a35A73b388BD625D83f2be' : '0xB8D20c2B7a1Ad2EE33Bc50eF10876eD3035b5e7b') as Address,
      data, expiry: expiry.toString(), owner: owner as Address, signer: signer as Address } };
}
function validateExecutionMarket(raw: DeriveInstrumentRaw, ticker: Ticker, cap: Pick<OptionExecutionCap, 'instrument' | 'quantity' | 'limitPrice' | 'maxFeePerUnit'>) {
  if (raw.instrument_name !== cap.instrument) throw new VenueError('Derive', `Instrument metadata mismatch for ${cap.instrument}`);
  const market = normalizeDeriveInstrument(raw, ticker), now = Date.now();
  if (!raw.is_active || market.expiry <= now || !Number.isFinite(market.timestamp) || now - market.timestamp > 15_000
    || market.timestamp > now + 5000 || market.ask === null || !Number.isFinite(market.askSize) || market.askSize < cap.quantity)
    throw new VenueError('Derive', `No fresh, sufficient best-ask liquidity for ${market.name}; re-quote`);
  if (market.ask > cap.limitPrice) throw new VenueError('Derive', `Ask for ${market.name} moved to ${market.ask}, above your approved price cap ${cap.limitPrice}; re-quote or review a larger tolerance`);
  const bands = compactTicker(ticker, raw.instrument_name);
  if (bands.maxp != null && cap.limitPrice > positive(bands.maxp, 'maximum permitted option price')
    || bands.minp != null && cap.limitPrice < finite(bands.minp, 'minimum permitted option price'))
    throw new VenueError('Derive', `Venue price band changed for ${market.name}; refresh and review the hedge`);
  if (cap.quantity < market.minSize || cap.quantity > positive(raw.maximum_amount, 'maximum quantity')
    || !new Decimal(cap.quantity).mod(market.sizeStep).isZero() || !new Decimal(cap.limitPrice).mod(market.tickSize).isZero())
    throw new VenueError('Derive', `Quantity or price tick changed for ${market.name}; re-quote`);
  const spot = market.feeModel!.spot;
  const requiredFeePerUnit = new Decimal(raw.base_fee).div(cap.quantity)
    .plus(new Decimal(Math.max(Number(raw.taker_fee_rate), Number(raw.maker_fee_rate))).mul(2).mul(Math.max(spot, cap.limitPrice)));
  if (new Decimal(cap.maxFeePerUnit).lt(requiredFeePerUnit))
    throw new VenueError('Derive', `Fee requirement for ${market.name} exceeds the approved fee cap; re-quote`);
  return market;
}
export async function prepareDeriveOrders(proposal: FitResult, auth: DeriveAuth, subaccountId: number,
  execution: OptionExecutionSettings = { mode: 'quoted-ask', maxSlippagePercent: 0 }): Promise<PreparedDeriveOrder[]> {
  const preview = optionExecutionPreview(proposal, execution);
  if (!proposal.feasible || proposal.source !== 'live' || preview.expiresAt <= Date.now()) throw new VenueError('Derive', 'A current feasible live hedge review is required');
  if (!preview.withinBudget) throw new VenueError('Derive', 'Maximum purchase cost including signed fee caps exceeds your premium budget; lower the tolerance or review a larger budget');
  await requireDeriveTradingAccess(auth);
  const account = await getDeriveAccount(auth, subaccountId);
  if (account.openOrders.length) throw new VenueError('Derive', 'Reconcile existing open orders before creating a new options basket');
  const prepared: PreparedDeriveOrder[] = [];
  const metadata: DeriveInstrumentRaw[] = [];
  for (const cap of preview.legs) metadata.push(await deriveRpc<DeriveInstrumentRaw>('public/get_instrument', { instrument_name: cap.instrument }));
  const chains = new Map<number, Record<string, Ticker>>();
  for (const raw of metadata) if (!chains.has(expiryDate(raw))) chains.set(expiryDate(raw), await executionChain(raw));
  for (let j = 0; j < preview.legs.length; j++) {
    const reviewed = preview.legs[j]!, raw = metadata[j]!, ticker = chains.get(expiryDate(raw))![reviewed.instrument];
    if (!ticker) throw new VenueError('Derive', `No execution ticker for ${reviewed.instrument}`);
    const bands = compactTicker(ticker, raw.instrument_name);
    // Lower the signed price when the current venue price ceiling is tighter; never raise a reviewed cap.
    const cap = { ...reviewed, limitPrice: bands.maxp == null ? reviewed.limitPrice
      : Decimal.min(reviewed.limitPrice, positive(bands.maxp, 'maximum permitted option price')).div(raw.tick_size).floor().mul(raw.tick_size).toNumber() };
    const market = validateExecutionMarket(raw, ticker, cap);
    const quantity = new Decimal(cap.quantity).toFixed();
    const price = new Decimal(cap.limitPrice).toFixed();
    const maxFeePerUnit = cap.maxFeePerUnit;
    const v2 = deriveConfig().version === 'v2';
    const nonce = (BigInt(Date.now()) * (v2 ? 1000n : 1_000_000n) + BigInt(randomInt(v2 ? 1000 : 1_000_000))).toString();
    const expiry = Math.floor(Date.now() / 1000) + (v2 ? 600 : 120);
    const typedData = buildDeriveOrderTypedData(raw, auth.wallet, subaccountId, quantity, price, maxFeePerUnit, nonce, expiry, auth.signer ?? auth.wallet);
    prepared.push({ instrument: raw.instrument_name, quantity: cap.quantity, limitPrice: cap.limitPrice,
      estimatedFee: deriveTakerFee(cap.quantity, market.ask!, market.feeModel!.spot, raw), typedData,
      params: { subaccount_id: subaccountId, instrument_name: raw.instrument_name, direction: 'buy', amount: quantity, limit_price: price,
        max_fee: maxFeePerUnit, nonce: v2 ? Number(nonce) : nonce, signer: auth.signer ?? auth.wallet, signature_expiry_sec: expiry, order_type: 'limit', time_in_force: 'ioc',
        label: `dlmm-${proposal.id}` } });
  }
  return prepared;
}
export async function verifyDeriveOrderSignature(prepared: PreparedDeriveOrder, signature: Hex, auth: DeriveAuth): Promise<void> {
  if (Number(prepared.params.signature_expiry_sec) * 1000 < Date.now()) throw new VenueError('Derive', 'Order signature expired');
  try { assertWalletSigningDomain(prepared.typedData); }
  catch { throw new VenueError('Derive', 'Prepared order uses an incomplete signing domain. Refresh the quote and sign a new basket. No order was sent.'); }
  const m = prepared.typedData.message;
  const expectedSigner = (auth.signer ?? auth.wallet).toLowerCase();
  if (m.signer.toLowerCase() !== expectedSigner || String(prepared.params.signer).toLowerCase() !== expectedSigner
    || m.owner.toLowerCase() !== auth.wallet.toLowerCase()) {
    throw new VenueError('Derive', 'Prepared order account or signer changed. Reconnect/authenticate the reviewed signer and quote again. No order was sent.');
  }
  const signer = await recoverTypedDataAddress({ ...prepared.typedData,
    domain: { ...prepared.typedData.domain, chainId: BigInt(prepared.typedData.domain.chainId) }, message: { ...m,
    subaccountId: BigInt(m.subaccountId), nonce: BigInt(m.nonce), expiry: BigInt(m.expiry) }, signature });
  if (signer.toLowerCase() !== expectedSigner) throw new VenueError('Derive', 'Order signature does not verify for the connected signer. Refresh the page and quote, then sign the new basket. No order was sent.');
}
/** Fail the entire signing preflight before any leg can reach the exchange. */
export async function verifyDeriveBasketSignatures(orders: PreparedDeriveOrder[], signatures: Hex[], auth: DeriveAuth): Promise<void> {
  if (!orders.length || orders.length !== signatures.length) throw new VenueError('Derive', 'Basket signatures are incomplete. No orders were sent.');
  for (let i = 0; i < orders.length; i++) await verifyDeriveOrderSignature(orders[i]!, signatures[i]!, auth);
}
/** Persist each signed intent before calling; after any ambiguous result stop and reconcile by nonce/history. */
export async function executeDeriveOrder(prepared: PreparedDeriveOrder, signature: Hex, auth: DeriveAuth) {
  await verifyDeriveOrderSignature(prepared, signature, auth);
  try {
    const raw = await deriveRpc<DeriveInstrumentRaw>('public/get_instrument', { instrument_name: prepared.instrument });
    const ticker = (await executionChain(raw))[prepared.instrument];
    if (!ticker) throw new VenueError('Derive', `No execution ticker for ${prepared.instrument}`);
    validateExecutionMarket(raw, ticker, { instrument: prepared.instrument, quantity: prepared.quantity, limitPrice: prepared.limitPrice, maxFeePerUnit: String(prepared.params.max_fee) });
  } catch (error) {
    // Public preflight failed before the mutation was attempted: no ambiguous trade to retry/reconcile.
    throw new VenueError('Derive', `Order not sent for ${prepared.instrument}: ${error instanceof DeriveApiError ? `public data error ${error.code}` : error instanceof Error ? error.message : 'Market preflight failed'}`);
  }
  return deriveRpc<any>('private/order', { ...prepared.params, signature }, auth);
}
export async function reconcileDeriveOrders(auth: DeriveAuth, subaccountId: number) {
  return { account: await getDeriveAccount(auth, subaccountId),
    trades: await deriveRpc<any>('private/get_trade_history', { subaccount_id: subaccountId, page: 1, page_size: 100 }, auth) };
}

export interface DeriveOrderStatus { order_id: string; nonce: string | number; instrument_name: string; amount: string;
  filled_amount: string; average_price: string; order_status: string; order_fee: string; subaccount_id: number;
  creation_timestamp: number; last_update_timestamp: number }
export async function getDeriveOrderHistory(auth: DeriveAuth, subaccountId: number, page = 1) {
  return deriveRpc<{ orders: DeriveOrderStatus[]; pagination: { count: number; num_pages: number } }>(
    'private/get_order_history', { subaccount_id: subaccountId, page, page_size: 1000 }, auth);
}
/** Pure read recovery by persisted nonce + instrument, without submitting any replacement orders. */
export async function reconcileDeriveBasket(auth: DeriveAuth, subaccountId: number, prepared: PreparedDeriveOrder[]) {
  const open = await deriveRpc<{ orders: DeriveOrderStatus[] }>('private/get_open_orders', { subaccount_id: subaccountId }, auth);
  const all = [...open.orders];
  const wanted = new Set(prepared.map(p => String(p.params.nonce)));
  for (let page = 1; page <= 20; page++) {
    const history = await getDeriveOrderHistory(auth, subaccountId, page);
    all.push(...history.orders);
    if (all.filter(o => wanted.has(String(o.nonce))).length >= wanted.size || page >= history.pagination.num_pages) break;
  }
  return prepared.map(p => {
    const order = all.find(o => String(o.nonce) === String(p.params.nonce) && o.instrument_name === p.instrument && o.subaccount_id === subaccountId);
    return { instrument: p.instrument, nonce: String(p.params.nonce), resolved: Boolean(order),
      terminal: Boolean(order && ['filled', 'cancelled', 'expired', 'rejected'].includes(order.order_status)), order: order ?? null };
  });
}

export async function registerDeriveReadOnlyKey(auth: DeriveAuth, publicSessionKey: string, expirySec: number) {
  if (deriveConfig().version !== 'v2') throw new VenueError('Derive', 'This read-key registration helper is for v2. v3 needs a separately signed set_session_key action.');
  if (expirySec <= Date.now() / 1000 + 300) throw new Error('Read session expiry must exceed five minutes');
  return deriveRpc('private/register_scoped_session_key', { wallet: auth.wallet, public_session_key: publicSessionKey,
    expiry_sec: expirySec, scope: 'read_only', label: 'DLMM risk reads', ip_whitelist: [] }, auth);
}
export async function deriveSessionAuth(wallet: string, sessionPrivateKey: Hex): Promise<DeriveAuth> {
  const signer = privateKeyToAccount(sessionPrivateKey); const timestamp = Date.now().toString();
  return { wallet, signer: signer.address, timestamp, signature: await signer.signMessage({ message: timestamp }) };
}

/** Streaming depth for review/execution. Top-of-book REST quote remains conservative until deeper levels arrive. */
export function streamDeriveBooks(instruments: string[], onBook: (book: { instrument: string; asks: [number, number][]; bids: [number, number][]; timestamp: number }) => void, onError: (message: string) => void) {
  const c = deriveConfig();
  const ws = new WebSocket(c.version === 'v3' ? c.base.replace('https:', 'wss:') + '/ws' : c.base.replace('https:', 'wss:') + '/ws');
  ws.onopen = () => ws.send(JSON.stringify({ id: 'books', jsonrpc: '2.0', method: 'subscribe', params: { channels: instruments.map(i => `orderbook.${i}.1.20`) } }));
  ws.onmessage = event => {
    try { const message = JSON.parse(String(event.data)); const data = message.params?.data;
      if (data?.instrument_name && Array.isArray(data.asks)) onBook({ instrument: data.instrument_name,
        asks: data.asks.map((l: string[]) => [Number(l[0]), Number(l[1])]), bids: data.bids.map((l: string[]) => [Number(l[0]), Number(l[1])]), timestamp: data.timestamp });
      if (message.error) onError(`Derive subscription rejected: ${message.error.message}`);
    } catch { onError('Invalid Derive book message'); }
  };
  ws.onerror = () => onError('Derive streaming connection failed');
  ws.onclose = () => onError('Derive streaming disconnected; invalidate depth and reconnect with backoff');
  return () => ws.close();
}
