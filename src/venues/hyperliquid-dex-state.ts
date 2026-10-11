import { SubscriptionClient, WebSocketTransport } from '@nktkas/hyperliquid';
import type { AllDexsClearinghouseStateEvent } from '@nktkas/hyperliquid/api/subscription';
/** A bounded read-only snapshot, reused for at most 10s; all DEXs share unified collateral. */
const cache=new Map<string,{at:number;states:AllDexsClearinghouseStateEvent['clearinghouseStates']}>();
const pending=new Map<string,Promise<{at:number;states:AllDexsClearinghouseStateEvent['clearinghouseStates']}>>();
export async function readHyperliquidDexStates(user: string, isTestnet: boolean) {
  const key=`${isTestnet}:${user.toLowerCase()}`, old=cache.get(key);
  if(old && Date.now()-old.at<10_000)return old;
  if(pending.has(key))return pending.get(key)!;
  const request=(async()=>{
    const transport=new WebSocketTransport({isTestnet,timeout:10_000,resubscribe:false});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const data=new Promise<AllDexsClearinghouseStateEvent>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Hyperliquid all-DEX account snapshot timed out')),12_000);
      new SubscriptionClient({transport}).allDexsClearinghouseState({user:user as `0x${string}`},event=>{
        if(event.user.toLowerCase()!==user.toLowerCase())return;
        resolve(event);
      }).catch(reject);
    });
    try {
      const event=await data;
      if(!Array.isArray(event.clearinghouseStates) || !event.clearinghouseStates.some(([dex])=>dex==='')) throw new Error('Hyperliquid all-DEX snapshot is missing the main account');
      const value={at:Date.now(),states:event.clearinghouseStates};cache.set(key,value);return value;
    } finally {if(timer)clearTimeout(timer);transport.close();}
  })();
  pending.set(key,request);
  try{return await request;}finally{pending.delete(key);}
}
