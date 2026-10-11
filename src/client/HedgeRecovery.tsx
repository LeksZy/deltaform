import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import type { AppState } from '../shared/types';
import type { RecoveryConfirmation, RecoveryReview } from '../shared/hedge-recovery';
import { api, fmt, signed, timestamp } from './api';

type Action = (key: string, task: () => Promise<unknown>, message?: string) => Promise<void>;
type Dialog = ComponentType<{ title: string; children: ReactNode; close: () => void }>;

export function recoveryPaused(state: AppState) {
  return Boolean(state.portfolio?.globalPaused && !state.portfolio.assets.some(asset => asset.enabled) && !state.hedge.enabled);
}

function reviewBlocker(state: AppState, review: RecoveryReview, now: number) {
  if (!recoveryPaused(state)) return 'Use Pause All before recovering a pending order. All hedging must remain paused.';
  if (state.mode !== 'live' || review.underlying !== (state.activeUnderlying || 'SOL') || review.clientOrderId !== state.hedge.pendingOrder) {
    return 'The selected asset or pending order changed. Close this review and check the current record.';
  }
  if (now >= review.expiresAt) return 'Review expired. Check the exchange again before archiving.';
  return '';
}

export function HedgeRecoveryReview({ review, state, now, acknowledged, acknowledge, confirm, recheck, busy, error }: {
  review: RecoveryReview; state: AppState; now: number; acknowledged: boolean;
  acknowledge: (value: boolean) => void; confirm: () => void; recheck: () => void; busy: boolean; error: string;
}) {
  const evidence = review.evidence;
  const blocker = reviewBlocker(state, review, now);
  const canArchive = evidence.eligible && !blocker && acknowledged && !busy && !error;
  return <>
    <div className="notice quiet"><div><strong>No order will be sent</strong><span>Only the local unresolved record will be archived. All hedging remains paused.</span></div></div>
    <div className="stat-pairs">
      <div><span>Underlying</span><strong>{review.underlying}</strong></div>
      <div><span>Client order ID (cloid)</span><strong style={{ overflowWrap: 'anywhere', maxWidth: '70%' }}>{review.clientOrderId}</strong></div>
      <div><span>Intent created</span><strong>{new Date(review.intentCreatedAt).toLocaleString()}</strong></div>
      <div><span>Original signed quantity</span><strong>{signed(review.quantity, 8)} {review.underlying}</strong></div>
      <div><span>Exchange checked</span><strong>{timestamp(evidence.checkedAt)}</strong></div>
      <div><span>Order status</span><strong>{evidence.orderStatus}</strong></div>
      <div><span>Open orders · account-wide</span><strong>{fmt(evidence.openOrderCount, 0)}</strong></div>
      <div><span>Matching historical orders</span><strong>{fmt(evidence.matchingHistoricalOrderCount, 0)}{evidence.historicalOrdersTruncated ? ' · history truncated' : ''}</strong></div>
      <div><span>Fills since intent · {review.underlying}</span><strong>{fmt(evidence.fillsSinceIntentCount, 0)}{evidence.fillsComplete ? ' · complete window' : ' · incomplete window'}</strong></div>
      <div><span>Actual perpetual position</span><strong>{evidence.actualPerp === null ? 'Unavailable' : `${signed(evidence.actualPerp, 8)} ${review.underlying}`}</strong></div>
      <div><span>Review expires</span><strong>{timestamp(review.expiresAt)} · {now >= review.expiresAt ? 'Expired' : `${Math.max(0, Math.ceil((review.expiresAt - now) / 1000))}s left`}</strong></div>
    </div>
    <p className="panel-description">{evidence.observation}</p>
    <div className="notice amber-notice"><AlertTriangle size={16}/><div><strong>The order outcome remains unknown</strong><span>Unknown status does not prove the order was never accepted by Hyperliquid. Archiving does not cancel an exchange order or erase its history.</span>{review.warning && <span>{review.warning}</span>}</div></div>
    {evidence.blockers.length > 0 && <div className="notice danger" role="alert"><div><strong>Record cannot be archived</strong>{evidence.blockers.map((reason, index) => <span key={index}>{reason}</span>)}</div></div>}
    {!evidence.eligible && evidence.blockers.length === 0 && <p className="amber">The exchange evidence does not permit archiving this record.</p>}
    {blocker && <p className="amber" role="status">{blocker}</p>}
    {error && <div className="notice danger" role="alert"><span>{error}</span></div>}
    {evidence.eligible && <label className="session-consent"><input type="checkbox" checked={acknowledged} disabled={busy || Boolean(blocker) || Boolean(error)} onChange={event => acknowledge(event.target.checked)}/><span>I acknowledge the order outcome is unknown and want to archive only this local record.</span></label>}
    <div className="modal-actions">
      <button type="button" className="button" disabled={busy || !recoveryPaused(state)} onClick={recheck}><RefreshCw size={13}/>Check exchange again</button>
      {evidence.eligible && <button type="button" className="button danger-outline" disabled={!canArchive} onClick={confirm}>{busy && <Loader2 size={14} className="spin"/>}Archive unresolved record</button>}
    </div>
  </>;
}

export function HedgeRecovery({ state, action, busy, Dialog }: { state: AppState; action: Action; busy: string[]; Dialog: Dialog }) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<RecoveryReview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const inFlight = useRef(false);
  const active = useRef(true);
  const identity = `${state.mode}:${state.activeUnderlying || 'SOL'}:${state.hedge.pendingOrder || ''}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setOpen(false); setReview(null); setAcknowledged(false); setError(''); }, [identity]);
  useEffect(() => {
    if (!open || !review) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, review]);
  const close = useCallback(() => { if (!inFlight.current) setOpen(false); }, []);
  if (state.mode !== 'live' || !state.hedge.pendingOrder) return null;
  const paused = recoveryPaused(state);
  const working = busy.length > 0;
  const preview = async () => {
    if (!paused || working || inFlight.current) return;
    inFlight.current = true;
    setOpen(true); setError(''); setReview(null); setAcknowledged(false);
    try {
      await action('hedge-recovery-preview', async () => {
        try {
          const next = await api<RecoveryReview>('/hedge/recovery/preview', {});
          if (active.current && currentIdentity.current === identity) { setReview(next); setNow(Date.now()); }
        } catch (cause) {
          if (active.current && currentIdentity.current === identity) setError((cause as Error).message);
          throw cause;
        }
      });
    } finally { inFlight.current = false; }
  };
  const confirm = async () => {
    if (!review || !acknowledged || !review.evidence.eligible || reviewBlocker(state, review, Date.now()) || error || working || inFlight.current) return;
    inFlight.current = true;
    try {
      await action('hedge-recovery-confirm', async () => {
        try {
          const body: RecoveryConfirmation = { reviewId: review.id, clientOrderId: review.clientOrderId, acknowledgeUnknown: true };
          await api('/hedge/recovery/confirm', body);
          if (active.current) { setOpen(false); setReview(null); setAcknowledged(false); }
        } catch (cause) {
          if (active.current && currentIdentity.current === identity) { setError((cause as Error).message); setAcknowledged(false); }
          throw cause;
        }
      }, 'Record archived. All hedging remains paused.');
    } finally { inFlight.current = false; }
  };
  return <>
    <button type="button" className="button" disabled={!paused || working} title={paused ? 'Review exchange evidence for this unresolved record' : 'Use Pause All first; every asset must be paused'} onClick={preview}>Recover pending order</button>
    {open && <Dialog title="Recover pending order" close={close}>
      {review ? <HedgeRecoveryReview review={review} state={state} now={now} acknowledged={acknowledged} acknowledge={setAcknowledged} confirm={confirm} recheck={preview} busy={working} error={error}/> : <>
        <p className="panel-description">No order will be sent. Checking the pending record and current Hyperliquid evidence.</p>
        {error ? <><div className="notice danger" role="alert"><span>{error}</span></div><button type="button" className="button" disabled={working || !paused} onClick={preview}>Check exchange again</button></> : <p role="status"><Loader2 size={14} className="spin"/> Checking exchange…</p>}
      </>}
    </Dialog>}
  </>;
}
