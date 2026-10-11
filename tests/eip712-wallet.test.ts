import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignTypedDataVersion, TypedDataUtils, signTypedData, type TypedMessage, type MessageTypes } from '@metamask/eth-sig-util';
import { hashTypedData, recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildDeriveOrderTypedData, type DeriveInstrumentRaw } from '../src/venues/derive';
import { prepareHyperliquidAgentApproval } from '../src/venues/hyperliquid';

const testKey = `0x${'11'.repeat(32)}` as Hex, signer = privateKeyToAccount(testKey);
const owner = '0x2222222222222222222222222222222222222222' as const;
const raw: DeriveInstrumentRaw = {
  instrument_name: 'SOL-20260928-130-P', instrument_type: 'option', is_active: true, base_currency: 'SOL', quote_currency: 'USDC',
  tick_size: '0.1', minimum_amount: '1', maximum_amount: '100000', amount_step: '0.1', base_fee: '0.5',
  taker_fee_rate: '0.0003', maker_fee_rate: '0.0001', mark_price_fee_rate_cap: '0.125',
  base_asset_address: '0x420c9295484d834B03F45E1C9EaC5da8cD8b0710', base_asset_sub_id: '39614081312966743646562557568',
  option_details: { expiry: 1790582400, strike: '130', option_type: 'P', index: 'SOL-USD' },
};
const browserData = (data: unknown): TypedMessage<MessageTypes> => JSON.parse(JSON.stringify(data));
const signBrowserJson = (data: TypedMessage<MessageTypes>) => signTypedData({
  privateKey: Buffer.from(testKey.slice(2), 'hex'), data, version: SignTypedDataVersion.V4,
}) as Hex;
const walletHash = (data: TypedMessage<MessageTypes>) => `0x${TypedDataUtils.eip712Hash(data, SignTypedDataVersion.V4).toString('hex')}`;
function deriveData(nonce = '1790532000000123') { return buildDeriveOrderTypedData(raw, owner, 42, '2', '10.5', '0.311201', nonce, 1790532600, signer.address); }
afterEach(() => { vi.unstubAllEnvs(); });

describe('browser JSON-RPC signing compatibility with an independent wallet implementation', () => {
  it.each([
    ['v2', 'mainnet', 957], ['v2', 'testnet', 901], ['v3', 'mainnet', 1], ['v3', 'testnet', 11155111],
  ] as const)('matches wallet and server hashes/signers for Derive %s %s', async (version, network, chain) => {
    vi.stubEnv('DERIVE_API_VERSION', version); vi.stubEnv('DERIVE_NETWORK', network);
    const nonce = version === 'v2' ? '1790532000000123' : '1790532000000000123';
    const typedData = deriveData(nonce), json = browserData(typedData);
    expect(json.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
    ]);
    expect(json.domain.chainId).toBe(chain);
    expect(json.message.nonce).toBe(nonce);
    expect(json.message.owner).toBe(owner); expect(json.message.signer).toBe(signer.address);
    const serverData = { ...typedData, domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) }, message: { ...typedData.message,
      subaccountId: 42n, nonce: BigInt(nonce), expiry: 1790532600n } };
    expect(walletHash(json)).toBe(hashTypedData(serverData));
    expect(await recoverTypedDataAddress({ ...serverData, signature: signBrowserJson(json) })).toBe(signer.address);
  });
  it('reproduces the old mismatch when a wallet receives a missing domain type', async () => {
    vi.stubEnv('DERIVE_API_VERSION', 'v2'); vi.stubEnv('DERIVE_NETWORK', 'mainnet');
    const typedData = deriveData(), incomplete = browserData(typedData);
    delete (incomplete.types as { EIP712Domain?: unknown }).EIP712Domain;
    const serverData = { ...typedData, domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) }, message: { ...typedData.message,
      subaccountId: 42n, nonce: 1790532000000123n, expiry: 1790532600n } };
    expect(walletHash(incomplete)).not.toBe(hashTypedData(serverData));
    expect(await recoverTypedDataAddress({ ...serverData, signature: signBrowserJson(incomplete) })).not.toBe(signer.address);
  });
  it.each(['mainnet', 'testnet'] as const)('matches wallet/server hashes for Hyperliquid %s agent approval', async network => {
    const { typedData } = prepareHyperliquidAgentApproval(owner, 1790532000000, network);
    const json = browserData(typedData);
    expect(json.types.EIP712Domain?.map(field => field.name)).toEqual(['name', 'version', 'chainId', 'verifyingContract']);
    const serverData = { ...typedData, domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) } };
    expect(walletHash(json)).toBe(hashTypedData(serverData));
    expect(await recoverTypedDataAddress({ ...serverData, signature: signBrowserJson(json) })).toBe(signer.address);
  });
  it('binds the signature independently to chain, owner, signer and spending data', async () => {
    vi.stubEnv('DERIVE_API_VERSION', 'v2'); vi.stubEnv('DERIVE_NETWORK', 'mainnet');
    const typedData = deriveData(), json = browserData(typedData), signature = signBrowserJson(json);
    const base = { ...typedData, domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) }, message: { ...typedData.message, subaccountId: 42n, nonce: 1790532000000123n, expiry: 1790532600n } };
    const changes = [
      { ...base, domain: { ...base.domain, chainId: 1n } },
      { ...base, message: { ...base.message, owner: signer.address } },
      { ...base, message: { ...base.message, signer: owner } },
      { ...base, message: { ...base.message, data: `0x${'00'.repeat(224)}` as Hex } },
    ];
    for (const changed of changes) expect(await recoverTypedDataAddress({ ...changed, signature })).not.toBe(signer.address);
  });
});
