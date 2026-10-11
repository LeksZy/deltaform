import { randomUUID } from 'node:crypto';
import { bybitConfig, prepareBybitOrders, executeBybitOrder, reconcileBybitOrder, type PreparedBybitOrder } from '../src/venues/bybit';
import { VenueError } from '../src/venues/http';
import { optionExecutionPreview } from '../src/shared/option-execution';
import type { OptionExecutionSettings, OptionHolding } from '../src/shared/types';
import type { Engine } from './engine';
import type { Gateway } from './live';
import type { Store } from './store';

export interface BybitBasket {
  underlying?: string;
  venue: 'bybit'; network: 'mainnet' | 'testnet'; accountId: string; credentialFingerprint: string;
  quoteId: string; orders: PreparedBybitOrder[]; statuses: string[]; fills: number[];
  baseline: Record<string, number>; createdAt: number; expiresAt: number; fingerprint: string;
  maxTotalCost: number;
}
export interface BybitOptionsClient {
  prepare: typeof prepareBybitOrders; execute: typeof executeBybitOrder; reconcile: typeof reconcileBybitOrder;
}
const realClient: BybitOptionsClient = { prepare: prepareBybitOrders, execute: executeBybitOrder, reconcile: reconcileBybitOrder };
type OptionsGateway = Pick<Gateway, 'auth' | 'credentialFingerprint' | 'bybitAccount' | 'positions'>;

/** Explicit purchases only. HTTP handlers and worker transitions share Engine.queue. */
export class BybitOptions {
  constructor(private engine: Engine, private store: Store, private gateway: OptionsGateway, private client = realClient) {}
  private assertLive() {
    if (this.engine.state.mode !== 'live' || process.env.ENABLE_LIVE_EXECUTION !== 'true') throw new Error('Live execution is disabled');
    if (this.engine.state.optionsMigration?.blocked) throw new Error(this.engine.state.optionsMigration.reason);
    if (this.engine.state.optionsVenue !== 'bybit') throw new Error('The active options venue is not Bybit');
  }
  private identity() {
    const auth = this.gateway.auth(), account = this.engine.state.accounts.bybit, fingerprint = this.gateway.credentialFingerprint();
    if (!auth || !account?.verified || !fingerprint) throw new Error('Configure and connect the Bybit API account before buying options');
    return { auth, account, fingerprint };
  }
  private readBasket(requestId: string) {
    const basket = this.store.get<BybitBasket>('bybitBasket:' + requestId);
    const identity = this.identity();
    if (!basket || basket.venue !== 'bybit' || basket.network !== bybitConfig().network
      || basket.accountId !== identity.account.address || basket.credentialFingerprint !== identity.fingerprint)
      throw new Error('Bybit basket, account, credentials or network changed. Reconcile with the original account; no replacement order was sent.');
    return { basket, ...identity };
  }
  private quantities(holdings: OptionHolding[]) {
    return Object.fromEntries(holdings.filter(h => h.quantity !== 0).map(h => [h.instrument.name, h.quantity]));
  }
  private async reconcileContext() {
    const selected = this.engine.selected();
    const [snapshot, refreshed] = await Promise.all([
      this.gateway.bybitAccount(),
      Promise.all(selected.map(async previous => {
        if (!previous.owner || previous.source !== 'live') throw new Error('A live hedge quote requires an actual Meteora position');
        const positions = await this.gateway.positions(previous.owner, previous.pool, this.engine.state.activeUnderlying??'SOL');
        const current = positions.find(p => p.id === previous.id);
        if (!current) throw new Error('A selected Meteora position no longer exists');
        return { previous, current };
      })),
    ]);
    if (snapshot.openOrders.length) throw new Error('Reconcile all Bybit open orders before preparing another basket');
    this.engine.reconcileHoldings(snapshot.holdings);
    this.engine.state.balances.reserves = snapshot.optionCash;
    for (const { previous, current } of refreshed) {
      const principal = new Map(previous.bins.map(b => [b.id, b.price * b.x + b.y]));
      const changed = current.bins.length !== previous.bins.length || current.bins.some(b => !principal.has(b.id)
        || Math.abs(principal.get(b.id)! - (b.price * b.x + b.y)) > Math.max(.01, principal.get(b.id)! * .0001));
      if (changed) { this.engine.changed('Meteora allocation changed; refresh and review its original benchmark before quoting'); throw new Error('Meteora liquidity allocation changed; review the benchmark before re-quoting'); }
      Object.assign(previous, current, { benchmarkBins: previous.benchmarkBins ?? previous.bins,
        benchmarkAt: previous.benchmarkAt, benchmarkPrice: previous.benchmarkPrice, benchmarkX: previous.benchmarkX, benchmarkY: previous.benchmarkY });
    }
    this.engine.updateDelta(); this.engine.save(); return snapshot;
  }
  async prepare(quoteId: string, execution: OptionExecutionSettings) {
    this.assertLive();
    if (this.store.get('bybitBasketPending')) throw new Error('A previous Bybit basket requires reconciliation before another purchase');
    const { auth, account, fingerprint } = this.identity();
    const snapshot = await this.reconcileContext();
    const fit = this.engine.validateQuote(quoteId, execution.mode === 'marketable-ioc');
    if (fit.legs.some(l => l.instrument.venue !== 'bybit')) throw new Error('This quote is not a Bybit options portfolio; refresh markets and re-quote');
    const preview = optionExecutionPreview(fit, execution);
    const orders = await this.client.prepare(fit, auth, execution);
    if (Date.now() >= preview.expiresAt) throw new Error('Hedge review expired while preparing orders; request a new quote');
    if (!orders.length || orders.some(o => o.accountId !== account.address || o.network !== bybitConfig().network)) throw new Error('Prepared Bybit orders do not match the connected account/network');
    const requestId = randomUUID();
    const basket: BybitBasket = { underlying: this.engine.state.activeUnderlying??'SOL', venue: 'bybit', network: bybitConfig().network, accountId: account.address,
      credentialFingerprint: fingerprint, quoteId, orders, statuses: orders.map(() => 'prepared'), fills: orders.map(() => 0),
      baseline: this.quantities(snapshot.holdings), createdAt: Date.now(), expiresAt: preview.expiresAt,
      fingerprint: fit.fingerprint, maxTotalCost: preview.maxTotalCost };
    this.store.set('bybitBasket:' + requestId, basket);
    return { requiresConfirmation: true, requestId, orders, preview, expiresAt: basket.expiresAt };
  }
  private storeBasket(id: string, basket: BybitBasket) { this.store.set('bybitBasket:' + id, basket); }
  private async snapshotAfterBasket(id: string, basket: BybitBasket) {
    const account = await this.gateway.bybitAccount();
    this.engine.reconcileHoldings(account.holdings);
    this.engine.state.balances.reserves = account.optionCash;
    this.engine.changed('Actual Bybit option holdings and collateral reconciled');
    const expected = { ...basket.baseline };
    for (let i = 0; i < basket.orders.length; i++) expected[basket.orders[i]!.instrument] = (expected[basket.orders[i]!.instrument] ?? 0) + basket.fills[i]!;
    const actual = this.quantities(account.holdings);
    const fillsVisible = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].every(symbol => Math.abs((expected[symbol] ?? 0) - (actual[symbol] ?? 0)) < 1e-8);
    const resolved = !basket.statuses.some(s => ['submitting', 'unknown', 'acknowledged', 'open'].includes(s));
    if (resolved && fillsVisible && !account.openOrders.length) {
      if (this.store.get('bybitBasketPending') === id) this.store.delete('bybitBasketPending');
      return true;
    }
    this.engine.suspend('Bybit orders or their position updates remain unresolved. Reconcile before another purchase or automatic hedge.');
    return false;
  }
  async submit(requestId: string) {
    this.assertLive();
    const { basket, auth } = this.readBasket(requestId);
    if (this.store.get('bybitBasketPending') || basket.statuses.some(s => s !== 'prepared')) throw new Error('This or another basket was already submitted. Reconcile before another purchase.');
    if((basket.underlying??'SOL')!==(this.engine.state.activeUnderlying??'SOL')) throw new Error('Select the underlying reviewed in this basket before submitting');
    await this.reconcileContext();
    if (Date.now() >= basket.expiresAt || this.engine.state.fit?.id !== basket.quoteId || this.engine.currentFingerprint() !== basket.fingerprint)
      throw new Error('Basket review expired or the portfolio/quote changed; prepare a fresh Bybit hedge');
    if (this.engine.state.fit?.settings.objective === 'gamma') this.engine.validateQuote(basket.quoteId, true);
    this.store.set('bybitBasketPending', requestId);
    let reason: string | null = null;
    for (let i = 0; i < basket.orders.length; i++) {
      const order = basket.orders[i]!;
      basket.statuses[i] = 'submitting'; this.storeBasket(requestId, basket);
      let acknowledged = false;
      try {
        const ack = await this.client.execute(order, auth);
        acknowledged = true;
        this.store.set(`bybitBasketResult:${requestId}:${i}`, ack);
        basket.statuses[i] = 'acknowledged'; this.storeBasket(requestId, basket);
        const result = await this.client.reconcile(auth, order);
        basket.fills[i] = result.filled;
        basket.statuses[i] = !result.resolved ? 'unknown' : !result.terminal ? 'open' : 'terminal';
        this.storeBasket(requestId, basket);
        this.engine.event('options-order', 'Bybit order acknowledged; reconciled fills determine portfolio risk',
          { instrument: order.instrument, orderLinkId: order.orderLinkId, filled: result.filled, status: result.status });
        if (!result.resolved || !result.terminal || result.filled + 1e-9 < order.quantity) {
          reason = `${order.instrument}: ${result.resolved ? `filled ${result.filled} of ${order.quantity}` : 'order outcome is unresolved'}. Remaining legs were not sent. Reconcile before reviewing another hedge.`;
          break;
        }
      } catch (error) {
        const definitelyUnsent = !acknowledged && error instanceof VenueError && !error.ambiguous;
        basket.statuses[i] = definitelyUnsent ? 'rejected' : 'unknown'; this.storeBasket(requestId, basket);
        reason = definitelyUnsent ? error.message + ' Remaining legs were not sent.' : 'Bybit order outcome is unresolved. Reconcile the stored order ID before any retry; remaining legs were not sent.';
        this.engine.event('options-order-stopped', reason, { instrument: order.instrument, orderLinkId: order.orderLinkId }); break;
      }
    }
    if (reason) this.engine.suspend(reason);
    const resolved = await this.snapshotAfterBasket(requestId, basket);
    return { complete: reason === null && resolved, reason: reason ?? (resolved ? null : 'Bybit fill/account reconciliation is still pending.') };
  }
  async reconcile() {
    if (this.engine.state.mode !== 'live') return { complete: true, reason: null };
    if (this.engine.state.optionsMigration?.blocked) throw new Error(this.engine.state.optionsMigration.reason);
    const requestId = this.store.get<string>('bybitBasketPending');
    if (!requestId) {
      const account = await this.gateway.bybitAccount();
      this.engine.reconcileHoldings(account.holdings); this.engine.state.balances.reserves = account.optionCash;
      this.engine.changed('Bybit positions and open orders refreshed');
      if (account.openOrders.length) throw new Error('Bybit still has open orders. Review them in Bybit before purchasing or hedging.');
      return { complete: true, reason: null };
    }
    const { basket, auth } = this.readBasket(requestId);
    for (let i = 0; i < basket.orders.length; i++) {
      if (['prepared', 'rejected'].includes(basket.statuses[i]!)) continue;
      const result = await this.client.reconcile(auth, basket.orders[i]!);
      basket.fills[i] = result.filled;
      basket.statuses[i] = !result.resolved ? 'unknown' : !result.terminal ? 'open' : 'terminal';
      this.storeBasket(requestId, basket);
    }
    const resolved = await this.snapshotAfterBasket(requestId, basket);
    if (!resolved) throw new Error('Bybit order/fill state remains unresolved. No replacement order has been submitted.');
    this.engine.event('options-reconciled', 'All submitted Bybit legs reached terminal states and fills are reflected in positions. Unsubmitted quantities can be re-quoted.');
    this.engine.save(); return { complete: true, reason: null };
  }
}
