import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { getDeriveTradingAccess, requireDeriveTradingAccess, deriveOrderRejectionReason, type DeriveAuth } from '../src/venues/derive';

const now = Date.UTC(2026, 8, 27);
const wallet = '0x2222222222222222222222222222222222222222';
const signer = '0x3333333333333333333333333333333333333333';
const workerKey = '0x4444444444444444444444444444444444444444';
const auth: DeriveAuth = { wallet, signer, timestamp: String(now), signature: '0x1234' };
const key = (scope: string, publicKey = signer, expiry = now / 1000 + 3600) => ({
  public_session_key: publicKey, scope, expiry_sec: expiry,
});
function venue(result: unknown) {
  const fetch = vi.fn(async (_url: string, _request: RequestInit) => new Response(JSON.stringify({ result }), { status: 200 }));
  vi.stubGlobal('fetch', fetch); return fetch;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('DERIVE_API_VERSION', 'v2'); vi.stubEnv('DERIVE_NETWORK', 'mainnet'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('v2 direct trading signer permission', () => {
  it('uses a read-only scope inspection for the exact authenticated wallet and signer', async () => {
    const fetch = venue({ public_session_keys: [key('admin'), key('read_only', workerKey)] });
    const access = await getDeriveTradingAccess(auth);
    expect(access).toMatchObject({ wallet, signer, scope: 'admin', canTrade: true, expirySec: now / 1000 + 3600, checkedAt: now });
    expect(access.message).toContain('withdrawals');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.lyra.finance/private/session_keys');
    expect(JSON.parse(String(request.body))).toEqual({ wallet });
    expect(request.headers).toMatchObject({ 'X-LyraWallet': wallet, 'X-LyraSignature': auth.signature });
  });
  it.each(['account', 'read_only', 'unrecognized_scope'])('refuses %s trading permission', async scope => {
    venue({ public_session_keys: [key(scope)] });
    const access = await getDeriveTradingAccess(auth);
    expect(access.canTrade).toBe(false);
    expect(access.scope).toBe(scope === 'unrecognized_scope' ? 'unknown' : scope);
    await expect(requireDeriveTradingAccess(auth)).rejects.toThrow('private/order requires Admin');
  });
  it('does not treat an unrelated Admin or the worker read key as the trading signer', async () => {
    venue({ public_session_keys: [key('account'), key('admin', workerKey)] });
    await expect(getDeriveTradingAccess(auth)).resolves.toMatchObject({ scope: 'account', canTrade: false });
    venue({ public_session_keys: [key('admin', workerKey)] });
    await expect(requireDeriveTradingAccess(auth)).rejects.toThrow('did not list the connected trading signer');
  });
  it.each([now / 1000 - 1, now / 1000])('refuses expired Admin at timestamp %s', async expiry => {
    venue({ public_session_keys: [key('admin', signer, expiry)] });
    await expect(requireDeriveTradingAccess(auth)).rejects.toThrow('registration has expired');
  });
  it('rechecks permission after an earlier successful check rather than trusting a cached grant', async () => {
    venue({ public_session_keys: [key('admin')] });
    await expect(requireDeriveTradingAccess(auth)).resolves.toMatchObject({ canTrade: true });
    venue({ public_session_keys: [key('read_only')] });
    await expect(requireDeriveTradingAccess(auth)).rejects.toThrow('No orders were sent');
  });
  it('matches case-insensitively and supports the v2 testnet endpoint', async () => {
    vi.stubEnv('DERIVE_NETWORK', 'testnet');
    const mixedSigner = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const fetch = venue({ public_session_keys: [key('admin', getAddress(mixedSigner))] });
    await expect(getDeriveTradingAccess({ ...auth, signer: mixedSigner })).resolves.toMatchObject({ canTrade: true, network: 'testnet' });
    expect(String(fetch.mock.calls[0]?.[0])).toContain('https://api-demo.lyra.finance/');
  });
  it.each([
    null,
    {},
    { public_session_keys: null },
    { public_session_keys: [key('admin', 'invalid')] },
    { public_session_keys: [{ ...key('admin'), expiry_sec: '1790000000' }] },
    { public_session_keys: [key('admin'), key('account')] },
  ])('fails closed on malformed or conflicting scope data (%j)', async response => {
    venue(response);
    await expect(requireDeriveTradingAccess(auth)).rejects.toThrow(/schema|Conflicting/);
  });
  it('propagates a failed scope read without attempting a mutation or inventing permission', async () => {
    const fetch = vi.fn(async (_url: string, _request: RequestInit) => new Response(JSON.stringify({ error: { code: 14030, message: 'Session key expired' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(requireDeriveTradingAccess(auth)).rejects.toThrow('14030');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/private/session_keys');
  });
  it('distinguishes direct owner signing from a delegated session key', async () => {
    const fetch = venue({});
    await expect(getDeriveTradingAccess({ ...auth, signer: wallet })).resolves.toMatchObject({ scope: 'owner', canTrade: true });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not impose the v2 Admin hierarchy on v3', async () => {
    vi.stubEnv('DERIVE_API_VERSION', 'v3');
    const fetch = venue({});
    await expect(getDeriveTradingAccess(auth)).resolves.toMatchObject({ version: 'v3', scope: 'unknown', canTrade: null });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('distinguishes a scope rejection from insufficient funds and expiry without exposing raw venue data', () => {
    expect(deriveOrderRejectionReason(14031)).toContain('Unauthorized key scope');
    expect(deriveOrderRejectionReason(14031)).not.toContain('Insufficient funds');
    expect(deriveOrderRejectionReason(11000)).toContain('Insufficient funds or margin');
    expect(deriveOrderRejectionReason(14030)).toContain('expired');
    expect(deriveOrderRejectionReason(12345)).toBe('The venue rejected this request. Inspect its order/account state and review the remaining hedge.');
  });
});
