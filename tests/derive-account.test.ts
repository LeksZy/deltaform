import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeriveApiError, deriveRpc, getDeriveAccount, type DeriveAuth } from '../src/venues/derive';
import { VenueError } from '../src/venues/http';

const owner = '0x1234567890abcdef1234567890abcdef12345678';
const auth: DeriveAuth = { wallet: owner, signer: '0x2222222222222222222222222222222222222222', timestamp: '1790465000000', signature: '0x1234' };
const emptyPortfolio = { positions: [], collaterals: [{ currency: 'USDC', amount: '500' }] };
function stubResults(overrides: Record<string, unknown> = {}) {
  const results: Record<string, unknown> = {
    'private/get_subaccounts': { wallet: owner, subaccount_ids: [42, 7] },
    'private/get_subaccount': emptyPortfolio,
    'private/get_open_orders': { orders: [] },
    ...overrides,
  };
  const fetch = vi.fn(async (input: string, _init: RequestInit) => {
    const method = new URL(input).pathname.split('/').slice(-2).join('/');
    if (!(method in results)) throw new Error(`Unexpected request: ${method}`);
    return new Response(JSON.stringify({ result: results[method] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch); return fetch;
}
function stubError(code: number, message = 'Account not found') {
  const fetch = vi.fn(async (_input: string, _init: RequestInit) => new Response(JSON.stringify({ error: { code, message } }), { status: 200 }));
  vi.stubGlobal('fetch', fetch); return fetch;
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Derive account-not-found guidance', () => {
  it.each([
    { version: 'v2', network: 'mainnet', base: 'https://api.lyra.finance', prefix: 'X-Lyra', advice: 'smart-contract wallet' },
    { version: 'v2', network: 'testnet', base: 'https://api-demo.lyra.finance', prefix: 'X-Lyra', advice: 'smart-contract wallet' },
    { version: 'v3', network: 'mainnet', base: 'https://api.derive.xyz/v3', prefix: 'X-Derive', advice: 'registered owner address' },
    { version: 'v3', network: 'testnet', base: 'https://testnet.api.derive.xyz/v3', prefix: 'X-Derive', advice: 'registered owner address' },
  ])('reports an actionable $version $network error without inventing an empty account', async ({ version, network, base, prefix, advice }) => {
    vi.stubEnv('DERIVE_API_VERSION', version); vi.stubEnv('DERIVE_NETWORK', network);
    const fetch = stubError(14000);
    const error = await getDeriveAccount(auth).catch(error => error);
    expect(error).toBeInstanceOf(VenueError);
    expect(error.message).toContain(`No ${version} ${network} account was found for ${owner}`);
    expect(error.message).toContain(advice);
    expect(error.message).toContain('leave the subaccount ID blank');
    expect(error.message).toContain('Local wallet verification does not create a Derive account');
    expect(error.message).toContain('14000 Account not found');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(`${base}/private/get_subaccounts`);
    const request = fetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ wallet: owner });
    expect(request.headers).toMatchObject({ [`${prefix}Wallet`]: owner, [`${prefix}Timestamp`]: auth.timestamp, [`${prefix}Signature`]: auth.signature });
    expect(request.headers).not.toHaveProperty(`${prefix === 'X-Lyra' ? 'X-Derive' : 'X-Lyra'}Wallet`);
  });
  it('preserves the exact API method and error code for diagnostics', async () => {
    stubError(14000);
    await expect(deriveRpc('private/get_subaccounts', { wallet: owner }, auth)).rejects.toMatchObject({
      method: 'private/get_subaccounts', code: 14000, ambiguous: false,
    });
    await expect(deriveRpc('private/get_subaccounts', { wallet: owner }, auth)).rejects.toBeInstanceOf(DeriveApiError);
  });
  it('does not reinterpret authentication failures as a missing or empty account', async () => {
    const fetch = stubError(10001, 'Invalid authentication signature');
    const error = await getDeriveAccount(auth).catch(error => error);
    expect(error).toBeInstanceOf(DeriveApiError);
    expect(error).toMatchObject({ method: 'private/get_subaccounts', code: 10001 });
    expect(error.message).toContain('Invalid authentication signature');
    expect(error.message).not.toContain('No v2'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('identifies the failed method and separated signer without guessing the reason for an HTML 403', async () => {
    vi.stubEnv('DERIVE_API_VERSION', 'v2');
    const fetch = vi.fn().mockResolvedValue(new Response('<h1>403 Forbidden</h1>', { status: 403, headers: { 'Content-Type': 'text/html' } }));
    vi.stubGlobal('fetch', fetch);
    const error = await getDeriveAccount(auth).catch(error => error);
    expect(error).toMatchObject({ status: 403, ambiguous: false });
    expect(error.message).toContain('private/get_subaccounts (v2 mainnet)');
    expect(error.message).toContain('authorized API/session signer');
    expect(error.message).toContain('cannot distinguish authentication failure');
    expect(error.message).not.toContain('<h1>');
    expect(error.message).not.toContain(auth.signature);
    expect(error.message).not.toContain('No v2 mainnet account');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves a non-2xx structured RPC code for account-not-found handling', async () => {
    vi.stubEnv('DERIVE_API_VERSION', 'v2');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 14000, message: 'Account not found' } }), { status: 403, headers: { 'Content-Type': 'application/json' } })));
    const error = await getDeriveAccount(auth).catch(error => error);
    expect(error.message).toContain('14000 Account not found');
    expect(error.message).toContain('No v2 mainnet account');
  });
  it('preserves order ambiguity when a structured server failure is converted to an RPC error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 10000, message: 'Internal server error' } }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    const error = await deriveRpc('private/order', {}, auth).catch(error => error);
    expect(error).toBeInstanceOf(DeriveApiError);
    expect(error).toMatchObject({ method: 'private/order', code: 10000, status: 503, ambiguous: true });
  });
});

describe('Derive subaccount selection', () => {
  it('discovers the first actual owned subaccount when the selector is omitted, without injecting zero', async () => {
    const fetch = stubResults();
    const result = await getDeriveAccount(auth);
    expect(result.subaccountIds).toEqual([42, 7]); expect(result.subaccountId).toBe(42);
    expect(result.holdings).toEqual([]); expect(result.collaterals).toEqual([{ currency: 'USDC', amount: '500' }]);
    expect(fetch).toHaveBeenCalledTimes(3);
    const requests = fetch.mock.calls.map(([url, init]) => ({ method: url.split('/').slice(-2).join('/'), params: JSON.parse(String(init.body)) }));
    expect(requests).toEqual([
      { method: 'private/get_subaccounts', params: { wallet: owner } },
      { method: 'private/get_subaccount', params: { subaccount_id: 42 } },
      { method: 'private/get_open_orders', params: { subaccount_id: 42 } },
    ]);
  });
  it('selects an explicitly supplied owned subaccount and accepts a genuine listed zero ID', async () => {
    const fetch = stubResults({ 'private/get_subaccounts': { subaccount_ids: [42, 0] } });
    const result = await getDeriveAccount(auth, 0);
    expect(result.subaccountId).toBe(0);
    expect(fetch.mock.calls.slice(1).map(([, init]) => JSON.parse(String(init.body)))).toEqual([{ subaccount_id: 0 }, { subaccount_id: 0 }]);
  });
  it('returns an empty account only after the venue successfully reports an actual empty ID list', async () => {
    const fetch = stubResults({ 'private/get_subaccounts': { wallet: owner, subaccount_ids: [] } });
    const result = await getDeriveAccount(auth);
    expect(result).toMatchObject({ subaccountIds: [], subaccountId: null, holdings: [], openOrders: [], portfolio: null });
    expect(Number.isFinite(result.timestamp)).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { selector: -1 }, { selector: 1.5 }, { selector: Number.NaN }, { selector: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid supplied ID $selector before fetching private inventory', async ({ selector }) => {
    const fetch = stubResults();
    await expect(getDeriveAccount(auth, selector)).rejects.toThrow('Subaccount ID must be a nonnegative integer');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects an unowned supplied ID rather than falling back to the first account', async () => {
    const fetch = stubResults();
    await expect(getDeriveAccount(auth, 0)).rejects.toThrow('does not belong to connected wallet');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Derive discovery schema validation', () => {
  it.each([
    { reason: 'null result', data: null },
    { reason: 'missing ID list', data: {} },
    { reason: 'null ID list', data: { subaccount_ids: null } },
    { reason: 'string ID list', data: { subaccount_ids: '42' } },
    { reason: 'string ID', data: { subaccount_ids: ['42'] } },
    { reason: 'negative ID', data: { subaccount_ids: [-1] } },
    { reason: 'fractional ID', data: { subaccount_ids: [1.5] } },
    { reason: 'unsafe integer ID', data: { subaccount_ids: [Number.MAX_SAFE_INTEGER + 1] } },
    { reason: 'duplicate IDs', data: { subaccount_ids: [42, 42] } },
    { reason: 'different wallet', data: { wallet: auth.signer, subaccount_ids: [42] } },
    { reason: 'non-string wallet', data: { wallet: 42, subaccount_ids: [42] } },
    { reason: 'null wallet', data: { wallet: null, subaccount_ids: [42] } },
  ])('fails closed for $reason', async ({ data }) => {
    const fetch = stubResults({ 'private/get_subaccounts': data });
    const error = await getDeriveAccount(auth).catch(error => error);
    expect(error).toBeInstanceOf(VenueError);
    expect(error.message).toContain('Unexpected subaccount discovery schema or account wallet mismatch');
    expect(error.message).toContain('failed closed'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts a case-insensitive matching wallet, and missing optional wallet metadata', async () => {
    for (const metadata of [{ wallet: owner.toUpperCase(), subaccount_ids: [42] }, { subaccount_ids: [42] }]) {
      stubResults({ 'private/get_subaccounts': metadata });
      await expect(getDeriveAccount(auth)).resolves.toMatchObject({ subaccountId: 42 });
    }
  });
  it.each([
    { reason: 'positions missing', portfolio: { collaterals: [] }, orders: { orders: [] } },
    { reason: 'collaterals missing', portfolio: { positions: [] }, orders: { orders: [] } },
    { reason: 'positions object', portfolio: { positions: {}, collaterals: [] }, orders: { orders: [] } },
    { reason: 'collaterals null', portfolio: { positions: [], collaterals: null }, orders: { orders: [] } },
    { reason: 'orders missing', portfolio: emptyPortfolio, orders: {} },
    { reason: 'orders non-array', portfolio: emptyPortfolio, orders: { orders: {} } },
  ])('rejects private inventory with $reason instead of showing empty holdings', async ({ portfolio, orders }) => {
    stubResults({ 'private/get_subaccount': portfolio, 'private/get_open_orders': orders });
    await expect(getDeriveAccount(auth)).rejects.toThrow('Unexpected private account schema');
  });
});
