import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signTypedData, SignTypedDataVersion } from '@metamask/eth-sig-util';
import { normalizeDeriveInstrument, prepareDeriveOrders, verifyDeriveOrderSignature, verifyDeriveBasketSignatures, executeDeriveOrder, type DeriveInstrumentRaw, type DeriveAuth } from '../src/venues/derive';
import { optionExecutionPreview } from '../src/shared/option-execution';
import type { FitResult, OptionExecutionSettings } from '../src/shared/types';

const now = Date.UTC(2026, 8, 27);
const signer = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const owner = '0x2222222222222222222222222222222222222222';
const auth: DeriveAuth = { wallet: owner, signer: signer.address, timestamp: String(now), signature: '0x1234' };
const raw: DeriveInstrumentRaw = {
  instrument_name: 'SOL-20260928-130-P', instrument_type: 'option', is_active: true, base_currency: 'SOL', quote_currency: 'USDC',
  tick_size: '0.1', minimum_amount: '1', maximum_amount: '100000', amount_step: '0.1', base_fee: '0.5',
  taker_fee_rate: '0.0003', maker_fee_rate: '0.0001', mark_price_fee_rate_cap: '0.125',
  base_asset_address: '0x420c9295484d834B03F45E1C9EaC5da8cD8b0710', base_asset_sub_id: '39614081312966743646562557568',
  option_details: { expiry: 1790582400, strike: '130', option_type: 'P', index: 'SOL-USD' },
};
// Expanded shape observed on v2 mainnet public/get_ticker; bulk get_tickers uses compact keys.
const expanded = (ask = '10', timestamp = now) => ({ instrument_name: raw.instrument_name, timestamp,
  best_ask_amount: '20', best_ask_price: ask, best_bid_amount: '10', best_bid_price: '9', index_price: '100', mark_price: '9.5',
  option_pricing: { delta: '-0.95', gamma: '0.01', vega: '0.1', theta: '-0.2', iv: '0.7' } });
const compact = { t: now, A: '20', a: '10', B: '10', b: '9', I: '100', M: '9.5',
  option_pricing: { d: '-0.95', g: '0.01', v: '0.1', t: '-0.2', i: '0.7' } };
const protectedBuy: OptionExecutionSettings = { mode: 'marketable-ioc', maxSlippagePercent: 5 };
function proposal(): FitResult {
  const instrument = normalizeDeriveInstrument(raw, compact);
  return { id: 'hedge-test', createdAt: now, expiresAt: now + 15000, source: 'live',
    legs: [{ instrument, quantity: 2, existingQuantity: 0, cost: 20, fee: .56 }], cost: 20, fees: .56, totalCost: 20.56,
    feasible: true, reasons: [], maxError: 0, weightedError: 0, maxUndercoverage: 0, lowerTailSlopeError: 0, upperTailSlopeError: 0,
    points: [], settings: { expiry: raw.option_details!.expiry * 1000, coverage: 1, budget: 100, maxLegs: 4, objective: 'payoff', maxUndercoverage: null },
    fingerprint: 'test', greeks: { delta: 0, gamma: 0, vega: 0, theta: 0 }, notes: [] };
}
function mockVenue(ticker = expanded(), priceCeiling?: string, scope = 'admin') {
  const fetch = vi.fn(async (url: string) => {
    const method = url.split('/').slice(-2).join('/');
    const results: Record<string, unknown> = {
      'private/get_subaccounts': { wallet: owner, subaccount_ids: [42] },
      'private/session_keys': { public_session_keys: [{ public_session_key: signer.address, scope, expiry_sec: Math.floor(now / 1000) + 3600 }] },
      'private/get_subaccount': { positions: [], collaterals: [] }, 'private/get_open_orders': { orders: [] },
      'public/get_instrument': raw, 'public/get_ticker': { ...ticker, best_ask_amount: '0', best_ask_price: '0' },
      'public/get_tickers': { tickers: { [raw.instrument_name]: { t: ticker.timestamp, A: ticker.best_ask_amount, a: ticker.best_ask_price,
        ...(priceCeiling ? { maxp: priceCeiling } : {}),
        B: ticker.best_bid_amount, b: ticker.best_bid_price, I: ticker.index_price, M: ticker.mark_price,
        option_pricing: { d: ticker.option_pricing.delta, g: ticker.option_pricing.gamma, v: ticker.option_pricing.vega, t: ticker.option_pricing.theta, i: ticker.option_pricing.iv } } } },
      'private/order': { order: { filled_amount: '2' } },
    };
    if (!(method in results)) throw new Error('Unexpected venue request');
    return new Response(JSON.stringify({ result: results[method] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch); return fetch;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('DERIVE_API_VERSION', 'v2'); vi.stubEnv('DERIVE_NETWORK', 'mainnet'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Derive single and bulk ticker compatibility', () => {
  it('normalizes the actual expanded get_ticker schema identically to the bulk chain schema', () => {
    expect(normalizeDeriveInstrument(raw, expanded())).toEqual(normalizeDeriveInstrument(raw, compact));
  });
  it('accepts zero mark as a valid quoted valuation, but does not invent liquidity', () => {
    const i = normalizeDeriveInstrument(raw, { ...expanded(), mark_price: '0', best_ask_amount: '0', best_ask_price: '0' });
    expect(i.mark).toBe(0); expect(i.ask).toBeNull(); expect(i.askSize).toBe(0);
  });
  it('names the affected instrument for malformed fields and rejects mismatched instruments', () => {
    expect(() => normalizeDeriveInstrument(raw, { ...expanded(), mark_price: 'NaN' })).toThrow(`Cannot parse ticker for ${raw.instrument_name}`);
    expect(() => normalizeDeriveInstrument(raw, { ...expanded(), instrument_name: 'WRONG' })).toThrow('Ticker instrument mismatch');
  });
});

describe('reviewed immediate-buy caps', () => {
  it('blocks an account-scoped signer before preparing signing payloads or inspecting execution markets', async () => {
    const fetch = mockVenue(expanded(), undefined, 'account');
    await expect(prepareDeriveOrders(proposal(), auth, 42, protectedBuy)).rejects.toThrow('private/order requires Admin');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toContain('/private/session_keys');
  });
  it('includes exact tick-rounded price and signed fee maxima in the budget', () => {
    const p = optionExecutionPreview(proposal(), protectedBuy);
    expect(p.legs[0]!.limitPrice).toBe(10.5);
    expect(p.legs[0]!.maxFeePerUnit).toBe('0.311201');
    expect(p.maxPremium).toBe(21); expect(p.maxFees).toBeCloseTo(.622402, 12);
    expect(p.maxTotalCost).toBeCloseTo(21.622402, 12); expect(p.expiresAt).toBe(now + 120000);
    const fit = proposal(); fit.settings.budget = 21.62;
    expect(optionExecutionPreview(fit, protectedBuy).withinBudget).toBe(false);
  });
  it('never rounds a small premium up past the selected percentage cap', () => {
    const fit = proposal(); fit.legs[0]!.instrument.ask = .2;
    expect(optionExecutionPreview(fit, protectedBuy).legs[0]!.limitPrice).toBe(.2);
    expect(optionExecutionPreview(fit, { ...protectedBuy, maxSlippagePercent: 50 }).legs[0]!.limitPrice).toBe(.3);
    expect(() => optionExecutionPreview(fit, { ...protectedBuy, maxSlippagePercent: 51 })).toThrow('between 0% and 50%');
  });
  it('prepares a fixed signed price cap after the estimate expires using the live chain even if single-ticker BBO is empty', async () => {
    vi.setSystemTime(now + 30000);
    const fetch = mockVenue(expanded('10.2', now + 30000));
    const [order] = await prepareDeriveOrders(proposal(), auth, 42, protectedBuy);
    expect(order!.params).toMatchObject({ limit_price: '10.5', amount: '2', order_type: 'limit', time_in_force: 'ioc' });
    const decoded = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'int256' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }], order!.typedData.message.data);
    expect(decoded[2]).toBe(10500000000000000000n); expect(decoded[3]).toBe(2000000000000000000n);
    expect(fetch.mock.calls.every(([url]) => !url.endsWith('/private/order'))).toBe(true);
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/public/get_tickers'))).toBe(true);
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/public/get_ticker'))).toBe(false);
  });
  it.each([
    { reason: 'above cap', ticker: expanded('10.6'), message: 'above your approved price cap' },
    { reason: 'insufficient depth', ticker: { ...expanded(), best_ask_amount: '1' }, message: 'sufficient best-ask liquidity' },
    { reason: 'stale', ticker: expanded('10', now - 16000), message: 'fresh' },
    { reason: 'future timestamp', ticker: expanded('10', now + 6000), message: 'fresh' },
    { reason: 'index / fee changed', ticker: { ...expanded(), index_price: '105' }, message: 'fee cap' },
  ])('refuses $reason without preparing or sending trades', async ({ ticker, message }) => {
    const fetch = mockVenue(ticker);
    await expect(prepareDeriveOrders(proposal(), auth, 42, protectedBuy)).rejects.toThrow(message);
    expect(fetch.mock.calls.every(([url]) => !url.endsWith('/private/order'))).toBe(true);
  });
  it('rejects expired reviews, insufficient budgets and strict-ask drift', async () => {
    const fetch = mockVenue(expanded('10.1'));
    await expect(prepareDeriveOrders(proposal(), auth, 42)).rejects.toThrow('above your approved price cap');
    const fit = proposal(); fit.settings.budget = 21;
    await expect(prepareDeriveOrders(fit, auth, 42, protectedBuy)).rejects.toThrow('premium budget');
    vi.setSystemTime(now + 120000);
    await expect(prepareDeriveOrders(proposal(), auth, 42, protectedBuy)).rejects.toThrow('current feasible live hedge review');
    expect(fetch.mock.calls.every(([url]) => !url.endsWith('/private/order'))).toBe(true);
  });
  it('lowers the signed cap to a tighter current venue price ceiling without increasing reviewed spending', async () => {
    mockVenue(expanded('10.2'), '10.3');
    const [order] = await prepareDeriveOrders(proposal(), auth, 42, protectedBuy);
    expect(order!.params.limit_price).toBe('10.3');
    expect(optionExecutionPreview(proposal(), protectedBuy).legs[0]!.limitPrice).toBe(10.5);
  });
  it('rechecks after wallet signing and does not chase an ask beyond the signed cap', async () => {
    mockVenue();
    const [order] = await prepareDeriveOrders(proposal(), auth, 42, protectedBuy);
    const signature = signTypedData({ privateKey: Buffer.from('11'.repeat(32), 'hex'),
      data: JSON.parse(JSON.stringify(order!.typedData)), version: SignTypedDataVersion.V4 }) as `0x${string}`;
    const fetch = mockVenue(expanded('10.7'));
    await expect(executeDeriveOrder(order!, signature, auth)).rejects.toThrow('above your approved price cap');
    expect(fetch.mock.calls.every(([url]) => !url.endsWith('/private/order'))).toBe(true);
    const fillFetch = mockVenue(expanded('10.3'));
    await expect(executeDeriveOrder(order!, signature, auth)).resolves.toMatchObject({ order: { filled_amount: '2' } });
    expect(fillFetch.mock.calls.filter(([url]) => url.endsWith('/private/order'))).toHaveLength(1);
  });
  it('rejects an old incomplete domain and a changed session before any venue request', async () => {
    mockVenue();
    const [order] = await prepareDeriveOrders(proposal(), auth, 42, protectedBuy);
    const signature = signTypedData({ privateKey: Buffer.from('11'.repeat(32), 'hex'),
      data: JSON.parse(JSON.stringify(order!.typedData)), version: SignTypedDataVersion.V4 }) as `0x${string}`;
    const fetch = mockVenue();
    await expect(verifyDeriveOrderSignature(order!, signature, { ...auth, signer: owner })).rejects.toThrow('account or signer changed');
    const incomplete = structuredClone(order!);
    delete (incomplete.typedData.types as { EIP712Domain?: unknown }).EIP712Domain;
    await expect(executeDeriveOrder(incomplete, signature, auth)).rejects.toThrow('incomplete signing domain');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects an invalid second signature before submitting the valid first leg', async () => {
    mockVenue();
    const [first] = await prepareDeriveOrders(proposal(), auth, 42, protectedBuy);
    const second = structuredClone(first!); second.typedData.message.nonce = String(BigInt(second.typedData.message.nonce) + 1n);
    const signJson = (order: typeof second, key = '11'.repeat(32)) => signTypedData({ privateKey: Buffer.from(key, 'hex'),
      data: JSON.parse(JSON.stringify(order.typedData)), version: SignTypedDataVersion.V4 }) as `0x${string}`;
    const fetch = mockVenue(), signatures = [signJson(first!), signJson(second, '22'.repeat(32))];
    await expect((async () => {
      await verifyDeriveBasketSignatures([first!, second], signatures, auth);
      await executeDeriveOrder(first!, signatures[0]!, auth);
    })()).rejects.toThrow('does not verify for the connected signer');
    expect(fetch).not.toHaveBeenCalled();
    await expect(verifyDeriveBasketSignatures([first!], [], auth)).rejects.toThrow('signatures are incomplete');
    await expect(verifyDeriveBasketSignatures([first!, second], [signJson(first!), signJson(second)], auth)).resolves.toBeUndefined();
  });
});
