import { createRequire } from 'node:module';
import type DLMMType from '@meteora-ag/dlmm';
import { Connection, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import type { Bin, Position } from '../shared/types.js';
import { resolveMeteoraPair, TOKEN_MAPPINGS, STABLECOINS, requireUnderlying, type Underlying, type MeteoraPairMapping } from '../shared/assets.js';
export { SOL_MINT, USDC_MINT, USDT_MINT } from '../shared/assets.js';
import { jsonRequest, positive, VenueError } from './http.js';

const API = 'https://dlmm.datapi.meteora.ag';
// SDK 1.9.14's ESM build imports named BN from Anchor CJS, unsupported by Node 23.
// Its shipped CJS build has the same API and resolves Anchor correctly.
const dlmmModule = createRequire(import.meta.url)('@meteora-ag/dlmm');
const DLMM: typeof DLMMType = dlmmModule.default ?? dlmmModule;
export interface MeteoraPool extends MeteoraPairMapping { address: string; name: string; price: number; binStep: number; tvl: number; volume24h: number; inverted: boolean; timestamp: number }
interface ApiPool { address: string; name: string; token_x: { address: string }; token_y: { address: string }; current_price: number; pool_config: { bin_step: number }; tvl: number; volume: { '24h': number } }
function normalizePool(p: ApiPool): MeteoraPool {
  const mapping = resolveMeteoraPair(p.token_x.address, p.token_y.address);
  const { inverted } = mapping;
  return { ...mapping, address: p.address, name: p.name, price: inverted ? 1 / positive(p.current_price, 'pool price') : positive(p.current_price, 'pool price'),
    binStep: p.pool_config.bin_step, tvl: p.tvl, volume24h: p.volume['24h'], inverted, timestamp: Date.now() };
}
export async function getMeteoraPool(address: string): Promise<MeteoraPool> {
  new PublicKey(address);
  const data = await jsonRequest<ApiPool>('Meteora', `${API}/pools/${address}`);
  return normalizePool(data);
}

export function supportedOrientation(xMint: string, yMint: string): boolean {
  const pair = resolveMeteoraPair(xMint, yMint);
  if (!pair.underlying) throw new VenueError('Meteora', pair.hedgeMapping.reason);
  return pair.inverted;
}
export async function getMeteoraPools(underlying: Underlying = 'SOL'): Promise<MeteoraPool[]> {
  requireUnderlying(underlying);
  const tokens = TOKEN_MAPPINGS.filter(t => t.underlying === underlying);
  if (!tokens.length) throw new VenueError('Meteora', `No verified ${underlying} Solana token mapping. Import a pool address for watch-only valuation; a symbol alone does not establish hedge eligibility.`);
  const all = new Map<string, MeteoraPool>();
  // Exact mints in both orientations; independently enforce filters even if the indexer ignores them.
  for (const token of tokens) for (const stable of STABLECOINS) for (const [x, y] of [[token.mint, stable.mint], [stable.mint, token.mint]]) {
    for (let page = 1; page <= 20; page++) {
      const query = new URLSearchParams({ page: String(page), page_size: '100', sort_by: 'tvl:desc', filter_by: `token_x=${x}&&token_y=${y}` });
      const result = await jsonRequest<{ data: ApiPool[]; total_pages?: number }>('Meteora', `${API}/pools?${query}`);
      if (!Array.isArray(result.data)) throw new VenueError('Meteora', 'Pool listing schema unavailable');
      for (const pool of result.data) if (pool.token_x.address === x && pool.token_y.address === y && Number.isFinite(pool.current_price) && pool.current_price > 0)
        all.set(pool.address, normalizePool(pool));
      if (result.data.length < 100 || (result.total_pages !== undefined && page >= result.total_pages)) break;
      if (page === 20) throw new VenueError('Meteora', 'Pool pagination bound exceeded; narrow pool discovery by exact address.');
    }
  }
  return [...all.values()].sort((a, b) => b.tvl - a.tvl);
}

export interface RawOwnedBin { binId: number; pricePerToken: string; positionXAmount: string; positionYAmount: string }
export function normalizeOwnedBins(bins: RawOwnedBin[], decimalsX: number, decimalsY: number, inverted: boolean): Bin[] {
  return bins.map(bin => {
    const nativePrice = new Decimal(bin.pricePerToken);
    if (!nativePrice.isPositive()) throw new Error('Invalid SDK bin price');
    const x = new Decimal(bin.positionXAmount).div(new Decimal(10).pow(decimalsX));
    const y = new Decimal(bin.positionYAmount).div(new Decimal(10).pow(decimalsY));
    if (x.isNegative() || y.isNegative()) throw new Error('Negative owned inventory');
    return { id: bin.binId, price: (inverted ? new Decimal(1).div(nativePrice) : nativePrice).toNumber(),
      x: (inverted ? y : x).toNumber(), y: (inverted ? x : y).toNumber() };
  }).filter(bin => bin.x > 0 || bin.y > 0).sort((a, b) => a.price - b.price);
}

export async function getMeteoraPositions(owner: string, pool?: string, underlying?: Underlying): Promise<Position[]> {
  if (underlying !== undefined) requireUnderlying(underlying);
  const rpc = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpc, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  const wallet = new PublicKey(owner);
  const pools = pool ? await (async () => {
    const dlmm = await DLMM.create(connection, new PublicKey(pool));
    const p = await dlmm.getPositionsByUserAndLbPair(wallet);
    return [{ publicKey: dlmm.pubkey, lbPair: dlmm.lbPair, tokenX: dlmm.tokenX, tokenY: dlmm.tokenY, lbPairPositionsData: p.userPositions }];
  })() : [...(await DLMM.getAllLbPairPositionsByUser(connection, wallet)).values()];
  const result: Position[] = [];
  const unsupported: string[] = [];
  for (const p of pools) {
    let mapping: MeteoraPairMapping;
    try { mapping = resolveMeteoraPair(p.tokenX.publicKey.toBase58(), p.tokenY.publicKey.toBase58()); }
    catch { unsupported.push(p.publicKey.toBase58()); continue; }
    if (underlying && mapping.underlying !== underlying) { unsupported.push(p.publicKey.toBase58()); continue; }
    const { inverted } = mapping;
    const dx = p.tokenX.mint.decimals; const dy = p.tokenY.mint.decimals;
    if ((mapping.baseDecimals !== undefined && (inverted ? dy : dx) !== mapping.baseDecimals) || (inverted ? dx : dy) !== mapping.quoteDecimals)
      throw new VenueError('Meteora', `On-chain token decimals disagree with the verified registry for ${p.publicKey.toBase58()}`);
    // SDK constructs pricePerToken from actual bin IDs and token decimals. This same geometric
    // rule is used for active pool price, independently of the displayed indexer's UI price.
    const nativePrice = new Decimal(1).plus(new Decimal(p.lbPair.binStep).div(10000)).pow(p.lbPair.activeId)
      .mul(new Decimal(10).pow(dx - dy));
    for (const position of p.lbPairPositionsData) {
      const d = position.positionData;
      const bins = normalizeOwnedBins(d.positionBinData, dx, dy, inverted);
      const feeX = new Decimal(d.feeXExcludeTransferFee.toString()).div(new Decimal(10).pow(dx)).toNumber();
      const feeY = new Decimal(d.feeYExcludeTransferFee.toString()).div(new Decimal(10).pow(dy)).toNumber();
      result.push({ id: position.publicKey.toBase58(), pool: p.publicKey.toBase58(), owner,
        name: `${mapping.base} / ${mapping.quote}`, source: 'live', base: mapping.base, quote: mapping.quote,
        underlying: mapping.underlying, baseMint: mapping.baseMint, quoteMint: mapping.quoteMint, hedgeMapping: mapping.hedgeMapping,
        snapshotAt: Date.now(), bins, baseFees: inverted ? feeY : feeX, quoteFees: inverted ? feeX : feeY,
        poolPrice: (inverted ? new Decimal(1).div(nativePrice) : nativePrice).toNumber(),
        benchmarkX: bins.reduce((s, b) => s + b.x, 0), benchmarkY: bins.reduce((s, b) => s + b.y, 0),
        notes: ['Solana confirmed commitment; SDK reads are not atomic across all accounts.',
          'Owned raw token amounts converted with Decimal; numerical scenario boundary uses JS numbers.',
          mapping.hedgeMapping.reason,
          'USDC/USDT/USD parity is approximate. Fees use SDK amounts excluding transfer fees; wrapper redemption and bridge costs are outside terminal replication.',
          ...(inverted ? ['Pool orientation inverted; bin IDs retained, prices and inventory normalized.'] : []),
          ...(unsupported.length ? [`Ignored unsupported pools: ${unsupported.join(', ')}`] : [])],
      });
    }
  }
  if (!result.length && unsupported.length) throw new VenueError('Meteora', `No matching supported stablecoin positions. Unsupported or other-underlying pool addresses: ${unsupported.join(', ')}`);
  return result;
}
