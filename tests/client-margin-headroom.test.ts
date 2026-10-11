import { describe, expect, it } from 'vitest';
import { initialState } from '../server/engine';
import { marginHeadroom } from '../src/client/margin-headroom';

function fixture() {
  const state = initialState('live');
  const owner = '0x1111111111111111111111111111111111111111';
  state.accounts.hyperliquid = { address: owner, verified: true, connectedAt: Date.now() };
  state.hyperliquidCollateral = { owner, mode: 'unifiedAccount', source: 'shared USDC balance', equity: 1000,
    accountPolicyCollateral: 950, policyCollateral: 850, spotUsdc: 1000, spotHolds: 650, timestamp: Date.now() };
  state.hedge.settings.marginBuffer = .2; state.hedge.settings.maxLeverage = 5;
  state.hedge.actualPerp = 3; state.market.perpMark = 100; state.hedge.venueMarginUsed = 120;
  state.portfolio = { assets: [], globalPaused: true, limits: { maxGrossPerpNotional: 10000, maxLeverage: 5, marginBuffer: .1 },
    grossPerpNotional: 1800, marginRequired: 500, commonShock: { pricePercent: 1, ivPoints: 1, deltaPnl: 0, gammaPnl: 0, vegaPnl: 0, thetaPerDay: 0, totalPnl: 0 } };
  return state;
}

describe('displayed Hyperliquid headroom boundary', () => {
  it('deducts all required margin once from account collateral and applies the stricter buffer', () => {
    const state = fixture();
    expect(marginHeadroom(state)).toMatchObject({ value: 260, scope: 'account', buffer: .2 }); // 950 × .8 − 500
    state.portfolio!.limits.marginBuffer = .4;
    expect(marginHeadroom(state)).toMatchObject({ value: 70, scope: 'account', buffer: .4 });
  });
  it('uses only selected required margin when legacy collateral already reserves other books', () => {
    const state = fixture(); delete state.hyperliquidCollateral!.accountPolicyCollateral;
    expect(marginHeadroom(state)).toMatchObject({ value: 560, scope: 'selected' }); // 850 × .8 − max(120 actual, 60 policy)
    expect(marginHeadroom(state).reason).toContain('Legacy');
    state.portfolio!.limits.maxLeverage = 2;
    expect(marginHeadroom(state).value).toBe(530); // 850 × .8 − 150 policy margin
  });
  it('does not use collateral from an unverified or different account', () => {
    const state = fixture(); state.accounts.hyperliquid!.address = '0x2222222222222222222222222222222222222222';
    expect(marginHeadroom(state).value).toBeNull();
    expect(marginHeadroom(state).reason).toContain('Reconcile collateral');
  });
  it('includes paper perp unrealized P&L once in account collateral', () => {
    const state = fixture(); state.mode = 'paper'; state.balances.collateral = 1000;
    state.accounting = { ...state.accounting!, perpUnrealized: -100 };
    expect(marginHeadroom(state)).toMatchObject({ value: 220, scope: 'account' }); // (1000 − 100) × .8 − 500
  });
});
