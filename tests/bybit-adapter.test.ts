import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bybitAuthFingerprint, bybitRequest, bybitTakerFee, executeBybitOrder, getBybitAccount, getBybitMarket, normalizeBybitInstrument,
  prepareBybitOrders, reconcileBybitOrder, signBybitRequest, type BybitInstrumentRaw, type BybitTickerRaw, type PreparedBybitOrder } from '../src/venues/bybit.js';
import type { FitResult } from '../src/shared/types.js';

const now = 1790536902077, auth = { apiKey: 'test-key', apiSecret: 'test-secret' };
const raw: BybitInstrumentRaw = { symbol: 'SOL-30OCT26-145-P-USDT', status: 'Trading', baseCoin: 'SOL', quoteCoin: 'USDT', settleCoin: 'USDT',
  optionsType: 'Put', deliveryTime: '1793347200000', deliveryFeeRate: '.0002', priceFilter: { minPrice: '.01', maxPrice: '3000', tickSize: '.01' },
  lotSizeFilter: { minOrderQty: '1', maxOrderQty: '100000', qtyStep: '1' } };
const ticker: BybitTickerRaw = { symbol: raw.symbol, bid1Price: '1.8', bid1Size: '20', ask1Price: '2', ask1Size: '10', markPrice: '1.9', indexPrice: '123', markIv: '.6',
  delta: '-.4', gamma: '.04', vega: '.05', theta: '-.2' };
const position = { symbol: raw.symbol, size: '2', side: 'Buy', avgPrice: '1.5' };
function prepared(): PreparedBybitOrder {
  return { instrument: raw.symbol, quantity: 2, limitPrice: 2.1, maxFee: 1, estimatedFee: .0738, accountId: '1234', authFingerprint: bybitAuthFingerprint(auth),
    network: 'mainnet', createdAt: now, expiresAt: now + 120000, orderLinkId: 'df-persisted-id',
    params: { category: 'option', symbol: raw.symbol, side: 'Buy', orderType: 'Limit', qty: '2', price: '2.1', timeInForce: 'IOC', orderLinkId: 'df-persisted-id' } };
}
function fit(): FitResult {
  return { id: 'reviewed', source: 'live', feasible: true, createdAt: now, expiresAt: now + 15000, fingerprint: 'fixture',
    legs: [{ instrument: normalizeBybitInstrument(raw, ticker, now), quantity: 2, existingQuantity: 0, cost: 4, fee: .0738 }],
    cost: 4, fees: .0738, totalCost: 4.0738, reasons: [], points: [], maxError: 0, weightedError: 0, maxUndercoverage: 0,
    lowerTailSlopeError: 0, upperTailSlopeError: 0, settings: { expiry: Number(raw.deliveryTime), coverage: 1, budget: 50, maxLegs: 4, objective: 'payoff', maxUndercoverage: null },
    greeks: { delta: -.8, gamma: .08, vega: .1, theta: -.4 }, notes: [] };
}
type MockOptions = { positions?: any[]; coins?: any[]; derivative?: boolean; derivativeOrder?: boolean; spotOrder?: boolean; readOnly?: boolean;
  withdrawal?: boolean; metadata?: any; quotes?: any[]; basis?: number; depth?: string; fee?: string; realtime?: any[]; history?: any[];
  unknownSubmit?: boolean; createCode?: number; stale?: boolean; balance?: string; expireDuringPreflight?: boolean; slowAccount?: boolean; unsafeAck?: boolean;
  accountInfoWithoutTime?: boolean; markets?: Record<string, { raw: BybitInstrumentRaw; ticker: BybitTickerRaw }> };
function mock(options: MockOptions = {}) {
  const calls: { route: string; params: URLSearchParams; method: string; body: any; headers: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const u = new URL(input), q = u.searchParams, body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ route: u.pathname, params: q, method: init.method!, body, headers: init.headers });
    let result: any;
    if (u.pathname === '/v5/user/query-api') result = { readOnly: options.readOnly ? 1 : 0, userID: 1234,
      permissions: { Options: ['OptionsTrade'], Wallet: options.withdrawal ? ['Withdraw'] : [] } };
    else if (u.pathname === '/v5/account/info') {
      if (options.expireDuringPreflight) vi.setSystemTime(now + 120001);
      if (options.slowAccount) vi.setSystemTime(now + 16000);
      result = { unifiedMarginStatus: 6, marginMode: 'REGULAR_MARGIN', updatedTime: '1697078946000' };
    }
    else if (u.pathname === '/v5/account/wallet-balance') result = { list: [{ accountType: 'UNIFIED', totalPerpUPL: '0', totalAvailableBalance: options.balance ?? '50',
      coin: options.coins ?? [{ coin: 'USDT', walletBalance: '50', equity: '53.8', borrowAmount: '0', spotBorrow: '0', accruedInterest: '0' }] }] };
    else if (u.pathname === '/v5/account/fee-rate') result = { category: 'option', list: [{ baseCoin: 'SOL', takerFeeRate: options.fee ?? '.0003' }] };
    else if (u.pathname === '/v5/position/list') result = { category: q.get('category'), list: q.get('category') === 'option' ? options.positions ?? []
      : q.get('category') === 'linear' && q.get('settleCoin') === 'USDT' && options.derivative ? [{ size: '1' }] : [], nextPageCursor: '' };
    else if (u.pathname === '/v5/market/instruments-info') result = { category: q.get('category'), nextPageCursor: '', list: q.get('category') === 'linear'
      ? [{ settleCoin: 'USDT' }, { settleCoin: 'USDC' }, { settleCoin: 'USD1' }] : [options.markets?.[q.get('symbol') ?? '']?.raw ?? options.metadata ?? raw] };
    else if (u.pathname === '/v5/market/tickers') result = { category: q.get('category'), list: q.get('category') === 'spot'
      ? [{ symbol: 'USDCUSDT', bid1Price: String(options.basis ?? 1.0001), ask1Price: String(options.basis ?? 1.0002) }] : options.quotes ?? [options.markets?.[q.get('symbol') ?? '']?.ticker ?? ticker] };
    else if (u.pathname === '/v5/market/orderbook') result = { s: raw.symbol, ts: now, a: [['2', options.depth ?? '10']] };
    else if (u.pathname === '/v5/order/realtime') result = { category: q.get('category'), nextPageCursor: '', list: q.has('orderLinkId') ? options.realtime ?? []
      : q.get('category') === 'linear' && q.get('settleCoin') === 'USD1' && options.derivativeOrder ? [{ symbol: 'NEWUSD1' }]
        : q.get('category') === 'spot' && options.spotOrder ? [{ symbol: 'SOLUSDT' }] : [] };
    else if (u.pathname === '/v5/order/history') result = { category: 'option', list: options.history ?? [], nextPageCursor: '' };
    else if (u.pathname === '/v5/order/create') {
      if (options.unknownSubmit) throw new Error('private request test-secret must never appear');
      if (options.createCode) return Response.json({ retCode: options.createCode, retMsg: 'echo test-secret', time: now });
      result = { orderId: options.unsafeAck ? 'arbitrary private text test-secret' : 'venue-123', orderLinkId: body.orderLinkId };
    } else throw new Error('Unexpected test route ' + u.pathname);
    return Response.json({ retCode: 0, result,
      ...(options.accountInfoWithoutTime && u.pathname === '/v5/account/info' ? {} : { time: options.stale ? now - 20000 : Date.now() }) });
  }));
  return calls;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('BYBIT_NETWORK', 'mainnet'); vi.stubEnv('BYBIT_MAX_STABLECOIN_BASIS_BPS', '50'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Bybit wire contract and normalization', () => {
  it('matches independent Python HMAC SHA256 GET and POST vectors', () => {
    expect(signBybitRequest(auth, '1700000000000', 'category=option&baseCoin=SOL')).toBe('4407f7dcf8a5f931678eb80a8595e3778bae4fb1f2b4b59f147bbab27ded1166');
    expect(signBybitRequest(auth, '1700000000000', '{"category":"option","symbol":"SOL-30OCT26-145-P-USDT","side":"Buy","qty":"1"}'))
      .toBe('05b5dd7cf323ce20216751dbff56e15b5369bac33569d6a3ae5244b62ab85e07');
  });
  it('retains USDT native prices, SOL quantity, and published Greek units', () => {
    const i = normalizeBybitInstrument(raw, ticker, now);
    expect(i).toMatchObject({ venue: 'bybit', quoteCoin: 'USDT', settleCoin: 'USDT', multiplier: 1, strike: 145, minSize: 1, sizeStep: 1, tickSize: .01,
      ask: 2, askSize: 10, greeks: { delta: -.4, gamma: .04, vega: .05, theta: -.2 } });
    expect(normalizeBybitInstrument(raw, { ...ticker, gamma: '' }, now).greeks).toBeNull();
  });
  it('rejects unsupported settlement and inconsistent symbol metadata', () => {
    expect(() => normalizeBybitInstrument({ ...raw, settleCoin: 'USDC' }, ticker)).toThrow(/settlement/);
    expect(() => normalizeBybitInstrument({ ...raw, optionsType: 'Call' }, ticker)).toThrow(/mapping/);
    expect(() => normalizeBybitInstrument({ ...raw, deliveryTime: String(Number(raw.deliveryTime) + 86400000) }, ticker)).toThrow(/date disagrees/);
  });
  it('does not invent depth from a mark or a zero-size ask', () => {
    expect(normalizeBybitInstrument(raw, { ...ticker, ask1Size: '0' }, now)).toMatchObject({ ask: null, askSize: 0, asks: [] });
  });
  it('uses underlying fee with the seven-percent premium cap', () => {
    expect(bybitTakerFee(2, 4, 100)).toBeCloseTo(.06, 12);
    expect(bybitTakerFee(2, .01, 100)).toBeCloseTo(.0014, 12);
  });
  it('discovers native SOL options and reports USDC/USDT BBO basis', async () => {
    mock(); const m = await getBybitMarket();
    expect(m.instruments).toHaveLength(1); expect(m.index).toBe(123); expect(m.stablecoinBasisBps).toBeCloseTo(1.5, 10);
  });
  it('rejects stale response timestamps instead of stamping old quotes as current', async () => {
    mock({ stale: true }); await expect(getBybitMarket()).rejects.toThrow(/stale/);
  });
  it('accepts the documented authenticated account-info envelope without time and labels its local provenance', async () => {
    mock({ accountInfoWithoutTime: true });
    const response = await bybitRequest<{ updatedTime: string }>('GET', '/v5/account/info', {}, auth);
    expect(response).toMatchObject({ time: now, timestampSource: 'local-request-start', result: { updatedTime: '1697078946000' } });
    expect(await getBybitAccount(auth)).toMatchObject({ timestamp: now, accountInfoTimestampSource: 'local-request-start' });
  });
  it('retains supplied venue timestamps and their provenance for account-info', async () => {
    mock();
    expect(await bybitRequest('GET', '/v5/account/info', {}, auth)).toMatchObject({ time: now, timestampSource: 'venue' });
    expect(await getBybitAccount(auth)).toMatchObject({ timestamp: now, accountInfoTimestampSource: 'venue' });
  });
  it('uses request-start time for timestamp-free configuration reads so slow responses still fail freshness', async () => {
    mock({ accountInfoWithoutTime: true, slowAccount: true });
    const response = await bybitRequest('GET', '/v5/account/info', {}, auth);
    expect(response).toMatchObject({ time: now, timestampSource: 'local-request-start' });
    expect(Date.now()).toBe(now + 16000);
    vi.setSystemTime(now);
    await expect(getBybitAccount(auth)).rejects.toThrow(/stale/);
  });
  it.each([null, String(now), -1, now + .5])('rejects a malformed present account-info timestamp instead of replacing it: %s', async time => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ retCode: 0, result: {}, time })));
    await expect(bybitRequest('GET', '/v5/account/info', {}, auth)).rejects.toMatchObject({ ambiguous: false });
  });
  it.each([
    ['GET', '/v5/market/tickers', false],
    ['GET', '/v5/account/wallet-balance', false],
    ['GET', '/v5/user/query-api', false],
    ['POST', '/v5/order/create', true],
  ] as const)('keeps missing timestamps invalid for %s %s and preserves mutation ambiguity', async (method, route, ambiguous) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ retCode: 0, result: {} })));
    await expect(bybitRequest(method, route, {}, auth)).rejects.toMatchObject({ ambiguous });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not enable the timestamp exception for unauthenticated account-info requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ retCode: 0, result: {} })));
    await expect(bybitRequest('GET', '/v5/account/info')).rejects.toMatchObject({ ambiguous: false });
  });
  it.each([null, [], 'invalid', 1, true])('rejects invalid business-result schemas even when envelope time is valid: %j', async result => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ retCode: 0, result, time: now })));
    await expect(bybitRequest('GET', '/v5/account/info', {}, auth)).rejects.toMatchObject({ ambiguous: false });
  });
});
describe('Bybit dedicated account boundary', () => {
  it('counts wallet cash without double counting options equity and includes short-position delta', async () => {
    const calls = mock({ positions: [{ ...position, side: 'Sell' }] }); const a = await getBybitAccount(auth);
    expect(a.optionCash).toBe(50); expect(a.holdings[0].quantity).toBe(-2); expect(a.permissions.canTrade).toBe(true);
    expect(calls.some(c => c.route === '/v5/position/list' && c.params.get('settleCoin') === 'USD1')).toBe(true);
    expect(calls.some(c => c.route === '/v5/position/list' && c.params.get('category') === 'inverse')).toBe(true);
    expect(calls.find(c => c.route === '/v5/account/wallet-balance')?.params.has('coin')).toBe(false);
  });
  it('allows read-only discovery and reports no trading permission', async () => {
    mock({ readOnly: true }); expect((await getBybitAccount(auth)).permissions).toMatchObject({ readOnly: true, canTrade: false });
  });
  it.each([{ derivative: true }, { derivativeOrder: true }, { spotOrder: true }])('rejects unmapped derivatives or pending spot exposure %o', async opts => {
    mock(opts); await expect(getBybitAccount(auth)).rejects.toThrow(/dedicated supported-options/);
  });
  it.each(['spotBorrow', 'borrowAmount', 'accruedInterest'])('rejects %s even when gross wallet balance looks funded', async liability => {
    mock({ coins: [{ coin: 'USDT', walletBalance: '50', equity: '40', [liability]: '10' }] }); await expect(getBybitAccount(auth)).rejects.toThrow(/debt/);
  });
  it('reconciles SOL and BTC options into one account snapshot with stable cash counted once', async () => {
    const btcRaw = { ...raw, symbol: 'BTC-30OCT26-80000-P-USDT', baseCoin: 'BTC' };
    const btcTicker = { ...ticker, symbol: btcRaw.symbol, indexPrice: '80000' };
    mock({ positions: [position, { ...position, symbol: btcRaw.symbol, size: '.02' }], markets: { [btcRaw.symbol]: { raw: btcRaw, ticker: btcTicker } } });
    const account = await getBybitAccount(auth);
    expect(account.holdings.map(h => [h.instrument.underlying, h.quantity])).toEqual([['SOL', 2], ['BTC', .02]]);
    expect(account.optionCash).toBe(50);
    expect(account.availableBalance).toBe(50);
  });
  it('rejects volatile collateral and withdrawal-enabled API keys', async () => {
    mock({ coins: [{ coin: 'SOL', walletBalance: '1', equity: '1' }] }); await expect(getBybitAccount(auth)).rejects.toThrow(/outside the supported options strategies/);
    mock({ withdrawal: true }); await expect(getBybitAccount(auth)).rejects.toThrow(/withdrawals/);
  });
  it('connects for discovery with extra MNT, reports its balance and keeps it outside strategy cash', async () => {
    mock({ coins: [{ coin: 'USDT', walletBalance: '50', equity: '50' }, { coin: 'MNT', walletBalance: '3', equity: '3', usdValue: '2.4' }], positions: [position] });
    const account = await getBybitAccount(auth, { mode: 'discovery' });
    expect(account).toMatchObject({ optionCash: 50, usdtCash: 50, excludedAssets: [{ coin: 'MNT', quantity: 3, usdValue: 2.4 }] });
    expect(account.holdings[0].quantity).toBe(2);
    expect(account.permissions.canTrade).toBe(true);
    expect(account.riskBlockers).toHaveLength(1); expect(account.riskBlockers![0]).toContain('MNT');
    await expect(getBybitAccount(auth)).rejects.toThrow(/MNT/);
  });
  it('allows zero extra-coin rows and returns no strategy blocker for stablecoin-only accounts', async () => {
    mock({ coins: [{ coin: 'USDT', walletBalance: '50', equity: '50' }, { coin: 'MNT', walletBalance: '0', equity: '0' }] });
    expect(await getBybitAccount(auth, { mode: 'discovery' })).toMatchObject({ optionCash: 50, excludedAssets: [], riskBlockers: [] });
  });
  it('keeps debt and withdrawal checks during discovery', async () => {
    mock({ coins: [{ coin: 'MNT', walletBalance: '3', equity: '3', borrowAmount: '1' }] });
    await expect(getBybitAccount(auth, { mode: 'discovery' })).rejects.toThrow(/debt/);
    mock({ withdrawal: true }); await expect(getBybitAccount(auth, { mode: 'discovery' })).rejects.toThrow(/withdrawals/);
  });
  it('refuses preparation and submission with extra assets even after successful discovery', async () => {
    const calls = mock({ coins: [{ coin: 'USDT', walletBalance: '50', equity: '50' }, { coin: 'MNT', walletBalance: '3', equity: '3' }] });
    await getBybitAccount(auth, { mode: 'discovery' });
    await expect(prepareBybitOrders(fit(), auth)).rejects.toThrow(/MNT/);
    await expect(executeBybitOrder(prepared(), auth)).rejects.toMatchObject({ ambiguous: false });
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });
});
describe('Bybit bounded order lifecycle', () => {
  it('prepares unique <=36-character persistent IDs and never places an order during preview', async () => {
    const calls = mock(); const orders = await prepareBybitOrders(fit(), auth, { mode: 'marketable-ioc', maxSlippagePercent: 5 });
    expect(orders).toHaveLength(1); expect(orders[0].params).toMatchObject({ side: 'Buy', orderType: 'Limit', timeInForce: 'IOC', qty: '2', price: '2.1' });
    expect(orders[0].orderLinkId).toMatch(/^[\w-]{1,36}$/); expect(calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('blocks insufficient available margin, read-only keys, and fractional non-executable lots', async () => {
    mock({ balance: '1' }); await expect(prepareBybitOrders(fit(), auth)).rejects.toThrow(/Insufficient/);
    mock({ readOnly: true }); await expect(prepareBybitOrders(fit(), auth)).rejects.toThrow(/OptionsTrade/);
    mock(); const fractional = fit(); fractional.legs[0].quantity = 1.5; await expect(prepareBybitOrders(fractional, auth)).rejects.toThrow(/lot/);
  });
  it('enforces live stablecoin basis before both preparation and submission', async () => {
    const calls = mock({ basis: 1.02 }); await expect(prepareBybitOrders(fit(), auth)).rejects.toThrow(/basis exceeds/);
    await expect(executeBybitOrder(prepared(), auth)).rejects.toMatchObject({ ambiguous: false });
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('rechecks current depth and account fee reserve before submitting', async () => {
    const calls = mock({ depth: '1' }); await expect(executeBybitOrder(prepared(), auth)).rejects.toThrow(/depth/);
    expect(calls.every(c => c.method === 'GET')).toBe(true);
    mock({ fee: '.1' }); await expect(executeBybitOrder({ ...prepared(), maxFee: .01 }, auth)).rejects.toThrow(/fee exceeds/);
  });
  it('rechecks cash withdrawn and permissions revoked after preparation before sending any leg', async () => {
    mock(); const [order] = await prepareBybitOrders(fit(), auth);
    const cashCalls = mock({ coins: [{ coin: 'USDT', walletBalance: '1', equity: '1' }] });
    await expect(executeBybitOrder(order, auth)).rejects.toThrow(/prefunded USDT cash/);
    expect(cashCalls.every(c => c.method === 'GET')).toBe(true);
    const permissionCalls = mock({ readOnly: true }); await expect(executeBybitOrder(order, auth)).rejects.toThrow(/permission changed/);
    expect(permissionCalls.every(c => c.method === 'GET')).toBe(true);
  });
  it('rechecks the review expiry after asynchronous account preflight', async () => {
    const calls = mock({ expireDuringPreflight: true }); await expect(executeBybitOrder(prepared(), auth)).rejects.toThrow(/expired/);
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('blocks market/basis data that aged during a slow account check', async () => {
    const calls = mock({ slowAccount: true }); await expect(executeBybitOrder(prepared(), auth)).rejects.toThrow(/stale/);
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('refuses cached quotes from a different environment and unexpected orderIv overrides', async () => {
    mock(); const f = fit(); f.legs[0].instrument.network = 'testnet'; await expect(prepareBybitOrders(f, auth)).rejects.toThrow(/this network/);
    const p = prepared(); (p.params as any).orderIv = '.9'; await expect(executeBybitOrder(p, auth)).rejects.toThrow(/reviewed bounded purchase/);
  });
  it('treats a successful create response as acknowledgment, not a fill', async () => {
    const calls = mock(); expect(await executeBybitOrder(prepared(), auth)).toMatchObject({ status: 'acknowledged', orderId: 'venue-123' });
    const posts = calls.filter(c => c.method === 'POST'); expect(posts).toHaveLength(1); expect(posts[0].body.timeInForce).toBe('IOC');
    expect(posts[0].body.orderLinkId).toBe('df-persisted-id');
  });
  it('treats an untrusted acknowledgment identifier as ambiguous without retaining its text', async () => {
    mock({ unsafeAck: true }); await expect(executeBybitOrder(prepared(), auth)).rejects.toMatchObject({ ambiguous: true, message: expect.not.stringContaining('test-secret') });
  });
  it('performs one mutation after timeout, preserves unknown state, and never leaks raw credentials', async () => {
    const calls = mock({ unknownSubmit: true }); await expect(executeBybitOrder(prepared(), auth)).rejects.toMatchObject({ ambiguous: true });
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
    expect(await reconcileBybitOrder(auth, prepared())).toMatchObject({ resolved: false, terminal: false, status: 'unknown' });
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
  });
  it('redacts venue messages and flags duplicate client IDs for reconciliation', async () => {
    mock({ createCode: 110072 }); await expect(bybitRequest('POST', '/v5/order/create', {}, auth)).rejects.toMatchObject({ code: 110072, ambiguous: true });
    try { await bybitRequest('POST', '/v5/order/create', {}, auth); } catch (e) { expect(String(e)).not.toContain('test-secret'); }
  });
  it('reconciles a partial IOC cancellation from history when realtime is empty', async () => {
    mock({ history: [{ orderId: 'venue-123', orderLinkId: 'df-persisted-id', symbol: raw.symbol, side: 'Buy', qty: '2', cumExecQty: '1', avgPrice: '2.01',
      orderStatus: 'Cancelled', cumExecFee: '.0369' }] });
    expect(await reconcileBybitOrder(auth, prepared())).toMatchObject({ resolved: true, terminal: true, filled: 1, price: 2.01, fee: .0369 });
  });
  it('retains open partial state and rejects mismatched account/environment or fill records', async () => {
    mock({ realtime: [{ orderId: 'venue-123', orderLinkId: 'df-persisted-id', symbol: raw.symbol, side: 'Buy', qty: '2', cumExecQty: '1', avgPrice: '2', orderStatus: 'PartiallyFilled' }] });
    expect(await reconcileBybitOrder(auth, prepared())).toMatchObject({ resolved: true, terminal: false, filled: 1 });
    await expect(reconcileBybitOrder({ ...auth, apiKey: 'different' }, prepared())).rejects.toThrow(/key or environment/);
    mock({ history: [{ orderLinkId: 'different', symbol: raw.symbol, side: 'Buy', qty: '2' }] });
    await expect(reconcileBybitOrder(auth, prepared())).rejects.toThrow(/persisted account intent/);
  });
  it('does not leak arbitrary exchange quantity or status strings into diagnostics', async () => {
    const order = { orderId: 'venue-123', orderLinkId: 'df-persisted-id', symbol: raw.symbol, side: 'Buy', qty: 'test-secret' };
    mock({ realtime: [order] }); await expect(reconcileBybitOrder(auth, prepared())).rejects.toThrow('Invalid order quantity');
    mock({ realtime: [{ ...order, qty: '2', cumExecQty: '0', orderStatus: 'test-secret' }] });
    await expect(reconcileBybitOrder(auth, prepared())).rejects.toThrow('Unrecognized order status');
  });
});
