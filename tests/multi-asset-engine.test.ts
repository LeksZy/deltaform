import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Engine,initialState,type LiveGateway,type OrderIntent} from '../server/engine';
import {Store} from '../server/store';
import {ASSET_CODES} from '../src/shared/multi-asset';
import {resolveMeteoraPair,USDC_MINT} from '../src/shared/assets';
import type {Position} from '../src/shared/types';
import {currentInventory} from '../src/quant/math';
import {capitalScope} from '../server/capital-tracking';

const stores:Store[]=[];let now=Date.UTC(2026,8,30,8);
beforeEach(()=>{now=Date.UTC(2026,8,30,8);vi.spyOn(Date,'now').mockImplementation(()=>now);});
afterEach(()=>{stores.splice(0).forEach(s=>s.close());vi.restoreAllMocks();});
function engine(){const s=new Store(':memory:');stores.push(s);return new Engine(s);}
function hedgeSettings(e:Engine){e.risk({maxOrderNotional:30000,deltaDeadband:1e-8,notionalDeadband:10,deltaEmergency:1e9});}

// A $741 shared account whose SOL target reserves $220 at venue 1x. HYPE
// currently uses $379 and should buy back 0.14 units toward its $365 target.
// Both targets exceed the deliberately conservative 50% shared budget.
function sharedMarginHarness(live=false){
 const e=engine();e.reset(true);e.selectAsset('HYPE');
 const s=e.state,position={...s.positions[0]!,source:live?'live' as const:'fixture' as const,owner:'mock-owner',
  bins:[{id:1,price:100,x:3.65,y:0}],benchmarkBins:[{id:1,price:100,x:3.65,y:0}],
  baseFees:0,quoteFees:0,poolPrice:100,benchmarkX:3.65,benchmarkY:0};
 s.positions=[position];s.selectedIds=[position.id];s.holdings=[];
 s.market={...s.market,source:live?'live':'fixture',timestamp:now,referencePrice:100,poolPrice:100,optionIndex:100,perpMark:100,perpSizeStep:.01};
 s.mode=live?'live':'paper';s.source=live?'live':'fixture';s.balances.collateral=741;
 s.portfolioLimits={maxGrossPerpNotional:100000,maxLeverage:5,marginBuffer:.5};
 s.hedge.actualPerp=-3.79;s.hedge.venueLeverage=1;s.perpEntry=100;
 const sol=s.books!.SOL;sol.hedge.actualPerp=-1.7;sol.hedge.desiredPerp=-2.2;sol.hedge.venueLeverage=1;sol.hedge.enabled=true;sol.market.perpMark=100;sol.market.timestamp=now;sol.perpEntry=100;
 e.risk({maxOrderNotional:1000,maxPerpNotional:15000,maxLeverage:5,marginBuffer:.25,deltaDeadband:1e-8,notionalDeadband:10,deltaEmergency:1e9});
 const venue={actual:-3.79,orders:[] as OrderIntent[]};
 if(live){
  s.accounts.hyperliquid={address:'0x'+'a'.repeat(40),verified:true,connectedAt:now};
  e.gateway={ready:()=>null,market:async()=>({...s.market,timestamp:now}),positions:async()=>[position],
   portfolio:async()=>({positions:[{...position,snapshotAt:now}],holdings:[],actualPerp:venue.actual,collateral:741,entryPrice:100,accountTimestamp:now}),
   order:async intent=>{venue.orders.push(structuredClone(intent));venue.actual+=intent.quantity;return {status:'filled',filled:Math.abs(intent.quantity),price:100};},
   reconcile:async()=>({status:'unknown',filled:0,price:0}),cancel:async()=>undefined};
 }
 e.updateDelta();e.save();return {e,venue};
}

describe('multiple economic underlyings in one persisted account',()=>{
 it('archives and migrates legacy SOL state while preserving baseline scope and pending order',()=>{
  const store=new Store(':memory:');stores.push(store);const old=initialState('live');
  old.positions=initialState().positions;old.selectedIds=old.positions.map(p=>p.id);old.hedge.anchor=123;old.hedge.actualPerp=-2;
  old.intent={cloid:'0xabc',quantity:-1,price:100,createdAt:now,reason:'partial',appliedFill:.2};old.hedge.pendingOrder='0xabc';
  const scope=capitalScope(old);store.set('activeMode','live');store.set('state:live',old);store.set('capitalTracking:live',{baseline:{scopeKey:scope,equity:999},flows:[]});
  const e=new Engine(store);expect(e.state.schemaVersion).toBe(2);expect(Object.keys(e.state.books!)).toHaveLength(8);
  expect(e.state.books!.SOL.hedge.anchor).toBe(123);expect(e.state.books!.SOL.intent).toEqual(old.intent);
  expect(capitalScope(e.state)).toBe(scope);expect(store.get('capitalTracking:live')).toEqual({baseline:{scopeKey:scope,equity:999},flows:[]});
  expect(store.get('multiAssetArchive:live')).toEqual(old);
  for(const b of Object.values(e.state.books!))for(const v of Object.values(b.hedge.settings))if(typeof v==='number')expect(Number.isFinite(v)).toBe(true);
  const restarted=new Engine(store);expect(restarted.state.books!.SOL.intent?.cloid).toBe('0xabc');
 });
 it('keeps quotes, preferences, prices and independent alpha anchors when switching assets and restarting',async()=>{
  const e=engine();e.reset(true);e.selectAsset('BTC');hedgeSettings(e);e.settings({modelSettings:{expiry:0,ivMode:'manual',ivPercent:45,daysAhead:0}});
  await e.enable();const btcAnchor=e.state.hedge.anchor;expect(btcAnchor).toBeGreaterThan(1000);
  e.selectAsset('SOL');hedgeSettings(e);e.settings({modelSettings:{expiry:0,ivMode:'manual',ivPercent:80,daysAhead:0}});await e.enable();const solAnchor=e.state.hedge.anchor;
  now+=6000;e.paperPrice(solAnchor!*1.02);await e.tickAll();
  expect(e.state.books!.BTC.hedge.anchor).toBe(btcAnchor);expect(e.state.books!.SOL.hedge.anchor).toBeCloseTo(solAnchor!*1.02);
  const restarted=new Engine(e.store);restarted.selectAsset('BTC');expect(restarted.state.hedge.anchor).toBe(btcAnchor);expect(restarted.state.books!.BTC.modelSettings?.ivPercent).toBe(45);expect(restarted.state.books!.SOL.modelSettings?.ivPercent).toBe(80);
 });
 it('hedges BTC and SOL independently even when cash exposures offset',async()=>{
  const e=engine();e.reset(true);e.selectAsset('BTC');hedgeSettings(e);e.updateDelta();
  const btcCash=e.state.hedge.currentDelta*e.state.market.referencePrice;
  e.selectAsset('SOL');hedgeSettings(e);const spot=e.state.market.referencePrice,lp=currentInventory(e.selected(),spot).delta;
  e.state.hedge.actualPerp=-lp-btcCash/spot;e.state.perpEntry=spot;e.updateDelta();e.save();
  expect(e.state.hedge.currentDelta*spot).toBeCloseTo(-btcCash);
  await e.enable();expect(Math.abs(e.state.hedge.currentDelta)*spot).toBeLessThan(10);
  e.selectAsset('BTC');await e.enable();expect(Math.abs(e.state.hedge.currentDelta)*e.state.market.referencePrice).toBeLessThan(10);
  expect(e.state.books!.SOL.hedge.actualPerp).not.toBe(0);expect(e.state.books!.BTC.hedge.actualPerp).not.toBe(0);
 });
 it('counts cash once and suspends a second underlying when shared margin is committed',async()=>{
  const e=engine();e.reset(true);const s=e.publicState();
  const lp=Object.values(e.state.books!).reduce((n,b)=>n+currentInventory(b.positions,b.market.referencePrice).value,0);
  expect(s.accounting!.equity).toBeCloseTo(lp+60000);
  e.state.balances.collateral=5000;e.selectAsset('BTC');hedgeSettings(e);await e.enable();expect(e.state.hedge.actualPerp).toBeLessThan(0);
  e.selectAsset('SOL');hedgeSettings(e);await e.enable();expect(e.state.hedge.actualPerp).toBe(0);expect(e.state.hedge.status).toBe('suspended');expect(e.state.hedge.anchor).toBeNull();expect(e.state.hedge.reason).toMatch(/shared.*margin/);
 });
 it('reserves actual venue margin and respects the venue leverage instead of assuming configured leverage',()=>{
  const e=engine();e.reset(true);e.state.balances.collateral=10000;
  e.reconcilePerps([{coin:'BTC',size:-.02,entryPrice:e.state.books!.BTC.market.perpMark,marginUsed:3000,leverage:1}],now);
  e.selectAsset('SOL');expect(e.marginCollateral()*(1-e.state.hedge.settings.marginBuffer)).toBeCloseTo(4500);
  e.state.books!.BTC.hedge.venueMarginUsed=6000;expect(e.marginCollateral()*(1-e.state.hedge.settings.marginBuffer)).toBeCloseTo(1500);
  const b=e.state.books!.BTC;b.market.perpMark=100000;b.perpEntry=100000;b.hedge.actualPerp=-.1;b.hedge.venueMarginUsed=0;
  expect(e.marginCollateral()).toBe(0);b.hedge.venueLeverage=2;expect(e.marginCollateral()*(1-e.state.hedge.settings.marginBuffer)).toBeCloseTo(2500);
 });
 it.each([false,true])('permits a strict HYPE reduction despite another enabled target reserving shared collateral (live=%s)',async live=>{
  const {e,venue}=sharedMarginHarness(live);
  expect(e.marginCollateral()*(1-e.state.hedge.settings.marginBuffer)).toBeCloseTo(150.5);
  await e.enable();
  expect(e.state.hedge.actualPerp).toBeCloseTo(-3.65);
  expect(e.state.hedge.anchor).toBe(100);
  expect(e.state.events.filter(event=>event.type==='order-intent')).toHaveLength(1);
  if(live){expect(venue.orders).toHaveLength(1);expect(venue.orders[0]).toMatchObject({underlying:'HYPE',reduceOnly:true});expect(venue.orders[0]!.quantity).toBeCloseTo(.14);}
  expect(e.state.books!.SOL.hedge.actualPerp).toBe(-1.7);
 });
 it('still blocks increasing both hedge targets when their shared margin does not fit',async()=>{
  const {e,venue}=sharedMarginHarness(true);venue.actual=-3.5;e.state.hedge.actualPerp=-3.5;e.updateDelta();e.save();
  await e.enable();expect(venue.orders).toHaveLength(0);expect(e.state.hedge.status).toBe('suspended');expect(e.state.hedge.reason).toMatch(/shared.*margin/);
 });
 it('allows reductions above exposure caps but retains the shared cap for increases',async()=>{
  const reducing=sharedMarginHarness(true);reducing.e.state.portfolioLimits!.maxGrossPerpNotional=500;reducing.e.risk({maxPerpNotional:350});
  await reducing.e.enable();expect(reducing.venue.orders[0]?.reduceOnly).toBe(true);expect(reducing.venue.actual).toBeCloseTo(-3.65);
  const increasing=sharedMarginHarness(true);increasing.e.state.portfolioLimits!.maxGrossPerpNotional=500;increasing.venue.actual=-3.5;increasing.e.state.hedge.actualPerp=-3.5;
  await increasing.e.enable();expect(increasing.venue.orders).toHaveLength(0);expect(increasing.e.state.hedge.reason).toMatch(/gross perpetual limit/);
 });
 it('does not apply reduce-only to a normally funded short increase',async()=>{
  const {e,venue}=sharedMarginHarness(true);e.state.portfolioLimits!.marginBuffer=0;e.risk({marginBuffer:0});
  venue.actual=-3.5;e.state.hedge.actualPerp=-3.5;
  await e.enable();expect(venue.orders).toHaveLength(1);expect(venue.orders[0]!.reduceOnly).toBe(false);expect(venue.orders[0]!.quantity).toBeCloseTo(-.15);
 });
 it.each(['pending','stale','mapping'] as const)('does not let a strict reduction bypass the %s guard',async guard=>{
  const {e,venue}=sharedMarginHarness(true),sol=e.state.books!.SOL;
  if(guard==='pending'){sol.intent={underlying:'SOL',cloid:'0xpending',quantity:-.5,price:100,createdAt:now,reason:'unknown outcome',appliedFill:0};sol.hedge.pendingOrder='0xpending';}
  else if(guard==='stale')sol.market.timestamp=now-60000;
  else e.state.positions[0]!.hedgeMapping={status:'watch-only',reason:'Unverified wrapper',requiresBasisMonitoring:true};
  if(guard==='mapping')await expect(e.enable()).rejects.toThrow(/Unverified wrapper/);
  else {await e.enable();expect(e.state.hedge.reason).toMatch(guard==='pending'?/pending order/:/stale margin valuation/);}
  expect(venue.orders).toHaveLength(0);expect(venue.actual).toBe(-3.79);expect(e.state.hedge.anchor).toBeNull();
 });
 it('does not grant the shared-margin exception to a smaller position on the opposite side',async()=>{
  const {e,venue}=sharedMarginHarness(true);e.risk({targetMode:'preserve-hodl'});e.state.positions[0]!.benchmarkX=7.15;e.updateDelta();
  expect(e.state.hedge.desiredPerp).toBeCloseTo(3.5);
  await e.enable();expect(venue.orders).toHaveLength(0);expect(e.state.hedge.reason).toMatch(/shared.*margin/);
 });
 it('does not issue a second asset order while another outcome is unresolved',async()=>{
  const e=engine();e.reset(true);e.selectAsset('BTC');e.state.intent={underlying:'BTC',cloid:'0xpending',quantity:-.1,price:80000,createdAt:now,reason:'test',appliedFill:0};e.state.hedge.pendingOrder='0xpending';e.save();
  e.selectAsset('SOL');await e.enable();expect(e.state.hedge.actualPerp).toBe(0);expect(e.state.hedge.reason).toMatch(/pending order/);expect(e.state.books!.BTC.intent?.cloid).toBe('0xpending');
 });
 it('global pause survives restart and prevents subsequent orders across all assets',async()=>{
  const e=engine();e.reset(true);for(const asset of ['BTC','SOL']){e.selectAsset(asset);hedgeSettings(e);await e.enable();}
  e.pauseAll();const orders=e.state.events.filter(x=>x.type==='order-intent').length;
  now+=10000;e.paperPrice(e.state.market.referencePrice*1.1);await e.tickAll();expect(e.state.events.filter(x=>x.type==='order-intent')).toHaveLength(orders);
  const next=new Engine(e.store);expect(next.state.globalPaused).toBe(true);for(const b of Object.values(next.state.books!))expect(b.hedge.enabled).toBe(false);
 });
 it('rejects stale or unmapped live basis before enabling',async()=>{
  const e=engine();e.reset(true);e.state.mode='live';e.state.market.source='live';e.state.market.timestamp=now-60000;
  await expect(e.enable()).rejects.toThrow(/Fresh complete/);
  e.state.market.timestamp=now;e.state.positions[0]!.hedgeMapping={status:'watch-only',reason:'Unknown issuer',requiresBasisMonitoring:true};await expect(e.enable()).rejects.toThrow(/Unknown issuer/);
 });
 it('returns state for an imported unmapped position with only a pool-priced inventory mark',async()=>{
  const store=new Store(':memory:');stores.push(store);store.set('activeMode','live');
  const e=new Engine(store), mint='unverified-mint', mapping=resolveMeteoraPair(mint,USDC_MINT);
  const position:Position={...initialState('paper').positions[0]!,id:'watch-only-lp',pool:'watch-only-pool',name:'Unverified / USDC',source:'live',
   underlying:mapping.underlying,base:mapping.base,quote:mapping.quote,baseMint:mint,quoteMint:USDC_MINT,hedgeMapping:mapping.hedgeMapping,
   snapshotAt:now,poolPrice:50,bins:[{id:1,price:50,x:2,y:10}],benchmarkX:2,benchmarkY:10,baseFees:.25,quoteFees:3};
  e.gateway={positions:async()=>[position]} as unknown as LiveGateway;
  const imported=await e.importPositions('owner','watch-only-pool');
  const row=imported.portfolio!.assets.find(asset=>asset.underlying===mapping.base)!;
  expect(imported.activeUnderlying).toBe(mapping.base);
  expect(row).toMatchObject({lpValue:125.5,fees:15.5,cashDelta:null,modelCashDelta:null,gammaPnl1Pct:null,vega:null,theta:null,supportStatus:'watch-only'});
  expect(row.supportReasons).toContain(mapping.hedgeMapping.reason);
  expect(e.publicState().portfolio!.assets.find(asset=>asset.underlying===mapping.base)).toMatchObject({lpValue:125.5,supportStatus:'watch-only'});
  e.state.market.referencePrice=0;
  expect(e.publicState().portfolio!.assets.find(asset=>asset.underlying===mapping.base)!.lpValue).toBeNull();
 });
 it('keeps per-asset P&L unavailable without an allocation and does not use expired live option marks',()=>{
  const e=engine();e.reset(true);const option=e.state.market.instruments[0]!;e.state.holdings=[{instrument:{...option,expiry:now-1,source:'live'},quantity:1,averagePrice:1}];e.state.source='live';e.state.mode='live';
  expect(e.publicState().accounting?.equity).toBeNull();expect(e.publicState().portfolio?.assets.every(a=>a.pnl===null)).toBe(true);
 });
});
