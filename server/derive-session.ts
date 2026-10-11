import { randomUUID } from 'node:crypto';
import { prepareDeriveSession, confirmDeriveSession, validateDeriveSessionForSubmission, DeriveSessionRevertedError, DeriveSessionInactiveError, type DeriveSessionPreview, type DeriveSessionConfirmation } from '../src/venues/derive-session';

export interface DeriveSessionRequest {
  requestId: string;
  owner: string;
  createdAt: number;
  updatedAt: number;
  phase: 'prepared' | 'wallet-requested' | 'pending' | 'confirmed' | 'rejected' | 'failed' | 'inactive';
  preview: DeriveSessionPreview;
  txHash: string | null;
  confirmation: DeriveSessionConfirmation | null;
  lastError: string | null;
}
interface SessionStore { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }
interface Dependencies {
  prepare: typeof prepareDeriveSession;
  validate: typeof validateDeriveSessionForSubmission;
  confirm: typeof confirmDeriveSession;
  now: () => number;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Persists only public owner transactions. This service never signs or broadcasts. */
export class DeriveSessions {
  constructor(private store: SessionStore, private dependencies: Dependencies = {
    prepare: prepareDeriveSession, validate: validateDeriveSessionForSubmission, confirm: confirmDeriveSession, now: Date.now,
  }) {}
  active(owner: string): DeriveSessionRequest | null {
    const id = this.store.get<string>('deriveSessionActive:' + owner.toLowerCase());
    return id ? this.store.get<DeriveSessionRequest>('deriveSession:' + id) ?? null : null;
  }
  private load(owner: string, id: string) {
    const request = this.store.get<DeriveSessionRequest>('deriveSession:' + id);
    if (!request || !same(request.owner, owner) || this.active(owner)?.requestId !== id) throw new Error('Session request was not found for the connected owner');
    return request;
  }
  private save(request: DeriveSessionRequest) {
    request.updatedAt = this.dependencies.now();
    this.store.set('deriveSession:' + request.requestId, request);
    return request;
  }
  async prepare(owner: string, wallet: string, hours: number) {
    const existing = this.active(owner);
    if (existing && ['wallet-requested', 'pending'].includes(existing.phase)) throw new Error('An authorization transaction is unresolved. Reconcile its hash before preparing another transaction');
    const preview = await this.dependencies.prepare(wallet, owner, hours);
    if (!same(preview.signer, owner) || !same(preview.wallet, wallet)) throw new Error('Prepared authorization does not match the selected wallet and owner');
    const request: DeriveSessionRequest = { requestId: randomUUID(), owner, createdAt: this.dependencies.now(), updatedAt: this.dependencies.now(),
      phase: 'prepared', preview, txHash: null, confirmation: null, lastError: null };
    this.store.set('deriveSessionActive:' + owner.toLowerCase(), request.requestId);
    return this.save(request);
  }
  async begin(owner: string, id: string) {
    const request = this.load(owner, id);
    if (request.phase !== 'prepared') throw new Error('This transaction has already been requested. Reconcile its outcome; do not send a duplicate');
    if (this.dependencies.now() - request.createdAt > 300_000) throw new Error('Authorization preview expired. Prepare and review a fresh preview');
    if (!request.preview.readyToSubmit) throw new Error(request.preview.gasEstimate.error || 'Resolve the authorization gas estimate before sending');
    await this.dependencies.validate(request.preview);
    request.phase = 'wallet-requested';
    this.save(request); // Persist BEFORE asking the wallet to broadcast, including ambiguous outcomes.
    return request;
  }
  rejected(owner: string, id: string) {
    const request = this.load(owner, id);
    if (request.phase !== 'wallet-requested' || request.txHash) throw new Error('Only an explicitly rejected wallet request without a transaction hash can be cleared');
    request.phase = 'rejected'; request.lastError = 'The wallet explicitly rejected the request before broadcasting';
    return this.save(request);
  }
  attach(owner: string, id: string, txHash: string) {
    const request = this.load(owner, id);
    if (!/^0x[\da-fA-F]{64}$/.test(txHash)) throw new Error('A valid transaction hash is required');
    if (!['wallet-requested', 'pending'].includes(request.phase)) throw new Error('The authorization is not awaiting a transaction result');
    if (request.txHash && !same(request.txHash, txHash)) throw new Error('A transaction hash is already recorded. Reconcile that hash without sending a replacement');
    request.txHash = txHash; request.phase = 'pending'; request.lastError = null;
    return this.save(request);
  }
  async reconcile(owner: string, id: string) {
    const request = this.load(owner, id);
    if (request.phase === 'confirmed') return request;
    if (request.phase !== 'pending' || !request.txHash) throw new Error('Enter the transaction hash from the wallet before checking confirmation. Do not blindly submit another transaction');
    try {
      request.confirmation = await this.dependencies.confirm(request.preview, request.txHash);
      request.phase = request.confirmation.status; request.lastError = null;
      return this.save(request);
    } catch (error) {
      // RPC failures and malformed/mismatched receipts must never release the duplicate-send guard.
      if (error instanceof DeriveSessionRevertedError) request.phase = 'failed';
      if (error instanceof DeriveSessionInactiveError) request.phase = 'inactive';
      request.lastError = error instanceof Error ? error.message : 'Authorization remains unresolved';
      this.save(request); throw error;
    }
  }
}
