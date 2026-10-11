/** Isolated UI harness. No dotenv, credentials, Gateway, or live execution adapter. */
import express, { type Request } from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Engine } from '../server/engine';
import { Store } from '../server/store';
import { stashBook } from '../server/multi-asset';
import { decompose, modelLp, modelOption } from '../src/quant/math';
import { scenarioSurface, simulateStrategies } from '../src/quant/simulation';
import { payoffPoints } from '../src/quant/fit';
import type { FitSettings } from '../src/shared/types';

process.env.ENABLE_LIVE_EXECUTION = 'false';
const port = Number(process.env.UI_QA_PORT || 8788);
if (!Number.isSafeInteger(port) || port < 1024 || port === 8787) throw new Error('Use a separate QA port, never production 8787.');
const directory = mkdtempSync(join(tmpdir(), 'deltaform-ui-qa-'));
const store = new Store(join(directory, 'paper.sqlite'));
store.acquireWorker();
const engine = new Engine(store);
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (!['127.0.0.1', 'localhost'].includes(req.hostname)) { res.status(403).json({error:'Loopback only'}); return; }
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  if (req.headers.origin && !allowed.includes(req.headers.origin)) { res.status(403).json({error:'QA origin only'}); return; }
  res.setHeader('Cache-Control','no-store'); next();
});
app.use(express.json());
type Scenario = 'normal' | 'empty' | 'stale' | 'error' | 'partial';
let scenario: Scenario = 'normal';

function publicState() {
  const state = engine.publicState();
  state.capabilities = {liveExecution:false,bybitExecution:false,bybitConfigured:false,hyperliquidAgent:false,optionsVenue:'bybit',message:`Isolated UI QA: ${scenario}. All positions, orders, and fills are synthetic.`,marketRefreshIntervalMs:2000};
  return state;
}
function setScenario(next: Scenario) {
  if (!['normal','empty','stale','error','partial'].includes(next)) throw new Error('Unknown QA scenario');
  engine.stop();
  engine.state.hedge.enabled=false; engine.state.hedge.pendingOrder=null; engine.state.intent=null;
  stashBook(engine.state);
  for (const book of Object.values(engine.state.books ?? {})) { book.hedge.enabled=false; book.hedge.pendingOrder=null; book.intent=null; }
  engine.reset(true); scenario=next;
  engine.state.accounts = {meteora:null,bybit:null,hyperliquid:null};
  const now=Date.now();
  for(const book of Object.values(engine.state.books!)) {
    book.fitSettings={expiry:book.market.instruments[0]!.expiry,coverage:.7,budget:1500,maxLegs:6,objective:'payoff',maxUndercoverage:null};
  }
  if(next==='empty') {
    engine.state.positions=[];engine.state.selectedIds=[];
    stashBook(engine.state);
    for(const book of Object.values(engine.state.books!)) {book.positions=[];book.selectedIds=[];book.holdings=[];book.hedge.actualPerp=0;}
  }
  if(next==='stale') {
    // Keep a real optimizer proposal available for stale-price UI inspection.
    // Generate it while the market is fresh, then expire its review window.
    const proposal=engine.quote(engine.state.books![engine.state.activeUnderlying??'SOL']!.fitSettings!);
    proposal.createdAt=now-180_000;proposal.expiresAt=now-120_000;
    for(const book of Object.values(engine.state.books!)) {
      book.market.timestamp=now-180_000;
      for(const instrument of book.market.instruments) instrument.timestamp=now-180_000;
      for(const position of book.positions) position.snapshotAt=now-180_000;
    }
    engine.state.market.timestamp=now-180_000;
    engine.state.hedge.status='suspended';engine.state.hedge.reason='QA: venue feed stale for 180 seconds; new orders suspended';
    engine.event('market-error','QA stale market feed: review timestamps before any simulated order.');
  }
  if(next==='error') {
    engine.state.hedge.status='suspended';engine.state.hedge.reason='QA: simulated venue disconnected; reconciliation unavailable';
    engine.state.market.status.bybit='QA: simulated Bybit HTTP 503';
    engine.event('venue-error','QA: simulated Bybit service unavailable. Existing exposure retained.');
  }
  if(next==='partial') {
    const call=engine.state.market.instruments.find(i=>i.type==='call'&&i.strike===210)!;
    engine.state.holdings=[{instrument:call,quantity:.4,averagePrice:call.ask!}];
    const premium=.4*call.ask!;
    engine.state.balances.reserves-=premium;engine.state.balances.optionPremiums=premium;
    engine.state.hedge.actualPerp=-12;engine.state.perpEntry=engine.state.market.perpMark;
    engine.state.hedge.status='suspended';engine.state.hedge.pendingOrder='QA-PARTIAL-PERP';
    engine.state.hedge.reason='QA partial fill: 12 of 30 SOL filled; anchor retained. Reconcile before another order.';
    engine.state.hedge.anchor=engine.state.market.referencePrice*.98;
    engine.event('partial-fill','QA simulated perp fill: 12 / 30 SOL. Remainder unconfirmed; worker suspended.',{requested:30,filled:12,orderId:'QA-PARTIAL-PERP'});
    engine.event('options-partial-fill','QA simulated option basket: 0.4 / 1.0 call filled. Only 0.4 is included in actual exposure.',{instrument:call.name,requested:1,filled:.4});
  }
  engine.updateDelta();engine.save();
  if(next==='normal'||next==='empty') engine.start();
  return publicState();
}
function route(path:string,fn:(req:Request)=>unknown|Promise<unknown>,method:'get'|'post'='post') {
  app[method](path,async(req,res)=>{
    try {const value=await engine.queue.run(()=>fn(req));res.json(value);}
    catch(error){res.status(409).json({error:error instanceof Error?error.message:'QA request failed'});}
  });
}
route('/__qa/scenario',req=>setScenario(req.body.scenario));
route('/__qa/scenario',()=>({scenario,port,isolated:true,liveExecution:false,presets:['normal','empty','stale','error','partial']}),'get');
route('/api/health',()=>({ok:true,mode:'paper',worker:true,qa:true}),'get');
route('/api/state',()=>publicState(),'get');
route('/api/assets/select',req=>engine.selectAsset(req.body.underlying));
route('/api/assets/settings',req=>engine.settings(req.body));
route('/api/portfolio/limits',req=>engine.portfolioLimits(req.body));
route('/api/portfolio/scenario',req=>engine.scenarioSettings(req.body.pricePercent,req.body.ivPoints));
route('/api/decomposition',()=>decompose(engine.selected()),'get');
route('/api/positions/select',req=>engine.select(req.body.ids));
route('/api/positions/rebase',()=>engine.rebase());
route('/api/positions/hypothetical',req=>engine.addHypothetical(req.body.name,req.body.bins));
route('/api/quote',req=>{if(scenario==='error')throw new Error('QA: simulated Bybit service unavailable (HTTP 503)');return engine.quote(req.body as FitSettings);});
route('/api/quote/execute',req=>engine.executePaperQuote(req.body.quoteId));
route('/api/quote/reconcile',()=>{if(scenario==='error')throw new Error('QA: simulated reconciliation failed (HTTP 503)');return publicState();});
route('/api/portfolio/reconcile',()=>engine.reconcilePortfolio());
route('/api/markets/refresh',()=>{if(scenario==='error')throw new Error('QA: simulated market refresh failed (HTTP 503)');return engine.refresh();});
route('/api/hedge/settings',req=>engine.risk(req.body));
route('/api/hedge/enable',()=>engine.enable());
route('/api/hedge/pause',()=>engine.pause());
route('/api/hedge/pause-all',()=>engine.pauseAll());
route('/api/hedge/cancel',()=>engine.cancel());
route('/api/hedge/close',()=>engine.closeHedge());
route('/api/paper/price',req=>engine.paperPrice(req.body.price));
route('/api/paper/feed',req=>{if(req.body.source!=='fixture')throw new Error('QA only supports offline fixture data');return publicState();});
route('/api/demo/reset',()=>setScenario('normal'));
route('/api/demo/multi',()=>setScenario('normal'));
route('/api/mode',req=>{if(req.body.mode!=='paper')throw new Error('Live mode is unavailable in the isolated UI QA harness');return publicState();});
route('/api/scenario',req=>{
  const s=engine.state,spot=s.market.referencePrice;
  const expiry=Number(req.query.expiry)||s.fit?.settings.expiry||s.market.instruments[0]!.expiry;
  const iv=Math.min(3,Math.max(.01,Number(req.query.iv)||.75));
  const days=Number(req.query.days??0),now=Date.now()+days*86400000;
  const holdings=[...s.holdings,...(req.query.proposed==='true'?s.fit?.legs.map(l=>({instrument:l.instrument,quantity:l.quantity,averagePrice:l.instrument.ask||0}))||[]:[])];
  const points=scenarioSurface(engine.selected(),holdings,spot,expiry,iv,now).map(p=>({...p,totalValue:p.totalValue+s.hedge.actualPerp*(p.price-s.perpEntry),delta:p.delta+s.hedge.actualPerp}));
  const lp=modelLp(engine.selected(),spot,expiry,now,iv);
  const options=holdings.reduce((sum,h)=>{const v=modelOption(h.instrument,spot,now,iv);for(const k of ['price','delta','gamma','vega','theta'] as const)sum[k]+=h.quantity*v[k];return sum;},{price:0,delta:0,gamma:0,vega:0,theta:0});
  const sim=simulateStrategies(engine.selected(),s.market);
  return{points,modelAtSpot:{lp,options},comparisons:sim.comparisons,paths:sim.points,notes:sim.notes};
},'get');
route('/api/export',req=>req.query.kind==='history'?store.history('paper'):req.query.kind==='positions'?engine.state.positions:req.query.kind==='payoff'?payoffPoints(engine.selected(),engine.state.holdings,[],engine.state.market.referencePrice,engine.state.market.instruments[0]!.expiry):publicState(),'get');
app.use('/api',(_req,res)=>res.status(403).json({error:'This endpoint is intentionally unavailable in isolated paper QA; no live adapters or wallet credentials exist.'}));
app.use(express.static(resolve('dist')));
app.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/index.html')));
setScenario('normal');
const server=app.listen(port,'127.0.0.1',()=>console.log(`Isolated paper UI QA: http://127.0.0.1:${port} (temporary SQLite; no live adapter)`));
server.on('error',error=>{engine.stop();store.close();console.error(error.message);process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{engine.stop();server.close(()=>{store.close();process.exit(0);});});
