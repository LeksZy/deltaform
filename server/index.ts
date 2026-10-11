import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Engine } from './engine';
import { ASSET_CODES } from '../src/shared/multi-asset';
import { requireUnderlying } from '../src/shared/assets';
import { Store } from './store';
import { WalletAuth } from './auth';
import { AgentVault } from './secrets';
import { Gateway } from './live';
import { decompose, currentInventory, modelLp, modelOption } from '../src/quant/math';
import { scenarioSurface, simulateStrategies } from '../src/quant/simulation';
import { payoffPoints } from '../src/quant/fit';
import { prepareHyperliquidAgentApproval, submitHyperliquidAgentApproval } from '../src/venues/hyperliquid';
import { getMeteoraPools } from '../src/venues/meteora';
import { bybitConfig, getBybitAccount } from '../src/venues/bybit';
import { BybitOptions } from './bybit-options';
import { HedgeRecovery } from './hedge-recovery';
import { inspectHyperliquidRecovery } from '../src/venues/hyperliquid-recovery';

const store = new Store();
store.acquireWorker();
const engine = new Engine(store), auth = new WalletAuth(store), vault = new AgentVault(store);
const gateway = new Gateway(store, vault, () => engine.state); engine.gateway = gateway;
const options = new BybitOptions(engine, store, gateway);
const hedgeRecovery = new HedgeRecovery(engine, store, (owner, intent) =>
  inspectHyperliquidRecovery(owner, { ...intent, underlying: intent.underlying ?? 'SOL' }));
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (!['localhost', '127.0.0.1'].includes(req.hostname)) { res.status(403).json({ error: 'Loopback host required' }); return; }
  const origin = req.headers.origin;
  const allowed = new Set(['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:8787', 'http://localhost:8787', process.env.APP_ORIGIN].filter(Boolean));
  if (origin && !allowed.has(origin)) { res.status(403).json({ error: 'This local trading service rejects requests from this origin' }); return; }
  if (req.method === 'POST' && !req.is('application/json')) { res.status(415).json({ error: 'JSON request required' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '1mb' }));
function state() { engine.state.capabilities = { ...gateway.capabilities(engine.state), marketRefreshIntervalMs: engine.publicRefreshIntervalMs }; return engine.publicState(); }
function route(path: string, handler: (req: Request) => unknown | Promise<unknown>, method: 'get' | 'post' = 'post') {
  app[method](path, async (req, res) => {
    try { const data = await engine.queue.run(() => {
      const expected=req.get('X-Deltaform-Underlying');
      if(expected && expected !== (engine.state.activeUnderlying??'SOL')) throw new Error('The selected underlying changed in another tab. Refresh and review the intended asset before retrying.');
      return handler(req);
    }); res.json(data); }
    catch (error) { res.status(error instanceof z.ZodError ? 400 : 409).json({ error: error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : error instanceof Error ? error.message : 'Operation failed' }); }
  });
}
const walletVenue = z.enum(['meteora', 'hyperliquid']);
const venue = z.enum(['meteora', 'bybit', 'hyperliquid']);
const fitSchema = z.object({ expiry: z.number().positive(), coverage: z.number().min(0).max(1), budget: z.number().min(0).max(1e8), maxLegs: z.number().int().min(1).max(40), objective: z.enum(['payoff', 'gamma', 'superhedge']), maxUndercoverage: z.number().nonnegative().nullable().default(null), gamma: z.object({ expiry: z.number().nonnegative(), ivMode: z.enum(['market','manual']), ivPercent: z.number().positive().max(500), tolerance: z.number().min(0).max(1e12) }).optional() });
const riskSchema = z.object({ alphaPercent: z.number().min(.01).max(50), targetMode: z.enum(['dollar-neutral', 'preserve-hodl']),
  deltaDeadband: z.number().min(0).max(1000), notionalDeadband: z.number().min(0).max(1e6), cooldownMs: z.number().int().min(1000).max(3600000),
  maxOrderNotional: z.number().min(10).max(1e6), maxPerpNotional: z.number().min(10).max(1e7), maxLeverage: z.number().min(1).max(10),
  marginBuffer: z.number().min(.1).max(.95), maxSlippageBps: z.number().min(1).max(100), maxDataAgeMs: z.number().min(1000).max(60000),
  maxBasisBps: z.number().min(1).max(1000), deltaEmergency: z.number().positive().max(1e5) }).partial().strict();

route('/api/state', () => state(), 'get');
route('/api/health', () => ({ ok: true, mode: engine.state.mode, worker: true, now: Date.now() }), 'get');
route('/api/demo/reset', () => engine.reset());
route('/api/demo/multi', () => engine.reset(true));
route('/api/assets/select',req=>engine.selectAsset(z.object({underlying:z.string().min(1).max(100)}).parse(req.body).underlying));
route('/api/assets/settings',req=>engine.settings(z.object({fitSettings:fitSchema.extend({expiry:z.number().nonnegative()}).optional(),modelSettings:z.object({expiry:z.number().nonnegative(),ivMode:z.enum(['market','manual']),ivPercent:z.number().positive().max(500),daysAhead:z.number().min(0).max(365)}).optional()}).strict().parse(req.body)));
route('/api/portfolio/limits',req=>engine.portfolioLimits(z.object({maxGrossPerpNotional:z.number().min(10).max(1e8),maxLeverage:z.number().min(1).max(10),marginBuffer:z.number().min(.1).max(.95)}).strict().parse(req.body)));
route('/api/portfolio/scenario',req=>{const v=z.object({pricePercent:z.number().min(-50).max(50),ivPoints:z.number().min(-50).max(50)}).strict().parse(req.body);return engine.scenarioSettings(v.pricePercent,v.ivPoints);});
route('/api/hedge/pause-all',()=>engine.pauseAll());
route('/api/hedge/recovery/preview', () => hedgeRecovery.preview());
route('/api/hedge/recovery/confirm', req => hedgeRecovery.confirm(z.object({
  reviewId: z.string().uuid(), clientOrderId: z.string().regex(/^0x[\da-fA-F]{32}$/),
  acknowledgeUnknown: z.literal(true),
}).strict().parse(req.body)));
route('/api/mode', req => engine.mode(z.object({ mode: z.enum(['paper', 'live']) }).parse(req.body).mode));
route('/api/positions/select', req => engine.select(z.object({ ids: z.array(z.string()).max(100) }).parse(req.body).ids));
route('/api/positions/import', req => { const p = z.object({ owner: z.string().min(30).max(50), pool: z.string().min(30).max(50).optional() }).parse(req.body); return engine.importPositions(p.owner, p.pool); });
route('/api/positions/hypothetical', req => { const p = z.object({ name: z.string().min(1).max(100), bins: z.array(z.object({ id: z.number().int(), price: z.number().positive().max(1e8), x: z.number().nonnegative().max(1e8), y: z.number().nonnegative().max(1e10) })).min(1).max(1500) }).parse(req.body); return engine.addHypothetical(p.name, p.bins); });
route('/api/positions/rebase', () => engine.rebase());
route('/api/pools', () => getMeteoraPools(requireUnderlying(engine.state.activeUnderlying??'SOL')), 'get');
route('/api/decomposition', () => decompose(engine.selected()), 'get');
route('/api/markets/refresh', () => engine.refresh());
route('/api/portfolio/reconcile', () => engine.reconcilePortfolio());
route('/api/capital/start', req => engine.startCapitalTracking(z.object({ restart: z.boolean().default(false) }).strict().parse(req.body).restart));
route('/api/capital/flow', req => engine.recordCapitalFlow(z.object({ id: z.string().uuid(), kind: z.enum(['deposit', 'withdrawal']), amount: z.number().positive().max(1e9),
  effectiveAt: z.number().int().positive(), note: z.string().trim().min(1).max(300) }).strict().parse(req.body)));
route('/api/capital/flow/reverse', req => engine.reverseCapitalFlowEntry(z.object({ id: z.string().uuid() }).strict().parse(req.body).id));
route('/api/quote', req => engine.quote(fitSchema.parse(req.body)));
route('/api/hedge/settings', req => engine.risk(riskSchema.parse(req.body)));
route('/api/hedge/enable', () => engine.enable());
route('/api/hedge/pause', () => engine.pause());
route('/api/hedge/cancel', () => engine.cancel());
route('/api/hedge/close', () => engine.closeHedge());
route('/api/paper/price', req => engine.paperPrice(z.object({ price: z.number().min(.01).max(1e6) }).parse(req.body).price));
route('/api/paper/feed', req => engine.paperFeed(z.object({ source: z.enum(['fixture', 'live']) }).parse(req.body).source));

route('/api/accounts/challenge', req => { const p = z.object({ venue: walletVenue, address: z.string().max(50) }).parse(req.body); return auth.challenge(p.venue, p.address); });
route('/api/accounts/connect', async req => {
  const p = z.object({ venue: walletVenue, address: z.string().max(50), signature: z.string().max(300), challengeId: z.string().max(100), subaccountId: z.number().int().nonnegative().optional() }).parse(req.body);
  if (engine.anyActive() || store.get('bybitBasketPending')) throw new Error('Pause and reconcile orders before changing connected accounts');
  await auth.verify(p.venue, p.address, p.challengeId, p.signature);
  engine.state.accounts[p.venue] = { address: p.address, verified: true, connectedAt: Date.now(), subaccountId: p.subaccountId };
  engine.changed(`${p.venue} wallet ownership verified`); return state();
});
route('/api/accounts/disconnect', req => {
  const p = z.object({ venue }).parse(req.body); if (engine.anyActive() || store.get('bybitBasketPending')) throw new Error('Pause and reconcile orders before disconnecting');
  if (p.venue === 'bybit' && engine.allHoldings().some(h => h.quantity !== 0)) throw new Error('Bybit still has option exposure. Close/reconcile it in the venue before disconnecting its risk feed.');
  if (p.venue === 'bybit') { store.delete('bybitAccountStatus'); engine.state.balances.reserves = 0; }
  engine.state.accounts[p.venue] = null; engine.changed(`${p.venue} account disconnected locally`); return state();
});

interface AgentRequest { owner: string; address: string; nonce: number; createdAt: number; revoke?: boolean }
route('/api/agent/prepare', req => {
  if (engine.state.mode !== 'live') throw new Error('Agent authorization is only needed in live mode');
  const owner = engine.state.accounts.hyperliquid?.address; if (!owner) throw new Error('Connect the Hyperliquid owner wallet first');
  if (engine.anyActive()) throw new Error('Pause and reconcile hedge execution before replacing agent authorization');
  const { revoke } = z.object({ revoke: z.boolean().optional() }).parse(req.body);
  const address = revoke ? '0x0000000000000000000000000000000000000000' : vault.status(owner)?.address || vault.create(owner);
  const nonce = Date.now(), requestId = randomUUID(); store.set('agentRequest:' + requestId, { owner, address, nonce, createdAt: nonce, revoke } satisfies AgentRequest);
  return { requestId, address, ...prepareHyperliquidAgentApproval(address, nonce) };
});
route('/api/agent/approve', async req => {
  const p = z.object({ requestId: z.string().uuid(), signature: z.string().regex(/^0x[\da-fA-F]+$/) }).parse(req.body);
  const request = store.get<AgentRequest>('agentRequest:' + p.requestId);
  if (!request || Date.now() - request.createdAt > 300000 || engine.state.accounts.hyperliquid?.address !== request.owner) throw new Error('Agent approval request expired or account changed');
  await submitHyperliquidAgentApproval(request.owner, request.address, request.nonce, p.signature as `0x${string}`);
  if (request.revoke) vault.revokeLocal(request.owner); else vault.approve(request.owner);
  store.delete('agentRequest:' + p.requestId); engine.event('authorization', request.revoke ? 'Hyperliquid agent revoked at venue and removed locally' : 'Hyperliquid agent approved by owner'); engine.save(); return state();
});

// Old Derive endpoints are retired; they cannot register permissions or submit legacy baskets.
app.use('/api/derive', (_req, res) => res.status(410).json({ error: 'Options execution moved to Bybit. Legacy Derive records are archived; no Derive action was sent.' }));
route('/api/bybit/connect', async () => {
  if (engine.state.mode !== 'live') throw new Error('Switch to live mode to connect a real Bybit account. Paper execution needs no API credentials.');
  if (engine.state.optionsMigration?.blocked) throw new Error(engine.state.optionsMigration.reason);
  if (engine.anyActive() || store.get('bybitBasketPending')) throw new Error('Pause and reconcile pending orders before changing the Bybit connection');
  const credentials = gateway.auth();
  if (!credentials) throw new Error('Set BYBIT_API_KEY and BYBIT_API_SECRET in the server .env, restart the server, then connect. Keep these API credentials out of chat and source control.');
  const account = await getBybitAccount(credentials, { mode: 'discovery' });
  const previous = engine.state.accounts.bybit;
  const cached = store.get<{ network: string }>('bybitAccountStatus');
  if (previous && (previous.address !== account.accountId || cached?.network !== bybitConfig().network) && engine.allHoldings().some(h => h.quantity !== 0))
    throw new Error('The previous Bybit account/network still has option exposure. Reconcile it before changing the portfolio boundary.');
  gateway.cacheBybitAccount(account);
  engine.state.accounts.bybit = { address: account.accountId, verified: true, connectedAt: Date.now() };
  engine.reconcileHoldings(account.holdings); engine.state.balances.reserves = account.optionCash;
  engine.changed('Bybit account verified and multi-asset options/collateral reconciled'); return state();
});
route('/api/bybit/check', async () => {
  if (engine.state.optionsMigration?.blocked) throw new Error(engine.state.optionsMigration.reason);
  const account = await gateway.bybitAccount({ mode: 'discovery' });
  if (engine.state.mode === 'live') { engine.reconcileHoldings(account.holdings); engine.state.balances.reserves = account.optionCash; }
  engine.changed('Bybit account permissions, positions and collateral refreshed'); return state();
});
route('/api/quote/execute', async req => {
  const p = z.object({ quoteId: z.string(), execution: z.object({ mode: z.enum(['quoted-ask', 'marketable-ioc']),
    maxSlippagePercent: z.number().min(0).max(50) }).default({ mode: 'quoted-ask', maxSlippagePercent: 0 }) }).strict().parse(req.body);
  if (engine.state.mode === 'paper') return engine.executePaperQuote(p.quoteId);
  return options.prepare(p.quoteId, p.execution);
});
route('/api/quote/submit', async req => {
  const { requestId } = z.object({ requestId: z.string().uuid() }).strict().parse(req.body);
  const optionExecution = await options.submit(requestId);
  return { ...state(), optionExecution };
});
route('/api/quote/reconcile', async () => {
  const optionExecution = await options.reconcile(); return { ...state(), optionExecution };
});

route('/api/scenario', req => {
  const s = engine.state, spot = s.market.referencePrice;
  const expiry = Number(req.query.expiry) || s.fit?.settings.expiry || s.holdings[0]?.instrument.expiry || s.market.instruments[0]?.expiry || Date.now() + 30 * 86400000;
  const iv = Math.min(3, Math.max(.01, Number(req.query.iv) || .75));
  const days = Number(req.query.days ?? 0);
  if (!Number.isFinite(days) || days < 0 || days > 365) throw new Error('Scenario days must be between 0 and 365');
  const includeProposal = req.query.proposed === 'true';
  const holdings = [...s.holdings, ...(includeProposal ? s.fit?.legs.map(l => ({ instrument: l.instrument, quantity: l.quantity, averagePrice: l.instrument.ask || 0 })) || [] : [])];
  const modelTime = Date.now() + days * 86400000;
  if (days > 0 && modelTime >= Math.min(expiry, ...holdings.filter(h => h.quantity !== 0).map(h => h.instrument.expiry))) throw new Error('Choose a scenario time before the earliest option expiry; settlement after that point depends on the price path.');
  const points = scenarioSurface(engine.selected(), holdings, spot, expiry, iv, modelTime).map(p => ({ ...p,
    totalValue: p.totalValue + s.hedge.actualPerp * (p.price - s.perpEntry),
    delta: p.delta + s.hedge.actualPerp }));
  const lp = modelLp(engine.selected(), spot, expiry, modelTime, iv);
  const options = holdings.reduce((total, h) => {
    const value = modelOption(h.instrument, spot, modelTime, iv);
    for (const key of ['price', 'delta', 'gamma', 'vega', 'theta'] as const) total[key] += h.quantity * value[key];
    return total;
  }, { price: 0, delta: 0, gamma: 0, vega: 0, theta: 0 });
  const simulation = simulateStrategies(engine.selected(), s.market);
  return { points, modelAtSpot: { lp, options }, comparisons: simulation.comparisons, paths: simulation.points, notes: simulation.notes };
}, 'get');
route('/api/analytics', () => {
  const s = engine.state, positions = engine.selected(), spot = s.market.referencePrice;
  const inv = currentInventory(positions, spot), accounting = engine.publicState().accounting!;
  const { optionsValue, perpUnrealized: unrealized, equity: nav } = accounting;
  return { inventory: inv, optionsValue, perpUnrealized: unrealized, initialCapital: s.initialCapital, nav,
    netPnl: accounting.pnl,
    boundaries: 'Selected Meteora positions and fees, all supported options in the connected Bybit account (USDT/USDC parity approximation), shared Hyperliquid account equity. Unselected wallet balances excluded.' };
}, 'get');
app.get('/api/export', async (req, res, next) => {
 try { await engine.queue.run(() => {
  const kind = String(req.query.kind || 'hedge');
  const s = engine.state;
  const expiry = s.holdings[0]?.instrument.expiry ?? s.market.instruments[0]?.expiry ?? Date.now();
  const tracking = engine.publicState().capitalTracking;
  const data = kind === 'capital' ? { tracking, openingSnapshot: tracking ? store.get('capitalSnapshot:' + tracking.baseline.id) : null, accounting: engine.publicState().accounting }
    : kind === 'positions' ? s.positions : kind === 'payoff' ? s.fit?.points || payoffPoints(engine.selected(), s.holdings, [], s.market.referencePrice, expiry) : kind === 'history' ? store.history(s.mode) : { proposal: s.fit, holdings: s.holdings, hedge: s.hedge };
  res.setHeader('Content-Disposition', `attachment; filename="dlmm-${['positions', 'payoff', 'history', 'capital'].includes(kind) ? kind : 'hedge'}.json"`);
  res.type('json').send(JSON.stringify(data, null, 2));
 }); } catch(error) {next(error);}
});
const dist = resolve('dist');
if (existsSync(dist)) { app.use(express.static(dist)); app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html'))); }
app.use((error: unknown, _req: Request, res: Response, _next: unknown) => res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid request' }));
const port = Number(process.env.PORT || 8787);
const server = app.listen(port, '127.0.0.1', () => { engine.start(); console.log(`DLMM Hedge Lab API on http://127.0.0.1:${port} (${engine.state.mode})`); });
server.on('error', error => { console.error(`Server could not bind: ${error.message}`); store.close(); process.exit(1); });
const shutdown = () => { engine.stop(); server.close(() => { void engine.queue.run(() => { engine.save(); store.close(); process.exit(0); }); }); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
