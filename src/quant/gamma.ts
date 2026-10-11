import Decimal from 'decimal.js';
import type { FitSettings, OptionInstrument } from '../shared/types';
/** Bounded discrete search: residual tolerance first, executable cost second.
 * Heuristic, not a proof of global feasibility/optimality. No shorts or invented lots. */
export function gammaLots(instruments: OptionInstrument[], unitGamma: number[], required: number, tolerance: number,
  settings: FitSettings, cost: (instrument: OptionInstrument, quantity: number) => { cost: number; fee: number; available: number }) {
  type Candidate = { qs: number[]; gamma: number; cost: number };
  const error = (s: Candidate) => Math.abs(s.gamma-required);
  const rank = (a: Candidate,b: Candidate) => {
    const af=error(a)<=tolerance+1e-10,bf=error(b)<=tolerance+1e-10;
    return af!==bf ? (af?-1:1) : af ? a.cost-b.cost || error(a)-error(b) : error(a)-error(b) || a.cost-b.cost;
  };
  let beam: Candidate[] = [{qs:instruments.map(()=>0),gamma:0,cost:0}], best=beam[0]!;
  for(let leg=0;leg<settings.maxLegs;leg++) {
    const next: Candidate[]=[]; const seen=new Set<string>();
    for(const s of beam) for(let j=0;j<instruments.length;j++) {
      if(s.qs[j] || unitGamma[j]!<=0 || required-s.gamma<=0) continue;
      const i=instruments[j]!, step=new Decimal(i.sizeStep);
      const min=new Decimal(i.minSize).div(step).ceil().mul(step).toNumber();
      const max=new Decimal(cost(i,0).available).div(step).floor().mul(step).toNumber();
      const ideal=(required-s.gamma)/unitGamma[j]!;
      const qs=new Set([min, Math.min(max,new Decimal(ideal).div(step).floor().mul(step).toNumber()), Math.min(max,new Decimal(ideal).div(step).ceil().mul(step).toNumber())]);
      // Include the largest affordable size when a full match exceeds budget.
      let lo=0,hi=Math.floor(max/i.sizeStep);
      while(lo<hi) {const mid=Math.ceil((lo+hi)/2),c=cost(i,new Decimal(mid).mul(step).toNumber());if(c.cost+c.fee+s.cost<=settings.budget+1e-8)lo=mid;else hi=mid-1;}
      qs.add(new Decimal(lo).mul(step).toNumber());
      for(const q of qs) {
        if(q<min-1e-10 || q>max+1e-10 || q<=0) continue;
        const c=cost(i,q), total=s.cost+c.cost+c.fee;
        if(total>settings.budget+1e-8) continue;
        const quantities=[...s.qs];quantities[j]=q;const key=quantities.join(',');if(seen.has(key))continue;seen.add(key);
        const candidate={qs:quantities,gamma:s.gamma+q*unitGamma[j]!,cost:total};
        if(rank(candidate,best)<0)best=candidate;
        next.push(candidate);
      }
    }
    if(!next.length)break;
    // Retain both residual-efficient and cheap partial baskets to allow combinations.
    const close=[...next].sort(rank).slice(0,32), cheap=next.filter(s=>s.gamma<required).sort((a,b)=>a.cost-b.cost).slice(0,32);
    beam=[...close,...cheap];
  }
  return best.qs;
}
