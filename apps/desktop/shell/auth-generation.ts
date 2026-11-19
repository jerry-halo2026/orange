// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** An opaque post-retirement generation fences UI state across accounts without unmounting a temporary lock. */
export function accountPresentation(state: {kind:string;uiGeneration?:number}, chatReady: number | null) {
  const generation = Number.isSafeInteger(state.uiGeneration) && (state.uiGeneration ?? -1) >= 0 ? state.uiGeneration! : 0;
  const active = state.kind === 'active';
  return {active,generation,chatVisible:active && chatReady === generation};
}


type AuthObservation = {kind:string;reason:string|null;uiGeneration?:number};
type NativeProof = {active:boolean;uiGeneration:number};

/** HTTP Auth alone never reveals a previous account's mounted editor or chat. */
export function reconcileHttpAuth(current:AuthObservation,next:AuthObservation,proof:NativeProof|null|undefined):AuthObservation {
  const currentGeneration=Number.isSafeInteger(current.uiGeneration) ? current.uiGeneration! : 0;
  if(!proof||!Number.isSafeInteger(proof.uiGeneration)||proof.uiGeneration<currentGeneration)
    return {kind:'locked',reason:'verification-unconfirmed',uiGeneration:currentGeneration};
  if(next.kind==='active'&&proof.active)return {...next,uiGeneration:proof.uiGeneration};
  if(next.kind!=='active'&&!proof.active)return {...next,uiGeneration:proof.uiGeneration};
  return {kind:'locked',reason:'verification-unconfirmed',uiGeneration:proof.uiGeneration};
}


/** Stale native events never move the UI back to an older account generation. */
export function reconcileNativeAuth(current:AuthObservation,next:AuthObservation):AuthObservation {
  const generation=Number.isSafeInteger(current.uiGeneration)&&(current.uiGeneration??-1)>=0?current.uiGeneration!:0;
  if(next.uiGeneration===undefined)
    return next.kind==='active' ? {kind:'locked',reason:'verification-unconfirmed',uiGeneration:generation} : {...next,uiGeneration:generation};
  if(!Number.isSafeInteger(next.uiGeneration)||next.uiGeneration<0)
    return {kind:'locked',reason:'verification-unconfirmed',uiGeneration:generation};
  if(next.uiGeneration<generation)return current;
  return next;
}


type AuthPublisher = (update:(current:AuthObservation)=>AuthObservation)=>void;

/** Recheck native state for every active event; a newer event invalidates an older in-flight proof. */
export function createAuthEventGate(readProof:()=>Promise<NativeProof|null|undefined>,publish:AuthPublisher) {
  let sequence=0,highestGeneration=0;
  const locked=(current:AuthObservation):AuthObservation=>({kind:'locked',reason:'verification-unconfirmed',uiGeneration:current.uiGeneration});
  const apply=(ticket:number,update:(current:AuthObservation)=>AuthObservation)=> {
    if(ticket===sequence)publish(current=>ticket===sequence?update(current):current);
  };
  return {
    async native(next:AuthObservation):Promise<void> {
      const observed=Number.isSafeInteger(next.uiGeneration)&&(next.uiGeneration??-1)>=0?next.uiGeneration!:null;
      if(observed!==null&&observed<highestGeneration)return;
      if(observed!==null)highestGeneration=observed;
      const ticket=++sequence;
      if(next.kind!=='active'){apply(ticket,current=>reconcileNativeAuth(current,next));return;}
      apply(ticket,locked);
      try {
        const proof=await readProof();
        apply(ticket,current=>proof?.active&&Number.isSafeInteger(next.uiGeneration)&&proof.uiGeneration===next.uiGeneration
          ? reconcileNativeAuth(current,next) : locked(current));
      } catch {apply(ticket,locked);}
    },
    async http(readHttp:()=>Promise<AuthObservation>):Promise<void> {
      const ticket=++sequence;
      apply(ticket,locked);
      try {const next=await readHttp(),proof=await readProof();if(ticket!==sequence)return;if(proof&&Number.isSafeInteger(proof.uiGeneration)&&proof.uiGeneration>=highestGeneration)highestGeneration=proof.uiGeneration;apply(ticket,current=>reconcileHttpAuth(current,next,proof));}
      catch {apply(ticket,locked);}
    },
    dispose():void {sequence+=1;},
  };
}
