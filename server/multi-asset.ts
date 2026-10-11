import { isUnderlying, requireUnderlying } from '../src/shared/assets';
import type { InternalState, OrderIntent } from './engine';
import type { AssetBook, AssetOverview, PortfolioLimits } from '../src/shared/multi-asset';
import { ASSET_CODES } from '../src/shared/multi-asset';
import { demoAssetMarket, demoAssetPosition } from '../src/quant/fixtures';
import { currentInventory, modelOption } from '../src/quant/math';
import { portfolioRisk, riskInputs } from '../src/client/portfolio-risk';
import { DEFAULT_RISK } from './policy';
import type { Store } from './store';
import { researchVolatility as readResearchVolatility } from './realized-volatility';
import { migrateVerifiedMappedBooks } from './mapped-book-migration';

export interface StoredAssetBook extends AssetBook {
  perpEntry: number; lastFundingAt: number; revision: number; hedgedRevision: number; intent: OrderIntent | null;
}
const fields = ['source','paperDataSource','positions','selectedIds','holdings','market','fit','hedge','perpEntry','lastFundingAt','revision','hedgedRevision','intent'] as const;
export const DEFAULT_PORTFOLIO_LIMITS: PortfolioLimits = { maxGrossPerpNotional: 100000, maxLeverage: 2, marginBuffer: .25 };
export function activeCode(s: InternalState) { return s.activeUnderlying ?? 'SOL'; }
export function stashBook(s: InternalState) {
  s.activeUnderlying ??= 'SOL'; s.books ??= {}; s.portfolioLimits??={...DEFAULT_PORTFOLIO_LIMITS};
  const prior = s.books[s.activeUnderlying];
  const book = { ...prior } as StoredAssetBook;
  for (const k of fields) (book as any)[k] = s[k];
  s.books[s.activeUnderlying] = book;
}
export function restoreBook(s: InternalState, asset: string) {
  stashBook(s);
  const book = s.books![asset]; if (!book) throw new Error('Unknown underlying');
  for (const k of fields) (s as any)[k] = (book as any)[k];
  s.activeUnderlying = asset;
}
export function blankBook(asset: string, mode: 'paper'|'live', withPosition = false): StoredAssetBook {
  const now = Date.now(), position = demoAssetPosition(requireUnderlying(asset), now), market = demoAssetMarket(requireUnderlying(asset), now, position.poolPrice);
  if (mode === 'live') Object.assign(market, {source:'live',timestamp:0,referencePrice:0,poolPrice:0,optionIndex:0,perpMark:0,perpSizeStep:0,instruments:[],status:{support:'Market discovery pending'}});
  return { source: mode==='paper'?'fixture':'live', paperDataSource:'fixture', positions: mode==='paper'&&withPosition?[position]:[], selectedIds:mode==='paper'&&withPosition?[position.id]:[],holdings:[],market,fit:null,
    hedge:{enabled:false,status:'paused',reason:'Automation is paused',anchor:null,lastHedgeAt:null,actualPerp:0,desiredPerp:0,currentDelta:0,targetDelta:0,pendingOrder:null,
      settings:{...DEFAULT_RISK,deltaDeadband:Math.min(.02,2/position.poolPrice),deltaEmergency:Math.max(.0001,400/position.poolPrice)}},
    perpEntry:0,lastFundingAt:now,revision:0,hedgedRevision:-1,intent:null };
}
export function migrateMultiAsset(store: Store, s: InternalState) {
  if (s.schemaVersion !== 2) {
    if (!store.get('multiAssetArchive:'+s.mode)) store.set('multiAssetArchive:'+s.mode,structuredClone(s));
    s.activeUnderlying = 'SOL'; s.books = {}; stashBook(s);
    s.schemaVersion = 2;
  }
  s.portfolioLimits ??= {...DEFAULT_PORTFOLIO_LIMITS}; s.globalPaused ??= false;
  for (const asset of ASSET_CODES) s.books![asset] ??= blankBook(asset,s.mode);
  // The foreground copy can be newer than its persisted book after an import.
  stashBook(s);
  return migrateVerifiedMappedBooks(store,s);
}
export function bookPerpPnl(b: StoredAssetBook) { return b.hedge.actualPerp*(b.market.perpMark-b.perpEntry); }
export function optionValue(b: StoredAssetBook) {
  let value = 0;
  for (const h of b.holdings) {
    if (!h.quantity) continue;
    if (b.source==='live' && (h.instrument.mark==null || h.instrument.expiry<=Date.now() || !Number.isFinite(h.instrument.mark))) return null;
    if (h.instrument.mark != null && Number.isFinite(h.instrument.mark)) value += h.quantity*h.instrument.multiplier*h.instrument.mark;
    else if (h.instrument.iv != null && b.market.referencePrice>0) value += h.quantity*modelOption(h.instrument,b.market.referencePrice).price;
    else return null;
  }
  return value;
}
export function supportReason(b: AssetBook, live: boolean): string[] {
  if (!live) return [];
  const positions=b.positions.filter(p=>b.selectedIds.includes(p.id));
  const reasons=[];
  if (b.market.source!=='live' || !b.market.timestamp || Date.now()-b.market.timestamp>b.hedge.settings.maxDataAgeMs || b.market.timestamp>Date.now()+5000) reasons.push('Fresh complete venue mapping unavailable: stale or missing market data');
  if (!b.market.instruments.some(i=>i.expiry>Date.now())) reasons.push('No supported live option expiry');
  if (!b.market.perpSizeStep || !b.market.perpMark) reasons.push('Matching linear perpetual unavailable');
  for (const p of positions) {
    if (p.hedgeMapping?.status==='watch-only') reasons.push(p.hedgeMapping.reason);
    const basis=Math.abs(p.poolPrice/b.market.referencePrice-1)*10000;
    if (!Number.isFinite(basis) || basis>b.hedge.settings.maxBasisBps) reasons.push(`${p.name}: pool/underlying basis exceeds limit`);
  }
  if (b.market.status.support) reasons.push(b.market.status.support);
  return [...new Set(reasons)];
}
export function researchVolatility() {
  return readResearchVolatility();
}
export function overview(s: InternalState): AssetOverview[] {
  stashBook(s);
  return Object.entries(s.books!).map(([underlying,raw])=>{
    const b=raw as StoredAssetBook, positions=b.positions.filter(p=>b.selectedIds.includes(p.id)),spot=b.market.referencePrice;
    const watchOnly=!isUnderlying(underlying)||positions.some(p=>p.hedgeMapping?.status==='watch-only'||!isUnderlying(p.base));
    const markable=Number.isFinite(spot)&&spot>0;
    const inv=currentInventory(positions,markable?spot:0), opt=optionValue(b);
    const reasons=supportReason(b,s.mode==='live');
    if(watchOnly) {
      for(const p of positions) if(p.hedgeMapping?.status==='watch-only'&&p.hedgeMapping.reason&&!reasons.includes(p.hedgeMapping.reason)) reasons.push(p.hedgeMapping.reason);
      if(!reasons.length) reasons.push('No verified economic underlying mapping for the selected LP position.');
    }
    const hasExposure=positions.length>0||b.holdings.some(h=>h.quantity!==0)||b.hedge.actualPerp!==0;
    let executionDelta: number|null=null, greeks: ReturnType<typeof portfolioRisk>['total']['greeks']=null;
    if(!watchOnly) {
      const expiry=b.modelSettings?.expiry||b.fitSettings?.expiry||b.market.instruments[0]?.expiry||Date.now()+30*86400000;
      const model=b.modelSettings??{expiry,ivMode:'market' as const,ivPercent:70,daysAhead:0};
      const view={...s,...b,activeUnderlying:underlying,accounting:{...s.accounting,perpUnrealized:bookPerpPnl(b)}} as any;
      const inputs=riskInputs(view,model,expiry), risk=portfolioRisk(view,positions,inputs.expiry,inputs.iv).total;
      executionDelta=hasExposure?risk.executionDelta:0;
      greeks=hasExposure?risk.greeks:{delta:0,gamma:0,vega:0,theta:0};
    }
    const times=[b.market.timestamp,...positions.map(p=>p.snapshotAt),...b.holdings.filter(h=>h.quantity).map(h=>h.instrument.timestamp)];
    if(s.mode==='live'&&hasExposure) times.push(b.hedge.accountSnapshot?.timestamp??0,s.capabilities.bybitAccount?.checkedAt??0);
    return {underlying,lpValue:positions.length&&!markable?null:inv.value,fees:positions.length&&!markable?null:positions.reduce((n,p)=>n+p.baseFees*spot+p.quoteFees,0),optionsValue:opt,
      perpSize:b.hedge.actualPerp,perpUnrealized:bookPerpPnl(b),pnl:null,pnlReason:'Shared collateral and starting cash are tracked at account level; per-asset cost/flow allocation is unavailable.',
      cashDelta:executionDelta==null?null:executionDelta*spot,modelCashDelta:greeks?.delta==null?null:greeks.delta*spot,gammaPnl1Pct:greeks?.gamma==null?null:.5*greeks.gamma*(.01*spot)**2,vega:greeks?.vega??null,theta:greeks?.theta??null,
      status:b.hedge.status,enabled:b.hedge.enabled,reason:b.hedge.reason,timestamp:Math.min(...times),
      supportStatus:reasons.length?(hasExposure?'watch-only':'unavailable'):'ready',supportReasons:reasons,realizedVolatility:researchVolatility()[underlying]??null};
  });
}
