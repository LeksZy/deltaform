import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({
  getChainId: vi.fn(), getBlock: vi.fn(), getBytecode: vi.fn(), readContract: vi.fn(),
}));
const makeClient = vi.hoisted(() => vi.fn(() => rpc));
vi.mock('viem', async importOriginal => ({ ...await importOriginal<typeof import('viem')>(), createPublicClient: makeClient }));
import { checkDeriveSignerAccess } from '../src/venues/derive-auth';

const wallet = '0x1111111111111111111111111111111111111111';
const signer = '0x2222222222222222222222222222222222222222';
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DERIVE_API_VERSION', 'v2'); vi.stubEnv('DERIVE_NETWORK', 'mainnet'); vi.stubEnv('DERIVE_RPC_URL', undefined);
  rpc.getChainId.mockResolvedValue(957); rpc.getBlock.mockResolvedValue({ number: 55n, timestamp: 1000n });
  rpc.getBytecode.mockResolvedValue('0x6000'); rpc.readContract.mockResolvedValue(0n);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('public Derive signer action permission', () => {
  it('validates both addresses and does not contact RPC for identical owner and signer', async () => {
    await expect(checkDeriveSignerAccess('invalid', signer)).rejects.toThrow('Valid account wallet');
    await expect(checkDeriveSignerAccess(wallet, 'invalid')).rejects.toThrow('Valid account wallet');
    const result = await checkDeriveSignerAccess(wallet, wallet);
    expect(result.onchainActionPermission).toBe('direct-owner'); expect(result.expirySec).toBeNull();
    expect(result.message).toContain('not verification of a signature'); expect(makeClient).not.toHaveBeenCalled();
  });
  it('uses signer then owner, the verified mainnet contract, and a consistent block', async () => {
    rpc.readContract.mockResolvedValue(1200n);
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000_000_000);
    const result = await checkDeriveSignerAccess(wallet, signer);
    expect(result.onchainActionPermission).toBe('active'); expect(result.expirySec).toBe(1200);
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: '0xeB8d770ec18DB98Db922E9D83260A585b9F0DeAD', functionName: 'sessionKeys', args: [signer, wallet], blockNumber: 55n,
    }));
    expect(rpc.getBytecode).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 55n }));
    expect(result.message).toContain('does not establish HTTP authentication');
  });
  it.each([[0n, 'unregistered'], [999n, 'expired'], [1000n, 'active']] as const)(
    'classifies expiry %s according to the contract comparison', async (expiry, status) => {
      rpc.readContract.mockResolvedValue(expiry);
      const result = await checkDeriveSignerAccess(wallet, signer);
      expect(result.onchainActionPermission).toBe(status); expect(result.expirySec).toBe(Number(expiry));
      expect(result.message).toContain('does not rule out a valid off-chain read-only session');
    });
  it('does not invent a testnet RPC and checks chain 901 when explicitly configured', async () => {
    vi.stubEnv('DERIVE_NETWORK', 'testnet');
    expect((await checkDeriveSignerAccess(wallet, signer)).onchainActionPermission).toBe('not-checked');
    expect(makeClient).not.toHaveBeenCalled();
    vi.stubEnv('DERIVE_RPC_URL', 'https://rpc.example.test'); rpc.getChainId.mockResolvedValue(901);
    await checkDeriveSignerAccess(wallet, signer);
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: '0x3cc154e220c2197c5337b7Bd13363DD127Bc0C6E' }));
  });
  it('does not mistake wrong networks, absent contracts or failed reads for unregistered keys', async () => {
    rpc.getChainId.mockResolvedValue(1);
    expect((await checkDeriveSignerAccess(wallet, signer)).message).toContain('does not match');
    expect(rpc.readContract).not.toHaveBeenCalled();
    rpc.getChainId.mockResolvedValue(957); rpc.getBytecode.mockResolvedValue('0x');
    expect((await checkDeriveSignerAccess(wallet, signer)).onchainActionPermission).toBe('not-checked');
    rpc.getBytecode.mockResolvedValue('0x6000'); rpc.readContract.mockRejectedValue(new Error('RPC failed https://rpc.example.test/secret-token'));
    const failure = await checkDeriveSignerAccess(wallet, signer);
    expect(failure.onchainActionPermission).toBe('not-checked'); expect(failure.message).not.toContain('secret-token');
  });
  it('does not apply the v2 mapping to delegated v3 signers', async () => {
    vi.stubEnv('DERIVE_API_VERSION', 'v3');
    const result = await checkDeriveSignerAccess(wallet, signer);
    expect(result.version).toBe('v3'); expect(result.onchainActionPermission).toBe('not-checked');
    expect(makeClient).not.toHaveBeenCalled();
  });
});
