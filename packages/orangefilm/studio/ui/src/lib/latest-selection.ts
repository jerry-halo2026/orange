// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** Only the latest local source owns the listing; changed or cleared sources abort their previous read. */
export function createLatestSelection<T>(load:(id:string,signal:AbortSignal)=>Promise<T>,publish:(value:T|null)=>void,onError:()=>void) {
  let sequence=0,controller:AbortController|null=null;
  const cancel=()=>{sequence+=1;controller?.abort();controller=null;};
  return {
    async select(id:string):Promise<void> {
      cancel();const request=sequence;
      publish(null);
      if(!id)return;
      const abort=new AbortController();controller=abort;
      try {const value=await load(id,abort.signal);if(request===sequence&&!abort.signal.aborted)publish(value);}
      catch {if(request===sequence&&!abort.signal.aborted)onError();}
      finally {if(controller===abort)controller=null;}
    },
    cancel,
  };
}

export function switchSelectionTab<T>(current:T,next:T,clear:()=>void):boolean {
  if(current===next)return false;
  clear();return true;
}
