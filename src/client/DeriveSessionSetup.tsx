import { useEffect, useState } from 'react';
import { AlertTriangle, Eye, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { DeriveSessionRequest } from '../../server/derive-session';
import { api, shortAddress } from './api';
import { ensureWalletContext, type EvmWalletProvider } from './evm-wallet';

type Action = (key: string, task: () => Promise<unknown>, message?: string) => Promise<void>;
export function DeriveSessionSetup({ owner, wallet, supported, paused, action, busy, onConfirmed }: {
  owner: string; wallet: string; supported: boolean; paused: boolean; action: Action; busy: string[]; onConfirmed: () => void;
}) {
  const [request, setRequest] = useState<DeriveSessionRequest | null>(null);
  const [hours, setHours] = useState(1);
  const [reviewed, setReviewed] = useState(false);
  const [hash, setHash] = useState('');
  const [loadError, setLoadError] = useState('');
  const loading = busy.some(key => key.startsWith('derive-session-'));
  const unresolved = request && ['wallet-requested', 'pending'].includes(request.phase);
  const sameWallet = request?.preview.wallet.toLowerCase() === wallet.trim().toLowerCase();
  const expired = !!request && Date.now() - request.createdAt > 300_000;
  const load = async () => {
    const result = await api<DeriveSessionRequest | null>('/derive/session/status');
    setRequest(result); if (result?.txHash) setHash(result.txHash); setLoadError('');
    return result;
  };
  useEffect(() => {
    let alive = true;
    api<DeriveSessionRequest | null>('/derive/session/status').then(result => {
      if (alive) { setRequest(result); setHash(result?.txHash || ''); setLoadError(''); }
    }).catch(error => { if (alive) setLoadError(error.message); });
    return () => { alive = false; };
  }, [owner]);
  useEffect(() => { setReviewed(false); }, [wallet, hours, owner, request?.requestId]);
  const preview = async () => {
    setRequest(await api<DeriveSessionRequest>('/derive/session/prepare', { wallet: wallet.trim(), hours }));
    setReviewed(false); setHash(''); setLoadError('');
  };
  const authorize = async () => {
    if (!request || !sameWallet || !reviewed) throw new Error('Review the selected wallet and broad permissions first');
    const provider = (window as unknown as { ethereum?: EvmWalletProvider }).ethereum;
    if (!provider) throw new Error('Open this dashboard in the browser with your EVM wallet extension');
    await ensureWalletContext(provider, owner, 957, 'Derive owner authorization');
    const started = await api<DeriveSessionRequest>('/derive/session/begin', { requestId: request.requestId });
    setRequest(started);
    let txHash: string;
    try { txHash = await provider.request({ method: 'eth_sendTransaction', params: [started.preview.transaction] }) as string; }
    catch (error) {
      if (Number((error as { code?: unknown })?.code) === 4001) {
        setRequest(await api<DeriveSessionRequest>('/derive/session/rejected', { requestId: started.requestId }));
        throw new Error('Authorization rejected in your wallet. No permission is assumed');
      }
      throw new Error('The wallet result is uncertain. Check its transaction history and enter the hash below. Do not submit another authorization blindly');
    }
    setHash(txHash);
    try { setRequest(await api<DeriveSessionRequest>('/derive/session/transaction', { requestId: started.requestId, txHash })); }
    catch { throw new Error('The wallet returned a transaction hash, but recording it failed. Keep this hash and reconnect it below; do not send another transaction'); }
  };
  const reconcile = async () => {
    if (!request) return;
    if (!request.txHash) setRequest(await api<DeriveSessionRequest>('/derive/session/transaction', { requestId: request.requestId, txHash: hash.trim() }));
    const result = await api<DeriveSessionRequest>('/derive/session/reconcile', { requestId: request.requestId });
    setRequest(result); if (result.phase === 'confirmed') onConfirmed();
  };
  return <div className="derive-session-setup">
    <h4><ShieldCheck size={16} /> Register your owner wallet as a Derive signer</h4>
    <p>For a supported existing smart account, authorize the connected owner wallet on-chain, then sign fresh Derive authentication below. This does not create an account, buy options, or enable delta automation.</p>
    {!supported && <p className="tiny-note">Select Live mode for this explicit authorization flow. It supports Derive v2 mainnet only.</p>}
    {!paused && <p className="tiny-note">Pause automation and reconcile pending orders before changing authorization.</p>}
    <div className="session-controls"><label className="field"><span>Session lifetime · 1–24 hours</span><input type="number" min="1" max="24" step="1" value={hours} disabled={loading || !!unresolved} onChange={e => setHours(Number(e.target.value))} /></label>
      <button className="button" disabled={!supported || !paused || loading || !!unresolved || !/^0x[\da-fA-F]{40}$/.test(wallet.trim())} onClick={() => action('derive-session-preview', preview)}><Eye size={14} />Preview wallet authorization</button>
      <button className="button" disabled={loading} onClick={() => action('derive-session-refresh', load)}><RefreshCw size={14} />Refresh status</button>
    </div>
    {loadError && <p className="tiny-note">{loadError}</p>}
    {request && <div className="session-preview" role="status">
      <div className="session-meta"><strong>{request.phase === 'confirmed' ? 'On-chain confirmed · API authentication still required' : `Authorization ${request.phase.replaceAll('-', ' ')}`}</strong><span>Derive Chain · 957</span></div>
      <dl><div><dt>Account wallet</dt><dd title={request.preview.wallet}>{shortAddress(request.preview.wallet)}</dd></div><div><dt>Owner signer</dt><dd title={request.owner}>{shortAddress(request.owner)}</dd></div><div><dt>Requested expiry</dt><dd>{new Date(request.preview.expirySec * 1000).toLocaleString()}</dd></div><div><dt>Owner ETH balance</dt><dd>{request.preview.gasEstimate.nativeBalanceEth} ETH</dd></div><div><dt>Execution gas estimate</dt><dd>{request.preview.gasEstimate.estimatedCostEth ?? 'Unavailable'} ETH</dd></div></dl>
      <div className="session-permissions"><AlertTriangle size={17} /><div><strong>Broad account permission</strong>{request.preview.warnings.map(warning => <p key={warning}>{warning}</p>)}</div></div>
      {request.preview.gasEstimate.error && <p className="session-error">{request.preview.gasEstimate.error}</p>}
      {request.phase === 'prepared' && <>
        {!sameWallet && <p className="session-error">The selected account wallet changed. Prepare a new preview.</p>}
        {expired && <p className="session-error">This preview expired. Prepare a fresh preview.</p>}
        <label className="session-consent"><input type="checkbox" checked={reviewed} disabled={loading || !sameWallet} onChange={e => setReviewed(e.target.checked)} /><span>I authorize this owner signer’s broad Matching permissions until the displayed expiry and will review the wallet’s final gas fee.</span></label>
        <button className="button primary full" disabled={loading || !reviewed || !sameWallet || expired || !paused || !request.preview.readyToSubmit} onClick={() => action('derive-session-send', authorize)}>{busy.includes('derive-session-send') && <Loader2 size={14} className="spin" />}Authorize signer in wallet</button>
      </>}
      {unresolved && <>
        <p className="tiny-note">Only the exact reviewed transaction can confirm this permission. A pending or lost response blocks duplicate submission.</p>
        <label className="field"><span>Authorization transaction hash</span><input value={hash} disabled={!!request.txHash || loading} onChange={e => setHash(e.target.value)} placeholder="0x… from wallet transaction history" autoComplete="off" /></label>
        <button className="button full" disabled={loading || !/^0x[\da-fA-F]{64}$/.test(hash.trim())} onClick={() => action('derive-session-confirm', reconcile)}><RefreshCw size={14} />Check transaction confirmation</button>
      </>}
      {request.txHash && <p className="tiny-note session-hash">Transaction: <code>{request.txHash}</code></p>}
      {(request.lastError || request.confirmation?.message) && <p className="tiny-note">{request.lastError || request.confirmation?.message}</p>}
      {request.phase === 'confirmed' && <p className="tiny-note">Now use <strong>Sign Derive authentication</strong> below. Venue indexing may take time; an unstructured HTTP 403 still does not establish its cause. Manage or revoke this signer in the official Derive app; local disconnection does not revoke it.</p>}
    </div>}
  </div>;
}
