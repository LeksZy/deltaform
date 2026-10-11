import {describe,it,expect} from 'vitest';
import {fitHedge} from '../src/quant/fit';
import {demoMarket} from '../src/quant/fixtures';
import {portfolioRisk} from '../src/client/portfolio-risk';
import {Engine, initialState} from '../server/engine';
import {Store} from '../server/store';
import type {FitSettings,Position,OptionInstrument} from '../src/shared/types';
const now=Date.UTC(2026,8,28),expiry=now+365.25*86400000;
const p:Position={id:'lp',name:'SOL',pool:'pool',source:'fixture',base:'SOL',quote:'USDC',snapshotAt:now,poolPrice:100,
  bins:[{id:0,price:100,x:1,y:0}],benchmarkBins:[{id:0,price:100,x:9,y:0}],benchmarkX:9,benchmarkY:0,baseFees:0,quoteFees:0,notes:[]};
const analyticGamma=.3969525475/20; // phi(.1)/(S sigma sqrt(T)) at ATM, sigma=.2, T=1
const settings:FitSettings={expiry,coverage:1,budget:100,maxLegs:2,objective:'gamma',maxUndercoverage:null,
  gamma:{expiry,ivMode:'manual',ivPercent:20,tolerance:.0001}};
function option(name='ATM',gamma=analyticGamma):OptionInstrument {
  return {...demoMarket(now).instruments[0]!,name,expiry,strike:100,timestamp:now,ask:2,asks:[[2,20]],askSize:20,
    minSize:1,sizeStep:1,multiplier:1,feeRate:0,feeModel:undefined,iv:.2,greeks:{delta:.5,gamma,vega:.1,theta:-.01}};
}
describe('current gamma target',()=>{
  it('matches independent ATM analytic LP gamma using current bins, not old benchmark lots',()=>{
    const r=fitHedge([p],[option()],[],settings,100,now);
    expect(r.gammaRisk!.lp).toBeCloseTo(-analyticGamma,9);expect(r.legs[0]!.quantity).toBe(1);
    expect(r.feasible).toBe(true);expect(r.gammaRisk!.after).toBeCloseTo(0,8);
    const s=initialState('paper');s.positions=[p];s.market.referencePrice=100;s.holdings=[];s.hedge.actualPerp=0;
    expect(portfolioRisk(s,[p],expiry,.2,now).total.greeks!.gamma).toBeCloseTo(r.gammaRisk!.before,10);
  });
  it('uses fresh venue Greeks for signed holdings at every expiry and multipliers exactly once',()=>{
    const held={...option('HELD',analyticGamma/4),expiry:expiry+86400000,multiplier:2};
    const candidate=option('BUY',analyticGamma/2);
    const long=fitHedge([p],[candidate,held],[{instrument:{...held,greeks:{...held.greeks!,gamma:9}},quantity:1,averagePrice:1}],settings,100,now);
    expect(long.gammaRisk!.existing).toBeCloseTo(analyticGamma/2);expect(long.legs[0]!.quantity).toBe(1);
    const short=fitHedge([p],[candidate,held],[{instrument:held,quantity:-1,averagePrice:1}],settings,100,now);
    expect(short.legs[0]!.quantity).toBe(3);expect(short.gammaRisk!.after).toBeCloseTo(0,8);
  });
  it('reports no new purchases when already neutral and refuses to solve excess positive gamma with buys',()=>{
    const i=option();const holdings=[{instrument:i,quantity:1,averagePrice:1}];
    const neutral=fitHedge([p],[i],holdings,settings,100,now);expect(neutral.legs).toHaveLength(0);expect(neutral.feasible).toBe(true);
    const excess=fitHedge([p],[i],[{...holdings[0]!,quantity:2}],settings,100,now);expect(excess.feasible).toBe(false);expect(excess.legs).toHaveLength(0);
  });
  it('marks rounding, budget and depth failures instead of calling a residual fit feasible',()=>{
    for(const [i,config] of [[option('large',analyticGamma*2),settings],[option(),{...settings,budget:1}],[{...option(),asks:[[2,.5]],askSize:.5},settings]] as [OptionInstrument,FitSettings][]) {
      const r=fitHedge([p],[i],[],config,100,now);expect(r.feasible).toBe(false);expect(r.gammaRisk!.error).toBeGreaterThan(config.gamma!.tolerance);expect(r.totalCost).toBeLessThanOrEqual(config.budget);
    }
  });
  it('combines legal lots when no one-leg match is possible, while enforcing cardinality',()=>{
    const a={...option('A',analyticGamma*.6),asks:[[2,1]] as [number,number][]},b={...option('B',analyticGamma*.4),asks:[[2,1]] as [number,number][]};
    const r=fitHedge([p],[a,b],[],settings,100,now);expect(r.feasible).toBe(true);expect(r.legs).toHaveLength(2);
    expect(fitHedge([p],[a,b],[],{...settings,maxLegs:1},100,now).feasible).toBe(false);
  });
  it('uses the requested market IV/horizon and refuses missing IV or held gamma rather than using 75%',()=>{
    const r=fitHedge([p],[option()],[],{...settings,gamma:{...settings.gamma!,ivMode:'market',expiry:0}},100,now);
    expect(r.gammaRisk!.iv).toBe(.2);expect(r.gammaRisk!.expiry).toBe(expiry);
    expect(()=>fitHedge([p],[{...option(),iv:null}],[],{...settings,gamma:{...settings.gamma!,ivMode:'market'}},100,now)).toThrow(/IV/);
    expect(()=>fitHedge([p],[option()],[{instrument:{...option('OLD'),timestamp:now-60000},quantity:1,averagePrice:1}],settings,100,now)).toThrow(/Fresh gamma/);
    const partial=fitHedge([p],[option('half',analyticGamma/2)],[],{...settings,coverage:.5},100,now);
    expect(partial.gammaRisk!.target).toBeCloseTo(-analyticGamma/2);expect(partial.feasible).toBe(true);
  });
});

describe('gamma execution revalidation',()=>{
  it('rejects changed venue gamma before buying the exact reviewed basket',()=>{
    const store=new Store(':memory:');
    try {
      const e=new Engine(store),time=Date.now(),horizon=time+365.25*86400000;
      const position={...p,benchmarkBins:p.bins,benchmarkX:1,benchmarkY:0,snapshotAt:time};
      e.state.positions=[position];e.state.selectedIds=[position.id];e.state.holdings=[];
      e.state.market={...demoMarket(time),referencePrice:100,instruments:[{...option(),timestamp:time,expiry:horizon}]};
      const fit=e.quote({...settings,expiry:horizon,gamma:{...settings.gamma!,expiry:horizon}});
      expect(e.validateQuote(fit.id).id).toBe(fit.id);
      e.state.market.instruments[0]!.greeks!.gamma=analyticGamma/2;
      expect(()=>e.validateQuote(fit.id)).toThrow(/outside the reviewed tolerance/);
      e.state.market.instruments[0]!.greeks!.gamma=analyticGamma;
      delete fit.gammaRisk;
      expect(()=>e.validateQuote(fit.id)).toThrow(/calculation changed/);
    } finally {store.close();}
  });
});
