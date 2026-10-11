import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity, ArrowDownUp, ArrowRight, ArrowUpRight, Check, CheckCircle2, ChevronDown, CircleHelp,
  Download, ExternalLink, Eye, FlaskConical, Layers3, LayoutDashboard, Link2, Loader2, LockKeyhole,
  Pause, Play, Plus, RefreshCw, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Square,
  Terminal, TrendingUp, Wallet, Wifi, WifiOff, X, AlertTriangle, BookOpen, BarChart3,
} from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { AppState, Bin, FitSettings, Greeks, OptionExecutionSettings, PayoffPoint, Position, RiskSettings } from '../shared/types';
import { optionExecutionPreview, type OptionExecutionPreview } from '../shared/option-execution';
import { payoffPoints } from '../quant/fit';
import { api, setApiUnderlying, expiryLabel, fmt, shortAddress, signed, timestamp, usd } from './api';
import { assetFitPayload, gammaTolerance, gammaToleranceCash, gammaToleranceFromCash } from './asset-settings';
import { marginHeadroom as calculateMarginHeadroom } from './margin-headroom';
import { connectSolanaWallet, discoverSolanaWallets, watchSolanaWallets, type SolanaWalletChoice } from './solana-wallet';
import { PortfolioRisk, ModelSettingsPanel, WatchOnlyRisk } from './TradingRisk';
import { MultiAssetOverview, PortfolioLimitsPanel, assetKeys, assetLabel } from './MultiAssetOverview';
import { riskInputs, type ModelSettings } from './portfolio-risk';
import { displayGreeks, greekDigits, greekConvention, greekHeaders, type GreekDisplay } from './cash-greeks';
import { signTypedDataBatch, type EvmWalletProvider } from './evm-wallet';
import { HedgeRecovery } from './HedgeRecovery';

type Tab = 'overview' | 'settings';
type WalletVenue = 'meteora' | 'hyperliquid';
type Action = (key: string, task: () => Promise<unknown>, message?: string) => Promise<void>;
type Scenario = { points: { price: number; lpModel: number; optionsValue: number; totalValue: number; delta: number; gamma: number }[]; modelAtSpot?: { lp: Greeks & { value: number }; options: Greeks & { price: number } }; comparisons: { name: string; path?: string; strategy?: string; finalPnl: number; maxDrawdown: number; costs: number; marginBreached?: boolean; returnOnCapital?: number; series?: { time: number; price: number; pnl: number }[] }[]; notes: string[] };
const navigation: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: 'overview', label: 'Risk Overview', icon: LayoutDashboard },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];
const chartColors = { theoretical: '#64dcc7', fitted: '#a891f5', il: '#ec997d', residual: '#d6d98d', lp: '#64dcc7', hold: '#8f9faf', netPnl: '#80b5ff' };
const curveNames: Record<string, string> = { theoretical: 'Theoretical IL hedge', fitted: 'Bybit option payoff', il: 'Signed IL', residual: 'IL + option payoff', lp: 'Fee-free LP value', hold: 'Original HODL', netPnl: 'Net terminal P&L', lpModel: 'Modeled LP value', optionsValue: 'Options value', totalValue: 'Combined model value' };

function Badge({ children, color = 'neutral', dot = false }: { children: ReactNode; color?: string; dot?: boolean }) {
  return <span className={`badge badge-${color}`}>{dot && <i />}{children}</span>;
}
function Btn({ children, onClick, disabled, busy = false, kind = '', title, className = '', type = 'button' }: { children: ReactNode; onClick?: () => void; disabled?: boolean; busy?: boolean; kind?: string; title?: string; className?: string; type?: 'button' | 'submit' }) {
  return <button type={type} className={`button ${kind} ${className}`} disabled={disabled || busy} onClick={onClick} title={title}>{busy && <Loader2 size={14} className="spin" />}{children}</button>;
}
function SectionHead({ eyebrow, title, aside }: { eyebrow?: string; title: string; aside?: ReactNode }) {
  return <div className="section-head"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div>{aside}</div>;
}
function Empty({ title, children, icon: Icon = Layers3 }: { title: string; children?: ReactNode; icon?: typeof Layers3 }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={23} /></div><h3>{title}</h3><p>{children}</p></div>;
}
function NumberField({ label, value, onChange, suffix, min, step = 'any', help, disabled = false }: { label: string; value: number; onChange: (n: number) => void; suffix?: string; min?: number; step?: number | 'any'; help?: string; disabled?: boolean }) {
  return <label className="field"><span>{label}</span><div className="input-wrap"><input type="number" value={Number.isFinite(value) ? value : ''} min={min} step={step} disabled={disabled} onChange={e => onChange(Number(e.target.value))} />{suffix && <span>{suffix}</span>}</div>{help && <small>{help}</small>}</label>;
}
function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const items = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,a[href],textarea');
        if (!items?.length) return;
        if (e.shiftKey && document.activeElement === items[0]) { items[items.length - 1].focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === items[items.length - 1]) { items[0].focus(); e.preventDefault(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); previous?.focus(); };
  }, [close]);
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && close()}><div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><X size={19} /></button></div>{children}</div></div>;
}

export function terminalPoints(positions: Position[], state: AppState): PayoffPoint[] {
  // A book can contain no selected Meteora liquidity (including immediately
  // after switching assets). The terminal IL plot needs a position benchmark.
  if (!positions.length) return [];
  if (state.activeUnderlying?.startsWith('unmapped:')) return [];
  if (state.fit) return state.fit.points;
  const expiry = state.market.instruments.filter(i => i.expiry > Date.now()).map(i => i.expiry).sort((a, b) => a - b)[0] || Date.now();
  return payoffPoints(positions, state.holdings, [], state.market.referencePrice, expiry);
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [assetView, setAssetView] = useState<'positions' | 'payoff' | 'bins' | 'options'>('positions');
  const [settingsSection, setSettingsSection] = useState('connections');
  const openSettings = (section = 'connections') => { setSettingsSection(section); setTab('settings'); };
  useEffect(() => { if (tab === 'settings') document.getElementById(`settings-${settingsSection}`)?.scrollIntoView({ block: 'start' }); }, [tab, settingsSection]);
  useEffect(() => { setAssetView('positions'); }, [state?.activeUnderlying]);
  const [busy, setBusy] = useState<string[]>([]);
  const [connectionError, setConnectionError] = useState('');
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [walletsOpen, setWalletsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [hypotheticalOpen, setHypotheticalOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [lastPoll, setLastPoll] = useState(0);
  const [fitSettings, setFitSettings] = useState<FitSettings>({ expiry: 0, coverage: 1, budget: 2000, maxLegs: 8, objective: 'payoff', maxUndercoverage: null });
  const [model, setModel] = useState<ModelSettings>({ expiry: 0, ivMode: 'market', ivPercent: 70, daysAhead: 0 });
  const [greekDisplay, setGreekDisplay] = useState<GreekDisplay>('cash');
  const [includeProposal, setIncludeProposal] = useState(false);
  const preferencesMode = useRef<string | null>(null);
  useEffect(() => { setApiUnderlying(state?.activeUnderlying || (state ? 'SOL' : null)); }, [state?.activeUnderlying, Boolean(state)]);
  useEffect(() => { if (!state?.fit) setIncludeProposal(false); }, [state?.fit]);
  useEffect(() => {
    if (!state) return;
    const preferenceKey = `${state.mode}:${state.activeUnderlying || 'SOL'}`;
    if (preferencesMode.current === preferenceKey) return;
    preferencesMode.current = preferenceKey;
    let saved: { fit?: Partial<FitSettings>; model?: Partial<ModelSettings>; greekDisplay?: GreekDisplay } = {};
    try { saved = JSON.parse(localStorage.getItem(`deltaform:view:${preferenceKey}`) || (state.activeUnderlying === 'SOL' ? localStorage.getItem(`deltaform:view:${state.mode}`) : null) || '{}'); } catch { /* Use defaults for unavailable local preferences. */ }
    const book = state.books?.[state.activeUnderlying || 'SOL'];
    setFitSettings({ expiry: 0, coverage: 1, budget: 2000, maxLegs: 8, objective: 'payoff', maxUndercoverage: null, ...saved?.fit, ...book?.fitSettings });
    setModel({ expiry: 0, ivMode: 'market', ivPercent: 70, daysAhead: 0, ...saved?.model, ...book?.modelSettings });
    setGreekDisplay(saved?.greekDisplay === 'raw' ? 'raw' : 'cash');
    setIncludeProposal(false);
  }, [state?.mode, state?.activeUnderlying]);
  useEffect(() => {
    if (state && preferencesMode.current === `${state.mode}:${state.activeUnderlying || 'SOL'}`) {
      try { localStorage.setItem(`deltaform:view:${preferencesMode.current}`, JSON.stringify({ fit: fitSettings, model, greekDisplay })); } catch { /* Preferences remain in memory. */ }
    }
  }, [fitSettings, model, greekDisplay]);
  useEffect(() => {
    const expiry = state?.market.instruments.filter(i => i.expiry > Date.now()).map(i => i.expiry).sort((a,b) => a-b)[0];
    if (!fitSettings.expiry && expiry) setFitSettings(s => s.expiry ? s : ({ ...s, expiry }));
  }, [state?.market.instruments, fitSettings.expiry]);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try { const next = await api<AppState>('/state'); if (mounted.current) { setState(next); setConnectionError(''); setLastPoll(Date.now()); } }
    catch (e) { if (mounted.current) setConnectionError((e as Error).message); }
  }, []);
  useEffect(() => { mounted.current = true; void refresh(); const timer = window.setInterval(refresh, 2000); return () => { mounted.current = false; window.clearInterval(timer); }; }, [refresh]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), toast.error ? 13000 : 5500); return () => window.clearTimeout(timer); }, [toast]);
  const action: Action = useCallback(async (key, task, message) => {
    setBusy(keys => [...keys, key]);
    try { await task(); await refresh(); if (message) setToast({ message, error: false }); }
    catch (e) { setToast({ message: (e as Error).message, error: true }); await refresh(); }
    finally { setBusy(keys => keys.filter(k => k !== key)); }
  }, [refresh]);
  const selected = useMemo(() => state?.positions.filter(p => state.selectedIds.includes(p.id)) || [], [state]);
  const points = useMemo(() => state ? terminalPoints(selected, includeProposal ? state : { ...state, fit: null }) : [], [state, selected, includeProposal]);
  const connectedCount = state ? [state.accounts.meteora, state.accounts.bybit, state.accounts.hyperliquid].filter(Boolean).length : 0;
  const marketStale = state ? Date.now() - state.market.timestamp > state.hedge.settings.maxDataAgeMs : false;
  const underlying = state?.activeUnderlying || 'SOL';
  const activeOverview = state?.portfolio?.assets.find(asset => asset.underlying === underlying);
  const selectionBusy = busy.length > 0;
  const selectAsset = (asset: string) => action('asset-select', () => api('/assets/select', { underlying: asset }));

  const quoteReady = !underlying.startsWith('unmapped:') && activeOverview?.supportStatus === 'ready' && !!state?.selectedIds.length && !!state.market.instruments.some(i => i.underlying === underlying && i.expiry === fitSettings.expiry && i.expiry > Date.now());
  const quote = () => action('quote', async () => { const payload = assetFitPayload(fitSettings, model, state!.market.referencePrice); await api('/quote', payload); setFitSettings(payload); setAssetView('options'); }, 'Bybit hedge quoted. Review proposed legs before purchasing.');
  const saveAssetSettings = () => action('asset-settings', async () => {
    const payload = state!.market.referencePrice > 0 || fitSettings.gamma || fitSettings.objective !== 'gamma'
      ? assetFitPayload(fitSettings, model, state!.market.referencePrice) : fitSettings;
    await api('/assets/settings', { fitSettings: payload, modelSettings: model });
    setFitSettings(payload);
  }, `${underlying} options and model settings saved`);
  return <div className="app-shell trader-terminal">
    <div className="main-shell">
      <header className="topbar"><a className="terminal-brand" href="#" onClick={e => { e.preventDefault(); setTab('overview'); }}>deltaform<span>.</span></a>
        <nav className="terminal-tabs" aria-label="Main navigation">{navigation.map(({id,label,icon:Icon}) => <button key={id} aria-current={tab === id ? 'page' : undefined} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={16}/>{label}</button>)}</nav>
        <span className="terminal-caption">Meteora / Bybit / Hyperliquid</span>
      </header><main>
        {!state ? <div className="loading-page"><h2>Loading strategy</h2><p>{connectionError || 'Positions and venue data…'}</p><Btn onClick={refresh}>Refresh</Btn></div> : <>
          {connectionError && <div className="notice danger"><WifiOff size={17}/><span>{connectionError}. Last update {timestamp(lastPoll)}.</span><Btn onClick={refresh}>Retry</Btn></div>}
          {marketStale && !connectionError && <div className="notice amber-notice"><AlertTriangle size={16}/><span>Stale market snapshot · {timestamp(state.market.timestamp)}</span><Btn busy={busy.includes('refresh')} onClick={() => action('refresh', () => api('/markets/refresh', {}))}>Refresh</Btn></div>}
          <AccountStrip state={state} connectionError={connectionError} lastPoll={lastPoll} action={action} busy={busy} settings={() => openSettings('connections')}/>
          {tab === 'overview' ? <>
            <MultiAssetOverview state={state} select={selectAsset} busy={selectionBusy} scenario={shock => action('portfolio-scenario', () => api('/portfolio/scenario', shock))}/>
            <div className="selected-asset-heading"><div><h2>{assetLabel(state, underlying)}</h2><span>{selected.length} LP · {state.holdings.length} filled option legs · Hyperliquid perp</span></div><button className="text-button" onClick={() => openSettings('positions')}>Position selection <Settings2 size={13}/></button></div>
            <div className="market-strip"><label className="active-asset-picker"><span className="sr-only">Selected underlying</span><select aria-label="Selected underlying" value={underlying} disabled={selectionBusy} onChange={e => selectAsset(e.target.value)}>{assetKeys(state).map(asset => <option key={asset} value={asset}>{assetLabel(state, asset)} / stable</option>)}</select></label><strong className="market-price">{usd(state.market.referencePrice, state.market.referencePrice < 1 ? 4 : 2)}</strong><span>Pool <b>{usd(state.market.poolPrice, state.market.poolPrice < 1 ? 4 : 2)}</b></span><span>Bybit <b>{usd(state.market.optionIndex, state.market.optionIndex < 1 ? 4 : 2)}</b></span><span>Perp <b>{usd(state.market.perpMark, state.market.perpMark < 1 ? 4 : 2)}</b></span><Badge color={state.market.source === 'fixture' ? 'amber' : 'green'}>{state.market.source === 'fixture' ? 'FIXTURES' : 'LIVE FEED'}</Badge><details className="feed-details"><summary>Venue status</summary>{Object.entries(state.market.status).map(([venue,status]) => <p key={venue}><b>{venue}</b> {status}</p>)}</details><span className="market-updated">{timestamp(state.market.timestamp)}</span><Btn title="Refresh venue markets" busy={busy.includes('refresh')} onClick={() => action('refresh', () => api('/markets/refresh', {}))}><RefreshCw size={14}/></Btn></div>
            {activeOverview && activeOverview.supportStatus !== 'ready' && <div className="notice amber-notice"><AlertTriangle size={16}/><span>{activeOverview.supportStatus}: {activeOverview.supportReasons.join(' · ') || activeOverview.reason}</span></div>}
            <ExpiringProtection state={state} action={action} busy={busy} onReview={() => setAssetView('positions')}/>
            <section id="options-execution" className="execution-toolbar"><div className="asset-view-controls" role="group" aria-label="Selected asset detail">{(['positions','payoff','bins','options'] as const).map(view => <button key={view} aria-pressed={assetView === view} className={assetView === view ? 'active' : ''} onClick={() => setAssetView(view)}>{({positions:'Positions & risk',payoff:'Payoff',bins:'LP bins',options:'Proposed options'})[view]}{view === 'options' && state.fit ? ` (${state.fit.legs.length})` : ''}</button>)}</div><div className="button-row"><Btn title="Options fit settings" onClick={() => openSettings('options')}>Fit settings</Btn><Btn kind="primary" disabled={!quoteReady} busy={busy.includes('quote')} onClick={quote}>Quote hedge</Btn><Btn busy={busy.includes('reconcile-options')} onClick={() => action('reconcile-options', () => api('/quote/reconcile', {}), 'Option positions reconciled')}>Reconcile orders</Btn></div></section>
            <div className={`asset-workspace ${underlying.startsWith('unmapped:') ? 'watch-only-workspace' : ''}`}><div className="asset-detail" aria-label={`${assetLabel(state, underlying)} details`}>
              {assetView === 'positions' && (underlying.startsWith('unmapped:') ? <WatchOnlyRisk state={state} positions={selected}/> : <PortfolioRisk state={state} positions={selected} model={model} fallbackExpiry={fitSettings.expiry} greekDisplay={greekDisplay} setGreekDisplay={setGreekDisplay}/>)}
              {assetView === 'payoff' && (underlying.startsWith('unmapped:') ? <div className="panel"><Empty title="Model unavailable">A verified underlying mapping is required. Current inventory remains in Positions & risk.</Empty></div> : <><div className="plot-selection"><label><input type="checkbox" checked={includeProposal} disabled={!state.fit} onChange={e => setIncludeProposal(e.target.checked)}/>Include proposed hedge</label><span>{includeProposal && state.fit ? 'Preview · not filled' : 'Actual positions only'}</span></div><PayoffPanel key={underlying} state={includeProposal ? state : { ...state, fit: null }} points={points} positions={selected} modelSettings={model} modelExpiry={fitSettings.expiry} includeProposal={includeProposal} greekDisplay={greekDisplay}/></>)}
              {assetView === 'bins' && <BinDistribution underlying={underlying} positions={selected} spot={state.market.referencePrice}/>}
              {assetView === 'options' && <><div className="options-configuration-summary">{fitSettings.expiry ? expiryLabel(fitSettings.expiry) : 'No listed expiry'} · {fmt(fitSettings.coverage * 100,0)}% coverage · {usd(fitSettings.budget)} budget · max {fitSettings.maxLegs} legs · {fitSettings.objective === 'gamma' ? 'Gamma fit' : fitSettings.objective === 'superhedge' ? 'Superhedge' : 'Terminal IL fit'}</div><OptionLegs key={underlying} state={state} action={action} busy={busy}/></>}
            </div>{!underlying.startsWith('unmapped:') && <HedgePanel key={underlying} state={state} action={action} busy={busy} compact onExpand={() => openSettings('hedge')}/>}</div>
            <RecentExecutions state={state}/>
            <details className="terminal-details"><summary>Capital, P&L attribution, funding & margin</summary><div className="two-column"><AccountingPanel state={state} positions={selected}/><RiskBoundary state={state} positions={selected}/></div>{state.mode === 'live' && <CapitalTrackingPanel state={state} action={action} busy={busy}/>}</details>
            <details className="terminal-details"><summary>Account-wide orders, fills & execution history</summary><ActivityPanel state={state}/></details>
          </> : <>
            <div className="market-strip"><label className="active-asset-picker"><span className="sr-only">Selected underlying</span><select aria-label="Selected underlying" value={underlying} disabled={selectionBusy} onChange={e => selectAsset(e.target.value)}>{assetKeys(state).map(asset => <option key={asset} value={asset}>{assetLabel(state, asset)} / stable</option>)}</select></label><strong className="market-price">{usd(state.market.referencePrice, state.market.referencePrice < 1 ? 4 : 2)}</strong><span>Pool <b>{usd(state.market.poolPrice, state.market.poolPrice < 1 ? 4 : 2)}</b></span><span>Bybit <b>{usd(state.market.optionIndex, state.market.optionIndex < 1 ? 4 : 2)}</b></span><span>Perp <b>{usd(state.market.perpMark, state.market.perpMark < 1 ? 4 : 2)}</b></span><Badge color={state.market.source === 'fixture' ? 'amber' : 'green'}>{state.market.source === 'fixture' ? 'FIXTURES' : 'LIVE FEED'}</Badge><details className="feed-details"><summary>Venue status</summary>{Object.entries(state.market.status).map(([venue,status]) => <p key={venue}><b>{venue}</b> {status}</p>)}</details><span className="market-updated">{timestamp(state.market.timestamp)}</span><Btn title="Refresh venue markets" busy={busy.includes('refresh')} onClick={() => action('refresh', () => api('/markets/refresh', {}))}><RefreshCw size={14}/></Btn></div>
            <section id="settings-connections" className="panel settings-access"><SectionHead title="Accounts & execution mode"/><div className="button-row"><div className="mode-toggle" aria-label="Trading mode"><button className={state.mode === 'paper' ? 'selected' : ''} disabled={busy.includes('mode')} onClick={() => action('mode', () => api('/mode', {mode:'paper'}))}>Paper</button><button className={state.mode === 'live' ? 'selected live' : ''} disabled={busy.includes('mode')} onClick={() => action('mode', () => api('/mode', {mode:'live'}))}>Live</button></div><Btn onClick={() => setWalletsOpen(true)}><Wallet size={14}/>Manage venue accounts · {connectedCount}/3</Btn></div><div className="risk-context">{(['meteora','bybit','hyperliquid'] as const).map(venue => <span key={venue}>{venue}<b>{state.accounts[venue] ? 'Connected' : 'Disconnected'}</b></span>)}</div><p className="tiny-note">{state.capabilities.message}</p><AgentAuthorization state={state} action={action} busy={busy}/></section>
            {state.mode === 'paper' && <><PaperRibbon state={state} action={action} busy={busy}/><details className="terminal-details"><summary>Paper price scenarios</summary><PaperControls key={underlying} state={state} action={action} busy={busy}/><ScenarioComparison key={`${state.mode}:${underlying}`}/></details></>}
            <div id="settings-positions"><PositionsPanel state={state} selected={selected} action={action} busy={busy} onImport={() => setImportOpen(true)} onHypothetical={() => setHypotheticalOpen(true)}/></div>
            {!underlying.startsWith('unmapped:') && <><div id="settings-options" className="two-column"><QuotePanel state={state} settings={fitSettings} setSettings={setFitSettings}/><ModelSettingsPanel state={state} model={model} setModel={setModel} fallbackExpiry={fitSettings.expiry} onHelp={() => setShowHelp(true)}/></div>
            <div className="asset-settings-save"><span>Editing {underlying} only · saved on the server</span><Btn kind="primary" busy={busy.includes('asset-settings')} onClick={saveAssetSettings}><Check size={14}/>Save {underlying} configuration</Btn></div>
            <div id="settings-hedge"><AutomationSettings key={`${state.mode}:${underlying}`} state={state} action={action} busy={busy}/></div></>}
            <PortfolioLimitsPanel state={state} busy={busy.includes('portfolio-limits')} save={limits => action('portfolio-limits', () => api('/portfolio/limits', limits), 'Account-wide limits saved')}/>
            <details className="terminal-details"><summary>Benchmark, exports & advanced configuration</summary><div className="two-column"><BenchmarkPanel positions={selected} state={state} action={action}/><ExportPanel/></div><Btn onClick={() => setShowHelp(true)}>Model & conventions</Btn></details>
          </>}
          <footer className="main-footer"><span>{connectionError ? 'Service disconnected' : 'Backend connected'}</span><span>USDT equivalent · {assetLabel(state, underlying)} selected · {timestamp(lastPoll)}</span></footer>
        </>}
      </main>
    </div>
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}<span>{toast.message}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={16} /></button></div>}
    {walletsOpen && state && <WalletModal state={state} action={action} busy={busy} close={() => setWalletsOpen(false)} />}
    {importOpen && state && <ImportModal state={state} action={action} busy={busy} close={() => setImportOpen(false)} />}
    {hypotheticalOpen && state && <HypotheticalModal state={state} action={action} busy={busy} close={() => setHypotheticalOpen(false)} />}
    {showHelp && <Modal title="Model & conventions" close={() => setShowHelp(false)} wide><div className="model-content"><Badge color="green">Constant-sum DLMM bins</Badge><h3>Holdings → terminal payoff → priced risk</h3><p>For each fixed bin, p is its human-unit quote/base price and x, y are your withdrawn-equivalent base and quote quantities. With ℓ = px + y:</p><div className="formula">Vₗₚ(S) = Σ ℓᵢ min(S / pᵢ, 1)<br />H(S) = −IL(S) = Σ [xᵢ(S − pᵢ)⁺ + (yᵢ / pᵢ)(pᵢ − S)⁺]</div><p>The positive IL hedge is a portfolio of calls and puts at each bin price. Listed Bybit strikes, depth, lot sizes, and premiums turn exact theoretical weights into an approximate executable hedge.</p><div className="model-grid"><div><h4>Current accounting delta</h4><p>Actual base inventory, filled option delta, and actual perpetual size. A terminal payoff slope is not substituted for current inventory.</p></div><div><h4>Terminal curvature</h4><p>Each bin has a kink weight of x + y/p. This is a distributional second derivative, not ordinary live option gamma.</p></div><div><h4>Model sensitivities</h4><p>Future-payoff values depend on maturity and IV assumptions. Raw inventory has no direct implied-volatility vega.</p></div><div><h4>Scope of the identity</h4><p>Fixed shares and bins, no repositioning, fee-free swaps, and an arbitrage-equilibrated terminal pool. Real fees, delayed arbitrage, rounding, and basis create differences.</p></div></div><p className="muted">A terminal IL hedge restores the original HODL payoff under these assumptions. Hyperliquid automation separately targets dollar-neutral delta or the original HODL exposure. Automatic-hedge P&L depends on the full price path.</p></div></Modal>}
  </div>;
}

export function AccountStrip({ state, connectionError, lastPoll, action, busy, settings }: { state: AppState; connectionError: string; lastPoll: number; action: Action; busy: string[]; settings: () => void }) {
  const margin = calculateMarginHeadroom(state);
  const dataAge = Math.max(0, Math.floor((Date.now() - state.market.timestamp) / 1000));
  const stale = !state.market.timestamp || Date.now() - state.market.timestamp > state.hedge.settings.maxDataAgeMs;
  const pnlReason = state.accounting?.pnlUnavailableReason || (state.accounting?.pnlStartedAt ? `Since ${new Date(state.accounting.pnlStartedAt).toLocaleString()} · recorded flows` : 'Since paper capital baseline');
  return <section className="account-strip" aria-label="Account summary">
    <div className="account-stat"><span>Equity · USDT eq.</span><strong title="All included positions and shared venue cash; collateral counted once">{usd(state.accounting?.equity)}{state.accounting?.valuationComplete === false && <small className="amber"> partial</small>}</strong></div>
    <div className="account-stat"><span>Net P&L <small>{state.accounting?.pnlStale ? 'stored' : ''}</small></span><strong title={pnlReason} className={state.accounting?.pnl == null ? 'muted' : state.accounting.pnl >= 0 ? 'green' : 'red'}>{usd(state.accounting?.pnl)}</strong>{state.accounting?.pnl == null && <details className="account-explanation"><summary>Unavailable</summary><p>{pnlReason}</p></details>}</div>
    <div className="account-stat"><span>HL margin headroom</span><strong title={`${margin.reason} · Application estimate after configured buffer; venue withdrawable margin may differ.`} className={margin.value != null && margin.value < 0 ? 'red' : ''}>{usd(margin.value)}</strong></div>
    <div className="account-stat account-freshness"><span>Selected feed · {state.activeUnderlying || 'SOL'}</span><strong className={connectionError ? 'red' : stale ? 'amber' : ''}>{connectionError ? 'Disconnected' : stale ? 'Stale' : 'Updated'} · {state.market.timestamp ? `${dataAge}s` : '—'}</strong><small title={`Backend poll ${timestamp(lastPoll)}`}>{timestamp(state.market.timestamp)}</small></div>
    <div className="account-venues" aria-label="Venue connections">{(['meteora','bybit','hyperliquid'] as const).map(venue => <button key={venue} onClick={settings} title={`${venue}: ${state.accounts[venue] ? 'Account connected; review execution permissions in Settings' : 'Disconnected'}`}><i className={`status-dot ${state.accounts[venue] ? '' : 'muted-dot'}`}/>{({meteora:'Meteora',bybit:'Bybit',hyperliquid:'Hyperliquid'})[venue]}<span>{state.accounts[venue] ? 'Connected' : 'Disconnected'}</span></button>)}</div>
    <div className="account-controls"><Badge color={state.mode === 'live' ? 'green' : 'amber'}>{state.mode === 'live' ? (state.capabilities.liveExecution ? 'LIVE' : 'LIVE · READ ONLY') : state.paperDataSource === 'live' ? 'PAPER · LIVE FEED' : 'PAPER · FIXTURES'}</Badge><span className="tiny-note">{state.portfolio?.globalPaused ? 'All paused' : `${state.portfolio?.assets.filter(asset => asset.enabled).length ?? Number(state.hedge.enabled)} enabled`}</span><Btn kind="danger-outline" busy={busy.includes('pause-all')} onClick={() => action('pause-all', () => api('/hedge/pause-all', {}), 'All automatic delta hedges paused')}><Pause size={13}/>Pause All</Btn></div>
  </section>;
}

function RecentExecutions({ state }: { state: AppState }) {
  const events = [...state.events].filter(e => /fill|order|execut|reject/.test(e.type)).sort((a,b) => b.timestamp - a.timestamp).slice(0, 4);
  return <section className="panel recent-executions" aria-label="Recent orders and fills"><SectionHead title="Recent orders & fills" aside={<span className="tiny-note">Account-wide · {state.mode === 'paper' ? 'simulated' : 'actual'}</span>}/>{events.length ? <div className="table-scroll"><table><thead><tr><th>Time</th><th>Event</th><th>Details</th></tr></thead><tbody>{events.map(e => <tr key={e.id}><td className="number" title={new Date(e.timestamp).toLocaleString()}>{timestamp(e.timestamp)}</td><td className={/reject|fail|error/.test(e.type) ? 'red' : ''}>{e.type.replaceAll('_',' ').replaceAll('.',' / ')}</td><td>{e.message}</td></tr>)}</tbody></table></div> : <p className="tiny-note">No orders or fills recorded. Full audit history below.</p>}</section>;
}

function ExpiringProtection({ state, action, busy, onReview }: { state: AppState; action: Action; busy: string[]; onReview: () => void }) {
  const soon = state.holdings.filter(h => Math.abs(h.quantity) > 1e-9 && h.instrument.expiry <= Date.now() + 7 * 86400000);
  if (!soon.length) return null;
  const nearest = Math.min(...soon.map(h => h.instrument.expiry));
  const expired = nearest <= Date.now();
  return <div className="notice amber-notice expiry-notice"><AlertTriangle size={15}/><div><strong>{expired ? 'Options expired' : 'Expiry within 7d'} · {soon.length} legs</strong><span>{new Date(nearest).toLocaleString()} · no automatic roll.{expired && state.mode === 'live' ? ' Reconcile settlement before sizing.' : ''}</span></div><div className="button-row"><Btn onClick={onReview}>Review protection</Btn>{expired && state.mode === 'live' && <Btn busy={busy.includes('reconcile-options')} onClick={() => action('reconcile-options', () => api('/quote/reconcile', {}), 'Bybit positions and settlement reconciled')}>Reconcile settlement</Btn>}</div></div>;
}

export function PayoffPanel({ state, points, positions, modelSettings, modelExpiry, includeProposal = false, greekDisplay }: { state: AppState; points: PayoffPoint[]; positions: Position[]; modelSettings: ModelSettings; modelExpiry: number; includeProposal?: boolean; greekDisplay: GreekDisplay }) {
  const [view, setView] = useState<'terminal' | 'model'>('terminal');
  const [terminalCurves, setTerminalCurves] = useState(['theoretical', 'fitted', 'il', 'residual']);
  const [modelCurves, setModelCurves] = useState(['lpModel', 'optionsValue', 'totalValue']);
  const underlying = state.activeUnderlying || 'SOL';
  const modelInput = riskInputs(state, modelSettings, modelExpiry);
  const days = modelSettings.daysAhead, iv = modelInput.iv == null ? null : modelInput.iv * 100;
  const [scenario, setScenario] = useState<Scenario | null>(null), [scenarioError, setScenarioError] = useState('');
  const [showMarkers, setShowMarkers] = useState(false);
  const exposedExpiries = [...state.holdings.filter(h => Math.abs(h.quantity) > 1e-9).map(h => h.instrument.expiry), ...(state.fit?.legs.filter(l => l.quantity > 0).map(l => l.instrument.expiry) || [])];
  const nearestExpiry = Math.min(modelInput.expiry || Infinity, ...exposedExpiries);
  const maxProjectionDays = Math.floor(Math.max(0, Math.min(90, (nearestExpiry - Date.now()) / 86400000 - 1 / 1440)) * 10) / 10;
  const effectiveDays = Math.min(days, maxProjectionDays);
  const modelFingerprint = JSON.stringify({ mode: state.mode, source: state.market.source, feed: state.paperDataSource, spot: state.market.referencePrice,
    positions: positions.map(p => ({ id: p.id, benchmarkAt: p.benchmarkAt, benchmarkX: p.benchmarkX, benchmarkY: p.benchmarkY, bins: p.benchmarkBins ?? p.bins })),
    holdings: state.holdings.map(h => ({ name: h.instrument.name, expiry: h.instrument.expiry, quantity: h.quantity, multiplier: h.instrument.multiplier, source: h.instrument.source })), fit: state.fit?.id });
  useEffect(() => {
    if (view !== 'model') return;
    if (!positions.length) { setScenario(null); setScenarioError(''); return; }
    if (iv == null || !modelInput.expiry || modelInput.expiry <= Date.now()) { setScenario(null); setScenarioError('Select an unexpired horizon and available IV in Settings.'); return; }
    let active = true;
    setScenario(null); setScenarioError('');
    const timer = setTimeout(() => { api<Scenario>(`/scenario?days=${effectiveDays}&iv=${iv / 100}&expiry=${modelInput.expiry}&proposed=${includeProposal}`).then(s => { if (active) { setScenario(s); setScenarioError(''); } }).catch(e => active && setScenarioError(e.message)); }, 220);
    return () => { active = false; clearTimeout(timer); };
  }, [view, effectiveDays, iv, modelFingerprint, modelInput.expiry, includeProposal]);
  const curves = view === 'terminal' ? terminalCurves : modelCurves;
  const availableCurves = view === 'terminal' ? ['theoretical', 'fitted', 'il', 'residual', 'hold', 'lp', 'netPnl'] : ['lpModel', 'optionsValue', 'totalValue'];
  const toggleCurve = (key: string) => { const update = (current: string[]) => current.includes(key) ? current.filter(item => item !== key) : [...current, key]; if (view === 'terminal') setTerminalCurves(update); else setModelCurves(update); };
  const binPrices = [...new Set(positions.flatMap(p => p.bins.map(b => b.price)))];
  const strikes = [...new Set(state.fit?.legs.map(l => l.instrument.strike) || [])];
  const range = binPrices.length ? [Math.min(...binPrices), Math.max(...binPrices)] : [];
  const chartData: Record<string, number>[] = (view === 'model' ? scenario?.points || [] : points).map(point => ({ ...point }));
  return <section className="panel payoff-panel"><SectionHead title={`${underlying} payoff`} aside={<span className="chart-currency">USDT equivalent</span>} /><div className="chart-controls"><div className="segmented small">{([['terminal', 'Terminal payoff'], ['model', 'Pre-expiry risk']] as const).map(([id, label]) => <button className={view === id ? 'active' : ''} key={id} onClick={() => setView(id)}>{label}</button>)}</div><details className="curve-controls"><summary><SlidersHorizontal size={14}/>Curves & markers</summary><div>{availableCurves.map(key => <label key={key}><input type="checkbox" checked={curves.includes(key)} onChange={() => toggleCurve(key)}/>{curveNames[key]}</label>)}<label><input type="checkbox" checked={showMarkers} onChange={() => setShowMarkers(!showMarkers)}/>Bin prices & listed strikes</label></div></details></div>
    {view === 'model' && <div className="risk-context"><span>{fmt(effectiveDays,1)} days ahead</span><span>IV {iv == null ? 'unavailable' : `${fmt(iv,2)}%`}</span><span>Configured in Settings · fixed current perp size</span></div>}
    <div className="chart-caption"><span>{view === 'model' ? 'Model-valued future payoffs · configured IV' : 'At the selected common option expiry'}</span><span>Spot <b>{usd(state.market.referencePrice)}</b></span></div>
    <div className="payoff-chart">{!positions.length ? <Empty title="No Meteora liquidity selected" icon={TrendingUp}>Select a position in Settings to plot its IL and hedge payoff. Filled options and perps remain in the risk table.</Empty> : view === 'model' && scenarioError ? <Empty title="Scenario model unavailable" icon={AlertTriangle}>{scenarioError}</Empty> : view === 'model' && !scenario ? <div className="inline-loading"><Loader2 size={17} className="spin" />Computing pre-expiry scenario…</div> : <ResponsiveContainer width="100%" height="100%"><ComposedChart data={chartData} margin={{ top: 16, right: 12, bottom: 3, left: 1 }}><CartesianGrid stroke="#25313a" strokeDasharray="3 5" vertical={false} /><XAxis type="number" dataKey="price" domain={['dataMin', 'dataMax']} tickFormatter={v => `$${fmt(v, Math.abs(v) < 1 ? 4 : Math.abs(v) < 10 ? 2 : 0)}`} tickLine={false} axisLine={false} minTickGap={28} tick={{ fill: '#748493', fontSize: 11 }} dy={8} /><YAxis width={65} tickFormatter={v => Math.abs(v) >= 1000 ? `${v < 0 ? '−' : ''}$${fmt(Math.abs(v) / 1000, 1)}k` : usd(v, 0)} tickLine={false} axisLine={false} tick={{ fill: '#748493', fontSize: 11 }} /><Tooltip content={<PayoffTooltip underlying={underlying} />} /><ReferenceLine y={0} stroke="#455460" /><ReferenceLine x={state.market.referencePrice} stroke="#71828f" strokeDasharray="4 5" label={{ value: 'SPOT', position: 'insideTopRight', fill: '#99a8b3', fontSize: 9 }} />{range.map((p, i) => <ReferenceLine key={`r${i}`} x={p} stroke="#3e555a" strokeDasharray="2 6" />)}{showMarkers && binPrices.filter((_, i) => binPrices.length < 40 || i % Math.ceil(binPrices.length / 40) === 0).map(p => <ReferenceLine key={`b${p}`} x={p} stroke="#43675e" strokeOpacity={.5} />)}{showMarkers && strikes.map(p => <ReferenceLine key={`s${p}`} x={p} stroke="#a891f5" strokeDasharray="3 5" />)}{curves.map((key, i) => key === 'theoretical' ? <Area key={key} type="linear" dataKey={key} name={curveNames[key]} stroke={chartColors.theoretical} strokeWidth={2} fill={chartColors.theoretical} fillOpacity={0.04} isAnimationActive={false} /> : <Line key={key} type="linear" dataKey={key} name={curveNames[key]} stroke={(chartColors as Record<string, string>)[key] || ['#64dcc7', '#a891f5', '#80b5ff'][i]} strokeWidth={key === 'fitted' || key === 'netPnl' ? 2.3 : 1.6} strokeDasharray={key === 'hold' || key === 'il' ? '5 5' : undefined} dot={false} isAnimationActive={false} />)}</ComposedChart></ResponsiveContainer>}</div>
    <div className="chart-legend">{curves.map((key, i) => <span key={key}><i style={{ background: (chartColors as Record<string, string>)[key] || ['#64dcc7', '#a891f5', '#80b5ff'][i] }} />{curveNames[key]}</span>)}</div><div className="model-greeks-slot">{view === 'model' && scenario?.modelAtSpot && !scenarioError && <ModelGreeks model={scenario.modelAtSpot} days={effectiveDays} iv={iv ?? 0} perpDelta={state.hedge.actualPerp} spot={state.market.referencePrice} greekDisplay={greekDisplay} underlying={underlying} />}</div><div className="chart-bottom-note">{view === 'model' ? 'Smooth model Greeks depend on the chosen IV and horizon. They are not current LP accounting Greeks.' : terminalCurves.includes('netPnl') ? 'Scenario baseline is the original HODL quantities valued at the current price. Excludes path-dependent perp P&L and future fees/funding. Premium is deducted once.' : state.fit ? `Fitted hedge includes existing long options and proposed purchases. Quote ${timestamp(state.fit.createdAt)}.` : 'Filled options only; proposed purchases are excluded.'} Option settlement and stablecoin LP values use 1:1 parity in USD plots; stablecoin basis risk remains.</div>
  </section>;
}
function PayoffTooltip({ active, payload, label, underlying }: { underlying: string; active?: boolean; payload?: readonly { dataKey?: string | number; value?: number | string; color?: string; name?: string }[]; label?: number | string }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip"><strong>{underlying} {usd(Number(label), Number(label) < 1 ? 5 : 2)}</strong>{payload.map((p, i) => <div key={i}><span><i style={{ background: p.color }} />{p.name}</span><b>{usd(Number(p.value))}</b></div>)}</div>;
}

function ModelGreeks({ model, days, iv, perpDelta, spot, greekDisplay, underlying }: { underlying: string; model: NonNullable<Scenario['modelAtSpot']>; days: number; iv: number; perpDelta: number; spot: number; greekDisplay: GreekDisplay }) {
  const rows = [{ label: 'LP future-value model', values: model.lp }, { label: 'LP + options + fixed perp model', values: { delta: model.lp.delta + model.options.delta + perpDelta, gamma: model.lp.gamma + model.options.gamma, vega: model.lp.vega + model.options.vega, theta: model.lp.theta + model.options.theta } }];
  const headers = greekHeaders(underlying, greekDisplay);
  return <div className="model-greeks"><div><strong>Scenario sensitivities at current spot · {greekDisplay === 'cash' ? 'Cash USDT' : 'Raw units'}</strong><span>{fmt(days, 1)} days ahead · {fmt(iv, 0)}% model IV</span></div><div className="table-scroll"><table><thead><tr><th>Model</th>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map(row => {
    const values = displayGreeks(row.values, spot, greekDisplay);
    return <tr key={row.label}><td>{row.label}</td>{(['delta', 'gamma', 'vega', 'theta'] as const).map(key => <td key={key} className="number">{values[key] == null ? '—' : signed(values[key], greekDigits(values[key], greekDisplay))}</td>)}</tr>;
  })}</tbody></table></div><small>{greekConvention(underlying)} LP values use the terminal bin model at the selected maturity and IV. Combined values follow the selected filled/proposed plot view and hold the current perp size fixed; future hedge trades are not simulated.</small></div>;
}

function PositionsPanel({ state, selected, action, busy, onImport, onHypothetical, compact = false, onExpand }: { state: AppState; selected: Position[]; action: Action; busy: string[]; onImport: () => void; onHypothetical: () => void; compact?: boolean; onExpand?: () => void }) {
  const underlying = assetLabel(state, state.activeUnderlying || 'SOL');
  return <section className="panel positions-panel"><SectionHead title={`${underlying} Meteora positions`} eyebrow="LIQUIDITY" aside={compact ? <button className="text-button" onClick={onExpand}>View all <ArrowUpRight size={13} /></button> : <div className="button-row"><Btn onClick={onHypothetical}><Plus size={13} />Hypothetical</Btn><Btn onClick={onImport} kind="primary"><Plus size={14} />Import positions</Btn></div>} />
    {state.positions.length ? <div className="table-scroll"><table><thead><tr><th aria-label="Selected" /><th>Position</th><th>Inventory value</th><th>Price range</th>{!compact && <><th>Inventory</th><th>Fees accrued</th><th>Snapshot</th></>}<th>Source</th></tr></thead><tbody>{state.positions.slice(0, compact ? 3 : undefined).map(p => { const x = p.bins.reduce((s, b) => s + b.x, 0), y = p.bins.reduce((s, b) => s + b.y, 0); const lo = Math.min(...p.bins.map(b => b.price)), hi = Math.max(...p.bins.map(b => b.price)); const inRange = state.market.referencePrice >= lo && state.market.referencePrice <= hi; return <tr key={p.id} className={state.selectedIds.includes(p.id) ? 'selected-row' : ''}><td><input type="checkbox" aria-label={`Select ${p.name}`} checked={state.selectedIds.includes(p.id)} disabled={busy.includes('selection')} onChange={e => action('selection', () => api('/positions/select', { ids: e.target.checked ? [...state.selectedIds, p.id] : state.selectedIds.filter(id => id !== p.id) }))} /></td><td><div className="position-name"><span className="token-icon">◎</span><div><strong>{p.name}</strong><small>{p.bins.length} bins · {shortAddress(p.pool)}</small></div></div></td><td className="number">{usd(x * state.market.referencePrice + y)}<small>{fmt(x * state.market.referencePrice / Math.max(x * state.market.referencePrice + y, 1) * 100, 0)}% {underlying}</small></td><td><span className="number">{usd(lo, lo < 1 ? 5 : 2)} — {usd(hi, hi < 1 ? 5 : 2)}</span><small className={inRange ? 'green' : 'amber'}>{inRange ? 'Within range' : 'Outside range'}</small></td>{!compact && <><td className="number">{fmt(x, 4)} {underlying}<small>{usd(y)} {p.quote}</small></td><td className="number">{usd(p.baseFees * state.market.referencePrice + p.quoteFees)}<small>{fmt(p.baseFees, 5)} {underlying} + {fmt(p.quoteFees)} {p.quote}</small></td><td>{timestamp(p.snapshotAt)}</td></>}<td><Badge color={p.source === 'live' ? 'green' : 'neutral'}>{p.source}</Badge></td></tr>; })}</tbody></table></div> : <Empty title="No LP positions">Import a wallet position or create a hypothetical bin distribution to begin.</Empty>}
    <div className="panel-footer"><span><span className="status-dot" />{selected.length} selected · {underlying} / stable</span>{compact ? <button className="text-button" onClick={onImport}><Plus size={13} />Import position</button> : <span>Prices normalized to quote per {underlying}</span>}</div>
    {!compact && selected.some(p => p.notes.length) && <div className="position-notes">{selected.flatMap(p => p.notes.map((note, i) => <p key={`${p.id}-${i}`}><CircleHelp size={13} />{note}</p>))}</div>}
  </section>;
}

function BinDistribution({ positions, spot, underlying }: { positions: Position[]; spot: number; underlying: string }) {
  const bins = positions.flatMap(p => p.bins).sort((a, b) => a.price - b.price).map(b => ({ ...b, baseValue: b.x * spot, quoteValue: b.y, curvature: b.x + b.y / b.price }));
  const theoreticalBins = positions.flatMap(p => p.benchmarkBins ?? p.bins).sort((a, b) => a.price - b.price).map(b => ({ ...b, curvature: b.x + b.y / b.price }));
  return <section className="panel bins-panel"><SectionHead title={`${underlying} bin inventory`} eyebrow="ACTUAL INVENTORY / BENCHMARK WEIGHTS" aside={<Badge>{bins.length} bins</Badge>} /><div className="two-column bins-content"><div><div className="bin-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={bins} margin={{ top: 10, right: 8, bottom: 10, left: 0 }}><CartesianGrid stroke="#25313a" vertical={false} strokeDasharray="3 5" /><XAxis dataKey="price" tickFormatter={v => usd(v, 0)} tick={{ fill: '#82929d', fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis tickFormatter={v => usd(v, 0)} width={60} tick={{ fill: '#82929d', fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: '#151e27', border: '1px solid #35414b', borderRadius: 8 }} formatter={v => usd(Number(v))} labelFormatter={v => `Bin price ${usd(Number(v))}`} /><Bar dataKey="baseValue" name={`${underlying} inventory value`} stackId="a" fill="#64dcc7" /><Bar dataKey="quoteValue" name="Stable quote inventory" stackId="a" fill="#a891f5" radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer></div><div className="chart-legend"><span><i style={{ background: '#64dcc7' }} />{underlying} at spot</span><span><i style={{ background: '#a891f5' }} />Stable quote</span></div></div><div className="bin-table table-scroll"><table><thead><tr><th>Bin / strike</th><th>Call weight</th><th>Put weight</th><th>Kink weight</th></tr></thead><tbody>{theoreticalBins.map((b, i) => <tr key={`${b.id}-${i}`}><td className="number">{usd(b.price, 4)}<small>#{b.id}</small></td><td className="number">{fmt(b.x, 5)}</td><td className="number">{fmt(b.y / b.price, 5)}</td><td className="number">{fmt(b.curvature, 5)}</td></tr>)}</tbody></table></div></div><div className="chart-bottom-note">The chart shows current inventory. Option weights use preserved benchmark bins in {underlying} payoff units. Kink weights are terminal curvature masses, not smooth live gamma; venue quantities use the verified multiplier.</div></section>;
}

function BenchmarkPanel({ positions, state, action }: { positions: Position[]; state: AppState; action: Action }) {
  const underlying = state.activeUnderlying || 'SOL';
  const [confirm, setConfirm] = useState(false);
  const x = positions.reduce((s, p) => s + p.benchmarkX, 0), y = positions.reduce((s, p) => s + p.benchmarkY, 0);
  return <section className="panel"><SectionHead title="Original HODL benchmark" eyebrow="PRESERVED SNAPSHOT" /><div className="stat-pairs"><div><span>Initial {underlying} inventory</span><strong>{fmt(x, 5)} {underlying}</strong></div><div><span>Initial quote inventory · USD parity</span><strong>{usd(y)}</strong></div><div><span>HODL marked at current price</span><strong>{usd(x * state.market.referencePrice + y)}</strong></div></div><div className="benchmark-lots">{positions.map(p => <div key={p.id}><strong>{p.name}</strong><div><span>Benchmark established</span><span>{p.benchmarkAt ? new Date(p.benchmarkAt).toLocaleString() : '—'}</span></div><div><span>Benchmark {underlying} price</span><span>{usd(p.benchmarkPrice)}</span></div></div>)}</div><p className="panel-description">The benchmark remains fixed across market refreshes. Rebase explicitly starts a new comparison from the current withdrawn-equivalent inventory.</p>{confirm ? <div className="inline-confirm"><span>Replace the selected original benchmarks?</span><Btn kind="primary" onClick={() => action('rebase', async () => { await api('/positions/rebase', {}); setConfirm(false); }, 'Benchmark rebased to current inventory')}>Rebase now</Btn><Btn onClick={() => setConfirm(false)}>Cancel</Btn></div> : <Btn onClick={() => setConfirm(true)}><RefreshCw size={13} />Rebase benchmark</Btn>}</section>;
}

function QuotePanel({ state, settings, setSettings }: { state: AppState; settings: FitSettings; setSettings: React.Dispatch<React.SetStateAction<FitSettings>> }) {
  const underlying = state.activeUnderlying || 'SOL';
  const expiries = [...new Set(state.market.instruments.filter(i => i.underlying === underlying && i.expiry > Date.now()).map(i => i.expiry))].sort((a,b) => a-b);
  const set = <K extends keyof FitSettings>(key: K, value: FitSettings[K]) => setSettings(s => ({ ...s, [key]: value }));
  return <section className="panel quote-panel"><SectionHead title={`${underlying} options fit settings`} eyebrow="OPTIONS CONFIGURATION" /><label className="field"><span>Hedge objective</span><select value={settings.objective} onChange={e => set('objective', e.target.value as FitSettings['objective'])}><option value="payoff">Terminal IL payoff fit</option><option value="superhedge">Conservative superhedge</option><option value="gamma">Current gamma neutrality</option></select><small>{settings.objective === 'gamma' ? 'Target current net gamma using the Risk model IV and horizon. 100% coverage targets zero; buys remain explicit. This does not guarantee terminal IL replication.' : settings.objective === 'superhedge' ? 'Seek nonnegative residual protection, including tail slopes. The constraints may be infeasible.' : 'Minimize listed-strike payoff error and executable cost at one expiry.'}</small></label><label className="field"><span>Common expiry <span className="field-tag">UTC</span></span><select value={settings.expiry} onChange={e => set('expiry', +e.target.value)} disabled={!expiries.length}>{!expiries.length && <option value={0}>No suitable {underlying} options listed</option>}{expiries.map(e => <option key={e} value={e}>{expiryLabel(e)} · {Math.ceil((e - Date.now()) / 86400000)} days</option>)}</select></label><div className="form-grid"><NumberField label="Coverage target" value={settings.coverage * 100} onChange={v => set('coverage', v / 100)} min={0} suffix="%" /><NumberField label="Premium budget" value={settings.budget} onChange={v => set('budget', v)} min={0} suffix="USD" /><NumberField label="Maximum legs" value={settings.maxLegs} onChange={v => set('maxLegs', v)} min={1} step={1} /><NumberField label="Max undercoverage" value={settings.maxUndercoverage ?? 0} onChange={v => set('maxUndercoverage', v > 0 ? v : null)} min={0} suffix="USD" help="0 = no additional bound" /></div>{settings.objective === 'gamma' && <NumberField label="Gamma tolerance · 1% move" value={state.market.referencePrice > 0 ? gammaToleranceCash(state.market.referencePrice, gammaTolerance(settings, state.market.referencePrice)) : NaN} onChange={v => set('gamma', {expiry:0,ivMode:'market',ivPercent:70,...settings.gamma,tolerance:gammaToleranceFromCash(state.market.referencePrice,v)})} disabled={state.market.referencePrice <= 0} min={0} step={0.01} suffix="USDT" help={`Maximum quadratic P&L residual for a 1% move. ${settings.gamma ? 'Saved raw gamma limit; its cash equivalent moves with spot.' : 'Default $1 per 1% move; fixed as raw gamma when saved or quoted.'}`} />}<div className="quote-notice"><LockKeyhole size={15} /><p>Long calls and puts only. Existing long holdings reduce incremental purchases. All actual positions remain in risk.</p></div><div className="tiny-note">{state.market.source === 'fixture' ? 'Fixture asks and liquidity · simulated quote' : 'Uses available executable asks, fees, and depth'} · Prices expire</div></section>;
}

export function OptionExecutionStatus({ state }: { state: AppState }) {
  const underlying = state.activeUnderlying || 'SOL';
  const last = [...state.events].filter(e => e.data?.underlying === underlying && (
    ['options-order-stopped','options-partial-fill','options-reconciled'].includes(e.type) ||
    e.type === 'suspended' && /Bybit|Remaining legs|order outcome/i.test(e.message)
  )).sort((a,b) => b.timestamp - a.timestamp)[0];
  if (!last) return null;
  const reconciled = last.type === 'options-reconciled';
  return <div className={`notice ${reconciled ? 'quiet' : 'amber-notice'}`} role="status"><span><strong>{reconciled ? 'Fills reconciled; review remaining hedge' : 'Last options execution incomplete'}</strong> · {timestamp(last.timestamp)}<br/>{last.message}</span></div>;
}

function OptionLegs({ state, action, busy }: { state: AppState; action: Action; busy: string[] }) {
  const underlying = state.activeUnderlying || 'SOL';
  const [confirm, setConfirm] = useState(false);
  const [execution, setExecution] = useState<OptionExecutionSettings>({ mode: 'marketable-ioc', maxSlippagePercent: 5 });
  const fit = state.fit;
  const gammaCash = (value: number) => state.market.referencePrice > 0 ? signed(gammaToleranceCash(state.market.referencePrice, value), 4) : '—';
  const tradingAccess = state.capabilities.bybitAccount;
  const scopeBlocked = state.mode === 'live' && (!state.accounts.bybit || !state.capabilities.bybitExecution || !state.capabilities.bybitAuthenticated || tradingAccess?.canTrade !== true);
  const expired = !!fit && Date.now() >= fit.expiresAt;
  let preview: OptionExecutionPreview | null = null, previewError = '';
  if (fit && state.mode === 'live') {
    try { preview = optionExecutionPreview(fit, execution); } catch (error) { previewError = (error as Error).message; }
  }
  const reviewExpired = !!fit && Date.now() >= (preview?.expiresAt ?? fit.expiresAt);
  const canBuy = !scopeBlocked && !!fit?.feasible && !!fit.legs.length && !reviewExpired && !previewError && (state.mode === 'paper' || !!preview?.withinBudget);
  const refreshQuote = () => action('requote', async () => {
    if (!fit) return;
    await api('/markets/refresh', {});
    await api('/quote', fit.settings);
  }, 'Hedge quote refreshed; review the updated portfolio and price caps');
  const execute = async () => {
    if (!fit) return;
    const response = await api<Record<string, unknown>>('/quote/execute', { quoteId: fit.id, execution });
    if (state.mode === 'live') {
      if (response.requiresConfirmation !== true || typeof response.requestId !== 'string') throw new Error('Bybit did not return a valid reviewed execution request. No purchase was submitted.');
      const submitted = await api<{ optionExecution?: { complete: boolean; reason: string | null } }>('/quote/submit', { requestId: response.requestId });
      if (submitted.optionExecution?.complete !== true) throw new Error(submitted.optionExecution?.reason || 'Options execution is incomplete or unconfirmed; reconcile actual fills before re-quoting.');
    }
    setConfirm(false);
  };
  const capital = state.accounting?.equity;
  return <section className="panel option-legs"><SectionHead title={`${underlying} proposed options`} eyebrow="BYBIT · INCREMENTAL PURCHASES" aside={fit && <Badge color={expired ? 'amber' : fit.feasible ? 'green' : 'red'} dot>{expired ? 'Quote expired' : fit.feasible ? 'Feasible fit' : 'Constraints not met'}</Badge>} />
    {state.mode === 'live' && state.capabilities.bybitAccount?.canTrade === false && <div className="notice amber-notice"><span>{state.capabilities.bybitAccount.message}</span></div>}
    <BybitSettlementNote state={state} />
    <OptionExecutionStatus state={state}/>
    {!fit ? <Empty title="No proposed hedge" icon={ShieldCheck}>Choose an expiry and budget, then decompose IL and request a quote.</Empty> : <>
      <div className="quote-metrics"><div><span>{fit.source === 'fixture' ? 'Simulated purchase cost' : expired ? 'Previous ask estimate' : 'Ask-based purchase estimate'}</span><strong>{usd(fit.totalCost)}</strong><small>{capital != null && capital > 0 ? `${fmt(fit.totalCost / capital * 100)}% of marked strategy capital` : 'Capital valuation incomplete'}</small></div><div><span>Max payoff error</span><strong>{usd(fit.maxError)}</strong><small>Weighted {usd(fit.weightedError)}</small></div><div><span>Max undercoverage</span><strong>{usd(fit.maxUndercoverage)}</strong><small>After lot rounding</small></div><div><span>Tail slope error</span><strong>{fmt(fit.lowerTailSlopeError, 3)} / {fmt(fit.upperTailSlopeError, 3)}</strong><small>Lower / upper · {underlying}</small></div></div>
      {fit.gammaRisk && <div className="quote-metrics"><div><span>Current net Γ P&L · 1%</span><strong>{gammaCash(fit.gammaRisk.before)}</strong><small>LP {gammaCash(fit.gammaRisk.lp)} + filled options {gammaCash(fit.gammaRisk.existing)}</small></div><div><span>Proposed option Γ P&L · 1%</span><strong>{gammaCash(fit.gammaRisk.added)}</strong><small>Not filled · USDT / 1% move</small></div><div><span>Net Γ P&L after full fills</span><strong>{gammaCash(fit.gammaRisk.after)}</strong><small>Target {gammaCash(fit.gammaRisk.target)} ± {gammaCash(fit.gammaRisk.tolerance)} USDT / 1% move</small></div><div><span>LP model</span><strong>{fmt(fit.gammaRisk.iv*100,2)}% IV</strong><small>{expiryLabel(fit.gammaRisk.expiry)} · {fit.gammaRisk.ivSource}</small></div></div>}
      {fit.reasons.length > 0 && <div className="notice amber-notice"><AlertTriangle size={17} /><div>{fit.reasons.map((r, i) => <span key={i}>{r}</span>)}</div></div>}
      <div className="table-scroll"><table className="options-table"><thead><tr><th>Instrument / expiry</th><th>Type / strike</th><th>Existing</th><th>Buy qty</th><th>Ask / multiplier</th><th>Depth</th><th>Cost + fees</th><th>Δ / Γ · per base</th><th>ν / Θ · per base</th></tr></thead><tbody>{fit.legs.map(l => <tr key={l.instrument.name}><td><strong>{l.instrument.name}</strong><small>{expiryLabel(l.instrument.expiry)} · {timestamp(l.instrument.timestamp)}</small><small>Settlement: {l.instrument.settlement}</small></td><td><Badge color={l.instrument.type === 'call' ? 'green' : 'purple'}>{l.instrument.type.toUpperCase()}</Badge><small>{usd(l.instrument.strike)}</small></td><td className="number">{fmt(l.existingQuantity, 4)}</td><td className="number green">+{fmt(l.quantity, 4)}</td><td className="number">{usd(l.instrument.ask, 4)}<small>× {fmt(l.instrument.multiplier, 2)} {l.instrument.underlying} / contract</small></td><td className="number">{fmt(l.instrument.askSize, 4)}<small>min {fmt(l.instrument.minSize, 4)}</small></td><td className="number">{usd(l.cost + l.fee)}<small>fees {usd(l.fee)}</small></td><td className="number">{fmt(l.instrument.greeks?.delta, 4)}<small>{fmt(l.instrument.greeks?.gamma, 5)}</small></td><td className="number">{fmt(l.instrument.greeks?.vega, 4)}<small>{fmt(l.instrument.greeks?.theta, 4)}</small></td></tr>)}</tbody></table>{fit.legs.length === 0 && <Empty title="No incremental option legs">Existing coverage or the available markets produced no new purchases. Review residual error and constraints.</Empty>}</div>
      <div className="quote-execution-footer"><div><strong>Premium {usd(fit.cost)} <span>+</span> fees {usd(fit.fees)}</strong><p>{fit.source === 'fixture' ? 'Simulated fixture quote' : 'Ask-based estimate'} · Quoted {timestamp(fit.createdAt)} · {expiryLabel(fit.settings.expiry)} expiry</p></div><div className="button-row"><Btn busy={busy.includes('requote')} onClick={refreshQuote}><RefreshCw size={14} />Refresh quote</Btn><Btn kind="primary" disabled={!fit.feasible || reviewExpired || !fit.legs.length} busy={busy.includes('cover')} onClick={() => setConfirm(true)}><ShieldCheck size={15} />{fit.settings.objective === 'gamma' ? 'Cover gamma with Bybit options' : 'Cover IL with Bybit options'}</Btn></div></div>
      <details className="inline-details quote-notes"><summary>Fit assumptions & residual risk</summary>{fit.notes.map((n, i) => <p key={i}><CircleHelp size={12} />{n}</p>)}</details>
    </>}
    {state.holdings.length > 0 && <details className="holdings-list inline-details"><summary>Filled option entries & marks</summary><div className="table-scroll"><table><thead><tr><th>Instrument</th><th>Quantity</th><th>Average entry</th><th>Current mark</th><th>Delta contribution</th></tr></thead><tbody>{state.holdings.map((h, i) => <tr key={`${h.instrument.name}-${i}`}><td>{h.instrument.name}<small>Settlement: {h.instrument.settlement}</small></td><td className="number">{signed(h.quantity, 4)}</td><td className="number">{usd(h.averagePrice, 4)}</td><td className="number">{usd(h.instrument.mark, 4)}</td><td className="number">{h.instrument.greeks ? `${signed(h.quantity * h.instrument.multiplier * h.instrument.greeks.delta, 4)} ${h.instrument.underlying}` : 'Unavailable'}</td></tr>)}</tbody></table></div></details>}
    {confirm && fit && <Modal title={state.mode === 'paper' ? 'Execute paper options hedge' : 'Review Bybit options purchase'} close={() => setConfirm(false)}><div className="purchase-preview">
      {state.mode === 'live' && <div className="form-grid"><label className="field"><span>Purchase execution</span><select aria-label="Purchase execution" value={execution.mode} disabled={busy.includes('cover')} onChange={e => setExecution(s => ({ ...s, mode: e.target.value as OptionExecutionSettings['mode'] }))}><option value="marketable-ioc">Buy immediately with price cap</option><option value="quoted-ask">Buy at quoted ask</option></select></label><NumberField label="Maximum price increase" value={execution.maxSlippagePercent} onChange={v => setExecution(s => ({ ...s, maxSlippagePercent: v }))} min={0} step={1} suffix="%" disabled={execution.mode !== 'marketable-ioc' || busy.includes('cover')} /></div>}
      <BybitSettlementNote state={state} />{fit.gammaRisk && <p>Gamma P&L for 1% move at current spot, using quote Greeks: {gammaCash(fit.gammaRisk.before)} → {gammaCash(fit.gammaRisk.after)} USDT after full fills; target {gammaCash(fit.gammaRisk.target)} ± {gammaCash(fit.gammaRisk.tolerance)} USDT. LP IV {fmt(fit.gammaRisk.iv*100,2)}%, horizon {expiryLabel(fit.gammaRisk.expiry)}. Partial fills and market moves change the result.</p>}<div className="purchase-total"><span>{expired && state.mode === 'live' ? 'Previous ask estimate + fees · prices will be rechecked' : 'Estimated incremental premium + fees'}</span><strong>{usd(fit.totalCost)}</strong></div>
      <div className="stat-pairs">{preview && <><div><span>Price-cap premium + estimated fee reserve</span><strong>{usd(preview.maxTotalCost, 4)}</strong></div><div><span>Premium budget</span><strong>{usd(preview.budget)}</strong></div><div><span>Review deadline</span><strong>{timestamp(preview.expiresAt)} · {reviewExpired ? 'Expired' : `${Math.max(0, Math.ceil((preview.expiresAt - Date.now()) / 1000))}s left`}</strong></div></>}<div><span>Portfolio</span><strong>{fit.legs.length} long option legs</strong></div><div><span>Common expiry</span><strong>{expiryLabel(fit.settings.expiry)}</strong></div><div><span>Maximum residual undercoverage</span><strong>{usd(fit.maxUndercoverage)}</strong></div></div>
      {preview && <div className="table-scroll purchase-caps"><table><thead><tr><th>Option / quantity</th><th>Quoted ask</th><th>Max price</th></tr></thead><tbody>{preview.legs.map(l => <tr key={l.instrument}><td>{l.instrument}<small>Buy {fmt(l.quantity, 4)} {underlying} contracts</small></td><td className="number">{usd(l.quotedAsk, 4)}</td><td className="number">{usd(l.limitPrice, 4)}</td></tr>)}</tbody></table></div>}
      {(previewError || preview && !preview.withinBudget) && <p className="amber">{previewError || 'Price-cap premium and estimated fee reserve exceed your premium budget. Lower the tolerance or re-quote with a reviewed budget.'}</p>}
      <p>{state.mode === 'paper' ? 'This action simulates fills and updates the paper portfolio. Automatic delta hedging will reconcile filled exposure if enabled.' : execution.mode === 'marketable-ioc' ? 'Buy at available market asks up to the approved caps. Caps are rounded down to venue price ticks, so a small tolerance may not allow another tick. Prices and liquidity are checked before submission and each order. Unfilled quantities are cancelled; legs can fill separately.' : 'Buy only up to the original quoted ask. Prices and liquidity are checked before submission and each order. Unfilled quantities are cancelled; legs can fill separately.'}</p>
      {state.mode === 'live' && <p>Bybit limit IOC orders use the server’s configured API credentials. Price limits are submitted to the venue; the fee reserve is an estimate, not a venue-enforced fee cap. Each leg may fill separately.</p>}
      {scopeBlocked && <div className="notice amber-notice" role="alert"><LockKeyhole size={17} /><div><strong>Order permissions are blocked</strong><p>{tradingAccess?.message || 'Connect and verify the Bybit API account before purchasing. Live execution must be enabled in server configuration.'}</p><Btn disabled={!state.capabilities.bybitConfigured} busy={busy.includes('bybit-check')} onClick={() => action('bybit-check', () => api('/bybit/check', {}))}>Check Bybit account</Btn></div></div>}
      <div className="button-row"><Btn busy={busy.includes('requote')} disabled={busy.includes('cover')} onClick={refreshQuote}><RefreshCw size={14} />Refresh quote</Btn>{reviewExpired && <span className="amber">Review expired. Refresh the quote.</span>}</div>
      <Btn kind="primary full" disabled={!canBuy || busy.includes('requote')} busy={busy.includes('cover')} onClick={() => action('cover', execute, state.mode === 'paper' ? 'Paper options fills reconciled' : 'Bybit execution submitted; fills are being reconciled')}>{state.mode === 'paper' ? 'Confirm simulated purchase' : 'Buy within reviewed price caps'}<ArrowRight size={15} /></Btn>
    </div></Modal>}
  </section>;
}

function HedgePanel({ state, action, busy, compact = false, onExpand }: { state: AppState; action: Action; busy: string[]; compact?: boolean; onExpand?: () => void }) {
  const underlying = state.activeUnderlying || 'SOL';
  const h = state.hedge, anchor = h.anchor, alpha = h.settings.alphaPercent / 100;
  const margin = calculateMarginHeadroom(state);
  const marginHeadroom = margin.value;
  const lower = anchor ? anchor * (1 - alpha) : null, upper = anchor ? anchor * (1 + alpha) : null;
  const progress = anchor && alpha > 0 ? Math.min(100, Math.max(0, 50 + (state.market.referencePrice / anchor - 1) / alpha * 50)) : 50;
  const [confirmClose, setConfirmClose] = useState(false);
  const setupAgent = async (revoke = false) => {
    const provider = (window as unknown as { ethereum?: EvmWalletProvider }).ethereum;
    if (!provider || !state.accounts.hyperliquid) throw new Error('Connect your Hyperliquid EVM wallet first.');
    const prepared = await api<{ address: string; typedData: unknown; requestId: string }>('/agent/prepare', { revoke });
    const [signature] = await signTypedDataBatch(provider, state.accounts.hyperliquid.address, [prepared.typedData], { label: 'Hyperliquid agent approval' });
    await api('/agent/approve', { requestId: prepared.requestId, signature });
  };
  return <section className={`panel hedge-panel ${compact ? 'compact' : ''}`}><SectionHead title={`${underlying} delta hedge`} eyebrow="HYPERLIQUID" aside={<Badge color={h.status === 'running' ? 'green' : h.status === 'suspended' ? 'red' : 'neutral'} dot>{h.status}</Badge>} /><div className="hedge-delta"><div><span>{underlying} net delta</span><strong>{signed(h.currentDelta, 3)}<small>{underlying}</small></strong></div><div className="delta-target"><span>Target</span><strong>{fmt(h.targetDelta, 3)} {underlying}</strong></div></div><div className="delta-progress"><div className="progress-track"><div style={{ left: `${progress}%` }} /><i style={{ left: '50%' }} /></div><div className="trigger-labels"><span>{lower ? usd(lower) : '—'}<small>−{fmt(h.settings.alphaPercent, 1)}%</small></span><span>{anchor ? usd(anchor) : 'Not established'}<small>Anchor</small></span><span>{upper ? usd(upper) : '—'}<small>+{fmt(h.settings.alphaPercent, 1)}%</small></span></div></div><div className="hedge-stats"><div><span>Actual perp position</span><strong>{signed(h.actualPerp, 4)} {underlying}</strong></div><div><span>Desired perp position</span><strong>{signed(h.desiredPerp, 4)} {underlying}</strong></div><div><span>Residual to target</span><strong className={Math.abs(h.currentDelta - h.targetDelta) > h.settings.deltaDeadband ? 'amber' : 'green'}>{signed(h.currentDelta - h.targetDelta, 4)} {underlying}</strong></div>{compact && <><div><span>Target mode</span><strong>{h.settings.targetMode === 'dollar-neutral' ? 'Dollar neutral' : 'Preserve HODL'}</strong></div>{h.pendingOrder && <div className="pending-order-status"><span>Pending order</span><strong title={h.pendingOrder}>{h.pendingOrder}</strong></div>}</>}{!compact && <><div><span>Target mode</span><strong>{h.settings.targetMode === 'dollar-neutral' ? 'Dollar neutral' : 'Preserve original HODL'}</strong></div><div><span>Local collateral</span><strong>{usd(state.balances.collateral)}</strong></div><div><span>Required buffer</span><strong>{fmt(margin.buffer * 100, 1)}% of collateral</strong></div><div><span>Headroom at configured leverage</span><strong className={marginHeadroom != null && marginHeadroom < 0 ? 'amber' : ''}>{usd(marginHeadroom)}</strong></div>{state.mode === 'live' && <div><span>Bybit option cash</span><strong>{usd(state.balances.reserves)}</strong></div>}<div><span>Pending hedge order</span><strong>{h.pendingOrder || 'None'}</strong></div></>}</div>{!compact && <p className="margin-context">Headroom is an application risk estimate at configured leverage; venue withdrawable margin may differ.{state.mode === 'live' && ' Bybit cash is separate collateral and does not fund the Hyperliquid margin account.'}</p>}<div className={`worker-state ${h.status === 'suspended' ? 'warning' : ''}`}><span className={`status-dot ${h.status === 'running' ? '' : 'muted-dot'}`} /><span>{h.reason || (h.enabled ? 'Watching price and portfolio changes' : 'Enable to establish the initial delta hedge')}</span></div><div className="hedge-actions">{h.enabled ? <Btn kind="primary full" busy={busy.includes('pause')} onClick={() => action('pause', () => api('/hedge/pause', {}), 'Automatic hedging paused')}><Pause size={14} />Pause automation</Btn> : <Btn kind="primary full" disabled={state.portfolio?.assets.find(asset => asset.underlying === underlying)?.supportStatus !== 'ready'} busy={busy.includes('enable')} onClick={() => action('enable', () => api('/hedge/enable', {}), state.mode === 'paper' ? 'Paper delta automation enabled' : 'Live delta automation enabled')}><Play size={14} />Enable {state.mode === 'paper' ? 'paper ' : ''}delta hedge</Btn>}{compact && <button className="icon-button settings-button" title="Configure delta hedging" onClick={onExpand}><Settings2 size={17} /></button>}</div><div className="button-row hedge-secondary"><HedgeRecovery state={state} action={action} busy={busy} Dialog={Modal}/>{state.mode === 'live' && <Btn onClick={() => action('refresh-collateral', () => api('/portfolio/reconcile', {}), 'Venue positions and collateral refreshed')} busy={busy.includes('refresh-collateral')}>Refresh collateral</Btn>}<Btn onClick={() => action('cancel', () => api('/hedge/cancel', {}), 'Pending hedge orders cancelled')} busy={busy.includes('cancel')}>Cancel pending</Btn><Btn kind="danger-outline" onClick={() => setConfirmClose(true)}>Close perp hedge</Btn></div><div className="risk-context"><span title={margin.reason}>{margin.scope === 'account' ? 'Shared HL margin headroom' : 'Selected HL headroom · legacy'} <b>{usd(marginHeadroom)}</b></span>{state.mode === 'live' && state.hyperliquidCollateral && <span>Collateral <b>{state.hyperliquidCollateral.source} · {usd(state.hyperliquidCollateral.equity)}</b></span>}<span>Funding / hour <b>{signed(state.market.fundingRate * 100,4)}%</b></span></div><div className="hedge-last"><span>Last completed cycle</span><strong>{timestamp(h.lastHedgeAt)}</strong></div>{confirmClose && <Modal title="Close the perpetual hedge" close={() => setConfirmClose(false)}><p className="panel-description">This separately closes the Hyperliquid hedge and pauses automation. Your LP and options remain exposed. Current perpetual position: <strong>{signed(h.actualPerp, 4)} {underlying}</strong>.</p><Btn kind="danger-outline full" busy={busy.includes('close')} onClick={() => action('close', async () => { await api('/hedge/pause', {}); await api('/hedge/close', {}); setConfirmClose(false); }, 'Perpetual close requested; reconciliation continues')}>Confirm close {state.mode === 'paper' ? 'paper ' : ''}hedge</Btn></Modal>}</section>;
}

function AutomationSettings({ state, action, busy }: { state: AppState; action: Action; busy: string[] }) {
  const underlying = state.activeUnderlying || 'SOL';
  const [draft, setDraft] = useState<RiskSettings>(state.hedge.settings);
  const previousSettings = useRef(JSON.stringify(state.hedge.settings));
  useEffect(() => { const next = JSON.stringify(state.hedge.settings); if (next !== previousSettings.current) { previousSettings.current = next; setDraft(state.hedge.settings); } }, [state.hedge.settings]);
  const set = <K extends keyof RiskSettings>(key: K, value: RiskSettings[K]) => setDraft(s => ({ ...s, [key]: value }));
  return <section className="panel settings-panel"><SectionHead title={`${underlying} hedge limits`} eyebrow="AUTOMATION LIMITS" /><div className="notice quiet"><ShieldCheck size={17} /><div><span>After a confirmed hedge, the anchor resets. Price moves, portfolio changes, and large delta deviations trigger reconciliation. The worker persists when this tab closes.</span></div></div><div className="form-grid"><label className="field"><span>Delta target</span><select value={draft.targetMode} onChange={e => set('targetMode', e.target.value as RiskSettings['targetMode'])}><option value="dollar-neutral">Dollar neutral · target 0 {underlying}</option><option value="preserve-hodl">Preserve original HODL delta</option></select></label><NumberField label="Alpha price move" value={draft.alphaPercent} onChange={v => set('alphaPercent', v)} min={.01} step={.1} suffix="%" /><NumberField label="Delta deadband" value={draft.deltaDeadband} onChange={v => set('deltaDeadband', v)} min={0} suffix={underlying} /><NumberField label="Notional deadband" value={draft.notionalDeadband} onChange={v => set('notionalDeadband', v)} min={0} suffix="USD" /><NumberField label="Max order notional" value={draft.maxOrderNotional} onChange={v => set('maxOrderNotional', v)} min={0} suffix="USD" /><NumberField label="Max perp exposure" value={draft.maxPerpNotional} onChange={v => set('maxPerpNotional', v)} min={0} suffix="USD" /><NumberField label="Maximum leverage" value={draft.maxLeverage} onChange={v => set('maxLeverage', v)} min={1} suffix="×" /><NumberField label="Local margin buffer" value={draft.marginBuffer * 100} onChange={v => set('marginBuffer', v / 100)} min={0} suffix="%" /><NumberField label="Max slippage" value={draft.maxSlippageBps} onChange={v => set('maxSlippageBps', v)} min={0} suffix="bps" /><NumberField label="Max cross-venue basis" value={draft.maxBasisBps} onChange={v => set('maxBasisBps', v)} min={0} suffix="bps" /><NumberField label="Data freshness" value={draft.maxDataAgeMs / 1000} onChange={v => set('maxDataAgeMs', v * 1000)} min={1} suffix="sec" /><NumberField label="Cycle cooldown" value={draft.cooldownMs / 1000} onChange={v => set('cooldownMs', v * 1000)} min={1} suffix="sec" /><NumberField label="Delta event threshold" value={draft.deltaEmergency} onChange={v => set('deltaEmergency', v)} min={0} suffix={underlying} /></div><div className="settings-save"><p>Stale data, unsafe margin, or excessive basis suspend new orders. Positions are not automatically liquidated.</p><Btn kind="primary" busy={busy.includes('settings')} onClick={() => action('settings', () => api('/hedge/settings', draft), 'Execution limits saved')}><Check size={14} />Save limits</Btn></div></section>;
}

function PaperRibbon({ state, action, busy }: { state: AppState; action: Action; busy: string[] }) {
  const hasExposure = state.holdings.some(h => Math.abs(h.quantity) > 1e-9) || Math.abs(state.hedge.actualPerp) > 1e-9;
  const locked = state.hedge.enabled || Boolean(state.hedge.pendingOrder) || hasExposure;
  const lockReason = hasExposure ? 'Reset the simulated portfolio, or close its option and perpetual exposure, before changing market feed.' : 'Pause automation and reconcile pending orders before changing market feed.';
  const source = state.paperDataSource || 'fixture';
  return <div className="paper-ribbon"><FlaskConical size={14} /><span><strong>Paper workspace</strong> · {source === 'live' ? 'Live public markets; simulated inventory and fills.' : 'Deterministic market fixtures; simulated inventory and fills.'}</span><label className="paper-feed-select"><span>Market feed</span><select aria-label="Paper market data source" value={source} disabled={locked || busy.includes('paper-feed')} title={locked ? lockReason : 'Select public market data for simulated trading'} onChange={e => action('paper-feed', () => api('/paper/feed', { source: e.target.value }), 'Paper market data source updated')}><option value="fixture">Fixture markets</option><option value="live">Live public markets</option></select>{busy.includes('paper-feed') && <Loader2 size={12} className="spin" />}</label><button onClick={() => action('reset', () => api('/demo/reset', {}), 'Demo portfolio reset')} disabled={busy.includes('reset')}>Reset demo <RefreshCw size={11} /></button><button disabled={busy.includes('multi-demo')} onClick={() => action('multi-demo', () => api('/demo/multi', {}), 'Eight-asset paper demo loaded')}>Load eight-asset demo</button>{locked && <small className="paper-feed-lock"><LockKeyhole size={10} />{lockReason}</small>}</div>;
}

function PaperControls({ state, action, busy }: { state: AppState; action: Action; busy: string[] }) {
  const underlying = state.activeUnderlying || 'SOL';
  const [price, setPrice] = useState(state.market.referencePrice);
  const canSimulate = state.mode === 'paper' && state.paperDataSource !== 'live';
  return <section className="panel"><SectionHead title="Move the market" eyebrow="PAPER SCENARIO CONTROL" aside={<FlaskConical size={18} className="muted" />} /><p className="panel-description">Simulate a reference-price move and watch the backend reconcile bin inventory, options delta, and the alpha trigger.</p><div className="price-control"><NumberField label="Scenario reference price" value={price} onChange={setPrice} min={.000001} suffix={`USD / ${underlying}`} disabled={!canSimulate} /><Btn kind="primary" disabled={!canSimulate} busy={busy.includes('price')} onClick={() => action('price', () => api('/paper/price', { price }), 'Paper market price updated')}>Apply price <ArrowRight size={13} /></Btn></div><div className="price-presets">{[-5, -1.5, 1.5, 5].map(change => <button key={change} disabled={!canSimulate} onClick={() => { const p = state.market.referencePrice * (1 + change / 100); setPrice(+p.toPrecision(8)); void action('price', () => api('/paper/price', { price: p })); }}>{change > 0 ? '+' : ''}{change}%</button>)}</div>{!canSimulate && <small className="amber">{state.mode !== 'paper' ? 'Switch to paper mode to simulate price moves.' : 'Live public feed is active. Pause automation and select Fixture markets to use manual price controls.'}</small>}</section>;
}

function RiskBoundary({ state, positions }: { state: AppState; positions: Position[] }) {
  const underlying = state.activeUnderlying || 'SOL';
  const x = positions.reduce((s, p) => s + p.bins.reduce((n, b) => n + b.x, 0) + p.baseFees, 0);
  const optDelta = state.holdings.reduce((n, h) => n + (h.instrument.greeks?.delta || 0) * h.quantity * h.instrument.multiplier, 0);
  const price = state.market.referencePrice;
  const basis = Math.max(Math.abs(state.market.perpMark / price - 1), Math.abs(state.market.optionIndex / price - 1)) * 10000;
  return <section className="panel"><SectionHead title="What the hedge includes" eyebrow="ACCOUNT AGGREGATION BOUNDARY" /><div className="stat-pairs"><div><span>Selected LP inventory + base fees</span><strong>{fmt(x, 4)} {underlying}</strong></div><div><span>Filled options contribution</span><strong>{signed(optDelta, 4)} {underlying}</strong></div><div><span>Actual Hyperliquid perpetual</span><strong>{signed(state.hedge.actualPerp, 4)} {underlying}</strong></div><div><span>Maximum observed index / perp basis</span><strong className={basis > state.hedge.settings.maxBasisBps ? 'amber' : ''}>{fmt(basis)} bps</strong></div><div><span>Current funding rate</span><strong>{signed(state.market.fundingRate * 100, 4)}%</strong></div></div><p className="panel-description">Only selected {underlying}/stable LPs and account-reconciled derivatives are included. Arbitrary wallet {underlying} and unrelated positions are excluded unless explicitly imported. Stable collateral is not added as underlying delta.</p></section>;
}

export function AccountingPanel({ state, positions }: { state: AppState; positions: Position[] }) {
  const assets = state.portfolio?.assets;
  const value = assets ? assets.some(asset => asset.lpValue == null) ? null : assets.reduce((sum, asset) => sum + (asset.lpValue || 0), 0) : positions.reduce((s, p) => s + p.bins.reduce((n, b) => n + b.x * state.market.referencePrice + b.y, 0), 0);
  const fees = assets ? assets.some(asset => asset.fees == null) ? null : assets.reduce((sum, asset) => sum + (asset.fees || 0), 0) : positions.reduce((s, p) => s + p.baseFees * state.market.referencePrice + p.quoteFees, 0);
  const opt = state.accounting?.optionsValue;
  const total = state.accounting?.equity;
  const attributed = (key: 'optionPremiums' | 'perpRealized' | 'funding' | 'costs') => state.mode === 'paper' ? state.balances[key] : state.accounting?.attribution?.[key] ?? null;
  return <section className="panel accounting-panel"><SectionHead title="Account capital & attribution" eyebrow="USD ACCOUNTING" aside={state.accounting?.valuationComplete === false ? <Badge color="amber">Incomplete valuation</Badge> : undefined} /><div className="account-total"><span>Total marked strategy capital</span><strong>{usd(total)}</strong><small>Includes venue collateral, perp unrealized P&L, and idle reserves</small></div><div className="stat-pairs">{state.accounting?.pnl != null && <div><span>Net P&L vs. capital baseline</span><strong className={state.accounting.pnl >= 0 ? 'green' : 'amber'}>{usd(state.accounting.pnl)}</strong></div>}<div><span>LP inventory mark</span><strong>{usd(value)}</strong></div><div><span>LP accrued fees</span><strong className="green">{usd(fees)}</strong></div><div><span>Options current mark</span><strong>{usd(opt)}</strong></div><div><span>{state.mode === 'live' ? 'Options premium · historical attribution' : 'Options paid premium'}</span><strong>{usd(attributed('optionPremiums'))}</strong></div><div><span>Perp realized price P&L</span><strong>{usd(attributed('perpRealized'))}</strong></div><div><span>Perp unrealized price P&L</span><strong>{usd(state.accounting?.perpUnrealized)}</strong></div><div><span>Funding earned / paid</span><strong>{usd(attributed('funding'))}</strong></div><div><span>Execution costs</span><strong>{usd(attributed('costs'))}</strong></div><div><span>Venue collateral / idle reserves</span><strong>{usd(state.balances.collateral)} / {usd(state.balances.reserves)}</strong></div></div><p className="tiny-note">{state.accounting?.scope && <>{state.accounting.scope}<br /></>}{state.accounting?.attribution?.scope ? <>{state.accounting.attribution.scope}<br /></> : state.mode === 'live' ? <>Historical attribution is not synchronized. — means unavailable; current NAV uses account snapshots.<br /></> : null}IL is a comparison benchmark, not an extra cash expense. Live options bought after the P&L baseline reduce Bybit cash and add current option mark; their net effect, including fees, is in marked Net P&L. Options bought before the baseline enter its opening value, so their earlier purchase costs are outside since-start P&L. The separate historical premium total is unavailable. Theta is not separately deducted from marked P&L.</p></section>;
}

function ActivityPanel({ state, limit }: { state: AppState; limit?: number }) {
  const events = [...state.events].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit || 100);
  return <section className="panel activity-panel"><SectionHead title="Account-wide execution & audit history" eyebrow="ALL UNDERLYINGS · PERSISTENT EVENT LOG" aside={<a className="text-button" href="/api/export?kind=history" download><Download size={13} />Export history</a>} />{events.length ? <div className="event-list">{events.map(e => <div className="event" key={e.id}><div className={`event-icon ${/fail|error|suspend|reject/.test(e.type) ? 'error' : ''}`}>{/fail|error|suspend|reject/.test(e.type) ? <AlertTriangle size={14} /> : /fill|complete|success/.test(e.type) ? <Check size={14} /> : <Activity size={14} />}</div><div><strong>{e.type.replaceAll('_', ' ').replaceAll('.', ' › ')}</strong><p>{e.message}</p>{e.data && <details><summary>Event details</summary><pre>{JSON.stringify(e.data, null, 2)}</pre></details>}</div><time>{new Date(e.timestamp).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}<span>{timestamp(e.timestamp)}</span></time></div>)}</div> : <Empty title="No execution history" icon={Activity}>Quotes, fills, hedge cycles, and state changes will appear here.</Empty>}</section>;
}

function ScenarioComparison() {
  const [scenario, setScenario] = useState<Scenario | null>(null), [error, setError] = useState('');
  const [path, setPath] = useState('');
  useEffect(() => { api<Scenario>('/scenario').then(setScenario).catch(e => setError(e.message)); }, []);
  const paths = [...new Set(scenario?.comparisons.map(c => c.path).filter((p): p is string => Boolean(p)) || [])];
  const chosenPath = paths.includes(path) ? path : paths[0];
  const comparisons = scenario?.comparisons.filter(c => !chosenPath || c.path === chosenPath) || [];
  const chartData = comparisons[0]?.series?.map((point, i) => Object.assign({ day: (point.time - comparisons[0]!.series![0]!.time) / 86400000, spot: point.price }, ...comparisons.map((c, j) => ({ [`strategy${j}`]: c.series?.[i]?.pnl ?? null })))) || [];
  return <section className="panel scenario-comparison"><SectionHead title="Compare the strategy paths" eyebrow="SCENARIO SIMULATION · NOT A HISTORICAL BACKTEST" aside={<BarChart3 size={19} className="muted" />} />{paths.length > 0 && <div className="scenario-paths segmented">{paths.map(p => <button key={p} className={chosenPath === p ? 'active' : ''} onClick={() => setPath(p)}>{p}</button>)}</div>}{error ? <p className="amber">{error}</p> : scenario ? <><div className="scenario-cards">{comparisons.map((s, i) => <div key={s.name}><span className="scenario-number">0{i + 1}</span><h3>{s.strategy || s.name}</h3><strong className={s.finalPnl >= 0 ? 'green' : 'amber'}>{usd(s.finalPnl)}</strong><span>Simulated net P&L{s.returnOnCapital !== undefined ? ` · ${signed(s.returnOnCapital * 100)}% on total capital` : ''}</span><div><span>Max drawdown <b>{usd(s.maxDrawdown)}</b></span><span>Total costs <b>{usd(s.costs)}</b></span></div>{s.marginBreached && <Badge color="red">Local margin breached</Badge>}</div>)}</div>{chartData.length > 0 && <><div className="simulation-chart"><ResponsiveContainer width="100%" height="100%"><ComposedChart data={chartData} margin={{ top: 18, left: 0, right: 5, bottom: 5 }}><CartesianGrid stroke="#25313a" vertical={false} strokeDasharray="3 5" /><XAxis dataKey="day" type="number" tickFormatter={v => `Day ${fmt(v, 0)}`} tick={{ fill: '#7892a3', fontSize: 9 }} tickLine={false} axisLine={false} /><YAxis tickFormatter={v => usd(v, 0)} tick={{ fill: '#7892a3', fontSize: 9 }} width={65} tickLine={false} axisLine={false} /><Tooltip contentStyle={{ background: '#15232d', border: '1px solid #3a4f5f', borderRadius: 7, fontSize: 10 }} labelFormatter={v => `Simulated day ${fmt(Number(v), 1)}`} formatter={v => usd(Number(v))} /><ReferenceLine y={0} stroke="#4a6470" />{comparisons.map((c, i) => <Line key={c.name} dataKey={`strategy${i}`} name={c.strategy || c.name} stroke={['#93aab9', '#aa94f6', '#64dcc7'][i]} strokeWidth={2} dot={false} isAnimationActive={false} />)}</ComposedChart></ResponsiveContainer></div><div className="chart-legend">{comparisons.map((c, i) => <span key={c.name}><i style={{ background: ['#93aab9', '#aa94f6', '#64dcc7'][i] }} />{c.strategy || c.name}</span>)}</div></>}<div className="scenario-notes">{scenario.notes.map((n, i) => <p key={i}>{n}</p>)}</div></> : <div className="inline-loading"><Loader2 size={17} className="spin" />Computing scenario comparison…</div>}</section>;
}
function CapitalTrackingPanel({ state, action, busy }: { state: AppState; action: Action; busy: string[] }) {
  const tracking = state.capitalTracking;
  const [kind, setKind] = useState<'deposit' | 'withdrawal'>('deposit');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const localDateTime = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [effectiveAt, setEffectiveAt] = useState(localDateTime);
  const [review, setReview] = useState<{ id: string; kind: 'deposit' | 'withdrawal'; amount: number; note: string; effectiveAt: number } | null>(null);
  const [restart, setRestart] = useState(false);
  const validFlow = Number(amount) > 0 && note.trim().length > 0 && Number.isFinite(new Date(effectiveAt).getTime());
  return <section className="panel capital-tracking"><SectionHead title="P&L tracking" eyebrow="MARKED CAPITAL · USDT EQUIVALENT" aside={tracking && <Badge color={state.accounting?.pnlUnavailableReason || state.accounting?.pnlStale ? 'amber' : 'green'}>{state.accounting?.pnlUnavailableReason ? 'Scope changed' : state.accounting?.pnlStale ? 'Stored / stale marks' : 'Tracking'}</Badge>}/>
    {!tracking ? <><p className="panel-description">Record current marked capital to start live P&L. Earlier profits and losses are excluded.</p><Btn kind="primary" busy={busy.includes('capital-start')} onClick={() => action('capital-start', () => api('/capital/start', {}), 'Starting capital recorded')}>Start P&L tracking now</Btn></> : <>
      <div className="stat-pairs"><div><span>Started</span><strong>{new Date(tracking.baseline.startedAt).toLocaleString()}</strong></div><div><span>Starting capital</span><strong>{usd(tracking.baseline.equity)} USDT eq.</strong></div><div><span>Net recorded external flows</span><strong>{usd(state.accounting?.netCapitalFlows)}</strong></div><div><span>Net P&L since start</span><strong>{usd(state.accounting?.pnl)}</strong></div></div>
      {state.accounting?.pnlUnavailableReason && <p className="amber">{state.accounting.pnlUnavailableReason}</p>}
      <p className="tiny-note">P&L = current marked capital − starting capital − recorded deposits + recorded withdrawals. Mark-to-market includes fees, funding and premiums through actual balances and positions; none are subtracted a second time. USDT/USDC parity is approximate. Unrecorded external movements affect the result.</p>
      <div className="form-grid"><label className="field"><span>External movement</span><select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="deposit">Deposit into strategy</option><option value="withdrawal">Withdrawal out of strategy</option></select></label><label className="field"><span>Amount · USDT equivalent</span><input type="number" min="0.01" step="any" value={amount} onChange={e => setAmount(e.target.value)}/></label><label className="field"><span>Effective time · local</span><input type="datetime-local" value={effectiveAt} onChange={e => setEffectiveAt(e.target.value)}/></label><label className="field"><span>Note / movement reference</span><input value={note} maxLength={300} onChange={e => setNote(e.target.value)} placeholder="External deposit, withdrawal, LP contribution…"/></label></div>
      <p className="tiny-note">Record only value crossing the tracked strategy boundary, including externally funded LP contributions or fees withdrawn to an excluded wallet. Transfers between included accounts, option purchases, perp trades and fees retained in the strategy are not external flows. This form records accounting only; it moves no funds.</p>
      <div className="button-row"><Btn disabled={!validFlow || !!state.accounting?.pnlUnavailableReason} onClick={() => setReview({ id: crypto.randomUUID(), kind, amount: Number(amount), note: note.trim(), effectiveAt: new Date(effectiveAt).getTime() })}>Review cash-flow adjustment</Btn><Btn busy={busy.includes('capital-refresh')} onClick={() => action('capital-refresh', () => api('/portfolio/reconcile', {}), 'Capital and venue positions refreshed')}>Refresh capital</Btn><a className="button" href="/api/export?kind=capital" download>Export capital ledger</a><Btn onClick={() => setRestart(true)}>Start new baseline</Btn></div>
      {tracking.flows.length > 0 && <div className="table-scroll"><table><thead><tr><th>Effective time</th><th>Movement</th><th>USDT equivalent</th><th>Note</th><th>Ledger action</th></tr></thead><tbody>{[...tracking.flows].reverse().map(flow => <tr key={flow.id}><td>{new Date(flow.effectiveAt).toLocaleString()}</td><td>{flow.kind}{flow.reversedAt ? ' · reversed' : ''}</td><td className="number">{usd(flow.amount)}</td><td>{flow.note}</td><td>{!flow.reversedAt && <Btn busy={busy.includes(`reverse-${flow.id}`)} onClick={() => action(`reverse-${flow.id}`, () => api('/capital/flow/reverse', { id: flow.id }), 'Incorrect ledger entry reversed; no funds moved')}>Reverse entry</Btn>}</td></tr>)}</tbody></table></div>}
    </>}
    {review && <Modal title="Record external cash flow" close={() => setReview(null)}><p>Record a <strong>{review.kind} of {usd(review.amount)} USDT equivalent</strong> effective {new Date(review.effectiveAt).toLocaleString()}.</p><p>{review.note}</p><p className="tiny-note">This changes P&L attribution only. It does not transfer funds. Deposits are removed from profit; withdrawals are added back.</p><Btn kind="primary full" busy={busy.includes('capital-flow')} onClick={() => action('capital-flow', async () => { await api('/capital/flow', review); setReview(null); setAmount(''); setNote(''); setEffectiveAt(localDateTime()); }, 'External cash flow recorded')}>Record adjustment</Btn></Modal>}
    {restart && <Modal title="Start a new P&L baseline" close={() => setRestart(false)}><p>Capture current marked capital and start P&L at zero from the new snapshot. The previous baseline and ledger stay archived. LP impermanent-loss benchmarks and trading settings remain unchanged.</p><Btn kind="primary full" busy={busy.includes('capital-start')} onClick={() => action('capital-start', async () => { await api('/capital/start', { restart: true }); setRestart(false); }, 'New capital baseline recorded')}>Record new starting capital</Btn></Modal>}
  </section>;
}
function ExportPanel() { return <section className="panel"><SectionHead title="Take the data with you" eyebrow="REVIEW & REPRODUCIBILITY" /><div className="export-list">{[['hedge', 'Proposed hedge', 'Legs, executable quotes, and residual risk'], ['positions', 'Position snapshots', 'Bin inventory and original benchmarks'], ['payoff', 'Terminal payoff data', 'Scenario points for every plotted curve'], ['history', 'Execution history', 'Persistent hedge events and order decisions']].map(([kind, label, text]) => <a href={`/api/export?kind=${kind}`} download key={kind}><span className="export-icon"><Download size={16} /></span><div><strong>{label}</strong><small>{text}</small></div><ArrowUpRight size={16} /></a>)}</div></section>; }

function WalletModal({ state, action, busy, close }: { state: AppState; action: Action; busy: string[]; close: () => void }) {
  const [activeChain, setActiveChain] = useState<string | null>(null);
  const [solanaWallets, setSolanaWallets] = useState<SolanaWalletChoice[]>(discoverSolanaWallets);
  const [selectedSolanaWallet, setSelectedSolanaWallet] = useState('');
  const [urlCopied, setUrlCopied] = useState(false);
  useEffect(() => watchSolanaWallets(wallets => {
    setSolanaWallets(wallets);
    setSelectedSolanaWallet(selected => wallets.some(wallet => wallet.id === selected) ? selected : wallets[0]?.id || '');
  }), []);
  useEffect(() => {
    const provider = (window as unknown as { ethereum?: { request: (a: { method: string }) => Promise<unknown>; on?: (event: string, callback: (chain: string) => void) => void; removeListener?: (event: string, callback: (chain: string) => void) => void } }).ethereum;
    const changed = (chain: string) => setActiveChain(String(parseInt(chain, 16)));
    provider?.request({ method: 'eth_chainId' }).then(chain => changed(String(chain))).catch(() => {});
    provider?.on?.('chainChanged', changed);
    return () => provider?.removeListener?.('chainChanged', changed);
  }, []);
  const connect = async (venue: WalletVenue) => {
    const browser = window as unknown as {
      ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
    };
    let address: string, sign: (message: string) => Promise<string>;
    if (venue === 'meteora') {
      const choice = discoverSolanaWallets().find(wallet => wallet.id === selectedSolanaWallet);
      if (!choice) throw new Error(`Open ${window.location.origin} in the browser profile where Jupiter is installed, unlock the extension, and refresh the wallet list. The Codex preview cannot access extensions installed in another browser.`);
      const connection = await connectSolanaWallet(choice); address = connection.address; sign = connection.signMessage;
    } else {
      if (!browser.ethereum) throw new Error('No EVM wallet detected. Open this app in a browser with an EIP-1193 wallet.');
      const accounts = await browser.ethereum.request({ method: 'eth_requestAccounts' }) as string[];
      if (!accounts[0]) throw new Error('The wallet did not return an account.');
      address = accounts[0];
      sign = async message => browser.ethereum!.request({ method: 'personal_sign', params: ['0x' + Array.from(new TextEncoder().encode(message), byte => byte.toString(16).padStart(2, '0')).join(''), address] }) as Promise<string>;
    }
    const challenge = await api<{ challengeId: string; message: string }>('/accounts/challenge', { venue, address });
    const signature = await sign(challenge.message);
    await api('/accounts/connect', { venue, address, signature, challengeId: challenge.challengeId });
  };
  const refreshSolanaWallets = () => {
    const wallets = discoverSolanaWallets();
    setSolanaWallets(wallets);
    setSelectedSolanaWallet(selected => wallets.some(wallet => wallet.id === selected) ? selected : wallets[0]?.id || '');
  };
  return <Modal title="Connect your venue accounts" close={close}>
    <p className="modal-intro">Connect a Solana wallet for Meteora and an EVM wallet for Hyperliquid. Bybit options use a separate exchange account with API credentials configured on the server.</p>
    <div className="wallet-chain-status"><span>Active EVM wallet chain</span><strong>{activeChain ? `${({ '1': 'Ethereum', '999': 'HyperEVM', '42161': 'Arbitrum' } as Record<string, string>)[activeChain] || 'Chain'} (${activeChain})` : 'No EVM provider'}</strong></div>
    <div className="wallet-list">{([{ venue: 'meteora', name: 'Meteora', network: 'Solana · liquidity positions', mark: 'M', color: 'purple' }, { venue: 'hyperliquid', name: 'Hyperliquid', network: 'Hyperliquid · perpetual account', mark: 'H', color: 'cyan' }] as const).map(v => <div className="wallet-card" key={v.venue}>
      <div className="wallet-card-top"><span className={`venue-logo ${v.color}`}>{v.mark}</span><div><h3>{v.name}</h3><small>{v.network}</small></div>{state.accounts[v.venue] && <Badge color="green">Verified</Badge>}</div>
      {v.venue === 'meteora' && !state.accounts.meteora && <div className="solana-wallet-picker">
        <label className="field"><span>Solana wallet</span><select value={selectedSolanaWallet} disabled={!solanaWallets.length || busy.includes('wallet-meteora')} onChange={e => setSelectedSolanaWallet(e.target.value)}>{solanaWallets.length ? solanaWallets.map(wallet => <option value={wallet.id} key={wallet.id}>{wallet.name}</option>) : <option value="">No wallet available in this browser</option>}</select></label>
        {!solanaWallets.length && <div className="wallet-browser-help" role="status">
          <strong>Use the browser where Jupiter is installed</strong>
          <p>Open this dashboard in the Chrome, Brave, or Edge profile with your Jupiter extension, unlock the wallet, and reload. The Codex preview cannot access extensions installed in another browser.</p>
          <code>{window.location.origin}</code>
          <Btn busy={busy.includes('wallet-copy-url')} onClick={() => action('wallet-copy-url', async () => { await navigator.clipboard.writeText(window.location.origin); setUrlCopied(true); })}>{urlCopied ? <Check size={13} /> : <Link2 size={13} />}{urlCopied ? 'Dashboard URL copied' : 'Copy dashboard URL'}</Btn>
        </div>}
        <button className="text-button" onClick={refreshSolanaWallets} disabled={busy.includes('wallet-meteora')}><RefreshCw size={12} />Refresh wallet list</button>
      </div>}
      {state.accounts[v.venue] ? <>
        <div className="connected-address"><span>{state.accounts[v.venue]!.address}</span><LockKeyhole size={13} /></div>
        <div className="wallet-permissions"><Eye size={12} />Ownership verified · Discovery enabled{v.venue === 'hyperliquid' && state.capabilities.hyperliquidAgent ? ' · Agent configured' : ''}</div>
        <button className="text-button" onClick={() => action(`wallet-${v.venue}`, () => api('/accounts/disconnect', { venue: v.venue }), `${v.name} disconnected`)}>Disconnect</button>
      </> : <Btn className="full" busy={busy.includes(`wallet-${v.venue}`)} disabled={v.venue === 'meteora' && !solanaWallets.some(wallet => wallet.id === selectedSolanaWallet)} onClick={() => action(`wallet-${v.venue}`, () => connect(v.venue), `${v.name} ownership verified`)}><Wallet size={14} />Connect {v.venue === 'meteora' ? 'Solana' : 'EVM'} wallet<ArrowUpRight size={13} /></Btn>}
    </div>)}</div>
    <BybitAccountStatus state={state} action={action} busy={busy} setup />
    <div className="quote-notice"><LockKeyhole size={15} /><p>Wallet keys stay in your wallet. Bybit API credentials stay on the server. Options purchases require a reviewed confirmation; unattended perps use a separate approved agent.</p></div>
    <p className="tiny-note">{state.capabilities.message}</p>
  </Modal>;
}

function BybitAccountStatus({ state, action, busy, setup = false }: { state: AppState; action: Action; busy: string[]; setup?: boolean }) {
  const account = state.capabilities.bybitAccount;
  const connected = !!state.accounts.bybit && state.capabilities.bybitAuthenticated;
  const configured = state.capabilities.bybitConfigured;
  const accountBusy = busy.some(key => key.startsWith('bybit-')) || busy.includes('cover');
  const tradingReady = connected && account?.canTrade === true && state.capabilities.bybitExecution;
  return <section className={setup ? 'wallet-card bybit-account-card' : `bybit-account-status notice ${connected && !tradingReady ? 'amber-notice' : 'quiet'}`}>
    {!setup && <LockKeyhole size={17} />}
    <div>
      <div className="wallet-card-top"><span className="venue-logo amber">B</span><div><h3>Bybit options account</h3><small>Exchange API · {state.capabilities.bybitNetwork || 'mainnet'} · separate venue collateral</small></div><Badge color={tradingReady ? 'green' : connected ? 'amber' : 'neutral'}>{tradingReady ? 'Order access verified' : connected ? 'Connected' : 'Not connected'}</Badge></div>
      <p>{account?.message || (configured ? 'Server API credentials are configured. Connect to verify the account, permissions, balance, positions, and open orders.' : 'Configure BYBIT_API_KEY and BYBIT_API_SECRET in the server .env, then restart the service and connect your Bybit account.')}</p>
      {!configured && <p className="tiny-note">Use API credentials for the selected Bybit network. Keep the secret on the server; this dashboard does not request your exchange password, wallet keys, or API secret.</p>}
      {account && <><div className="stat-pairs"><div><span>Bybit account</span><strong>{account.accountId}</strong></div><div><span>USDT/USDC strategy cash</span><strong>{usd(account.optionCash)}</strong></div><div><span>Exchange available balance</span><strong>{account.availableBalance == null ? 'Unavailable' : usd(account.availableBalance)}</strong></div><div><span>API key access</span><strong>{account.readOnly ? 'Read only' : (account.keyCanTrade ?? account.canTrade) ? 'OptionsTrade granted' : 'Option orders unavailable'}</strong></div></div><small>Last verified {timestamp(account.checkedAt)} · Orders recheck account and margin.</small></>}
      {!!account?.excludedAssets?.length && <div className="quote-notice" role="status"><AlertTriangle size={15} /><div><strong>Connected for account inspection · Trading blocked</strong><p>These assets share the Unified account but are excluded from strategy capital and strategy delta. Exchange available balance can include their collateral value.</p><div className="stat-pairs">{account.excludedAssets.map(asset => <div key={asset.coin}><span>{asset.coin} balance</span><strong>{fmt(asset.quantity, 8)} {asset.coin}{asset.usdValue != null ? ` · ${usd(asset.usdValue)}` : ''}</strong></div>)}</div><p>Use a dedicated Bybit subaccount containing supported options and USDT/USDC cash, or manage the extra assets in Bybit, then select Verify / refresh account.</p></div></div>}
      {connected && !state.capabilities.liveExecution && <p className="amber">Live execution is disabled in server configuration.</p>}
      <div className="button-row"><Btn kind={connected ? '' : 'primary'} disabled={!configured || accountBusy} busy={busy.includes('bybit-connect')} onClick={() => action('bybit-connect', () => api('/bybit/connect', {}), 'Bybit account connected and holdings reconciled')}><Link2 size={13} />{connected ? 'Reconnect Bybit account' : 'Connect Bybit account'}</Btn><Btn disabled={!configured || !connected || accountBusy} busy={busy.includes('bybit-check')} onClick={() => action('bybit-check', () => api('/bybit/check', {}), 'Bybit account and permissions refreshed')}><RefreshCw size={13} />Verify / refresh account</Btn>{connected && <Btn disabled={accountBusy} busy={busy.includes('bybit-disconnect')} onClick={() => action('bybit-disconnect', () => api('/accounts/disconnect', { venue: 'bybit' }), 'Bybit account disconnected')}>Disconnect</Btn>}<a className="button" href="https://www.bybit.com/" target="_blank" rel="noopener noreferrer">Open Bybit<ExternalLink size={13} /></a></div>
      <p className="tiny-note">Fund the selected Bybit account separately; connecting does not transfer funds from another venue. Connection reads account data. Every options purchase requires its own confirmation. Review the API key’s permissions and IP restrictions in Bybit; application limits do not narrow permissions granted by the exchange.</p>
    </div>
  </section>;
}

function BybitSettlementNote({ state }: { state: AppState }) {
  const underlying = state.activeUnderlying || 'SOL';
  return <div className="notice quiet bybit-settlement-note"><CircleHelp size={16} /><div><strong>Bybit settlement and LP numeraire</strong><p>Option settlement units follow the selected instruments; Meteora uses the pool quote asset. Payoff plots display USD using a 1:1 stablecoin parity assumption. USDT/USDC basis risk remains, so the combined hedge is approximate.{state.market.stablecoinBasisBps != null && ` Observed stablecoin basis: ${signed(state.market.stablecoinBasisBps, 2)} bps.`}</p></div></div>;
}

function ImportModal({ state, action, busy, close }: { state: AppState; action: Action; busy: string[]; close: () => void }) {
  const [owner, setOwner] = useState(state.accounts.meteora?.address || ''), [pool, setPool] = useState('');
  return <Modal title="Import Meteora positions" close={close}><p className="modal-intro">Discover confirmed bin inventory from a public Solana address. Positions are grouped by verified underlying; unsupported mappings show their reason. Filter by pool address if needed.</p><label className="field"><span>Solana owner address</span><input value={owner} onChange={e => setOwner(e.target.value)} placeholder="Wallet public key" autoComplete="off" /></label><label className="field"><span>Meteora pool address <small>Optional</small></span><input value={pool} onChange={e => setPool(e.target.value)} placeholder="Filter to a specific DLMM pool" autoComplete="off" /></label><div className="notice quiet"><Eye size={16} /><div><span>Importing is read-only and does not deposit, move, or recenter liquidity.</span></div></div><Btn kind="primary full" disabled={!owner.trim()} busy={busy.includes('import')} onClick={() => action('import', async () => { await api('/positions/import', { owner: owner.trim(), ...(pool.trim() ? { pool: pool.trim() } : {}) }); close(); }, 'Meteora position snapshots imported')}><Download size={14} />Discover & import positions</Btn></Modal>;
}

function HypotheticalModal({ state, action, busy, close }: { state: AppState; action: Action; busy: string[]; close: () => void }) {
  const underlying = state.activeUnderlying || 'SOL';
  const price = state.market.referencePrice;
  const [name, setName] = useState(`Custom ${underlying} / USDC`);
  const [rows, setRows] = useState<Bin[]>([{ id: -1, price: +(price * .9).toPrecision(8), x: 0, y: 1000 }, { id: 0, price, x: 500 / price, y: 500 }, { id: 1, price: +(price * 1.1).toPrecision(8), x: 1000 / price, y: 0 }]);
  const edit = (i: number, key: keyof Bin, value: number) => setRows(bs => bs.map((b, j) => i === j ? { ...b, [key]: value } : b));
  return <Modal title="Create a hypothetical position" close={close} wide><p className="modal-intro">Explicitly defined economic bin quantities in {underlying} and USDC. This fixture is labeled hypothetical throughout the workbench.</p><label className="field"><span>Position name</span><input value={name} onChange={e => setName(e.target.value)} /></label><div className="hypothetical-table"><div className="hypothetical-row headings"><span>Bin ID</span><span>Bin price · USD/{underlying}</span><span>Base · {underlying}</span><span>Quote · USDC</span><span /></div>{rows.map((r, i) => <div className="hypothetical-row" key={i}>{(['id', 'price', 'x', 'y'] as const).map(key => <input key={key} type="number" aria-label={`Bin ${i + 1} ${key}`} step="any" value={r[key]} onChange={e => edit(i, key, +e.target.value)} />)}<button className="icon-button" aria-label={`Remove bin ${i + 1}`} onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}><X size={15} /></button></div>)}</div><Btn onClick={() => setRows(rs => [...rs, { id: (rs.at(-1)?.id || 0) + 1, price: +(price * 1.2).toPrecision(8), x: 1, y: 0 }])}><Plus size={13} />Add bin</Btn><div className="modal-actions"><Btn onClick={close}>Cancel</Btn><Btn kind="primary" disabled={!name.trim() || !rows.length} busy={busy.includes('hypothetical')} onClick={() => action('hypothetical', async () => { await api('/positions/hypothetical', { name, bins: rows, underlying }); close(); }, 'Hypothetical position created')}>Create position<ArrowRight size={14} /></Btn></div></Modal>;
}

function AgentAuthorization({ state, action, busy }: { state: AppState; action: Action; busy: string[] }) {
  const setup = async (revoke = false) => {
    const provider = (window as unknown as { ethereum?: EvmWalletProvider }).ethereum;
    if (!provider || !state.accounts.hyperliquid) throw new Error('Connect your Hyperliquid EVM wallet first.');
    const prepared = await api<{ address: string; typedData: unknown; requestId: string }>('/agent/prepare', { revoke });
    const [signature] = await signTypedDataBatch(provider, state.accounts.hyperliquid.address, [prepared.typedData], { label: 'Hyperliquid agent approval' });
    await api('/agent/approve', { requestId: prepared.requestId, signature });
  };
  return <div className="agent-setup"><strong>Hyperliquid agent · {state.capabilities.hyperliquidAgent ? 'Authorized' : 'Not authorized'}</strong><div className="button-row"><Btn disabled={state.mode !== 'live' || !state.accounts.hyperliquid || (state.portfolio?.assets.some(asset => asset.enabled) ?? state.hedge.enabled)} busy={busy.includes('agent')} onClick={() => action('agent', () => setup(), 'Hyperliquid agent authorized')}>Authorize agent</Btn><Btn disabled={!state.capabilities.hyperliquidAgent || (state.portfolio?.assets.some(asset => asset.enabled) ?? state.hedge.enabled)} busy={busy.includes('agent-revoke')} onClick={() => action('agent-revoke', () => setup(true), 'Agent revoked')}>Revoke agent</Btn></div><small>Requires owner-wallet authorization. Pause automation before changing agent access.</small></div>;
}
