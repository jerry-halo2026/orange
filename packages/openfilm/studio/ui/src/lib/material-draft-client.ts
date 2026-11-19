// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { isMaterialDraftReference, materialDraftKey, type MaterialDraftOperation, type MaterialDraftReference } from './material-draft.ts';

type Snapshot={lease:string;revision:number;items:MaterialDraftReference[]};
type Event={generation:number;revision:number;items:MaterialDraftReference[]};
export interface MaterialDraftBridge {
  read(input:{generation:number}):Promise<unknown>;
  change(input:{generation:number;lease:string;baseRevision:number;operation:MaterialDraftOperation}):Promise<unknown>;
  onChange(listener:(event:unknown)=>void):()=>void;
}
export interface MaterialDraftState {ready:boolean;revision:number|null;items:MaterialDraftReference[];reason:'unavailable'|'conflict'|null}

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const revisionOf=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
function itemsOf(value:unknown):MaterialDraftReference[]|null {
  if(!Array.isArray(value)||value.length>10000||!value.every(isMaterialDraftReference))return null;
  const copy=value.map(item=>({...item})),keys=copy.map(materialDraftKey);
  return new Set(keys).size===keys.length?copy:null;
}
function snapshotOf(value:unknown):Snapshot|null {
  if(!object(value)||Object.keys(value).sort().join()!=='items,lease,revision'||typeof value.lease!=='string'||!/^[A-Za-z0-9_-]{16,256}$/.test(value.lease)||!revisionOf(value.revision))return null;
  const items=itemsOf(value.items);return items?{lease:value.lease,revision:value.revision,items}:null;
}
function eventOf(value:unknown,generation:number):Event|null {
  if(!object(value)||Object.keys(value).sort().join()!=='generation,items,revision'||value.generation!==generation||!revisionOf(value.revision))return null;
  const items=itemsOf(value.items);return items?{generation,revision:value.revision,items}:null;
}

/** In-memory client. The lease is never returned in UI state or persisted by the renderer. */
export function createMaterialDraftClient(bridge:MaterialDraftBridge,generation:number,publish:(state:MaterialDraftState)=>void) {
  let lease:string|null=null,boundLease:string|null=null,revision=-1,items:MaterialDraftReference[]=[],ready=false,closed=false,accepting=false,epoch=0,readSequence=0;
  let buffered:Event|null=null,bufferConflict=false,queue:Promise<void>=Promise.resolve();
  const emit=(reason:MaterialDraftState['reason']=null)=>{if(!closed)publish({ready,revision:revision<0?null:revision,items:items.map(item=>({...item})),reason});};
  const same=(a:MaterialDraftReference[],b:MaterialDraftReference[])=>a.length===b.length&&a.every((item,index)=>{const other=b[index];return !!other&&materialDraftKey(item)===materialDraftKey(other)&&item.title===other.title&&item.role===other.role&&item.group===other.group&&(item.source!=='local'||other.source==='local'&&item.mediaKind===other.mediaKind);});
  const apply=(next:{revision:number;items:MaterialDraftReference[]})=>{
    if(next.revision<revision)return true;
    if(next.revision===revision&&!same(items,next.items))return false;
    revision=next.revision;items=next.items.map(item=>({...item}));return true;
  };
  const fail=(reason:MaterialDraftState['reason'])=>{ready=false;emit(reason);};
  const unsubscribe=bridge.onChange(raw=>{
    if(closed||!accepting)return;
    const event=eventOf(raw,generation);if(!event)return;
    if(!lease){if(!buffered||event.revision>buffered.revision){buffered=event;bufferConflict=false;}else if(event.revision===buffered.revision&&!same(buffered.items,event.items))bufferConflict=true;return;}
    if(!apply(event)){lease=null;revision=-1;items=[];buffered=null;fail('unavailable');return;}
    emit();
  });
  async function reload():Promise<boolean>{
    const ticket=epoch,read=++readSequence;
    try {
      const next=snapshotOf(await bridge.read({generation}));
      if(closed||!accepting||ticket!==epoch||read!==readSequence)return false;
      if(!next||boundLease!==null&&next.lease!==boundLease){lease=null;items=[];revision=-1;buffered=null;fail('unavailable');return false;}
      boundLease=next.lease;lease=next.lease;
      if(bufferConflict||!apply(next)||buffered&&!apply(buffered)){lease=null;items=[];revision=-1;buffered=null;bufferConflict=false;fail('unavailable');return false;}
      buffered=null;bufferConflict=false;ready=true;emit();return true;
    } catch {
      if(!closed&&ticket===epoch&&read===readSequence){lease=null;fail('unavailable');}
      return false;
    }
  }
  function suspend(clear:boolean):void {
    epoch+=1;readSequence+=1;accepting=false;ready=false;lease=null;buffered=null;bufferConflict=false;
    if(clear){revision=-1;items=[];}
    emit('unavailable');
  }
  function change(operation:MaterialDraftOperation):Promise<boolean>{
    let frozen:MaterialDraftOperation;try{frozen=structuredClone(operation);}catch{return Promise.resolve(false);}
    const ticket=epoch;
    const work=queue.then(async()=>{
      if(closed||!ready||!lease||ticket!==epoch)return false;
      const expectedLease=lease;
      for(let attempt=0;attempt<2;attempt++){
        let raw:unknown;
        try{raw=await bridge.change({generation,lease:expectedLease,baseRevision:revision,operation:frozen});}
        catch{if(!closed&&ticket===epoch){lease=null;fail('unavailable');}return false;}
        if(closed||ticket!==epoch||lease!==expectedLease)return false;
        if(object(raw)&&raw.code==='revision-conflict'){
          if(attempt===1){if(await reload())emit('conflict');else fail('conflict');return false;}
          if(!await reload()||closed||ticket!==epoch||lease!==expectedLease)return false;
          continue;
        }
        const next=snapshotOf(raw);
        if(!next||next.lease!==expectedLease||!apply(next)){lease=null;items=[];revision=-1;fail('unavailable');return false;}
        emit();return true;
      }
      return false;
    });
    queue=work.then(()=>undefined,()=>undefined);
    return work;
  }
  return Object.freeze({
    async resume(){if(closed)return false;accepting=true;return reload();},
    suspend,
    change,
    dispose(){if(closed)return;closed=true;epoch+=1;readSequence+=1;accepting=false;lease=null;boundLease=null;items=[];buffered=null;bufferConflict=false;unsubscribe();},
  });
}
