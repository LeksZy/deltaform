import { useEffect, useState } from 'react';
import type { AppState } from '../shared/types';
import { ASSET_CODES, type AssetOverview, type PortfolioLimits } from '../shared/multi-asset';
import { fmt, signed, timestamp, usd } from './api';

const age = (time: number) => !time ? '—' : `${Math.max(0, Math.floor((Date.now() - time) / 1000))}s`;
const cash = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : signed(value, Math.abs(value) > 0 && Math.abs(value) < .01 ? 4 : 2);
export const assetKeys = (state: AppState) => [...new Set<string>([...ASSET_CODES, ...Object.keys(state.books || {}), ...(state.portfolio?.assets.map(asset => asset.underlying) || [])])];
export const assetLabel = (state: AppState, underlying: string) => underlying.startsWith('unmapped:') ? state.books?.[underlying]?.positions[0]?.base || `Token ${underlying.slice(9, 15)}…` : underlying;
export function relevantAssetKeys(state: AppState): string[] {
  const active = state.activeUnderlying || 'SOL';
  const nonzero = (value: number | null | undefined) => value != null && Number.isFinite(value) && value !== 0;
  return assetKeys(state).filter(underlying => {
    if (underlying === active) return true;
    const book = state.books?.[underlying];
    const row = state.portfolio?.assets.find(asset => asset.underlying === underlying);
    return !!row?.enabled || [row?.lpValue, row?.optionsValue, row?.perpSize, row?.fees].some(nonzero)
      || !!book && (book.positions.some(position => book.selectedIds.includes(position.id))
        || book.holdings.some(holding => nonzero(holding.quantity))
        || nonzero(book.hedge.actualPerp) || book.hedge.enabled || !!book.hedge.pendingOrder);
  });
}

export type AssetSortKey = 'underlying' | 'lpValue' | 'optionsValue' | 'perpSize' | 'fees' | 'pnl' | 'cashDelta' | 'gammaPnl1Pct' | 'vega' | 'theta' | 'status' | 'timestamp';
export interface AssetSort { key: AssetSortKey; direction: 'asc' | 'desc' }
const displayedStatus = (row: AssetOverview) => row.supportStatus === 'ready' ? row.status : row.supportStatus;

/** Unknown observations stay last in either direction; ties keep the supplied asset order. */
export function sortAssetKeys(keys: string[], assets: AssetOverview[], sort: AssetSort): string[] {
  const rows = new Map(assets.map(row => [row.underlying, row]));
  const value = (underlying: string): string | number | null => {
    if (sort.key === 'underlying') return underlying;
    const row = rows.get(underlying);
    if (!row) return null;
    if (sort.key === 'status') return displayedStatus(row);
    const observation = row[sort.key];
    if (observation == null || !Number.isFinite(observation) || (sort.key === 'timestamp' && observation <= 0)) return null;
    // The visible column is age: a later observation has a smaller age.
    return sort.key === 'timestamp' ? -observation : observation;
  };
  return keys.map((key, index) => ({ key, index, value: value(key) })).sort((a, b) => {
    if (a.value === null || b.value === null) return a.value === null ? b.value === null ? a.index - b.index : 1 : -1;
    const order = typeof a.value === 'number' && typeof b.value === 'number' ? a.value - b.value : String(a.value).localeCompare(String(b.value), 'en');
    return (sort.direction === 'asc' ? order : -order) || a.index - b.index;
  }).map(item => item.key);
}

export function MultiAssetOverview({ state, select, busy, scenario }: { state: AppState; select: (underlying: string) => void; busy: boolean; scenario?: (shock: { pricePercent: number; ivPoints: number }) => void }) {
  const assets = state.portfolio?.assets || [];
  const shock = state.portfolio?.commonShock;
  const [pricePercent, setPricePercent] = useState(shock?.pricePercent ?? 1), [ivPoints, setIvPoints] = useState(shock?.ivPoints ?? 1);
  const [sort, setSort] = useState<AssetSort>({ key: 'underlying', direction: 'asc' });
  const [scope, setScope] = useState<'positions' | 'all'>('positions');
  const header = (key: AssetSortKey, label: string, title?: string) => <th scope="col" aria-sort={sort.key === key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'} title={title}><button className="asset-sort" onClick={() => setSort(current => ({ key, direction: current.key === key ? current.direction === 'asc' ? 'desc' : 'asc' : key === 'underlying' || key === 'status' ? 'asc' : 'desc' }))} aria-label={`Sort by ${label}`}><span>{label}</span><span className="asset-sort-indicator" aria-hidden="true">{sort.key === key ? sort.direction === 'asc' ? '↑' : '↓' : '↕'}</span></button></th>;
  return <section className="panel multi-asset-overview" aria-label="All underlying risk">
    <div className="section-head"><h2>Underlying risk</h2><div className="risk-table-tools"><span className="tiny-note">USDT equivalent</span><div className="segmented small" role="group" aria-label="Risk table scope">{(['positions', 'all'] as const).map(value => <button key={value} className={scope === value ? 'active' : ''} aria-pressed={scope === value} onClick={() => setScope(value)}>{value === 'positions' ? 'Positions' : 'All assets'}</button>)}</div></div></div>
    <div className="table-scroll"><table className="asset-table"><thead><tr>{header('underlying', 'Asset')}{header('lpValue', 'LP mark')}{header('optionsValue', 'Options mark', 'Actual filled options at current marks; excludes proposed purchases')}{header('perpSize', 'Perp · base', 'Actual signed perpetual quantity in the row’s underlying units')}{header('fees', 'LP fees', 'Accrued LP fees in USDT equivalent')}{header('pnl', 'Net P&L', 'Per-asset net P&L where the accounting allocation is available')}{header('cashDelta', 'Cash Δ', 'Current inventory delta plus filled options and perps, multiplied by underlying price; USDT equivalent')}{header('gammaPnl1Pct', 'Γ P&L · 1%', 'Local quadratic P&L for a 1% price move; configured LP future-value model plus actual options')}{header('vega', 'ν / IV pt', 'USDT-equivalent P&L per 1 percentage point IV change')}{header('theta', 'Θ / day', 'USDT-equivalent model/option time decay per day')}{header('status', 'Hedge / support')}{header('timestamp', 'Age', 'Elapsed seconds since the risk snapshot; hover a value for its timestamp')}</tr></thead><tbody>
      {sortAssetKeys(scope === 'positions' ? relevantAssetKeys(state) : assetKeys(state), assets, sort).map(underlying => {
        const row = assets.find(asset => asset.underlying === underlying);
        const stale = !!row?.timestamp && Date.now() - row.timestamp > (state.books?.[underlying]?.hedge.settings.maxDataAgeMs ?? 30000);
        const active = (state.activeUnderlying || 'SOL') === underlying;
        return <tr key={underlying} className={`${active ? 'selected-row' : ''} ${stale ? 'stale-asset' : ''}`} aria-selected={active} onClick={() => { if (!busy) select(underlying); }}>
          <td><button className="asset-select" aria-label={`Select ${underlying}`} title={underlying} aria-pressed={active} disabled={busy} onClick={event => { event.stopPropagation(); select(underlying); }}>{assetLabel(state, underlying)}<span>{active ? '●' : '›'}</span></button></td>
          <td className="number">{usd(row?.lpValue)}</td><td className="number">{usd(row?.optionsValue)}</td><td className="number" title={`${underlying} underlying units`}>{row && Number.isFinite(row.perpSize) ? signed(row.perpSize, 5) : '—'}</td><td className="number">{usd(row?.fees)}</td><td className="number" title={row?.pnlReason}>{usd(row?.pnl)}</td>
          <td className="number">{cash(row?.cashDelta)}</td><td className="number">{cash(row?.gammaPnl1Pct)}</td><td className="number">{cash(row?.vega)}</td><td className="number">{cash(row?.theta)}</td>
          <td title={[row?.reason, ...(row?.supportReasons || [])].filter(Boolean).join(' · ')}><span className={`badge badge-${row?.status === 'suspended' || row?.supportStatus === 'unavailable' ? 'red' : row?.supportStatus === 'watch-only' ? 'amber' : row?.enabled && row.status === 'running' ? 'green' : 'neutral'}`}>{row ? displayedStatus(row) : 'Loading'}</span></td><td className={stale ? 'amber number' : 'number'} title={timestamp(row?.timestamp)}>{age(row?.timestamp || 0)}{stale ? ' stale' : ''}</td>
        </tr>;
      })}
    </tbody></table></div>
    <details className="inline-details"><summary>Portfolio scenario, volatility & conventions</summary>
      {shock && <div className="portfolio-shock" aria-label="Common portfolio shock"><strong>Common shock · {signed(shock.pricePercent)}% each asset / {signed(shock.ivPoints)} IV pt</strong><span>Δ P&L <b>{cash(shock.deltaPnl)}</b></span><span>Γ P&L <b>{cash(shock.gammaPnl)}</b></span><span>ν P&L <b>{cash(shock.vegaPnl)}</b></span><span>Combined <b>{cash(shock.totalPnl)}</b></span><span>Θ / day <b>{cash(shock.thetaPerDay)}</b></span></div>}
      {scenario && <div className="shock-controls"><label>Common price move · %<input aria-label="Common price move percent" type="number" min={-50} max={50} step="any" value={pricePercent} onChange={event => setPricePercent(+event.target.value)}/></label><label>Common IV move · points<input aria-label="Common IV move points" type="number" min={-50} max={50} step="any" value={ivPoints} onChange={event => setIvPoints(+event.target.value)}/></label><button className="button" disabled={busy} onClick={() => scenario({ pricePercent, ivPoints })}>Apply scenario</button></div>}<p className="tiny-note">{state.mode === 'paper' && state.paperDataSource !== 'live' && <>All paper instruments and support statuses are deterministic fixtures; they do not verify live venue availability. </>}Cash Δ uses current LP inventory plus filled options and perps. Γ, ν and Θ include the configured LP future-value model and available option Greeks. Γ is the quadratic P&L contribution for a 1% underlying move; ν is per IV percentage point; Θ is per day. Shared cash and collateral appear once in account capital. RV is annualized from one-minute log returns; — means unavailable. The common shock is a local approximation of the stated simultaneous move.</p><div className="table-scroll"><table><thead><tr><th>Asset</th><th>RV · 30d</th><th>Support</th><th>Mapping / access / basis</th></tr></thead><tbody>{assets.map(row => <tr key={row.underlying}><td>{assetLabel(state, row.underlying)}</td><td className="number" title={row.realizedVolatility ? `${row.realizedVolatility.source} · ${new Date(row.realizedVolatility.start).toISOString()} – ${new Date(row.realizedVolatility.end).toISOString()} · ${row.realizedVolatility.samples} samples` : 'No verified complete 30-day minute-return series'}>{row.realizedVolatility ? `${fmt(row.realizedVolatility.annualized * 100, 1)}%` : '—'}</td><td>{row.supportStatus}</td><td>{row.supportReasons.join(' · ') || row.reason || 'Verified venue mapping'}{state.books?.[row.underlying]?.positions.some(p => p.hedgeMapping?.requiresBasisMonitoring) && <small>Wrapped / proxy exposure · basis monitoring required</small>}</td></tr>)}</tbody></table></div></details>
  </section>;
}

export function PortfolioLimitsPanel({ state, save, busy }: { state: AppState; save: (limits: PortfolioLimits) => void; busy: boolean }) {
  const limits = state.portfolio?.limits;
  const [draft, setDraft] = useState<PortfolioLimits>(limits || { maxGrossPerpNotional: 10000, maxLeverage: 2, marginBuffer: .2 });
  const key = JSON.stringify(limits);
  useEffect(() => { if (limits) setDraft(limits); }, [key]);
  return <section className="panel portfolio-limits"><div className="section-head"><h2>Account-wide margin limits</h2><span className="tiny-note">All underlying books share these limits</span></div><div className="form-grid">
    <label className="field"><span>Maximum gross perp exposure · USDT</span><input type="number" min={10} max={1e8} value={draft.maxGrossPerpNotional} onChange={e => setDraft({ ...draft, maxGrossPerpNotional: +e.target.value })}/></label>
    <label className="field"><span>Maximum account leverage</span><input type="number" min={1} max={10} step="any" value={draft.maxLeverage} onChange={e => setDraft({ ...draft, maxLeverage: +e.target.value })}/></label>
    <label className="field"><span>Shared margin buffer · %</span><input type="number" min={10} max={95} step="any" value={draft.marginBuffer * 100} onChange={e => setDraft({ ...draft, marginBuffer: +e.target.value / 100 })}/></label>
  </div><div className="settings-save"><p>Gross perp exposure {usd(state.portfolio?.grossPerpNotional)} · required margin {usd(state.portfolio?.marginRequired)}. Each asset also has its own limits.</p><button className="button primary" disabled={busy || !limits} onClick={() => save(draft)}>Save account limits</button></div></section>;
}
