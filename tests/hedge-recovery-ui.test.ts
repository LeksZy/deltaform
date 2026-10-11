import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { initialState } from '../server/engine';
import { HedgeRecovery, HedgeRecoveryReview } from '../src/client/HedgeRecovery';
import type { RecoveryReview } from '../src/shared/hedge-recovery';

const now = 1800000000000;
const cloid = '0x1234567890abcdef1234567890abcdef';
const review: RecoveryReview = {
  id: 'review-123', createdAt: now, expiresAt: now + 120000, underlying: 'SOL', clientOrderId: cloid,
  quantity: -.046, intentCreatedAt: now - 3600000,
  evidence: { checkedAt: now, orderStatus: 'unknownOid', openOrderCount: 0, matchingHistoricalOrderCount: 0,
    historicalOrdersTruncated: false, fillsSinceIntentCount: 0, fillsComplete: true, actualPerp: -.035,
    eligible: true, blockers: [], observation: 'No matching order or fills found.' },
  warning: 'The unknown result must remain in the audit record.',
};

function fixture() {
  const state = initialState('paper');
  state.mode = 'live'; state.activeUnderlying = 'SOL'; state.hedge.enabled = false;
  state.hedge.pendingOrder = cloid; state.hedge.status = 'suspended';
  state.portfolio = {
    globalPaused: true, assets: ['SOL', 'BTC'].map(underlying => ({ underlying, lpValue: 0, fees: 0, optionsValue: 0,
      perpSize: 0, perpUnrealized: 0, pnl: null, pnlReason: '', cashDelta: 0, gammaPnl1Pct: 0, vega: 0, theta: 0,
      status: 'paused', enabled: false, reason: '', timestamp: now, supportStatus: 'ready', supportReasons: [], realizedVolatility: null })),
    limits: { maxGrossPerpNotional: 9000, maxLeverage: 3, marginBuffer: .2 }, grossPerpNotional: 0, marginRequired: 0,
    commonShock: { pricePercent: 1, ivPoints: 2, deltaPnl: 0, gammaPnl: 0, vegaPnl: 0, thetaPerDay: 0, totalPnl: 0 },
  };
  return state;
}

const Dialog = ({ children }: { title: string; children: ReactNode; close: () => void }) => createElement('div', {}, children);
const action = vi.fn(async () => {});
function control(state = fixture(), busy: string[] = []) {
  return renderToStaticMarkup(createElement(HedgeRecovery, { state, busy, action, Dialog }));
}
function content(overrides: Partial<Parameters<typeof HedgeRecoveryReview>[0]> = {}) {
  return renderToStaticMarkup(createElement(HedgeRecoveryReview, { review, state: fixture(), now, acknowledged: false,
    acknowledge: () => {}, confirm: () => {}, recheck: () => {}, busy: false, error: '', ...overrides }));
}
const archiveButton = (html: string) => html.match(/<button[^>]*>[^<]*Archive unresolved record<\/button>/)?.[0];

describe('pending Hyperliquid recovery controls', () => {
  it('appears only for a live pending record and never initiates a request while rendering', () => {
    const state = fixture();
    expect(control(state)).toContain('Recover pending order');
    expect(control(state)).not.toContain('disabled=""');
    state.mode = 'paper'; expect(control(state)).toBe('');
    state.mode = 'live'; state.hedge.pendingOrder = null; expect(control(state)).toBe('');
    expect(action).not.toHaveBeenCalled();
  });
  it('requires account-wide pause, including other assets and a known portfolio state', () => {
    const state = fixture();
    state.portfolio!.globalPaused = false;
    expect(control(state)).toContain('disabled=""');
    state.portfolio!.globalPaused = true; state.portfolio!.assets[1]!.enabled = true;
    expect(control(state)).toContain('disabled=""');
    state.portfolio!.assets[1]!.enabled = false; state.hedge.enabled = true;
    expect(control(state)).toContain('disabled=""');
    state.hedge.enabled = false; state.portfolio = undefined;
    expect(control(state)).toContain('disabled=""');
    expect(control(fixture(), ['pause-all'])).toContain('disabled=""');
  });
  it('shows the original intent, evidence scope, actual position and unresolved outcome', () => {
    const html = content();
    expect(html).toContain('No order will be sent');
    expect(html).toContain('All hedging remains paused.');
    expect(html).toContain(cloid); expect(html).toContain('Original signed quantity');
    expect(html).toContain('-0.04600000 SOL'); expect(html).toContain('-0.03500000 SOL');
    expect(html).toContain('Open orders · account-wide'); expect(html).toContain('Fills since intent · SOL');
    expect(html).toContain('unknownOid'); expect(html).toContain('complete window');
    expect(html).toContain('Unknown status does not prove the order was never accepted');
    expect(html).toContain('Only the local unresolved record will be archived');
    expect(html).toContain('120s left');
    expect(archiveButton(html)).toContain('disabled=""');
    expect(archiveButton(content({ acknowledged: true }))).not.toContain('disabled=""');
  });
  it('never replaces unavailable position evidence with a zero and hides archive for blockers', () => {
    const blocked = { ...review, evidence: { ...review.evidence, eligible: false, actualPerp: null,
      fillsComplete: false, historicalOrdersTruncated: true, blockers: ['Open exchange orders remain.'] } };
    const html = content({ review: blocked, acknowledged: true });
    expect(html).toContain('Unavailable'); expect(html).toContain('incomplete window');
    expect(html).toContain('history truncated'); expect(html).toContain('Open exchange orders remain.');
    expect(html).not.toContain('Archive unresolved record'); expect(html).not.toContain('type="checkbox"');
  });
  it('disables confirmation after expiration, a record change, resumed hedging, or a failed confirmation', () => {
    const expired = content({ now: review.expiresAt, acknowledged: true });
    expect(expired).toContain('Review expired. Check the exchange again');
    expect(archiveButton(expired)).toContain('disabled=""');
    const state = fixture(); state.hedge.pendingOrder = 'another-order';
    expect(archiveButton(content({ state, acknowledged: true }))).toContain('disabled=""');
    state.hedge.pendingOrder = cloid; state.activeUnderlying = 'BTC';
    expect(archiveButton(content({ state, acknowledged: true }))).toContain('disabled=""');
    state.activeUnderlying = 'SOL'; state.portfolio!.assets[1]!.enabled = true;
    expect(archiveButton(content({ state, acknowledged: true }))).toContain('disabled=""');
    const failed = content({ error: 'Exchange evidence changed. Review again.', acknowledged: true });
    expect(failed).toContain('role="alert"'); expect(failed).toContain('Exchange evidence changed. Review again.');
    expect(archiveButton(failed)).toContain('disabled=""'); expect(failed).toContain('Check exchange again');
  });
});
