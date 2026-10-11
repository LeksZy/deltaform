import { createHash, randomUUID } from 'node:crypto';
import type { AppState } from '../src/shared/types';
import type { RecoveryConfirmation, RecoveryEvidence, RecoveryReview } from '../src/shared/hedge-recovery';
import { hlNetwork } from '../src/venues/hyperliquid';
import type { Engine, InternalState, OrderIntent } from './engine';
import { activeCode, stashBook } from './multi-asset';
import type { Store } from './store';

export const HEDGE_RECOVERY_REVIEW_MS = 120_000;
const WARNING = 'These read-only observations do not prove that the order was never accepted. Recovery archives only the local intent as abandoned-unknown; it does not cancel or reject an exchange order. Automation remains paused.';
const reviewKey = (id: string) => `hedgeRecoveryReview:${id}`;
const activeReviewKey = (underlying: string) => `hedgeRecoveryReviewActive:${underlying}`;
const archiveKey = (clientOrderId: string) => `hedgeRecoveryArchive:${clientOrderId}`;

interface RecoveryBinding {
  owner: string;
  network: ReturnType<typeof hlNetwork>;
  mode: 'live';
  underlying: string;
  intent: OrderIntent;
  identity: string;
  fingerprint: string;
}
interface StoredRecoveryReview extends RecoveryBinding { review: RecoveryReview }
export interface HedgeRecoveryArchive extends RecoveryBinding {
  outcome: 'abandoned-unknown';
  archivedAt: number;
  review: RecoveryReview;
  evidence: RecoveryEvidence;
  acknowledgeUnknown: true;
  actualPerp: number;
  anchor: number | null;
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function samePosition(left: number, right: number) {
  return Math.abs(left - right) <= Math.max(1e-8, Math.max(Math.abs(left), Math.abs(right)) * 1e-10);
}
function portfolioScope(state: InternalState) {
  return Object.entries(state.books ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([underlying, book]) => ({
    underlying, positions: book.positions.map(position => position.id).sort(), selectedIds: [...book.selectedIds].sort(),
    holdings: book.holdings.map(holding => [holding.instrument.venue, holding.instrument.network,
      holding.instrument.name, holding.quantity]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  }));
}
function identity(state: InternalState) {
  return hash({ mode: state.mode, underlying: activeCode(state), network: hlNetwork(), accounts: state.accounts,
    intent: state.intent, pendingOrder: state.hedge.pendingOrder, anchor: state.hedge.anchor,
    settings: state.hedge.settings, scope: portfolioScope(state) });
}
function fingerprint(state: InternalState) {
  return hash({ identity: identity(state), books: Object.entries(state.books ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([underlying, book]) => ({ underlying, enabled: book.hedge.enabled, intent: book.intent,
      pendingOrder: book.hedge.pendingOrder, actualPerp: book.hedge.actualPerp })) });
}

/** Call inside the engine's mutation queue. This service never signs, submits, or cancels an order. */
export class HedgeRecovery {
  constructor(private readonly engine: Engine, private readonly store: Store,
    private readonly inspect: (owner: string, intent: OrderIntent) => Promise<RecoveryEvidence>) {}

  private pausedContext() {
    const state = this.engine.state;
    stashBook(state);
    if (state.mode !== 'live') throw new Error('Local hedge recovery is only available in live mode.');
    if (state.globalPaused !== true || state.hedge.enabled || Object.values(state.books!).some(book => book.hedge.enabled))
      throw new Error('Pause all automatic hedges before reviewing or confirming local recovery.');
    const underlying = activeCode(state);
    if (underlying !== 'SOL' && underlying !== 'HYPE') throw new Error('Local recovery requires the selected SOL or HYPE book.');
    const account = state.accounts.hyperliquid;
    if (!account?.verified || !/^0x[0-9a-f]{40}$/i.test(account.address))
      throw new Error('Connect and verify the owning Hyperliquid account before local recovery.');
    if (this.store.get('bybitBasketPending')) throw new Error('Reconcile the pending Bybit basket before local hedge recovery.');
    if (Object.entries(state.books!).some(([asset, book]) => asset !== underlying && (book.intent || book.hedge.pendingOrder)))
      throw new Error('Another underlying has a pending order; reconcile it before local recovery.');
    return { state, underlying, owner: account.address, network: hlNetwork() };
  }

  private pendingContext() {
    const context = this.pausedContext();
    const { state, underlying } = context, intent = state.intent;
    if (!intent || state.hedge.pendingOrder !== intent.cloid)
      throw new Error('The selected pending intent must exactly match its local client order ID.');
    if (!/^0x[0-9a-f]{32}$/i.test(intent.cloid) || (intent.underlying ?? 'SOL') !== underlying
      || !Number.isFinite(intent.quantity) || intent.quantity === 0 || !Number.isFinite(intent.createdAt)
      || intent.createdAt <= 0 || intent.createdAt > Date.now() || !Number.isFinite(intent.price) || intent.price <= 0)
      throw new Error('The pending intent is not a known, valid order for the selected underlying.');
    if (intent.appliedFill !== 0) throw new Error('A locally applied fill prevents unknown-intent recovery.');
    return { ...context, intent };
  }

  private checkReview(record: StoredRecoveryReview, completeFingerprint = true) {
    const context = this.pendingContext();
    if (Date.now() >= record.review.expiresAt || Date.now() < record.review.createdAt)
      throw new Error('Local recovery review expired. Refresh the review before confirming.');
    if (context.owner !== record.owner || context.network !== record.network || context.underlying !== record.underlying
      || identity(context.state) !== record.identity || (completeFingerprint && fingerprint(context.state) !== record.fingerprint))
      throw new Error('The account, intent, or portfolio changed. Refresh the local recovery review.');
    return context;
  }

  private requireEligible(evidence: RecoveryEvidence) {
    if (!evidence.eligible || evidence.blockers.length > 0 || evidence.orderStatus !== 'unknownOid' || evidence.openOrderCount !== 0
      || evidence.matchingHistoricalOrderCount !== 0
      || evidence.fillsSinceIntentCount !== 0 || !evidence.fillsComplete
      || evidence.actualPerp === null || !Number.isFinite(evidence.actualPerp)
      || !Number.isFinite(evidence.checkedAt) || evidence.checkedAt > Date.now() + 5_000
      || Date.now() - evidence.checkedAt > HEDGE_RECOVERY_REVIEW_MS)
      throw new Error(`Read-only evidence does not permit local recovery. ${evidence.blockers.join('; ') || 'Refresh the recovery review.'}`);
  }

  async preview(): Promise<RecoveryReview> {
    const context = this.pendingContext();
    const binding: RecoveryBinding = { owner: context.owner, network: context.network, mode: 'live',
      underlying: context.underlying, intent: structuredClone(context.intent), identity: identity(context.state), fingerprint: fingerprint(context.state) };
    const evidence = await this.inspect(context.owner, structuredClone(context.intent));
    // HTTP routes serialize mutations, but also reject callers that changed state during a read.
    const current = this.pendingContext();
    if (fingerprint(current.state) !== binding.fingerprint)
      throw new Error('The account, intent, or portfolio changed while reading evidence. Refresh the recovery review.');
    const createdAt = Date.now();
    const review: RecoveryReview = { id: randomUUID(), createdAt, expiresAt: createdAt + HEDGE_RECOVERY_REVIEW_MS,
      underlying: context.underlying, clientOrderId: context.intent.cloid, quantity: context.intent.quantity,
      intentCreatedAt: context.intent.createdAt, evidence: structuredClone(evidence), warning: WARNING };
    this.store.transaction(() => {
      const priorId = this.store.get<string>(activeReviewKey(context.underlying));
      if (priorId) this.store.delete(reviewKey(priorId));
      this.store.set(reviewKey(review.id), { ...binding, review } satisfies StoredRecoveryReview);
      this.store.set(activeReviewKey(context.underlying), review.id);
    });
    return structuredClone(review);
  }

  async confirm(input: RecoveryConfirmation): Promise<AppState> {
    if (input.acknowledgeUnknown !== true) throw new Error('Explicit acknowledgement of the unknown exchange outcome is required.');
    const context = this.pausedContext();
    const committed = this.store.get<HedgeRecoveryArchive>(archiveKey(input.clientOrderId));
    if (committed) {
      if (committed.outcome !== 'abandoned-unknown' || committed.review.id !== input.reviewId || committed.review.clientOrderId !== input.clientOrderId
        || committed.owner !== context.owner || committed.network !== context.network || committed.underlying !== context.underlying)
        throw new Error('This client order ID has a different committed recovery review.');
      return this.engine.publicState();
    }
    const record = this.store.get<StoredRecoveryReview>(reviewKey(input.reviewId));
    if (!record || record.review.clientOrderId !== input.clientOrderId
      || this.store.get(activeReviewKey(record.underlying)) !== input.reviewId)
      throw new Error('Local recovery review not found or replaced. Refresh the review.');
    const pending = this.checkReview(record);
    this.requireEligible(record.review.evidence);
    const evidence = await this.inspect(pending.owner, structuredClone(pending.intent));
    this.checkReview(record);
    this.requireEligible(evidence);
    if (!samePosition(evidence.actualPerp!, record.review.evidence.actualPerp!))
      throw new Error('The exchange perpetual position changed. Refresh the local recovery review.');

    await this.engine.reconcilePortfolio();
    const reconciled = this.checkReview(record, false);
    this.requireEligible(evidence);
    if (!Number.isFinite(reconciled.state.hedge.actualPerp) || !samePosition(reconciled.state.hedge.actualPerp, evidence.actualPerp!))
      throw new Error('The reconciled perpetual position differs from the evidence. Refresh the local recovery review.');

    // Portfolio reads can take time and allow the original ambiguous order to
    // become visible. Check it again immediately before committing local recovery.
    const reconciledFingerprint = fingerprint(reconciled.state);
    const finalEvidence = await this.inspect(reconciled.owner, structuredClone(reconciled.intent));
    const finalContext = this.checkReview(record, false);
    if (fingerprint(finalContext.state) !== reconciledFingerprint)
      throw new Error('The account, intent, or portfolio changed during the final recovery check. Refresh the review.');
    this.requireEligible(finalEvidence);
    if (!samePosition(finalEvidence.actualPerp!, record.review.evidence.actualPerp!)
      || !samePosition(finalEvidence.actualPerp!, evidence.actualPerp!)
      || !samePosition(finalEvidence.actualPerp!, finalContext.state.hedge.actualPerp))
      throw new Error('The exchange perpetual position changed during the final recovery check. Refresh the review.');

    const beforeCommit = structuredClone(this.engine.state);
    try {
      this.store.transaction(() => {
        const state = this.engine.state;
        const archive: HedgeRecoveryArchive = { ...record, outcome: 'abandoned-unknown', archivedAt: Date.now(),
          evidence: structuredClone(finalEvidence), acknowledgeUnknown: true,
          actualPerp: state.hedge.actualPerp, anchor: state.hedge.anchor };
        this.store.set(archiveKey(input.clientOrderId), archive);
        state.intent = null;
        state.hedge.pendingOrder = null;
        state.hedge.enabled = false;
        state.hedge.status = 'paused';
        state.hedge.reason = 'Local unknown intent archived after explicit recovery review; automation remains paused.';
        state.globalPaused = true;
        state.hedgedRevision = -1;
        this.engine.updateDelta();
        this.engine.event('hedge-recovery', 'Local hedge intent archived as abandoned-unknown; no exchange cancellation or rejection was inferred.', {
          reviewId: input.reviewId, clientOrderId: input.clientOrderId, outcome: archive.outcome,
          acknowledgeUnknown: true, evidence: archive.evidence, intent: archive.intent,
        });
        this.engine.save();
        this.store.delete(reviewKey(input.reviewId));
        this.store.delete(activeReviewKey(record.underlying));
      });
    } catch (error) {
      this.engine.state = beforeCommit;
      throw error;
    }
    return this.engine.publicState();
  }
}
