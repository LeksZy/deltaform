export type Mode = 'paper' | 'live';
export type Source = 'fixture' | 'live' | 'hypothetical';
export interface Bin { id: number; price: number; x: number; y: number }
export interface Position {
  underlying?: string; hedgeMapping?: { status: 'direct' | 'proxy' | 'watch-only'; reason: string; requiresBasisMonitoring: boolean };
  id: string; pool: string; name: string; owner?: string; source: Source;
  base: string; quote: string; baseMint?: string; quoteMint?: string;
  snapshotAt: number; bins: Bin[]; benchmarkBins?: Bin[]; benchmarkAt?: number; benchmarkPrice?: number; baseFees: number; quoteFees: number;
  poolPrice: number; benchmarkX: number; benchmarkY: number;
  notes: string[];
}
export interface Greeks { delta: number; gamma: number; vega: number; theta: number }
export interface OptionInstrument {
  venue?: 'bybit' | 'derive'; network?: 'mainnet' | 'testnet'; quoteCoin?: string; settleCoin?: string;
  name: string; underlying: string; type: 'call' | 'put'; strike: number; expiry: number;
  multiplier: number; minSize: number; sizeStep: number; tickSize: number;
  bid: number | null; ask: number | null; askSize: number; mark: number | null;
  iv: number | null; greeks: Greeks | null; timestamp: number; source: Source;
  asks?: [number, number][]; settlement: string; feeRate: number;
  feeModel?: { kind: 'derive' | 'bybit'; fixed: number; underlyingRate: number; premiumCapRate: number; spot: number };
}
export interface OptionHolding { instrument: OptionInstrument; quantity: number; averagePrice: number }
export interface HedgeLeg { instrument: OptionInstrument; quantity: number; existingQuantity: number; cost: number; fee: number }
export interface OptionExecutionSettings { mode: 'quoted-ask' | 'marketable-ioc'; maxSlippagePercent: number }
export interface FitSettings {
  expiry: number; coverage: number; budget: number; maxLegs: number;
  objective: 'payoff' | 'gamma' | 'superhedge'; maxUndercoverage: number | null;
  gamma?: { expiry: number; ivMode: 'market' | 'manual'; ivPercent: number; tolerance: number };
}
export interface PayoffPoint {
  price: number; hold: number; lp: number; il: number; theoretical: number;
  fitted: number; residual: number; netPnl: number;
}
export interface FitResult {
  id: string; createdAt: number; expiresAt: number; source: Source;
  legs: HedgeLeg[]; cost: number; fees: number; totalCost: number;
  feasible: boolean; reasons: string[]; maxError: number; weightedError: number;
  maxUndercoverage: number; lowerTailSlopeError: number; upperTailSlopeError: number;
  points: PayoffPoint[]; settings: FitSettings; fingerprint: string;
  greeks: Greeks; notes: string[];
  gammaRisk?: { lp: number; existing: number; before: number; added: number; after: number; target: number; error: number; tolerance: number; iv: number; expiry: number; ivSource: string };
}
export interface MarketSnapshot {
  source: Source; timestamp: number; referencePrice: number; poolPrice: number;
  optionIndex: number; perpMark: number; fundingRate: number;
  perpMaxLeverage?: number; instruments: OptionInstrument[]; perpSizeStep: number; perpMinNotional: number;
  status: Record<string, string>;
  stablecoinBasisBps?: number;
}
export interface RiskSettings {
  alphaPercent: number; targetMode: 'dollar-neutral' | 'preserve-hodl';
  deltaDeadband: number; notionalDeadband: number; cooldownMs: number;
  maxOrderNotional: number; maxPerpNotional: number; maxLeverage: number;
  marginBuffer: number; maxSlippageBps: number; maxDataAgeMs: number;
  maxBasisBps: number; deltaEmergency: number;
}
export interface HedgeState {
  enabled: boolean; status: 'paused' | 'running' | 'executing' | 'suspended';
  reason: string; anchor: number | null; lastHedgeAt: number | null;
  accountSnapshot?: { owner: string; timestamp: number };
  venueMarginUsed?: number; venueLeverage?: number;
  actualPerp: number; desiredPerp: number; currentDelta: number; targetDelta: number;
  pendingOrder: string | null; settings: RiskSettings;
}
export interface AccountConnection { address: string; verified: boolean; connectedAt: number; subaccountId?: number }
export interface BybitExcludedAsset { coin: string; quantity: number; usdValue: number | null }
export interface BybitAccountStatus {
  accountId: string; checkedAt: number; canTrade: boolean; readOnly: boolean;
  availableBalance: number | null; optionCash: number; message: string;
  keyCanTrade?: boolean; strategyReady?: boolean; riskBlockers?: string[]; excludedAssets?: BybitExcludedAsset[];
}
export interface DeriveTradingAccess {
  wallet: string; signer: string; version: 'v2' | 'v3'; network: 'mainnet' | 'testnet'; checkedAt: number;
  scope: 'owner' | 'admin' | 'account' | 'read_only' | 'unregistered' | 'unknown';
  expirySec: number | null; canTrade: boolean | null; message: string;
}
export interface LedgerEntry { id: string; timestamp: number; type: string; message: string; data?: Record<string, unknown> }
export interface CapitalFlow { id: string; kind: 'deposit' | 'withdrawal'; amount: number; effectiveAt: number; recordedAt: number; note: string; reversedAt?: number }
export interface CapitalTracking {
  baseline: { id: string; startedAt: number; equity: number; scopeKey: string; scope: string; currency: 'USDT equivalent'; snapshotTimes: number[] };
  flows: CapitalFlow[];
}
export interface AppState {
  schemaVersion?: number; activeUnderlying?: string; books?: Record<string, import('./multi-asset').AssetBook>;
  portfolio?: import('./multi-asset').PortfolioOverview;
  optionsVenue: 'bybit';
  optionsMigration?: { blocked: boolean; reason: string; archivedAt: number };
  hyperliquidCollateral?: import('../venues/hyperliquid-collateral').HyperliquidCollateral & { owner: string };
  capitalTracking?: CapitalTracking;
  paperDataSource?: 'fixture' | 'live';
  mode: Mode; source: Source; positions: Position[]; selectedIds: string[];
  holdings: OptionHolding[]; market: MarketSnapshot; fit: FitResult | null;
  hedge: HedgeState; events: LedgerEntry[];
  accounts: { meteora: AccountConnection | null; bybit: AccountConnection | null; hyperliquid: AccountConnection | null; derive?: AccountConnection | null };
  balances: { collateral: number; reserves: number; optionPremiums: number; perpRealized: number; funding: number; costs: number };
  accounting?: { equity: number | null; perpUnrealized: number; optionsValue: number | null; initialCapital: number; pnl: number | null; scope: string; valuationComplete?: boolean;
    pnlStartedAt?: number; netCapitalFlows?: number; pnlUnavailableReason?: string | null; pnlStale?: boolean;
    attribution?: { optionPremiums: number | null; perpRealized: number | null; funding: number | null; costs: number | null; scope: string } };
  capabilities: { liveExecution: boolean; bybitExecution: boolean; bybitConfigured?: boolean; bybitAuthenticated?: boolean;
    bybitNetwork?: 'mainnet' | 'testnet'; bybitAccount?: BybitAccountStatus; optionsVenue?: 'bybit';
    deriveExecution?: boolean; hyperliquidAgent: boolean; message: string;
    deriveApiVersion?: 'v2' | 'v3'; deriveNetwork?: 'mainnet' | 'testnet'; marketRefreshIntervalMs?: number; deriveAuthenticated?: boolean; deriveReadOnly?: boolean; deriveReadExpiresAt?: number | null; deriveWallet?: string; deriveTradingAccess?: DeriveTradingAccess };
}
