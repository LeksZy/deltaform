/** Economic risk groups. A ticker alone never proves an on-chain token mapping. */
export const UNDERLYINGS = ['BTC', 'ETH', 'SOL', 'XAUT', 'HYPE', 'XRP', 'MNT', 'DOGE'] as const;
export type Underlying = typeof UNDERLYINGS[number];
export function isUnderlying(value: unknown): value is Underlying { return typeof value === 'string' && (UNDERLYINGS as readonly string[]).includes(value); }
export function requireUnderlying(value: unknown): Underlying {
  if (!isUnderlying(value)) throw new Error(`Unsupported underlying: ${String(value)}`);
  return value;
}
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export interface TokenMapping { mint: string; symbol: string; underlying: Underlying; decimals: number; proxy: boolean; source: string }
/** Issuer/bridge addresses checked against official registries and Solana mint data 2026-09-30. */
export const TOKEN_MAPPINGS: readonly TokenMapping[] = [
  { mint: SOL_MINT, symbol: 'SOL', underlying: 'SOL', decimals: 9, proxy: false, source: 'https://solana.com/docs/tokens/basics/sync-native' },
  { mint: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', symbol: 'cbBTC', underlying: 'BTC', decimals: 8, proxy: true, source: 'https://www.coinbase.com/cbbtc' },
  { mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', symbol: 'WBTC (Portal)', underlying: 'BTC', decimals: 8, proxy: true, source: 'https://github.com/wormhole-foundation/wormhole-token-list/blob/main/content/by_source.csv' },
  { mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', symbol: 'ETH (Portal)', underlying: 'ETH', decimals: 8, proxy: true, source: 'https://github.com/wormhole-foundation/wormhole-token-list/blob/main/content/by_source.csv' },
  { mint: 'AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P', symbol: 'XAUt0', underlying: 'XAUT', decimals: 6, proxy: true, source: 'https://usdt0.gitbook.io/xaut0/technical-documentation/developer' },
  { mint: '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g', symbol: 'HYPE (Sunrise/Wormhole NTT)', underlying: 'HYPE', decimals: 9, proxy: true, source: 'https://pump.fun/docs/custom-pairs' },
];
export const STABLECOINS = [
  { mint: USDC_MINT, symbol: 'USDC' as const, decimals: 6, source: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
  { mint: USDT_MINT, symbol: 'USDT' as const, decimals: 6, source: 'https://usdt0.to/ecosystem/solana' },
] as const;
export interface HedgeMapping { status: 'direct' | 'proxy' | 'watch-only'; reason: string; requiresBasisMonitoring: boolean }
export interface MeteoraPairMapping {
  underlying?: Underlying; base: string; quote: 'USDC' | 'USDT'; baseMint: string; quoteMint: string;
  inverted: boolean; baseDecimals?: number; quoteDecimals: number; hedgeMapping: HedgeMapping;
}
export function resolveMeteoraPair(xMint: string, yMint: string): MeteoraPairMapping {
  const xs = STABLECOINS.find(s => s.mint === xMint), ys = STABLECOINS.find(s => s.mint === yMint);
  if ((!xs && !ys) || (xs && ys)) throw new Error('Only volatile/stablecoin pairs using canonical USDC or USDT can be valued here; volatile/volatile pairs require a joint model.');
  const inverted = Boolean(xs), stable = (xs ?? ys)!, baseMint = inverted ? yMint : xMint;
  const token = TOKEN_MAPPINGS.find(t => t.mint === baseMint);
  const hedgeMapping: HedgeMapping = !token
    ? { status: 'watch-only', reason: 'Token mint has no verified issuer/bridge mapping; symbol matching and proxy hedges are not authorized.', requiresBasisMonitoring: true }
    : token.proxy
      ? { status: 'proxy', reason: `${token.symbol} is a verified ${token.underlying} representation with bridge/custody and price basis risk; fresh pool-to-index basis is required.`, requiresBasisMonitoring: true }
      : { status: 'direct', reason: 'Wrapped native SOL; stablecoin and venue basis are monitored separately.', requiresBasisMonitoring: stable.symbol === 'USDT' };
  return { underlying: token?.underlying, base: token?.underlying ?? `unmapped:${baseMint}`, quote: stable.symbol, baseMint,
    quoteMint: stable.mint, inverted, baseDecimals: token?.decimals, quoteDecimals: stable.decimals, hedgeMapping };
}
export function meteoraMappingStatus(underlying: Underlying) {
  const tokens = TOKEN_MAPPINGS.filter(t => t.underlying === underlying);
  return { underlying, tokens, available: tokens.length > 0,
    reason: tokens.length ? 'Exact mint registry available; pool liquidity, option chain and matching perpetual still require live discovery.'
      : `No verified Solana ${underlying} mint is configured. Imported stablecoin pools remain watch-only until issuer/bridge provenance is verified.` };
}
