import { finite, VenueError } from './http';
export type HyperliquidAccountMode = 'unifiedAccount' | 'disabled' | 'default' | 'dexAbstraction';
export interface HyperliquidCollateral {
  mode: HyperliquidAccountMode; source: 'shared USDC balance' | 'perp account equity';
  equity: number; policyCollateral: number; accountPolicyCollateral?: number; spotUsdc: number; spotHolds: number;
  timestamp: number;
}
/** USDC-only native perpetual accounts. Unified cash is counted once, never added to legacy perp equity. */
export function normalizeHyperliquidCollateral(mode: unknown, state: any, spot: any, now = Date.now(), underlying = 'SOL'): HyperliquidCollateral {
  if (!['unifiedAccount','disabled','default','dexAbstraction'].includes(String(mode))) throw new VenueError('Hyperliquid', `Unsupported account abstraction ${String(mode)}; portfolio margin requires separate collateral/borrowing support`);
  if (!Array.isArray(spot?.balances) || !Array.isArray(state?.assetPositions)) throw new VenueError('Hyperliquid','Missing spot balances or perpetual positions');
  const usdc = spot.balances.filter((b:any)=>b.coin==='USDC' && b.token===0);
  if (usdc.length>1 || spot.balances.some((b:any)=>b.coin==='USDC' && b.token!==0)) throw new VenueError('Hyperliquid','Invalid canonical USDC balance');
  const spotUsdc=usdc.length?finite(usdc[0].total,'shared USDC balance'):0;
  const spotHolds=usdc.length?finite(usdc[0].hold,'shared USDC holds'):0;
  if (spotUsdc<0 || spotHolds<0) throw new VenueError('Hyperliquid','Negative USDC balance or holds; review account collateral/debt');
  if (mode==='unifiedAccount') {
    // Reserve other orders' holds, while allowing the selected position's own margin
    // to fund its desired replacement. The policy compares the whole desired exposure.
    const ownMargin=state.assetPositions.reduce((sum:number,p:any)=>sum+(p.position?.coin===underlying && p.position.leverage?.type==='cross' ? Math.max(0,finite(p.position.marginUsed,'selected position margin')):0),0);
    const allMargin=state.assetPositions.reduce((sum:number,p:any)=>sum+(p.position.leverage?.type==='cross' ? Math.max(0,finite(p.position.marginUsed,'position margin')):0),0);
    return {mode,source:'shared USDC balance',equity:spotUsdc,accountPolicyCollateral:Math.max(0,spotUsdc-Math.max(0,spotHolds-allMargin)),policyCollateral:Math.max(0,spotUsdc-Math.max(0,spotHolds-ownMargin)),spotUsdc,spotHolds,timestamp:now};
  }
  const equity=finite(state.marginSummary?.accountValue,'HL equity');
  return {mode:mode as HyperliquidAccountMode,source:'perp account equity',equity,policyCollateral:equity,accountPolicyCollateral:equity,spotUsdc,spotHolds,timestamp:now};
}
