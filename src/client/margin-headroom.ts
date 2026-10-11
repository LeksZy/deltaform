import type { AppState } from '../shared/types';

/** Display-only headroom: account collateral and margin must cover the same boundary. */
export function marginHeadroom(state: AppState): { value: number | null; scope: 'account' | 'selected'; buffer: number; reason: string } {
  const portfolio = state.portfolio;
  const buffer = Math.max(state.hedge.settings.marginBuffer, portfolio?.limits.marginBuffer ?? 0);
  const leverage = Math.min(state.hedge.settings.maxLeverage, portfolio?.limits.maxLeverage ?? Infinity, state.market.perpMaxLeverage ?? Infinity);
  const ownMargin = Math.max(state.hedge.venueMarginUsed ?? 0, Math.abs(state.hedge.actualPerp * state.market.perpMark) / leverage);
  const scoped = (collateral: number, required: number, scope: 'account' | 'selected', reason = '') => ({
    value: Number.isFinite(collateral) && Number.isFinite(required) ? collateral * (1 - buffer) - required : null,
    scope, buffer, reason,
  });
  if (state.mode === 'paper') {
    if (state.accounting?.perpUnrealized == null) return { value: null, scope: portfolio ? 'account' : 'selected', buffer, reason: 'Paper perp valuation unavailable' };
    return scoped(state.balances.collateral + state.accounting.perpUnrealized, portfolio?.marginRequired ?? ownMargin, portfolio ? 'account' : 'selected');
  }
  const collateral = state.hyperliquidCollateral;
  if (!collateral || !state.accounts.hyperliquid || collateral.owner.toLowerCase() !== state.accounts.hyperliquid.address.toLowerCase()) {
    return { value: null, scope: portfolio ? 'account' : 'selected', buffer, reason: 'Reconcile collateral for the connected Hyperliquid account' };
  }
  if (portfolio && collateral.accountPolicyCollateral != null) {
    return scoped(collateral.accountPolicyCollateral, portfolio.marginRequired, 'account');
  }
  // Legacy policyCollateral already reserves other books' holds. Only this book's
  // replacement margin can be deducted from that amount without double counting.
  return scoped(collateral.policyCollateral, ownMargin, 'selected', 'Legacy selected-book collateral estimate; refresh for account-wide headroom');
}
