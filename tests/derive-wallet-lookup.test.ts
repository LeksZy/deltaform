import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi } from 'viem';
import { lookupDeriveAccountWallet } from '../src/venues/derive';
import { VenueError } from '../src/venues/http';

const signer = '0x1234567890abcdef1234567890abcdef12345678';
const candidate = '0x3333333333333333333333333333333333333333';
const factory = '0x000000893A26168158fbeaDD9335Be5bC96592E2';
const factoryAbi = parseAbi(['function getAddress(address owner, uint256 salt) view returns (address)']);
type RpcRequest = { id: number; method: string; params?: unknown[] };
function stubRpc(settings: { chain?: string; factoryCode?: string; candidateCode?: string } = {}) {
  const requests: RpcRequest[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as RpcRequest; requests.push(body);
    let result: string;
    if (body.method === 'eth_chainId') result = settings.chain ?? '0x3bd';
    else if (body.method === 'eth_getCode') {
      const address = String(body.params![0]).toLowerCase();
      if (address === factory.toLowerCase()) result = settings.factoryCode ?? '0x6000';
      else if (address === candidate.toLowerCase()) result = settings.candidateCode ?? '0x6001';
      else throw new Error(`Unexpected bytecode address ${address}`);
    } else if (body.method === 'eth_call') result = encodeFunctionResult({ abi: factoryAbi, functionName: 'getAddress', result: candidate });
    else throw new Error(`Only read-only chain methods are permitted; got ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch); return { fetch, requests };
}
beforeEach(() => { vi.stubEnv('DERIVE_API_VERSION', 'v2'); vi.stubEnv('DERIVE_NETWORK', 'mainnet'); vi.stubEnv('DERIVE_RPC_URL', ''); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Derive default account-wallet discovery', () => {
  it('checks chain 957 and factory bytecode, calls getAddress with the signer and salt zero, and labels registration unverified', async () => {
    for (const candidateCode of ['0x6001', '0x']) {
      const { fetch, requests } = stubRpc({ candidateCode });
      const result = await lookupDeriveAccountWallet(signer);
      expect(result).toMatchObject({ wallet: getAddress(candidate), signer: getAddress(signer), version: 'v2', network: 'mainnet',
        source: 'default-smart-wallet', deployed: candidateCode !== '0x', registrationVerified: false });
      expect(result.message).toContain('Venue registration is not confirmed');
      expect(requests.map(r => r.method)).toEqual(['eth_chainId', 'eth_getCode', 'eth_call', 'eth_getCode']);
      expect(fetch.mock.calls.every(([url]) => new URL(String(url)).origin === 'https://rpc.lyra.finance')).toBe(true);
      expect(String(requests[1]!.params![0]).toLowerCase()).toBe(factory.toLowerCase());
      const call = requests[2]!.params![0] as { to: string; data: `0x${string}` };
      expect(call.to.toLowerCase()).toBe(factory.toLowerCase());
      expect(decodeFunctionData({ abi: factoryAbi, data: call.data })).toEqual({ functionName: 'getAddress', args: [getAddress(signer), 0n] });
      expect(String(requests[3]!.params![0]).toLowerCase()).toBe(candidate.toLowerCase());
      expect(fetch).toHaveBeenCalledTimes(4);
    }
  });
  it('uses an explicitly configured RPC without changing the factory or owner mapping', async () => {
    vi.stubEnv('DERIVE_RPC_URL', 'https://derive-rpc.example.invalid');
    const { fetch } = stubRpc();
    await expect(lookupDeriveAccountWallet(signer)).resolves.toMatchObject({ wallet: candidate, source: 'default-smart-wallet' });
    expect(fetch.mock.calls.every(([url]) => new URL(String(url)).origin === 'https://derive-rpc.example.invalid')).toBe(true);
  });
  it('uses the connected owner for v3 on either network and performs no RPC lookup', async () => {
    const { fetch } = stubRpc(); vi.stubEnv('DERIVE_API_VERSION', 'v3');
    for (const network of ['mainnet', 'testnet']) {
      vi.stubEnv('DERIVE_NETWORK', network);
      await expect(lookupDeriveAccountWallet(signer)).resolves.toMatchObject({ wallet: getAddress(signer), signer: getAddress(signer), version: 'v3', network,
        source: 'connected-owner', deployed: null, registrationVerified: false });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects malformed signers and unsupported v2 testnet discovery without network calls', async () => {
    const { fetch } = stubRpc();
    for (const invalid of ['', 'not-an-address', '0x1234']) {
      await expect(lookupDeriveAccountWallet(invalid)).rejects.toThrow('valid connected EVM signer address');
    }
    vi.stubEnv('DERIVE_NETWORK', 'testnet');
    await expect(lookupDeriveAccountWallet(signer)).rejects.toThrow('Enter the account wallet from your Derive testnet account');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed with manual-entry guidance on the wrong chain or unavailable verified factory', async () => {
    for (const scenario of [
      { settings: { chain: '0x1' }, message: 'requires chain 957', calls: 1 },
      { settings: { factoryCode: '0x' }, message: 'Verified account factory is unavailable', calls: 2 },
    ]) {
      const { fetch, requests } = stubRpc(scenario.settings);
      const error = await lookupDeriveAccountWallet(signer).catch(error => error);
      expect(error).toBeInstanceOf(VenueError);
      expect(error.message).toContain(scenario.message);
      expect(error.message).toContain('enter the account address from Derive manually');
      expect(fetch).toHaveBeenCalledTimes(scenario.calls);
      expect(requests.some(r => r.method === 'eth_call')).toBe(false);
    }
  });
  it('reports RPC timeout with manual-entry guidance and does not retry or request signatures', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).method).toBe('eth_chainId');
      throw new DOMException('RPC deadline exceeded', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetch);
    const error = await lookupDeriveAccountWallet(signer).catch(error => error);
    expect(error).toBeInstanceOf(VenueError);
    expect(error.message).toContain('Read-only account-wallet lookup failed');
    expect(error.message).toContain('enter the account address from Derive manually');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
