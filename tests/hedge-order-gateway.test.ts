import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gateway } from '../server/live';
import { initialState, type OrderIntent } from '../server/engine';
import { Store } from '../server/store';
import type { AgentVault } from '../server/secrets';
import { executeHyperliquidOrder } from '../src/venues/hyperliquid';

vi.mock('../src/venues/hyperliquid', () => ({
  executeHyperliquidOrder: vi.fn(), getHyperliquidMarket: vi.fn(), getHyperliquidAccount: vi.fn(),
  getHyperliquidAttribution: vi.fn(), reconcileHyperliquidOrder: vi.fn(),
  cancelHyperliquidOrder: vi.fn(), hyperliquidInfo: vi.fn(),
}));

let store: Store, gateway: Gateway;
const owner = '0x1111111111111111111111111111111111111111';
const intent: OrderIntent = { underlying: 'HYPE', cloid: '0x' + '1'.repeat(32), quantity: 1,
  price: 100, createdAt: 1790750000000, reason: 'Delta adjustment', appliedFill: 0 };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network access in mocked execution test'); }));
  store = new Store(':memory:');
  gateway = new Gateway(store, { privateKey: () => '0x' + '2'.repeat(64) } as unknown as AgentVault, () => initialState('live'));
  const status = { filled: { totalSz: '1', avgPx: '100', oid: 1 } };
  vi.mocked(executeHyperliquidOrder).mockResolvedValue({
    result: { status: 'ok', response: { type: 'order', data: { statuses: [status] } } },
    status, requestedSize: 1, price: 100, clientOrderId: intent.cloid as `0x${string}` });
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); store.close(); vi.unstubAllGlobals(); });

describe('hedge order gateway flags', () => {
  it.each([
    { label: 'dynamic hedge reduction', change: { reduceOnly: true }, expected: true },
    { label: 'hedge increase without a flag', change: {}, expected: false },
    { label: 'hedge increase with an explicit false flag', change: { reduceOnly: false }, expected: false },
    { label: 'legacy explicit close intent', change: { reason: 'Explicit close-hedge request' }, expected: true },
  ])('forwards reduce-only correctly for $label', async ({ change, expected }) => {
    expect(await gateway.order({ ...intent, ...change }, owner)).toEqual({ status: 'filled', filled: 1, price: 100 });
    expect(executeHyperliquidOrder).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      coin: 'HYPE', size: 1, limitPrice: 100, clientOrderId: intent.cloid, reduceOnly: expected,
    });
  });
});
