import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeAbiParameters, hashTypedData, keccak256, stringToHex } from 'viem';
import { normalizeOwnedBins, supportedOrientation, SOL_MINT, USDC_MINT } from '../src/venues/meteora';
import { buildDeriveOrderTypedData, deriveTakerFee, normalizeDeriveInstrument, type DeriveInstrumentRaw } from '../src/venues/derive';
import { prepareHyperliquidAgentApproval } from '../src/venues/hyperliquid';
import { jsonRequest, VenueError } from '../src/venues/http';

const raw: DeriveInstrumentRaw = {
  instrument_name: 'SOL-20261225-120-C', instrument_type: 'option', is_active: true, base_currency: 'SOL', quote_currency: 'USDC',
  tick_size: '.1', minimum_amount: '1', maximum_amount: '100000', amount_step: '.1', base_fee: '.5',
  taker_fee_rate: '.0003', maker_fee_rate: '.0001', mark_price_fee_rate_cap: '.125',
  base_asset_address: '0x420c9295484d834B03F45E1C9EaC5da8cD8b0710', base_asset_sub_id: '39614081308671776350570160768',
  option_details: { expiry: 1798185600, strike: '120', option_type: 'C', index: 'SOL-USD' },
};
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('venue accounting conversion', () => {
  it('converts owned raw integers with mint decimals without using liquidity shares as tokens', () => {
    expect(normalizeOwnedBins([{ binId: -123, pricePerToken: '120', positionXAmount: '1500000000', positionYAmount: '60250000' }], 9, 6, false))
      .toEqual([{ id: -123, price: 120, x: 1.5, y: 60.25 }]);
  });
  it('normalizes an inverted mixed bin by swapping inventory and reciprocal price', () => {
    expect(normalizeOwnedBins([{ binId: 123, pricePerToken: '0.008', positionXAmount: '60250000', positionYAmount: '1500000000' }], 6, 9, true))
      .toEqual([{ id: 123, price: 125, x: 1.5, y: 60.25 }]);
    expect(supportedOrientation(USDC_MINT, SOL_MINT)).toBe(true);
    expect(() => supportedOrientation('JitoSOL', USDC_MINT)).toThrow('proxy hedges');
  });
  it('does not confuse marks and unavailable asks; confirms one-SOL contract units', () => {
    const instrument = normalizeDeriveInstrument(raw, { t: 10, a: '0', A: '0', b: '0', B: '0', I: '121', M: '13.7' });
    expect(instrument.ask).toBeNull(); expect(instrument.askSize).toBe(0); expect(instrument.mark).toBe(13.7);
    expect(instrument.multiplier).toBe(1); expect(instrument.expiry).toBe(1798185600000);
    expect(instrument.feeModel?.fixed).toBe(.5);
  });
  it('uses the capped notional fee plus one base fee per executed leg', () => {
    expect(deriveTakerFee(10, 2, 120)).toBeCloseTo(.86, 12);
    expect(deriveTakerFee(10, .01, 120)).toBeCloseTo(.5125, 12);
    expect(deriveTakerFee(0, 2, 120)).toBe(0);
  });
});

describe('exchange signing schemas', () => {
  it('uses verified Action type hash and separates v2 SCW owner from EOA signer', () => {
    vi.stubEnv('DERIVE_API_VERSION', 'v2'); vi.stubEnv('DERIVE_NETWORK', 'mainnet');
    const owner = '0x1111111111111111111111111111111111111111';
    const signer = '0x2222222222222222222222222222222222222222';
    const data = buildDeriveOrderTypedData(raw, owner, 123, '1.5', '13.7', '0.5', '1790465000000123', 1790465600, signer);
    expect(data.domain.chainId).toBe(957); expect(data.message.owner).toBe(owner); expect(data.message.signer).toBe(signer);
    expect(keccak256(stringToHex('Action(uint256 subaccountId,uint256 nonce,address module,bytes data,uint256 expiry,address owner,address signer)')))
      .toBe('0x4d7a9f27c403ff9c0f19bce61d76d82f9aa29f8d6d4b0c5474607d9770d1af17');
    const words = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'int256' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }], data.message.data);
    expect(words[2]).toBe(13700000000000000000n); expect(words[3]).toBe(1500000000000000000n); expect(words[5]).toBe(123n); expect(words[6]).toBe(true);
    const digest = hashTypedData({ ...data, domain: { ...data.domain, chainId: 957n }, message: { ...data.message, subaccountId: 123n, nonce: 1790465000000123n, expiry: 1790465600n } });
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('does not conflate v3 testnet chain, nonce and v2 execution domains', () => {
    vi.stubEnv('DERIVE_API_VERSION', 'v3'); vi.stubEnv('DERIVE_NETWORK', 'testnet');
    const data = buildDeriveOrderTypedData(raw, '0x1111111111111111111111111111111111111111', 1, '1', '1', '1', '1790465000000000123', 1790465600);
    expect(data.domain.chainId).toBe(11155111); expect(data.message.nonce).toBe('1790465000000000123');
  });
  it('signs HL agent approval with owner-action domain and network bound into message', () => {
    const data = prepareHyperliquidAgentApproval('0x1111111111111111111111111111111111111111', 1790465000000, 'testnet');
    expect(data.typedData.domain.name).toBe('HyperliquidSignTransaction');
    expect(data.typedData.domain.chainId).toBe(42161); expect(data.action.hyperliquidChain).toBe('Testnet');
    expect(data.action.signatureChainId).toBe('0xa4b1');
  });
});

describe('network ambiguity', () => {
  it('does not silently retry a timeout that might have accepted an order', async () => {
    const mocked = vi.fn().mockRejectedValue(new Error('socket closed'));
    vi.stubGlobal('fetch', mocked);
    await expect(jsonRequest('test', 'https://example.invalid/order', { order: 1 })).rejects.toMatchObject({ ambiguous: true });
    expect(mocked).toHaveBeenCalledTimes(1);
  });
  it('reports unavailable access instead of fabricating live data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(jsonRequest('test', 'https://example.invalid')).rejects.toBeInstanceOf(VenueError);
  });
  it('keeps a server error ambiguous because the exchange may have accepted the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(jsonRequest('test', 'https://example.invalid/order', {})).rejects.toMatchObject({ ambiguous: true });
  });
});
