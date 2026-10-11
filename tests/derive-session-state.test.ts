import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store';
import { DeriveSessions } from '../server/derive-session';
import { DeriveSessionRevertedError, DeriveSessionInactiveError, type DeriveSessionPreview } from '../src/venues/derive-session';

const owner = '0x2222222222222222222222222222222222222222';
const wallet = '0x1111111111111111111111111111111111111111';
const hash = `0x${'ab'.repeat(32)}`;
const preview: DeriveSessionPreview = {
  wallet, signer: owner, version: 'v2', network: 'mainnet', chainId: 957, checkedAt: 100000,
  expirySec: 3700, currentExpirySec: 0, implementation: '0xc1B2fC4197c9187853243E6e4eb5A4aF8879a1c0', implementationVersion: '1.0.1',
  transaction: { from: owner, to: wallet, value: '0x0', data: '0x1234' }, readyToSubmit: true,
  gasEstimate: { gasUnits: '100', gasPriceWei: '100', estimatedCostWei: '10000', estimatedCostEth: '0.00000000000001', nativeBalanceWei: '100000', nativeBalanceEth: '0.0000000000001', sufficientNativeGas: true, error: null }, warnings: ['Broad Matching authority'],
};
let store: Store, sessions: DeriveSessions;
let now = 100000;
const prepare = vi.fn(), validate = vi.fn(), confirm = vi.fn();
beforeEach(() => {
  now = 100000; vi.clearAllMocks(); store = new Store(':memory:');
  prepare.mockResolvedValue(structuredClone(preview)); validate.mockResolvedValue(undefined);
  confirm.mockResolvedValue({ status: 'pending', txHash: hash, checkedAt: now, expirySec: null, message: 'Still pending' });
  sessions = new DeriveSessions(store, { prepare, validate, confirm, now: () => now });
});
afterEach(() => store.close());

describe('durable owner-controlled Derive session authorization', () => {
  it('previews without authorization and binds both account and connected owner', async () => {
    const request = await sessions.prepare(owner, wallet, 1);
    expect(prepare).toHaveBeenCalledWith(wallet, owner, 1);
    expect(request.phase).toBe('prepared'); expect(request.txHash).toBeNull();
    expect(validate).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    prepare.mockResolvedValue({ ...preview, signer: wallet });
    await expect(sessions.prepare(owner, wallet, 1)).rejects.toThrow('does not match');
  });
  it('persists wallet-requested before returning and blocks duplicate sends/previews across restart', async () => {
    const request = await sessions.prepare(owner, wallet, 1);
    await sessions.begin(owner, request.requestId);
    expect(validate).toHaveBeenCalledWith(preview);
    const restarted = new DeriveSessions(store, { prepare, validate, confirm, now: () => now });
    expect(restarted.active(owner)?.phase).toBe('wallet-requested');
    await expect(restarted.begin(owner, request.requestId)).rejects.toThrow('already been requested');
    await expect(restarted.prepare(owner, wallet, 1)).rejects.toThrow('unresolved');
    expect(validate).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong owners and superseded request identifiers', async () => {
    const old = await sessions.prepare(owner, wallet, 1);
    const current = await sessions.prepare(owner, wallet, 1);
    await expect(sessions.begin(wallet, current.requestId)).rejects.toThrow('connected owner');
    await expect(sessions.begin(owner, old.requestId)).rejects.toThrow('connected owner');
  });
  it('requires a fresh preview and feasible gas before requesting the wallet', async () => {
    const old = await sessions.prepare(owner, wallet, 1); now += 300001;
    await expect(sessions.begin(owner, old.requestId)).rejects.toThrow('expired');
    prepare.mockResolvedValue({ ...preview, readyToSubmit: false, gasEstimate: { ...preview.gasEstimate, error: 'Insufficient native gas' } });
    const noGas = await sessions.prepare(owner, wallet, 1);
    await expect(sessions.begin(owner, noGas.requestId)).rejects.toThrow('Insufficient native gas');
    expect(validate).not.toHaveBeenCalled();
  });
  it('preserves unsigned state after fresh validation rejects changed ownership', async () => {
    const request = await sessions.prepare(owner, wallet, 1);
    validate.mockRejectedValue(new Error('Owner changed'));
    await expect(sessions.begin(owner, request.requestId)).rejects.toThrow('Owner changed');
    expect(sessions.active(owner)?.phase).toBe('prepared');
  });
  it('only releases a wallet request after an explicit pre-broadcast rejection', async () => {
    const request = await sessions.prepare(owner, wallet, 1);
    expect(() => sessions.rejected(owner, request.requestId)).toThrow('explicitly rejected');
    await sessions.begin(owner, request.requestId);
    expect(sessions.rejected(owner, request.requestId).phase).toBe('rejected');
    expect((await sessions.prepare(owner, wallet, 1)).phase).toBe('prepared');
  });
  it('records one hash, permits idempotent attachment and never replaces an ambiguous submission', async () => {
    const request = await sessions.prepare(owner, wallet, 1); await sessions.begin(owner, request.requestId);
    sessions.attach(owner, request.requestId, hash); sessions.attach(owner, request.requestId, hash.toUpperCase().replace('0X', '0x'));
    expect(() => sessions.attach(owner, request.requestId, `0x${'cd'.repeat(32)}`)).toThrow('already recorded');
    expect(() => sessions.rejected(owner, request.requestId)).toThrow('explicitly rejected');
    await expect(sessions.prepare(owner, wallet, 1)).rejects.toThrow('unresolved');
  });
  it('requires a recorded hash and does not call confirmation for an unknown wallet response', async () => {
    const request = await sessions.prepare(owner, wallet, 1); await sessions.begin(owner, request.requestId);
    await expect(sessions.reconcile(owner, request.requestId)).rejects.toThrow('Enter the transaction hash');
    expect(confirm).not.toHaveBeenCalled();
  });
  it('keeps pending outcomes after expiry/restart and confirms only verified chain evidence', async () => {
    const request = await sessions.prepare(owner, wallet, 1); await sessions.begin(owner, request.requestId); sessions.attach(owner, request.requestId, hash);
    now += 600000;
    expect((await sessions.reconcile(owner, request.requestId)).phase).toBe('pending');
    confirm.mockResolvedValue({ status: 'confirmed', txHash: hash, checkedAt: now, expirySec: 3700, message: 'On-chain only' });
    expect((await sessions.reconcile(owner, request.requestId)).phase).toBe('confirmed');
    await sessions.reconcile(owner, request.requestId); expect(confirm).toHaveBeenCalledTimes(2);
    expect(store.get('deriveAuth:' + owner.toLowerCase())).toBeUndefined();
  });
  it('keeps duplicate-send guard on mismatched receipts and transient errors', async () => {
    const request = await sessions.prepare(owner, wallet, 1); await sessions.begin(owner, request.requestId); sessions.attach(owner, request.requestId, hash);
    confirm.mockRejectedValue(new Error('Receipt inconsistent'));
    await expect(sessions.reconcile(owner, request.requestId)).rejects.toThrow('Receipt inconsistent');
    expect(sessions.active(owner)?.phase).toBe('pending');
    expect(sessions.active(owner)?.lastError).toBe('Receipt inconsistent');
    await expect(sessions.prepare(owner, wallet, 1)).rejects.toThrow('unresolved');
  });
  it('allows a new preview only after a verified matching transaction reverted', async () => {
    const request = await sessions.prepare(owner, wallet, 1); await sessions.begin(owner, request.requestId); sessions.attach(owner, request.requestId, hash);
    confirm.mockRejectedValue(new DeriveSessionRevertedError());
    await expect(sessions.reconcile(owner, request.requestId)).rejects.toThrow('reverted');
    expect(sessions.active(owner)?.phase).toBe('failed');
    expect((await sessions.prepare(owner, wallet, 1)).phase).toBe('prepared');
  });
  it('releases a successfully mined but now-inactive grant without authenticating the account', async () => {
    const request = await sessions.prepare(owner, wallet, 1); await sessions.begin(owner, request.requestId); sessions.attach(owner, request.requestId, hash);
    confirm.mockRejectedValue(new DeriveSessionInactiveError());
    await expect(sessions.reconcile(owner, request.requestId)).rejects.toBeInstanceOf(DeriveSessionInactiveError);
    expect(sessions.active(owner)?.phase).toBe('inactive');
    expect(store.get('deriveAuth:' + owner.toLowerCase())).toBeUndefined();
    expect((await sessions.prepare(owner, wallet, 1)).phase).toBe('prepared');
  });
});
