import { createHash } from 'node:crypto';
import { requireUnderlying, isUnderlying, type Underlying } from '../src/shared/assets';
import type { AppState, BybitAccountStatus, MarketSnapshot } from '../src/shared/types';
import { getMeteoraPools, getMeteoraPool, getMeteoraPositions } from '../src/venues/meteora';
import { getBybitMarket, getBybitAccount, bybitConfig, type BybitAuth } from '../src/venues/bybit';
import { getHyperliquidMarket, getHyperliquidAccount, getHyperliquidAttribution, type HyperliquidAttribution, executeHyperliquidOrder, reconcileHyperliquidOrder, cancelHyperliquidOrder, hyperliquidInfo } from '../src/venues/hyperliquid';
import type { ExecutionResult, LiveGateway, OrderIntent } from './engine';
import type { Store } from './store';
import type { AgentVault } from './secrets';

export class Gateway implements LiveGateway {
  private attributionInFlight = new Set<string>();
  private poolCache = new Map<string, {at:number;value:Awaited<ReturnType<typeof getMeteoraPools>>}>();
  private accountCache?: {key:string;at:number;hl:Awaited<ReturnType<typeof getHyperliquidAccount>>;bybit:Awaited<ReturnType<typeof getBybitAccount>>};
  private async discoveredPools(asset: Underlying) {
    const cached=this.poolCache.get(asset);if(cached&&Date.now()-cached.at<300000)return cached.value;
    const value=await getMeteoraPools(asset);this.poolCache.set(asset,{at:Date.now(),value});return value;
  }
  constructor(private store: Store, private vault: AgentVault, private getState: () => AppState) {}
  private attribution(owner: string, underlying: Underlying = 'SOL'): NonNullable<NonNullable<AppState['accounting']>['attribution']> {
    const key = owner.toLowerCase()+':'+underlying;
    let sinceTime = this.store.get<number>('hlAttributionStart:' + key);
    if (sinceTime === undefined) { sinceTime = Date.now(); this.store.set('hlAttributionStart:' + key, sinceTime); }
    const cached = this.store.get<HyperliquidAttribution>('hlAttribution:' + key);
    // Optional attribution must not delay a risk refresh or automatic hedge. One bounded
    // background read per account is cached durably; the next reconciliation exposes it.
    if ((!cached || Date.now() - cached.timestamp >= 30_000) && !this.attributionInFlight.has(key)) {
      this.attributionInFlight.add(key);
      void getHyperliquidAttribution(owner, sinceTime, { underlying }).then(value => {
        this.store.set('hlAttribution:' + key, value);
      }).catch(() => {
        // Validated helper returns null totals on API failure. Unexpected shutdown/storage
        // errors must not turn this optional background job into an unhandled rejection.
      }).finally(() => this.attributionInFlight.delete(key));
    }
    if (!cached) return { optionPremiums: null, perpRealized: null, funding: null, costs: null,
      scope: `Hyperliquid ${underlying} history is loading since monitoring began ${new Date(sinceTime).toISOString()}. Bybit premium/fee history is unavailable; unknown values are not zero.` };
    return { optionPremiums: null, ...cached.totals,
      scope: `${cached.scope} Costs are USDC Hyperliquid fill fees only (builder fee already included). Bybit premium/fee and chain cost history are unavailable. ${cached.warnings.join(' ')}${Date.now() - cached.timestamp > 60_000 ? ' Cached attribution is stale.' : ''}${cached.funding.error ? ' Funding unavailable: ' + cached.funding.error : ''}${cached.fills.error ? ' Fills unavailable: ' + cached.fills.error : ''}` };
  }
  auth(): BybitAuth | undefined {
    const apiKey = process.env.BYBIT_API_KEY?.trim(), apiSecret = process.env.BYBIT_API_SECRET?.trim();
    return apiKey && apiSecret ? { apiKey, apiSecret } : undefined;
  }
  credentialFingerprint() {
    const auth = this.auth();
    return auth ? createHash('sha256').update(JSON.stringify([bybitConfig(), auth.apiKey, auth.apiSecret])).digest('hex') : undefined;
  }
  cacheBybitAccount(account: Awaited<ReturnType<typeof getBybitAccount>>) {
    const strategyReady = !account.riskBlockers?.length;
    const status: BybitAccountStatus = { accountId: account.accountId, checkedAt: account.timestamp,
      canTrade: account.permissions.canTrade && strategyReady, keyCanTrade: account.permissions.canTrade,
      strategyReady, riskBlockers: account.riskBlockers ?? [], excludedAssets: account.excludedAssets ?? [],
      readOnly: account.permissions.readOnly, message: strategyReady ? account.permissions.message : account.riskBlockers!.join(' '),
      availableBalance: account.availableBalance, optionCash: account.optionCash };
    this.store.set('bybitAccountStatus', { status, fingerprint: this.credentialFingerprint(), network: bybitConfig().network });
    return status;
  }
  async bybitAccount(options: { mode?: 'strategy' | 'discovery' } = {}) {
    const auth = this.auth(), connected = this.getState().accounts.bybit;
    if (!auth || !connected) throw new Error('Configure server-side Bybit API credentials and connect the Bybit account');
    const saved = this.store.get<{ fingerprint: string; network: string }>('bybitAccountStatus');
    if (!saved || saved.fingerprint !== this.credentialFingerprint() || saved.network !== bybitConfig().network)
      throw new Error('Bybit credentials or network changed. Reconnect and verify the original account before continuing.');
    const account = await getBybitAccount(auth, options);
    if (account.accountId !== connected.address) throw new Error('Configured Bybit API key belongs to a different account. Reconcile the original account before reconnecting.');
    this.cacheBybitAccount(account); return account;
  }
  ready(state: AppState): string | null {
    if (state.optionsMigration?.blocked) return state.optionsMigration.reason;
    if (this.store.get('bybitBasketPending')) return 'Reconcile the pending Bybit options basket before automatic hedging';
    if (process.env.ENABLE_LIVE_EXECUTION !== 'true') return 'Live execution is disabled on this server. Set ENABLE_LIVE_EXECUTION=true after reviewing the configuration.';
    if (!state.accounts.hyperliquid?.verified) return 'Connect and verify the Hyperliquid owner wallet';
    if (!this.vault.configured || !this.vault.status(state.accounts.hyperliquid.address)?.approved) return 'Authorize the server agent for this Hyperliquid account';
    if (!state.accounts.meteora?.verified) return 'Connect and verify the Meteora owner wallet';
    if (!state.accounts.bybit || !this.auth()) return 'Configure and connect the Bybit API account to reconcile options';
    const cached = this.store.get<{ status: BybitAccountStatus; fingerprint: string }>('bybitAccountStatus');
    if (cached && cached.fingerprint === this.credentialFingerprint() && cached.status.accountId === state.accounts.bybit.address && cached.status.riskBlockers?.length)
      return cached.status.riskBlockers.join(' ');
    if (state.positions.filter(p => state.selectedIds.includes(p.id)).some(p => p.source !== 'live' || p.owner !== state.accounts.meteora?.address)) return 'Live hedging requires positions owned by the connected Solana wallet';
    return null;
  }
  async market(previous: MarketSnapshot, code = 'SOL'): Promise<MarketSnapshot> {
    const underlying = requireUnderlying(code);
    const selected = this.getState().positions.filter(v => v.source === 'live' && (v.underlying??v.base)===underlying && this.getState().selectedIds.includes(v.id));
    const exactPools = [...new Set(selected.map(p => p.pool))];
    const results = await Promise.allSettled([getHyperliquidMarket(underlying), getBybitMarket(underlying), exactPools.length ? Promise.all(exactPools.map(address => getMeteoraPool(address))) : this.discoveredPools(underlying)] as const);
    const [h, d, p] = results;
    const status: Record<string, string> = {};
    status.hyperliquid = h.status === 'fulfilled' ? `Live ${underlying} oracle, mark, funding and contract metadata` : String(h.reason);
    status.bybit = d.status === 'fulfilled' ? d.value.status : String(d.reason);
    status.meteora = p.status === 'fulfilled' ? `${p.value.length} live ${underlying}/stablecoin pools discovered` : String(p.reason);
    const poolAddress = selected[0]?.pool;
    const pool = p.status === 'fulfilled' ? (poolAddress ? p.value.find(v => v.address === poolAddress) : p.value[0]) : undefined;
    if (p.status === 'fulfilled' && h.status === 'fulfilled' && p.value.some(v => Math.abs(v.price / h.value.oracle - 1) * 10000 > this.getState().hedge.settings.maxBasisBps) && exactPools.length) status.meteora = 'At least one selected pool exceeds the configured cross-venue basis limit';
    const missing=[h.status==='rejected'?String(h.reason):'',d.status==='rejected'?String(d.reason):'',p.status==='rejected'?String(p.reason):p.value.length===0?'No verified liquid DLMM pools discovered':''].filter(Boolean);
    if(missing.length) status.support=missing.join('; ');
    return { source: 'live', timestamp: !missing.length && results.every(r => r.status === 'fulfilled') ? Math.min(h.status === 'fulfilled' ? h.value.timestamp : 0, d.status === 'fulfilled' ? d.value.timestamp : 0) : 0,
      referencePrice: h.status === 'fulfilled' ? h.value.oracle : d.status === 'fulfilled' ? d.value.index : previous.source === 'live' ? previous.referencePrice : 0,
      perpMark: h.status === 'fulfilled' ? h.value.mark : previous.source === 'live' ? previous.perpMark : 0,
      fundingRate: h.status === 'fulfilled' ? h.value.funding : 0,
      optionIndex: d.status === 'fulfilled' ? d.value.index : 0,
      stablecoinBasisBps: d.status === 'fulfilled' ? d.value.stablecoinBasisBps : undefined,
      poolPrice: pool?.price ?? 0, instruments: d.status === 'fulfilled' ? d.value.instruments : [],
      perpMaxLeverage:h.status==='fulfilled'?h.value.maxLeverage:undefined,
      perpSizeStep: h.status === 'fulfilled' ? h.value.sizeStep : 0,
      perpMinNotional: h.status === 'fulfilled' ? h.value.minNotional : 10, status };
  }
  positions(owner: string, pool?: string, underlying?: string) { return getMeteoraPositions(owner, pool, underlying===undefined?undefined:requireUnderlying(underlying)); }
  async portfolio(state: AppState) {
    const underlying=requireUnderlying(state.activeUnderlying??'SOL');
    const owner = state.accounts.hyperliquid?.address, solana = state.accounts.meteora?.address;
    if (!owner || !solana) throw new Error('Both Meteora and Hyperliquid owners must be connected');
    const pools = [...new Set(state.positions.filter(p => state.selectedIds.includes(p.id)).map(p => p.pool))];
    const key=owner+':'+state.accounts.bybit?.address+':'+this.credentialFingerprint();
    const cached=!state.hedge.enabled&&!state.hedge.pendingOrder&&this.accountCache?.key===key&&Date.now()-this.accountCache.at<5000?this.accountCache:undefined;
    const [hlRaw, poolPositions, bybit] = await Promise.all([
      cached?Promise.resolve(cached.hl):getHyperliquidAccount(owner, underlying), Promise.all(pools.map(p => getMeteoraPositions(solana, p))),
      cached?Promise.resolve(cached.bybit):this.bybitAccount(),
    ]);
    if(!cached) this.accountCache={key,at:Date.now(),hl:hlRaw,bybit};
    const selectedPerp=hlRaw.allPositions.find(p=>p.coin===underlying);
    const hl={...hlRaw,actualPerp:selectedPerp?.size??0};
    const status = this.vault.status(owner);
    if ((state.hedge.enabled||state.hedge.pendingOrder) && (!Array.isArray(hl.agents) || !hl.agents.some((a: any) => String(a.address).toLowerCase() === status?.address.toLowerCase() && (!a.validUntil || Number(a.validUntil) > Date.now())))) throw new Error('Hyperliquid agent authorization is absent, revoked, or expired');
    const knownPending=new Set(Object.values(state.books??{}).map(b=>b.hedge.pendingOrder).filter(Boolean));
    if(state.hedge.pendingOrder) knownPending.add(state.hedge.pendingOrder);
    if(hl.openOrders.some((o:any)=>!o.cloid||!knownPending.has(o.cloid))) throw new Error('Unmanaged Hyperliquid open orders affect shared margin; reconcile them before hedging');
    if (hl.allPositions.some(p=>p.size!==0&&p.entryPrice===null)) throw new Error('Perpetual entry price is missing; reconcile venue position metadata');
    if (hl.allPositions.some(p=>p.size!==0&&!p.supported)) throw new Error('Unmapped perpetual exposure shares account margin; use an account with supported strategy assets');
    if (hl.spot.balances?.some((b: any) => b.coin !== 'USDC' && Number(b.total) > 0)) throw new Error('Non-USDC Hyperliquid spot balances are outside the configured portfolio boundary. Use a dedicated hedge account.');
    if (bybit.openOrders.length) throw new Error('Bybit has open orders; reconcile them before automatic hedging');
    const solPosition = hl.state.assetPositions.find((p: any) => p.position.coin === underlying)?.position;
    if (hl.state.assetPositions.some((p:any)=>Number(p.position.szi)!==0&&p.position.leverage?.type==='isolated')) throw new Error('Isolated perpetual margin is unsupported by the shared account allocator');
    if (poolPositions.flat().filter(p => state.selectedIds.includes(p.id)).some(p => Math.abs(p.poolPrice / state.market.referencePrice - 1) * 10000 > state.hedge.settings.maxBasisBps)) throw new Error('A selected Meteora pool price exceeds the cross-venue basis limit');
    const optionCash = bybit.optionCash;
    if (!Number.isFinite(optionCash)) throw new Error('Bybit collateral balance is invalid');
    return { positions: poolPositions.flat(), holdings: bybit.holdings.filter(h=>h.instrument.underlying===underlying), allHoldings: bybit.holdings, allPerps: hl.allPositions.map(p=>({coin:p.coin,size:p.size,entryPrice:p.entryPrice??0,marginUsed:p.marginUsed,leverage:p.leverage})), actualPerp: hl.actualPerp, accountTimestamp: hl.timestamp, collateral: hl.equity, collateralInfo: {...hl.collateralInfo,owner}, entryPrice: Number(solPosition?.entryPx || 0), optionCash, attribution: Object.values(state.books??{}).filter(b=>b.selectedIds.length||b.holdings.length||b.hedge.actualPerp).length>1?{optionPremiums:null,perpRealized:null,funding:null,costs:null,scope:'Multi-asset historical attribution unavailable; account NAV includes marked assets and venue cash once.'}:this.attribution(owner, underlying) };
  }
  async order(intent: OrderIntent, owner: string): Promise<ExecutionResult> {
    this.accountCache=undefined;
    const result = await executeHyperliquidOrder(this.vault.privateKey(owner), { coin: requireUnderlying(intent.underlying??'SOL'), size: intent.quantity, limitPrice: intent.price, clientOrderId: intent.cloid as `0x${string}`, reduceOnly: intent.reduceOnly === true || intent.reason === 'Explicit close-hedge request' });
    const status = result.status;
    if (typeof status === 'object' && 'filled' in status) return { status: Number(status.filled.totalSz) + 1e-10 < Math.abs(intent.quantity) ? 'partial' : 'filled', filled: Number(status.filled.totalSz), price: Number(status.filled.avgPx) };
    if (typeof status === 'object' && 'error' in status) return { status: 'rejected', filled: 0, price: 0, reason: String(status.error) };
    return this.reconcile(intent, owner);
  }
  async reconcile(intent: OrderIntent, owner: string): Promise<ExecutionResult> {
    const result = await reconcileHyperliquidOrder(owner, intent.cloid as `0x${string}`);
    if (!result.resolved) return { status: 'unknown', filled: 0, price: 0, reason: 'Venue does not yet resolve the persisted client order ID' };
    const order = result.order.order;
    if (!order?.order?.oid) return { status: 'unknown', filled: 0, price: 0, reason: 'Order status response is missing its exchange identifier' };
    const fills = await hyperliquidInfo<any[]>({ type: 'userFillsByTime', user: owner, startTime: intent.createdAt - 1000, aggregateByTime: false });
    const matched = fills.filter(f => Number(f.oid) === Number(order.order.oid) && f.coin === (intent.underlying??'SOL'));
    const filled = matched.reduce((n, f) => n + Number(f.sz), 0);
    const price = filled > 0 ? matched.reduce((n, f) => n + Number(f.sz) * Number(f.px), 0) / filled : 0;
    if (order.status === 'open' || order.status === 'triggered') return { status: 'resting', filled, price };
    if (order.status === 'filled') {
      if (filled + 1e-8 < Math.abs(intent.quantity)) return { status: 'unknown', filled, price, reason: 'Order is filled but its complete fills have not reached the history endpoint' };
      return { status: 'filled', filled, price };
    }
    if (String(order.status).toLowerCase().includes('cancel') || String(order.status).toLowerCase().includes('reject')) return { status: filled > 0 ? 'partial' : 'rejected', filled, price, reason: `Venue order status: ${order.status}` };
    return { status: 'unknown', filled, price, reason: `Unrecognized order state: ${order.status}` };
  }
  async cancel(intent: OrderIntent, owner: string) { await cancelHyperliquidOrder(this.vault.privateKey(owner), intent.cloid as `0x${string}`, requireUnderlying(intent.underlying??'SOL')); }
  capabilities(state: AppState) {
    const agent = state.accounts.hyperliquid ? this.vault.status(state.accounts.hyperliquid.address) : null;
    const cached = this.store.get<{ status: BybitAccountStatus; fingerprint: string; network: string }>('bybitAccountStatus');
    const status = cached?.fingerprint === this.credentialFingerprint() && cached?.network === bybitConfig().network
      && cached?.status.accountId === state.accounts.bybit?.address ? cached.status : undefined;
    return { liveExecution: process.env.ENABLE_LIVE_EXECUTION === 'true', bybitExecution: process.env.ENABLE_LIVE_EXECUTION === 'true' && Boolean(status?.canTrade),
      optionsVenue: 'bybit' as const, bybitConfigured: Boolean(this.auth()), bybitAuthenticated: Boolean(status),
      bybitNetwork: bybitConfig().network, bybitAccount: status, hyperliquidAgent: Boolean(agent?.approved),
      message: state.mode === 'paper' ? 'Synthetic paper execution. No live orders are sent.' : this.ready(state) || 'Configured for explicit live execution. Exchange signatures and venue limits still apply.' };
  }
}
