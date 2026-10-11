import { afterEach, describe, expect, it, vi } from 'vitest';
import { signTypedData, SignTypedDataVersion } from '@metamask/eth-sig-util';
import { privateKeyToAccount } from 'viem/accounts';
import { signTypedDataBatch, typedDataChainId, type EvmWalletProvider } from '../src/client/evm-wallet';

const testKey = `0x${'11'.repeat(32)}` as const;
const signer = privateKeyToAccount(testKey).address;
const other = '0x2222222222222222222222222222222222222222';
const data = (chainId: unknown = 957, nonce = 1) => ({
  domain: { name: 'Matching', version: '1.0', chainId, verifyingContract: other },
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    Order: [{ name: 'nonce', type: 'uint256' }],
  }, primaryType: 'Order', message: { nonce },
});
const walletSignature = (payload: string, privateKey = testKey) => signTypedData({
  privateKey: Buffer.from(privateKey.slice(2), 'hex'), data: JSON.parse(payload), version: SignTypedDataVersion.V4,
});
function wallet(initialChain = 1, options: {
  switchError?: unknown; ignoreSwitch?: boolean; onSwitch?: () => void;
  onSign?: () => void; signature?: unknown; signError?: unknown;
} = {}) {
  let chain = initialChain;
  let account: string = signer;
  const request = vi.fn(async ({ method, params }: Parameters<EvmWalletProvider['request']>[0]): Promise<unknown> => {
    if (method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return `0x${chain.toString(16)}`;
    if (method === 'wallet_switchEthereumChain') {
      if (options.switchError) throw options.switchError;
      if (!options.ignoreSwitch) chain = Number((params![0] as { chainId: string }).chainId);
      options.onSwitch?.(); return null;
    }
    if (method === 'eth_signTypedData_v4') {
      if (options.signError) throw options.signError;
      // Model Rabby's refusal of an EIP-712 domain on a different active chain.
      if (Number(JSON.parse(params![1] as string).domain.chainId) !== chain) throw new Error('chainId should be same as current chainId');
      options.onSign?.(); return options.signature ?? walletSignature(params![1] as string);
    }
    throw new Error(`Unexpected wallet request ${method}`);
  });
  return { provider: { request }, request, setChain(next: number) { chain = next; }, setAccount(next: string) { account = next; } };
}
const sign = (mock: ReturnType<typeof wallet>, payloads: unknown[] = [data()], expiresAt?: number) =>
  signTypedDataBatch(mock.provider, signer, payloads, { label: 'Derive options', expiresAt });
const calls = (mock: ReturnType<typeof wallet>, method: string) => mock.request.mock.calls.filter(([args]) => args.method === method);
afterEach(() => { vi.restoreAllMocks(); });

describe('EVM signing chain and account binding', () => {
  it('switches from Ethereum to Derive before signing the entire unchanged basket', async () => {
    const mock = wallet(), payloads = [data(957, 41), data(957, 42)], original = JSON.stringify(payloads);
    expect(await sign(mock, payloads)).toEqual(payloads.map(payload => walletSignature(JSON.stringify(payload))));
    expect(calls(mock, 'wallet_switchEthereumChain')).toEqual([[{ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x3bd' }] }]]);
    expect(calls(mock, 'eth_signTypedData_v4').map(([args]) => args.params)).toEqual(payloads.map(payload => [signer, JSON.stringify(payload)]));
    expect(JSON.stringify(payloads)).toBe(original);
    const methods = mock.request.mock.calls.map(([args]) => args.method);
    expect(methods.indexOf('wallet_switchEthereumChain')).toBeLessThan(methods.indexOf('eth_signTypedData_v4'));
    expect(methods.slice(-2)).toEqual(['eth_chainId', 'eth_accounts']);
  });
  it('does not request a network switch when the correct chain is already active', async () => {
    const mock = wallet(957);
    await sign(mock); expect(calls(mock, 'wallet_switchEthereumChain')).toHaveLength(0);
  });
  it.each([1, 901, 11155111, 42161])('uses the signed domain chain %i rather than assuming Derive mainnet', async chain => {
    const mock = wallet(957);
    await sign(mock, [data(chain)]);
    expect(calls(mock, 'wallet_switchEthereumChain')[0]![0].params).toEqual([{ chainId: `0x${chain.toString(16)}` }]);
  });
  it.each([957, '957', '0x3bd'])('accepts a valid numeric or encoded chain %s', chain => {
    expect(typedDataChainId(data(chain))).toBe(957);
  });
  it.each([0, -1, 1.5, NaN, true, null, '', '957 garbage', {}, Number.MAX_SAFE_INTEGER + 1])('refuses invalid domain chain %s before any wallet request', async chain => {
    const mock = wallet();
    await expect(sign(mock, [data(chain)])).rejects.toThrow('valid signing chain ID');
    expect(mock.request).not.toHaveBeenCalled();
  });
  it.each([
    [4001, 'network switch rejected'], [4902, 'add Derive Chain (957)'], [-32601, 'could not switch'],
  ])('stops without signing when switching fails with %i', async (code, message) => {
    const mock = wallet(1, { switchError: { code } });
    await expect(sign(mock)).rejects.toThrow(String(message));
    expect(calls(mock, 'eth_signTypedData_v4')).toHaveLength(0);
    expect(calls(mock, 'wallet_switchEthereumChain')).toHaveLength(1);
  });
  it('requires evidence of the actual switched chain, even if the wallet reports success', async () => {
    const mock = wallet(1, { ignoreSwitch: true });
    await expect(sign(mock)).rejects.toThrow('Derive Chain (957) is required');
    expect(calls(mock, 'eth_signTypedData_v4')).toHaveLength(0);
  });
  it('does not switch or sign for an account other than the verified signer', async () => {
    const mock = wallet(); mock.setAccount(other);
    await expect(sign(mock)).rejects.toThrow('verified signer');
    expect(calls(mock, 'wallet_switchEthereumChain')).toHaveLength(0);
    expect(calls(mock, 'eth_signTypedData_v4')).toHaveLength(0);
  });
  it('rechecks the account after the wallet network selection', async () => {
    const mock = wallet(1, { onSwitch: () => mock.setAccount(other) });
    await expect(sign(mock)).rejects.toThrow('account may have changed');
    expect(calls(mock, 'eth_signTypedData_v4')).toHaveLength(0);
  });
  it.each(['chain', 'account'])('aborts the basket if %s changes during the first signature, without returning signatures for submission', async changed => {
    const mock = wallet(957, { onSign: () => changed === 'chain' ? mock.setChain(1) : mock.setAccount(other) });
    const submit = vi.fn();
    await expect((async () => { submit(await sign(mock, [data(957, 1), data(957, 2)])); })()).rejects.toThrow(changed === 'chain' ? 'network changed' : 'account may have changed');
    expect(calls(mock, 'eth_signTypedData_v4')).toHaveLength(1);
    expect(submit).not.toHaveBeenCalled();
  });
  it('checks context after the last signature as well', async () => {
    const mock = wallet(957, { onSign: () => mock.setChain(1) });
    await expect(sign(mock)).rejects.toThrow('network changed');
    expect(calls(mock, 'eth_signTypedData_v4')).toHaveLength(1);
  });
  it('refuses a mixed-chain basket before prompting for any signature or switch', async () => {
    const mock = wallet();
    await expect(sign(mock, [data(957), data(1)])).rejects.toThrow('different chains');
    expect(mock.request).not.toHaveBeenCalled();
  });
  it('validates every domain in advance, including absent domains and empty baskets', async () => {
    const mock = wallet();
    await expect(sign(mock, [data(), { message: {} }])).rejects.toThrow('no EIP-712 domain');
    await expect(sign(mock, [{ domain: {} }])).rejects.toThrow('no domain chain ID');
    await expect(sign(mock, [])).rejects.toThrow('no signing requests');
    expect(mock.request).not.toHaveBeenCalled();
  });
  it('refuses incomplete or altered explicit domain types before prompting the wallet', async () => {
    const mock = wallet(), absent = data(), altered = data();
    delete (absent.types as { EIP712Domain?: unknown }).EIP712Domain;
    altered.types.EIP712Domain[2]!.type = 'string';
    await expect(sign(mock, [absent])).rejects.toThrow('EIP712Domain');
    await expect(sign(mock, [altered])).rejects.toThrow('EIP712Domain');
    expect(mock.request).not.toHaveBeenCalled();
  });
  it('refuses an already expired review without contacting the wallet', async () => {
    const mock = wallet();
    await expect(sign(mock, [data()], Date.now() - 1)).rejects.toThrow('review expired');
    expect(mock.request).not.toHaveBeenCalled();
  });
  it('does not sign if the review expires while the wallet network switch is open', async () => {
    let now = 1_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const mock = wallet(1, { onSwitch: () => { now = 3_000; } });
    await expect(sign(mock, [data()], 2_000)).rejects.toThrow('review expired');
    expect(calls(mock, 'eth_signTypedData_v4')).toHaveLength(0);
  });
  it('does not return a basket that expired during signing or request additional signatures', async () => {
    let now = 1_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const mock = wallet(957, { onSign: () => { now = 3_000; } });
    await expect(sign(mock, [data(), data(957, 2)], 2_000)).rejects.toThrow('review expired');
    expect(calls(mock, 'eth_signTypedData_v4')).toHaveLength(1);
  });
  it('propagates a rejected wallet signature without a retry', async () => {
    const rejection = { code: 4001, message: 'User rejected the request' }, mock = wallet(957, { signError: rejection });
    await expect(sign(mock)).rejects.toBe(rejection);
    expect(calls(mock, 'eth_signTypedData_v4')).toHaveLength(1);
  });
  it('refuses malformed wallet signatures', async () => {
    const mock = wallet(957, { signature: '0x1234' });
    await expect(sign(mock)).rejects.toThrow('invalid signature');
  });
  it('checks the recovered signer before allowing signatures to be submitted', async () => {
    const wrongKey = `0x${'22'.repeat(32)}` as typeof testKey;
    const mock = wallet(957, { signature: walletSignature(JSON.stringify(data()), wrongKey) });
    const submit = vi.fn();
    await expect((async () => { submit(await sign(mock)); })()).rejects.toThrow('does not verify for the reviewed signer');
    expect(submit).not.toHaveBeenCalled();
  });
});
