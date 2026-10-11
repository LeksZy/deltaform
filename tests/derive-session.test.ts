import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, parseAbi } from 'viem';

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getBlock: vi.fn(), getBytecode: vi.fn(),
  readContract: vi.fn(), getStorageAt: vi.fn(), getBalance: vi.fn(), estimateGas: vi.fn(), getGasPrice: vi.fn(),
  getTransaction: vi.fn(), getTransactionReceipt: vi.fn() }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: vi.fn(() => rpc) }));
import { confirmDeriveSession, DeriveSessionInactiveError, DeriveSessionRevertedError, prepareDeriveSession, validateDeriveSessionForSubmission, type DeriveSessionPreview } from '../src/venues/derive-session';

const wallet = '0x1111111111111111111111111111111111111111';
const signer = '0x2222222222222222222222222222222222222222';
const implementation = '0xc1B2fC4197c9187853243E6e4eb5A4aF8879a1c0';
const hash = `0x${'a'.repeat(64)}` as const, blockHash = `0x${'b'.repeat(64)}` as const;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('DERIVE_API_VERSION', 'v2'); vi.stubEnv('DERIVE_NETWORK', 'mainnet');
  rpc.getChainId.mockResolvedValue(957); rpc.getBlock.mockResolvedValue({ number: 55n, timestamp: 1000n });
  rpc.getBytecode.mockResolvedValue('0x6000');
  rpc.getStorageAt.mockResolvedValue(`0x${'0'.repeat(24)}${implementation.slice(2)}`);
  rpc.readContract.mockImplementation(async args => args.functionName === 'owner' ? signer : args.functionName === 'accountImplementation' ? implementation : 0n);
  rpc.getBalance.mockResolvedValue(10n ** 18n); rpc.estimateGas.mockResolvedValue(100_000n); rpc.getGasPrice.mockResolvedValue(100_000_000n);
});
afterEach(() => vi.unstubAllEnvs());
function mined(preview: DeriveSessionPreview) {
  rpc.getTransaction.mockResolvedValue({ from: signer, to: wallet, input: preview.transaction.data, value: 0n, chainId: 957, blockNumber: 54n, blockHash });
  rpc.getTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: hash, blockNumber: 54n, blockHash });
  rpc.readContract.mockResolvedValue(4600n);
}

describe('Derive owner transaction preparation', () => {
  it('constructs exactly one zero-value execute wrapping signer authorization with a bounded chain-time expiry', async () => {
    const p = await prepareDeriveSession(wallet, signer);
    expect(p.transaction).toMatchObject({ from: signer, to: wallet, value: '0x0' });
    expect(p.expirySec).toBe(4600); expect(p.currentExpirySec).toBe(0); expect(p.implementationVersion).toBe('1.0.1');
    const outer = decodeFunctionData({ abi: parseAbi(['function execute(address dest,uint256 value,bytes func)']), data: p.transaction.data });
    expect(outer.functionName).toBe('execute'); expect(outer.args[0].toLowerCase()).toBe('0xeb8d770ec18db98db922e9d83260a585b9f0dead');
    expect(outer.args[1]).toBe(0n);
    const inner = decodeFunctionData({ abi: parseAbi(['function registerSessionKey(address sessionKey,uint256 expiry)']), data: outer.args[2] });
    expect(inner.args).toEqual([signer, 4600n]);
    expect(p.gasEstimate.estimatedCostWei).toBe('10000000000000'); expect(p.gasEstimate.estimatedCostEth).toBe('0.00001');
    expect(p.readyToSubmit).toBe(true); expect(p.warnings.join(' ')).toContain('10-minute');
    expect(p.warnings.join(' ')).toContain('not a read-only');
  });
  it('rejects invalid addresses, unsupported deployment modes and duration outside 1–24 hours', async () => {
    await expect(prepareDeriveSession('invalid', signer)).rejects.toThrow('Valid Derive');
    for (const hours of [0, .5, 25, NaN]) await expect(prepareDeriveSession(wallet, signer, hours)).rejects.toThrow('between 1 and 24');
    vi.stubEnv('DERIVE_API_VERSION', 'v3'); await expect(prepareDeriveSession(wallet, signer)).rejects.toThrow('v2 mainnet');
    vi.stubEnv('DERIVE_API_VERSION', 'v2'); vi.stubEnv('DERIVE_NETWORK', 'testnet');
    await expect(prepareDeriveSession(wallet, signer)).rejects.toThrow('v2 mainnet');
  });
  it('rejects wrong RPC chain, undeployed account and a signer who is not its owner', async () => {
    rpc.getChainId.mockResolvedValue(1); await expect(prepareDeriveSession(wallet, signer)).rejects.toThrow('chain 957');
    rpc.getChainId.mockResolvedValue(957); rpc.getBytecode.mockResolvedValue('0x');
    await expect(prepareDeriveSession(wallet, signer)).rejects.toThrow('already be deployed');
    rpc.getBytecode.mockResolvedValue('0x6000'); rpc.readContract.mockImplementation(async args => args.functionName === 'owner' ? wallet : args.functionName === 'accountImplementation' ? implementation : 0n);
    await expect(prepareDeriveSession(wallet, signer)).rejects.toThrow('not the account wallet owner');
  });
  it('rejects upgraded/unknown implementation and will not silently extend an existing longer deadline', async () => {
    rpc.getStorageAt.mockResolvedValue(`0x${'0'.repeat(64)}`);
    await expect(prepareDeriveSession(wallet, signer)).rejects.toThrow('Unsupported account implementation');
    rpc.getStorageAt.mockResolvedValue(`0x${'0'.repeat(24)}${implementation.slice(2)}`);
    rpc.readContract.mockImplementation(async args => args.functionName === 'owner' ? signer : args.functionName === 'accountImplementation' ? implementation : 90000n);
    await expect(prepareDeriveSession(wallet, signer)).rejects.toThrow('will not silently extend');
  });
  it('reports insufficient ETH and unavailable gas estimates without inventing a fee or leaking RPC credentials', async () => {
    rpc.getBalance.mockResolvedValue(1n);
    let p = await prepareDeriveSession(wallet, signer);
    expect(p.readyToSubmit).toBe(false); expect(p.gasEstimate.sufficientNativeGas).toBe(false);
    rpc.estimateGas.mockRejectedValue(new Error('https://rpc.example/secret-token'));
    p = await prepareDeriveSession(wallet, signer);
    expect(p.gasEstimate.estimatedCostWei).toBeNull(); expect(p.readyToSubmit).toBe(false);
    expect(JSON.stringify(p)).not.toContain('secret-token');
  });
});

describe('Derive session checks immediately before the wallet request', () => {
  it('rechecks current state and gas for the exact reviewed calldata without refreshing its deadline', async () => {
    const p = await prepareDeriveSession(wallet, signer), saved = JSON.stringify(p);
    rpc.getBlock.mockResolvedValue({ number: 56n, timestamp: 1100n });
    vi.clearAllMocks();
    await expect(validateDeriveSessionForSubmission(p)).resolves.toBeUndefined();
    expect(JSON.stringify(p)).toBe(saved);
    expect(rpc.estimateGas).toHaveBeenCalledWith({ account: signer, to: wallet, value: 0n, data: p.transaction.data });
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'owner', blockNumber: 56n }));
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'sessionKeys', blockNumber: 56n, args: [signer, wallet] }));
    expect(rpc.getTransaction).not.toHaveBeenCalled();
  });
  it.each([4540n, 4541n, 4600n, 4601n])('refuses an expired or imminently expiring deadline at chain time %s', async timestamp => {
    const p = await prepareDeriveSession(wallet, signer);
    rpc.getBlock.mockResolvedValue({ number: 56n, timestamp });
    rpc.estimateGas.mockClear();
    await expect(validateDeriveSessionForSubmission(p)).rejects.toThrow('deadline has expired');
    expect(p.expirySec).toBe(4600); expect(rpc.estimateGas).not.toHaveBeenCalled();
  });
  it.each([4600n, 5000n])('refuses a session whose on-chain deadline has overtaken the preview: %s', async existing => {
    const p = await prepareDeriveSession(wallet, signer);
    rpc.readContract.mockImplementation(async args => args.functionName === 'owner' ? signer : args.functionName === 'accountImplementation' ? implementation : existing);
    await expect(validateDeriveSessionForSubmission(p)).rejects.toThrow('superseded authorization');
  });
  it('refuses a changed owner, upgraded implementation or wrong RPC chain', async () => {
    const p = await prepareDeriveSession(wallet, signer);
    rpc.readContract.mockImplementation(async args => args.functionName === 'owner' ? wallet : args.functionName === 'accountImplementation' ? implementation : 0n);
    await expect(validateDeriveSessionForSubmission(p)).rejects.toThrow('not the account wallet owner');
    rpc.readContract.mockImplementation(async args => args.functionName === 'owner' ? signer : args.functionName === 'accountImplementation' ? implementation : 0n);
    rpc.getStorageAt.mockResolvedValue(`0x${'0'.repeat(64)}`);
    await expect(validateDeriveSessionForSubmission(p)).rejects.toThrow('Unsupported account implementation');
    rpc.getChainId.mockResolvedValue(1);
    await expect(validateDeriveSessionForSubmission(p)).rejects.toThrow('chain 957');
  });
  it('rechecks current gas feasibility and hides RPC credentials on simulation failures', async () => {
    const p = await prepareDeriveSession(wallet, signer);
    rpc.getBalance.mockResolvedValue(1n);
    await expect(validateDeriveSessionForSubmission(p)).rejects.toThrow('insufficient native ETH');
    rpc.getBalance.mockResolvedValue(10n ** 18n);
    rpc.estimateGas.mockRejectedValue(new Error('https://rpc.example/secret-token'));
    const error = await validateDeriveSessionForSubmission(p).catch(error => error);
    expect(error.message).toContain('pre-submission validation'); expect(error.message).not.toContain('secret-token');
  });
  it('refuses tampered persisted calldata, metadata and a deadline changed without updated calldata before any RPC call', async () => {
    const p = await prepareDeriveSession(wallet, signer);
    vi.clearAllMocks();
    await expect(validateDeriveSessionForSubmission({ ...p, transaction: { ...p.transaction, data: '0x1234' } })).rejects.toThrow('Persisted preview');
    await expect(validateDeriveSessionForSubmission({ ...p, expirySec: 4700 })).rejects.toThrow('Persisted preview');
    await expect(validateDeriveSessionForSubmission({ ...p, implementation: wallet })).rejects.toThrow('Invalid persisted');
    expect(rpc.getChainId).not.toHaveBeenCalled();
  });
});

describe('Derive session transaction reconciliation', () => {
  it('confirms only an exact successful mined transaction plus currently active Matching permission', async () => {
    const p = await prepareDeriveSession(wallet, signer); mined(p);
    const result = await confirmDeriveSession(p, hash);
    expect(result.status).toBe('confirmed'); expect(result.expirySec).toBe(4600);
    expect(result.message).toContain('HTTP authentication must still be confirmed separately');
  });
  it('keeps pending/not-yet-found outcomes unresolved without attempting replacement transactions', async () => {
    const p = await prepareDeriveSession(wallet, signer); mined(p);
    rpc.getTransaction.mockResolvedValue({ from: signer, to: wallet, input: p.transaction.data, value: 0n, chainId: 957, blockNumber: null });
    expect((await confirmDeriveSession(p, hash)).status).toBe('pending'); expect(rpc.getTransactionReceipt).not.toHaveBeenCalled();
    rpc.getTransaction.mockRejectedValue(Object.assign(new Error('not found'), { name: 'TransactionNotFoundError' }));
    expect((await confirmDeriveSession(p, hash)).status).toBe('pending');
  });
  it('rejects reverted receipts and a successful receipt without the promised authorization', async () => {
    const p = await prepareDeriveSession(wallet, signer); mined(p);
    rpc.getTransactionReceipt.mockResolvedValue({ status: 'reverted', transactionHash: hash, blockNumber: 54n, blockHash });
    await expect(confirmDeriveSession(p, hash)).rejects.toBeInstanceOf(DeriveSessionRevertedError);
    mined(p); rpc.readContract.mockResolvedValue(0n);
    await expect(confirmDeriveSession(p, hash)).rejects.toBeInstanceOf(DeriveSessionInactiveError);
  });
  it.each([{ expiry: 0n, time: 1000n }, { expiry: 4000n, time: 1000n }, { expiry: 4600n, time: 4601n }])('classifies a successful transaction with absent, shortened or expired Mapping as inactive: %s', async ({ expiry, time }) => {
    const p = await prepareDeriveSession(wallet, signer); mined(p);
    rpc.readContract.mockResolvedValue(expiry); rpc.getBlock.mockResolvedValue({ number: 55n, timestamp: time });
    await expect(confirmDeriveSession(p, hash)).rejects.toBeInstanceOf(DeriveSessionInactiveError);
  });
  it('keeps permission active at the exact expiry timestamp, as required by the on-chain strict less-than comparison', async () => {
    const p = await prepareDeriveSession(wallet, signer); mined(p);
    rpc.getBlock.mockResolvedValue({ number: 55n, timestamp: 4600n });
    expect((await confirmDeriveSession(p, hash)).status).toBe('confirmed');
  });
  it('keeps failed or invalid Mapping reads and stale pre-receipt snapshots unresolved', async () => {
    const p = await prepareDeriveSession(wallet, signer); mined(p);
    rpc.readContract.mockRejectedValue(new Error('RPC unavailable'));
    let error = await confirmDeriveSession(p, hash).catch(error => error);
    expect(error).not.toBeInstanceOf(DeriveSessionInactiveError); expect(error.message).toContain('unresolved');
    rpc.readContract.mockResolvedValue(undefined);
    error = await confirmDeriveSession(p, hash).catch(error => error);
    expect(error).not.toBeInstanceOf(DeriveSessionInactiveError); expect(error.message).toContain('exact integer');
    rpc.getBlock.mockResolvedValue({ number: 53n, timestamp: 1000n });
    rpc.readContract.mockClear();
    error = await confirmDeriveSession(p, hash).catch(error => error);
    expect(error).not.toBeInstanceOf(DeriveSessionInactiveError); expect(error.message).toContain('predates');
    expect(rpc.readContract).not.toHaveBeenCalled();
  });
  it('does not classify a mismatched successful receipt as inactive even when the Mapping would be empty', async () => {
    const p = await prepareDeriveSession(wallet, signer); mined(p);
    rpc.getTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: hash, blockNumber: 99n, blockHash });
    rpc.readContract.mockResolvedValue(0n).mockClear();
    const error = await confirmDeriveSession(p, hash).catch(error => error);
    expect(error).not.toBeInstanceOf(DeriveSessionInactiveError); expect(error.message).toContain('inconsistent');
    expect(rpc.readContract).not.toHaveBeenCalled();
  });
  it('does not classify an inconsistent or unknown receipt as a definite reverted transaction', async () => {
    const p = await prepareDeriveSession(wallet, signer); mined(p);
    rpc.getTransactionReceipt.mockResolvedValue({ status: 'reverted', transactionHash: hash, blockNumber: 99n, blockHash });
    let error = await confirmDeriveSession(p, hash).catch(error => error);
    expect(error).not.toBeInstanceOf(DeriveSessionRevertedError); expect(error.message).toContain('inconsistent');
    rpc.getTransactionReceipt.mockResolvedValue({ status: 'unknown', transactionHash: hash, blockNumber: 54n, blockHash });
    error = await confirmDeriveSession(p, hash).catch(error => error);
    expect(error).not.toBeInstanceOf(DeriveSessionRevertedError); expect(error.message).toContain('unresolved');
  });
  it('checks receipt availability and its block independently from a mined transaction', async () => {
    const p = await prepareDeriveSession(wallet, signer); mined(p);
    rpc.getTransactionReceipt.mockRejectedValue(Object.assign(new Error('receipt unavailable'), { name: 'TransactionReceiptNotFoundError' }));
    expect((await confirmDeriveSession(p, hash)).status).toBe('pending');
    rpc.getTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: hash, blockNumber: 99n, blockHash });
    await expect(confirmDeriveSession(p, hash)).rejects.toThrow('inconsistent');
  });
  it.each([{ value: 1n }, { from: wallet }, { to: signer }, { input: '0x1234' }, { chainId: 1 }])('rejects altered transaction fields %s', async changed => {
    const p = await prepareDeriveSession(wallet, signer); mined(p);
    rpc.getTransaction.mockResolvedValue({ from: signer, to: wallet, input: p.transaction.data, value: 0n, chainId: 957, blockNumber: 54n, blockHash, ...changed });
    await expect(confirmDeriveSession(p, hash)).rejects.toThrow('does not match');
  });
  it('rejects altered persisted preview data and a confirmation RPC on the wrong chain', async () => {
    const p = await prepareDeriveSession(wallet, signer);
    await expect(confirmDeriveSession({ ...p, transaction: { ...p.transaction, data: '0x1234' } }, hash)).rejects.toThrow('Persisted preview');
    rpc.getChainId.mockResolvedValue(1); await expect(confirmDeriveSession(p, hash)).rejects.toThrow('chain 957');
  });
});
