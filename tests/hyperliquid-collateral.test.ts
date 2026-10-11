import {afterEach,describe,expect,it,vi} from 'vitest';
import {normalizeHyperliquidCollateral} from '../src/venues/hyperliquid-collateral';
vi.mock('../src/venues/hyperliquid-dex-state',()=>({readHyperliquidDexStates:vi.fn()}));
import {readHyperliquidDexStates} from '../src/venues/hyperliquid-dex-state';
import {getHyperliquidAccount} from '../src/venues/hyperliquid';
import {Engine,initialState} from '../server/engine';
import {Store} from '../server/store';
const state={assetPositions:[],marginSummary:{accountValue:'0',totalMarginUsed:'0'},withdrawable:'0'};
const spot=(total='548.020001',hold='0')=>({balances:[{coin:'USDC',token:0,total,hold}]});
afterEach(()=>vi.unstubAllGlobals());
describe('Hyperliquid collateral by account mode',()=>{
  it('uses canonical shared USDC for unified mode when the legacy perp summary is zero',()=>{
    const r=normalizeHyperliquidCollateral('unifiedAccount',state,spot(),123);
    expect(r).toMatchObject({equity:548.020001,policyCollateral:548.020001,source:'shared USDC balance',timestamp:123});
  });
  it('counts unified money once even when legacy accountValue reports a duplicate value',()=>{
    expect(normalizeHyperliquidCollateral('unifiedAccount',{...state,marginSummary:{accountValue:'548.020001'}},spot()).equity).toBe(548.020001);
  });
  it('does not use ordinary spot USDC as standard-mode perpetual collateral',()=>{
    for(const mode of ['disabled','default','dexAbstraction']) {
      expect(normalizeHyperliquidCollateral(mode,state,spot()).equity).toBe(0);
      expect(normalizeHyperliquidCollateral(mode,{...state,marginSummary:{accountValue:'123'}},spot()).equity).toBe(123);
    }
  });
  it('reserves spot holds but allows own cross SOL margin to fund the whole desired exposure',()=>{
    expect(normalizeHyperliquidCollateral('unifiedAccount',state,spot('500','200')).policyCollateral).toBe(300);
    const own={...state,assetPositions:[{position:{coin:'SOL',marginUsed:'150',leverage:{type:'cross'}}}]};
    const r=normalizeHyperliquidCollateral('unifiedAccount',own,spot('500','200'));
    expect(r.equity).toBe(500);expect(r.policyCollateral).toBe(450);
  });
  it('rejects unknown and portfolio-margin modes instead of assuming spot collateral can fund a trade',()=>{
    for(const mode of [null,'portfolioMargin','newMode']) expect(()=>normalizeHyperliquidCollateral(mode,state,spot())).toThrow(/Unsupported account abstraction/);
  });
  it('rejects malformed, duplicate, wrong-token and negative shared balances',()=>{
    for(const s of [spot('bad'),spot('500','bad'),spot('-1'),spot('500','-1'),{balances:[...spot().balances,...spot().balances]}, {balances:[{coin:'USDC',token:5,total:'500',hold:'0'}]}]) {
      expect(()=>normalizeHyperliquidCollateral('unifiedAccount',state,s)).toThrow();
    }
    expect(normalizeHyperliquidCollateral('unifiedAccount',state,{balances:[]}).equity).toBe(0);
  });
  it('queries account mode instead of substituting a spot balance when the mode endpoint fails',async()=>{
    const calls:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async (_url:unknown,init:RequestInit)=>{
      const type=JSON.parse(String(init.body)).type;calls.push(type);
      if(type==='userAbstraction')return {ok:false,status:503};
      return {ok:true,json:async()=> type==='clearinghouseState'?state:type==='spotClearinghouseState'?spot():[]};
    }));
    await expect(getHyperliquidAccount('0x1111111111111111111111111111111111111111')).rejects.toThrow();
    expect(calls).toContain('userAbstraction');
  });
  it('uses shared equity for NAV and owner-bound usable collateral for hedge policy without adding spot twice',()=>{
    const store=new Store(':memory:');
    try{
      const e=new Engine(store);e.state=initialState('live');
      const owner='0xabc';e.state.accounts.hyperliquid={address:owner,verified:true,connectedAt:1};
      e.state.balances.collateral=500;e.state.hyperliquidCollateral={...normalizeHyperliquidCollateral('unifiedAccount',state,spot('500','200')),owner};
      expect(e.effectiveCollateral()).toBe(500);expect(e.marginCollateral()).toBe(300);
      e.state.accounts.hyperliquid.address='0xother';expect(e.marginCollateral()).toBe(500);
    }finally{store.close();}
  });
});

describe('shared collateral account boundary',()=>{
  function responses() {
    vi.stubGlobal('fetch',vi.fn(async (_url:unknown,init:RequestInit)=>{
      const type=JSON.parse(String(init.body)).type;
      return {ok:true,json:async()=>type==='userAbstraction'?'unifiedAccount':type==='clearinghouseState'?state:type==='spotClearinghouseState'?spot():[]};
    }));
  }
  it('reads unified collateral and uses an all-DEX snapshot without a fund transfer',async()=>{
    responses();vi.mocked(readHyperliquidDexStates).mockResolvedValue({at:Date.now(),states:[['',state as any]]});
    const account=await getHyperliquidAccount('0x1111111111111111111111111111111111111111');
    expect(account.equity).toBe(548.020001);expect(account.collateralInfo.mode).toBe('unifiedAccount');
    const types=vi.mocked(fetch).mock.calls.map(c=>JSON.parse(String(c[1]?.body)).type);
    expect(types).toHaveLength(6);expect(types).not.toContain('usdClassTransfer');
  });
  it('rejects another DEX position sharing the balance',async()=>{
    responses();vi.mocked(readHyperliquidDexStates).mockResolvedValue({at:Date.now(),states:[['',state as any],['xyz',{...state,assetPositions:[{position:{coin:'xyz:ABC',szi:'1'}}]} as any]]});
    await expect(getHyperliquidAccount('0x1111111111111111111111111111111111111111')).rejects.toThrow(/Other DEX exposure/);
  });
  it('reconciles collateral while automation is paused without invoking execution',async()=>{
    const store=new Store(':memory:');
    try {
      const e=new Engine(store);e.state=initialState('live');
      const owner='0xabc';e.state.accounts.hyperliquid={address:owner,verified:true,connectedAt:1};
      const order=vi.fn();e.gateway={portfolio:vi.fn(async()=>({positions:e.state.positions,holdings:[],actualPerp:0,collateral:548.020001,entryPrice:0,accountTimestamp:Date.now(),collateralInfo:{...normalizeHyperliquidCollateral('unifiedAccount',state,spot()),owner}})),order} as any;
      const result=await e.reconcilePortfolio();
      expect(result.balances.collateral).toBe(548.020001);expect(result.hedge.enabled).toBe(false);expect(order).not.toHaveBeenCalled();
    }finally {store.close();}
  });
});
