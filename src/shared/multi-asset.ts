import type { AppState, FitSettings, FitResult, HedgeState, MarketSnapshot, OptionHolding, Position, Source } from './types';

export const ASSET_CODES = ['BTC', 'ETH', 'SOL', 'XAUT', 'HYPE', 'XRP', 'MNT', 'DOGE'] as const;
export type AssetCode = typeof ASSET_CODES[number];
export interface AssetBook {
  source: Source; paperDataSource?: 'fixture' | 'live';
  positions: Position[]; selectedIds: string[]; holdings: OptionHolding[];
  market: MarketSnapshot; fit: FitResult | null; hedge: HedgeState;
  fitSettings?: FitSettings;
  modelSettings?: { expiry: number; ivMode: 'market' | 'manual'; ivPercent: number; daysAhead: number };
}
export interface AssetOverview {
  underlying: string; lpValue: number | null; fees: number | null; optionsValue: number | null;
  perpSize: number; perpUnrealized: number | null; pnl: number | null; pnlReason: string;
  cashDelta: number | null; modelCashDelta?: number | null; gammaPnl1Pct: number | null; vega: number | null; theta: number | null;
  status: HedgeState['status']; enabled: boolean; reason: string; timestamp: number;
  supportStatus: 'ready' | 'watch-only' | 'unavailable'; supportReasons: string[];
  realizedVolatility: { annualized: number; start: number; end: number; samples: number; source: string } | null;
}
export interface PortfolioLimits { maxGrossPerpNotional: number; maxLeverage: number; marginBuffer: number }
export interface PortfolioOverview {
  assets: AssetOverview[]; globalPaused: boolean; limits: PortfolioLimits;
  grossPerpNotional: number; marginRequired: number;
  commonShock: { pricePercent: number; ivPoints: number; deltaPnl: number | null; gammaPnl: number | null; vegaPnl: number | null; thetaPerDay: number | null; totalPnl: number | null };
}
export function bookState(state: AppState, underlying: string): AppState {
  const book = state.books?.[underlying];
  return book ? { ...state, ...book, activeUnderlying: underlying } : state;
}
