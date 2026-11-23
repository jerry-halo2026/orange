// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import React from 'react';
import { createMaterialDraftClient, type MaterialDraftBridge, type MaterialDraftState } from './material-draft-client.ts';
import type { MaterialDraftOperation } from './material-draft.ts';

type AuthEvent={kind:string;uiGeneration?:number};
type NativeDraft={materialDraft?:MaterialDraftBridge;onAuth?:(listener:(event:AuthEvent)=>void)=>()=>void};
const empty=():MaterialDraftState=>({ready:false,revision:null,items:[],reason:'unavailable'});

/** No browser/global-storage fallback: selections exist only in the native account-scoped store. */
export function useMaterialDraft(generation?:number) {
  const [record,setRecord]=React.useState<{generation:number|undefined;state:MaterialDraftState}>(()=>({generation,state:empty()}));
  const current=React.useRef<{generation:number;client:ReturnType<typeof createMaterialDraftClient>}|null>(null);
  React.useEffect(()=>{
    const native=typeof window==='undefined'?undefined:(window as unknown as {openfilmNative?:NativeDraft}).openfilmNative;
    if(!Number.isSafeInteger(generation)||(generation??-1)<0||!native?.materialDraft){
      setRecord({generation,state:empty()});return;
    }
    let live=true,client:ReturnType<typeof createMaterialDraftClient>;
    try{client=createMaterialDraftClient(native.materialDraft,generation!,state=>{if(live)setRecord({generation,state});});}
    catch{setRecord({generation,state:empty()});return;}
    current.current={generation:generation!,client};
    const unsubscribe=native.onAuth?.(event=>{
      const observed=Number.isSafeInteger(event.uiGeneration)&&(event.uiGeneration??-1)>=0?event.uiGeneration!:null;
      if(observed!==null&&observed<generation!)return;
      if(observed!==null&&observed>generation!){client.suspend(true);return;}
      if(event.kind==='signed-out'||event.kind==='revoked')client.suspend(true);
      else if(event.kind!=='active')client.suspend(false);
      else if(observed===generation)void client.resume();
    });
    void client.resume();
    return()=>{live=false;unsubscribe?.();client.dispose();if(current.current?.client===client)current.current=null;};
  },[generation]);
  const state=record.generation===generation?record.state:empty();
  const change=React.useCallback((operation:MaterialDraftOperation)=>{
    const value=current.current;
    return value&&value.generation===generation?value.client.change(operation):Promise.resolve(false);
  },[generation]);
  const retry=React.useCallback(()=>{const value=current.current;return value&&value.generation===generation?value.client.resume():Promise.resolve(false);},[generation]);
  return {...state,change,retry};
}
