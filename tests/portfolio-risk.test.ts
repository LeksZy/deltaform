import { describe, expect, it } from 'vitest';
import { initialState } from '../server/engine';
import type { Position } from '../src/shared/types';
import { aggregateRisk, portfolioRisk, riskInputs } from '../src/client/portfolio-risk';
const now = Date.UTC(2026, 8, 27), expiry = now + 365.25 * 86400000;
const lp: Position = { id:'lp', pool:'pool', name:'SOL/USDC', source:'live', base:'SOL', quote:'USDC', snapshotAt:now,
  bins:[{id:0,price:100,x:1,y:0}], benchmarkBins:[{id:0,price:100,x:3,y:0}], benchmarkX:3,benchmarkY:0,
  baseFees:0.1, quoteFees:2,poolPrice:100,notes:[] };
function state() { const s=initialState('paper'); s.positions=[lp];s.selectedIds=['lp'];s.holdings=[];s.market.referencePrice=100;s.market.perpMark=100;s.hedge.actualPerp=-1;return s; }
describe('Trading overview risk conventions', () => {
  it('uses current bin inventory for LP model and includes fees in inventory delta', () => {
    const r=portfolioRisk(state(),[lp],expiry,0.2,now).rows[0];
    // At S=K, r=0, T=1, sigma=.2: N(.1)=.5398278373; phi(.1)=.3969525475.
    expect(r.executionDelta).toBeCloseTo(1.1,10); expect(r.value).toBeCloseTo(112,10);
    expect(r.greeks!.delta).toBeCloseTo(1-.5398278373+.1,6);
    expect(r.greeks!.gamma).toBeCloseTo(-.3969525475/20,9);
    expect(r.greeks!.vega).toBeCloseTo(-.3969525475,9);
    expect(r.greeks!.theta).toBeCloseTo(100*.3969525475*.2/2/365.25,9);
  });
  it('uses signed filled contracts, fresh matching venue Greeks and linear perp size in totals', () => {
    const s=state();const i={...s.market.instruments[0],name:'OPTION',venue:'bybit' as const,network:'mainnet' as const,expiry,timestamp:now,multiplier:2,mark:4,
      greeks:{delta:.6,gamma:.02,vega:.4,theta:-.03},iv:.2};
    s.holdings=[{instrument:{...i,greeks:{...i.greeks,delta:.1}},quantity:-3,averagePrice:5}];s.market.instruments=[i];
    const r=portfolioRisk(s,[lp],expiry,.2,now);const option=r.rows.find(r=>r.venue==='Bybit')!;
    expect(option.executionDelta).toBeCloseTo(-3.6,10);expect(option.value).toBe(-24);
    expect(r.total.executionDelta).toBeCloseTo(-3.5,10);
    expect(r.total.greeks!.gamma).toBeCloseTo(-.3969525475/20-.12,9);
    expect(r.subtotals.find(r=>r.venue==='Hyperliquid')!.greeks).toEqual({delta:-1,gamma:0,vega:0,theta:0});
  });
  it('keeps missing or expired option Greeks unknown and excludes proposed options', () => {
    const s=state();const i={...s.market.instruments[0],expiry:now-1,timestamp:now,greeks:null};
    s.holdings=[{instrument:i,quantity:1,averagePrice:2}];s.market.instruments=[];
    const r=portfolioRisk(s,[lp],expiry,.2,now);
    expect(r.total.greeks).toBeNull();expect(r.total.executionDelta).toBeNull();
    expect(r.rows.find(r=>r.venue==='Bybit')!.value).toBeNull();
    s.holdings=[];s.fit={legs:[{instrument:i,quantity:100}]} as any;
    expect(portfolioRisk(s,[lp],expiry,.2,now).rows.filter(r=>r.venue==='Bybit')).toHaveLength(0);
  });
  it('shows LP sensitivities unavailable without IV and does not infer a flat live perp account', () => {
    const s=state();s.mode='live';s.hedge.actualPerp=0;s.hedge.lastHedgeAt=null;
    const r=portfolioRisk(s,[lp],expiry,null,now);
    expect(r.rows[0].greeks).toBeNull();expect(r.rows[0].executionDelta).toBe(1.1);
    expect(r.rows.find(r=>r.venue==='Hyperliquid')!.executionDelta).toBeNull();expect(r.total.stale).toBe(true);
  });
  it('counts a reconciled empty perp account without requiring a hedge trade, binding it to its owner', () => {
    const s=state();s.mode='live';s.hedge.actualPerp=0;s.hedge.lastHedgeAt=null;
    s.accounts.hyperliquid={address:'0xabc',verified:true,connectedAt:now};
    s.hedge.accountSnapshot={owner:'0xABC',timestamp:now};
    let row=portfolioRisk(s,[lp],expiry,.2,now).rows.find(r=>r.venue==='Hyperliquid')!;
    expect(row.executionDelta).toBe(0);expect(row.stale).toBe(false);expect(row.timestamp).toBe(now);
    s.accounts.hyperliquid.address='0xother';
    row=portfolioRisk(s,[lp],expiry,.2,now).rows.find(r=>r.venue==='Hyperliquid')!;
    expect(row.executionDelta).toBeNull();expect(row.stale).toBe(true);
  });
  it('calibrates LP IV to fresh nearest-ATM options at the configured horizon', () => {
    const s=state();const base=s.market.instruments[0];s.market.instruments=[{...base,name:'ATM',expiry,strike:100,iv:.6,timestamp:now},
      {...base,name:'wrong expiry',expiry:expiry+1,strike:100,iv:.9,timestamp:now},{...base,name:'OTM',expiry,strike:120,iv:.8,timestamp:now}];
    const m={expiry:0,ivMode:'market' as const,ivPercent:70,daysAhead:0};
    expect(riskInputs(s,m,expiry,now)).toMatchObject({iv:.6,expiry});
    expect(riskInputs(s,m,expiry,now+100000).iv).toBeNull();
    expect(riskInputs(s,{...m,ivMode:'manual',ivPercent:55},expiry,now).iv).toBe(.55);
  });
  it('empty venue totals are zero, missing values are not', () => {
    expect(aggregateRisk([]).executionDelta).toBe(0);
    const rows=portfolioRisk(state(),[lp],expiry,.2,now).rows;
    expect(aggregateRisk([{...rows[0],executionDelta:null}]).executionDelta).toBeNull();
  });
});
