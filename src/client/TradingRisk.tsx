import type { AppState, Position } from '../shared/types';
import { aggregateRisk, portfolioRisk, type ModelSettings, riskInputs } from './portfolio-risk';
import { expiryLabel, fmt, signed, timestamp, usd } from './api';
import { cashDelta, displayGreeks, greekDigits, greekConvention, greekHeaders, type GreekDisplay } from './cash-greeks';

export function WatchOnlyRisk({ state, positions }: { state: AppState; positions: Position[] }) {
  return <section className="panel"><div className="section-head"><h2>Imported inventory</h2><span className="badge badge-amber">Watch only · underlying mapping unavailable</span></div><div className="table-scroll"><table><thead><tr><th>Position</th><th>Base quantity</th><th>Quote quantity</th><th>Pool-price mark · USD parity</th><th>Snapshot</th></tr></thead><tbody>{positions.map(position => {
    const base = position.bins.reduce((sum, bin) => sum + bin.x, 0), quote = position.bins.reduce((sum, bin) => sum + bin.y, 0);
    return <tr key={position.id}><td>{position.name}<small>{position.hedgeMapping?.reason}</small></td><td className="number">{fmt(base, 8)} {position.base}</td><td className="number">{fmt(quote, 4)} {position.quote}</td><td className="number">{state.market.referencePrice > 0 ? usd(base * state.market.referencePrice + quote) : '—'}</td><td>{timestamp(position.snapshotAt)}</td></tr>;
  })}</tbody></table></div><p className="tiny-note">Pool-marked inventory only. Market Greeks and executable hedges require a verified economic underlying and venue mapping.</p></section>;
}

export function PortfolioRisk({ state, positions, model, fallbackExpiry, greekDisplay, setGreekDisplay }: { state: AppState; positions: Position[]; model: ModelSettings; fallbackExpiry: number; greekDisplay: GreekDisplay; setGreekDisplay: (mode: GreekDisplay) => void }) {
  const underlying = state.activeUnderlying || 'SOL';
  const inputs = riskInputs(state, model, fallbackExpiry);
  const risk = portfolioRisk(state, positions, inputs.expiry, inputs.iv);
  const cash = greekDisplay === 'cash', spot = state.market.referencePrice;
  const number = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? '—' : signed(v, greekDigits(v, greekDisplay));
  const cells = (row: ReturnType<typeof aggregateRisk>) => {
    const values = displayGreeks(row.greeks, spot, greekDisplay);
    return <><td className="number">{number(cash ? cashDelta(row.executionDelta, spot) : row.executionDelta)}</td>{(['delta', 'gamma', 'vega', 'theta'] as const).map(key => <td key={key} className="number">{number(values[key])}</td>)}</>;
  };
  return <section className="panel portfolio-risk">
    <div className="section-head">
      <h2>{underlying} positions & risk</h2>
      <div className="greek-display-controls">
        <span className={`badge ${risk.total.stale ? 'badge-amber' : ''}`}>{risk.total.stale ? 'Stored / stale' : 'Current snapshots'}</span>
        <div className="segmented small" role="group" aria-label="Greek display units">{(['cash', 'raw'] as const).map(mode => <button key={mode} className={greekDisplay === mode ? 'active' : ''} aria-pressed={greekDisplay === mode} onClick={() => setGreekDisplay(mode)}>{mode === 'cash' ? 'Cash · USDT' : 'Raw units'}</button>)}</div>
      </div>
    </div>
    <div className="risk-context compact-risk-context">
      <span>LP horizon <b>{inputs.expiry ? expiryLabel(inputs.expiry) : 'Unavailable'}</b></span>
      <span>LP IV <b>{inputs.iv == null ? '—' : `${fmt(inputs.iv * 100, 2)}%`}</b></span>
      <span title={inputs.ivSource}>{model.ivMode === 'market' ? (state.market.source === 'fixture' ? 'Fixture IV' : 'Bybit ATM') : 'Manual IV'}</span>
      <span>Actual positions only</span>
    </div>
    <div className="table-scroll"><table className="positions-risk-table">
      <thead><tr>
        <th>Venue / position</th><th>Actual size</th><th title="LP and options marked value; perpetual unrealized P&L, not notional">Mark / perp uPnL</th>
        <th title="Current LP inventory plus filled options and perpetual delta">Inventory / execution Δ · {cash ? 'USDT' : underlying}</th>
        <th title="LP future-value model plus venue option Greeks and linear perpetual delta">Model / venue Δ · {cash ? 'USDT' : underlying}</th>
        <th title={cash ? `Quadratic P&L contribution for a ±1% ${underlying} move, excluding delta` : 'LP modeled gamma plus actual option venue gamma'}>{cash ? `Gamma P&L · 1% ${underlying}` : greekHeaders(underlying, greekDisplay)[1]}</th>
        <th>ν · USDT/IV pt</th><th>Θ · USDT/day</th><th>Source / time</th>
      </tr></thead>
      <tbody>
        {risk.subtotals.map(group => <Rows key={group.venue} group={group} rows={risk.rows.filter(r => r.venue === group.venue)} cells={cells} />)}
        <tr className="risk-total"><td>{underlying} total</td><td /><td className="number" title="LP and option marks plus perpetual unrealized P&L; excludes idle collateral">{usd(risk.total.value)}</td>{cells(risk.total)}<td>{risk.total.stale ? 'Contains stale values' : 'LP model / venue Greeks'}</td></tr>
      </tbody>
    </table></div>
    <details className="inline-details"><summary>Greek conventions & valuation</summary><p className="tiny-note">{greekConvention(underlying)}</p><p className="tiny-note">Inventory / execution Δ uses current LP inventory and filled derivatives. Model / venue Δ, Γ, ν and Θ combine the LP future-value model with actual options Greeks; totals are approximate. Perp value is unrealized P&L, not notional. Stale values are retained and marked; — means unavailable. Proposed orders are excluded.</p></details>
  </section>;
}
function Rows({ group, rows, cells }: { group: ReturnType<typeof aggregateRisk> & { venue: string }; rows: ReturnType<typeof portfolioRisk>['rows']; cells: (row: ReturnType<typeof aggregateRisk>) => React.ReactNode }) {
  if (!rows.length) return null;
  return <>{rows.map(r => <tr key={r.id}>
    <td><strong>{r.label}</strong><small>{r.venue}</small></td>
    <td className="number">{r.quantity}</td><td className="number">{usd(r.value)}</td>{cells({ ...r, greeks: r.greeks })}
    <td title={r.convention}><span className={r.stale ? 'amber' : ''}>{r.timestamp ? timestamp(r.timestamp) : 'Unverified time'}</span><small>{r.venue === 'Meteora' ? 'LP model' : r.venue === 'Bybit' ? 'Venue' : 'Stored size'}{r.stale ? ' · stale' : ''}</small></td>
  </tr>)}{rows.length > 1 && <tr className="risk-subtotal"><td>{group.venue} subtotal</td><td>{rows.length} positions</td><td className="number">{usd(group.value)}</td>{cells(group)}<td>{group.stale ? 'Stale / unverified snapshot' : ''}</td></tr>}</>;
}

export function ModelSettingsPanel({ state, model, setModel, fallbackExpiry, onHelp }: { state: AppState; model: ModelSettings; setModel: (s: ModelSettings) => void; fallbackExpiry: number; onHelp: () => void }) {
  const underlying = state.activeUnderlying || 'SOL';
  const inputs = riskInputs(state, model, fallbackExpiry);
  const expiries = [...new Set(state.market.instruments.filter(i => i.expiry > Date.now()).map(i => i.expiry))].sort((a,b) => a-b);
  return <section className="panel"><div className="section-head"><h2>Risk model & reference prices</h2><button className="text-button" onClick={onHelp}>Greek conventions</button></div><div className="form-grid">
    <label className="field"><span>LP model horizon</span><select value={model.expiry} onChange={e => setModel({ ...model, expiry: +e.target.value })}><option value={0}>Use configured options expiry</option>{expiries.map(e => <option key={e} value={e}>{expiryLabel(e)}</option>)}</select></label>
    <label className="field"><span>LP IV source</span><select value={model.ivMode} onChange={e => setModel({ ...model, ivMode: e.target.value as ModelSettings['ivMode'] })}><option value="market">Bybit nearest ATM at horizon</option><option value="manual">Manual flat IV</option></select></label>
    <label className="field"><span>Manual IV · %</span><input type="number" min="1" max="500" value={model.ivPercent} disabled={model.ivMode !== 'manual'} onChange={e => setModel({ ...model, ivPercent: +e.target.value })} /></label>
    <label className="field"><span>Pre-expiry plot · days ahead</span><input type="number" min="0" max="90" step="0.1" value={model.daysAhead} onChange={e => setModel({ ...model, daysAhead: Math.max(0, Math.min(90, +e.target.value)) })} /></label>
  </div><div className="risk-context compact-risk-context"><span title={inputs.ivSource}>LP IV <b>{inputs.iv == null ? 'Unavailable' : `${fmt(inputs.iv * 100, 2)}%`}</b></span><span>Reference <b>Hyperliquid {underlying} oracle</b></span><span>Pool <b>{usd(state.market.poolPrice)}</b></span><span>Bybit index <b>{usd(state.market.optionIndex)}</b></span><span>Perp mark <b>{usd(state.market.perpMark)}</b></span></div><details className="inline-details"><summary>Model & price conventions</summary><p className="tiny-note">{inputs.ivSource}. Greek table is at current time; days ahead changes the scenario plot only. LP Greeks assume zero-rate lognormal terminal valuation. Options use their own venue Greeks and expiries. USDT/USDC use approximate USD parity. Reference feeds follow the execution policy; basis and freshness limits are configured below.</p></details></section>;
}
