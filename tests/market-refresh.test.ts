import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, initialState, type LiveGateway } from '../server/engine';
import { Store } from '../server/store';
import { demoMarket } from '../src/quant/fixtures';
import type { MarketSnapshot } from '../src/shared/types';

let now = Date.UTC(2026, 8, 27, 12);
const engines: Engine[] = [], stores: Store[] = [];
beforeEach(() => {
  now = Date.UTC(2026, 8, 27, 12);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubEnv('PUBLIC_MARKET_REFRESH_MS', '10000');
});
afterEach(() => {
  engines.splice(0).forEach(engine => engine.stop());
  stores.splice(0).forEach(store => store.close());
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});
function snapshot(): MarketSnapshot { return { ...demoMarket(now, 200), source: 'live', poolPrice: 200 }; }
function harness() {
  const store = new Store(':memory:'); stores.push(store);
  const engine = new Engine(store); engines.push(engine);
  engine.state = initialState('live'); engine.store.set('activeMode', 'live'); engine.save();
  const market = vi.fn(async () => snapshot());
  const forbidden = vi.fn(async () => { throw new Error('No private/account/trading calls expected'); });
  const ready = vi.fn((): string | null => 'Wallet is disconnected and trading disabled');
  const gateway: LiveGateway = { market, ready, positions: forbidden, portfolio: forbidden, order: forbidden, reconcile: forbidden, cancel: forbidden };
  engine.gateway = gateway;
  return { engine, gateway, market, forbidden, ready };
}

describe('independent public market refresh', () => {
  it('refreshes paused live data without wallet readiness, account reads or execution', async () => {
    const { engine, market, forbidden, ready } = harness();
    expect(engine.state.hedge.enabled).toBe(false);
    await engine.tick();
    expect(market).toHaveBeenCalledTimes(1); expect(engine.state.market.source).toBe('live');
    expect(engine.state.market.timestamp).toBe(now); expect(engine.state.market.referencePrice).toBe(200);
    expect(engine.state.hedge.enabled).toBe(false); expect(engine.state.hedge.status).toBe('paused');
    expect(ready).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled();
    now += 10_000; await engine.tick();
    expect(market).toHaveBeenCalledTimes(2); expect(engine.state.market.timestamp).toBe(now);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('continues public updates when live execution readiness is blocked', async () => {
    const { engine, market, forbidden, ready } = harness(); engine.state.hedge.enabled = true;
    await engine.tick();
    expect(ready).toHaveBeenCalledOnce(); expect(engine.state.hedge.status).toBe('suspended');
    expect(engine.state.hedge.reason).toContain('disconnected');
    now += 10_000; await engine.tick();
    expect(market).toHaveBeenCalledTimes(2); expect(engine.state.market.timestamp).toBe(now);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('throttles with a separate attempt clock and lets explicit refresh restart the interval', async () => {
    const { engine, market } = harness();
    await engine.tick();
    for (let j = 0; j < 4; j++) { now += 2000; await engine.tick(); }
    expect(market).toHaveBeenCalledTimes(1);
    await engine.refresh(); expect(market).toHaveBeenCalledTimes(2);
    now += 2000; await engine.tick(); expect(market).toHaveBeenCalledTimes(2);
    now += 8000; await engine.tick(); expect(market).toHaveBeenCalledTimes(3);
  });

  it('backs off partial timestamp-zero responses rather than polling them every two seconds', async () => {
    const { engine, market, forbidden } = harness(); let partial = true;
    market.mockImplementation(async () => partial ? { ...snapshot(), timestamp: 0, status: { derive: 'Unavailable' } } : snapshot());
    await engine.tick(); expect(market).toHaveBeenCalledTimes(1);
    expect(engine.state.market.timestamp).toBe(0); expect(engine.state.market.status.publicFeed).toMatch(/partial or stale/);
    now += 2000; await engine.tick(); expect(market).toHaveBeenCalledTimes(1);
    now += 8000; await engine.tick(); expect(market).toHaveBeenCalledTimes(2); // Retry after 10s.
    now += 10_000; await engine.tick(); expect(market).toHaveBeenCalledTimes(2);
    now += 10_000; await engine.tick(); expect(market).toHaveBeenCalledTimes(3); // Then 20s.
    now += 20_000; await engine.tick(); expect(market).toHaveBeenCalledTimes(3);
    partial = false; now += 20_000; await engine.tick(); expect(market).toHaveBeenCalledTimes(4); // Then 40s.
    expect(engine.state.market.timestamp).toBe(now);
    now += 10_000; await engine.tick(); expect(market).toHaveBeenCalledTimes(5); // Healthy cadence restored.
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('marks retained prices stale after network failure and recovers without enabling trading', async () => {
    const { engine, market, forbidden } = harness();
    market.mockRejectedValueOnce(new Error('Public market timeout'));
    await expect(engine.tick()).resolves.toBeUndefined();
    expect(engine.state.market.timestamp).toBe(0); expect(engine.state.market.status.publicFeed).toMatch(/failed/);
    expect(engine.state.hedge.status).toBe('paused'); expect(engine.state.events.filter(e => e.type === 'market-error')).toHaveLength(1);
    now += 2000; await engine.tick(); expect(market).toHaveBeenCalledTimes(1);
    now += 8000; await engine.tick(); expect(market).toHaveBeenCalledTimes(2);
    expect(engine.state.market.timestamp).toBe(now); expect(engine.state.hedge.enabled).toBe(false);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('keeps public cadence while account reconciliation uses a longer backoff', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { engine, market, gateway, ready, forbidden } = harness();
    ready.mockReturnValue(null); engine.state.hedge.enabled = true;
    const portfolio = vi.fn(async () => { throw new Error('Private account API unavailable'); }); gateway.portfolio = portfolio;
    engine.start();
    for (let j = 0; j < 26; j++) { now += 2000; await vi.advanceTimersByTimeAsync(2000); }
    expect(market).toHaveBeenCalledTimes(6); // t=2,12,22,32,42,52 seconds.
    expect(portfolio).toHaveBeenCalledTimes(5); // t=2,4,8,16,32 seconds.
    expect(engine.state.market.timestamp).toBe(now); expect(forbidden).not.toHaveBeenCalled();
  });

  it('never overlaps slow public requests from the persistent worker', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { engine, market, forbidden } = harness(); let resolveMarket!: (value: MarketSnapshot) => void;
    market.mockImplementationOnce(() => new Promise(resolve => { resolveMarket = resolve; }));
    engine.start(); now += 2000; await vi.advanceTimersByTimeAsync(2000);
    expect(market).toHaveBeenCalledTimes(1);
    now += 20_000; await vi.advanceTimersByTimeAsync(20_000); expect(market).toHaveBeenCalledTimes(1);
    resolveMarket(snapshot()); await vi.advanceTimersByTimeAsync(0);
    now += 10_000; await vi.advanceTimersByTimeAsync(10_000); expect(market).toHaveBeenCalledTimes(2);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('clamps configurable public intervals to at least five seconds', () => {
    vi.stubEnv('PUBLIC_MARKET_REFRESH_MS', '1000'); expect(harness().engine.publicRefreshIntervalMs).toBe(5000);
    vi.stubEnv('PUBLIC_MARKET_REFRESH_MS', 'invalid'); expect(harness().engine.publicRefreshIntervalMs).toBe(10_000);
    vi.stubEnv('PUBLIC_MARKET_REFRESH_MS', '120000'); expect(harness().engine.publicRefreshIntervalMs).toBe(60_000);
  });
});
