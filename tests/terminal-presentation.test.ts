import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { initialState } from '../server/engine';
import { AccountStrip, OptionExecutionStatus } from '../src/client/App';

describe('trader account and execution states', () => {
  it('keeps unavailable P&L and collateral distinct from zero with accessible explanations', () => {
    const state = initialState('live');
    state.activeUnderlying = 'SOL';
    state.accounting = { ...state.accounting!, equity:null, pnl:null, pnlUnavailableReason:'A capital baseline is required' };
    const html = renderToStaticMarkup(createElement(AccountStrip,{state,connectionError:'',lastPoll:Date.now(),action:async()=>{},busy:[],settings:()=>{}}));
    expect(html).toContain('A capital baseline is required');
    expect(html).toContain('HL margin headroom');
    expect(html).not.toContain('$0.00');
    expect(html).toContain('Pause All');
    expect(html).toContain('Venue connections');
  });
  it('retains incomplete execution after fit invalidation and does not show another asset’s error', () => {
    const state = initialState('paper'); state.activeUnderlying='SOL'; state.fit=null;
    state.events=[{id:'s',type:'options-order-stopped',timestamp:100,message:'SOL order unresolved. Reconcile first.',data:{underlying:'SOL'}},
      {id:'b',type:'options-reconciled',timestamp:200,message:'BTC outcomes reconciled',data:{underlying:'BTC'}}];
    const html=renderToStaticMarkup(createElement(OptionExecutionStatus,{state}));
    expect(html).toContain('Last options execution incomplete');
    expect(html).toContain('SOL order unresolved');
    expect(html).not.toContain('BTC outcomes');
    state.events.push({id:'r',type:'options-reconciled',timestamp:300,message:'Unsubmitted quantities can be re-quoted.',data:{underlying:'SOL'}});
    const reconciled=renderToStaticMarkup(createElement(OptionExecutionStatus,{state}));
    expect(reconciled).toContain('Fills reconciled; review remaining hedge');
    expect(reconciled).not.toContain('execution incomplete');
    expect(reconciled).not.toContain('fully filled');
  });
});
