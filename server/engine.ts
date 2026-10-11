import { requireUnderlying } from '../src/shared/assets';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AppState, CapitalTracking, CapitalFlow, FitSettings, MarketSnapshot, OptionHolding, Position, RiskSettings } from '../src/shared/types';
import { CAPITAL_TRACKING_KEY, addCapitalFlow, capitalScope, capitalSnapshotsStale, captureCapitalBaseline, reverseCapitalFlow, trackedPnl } from './capital-tracking';
import { demoMarket, demoPosition, demoAssetMarket } from '../src/quant/fixtures';
import { ASSET_CODES, type PortfolioLimits } from '../src/shared/multi-asset';
import { activeCode, stashBook, restoreBook, migrateMultiAsset, blankBook, bookPerpPnl, optionValue, overview, supportReason, type StoredAssetBook } from './multi-asset';
import { currentInventory, modelOption } from '../src/quant/math';
import { fitHedge } from '../src/quant/fit';
import { PROTECTED_REVIEW_MS } from '../src/shared/option-execution';
import { applyPerpFill, DEFAULT_RISK, evaluateHedge, isStrictPositionReduction } from './policy';
import { SerialQueue, Store } from './store';

export interface ExecutionResult { status: 'filled' | 'partial' | 'resting' | 'rejected' | 'unknown'; filled: number; price: number; reason?: string }
export interface OrderIntent { underlying?: string; cloid: string; quantity: number; price: number; createdAt: number; reason: string; appliedFill: number; reduceOnly?: boolean }
export interface LiveGateway {
  market(previous: MarketSnapshot, underlying?: string): Promise<MarketSnapshot>;
  positions(owner: string, pool?: string, underlying?: string): Promise<Position[]>;
  portfolio(state: AppState): Promise<{ positions: Position[]; holdings: OptionHolding[]; actualPerp: number; collateral: number; entryPrice: number; optionCash?: number; accountTimestamp?: number; collateralInfo?: AppState['hyperliquidCollateral'];
    attribution?: NonNullable<NonNullable<AppState['accounting']>['attribution']>; allHoldings?: OptionHolding[]; allPerps?: { coin: string; size: number; entryPrice: number; marginUsed?: number; leverage?: number }[] }>;
  order(intent: OrderIntent, owner: string): Promise<ExecutionResult>;
  reconcile(intent: OrderIntent, owner: string): Promise<ExecutionResult>;
  cancel(intent: OrderIntent, owner: string): Promise<void>;
  ready(state: AppState): string | null;
}
export interface InternalState extends AppState {
  books?: Record<string, StoredAssetBook>; portfolioLimits?: PortfolioLimits; globalPaused?: boolean; commonShock?: {pricePercent:number;ivPoints:number};
  perpEntry: number; lastFundingAt: number; revision: number; hedgedRevision: number;
  intent: OrderIntent | null; initialCapital: number;
  liveAttribution?: NonNullable<NonNullable<AppState['accounting']>['attribution']>;
}
function fingerprint(state: AppState) {
  return createHash('sha256').update(JSON.stringify({ mode: state.mode, optionsVenue: state.optionsVenue, selected: state.selectedIds,
    positions: state.positions.filter(p => state.selectedIds.includes(p.id)).map(p => [p.id, p.benchmarkBins ?? p.bins, p.benchmarkX, p.benchmarkY]),
    holdings: state.holdings.map(h => [h.instrument.venue, h.instrument.network, h.instrument.settleCoin, h.instrument.name, h.quantity]), accounts: state.accounts })).digest('hex');
}
export function initialState(mode: 'paper' | 'live' = 'paper'): InternalState {
  const position = demoPosition(); position.benchmarkBins = structuredClone(position.bins); position.benchmarkAt = position.snapshotAt; position.benchmarkPrice = position.poolPrice;
  const market = demoMarket(Date.now(), position.poolPrice);
  return {
    optionsVenue: 'bybit',
    mode, paperDataSource: 'fixture', source: mode === 'paper' ? 'fixture' : 'live', positions: mode === 'paper' ? [position] : [],
    selectedIds: mode === 'paper' ? [position.id] : [], holdings: [], fit: null, market,
    hedge: { enabled: false, status: 'paused', reason: 'Automation is paused', anchor: null, lastHedgeAt: null,
      actualPerp: 0, desiredPerp: 0, currentDelta: 0, targetDelta: 0, pendingOrder: null, settings: { ...DEFAULT_RISK } },
    accounts: { meteora: null, bybit: null, hyperliquid: null }, events: [],
    balances: { collateral: mode === 'paper' ? 10000 : 0, reserves: mode === 'paper' ? 5000 : 0,
      optionPremiums: 0, perpRealized: 0, funding: 0, costs: 0 },
    capabilities: { liveExecution: false, bybitExecution: false, optionsVenue: 'bybit', hyperliquidAgent: false, message: 'Paper mode uses explicitly synthetic positions, quotes, and fills.' },
    perpEntry: 0, lastFundingAt: Date.now(), revision: 0, hedgedRevision: -1, intent: null,
    initialCapital: mode === 'paper' ? currentInventory([position], market.referencePrice).value + 15000 : 0,
  };
}

/** Preserve the old book verbatim before replacing venue-specific state. No venue calls or orders. */
export function migrateOptionsVenue(store: Store, old: InternalState): InternalState {
  if (old.optionsVenue === 'bybit') return old;
  const archivedAt = Date.now();
  const archiveKey = `archive:derive:${old.mode}`;
  if (!store.get(archiveKey)) store.set(archiveKey, { archivedAt, state: old });
  if (old.mode === 'paper') {
    const fresh = initialState('paper');
    fresh.optionsMigration = { blocked: false, archivedAt, reason: 'Previous Derive paper book archived; a fresh Bybit paper demo is active.' };
    return fresh;
  }
  const blocked = old.holdings.some(h => h.quantity !== 0) || Boolean(store.get('deriveBasketPending'));
  const reason = blocked
    ? 'Legacy Derive positions or unresolved orders remain. Their archived exposure is retained; Bybit execution and automation are blocked until the legacy book is reconciled and migration is reviewed.'
    : 'Options venue changed to Bybit. Derive account history was archived; connect Bybit and explicitly enable automation after reviewing the new portfolio.';
  return { ...old, optionsVenue: 'bybit', optionsMigration: { blocked, archivedAt, reason }, fit: null,
    accounts: { meteora: old.accounts.meteora, hyperliquid: old.accounts.hyperliquid, bybit: null },
    holdings: blocked ? old.holdings : [], balances: { ...old.balances, reserves: 0 }, liveAttribution: undefined,
    market: { ...old.market, timestamp: 0, instruments: [], optionIndex: 0, status: { bybit: 'Awaiting Bybit public market discovery' } },
    hedge: { ...old.hedge, enabled: false, status: 'paused', reason, anchor: null },
    capabilities: { liveExecution: false, bybitExecution: false, optionsVenue: 'bybit', hyperliquidAgent: false, message: reason },
    revision: old.revision + 1, hedgedRevision: -1 };
}

export class Engine {
  state: InternalState;
  readonly queue = new SerialQueue();
  private timer?: ReturnType<typeof setInterval>;
  private queued = false;
  private nextRetryAt = 0;
  private failureCount = 0;
  private nextPublicRefreshAt = 0;
  private publicRefreshFailures = 0;
  private nextCapitalRefreshAt = 0;
  readonly publicRefreshIntervalMs: number;
  gateway?: LiveGateway;
  constructor(readonly store: Store) {
    const configuredInterval = Number(process.env.PUBLIC_MARKET_REFRESH_MS ?? 10_000);
    this.publicRefreshIntervalMs = Math.max(5000, Math.min(60_000, Number.isFinite(configuredInterval) && configuredInterval > 0 ? configuredInterval : 10_000));
    const mode = store.get<'paper' | 'live'>('activeMode') || 'paper';
    this.state = migrateMultiAsset(store, migrateOptionsVenue(store, store.get<InternalState>('state:' + mode) || initialState(mode)));
    // Persisted live intent must be reconciled before any new order after restart.
    if (this.state.mode === 'live' && this.state.hedge.enabled) {
      this.state.hedge.status = 'suspended'; this.state.hedge.reason = 'Restart: reconciling account, authorization, and pending orders';
    }
    for(const b of Object.values(this.state.books??{})) if(this.state.mode==='live'&&b.hedge.enabled){b.hedge.status='suspended';b.hedge.reason='Restart: reconcile account, permissions and pending orders';}
    this.updateDelta(); this.save();
  }
  private runtime = new Map<string, number[]>();
  selectAsset(asset: string) {
    if (!this.state.books?.[asset] && !(ASSET_CODES as readonly string[]).includes(asset)) throw new Error('Unsupported underlying');
    this.runtime.set(activeCode(this.state),[this.nextRetryAt,this.failureCount,this.nextPublicRefreshAt,this.publicRefreshFailures,this.nextCapitalRefreshAt]);
    restoreBook(this.state,asset);
    [this.nextRetryAt,this.failureCount,this.nextPublicRefreshAt,this.publicRefreshFailures,this.nextCapitalRefreshAt]=this.runtime.get(asset)??[0,0,0,0,0];
    this.updateDelta(); this.save(); return this.publicState();
  }
  anyActive() { stashBook(this.state); return Object.values(this.state.books!).some(b=>b.hedge.enabled||b.intent||b.hedge.pendingOrder); }
  allHoldings() {stashBook(this.state);return Object.values(this.state.books!).flatMap(b=>b.holdings);}
  settings(input: {fitSettings?: FitSettings; modelSettings?: NonNullable<StoredAssetBook['modelSettings']>}) {
    stashBook(this.state); Object.assign(this.state.books![activeCode(this.state)]!,input); this.state.fit=null; this.save(); return this.publicState();
  }
  portfolioLimits(limits: PortfolioLimits) {this.state.portfolioLimits=limits;this.event('limits','Account-wide margin limits updated');this.save();return this.publicState();}
  scenarioSettings(pricePercent: number,ivPoints: number) {this.state.commonShock={pricePercent,ivPoints};this.save();return this.publicState();}
  pauseAll() { stashBook(this.state); for(const b of Object.values(this.state.books!)){b.hedge.enabled=false;b.hedge.status='paused';b.hedge.reason='Global pause';} this.state.globalPaused=true;this.event('automation','All automatic hedges paused');this.save();return this.publicState(); }
  private requireMapping() {
    if(this.state.mode!=='live') return;
    stashBook(this.state);const reasons=supportReason(this.state.books![activeCode(this.state)]!,true);
    if(reasons.length) throw new Error(reasons.join('; '));
  }
  private requireSharedLimits(orderQuantity: number) {
    stashBook(this.state);const s=this.state,limits=s.portfolioLimits!;
    const others=Object.entries(s.books!).filter(([a])=>a!==activeCode(s));
    if(s.mode==='live' && others.some(([,b])=>(b.hedge.actualPerp!==0||b.hedge.enabled)&&(!b.market.timestamp||Date.now()-b.market.timestamp>b.hedge.settings.maxDataAgeMs))) throw new Error('Another underlying has stale margin valuation; refresh its price before trading');
    if(others.some(([,b])=>b.intent||b.hedge.pendingOrder)) throw new Error('Another underlying has a pending order; reconcile it before submitting another hedge');
    const gross=others.reduce((n,[,b])=>n+Math.max(Math.abs(b.hedge.actualPerp),b.hedge.enabled?Math.abs(b.hedge.desiredPerp):0)*b.market.perpMark,0);
    const next=s.hedge.actualPerp+orderQuantity;
    // A confirmed position reduction releases margin even if another enabled
    // book's reserved target currently consumes all shared capacity. Unknown
    // outcomes and stale valuations above still block the reduction.
    if(isStrictPositionReduction(s.hedge.actualPerp,next)) return;
    if(gross+Math.abs(next)*s.market.perpMark>limits.maxGrossPerpNotional) throw new Error('Account-wide gross perpetual limit exceeded');
    const localLeverage=Math.min(s.hedge.settings.maxLeverage,limits.maxLeverage,s.market.perpMaxLeverage??Infinity,s.hedge.venueLeverage??Infinity);
    if(Math.abs(next)*s.market.perpMark/localLeverage>this.marginCollateral()*(1-s.hedge.settings.marginBuffer)) throw new Error('Insufficient shared venue margin after other underlying reservations and buffer');
  }
  reconcileHoldings(holdings: OptionHolding[]) {
    stashBook(this.state);
    for(const h of holdings) if(!this.state.books![h.instrument.underlying]) throw new Error('Unmapped option exposure '+h.instrument.underlying);
    for(const [asset,b] of Object.entries(this.state.books!)) {
      const next=holdings.filter(h=>h.instrument.underlying===asset);
      if(JSON.stringify(b.holdings.map(h=>[h.instrument.name,h.quantity]))!==JSON.stringify(next.map(h=>[h.instrument.name,h.quantity]))) {b.revision++;b.fit=null;}
      b.holdings=next;
    }
    const b=this.state.books![activeCode(this.state)]!;this.state.holdings=b.holdings;this.state.revision=b.revision;this.state.fit=b.fit;this.updateDelta();
  }
  reconcilePerps(perps:{coin:string;size:number;entryPrice:number;marginUsed?:number;leverage?:number}[],timestamp?:number) {
    stashBook(this.state);
    for(const p of perps) if(!this.state.books![p.coin]&&p.size!==0) throw new Error('Unmapped perpetual exposure '+p.coin);
    for(const [asset,b] of Object.entries(this.state.books!)) {
      const p=perps.find(p=>p.coin===asset),size=p?.size??0;
      if(!b.intent&&b.hedge.actualPerp!==size) b.revision++;
      b.hedge.actualPerp=size;b.perpEntry=p?.entryPrice??0;b.hedge.venueMarginUsed=p?.marginUsed??0;b.hedge.venueLeverage=p?.leverage;
      if(timestamp&&this.state.accounts.hyperliquid)b.hedge.accountSnapshot={owner:this.state.accounts.hyperliquid.address,timestamp};
    }
    const b=this.state.books![activeCode(this.state)]!;this.state.hedge=b.hedge;this.state.perpEntry=b.perpEntry;this.state.revision=b.revision;this.updateDelta();
  }
  private async tickAsset(asset: string) {
    if (!this.state.books?.[asset]) return;
    const active=activeCode(this.state);
    try {
      this.selectAsset(asset);
      try {await this.tick();} catch(error){
        this.failureCount++;const retryMs=Math.min(60000,2000*2**Math.min(5,this.failureCount-1));this.nextRetryAt=Date.now()+retryMs;
        this.suspend(error instanceof Error?error.message:'Asset reconciliation failed');
        this.event('retry',`Account reconciliation retries after ${retryMs/1000}s`,{nextRetryAt:this.nextRetryAt});this.save();
      }
    } finally {this.selectAsset(active);}
  }
  async tickAll() {
    stashBook(this.state);
    for(const asset of Object.keys(this.state.books!)) await this.tickAsset(asset);
  }
  private async tickWorkerBooks() {
    // Release the queue between books so global pause and UI reads cannot wait
    // behind eight separate venue refreshes. Each book cycle remains serialized.
    for(const asset of Object.keys(this.state.books!)) await this.queue.run(()=>this.tickAsset(asset));
  }
  selected() { return this.state.positions.filter(p => this.state.selectedIds.includes(p.id)); }
  publicState(): AppState {
    const s = this.state, spot = s.market.referencePrice;
    stashBook(s);
    const books=Object.values(s.books!), assets=overview(s);
    const values=books.map(optionValue), optionsValue=values.some(v=>v==null)?null:values.reduce<number>((n,v)=>n+v!,0);
    const unavailable=books.flatMap(b=>b.holdings.filter(h=>h.quantity!==0 && h.instrument.mark==null && h.instrument.iv==null).map(h=>h.instrument.name));
    const perpUnrealized=books.reduce((n,b)=>n+bookPerpPnl(b),0);
    const lpValue=assets.some(a=>a.lpValue==null)?null:assets.reduce((n,a)=>n+a.lpValue!,0);
    const equity=optionsValue==null||lpValue==null?null:lpValue+optionsValue+s.balances.reserves+this.effectiveCollateral();
    const shock=s.commonShock??{pricePercent:1,ivPoints:1};
    const sum=(key:'cashDelta'|'modelCashDelta'|'gammaPnl1Pct'|'vega'|'theta')=>assets.some(a=>a[key]==null)?null:assets.reduce((n,a)=>n+a[key]!,0);
    const deltaPnl=sum('modelCashDelta')==null?null:sum('modelCashDelta')!*shock.pricePercent/100;
    const gammaPnl=sum('gammaPnl1Pct')==null?null:sum('gammaPnl1Pct')!*shock.pricePercent**2;
    const vegaPnl=sum('vega')==null?null:sum('vega')!*shock.ivPoints;
    const portfolio={assets,globalPaused:s.globalPaused??false,limits:s.portfolioLimits!,
      grossPerpNotional:books.reduce((n,b)=>n+Math.abs(b.hedge.actualPerp)*b.market.perpMark,0),
      marginRequired:books.reduce((n,b)=>n+Math.max(b.hedge.venueMarginUsed??0,Math.abs(b.hedge.actualPerp)*b.market.perpMark/Math.min(b.hedge.settings.maxLeverage,s.portfolioLimits!.maxLeverage,b.market.perpMaxLeverage??Infinity,b.hedge.venueLeverage??Infinity)),0),
      commonShock:{...shock,deltaPnl,gammaPnl,vegaPnl,thetaPerDay:sum('theta'),totalPnl:deltaPnl==null||gammaPnl==null||vegaPnl==null?null:deltaPnl+gammaPnl+vegaPnl}};
    const tracking = s.mode === 'live' ? this.store.get<CapitalTracking>(CAPITAL_TRACKING_KEY) : undefined;
    const livePnl = trackedPnl(s, tracking, spot > 0 && Number.isFinite(spot) ? equity : null);
    const attribution = s.mode === 'paper' ? { optionPremiums: s.balances.optionPremiums, perpRealized: s.balances.perpRealized, funding: s.balances.funding, costs: s.balances.costs, scope: 'Paper ledger since account reset.' }
      : s.liveAttribution ?? { optionPremiums: null, perpRealized: null, funding: null, costs: null, scope: 'Live historical attribution has not been reconciled; unknown values are not zero.' };
    return { ...structuredClone(s), portfolio, capitalTracking: tracking, accounting: { equity, perpUnrealized, optionsValue, initialCapital: tracking?.baseline.equity ?? s.initialCapital,
      pnl: s.mode === 'paper' && equity !== null ? equity - s.initialCapital : s.mode === 'live' ? livePnl.pnl : null,
      pnlStartedAt: tracking?.baseline.startedAt, netCapitalFlows: s.mode === 'live' ? livePnl.netFlows : undefined,
      pnlUnavailableReason: s.mode === 'live' ? livePnl.reason : null, pnlStale: s.mode === 'live' && capitalSnapshotsStale(s),
      valuationComplete: equity !== null, attribution,
      scope: (s.optionsMigration?.blocked ? s.optionsMigration.reason : 'Selected LPs across underlyings, connected Bybit options and stablecoin cash, and Hyperliquid account equity counted once. External wallet balances excluded; USDT/USDC use approximate parity.')
        + (s.mode === 'live' && s.capabilities.bybitAccount?.excludedAssets?.length ? ` Other Unified-account assets (${s.capabilities.bybitAccount.excludedAssets.map(a => a.coin).join(', ')}) are excluded from strategy capital and delta; this is not a valuation of the entire Bybit account. Trading is blocked while that exposure remains.` : '')
        + (unavailable.length ? ` Option valuation unavailable: ${unavailable.join(', ')}.` : '') } };
  }
  private resetCapitalBaseline() {
    if (this.state.mode !== 'paper') return;
    const equity = this.publicState().accounting!.equity;
    if (equity === null) throw new Error('A complete paper portfolio valuation is required before changing its capital baseline.');
    this.state.initialCapital = equity;
    this.event('capital-baseline', 'Paper NAV baseline restarted after changing the selected portfolio boundary. Original bin IL benchmarks remain preserved.');
  }
  async startCapitalTracking(restart = false) {
    if (this.state.mode !== 'live') throw new Error('Live mode is required to start live capital tracking');
    const existing = this.store.get<CapitalTracking>(CAPITAL_TRACKING_KEY);
    if (existing && !restart) return this.publicState(); // Retries cannot silently reset an existing baseline.
    if (this.state.intent || this.state.hedge.pendingOrder || this.store.get('bybitBasketPending')) throw new Error('Reconcile pending orders before starting a capital baseline');
    if (!this.gateway) throw new Error('Live account adapter unavailable');
    await this.refresh(); await this.syncLivePortfolio();
    const snapshot = this.publicState(), tracking = captureCapitalBaseline(snapshot);
    if (existing) this.store.set('capitalTrackingArchive:' + existing.baseline.id, existing);
    this.store.set('capitalSnapshot:' + tracking.baseline.id, snapshot);
    this.store.set(CAPITAL_TRACKING_KEY, tracking);
    this.event('capital-baseline', 'Live P&L tracking started from current marked capital', { id: tracking.baseline.id, equity: tracking.baseline.equity });
    this.save(); return this.publicState();
  }
  recordCapitalFlow(input: Omit<CapitalFlow, 'recordedAt' | 'reversedAt'>) {
    if (this.state.mode !== 'live') throw new Error('Cash-flow adjustments are for the live tracking ledger');
    const existing = this.store.get<CapitalTracking>(CAPITAL_TRACKING_KEY);
    if (!existing) throw new Error('Start a capital baseline before recording external movements');
    if (capitalScope(this.state) !== existing.baseline.scopeKey) throw new Error('Restore the tracked portfolio scope before recording a cash flow');
    const next = addCapitalFlow(existing, { ...input, recordedAt: Date.now() });
    if (next !== existing) {
      this.store.set(CAPITAL_TRACKING_KEY, next);
      this.event('capital-flow', `Recorded external ${input.kind} of ${input.amount} USDT equivalent: ${input.note}`, { ...input });
      this.save();
    }
    return this.publicState();
  }
  reverseCapitalFlowEntry(id: string) {
    if (this.state.mode !== 'live') throw new Error('Cash-flow adjustments are for the live tracking ledger');
    const tracking = this.store.get<CapitalTracking>(CAPITAL_TRACKING_KEY);
    if (!tracking) throw new Error('Capital baseline unavailable');
    const next = reverseCapitalFlow(tracking, id);
    this.store.set(CAPITAL_TRACKING_KEY, next);
    if (!tracking.flows.find(f => f.id === id)?.reversedAt) this.event('capital-flow-correction', 'Reversed an incorrect cash-flow ledger entry; no funds moved', { id });
    this.save(); return this.publicState();
  }
  currentFingerprint() { return fingerprint(this.state); }
  save() { stashBook(this.state); this.store.set('state:' + this.state.mode, this.state); }
  event(type: string, message: string, data?: Record<string, unknown>) {
    const entry = { id: randomUUID(), timestamp: Date.now(), type, message, data: { ...data, underlying: activeCode(this.state) } };
    this.store.appendEvent(this.state.mode, entry); this.state.events.unshift(entry);
    this.state.events = this.state.events.slice(0, 1000);
  }
  changed(message: string) { this.state.revision++; this.state.fit = null; this.updateDelta(); this.event('portfolio', message); this.save(); }
  updateDelta() {
    const s = this.state, spot = s.market.referencePrice;
    const inventory = currentInventory(this.selected(), spot).delta;
    const options = s.holdings.reduce((sum, h) => {
      if (h.quantity === 0) return sum;
      const g = h.instrument.greeks;
      const delta = g ? g.delta * h.instrument.multiplier : h.instrument.iv !== null ? modelOption(h.instrument, spot).delta : NaN;
      return sum + delta * h.quantity;
    }, 0);
    const target = s.hedge.settings.targetMode === 'preserve-hodl' ? this.selected().reduce((sum, p) => sum + p.benchmarkX, 0) : 0;
    s.hedge.currentDelta = inventory + options + s.hedge.actualPerp;
    s.hedge.targetDelta = target; s.hedge.desiredPerp = target - inventory - options;
  }
  start() {
    this.timer = setInterval(() => {
      if (this.queued) return;
      this.queued = true;
      void this.tickWorkerBooks().catch(error => {
        this.failureCount++;
        const retryMs = Math.min(60_000, 2000 * 2 ** Math.min(5, this.failureCount - 1));
        this.nextRetryAt = Date.now() + retryMs;
        this.suspend(error instanceof Error ? error.message : 'Hedge worker failed');
        this.event('retry', `Market/account reconciliation will retry after ${retryMs / 1000}s`, { nextRetryAt: this.nextRetryAt }); this.save();
      }).finally(() => { this.queued = false; });
    }, 2000);
  }
  stop() { if (this.timer) clearInterval(this.timer); }
  suspend(reason: string) {
    if (this.state.hedge.reason !== reason || this.state.hedge.status !== 'suspended') this.event('suspended', reason);
    this.state.hedge.status = 'suspended'; this.state.hedge.reason = reason; this.save();
  }
  async mode(mode: 'paper' | 'live') {
    if (this.anyActive()) throw new Error('Pause all assets and reconcile pending hedges before changing trading mode.');
    this.save(); this.state = migrateMultiAsset(this.store, migrateOptionsVenue(this.store, this.store.get<InternalState>('state:' + mode) || initialState(mode)));
    this.store.set('activeMode', mode); this.updateDelta(); this.event('mode', `Opened ${mode} account book`); this.save();
    if (mode === 'live') { try { await this.refresh(); } catch (error) { this.event('market-error', String(error)); this.save(); } }
    return this.publicState();
  }
  reset(multi = false) {
    if (this.state.mode !== 'paper') throw new Error('Demo reset is only available in paper mode.');
    if (this.anyActive()) throw new Error('Pause all assets and reconcile orders before resetting paper books');
    this.state = migrateMultiAsset(this.store,initialState());
    if(multi) { this.state.balances.collateral=40000;this.state.balances.reserves=20000; for(const a of ASSET_CODES) this.state.books![a]=blankBook(a,'paper',true); Object.assign(this.state,this.state.books!.SOL); }
    this.updateDelta(); this.state.initialCapital=this.publicState().accounting!.equity??0; this.event('demo', multi?'Eight-underlying deterministic paper portfolio loaded':'SOL paper study reset'); this.save();
    return this.publicState();
  }
  select(ids: string[]) {
    if (this.state.mode === 'paper' && this.publicState().accounting!.equity === null) throw new Error('Refresh missing option valuation before changing the paper portfolio boundary.');
    if (!ids.every(id => this.state.positions.some(p => p.id === id))) throw new Error('Position selection contains an unknown position');
    if (this.state.hedge.enabled && !ids.length) throw new Error('Pause hedging before clearing all positions');
    this.state.selectedIds = [...new Set(ids)]; this.resetCapitalBaseline(); this.changed('Selected position set changed'); return this.publicState();
  }
  addHypothetical(name: string, bins: Position['bins']) {
    if (this.state.mode !== 'paper') throw new Error('Hypothetical positions belong in paper mode');
    if (this.publicState().accounting!.equity === null) throw new Error('Refresh missing option valuation before changing the paper portfolio boundary.');
    const p: Position = { id: randomUUID(), pool: 'hypothetical', name, source: 'hypothetical', base: activeCode(this.state), quote: 'USDC',
      snapshotAt: Date.now(), bins, benchmarkBins: structuredClone(bins), benchmarkAt: Date.now(), benchmarkPrice: this.state.market.referencePrice, benchmarkX: bins.reduce((n, b) => n + b.x, 0),
      benchmarkY: bins.reduce((n, b) => n + b.y, 0), baseFees: 0, quoteFees: 0, poolPrice: this.state.market.referencePrice,
      notes: ['User-entered hypothetical human-unit inventory; not an on-chain position.'] };
    this.state.positions.push(p); this.state.selectedIds = [p.id]; this.resetCapitalBaseline(); this.changed('Hypothetical position added'); return this.publicState();
  }
  async importPositions(owner: string, pool?: string) {
    if (this.state.mode === 'paper' && this.publicState().accounting!.equity === null) throw new Error('Refresh missing option valuation before changing the paper portfolio boundary.');
    if (!this.gateway) throw new Error('Venue integrations are not configured');
    const positions = await this.gateway.positions(owner, pool, pool?undefined:activeCode(this.state));
    if (!positions.length) throw new Error('No verified stablecoin DLMM positions found for the selected underlying');
    const original=activeCode(this.state); stashBook(this.state);
    for (const p of positions) {
      const asset=p.underlying??p.base;
      if(!this.state.books![asset]) {
        const b=blankBook('SOL',this.state.mode);
        b.market={...b.market,source:'live',timestamp:p.snapshotAt,referencePrice:p.poolPrice,poolPrice:p.poolPrice,optionIndex:0,perpMark:0,perpSizeStep:0,instruments:[],status:{support:p.hedgeMapping?.reason??'Unverified underlying mapping'}};
        b.source='live';b.paperDataSource='live';this.state.books![asset]=b;
      }
      const book=this.state.books![asset]!, old=book.positions.find(v=>v.id===p.id);
      const next=old?{...p,benchmarkBins:old.benchmarkBins??old.bins,benchmarkAt:old.benchmarkAt,benchmarkPrice:old.benchmarkPrice,benchmarkX:old.benchmarkX,benchmarkY:old.benchmarkY}
        :{...p,benchmarkBins:structuredClone(p.bins),benchmarkAt:p.snapshotAt,benchmarkPrice:p.poolPrice};
      book.positions=book.positions.filter(v=>v.id!==p.id);book.positions.push(next);
      book.selectedIds=[...new Set([...book.selectedIds,p.id])];book.revision++;book.fit=null;
    }
    // The foreground copy must be loaded without stashing its pre-import data over the updated book.
    const chosen=positions[0]!.underlying??positions[0]!.base;
    Object.assign(this.state,this.state.books![chosen]);this.state.activeUnderlying=chosen;
    this.resetCapitalBaseline();this.changed('On-chain positions imported with mint-verified asset grouping');return this.publicState();
  }

  rebase() {
    if (this.state.hedge.enabled) throw new Error('Pause automatic hedging before rebasing the benchmark');
    for (const p of this.selected()) {
      p.benchmarkBins = structuredClone(p.bins); p.benchmarkX = p.bins.reduce((n, b) => n + b.x, 0); p.benchmarkY = p.bins.reduce((n, b) => n + b.y, 0);
      p.benchmarkAt = Date.now(); p.benchmarkPrice = this.state.market.referencePrice;
      p.notes = p.notes.filter(n => !n.startsWith('Principal changed since original benchmark') && !n.startsWith('Current principal/allocation differs from original benchmark'));
    }
    this.changed('IL benchmark explicitly rebased to current LP inventory'); return this.publicState();
  }
  private benchmarkMatches(position: Position): boolean {
    if (!position.benchmarkBins) return true;
    const original = new Map(position.benchmarkBins.map(b => [b.id, b]));
    if (original.size !== position.bins.length) return false;
    return position.bins.every(b => {
      const old = original.get(b.id); if (!old) return false;
      const principal = old.price * old.x + old.y;
      return Math.abs(old.price - b.price) <= Math.max(1e-10, old.price * 1e-10)
        && Math.abs(principal - (b.price * b.x + b.y)) <= Math.max(.01, Math.abs(principal) * .0001);
    });
  }
  private ensureBenchmarkMatches() {
    if (this.selected().some(p => !this.benchmarkMatches(p))) throw new Error('Current bin allocation or principal differs from the original IL benchmark. Pause and explicitly rebase after reviewing position changes before quoting new protection.');
  }
  private applyPaperReference(price: number) {
    for (const p of this.state.positions) {
      p.bins = (p.benchmarkBins ?? p.bins).map(b => {
        const ell = b.price * b.x + b.y;
        return { ...b, x: price < b.price ? ell / b.price : price > b.price ? 0 : b.x, y: price > b.price ? ell : price < b.price ? 0 : b.y };
      });
      if (p.source === 'live') p.source = 'hypothetical';
      p.poolPrice = price; p.snapshotAt = Date.now();
    }
  }
  private validatePaperMarket(market: MarketSnapshot) {
    if (market.source !== 'live' || !(market.referencePrice > 0) || !Number.isFinite(market.referencePrice)
      || !Number.isFinite(market.timestamp) || Date.now() - market.timestamp > this.state.hedge.settings.maxDataAgeMs || market.timestamp > Date.now() + 5000) {
      throw new Error('Fresh public live prices are unavailable; paper feed was not switched or advanced.');
    }
  }
  private async loadPublicMarket(): Promise<MarketSnapshot> {
    // Schedule from attempts/completion, not a venue timestamp. A partial response
    // deliberately has timestamp=0 and must not trigger requests every worker tick.
    if (!this.gateway) throw new Error('Public live market adapter is not configured.');
    this.nextPublicRefreshAt = Date.now() + this.publicRefreshIntervalMs;
    try {
      if(!(ASSET_CODES as readonly string[]).includes(activeCode(this.state))) return this.state.market;
      const market = await this.gateway.market(this.state.market, activeCode(this.state));
      const fresh = market.source === 'live' && Number.isFinite(market.timestamp) && market.timestamp > 0
        && Date.now() - market.timestamp <= this.state.hedge.settings.maxDataAgeMs && market.timestamp <= Date.now() + 5000
        && [market.referencePrice, market.perpMark, market.optionIndex, market.poolPrice].every(value => Number.isFinite(value) && value > 0);
      if (fresh) {
        this.publicRefreshFailures = 0;
        this.nextPublicRefreshAt = Date.now() + this.publicRefreshIntervalMs;
        return market;
      }
      this.publicRefreshFailures++;
      const retryMs = Math.min(60_000, this.publicRefreshIntervalMs * 2 ** Math.min(4, this.publicRefreshFailures - 1));
      this.nextPublicRefreshAt = Date.now() + retryMs;
      return { ...market, timestamp: 0, status: { ...market.status,
        publicFeed: `Public snapshot is partial or stale; retry in ${retryMs / 1000}s. Automatic orders require fresh complete data.` } };
    } catch (error) {
      this.publicRefreshFailures++;
      const retryMs = Math.min(60_000, this.publicRefreshIntervalMs * 2 ** Math.min(4, this.publicRefreshFailures - 1));
      this.nextPublicRefreshAt = Date.now() + retryMs;
      throw error;
    }
  }
  private async refreshPublicIfDue(force: boolean) {
    if (!force && Date.now() < this.nextPublicRefreshAt) return;
    this.nextPublicRefreshAt = Date.now() + this.publicRefreshIntervalMs;
    try { await this.refresh(false); }
    catch (error) {
      // Public feed failures are separate from account/order retries. Keep the
      // dashboard responsive and stale-marked even if no wallet is connected.
      const reason = error instanceof Error ? error.message : 'Public market refresh failed';
      this.state.market = { ...this.state.market, timestamp: 0, status: { ...this.state.market.status,
        publicFeed: `Public refresh failed; next retry at ${new Date(this.nextPublicRefreshAt).toISOString()}. ${reason}` } };
      this.event('market-error', 'Public market refresh failed; retained values are stale', { nextRetryAt: this.nextPublicRefreshAt }); this.save();
    }
  }
  async paperFeed(source: 'fixture' | 'live') {
    const s = this.state;
    if (s.mode !== 'paper') throw new Error('Paper feed settings are only available in paper mode.');
    if (s.hedge.enabled || s.intent) throw new Error('Pause paper hedging and reconcile pending orders before changing the feed.');
    if (s.holdings.some(h => h.quantity !== 0) || Math.abs(s.hedge.actualPerp) > 1e-10) throw new Error('Close paper positions or reset the paper account before switching fixture/live feeds. Synthetic option contracts cannot be moved to a live chain.');
    let market: MarketSnapshot;
    if (source === 'live') {
      if (!this.gateway) throw new Error('Public live market adapter is not configured.');
      market = await this.loadPublicMarket(); this.validatePaperMarket(market);
    } else market = demoAssetMarket(requireUnderlying(activeCode(s)), Date.now(), s.market.referencePrice);
    s.paperDataSource = source; s.source = source === 'live' ? 'live' : 'fixture'; s.market = market; this.applyPaperReference(market.referencePrice);
    s.hedge.anchor = null; s.hedge.lastHedgeAt = null;
    this.refreshPaperHoldings(); this.changed(source === 'live' ? 'Paper execution now uses live public prices and a simulated fixed-bin portfolio.' : 'Paper execution now uses synthetic fixture prices.');
    return this.publicState();
  }
  paperPrice(price: number) {
    if (this.state.mode !== 'paper') throw new Error('Price scenarios are only available in paper mode');
    if (this.state.paperDataSource === 'live') throw new Error('Manual price scenarios are disabled while the paper feed uses live public prices.');
    this.accruePaperFunding();
    this.state.market = demoAssetMarket(requireUnderlying(activeCode(this.state)), Date.now(), price); this.state.market.poolPrice = price;
    this.applyPaperReference(price);
    this.refreshPaperHoldings(); this.state.fit = null; this.updateDelta(); this.event('scenario', `Paper underlying price set to ${price.toFixed(4)} USDC`); this.save(); return this.publicState();
  }
  private refreshPaperHoldings() {
    const now = Date.now(), s = this.state;
    for (const h of [...s.holdings]) {
      if (h.instrument.expiry <= now) {
        const payoff = Math.max(h.instrument.type === 'call' ? s.market.referencePrice - h.instrument.strike : h.instrument.strike - s.market.referencePrice, 0) * h.instrument.multiplier * h.quantity;
        s.balances.reserves += payoff; s.holdings = s.holdings.filter(v => v !== h); s.revision++;
        this.event('settlement', `Paper option settled: ${h.instrument.name}`, { payoff });
      } else {
        const i = s.market.instruments.find(i => i.name === h.instrument.name);
        if (i) h.instrument = i;
        else if (h.instrument.iv !== null && Number.isFinite(h.instrument.iv) && h.instrument.iv >= 0) {
          const g = modelOption(h.instrument, s.market.referencePrice), m = h.instrument.multiplier;
          h.instrument = { ...h.instrument, mark: g.price / m, source: 'hypothetical', greeks: { delta: g.delta / m, gamma: g.gamma / m, vega: g.vega / m, theta: g.theta / m }, timestamp: now };
          s.market.status.paperOptionMarks = 'Some simulated holdings use a model mark and prior IV because their expiry is absent from the current chain; these Greeks are hypothetical.';
        } else {
          h.instrument = { ...h.instrument, source: 'hypothetical', timestamp: 0 };
          s.market.status.paperOptionMarks = 'A held option has no fresh chain quote or usable IV. Its prior mark is retained; automatic hedging is suspended by the stale-data check.';
        }
      }
    }
  }
  async refresh(resetBackoff = true) {
    if(!(ASSET_CODES as readonly string[]).includes(activeCode(this.state))) {
      if(!this.gateway) throw new Error('Watch-only pool reader unavailable');
      for(const old of this.selected()) {
        const current=(await this.gateway.positions(old.owner!,old.pool)).find(p=>p.id===old.id);
        if(!current) throw new Error('Watch-only position no longer found');
        Object.assign(old,current,{benchmarkBins:old.benchmarkBins??old.bins,benchmarkX:old.benchmarkX,benchmarkY:old.benchmarkY});
      }
      const price=this.selected()[0]?.poolPrice??0;this.state.market={...this.state.market,referencePrice:price,poolPrice:price,timestamp:Date.now()};this.updateDelta();this.save();return this.publicState();
    }
    if (this.state.mode === 'paper') {
      const spot = this.state.market.referencePrice;
      if (this.state.paperDataSource === 'live') {
        if (!this.gateway) throw new Error('Public live market adapter is not configured.');
        const market = await this.loadPublicMarket(); this.validatePaperMarket(market);
        this.state.market = market; this.state.source = 'live'; this.applyPaperReference(market.referencePrice);
      } else { this.state.market = demoAssetMarket(requireUnderlying(activeCode(this.state)), Date.now(), spot); this.state.market.poolPrice = spot; }
      this.refreshPaperHoldings(); this.state.positions.forEach(p => p.snapshotAt = Date.now());
    } else {
      if (!this.gateway) throw new Error('Live venue adapter is unavailable');
      this.state.market = await this.loadPublicMarket();
      this.state.source = 'live';
    }
    if (resetBackoff) { this.failureCount = 0; this.nextRetryAt = 0; }
    this.updateDelta(); this.save(); return this.publicState();
  }
  quote(settings: FitSettings) {
    if (this.state.optionsMigration?.blocked) throw new Error(this.state.optionsMigration.reason);
    if (!this.selected().length) throw new Error('Select a position before quoting a hedge');
    this.ensureBenchmarkMatches();
    if (this.state.mode === 'live' && this.state.market.source !== 'live') throw new Error('Live executable market data is unavailable');
    if (this.state.market.instruments.some(i => i.venue === 'bybit') && (!Number.isFinite(this.state.market.stablecoinBasisBps)
      || Math.abs(this.state.market.stablecoinBasisBps!) > this.state.hedge.settings.maxBasisBps)) throw new Error('USDT/USDC basis is unavailable or exceeds the configured basis limit. Refresh markets before quoting.');
    this.requireMapping();
    const fit = fitHedge(this.selected(), this.state.market.instruments, this.state.holdings, settings, this.state.market.referencePrice, Date.now(), this.state.hedge.settings.maxDataAgeMs);
    fit.fingerprint = fingerprint(this.state); this.state.fit = fit; stashBook(this.state); this.state.books![activeCode(this.state)]!.fitSettings = settings; this.save(); return fit;
  }
  validateQuote(id: string, protectedReview = false) {
    this.ensureBenchmarkMatches();
    const fit = this.state.fit;
    if (!fit || fit.id !== id) throw new Error('Quote has changed; request a new hedge quote');
    if (protectedReview && this.state.mode !== 'live') throw new Error('Protected quote review is only available for live execution');
    const expiresAt = protectedReview ? fit.createdAt + PROTECTED_REVIEW_MS : fit.expiresAt;
    if (Date.now() >= expiresAt) throw new Error('Quote review has expired; request a fresh executable quote');
    if (fingerprint(this.state) !== fit.fingerprint) throw new Error('Portfolio changed after this quote; re-quote the hedge');
    if (fit.settings.objective === 'gamma') {
      if (!fit.gammaRisk) throw new Error('Gamma calculation changed; request a new gamma quote');
      const now = Date.now();
      if (now-this.state.market.timestamp > this.state.hedge.settings.maxDataAgeMs) throw new Error('Gamma reference market is stale; refresh and re-quote');
      const proposedHoldings = [...this.state.holdings, ...fit.legs.map(l => ({instrument:l.instrument,quantity:l.quantity,averagePrice:l.instrument.ask ?? 0}))];
      const check = fitHedge(this.selected(), this.state.market.instruments, proposedHoldings,
        {...fit.settings,budget:0,maxLegs:0}, this.state.market.referencePrice, now, this.state.hedge.settings.maxDataAgeMs).gammaRisk!;
      if (Math.abs(check.before-check.target) > check.tolerance+1e-10) throw new Error('Market gamma moved outside the reviewed tolerance; re-quote the gamma hedge');
    }
    if (!fit.feasible) throw new Error(fit.reasons.join('; ') || 'Hedge constraints are infeasible');
    if (!fit.legs.length) throw new Error('There are no incremental option purchases in this quote');
    if (fit.legs.some(l => l.instrument.ask === null || !Number.isFinite(l.instrument.ask) || l.instrument.expiry <= Date.now()
      || (!protectedReview && Date.now() - l.instrument.timestamp > this.state.hedge.settings.maxDataAgeMs))) throw new Error('Executable option prices are stale or expired');
    return fit;
  }
  executePaperQuote(id: string) {
    if (this.state.mode !== 'paper') throw new Error('Live options require explicit Bybit purchase confirmation');
    const fit = this.validateQuote(id);
    if (fit.totalCost > this.state.balances.reserves) throw new Error('Insufficient paper cash reserve for the quoted premium and fees');
    for (const leg of fit.legs) {
      const old = this.state.holdings.find(h => h.instrument.name === leg.instrument.name);
      const price = leg.cost / (leg.quantity * leg.instrument.multiplier);
      if (old) { old.averagePrice = (old.averagePrice * old.quantity + price * leg.quantity) / (old.quantity + leg.quantity); old.quantity += leg.quantity; }
      else this.state.holdings.push({ instrument: leg.instrument, quantity: leg.quantity, averagePrice: price });
    }
    this.state.balances.reserves -= fit.totalCost; this.state.balances.optionPremiums += fit.cost; this.state.balances.costs += fit.fees;
    this.event('options-fill', `Paper hedge filled: ${fit.legs.length} legs for ${fit.totalCost.toFixed(2)} USDC`, { quoteId: id, totalCost: fit.totalCost });
    this.state.revision++; this.state.fit = null; this.updateDelta(); this.save(); return this.publicState();
  }
  risk(settings: Partial<RiskSettings>) {
    this.state.hedge.settings = { ...this.state.hedge.settings, ...settings }; this.state.revision++;
    this.updateDelta(); this.event('settings', 'Hedge thresholds and limits updated'); this.save(); return this.publicState();
  }
  async enable() {
    this.requireMapping(); this.state.globalPaused = false;
    if (!this.selected().length) throw new Error('Select supported LP positions before enabling automatic hedging');
    if (this.state.mode === 'live') {
      const reason = this.gateway?.ready(this.state) ?? (!this.gateway ? 'Live adapter unavailable' : null);
      if (reason) throw new Error(reason);
    }
    this.failureCount = 0; this.nextRetryAt = 0;
    this.state.hedge.enabled = true; this.state.hedge.status = 'running'; this.state.hedge.reason = 'Reconciling initial hedge';
    this.event('automation', `${this.state.mode} automatic delta hedging enabled`); this.save();
    await this.tick(true); return this.publicState();
  }
  pause() {
    this.state.hedge.enabled = false; this.state.hedge.status = 'paused'; this.state.hedge.reason = 'Paused by user. Existing positions remain open.';
    this.event('automation', 'Automatic hedging paused'); this.save(); return this.publicState();
  }
  async cancel() {
    const s = this.state;
    if (s.intent && s.mode === 'live') {
      const owner = s.accounts.hyperliquid?.address; if (!owner || !this.gateway) throw new Error('Connect the owning account to cancel its order');
      await this.gateway.cancel(s.intent, owner);
      // Cancellation response can race a fill. Reconcile before clearing the pending intent.
      const result = await this.gateway.reconcile(s.intent, owner); await this.handleExecution(result);
      if (s.intent) throw new Error('Order cancellation sent; final order/fill reconciliation remains pending');
    } else { s.intent = null; s.hedge.pendingOrder = null; }
    this.event('cancel', 'Pending hedge order reconciled/cancelled'); this.save(); return this.publicState();
  }
  async closeHedge() {
    if (this.state.hedge.enabled) throw new Error('Pause automation before closing the perpetual hedge');
    if (this.state.intent) throw new Error('Reconcile or cancel the pending order first');
    if (this.state.mode === 'paper') this.accruePaperFunding();
    if (this.state.mode === 'live') {
      const reason = this.gateway?.ready(this.state); if (reason || !this.gateway) throw new Error(reason || 'Live adapter unavailable');
      await this.refresh(); await this.syncLivePortfolio();
    }
    for (let cycle = 0; cycle < 25; cycle++) {
      const s = this.state, quantity = -s.hedge.actualPerp;
      if (Math.abs(quantity) < s.market.perpSizeStep) break;
      if (Date.now() - s.market.timestamp > s.hedge.settings.maxDataAgeMs || !(s.market.perpMark > 0)) throw new Error('Fresh perpetual pricing is required to close the hedge');
      const cap = s.hedge.settings.maxOrderNotional / s.market.perpMark;
      const size = Math.sign(quantity) * Math.floor((Math.min(cap, Math.abs(quantity)) + 1e-12) / s.market.perpSizeStep) * s.market.perpSizeStep;
      if (Math.abs(size) * s.market.perpMark < s.market.perpMinNotional) throw new Error('Remaining hedge is below the normal order minimum; close the residual in the venue interface');
      await this.submit(size, 'Explicit close-hedge request');
      if (s.intent || s.hedge.status === 'suspended') break;
      if (s.mode === 'live') { await this.refresh(); await this.syncLivePortfolio(); }
    }
    this.updateDelta(); this.save(); return this.publicState();
  }
  async reconcilePortfolio() {
    if(this.state.mode==='live') {
      if(!this.gateway) throw new Error('Live account adapter unavailable');
      await this.syncLivePortfolio();
    }
    return this.publicState();
  }
  private async syncLivePortfolio() {
    const snapshot = await this.gateway!.portfolio(this.state);
    if (snapshot.allHoldings) this.reconcileHoldings(snapshot.allHoldings);
    if (snapshot.allPerps) this.reconcilePerps(snapshot.allPerps,snapshot.accountTimestamp);
    for (const p of snapshot.positions) {
      const previous = this.state.positions.find(v => v.id === p.id);
      if (!previous) continue;
      // Principal must remain constant at each bin for this benchmark to remain valid.
      const before = new Map(previous.bins.map(b => [b.id, b.price * b.x + b.y]));
      const changed = p.bins.some(b => !before.has(b.id) || Math.abs(before.get(b.id)! - (b.price * b.x + b.y)) > Math.max(.01, before.get(b.id)! * .0001)) || previous.bins.some(b => !p.bins.some(v => v.id === b.id));
      if (changed) {
        this.state.revision++; this.state.fit = null;
        p.notes.push('Principal changed since original benchmark; terminal replication requires explicit review/rebase.');
      }
      Object.assign(previous, p, { benchmarkBins: previous.benchmarkBins ?? previous.bins, benchmarkAt: previous.benchmarkAt, benchmarkPrice: previous.benchmarkPrice, benchmarkX: previous.benchmarkX, benchmarkY: previous.benchmarkY });
      if (!this.benchmarkMatches(previous) && !previous.notes.some(n => n.includes('original benchmark'))) previous.notes.push('Current principal/allocation differs from original benchmark; explicitly rebase before quoting new protection.');
    }
    if (this.selected().some(p => !snapshot.positions.some(v => v.id === p.id))) throw new Error('A selected Meteora position was not found during on-chain reconciliation');
    const quantities = (holdings: OptionHolding[]) => JSON.stringify(holdings.map(h => [h.instrument.name, h.quantity]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    if (quantities(this.state.holdings) !== quantities(snapshot.holdings) || (!this.state.intent && Math.abs(this.state.hedge.actualPerp - snapshot.actualPerp) > 1e-8)) {
      this.state.revision++; this.state.fit = null;
    }
    this.state.holdings = snapshot.holdings; this.state.hedge.actualPerp = snapshot.actualPerp;
    const owner = this.state.accounts.hyperliquid?.address;
    if (owner && snapshot.accountTimestamp) this.state.hedge.accountSnapshot = { owner, timestamp: snapshot.accountTimestamp };
    this.state.hyperliquidCollateral = snapshot.collateralInfo;
    this.state.perpEntry = snapshot.entryPrice; this.state.balances.collateral = snapshot.collateral;
    if (snapshot.optionCash !== undefined) this.state.balances.reserves = snapshot.optionCash;
    this.state.liveAttribution = snapshot.attribution;
    this.updateDelta(); this.save();
  }
  async tick(force = false) {
    const s = this.state, now = Date.now();
    if(!(ASSET_CODES as readonly string[]).includes(activeCode(s))){if(now>=this.nextPublicRefreshAt){this.nextPublicRefreshAt=now+15000;await this.refresh();}return;}
    if (s.mode === 'paper') this.accruePaperFunding(now);
    if (s.mode === 'live' || s.paperDataSource === 'live') {
      await this.refreshPublicIfDue(force);
      if (s.mode === 'paper') { this.refreshPaperHoldings(); this.updateDelta(); this.save(); }
    } else await this.refresh(false);
    if (!s.hedge.enabled && !s.intent) {
      // Capital monitoring continues independently of automation and an open browser.
      if (s.mode === 'live' && this.gateway && (s.selectedIds.length || s.holdings.length || s.hedge.actualPerp) && s.accounts.bybit && s.accounts.hyperliquid && s.accounts.meteora && now >= this.nextCapitalRefreshAt) {
        this.nextCapitalRefreshAt = now + 15_000;
        try { await this.syncLivePortfolio(); }
        catch (error) { this.event('capital-refresh', `Capital snapshot refresh failed; stored P&L becomes stale: ${error instanceof Error ? error.message : 'Account unavailable'}`); this.save(); }
      }
      return;
    }
    // Account/order failures can back off without stopping independent public prices.
    if (!force && Date.now() < this.nextRetryAt) return;
    await this.hedgeCycle(force);
    this.failureCount = 0; this.nextRetryAt = 0;
  }
  private async hedgeCycle(force: boolean) {
    const s = this.state;
    if (s.mode === 'live') {
      const reason = this.gateway?.ready(s) ?? (!this.gateway ? 'Live adapter unavailable' : null);
      if (reason) { this.suspend(reason); return; }
      await this.syncLivePortfolio();
      const invalidOption = s.holdings.find(h => h.quantity !== 0 && (h.instrument.expiry <= Date.now()
        || !h.instrument.greeks || !Number.isFinite(h.instrument.greeks.delta)));
      if (invalidOption && !s.intent) { this.suspend(`Live option ${invalidOption.instrument.name} has expired or lacks a valid live delta. Reconcile settlement or refresh Greeks before automatic hedging.`); return; }
    }
    if (s.intent) {
      if (s.mode === 'live') await this.handleExecution(await this.gateway!.reconcile(s.intent, s.accounts.hyperliquid!.address));
      return;
    }
    if (!s.hedge.enabled || s.globalPaused) return;
    // Recompute the target before checking shared capacity. Passing the target
    // difference is essential: an omitted quantity cannot identify a reduction.
    this.updateDelta();
    try { this.requireMapping(); this.requireSharedLimits(s.hedge.desiredPerp - s.hedge.actualPerp); } catch(error) { this.suspend((error as Error).message); return; }
    const decision = evaluateHedge({ hedge: s.hedge, market: s.market,
      nonPerpDelta: s.hedge.currentDelta - s.hedge.actualPerp,
      benchmarkDelta: this.selected().reduce((n, p) => n + p.benchmarkX, 0), collateral: this.marginCollateral(), now: Date.now(), force,
      portfolioChanged: s.revision !== s.hedgedRevision,
      dataTimestamps: [...this.selected().map(p => p.snapshotAt), ...s.holdings.filter(h => h.quantity !== 0).map(h => h.instrument.timestamp)] });
    s.hedge.desiredPerp = decision.desired; s.hedge.currentDelta = decision.delta; s.hedge.targetDelta = decision.target;
    if (decision.action === 'suspend') { this.suspend(decision.reason); return; }
    s.hedge.status = 'running'; s.hedge.reason = decision.reason;
    if (decision.action === 'complete') this.complete(decision.reason);
    else if (decision.action === 'order') await this.submit(decision.quantity, decision.reason);
    this.save();
  }
  marginCollateral() {
    const s=this.state,info=s.hyperliquidCollateral; stashBook(s);
    const equity=s.mode==='live'&&info&&info.owner.toLowerCase()===s.accounts.hyperliquid?.address.toLowerCase()?(info.accountPolicyCollateral??info.policyCollateral):this.effectiveCollateral();
    const limits=s.portfolioLimits??{maxLeverage:2,marginBuffer:.25};
    const others=Object.entries(s.books!).filter(([a])=>a!==activeCode(s)).reduce((n,[,b])=>{
      const pending=b.intent?b.hedge.actualPerp+b.intent.quantity-Math.sign(b.intent.quantity)*b.intent.appliedFill:b.hedge.actualPerp;
      const size=Math.max(Math.abs(b.hedge.actualPerp),Math.abs(pending),b.hedge.enabled?Math.abs(b.hedge.desiredPerp):0);
      return n+Math.max(b.hedge.venueMarginUsed??0,size*b.market.perpMark/Math.min(b.hedge.settings.maxLeverage,limits.maxLeverage,b.market.perpMaxLeverage??Infinity,b.hedge.venueLeverage??Infinity));
    },0);
    return Math.max(0,equity*(1-Math.max(limits.marginBuffer,s.hedge.settings.marginBuffer))-others)/(1-s.hedge.settings.marginBuffer);
  }
  effectiveCollateral() {
    const s = this.state;
    // Live accountValue already includes venue unrealized P&L.
    stashBook(s); return s.balances.collateral + (s.mode === 'paper' ? Object.values(s.books!).reduce((n,b)=>n+bookPerpPnl(b),0) : 0);
  }
  accruePaperFunding(now = Date.now()) {
    const s = this.state; if (s.mode !== 'paper') return;
    const elapsed = Math.max(0, now - s.lastFundingAt);
    const funding = -s.hedge.actualPerp * s.market.referencePrice * s.market.fundingRate * elapsed / 3600000;
    s.balances.funding += funding; s.balances.collateral += funding; s.lastFundingAt = now;
  }
  complete(reason: string) {
    const s = this.state;
    s.hedge.anchor = s.market.referencePrice; s.hedge.lastHedgeAt = Date.now(); s.hedgedRevision = s.revision;
    s.hedge.status = s.hedge.enabled ? 'running' : 'paused'; s.hedge.reason = reason;
    this.event('hedge-complete', reason, { anchor: s.hedge.anchor, residualDelta: s.hedge.currentDelta - s.hedge.targetDelta }); this.save();
  }
  private async submit(quantity: number, reason: string) {
    const s = this.state;
    if (s.intent) throw new Error('An order is already awaiting reconciliation');
    this.requireSharedLimits(quantity);
    const price = s.market.perpMark * (1 + Math.sign(quantity) * s.hedge.settings.maxSlippageBps / 10000);
    const intent: OrderIntent = { underlying: activeCode(s), cloid: '0x' + randomBytes(16).toString('hex'), quantity, price, createdAt: Date.now(), reason, appliedFill: 0,
      reduceOnly: isStrictPositionReduction(s.hedge.actualPerp, s.hedge.actualPerp + quantity) };
    s.intent = intent; s.hedge.pendingOrder = intent.cloid; s.hedge.status = 'executing';
    this.event('order-intent', reason, { cloid: intent.cloid, quantity, limitPrice: price }); this.save();
    if (s.mode === 'paper') {
      const executionPrice = s.market.perpMark * (1 + Math.sign(quantity) * 0.0001);
      await this.handleExecution({ status: 'filled', filled: Math.abs(quantity), price: executionPrice });
    } else {
      try { await this.handleExecution(await this.gateway!.order(intent, s.accounts.hyperliquid!.address)); }
      catch { this.suspend('Order submission outcome is unknown. Reconciliation is required before another order.'); }
    }
  }
  private async handleExecution(result: ExecutionResult) {
    const s = this.state, intent = s.intent; if (!intent) return;
    if (!Number.isFinite(result.filled) || result.filled < 0 || result.filled > Math.abs(intent.quantity) + 1e-7) { this.suspend('Invalid order reconciliation quantity'); return; }
    const newFill = result.filled - intent.appliedFill;
    if (newFill > 1e-10 && (!(result.price > 0) || !Number.isFinite(result.price))) { this.suspend('Fill reconciliation returned an invalid execution price'); return; }
    if (newFill > 1e-10) {
      if (s.mode === 'paper') {
        this.accruePaperFunding();
        const fill = applyPerpFill(s.hedge.actualPerp, s.perpEntry, Math.sign(intent.quantity) * newFill, result.price);
        const fee = newFill * result.price * 0.00035;
        s.hedge.actualPerp = fill.actual; s.perpEntry = fill.entry; s.balances.perpRealized += fill.realized;
        s.balances.collateral += fill.realized - fee; s.balances.costs += fee;
      } else await this.syncLivePortfolio();
      intent.appliedFill = result.filled;
      this.event('perp-fill', `${s.mode} perpetual fill reconciled`, { cloid: intent.cloid, quantity: Math.sign(intent.quantity) * newFill, price: result.price });
    }
    this.updateDelta();
    if (result.status === 'unknown' || result.status === 'resting') { this.suspend(result.reason || 'Order remains pending; awaiting final reconciliation'); return; }
    s.intent = null; s.hedge.pendingOrder = null;
    if (result.status === 'rejected') { this.suspend(result.reason || 'Hedge order rejected'); s.hedge.enabled = false; this.save(); return; }
    if (intent.reason !== 'Explicit close-hedge request') {
      const validation = evaluateHedge({ hedge: s.hedge, market: s.market, nonPerpDelta: s.hedge.currentDelta - s.hedge.actualPerp,
        benchmarkDelta: this.selected().reduce((n, p) => n + p.benchmarkX, 0), collateral: this.marginCollateral(), now: Date.now(), force: true,
        dataTimestamps: [...this.selected().map(p => p.snapshotAt), ...s.holdings.filter(h => h.quantity !== 0).map(h => h.instrument.timestamp)] });
      const invalidOption = s.mode === 'live' && s.holdings.some(h => h.quantity !== 0 && (h.instrument.expiry <= Date.now() || !h.instrument.greeks || !Number.isFinite(h.instrument.greeks.delta)));
      if (validation.action === 'suspend' || invalidOption) {
        // Inventory is confirmed, but a completion anchor needs a fresh coherent risk snapshot.
        s.hedgedRevision = -1;
        this.suspend(`Fill confirmed; anchor retained until fresh risk reconciliation. ${invalidOption ? 'Option settlement or live delta is unavailable.' : validation.reason}`);
        return;
      }
    }
    const residual = Math.abs(s.hedge.currentDelta - s.hedge.targetDelta);
    if (residual <= s.hedge.settings.deltaDeadband || residual * s.market.perpMark < Math.max(s.hedge.settings.notionalDeadband, s.market.perpMinNotional)) this.complete('Confirmed fills achieved the executable delta tolerance');
    else { s.hedge.status = s.hedge.enabled ? 'running' : 'paused'; s.hedge.reason = 'Partial or capped hedge completed; anchor retained until residual is covered'; }
    this.save();
  }
}
