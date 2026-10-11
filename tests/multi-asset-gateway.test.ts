import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gateway } from '../server/live';
import { initialState } from '../server/engine';
import { Store } from '../server/store';
import type { AgentVault } from '../server/secrets';
import type { AppState, OptionHolding } from '../src/shared/types';
import { getBybitAccount, getBybitMarket, type BybitAccount } from '../src/venues/bybit';
import { getHyperliquidAccount, getHyperliquidMarket, executeHyperliquidOrder, cancelHyperliquidOrder } from '../src/venues/hyperliquid';
import { getMeteoraPool, getMeteoraPools, getMeteoraPositions } from '../src/venues/meteora';

vi.mock('../src/venues/bybit', () => ({
  getBybitAccount: vi.fn(), getBybitMarket: vi.fn(),
  bybitConfig: () => ({ version: 'v5', network: 'mainnet', base: 'https://unused.invalid', maxStablecoinBasisBps: 50 }),
}));
vi.mock('../src/venues/meteora', () => ({ getMeteoraPool: vi.fn(), getMeteoraPools: vi.fn(), getMeteoraPositions: vi.fn() }));
vi.mock('../src/venues/hyperliquid', () => ({
  getHyperliquidAccount: vi.fn(), getHyperliquidMarket: vi.fn(), getHyperliquidAttribution: vi.fn(async () => { throw new Error('No optional history in this fixture'); }),
  executeHyperliquidOrder: vi.fn(), cancelHyperliquidOrder: vi.fn(), reconcileHyperliquidOrder: vi.fn(), hyperliquidInfo: vi.fn(),
}));

const now = 1790750000000, owner = '0x1111111111111111111111111111111111111111', agent = '0x2222222222222222222222222222222222222222';
const holdings: OptionHolding[] = [
  { instrument: { underlying: 'SOL', name: 'SOL-30OCT26-120-P-USDT' } as OptionHolding['instrument'], quantity: 2, averagePrice: 3 },
  { instrument: { underlying: 'BTC', name: 'BTC-30OCT26-80000-P-USDT' } as OptionHolding['instrument'], quantity: .02, averagePrice: 1000 },
];
function bybit(): BybitAccount {
  return { accountId: '123', holdings, openOrders: [], optionCash: 500, usdtCash: 500, availableBalance: 450, timestamp: Date.now(),
    permissions: { canTrade: true, readOnly: false, message: 'Fixture permissions' }, excludedAssets: [], riskBlockers: [] };
}
function hyperliquid() {
  const allPositions = [
    { coin: 'SOL', size: -2, entryPrice: 120, unrealizedPnl: -2, marginUsed: 121, leverage: 2, supported: true },
    { coin: 'BTC', size: -.02, entryPrice: 80000, unrealizedPnl: 10, marginUsed: 800, leverage: 2, supported: true },
  ];
  return { address: owner, underlying: 'SOL' as const, actualPerp: -2, allPositions,
    equity: 5000, marginUsed: 921, withdrawable: 4000, timestamp: Date.now(),
    collateralInfo: { mode: 'unifiedAccount' as const, source: 'shared USDC balance' as const, equity: 5000, policyCollateral: 4150,
      accountPolicyCollateral: 4950, spotUsdc: 5000, spotHolds: 971, timestamp: Date.now() },
    state: { assetPositions: allPositions.map(p => ({ position: { coin: p.coin, szi: String(p.size), entryPx: String(p.entryPrice), marginUsed: String(p.marginUsed), leverage: { type: 'cross', value: p.leverage } } })) },
    openOrders: [], fills: [], spot: { balances: [{ coin: 'USDC', token: 0, total: '5000', hold: '971' }] }, agents: [{ address: agent, validUntil: now + 60000 }] };
}

let store: Store, state: AppState, gateway: Gateway, privateKey: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubEnv('BYBIT_API_KEY', 'fixture-public-key'); vi.stubEnv('BYBIT_API_SECRET', 'fixture-secret');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network access in gateway fixture'); }));
  store = new Store(':memory:'); state = initialState('live'); state.activeUnderlying = 'SOL';
  state.accounts = { meteora: { address: 'fixture-solana-owner', connectedAt: now, verified: true },
    bybit: { address: '123', connectedAt: now, verified: true }, hyperliquid: { address: owner, connectedAt: now, verified: true } };
  privateKey = vi.fn(() => { throw new Error('Read-only test must never obtain signing key'); });
  gateway = new Gateway(store, { configured: true, status: () => ({ approved: true, address: agent }), privateKey } as unknown as AgentVault, () => state);
  gateway.cacheBybitAccount(bybit());
  vi.mocked(getBybitAccount).mockImplementation(async () => bybit());
  vi.mocked(getHyperliquidAccount).mockImplementation(async () => hyperliquid());
  vi.mocked(getMeteoraPositions).mockResolvedValue([]);
});
afterEach(async () => {
  await Promise.resolve(); await Promise.resolve();
  expect(executeHyperliquidOrder).not.toHaveBeenCalled(); expect(cancelHyperliquidOrder).not.toHaveBeenCalled(); expect(privateKey).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled(); store.close(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe('multi-asset gateway account snapshots', () => {
  it('expires the paused account cache from the original fetch, without sliding on reads', async () => {
    const first = await gateway.portfolio(state);
    vi.setSystemTime(now + 4000); expect((await gateway.portfolio(state)).accountTimestamp).toBe(first.accountTimestamp);
    expect(getHyperliquidAccount).toHaveBeenCalledTimes(1); expect(getBybitAccount).toHaveBeenCalledTimes(1);
    vi.setSystemTime(now + 5000); expect((await gateway.portfolio(state)).accountTimestamp).toBe(now + 5000);
    expect(getHyperliquidAccount).toHaveBeenCalledTimes(2); expect(getBybitAccount).toHaveBeenCalledTimes(2);
  });
  it('recomputes selected perp, entry price and option holdings from the same cached account', async () => {
    const sol = await gateway.portfolio(state);
    state.activeUnderlying = 'BTC'; vi.setSystemTime(now + 1000);
    const btc = await gateway.portfolio(state);
    expect(sol).toMatchObject({ actualPerp: -2, entryPrice: 120, optionCash: 500 });
    expect(btc).toMatchObject({ actualPerp: -.02, entryPrice: 80000, optionCash: 500 });
    expect(btc.holdings.map(h => h.instrument.underlying)).toEqual(['BTC']);
    expect(btc.allHoldings).toHaveLength(2); expect(getHyperliquidAccount).toHaveBeenCalledTimes(1);
  });
  it('preserves venue margin, leverage and account-wide collateral for every underlying', async () => {
    const snapshot = await gateway.portfolio(state);
    expect(snapshot.allPerps).toEqual([
      { coin: 'SOL', size: -2, entryPrice: 120, marginUsed: 121, leverage: 2 },
      { coin: 'BTC', size: -.02, entryPrice: 80000, marginUsed: 800, leverage: 2 },
    ]);
    expect(snapshot.collateralInfo).toMatchObject({ owner, equity: 5000, accountPolicyCollateral: 4950 });
  });
  it('bypasses the cache for enabled automation and pending reconciliation', async () => {
    await gateway.portfolio(state);
    state.hedge.enabled = true; vi.setSystemTime(now + 1); await gateway.portfolio(state);
    state.hedge.enabled = false; state.hedge.pendingOrder = '0xfixture-pending'; vi.setSystemTime(now + 2); await gateway.portfolio(state);
    expect(getHyperliquidAccount).toHaveBeenCalledTimes(3); expect(getBybitAccount).toHaveBeenCalledTimes(3);
  });
  it('invalidates the account cache on owner change', async () => {
    await gateway.portfolio(state); state.accounts.hyperliquid!.address = '0x3333333333333333333333333333333333333333';
    await gateway.portfolio(state); expect(getHyperliquidAccount).toHaveBeenCalledTimes(2);
  });
  it('refuses changed Bybit credentials rather than reusing a connected account cache', async () => {
    await gateway.portfolio(state); vi.stubEnv('BYBIT_API_KEY', 'different-fixture-key');
    await expect(gateway.portfolio(state)).rejects.toThrow(/credentials or network changed/);
  });
  it('blocks unknown nonzero perp exposure while preserving a strict account boundary', async () => {
    const account = hyperliquid(); account.allPositions.push({ coin: 'UNMAPPED', size: 1, entryPrice: 1, unrealizedPnl: 0, marginUsed: 1, leverage: 1, supported: false });
    vi.mocked(getHyperliquidAccount).mockResolvedValue(account);
    await expect(gateway.portfolio(state)).rejects.toThrow(/Unmapped perpetual exposure/);
  });
  it('blocks isolated margin positions that cannot use the shared allocator', async () => {
    const account = hyperliquid(); account.state.assetPositions[1].position.leverage.type = 'isolated';
    vi.mocked(getHyperliquidAccount).mockResolvedValue(account);
    await expect(gateway.portfolio(state)).rejects.toThrow(/Isolated perpetual margin/);
  });
  it('blocks untracked orders even when their asset is a supported underlying', async () => {
    const account = hyperliquid(); (account.openOrders as unknown[]) = [{ coin: 'BTC', cloid: 'unmanaged-order' }];
    vi.mocked(getHyperliquidAccount).mockResolvedValue(account);
    await expect(gateway.portfolio(state)).rejects.toThrow(/Unmanaged Hyperliquid open orders/);
  });
});

describe('multi-asset gateway market discovery', () => {
  function mockPublic() {
    vi.mocked(getHyperliquidMarket).mockImplementation(async (asset = 'SOL') => ({ coin: asset, oracle: 120, mark: 120, funding: 0, sizeStep: .01, szDecimals: 2, minNotional: 10, maxLeverage: 20, asset: 5, timestamp: Date.now() }));
    vi.mocked(getBybitMarket).mockResolvedValue({ instruments: [], rawInstruments: [], index: 120, timestamp: now, stablecoinBasisBps: 0, status: 'Fixture options' });
    vi.mocked(getMeteoraPools).mockResolvedValue([{ address: 'pool', underlying: 'SOL', price: 120, timestamp: now } as any]);
    vi.mocked(getMeteoraPool).mockResolvedValue({ address: 'selected-pool', underlying: 'SOL', price: 120, timestamp: now } as any);
  }
  it('caches empty-book pool discovery for five minutes without caching selected-pool prices', async () => {
    mockPublic(); await gateway.market(state.market, 'SOL'); vi.setSystemTime(now + 1000); await gateway.market(state.market, 'SOL');
    expect(getMeteoraPools).toHaveBeenCalledTimes(1);
    state.positions = [{ id: 'position', source: 'live', base: 'SOL', underlying: 'SOL', pool: 'selected-pool' } as any]; state.selectedIds = ['position'];
    await gateway.market(state.market, 'SOL'); await gateway.market(state.market, 'SOL'); expect(getMeteoraPool).toHaveBeenCalledTimes(2);
    state.positions = []; state.selectedIds = []; vi.setSystemTime(now + 300000); await gateway.market(state.market, 'SOL');
    expect(getMeteoraPools).toHaveBeenCalledTimes(2);
  });
  it('never uses another underlying selected pool when an explicit different market is requested', async () => {
    mockPublic(); state.positions = [{ id: 'position', source: 'live', base: 'SOL', underlying: 'SOL', pool: 'selected-pool' } as any]; state.selectedIds = ['position'];
    await gateway.market(state.market, 'BTC'); expect(getMeteoraPool).not.toHaveBeenCalled(); expect(getMeteoraPools).toHaveBeenCalledWith('BTC');
  });
  it('retains a Bybit XAUT reference for monitoring while marking the missing perp unavailable', async () => {
    mockPublic(); vi.mocked(getHyperliquidMarket).mockRejectedValue(new Error('XAUT perpetual unavailable'));
    vi.mocked(getBybitMarket).mockResolvedValue({ instruments: [], rawInstruments: [], index: 4000, timestamp: now, stablecoinBasisBps: 0, status: 'Fixture options' });
    const market = await gateway.market(state.market, 'XAUT');
    expect(market).toMatchObject({ referencePrice: 4000, timestamp: 0, perpSizeStep: 0 }); expect(market.status.support).toContain('XAUT perpetual unavailable');
  });
});
