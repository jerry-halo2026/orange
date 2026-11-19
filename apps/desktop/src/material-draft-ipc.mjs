// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const deny=()=>{throw Object.assign(new Error('authentication-required'),{code:'authentication-required'});};

/** Only current native pages can share untrusted selection intent. It never grants media access. */
export function createMaterialDraftBridge({store,isAllowed,generation,broadcast}){
  function authorize(event,input,keys){
    if(!isAllowed(event)||!exact(input,keys)||!Number.isSafeInteger(input.generation)||input.generation!==generation())deny();
  }
  return Object.freeze({
    read(event,input){
      authorize(event,input,['generation']);
      return store.read({generation:input.generation});
    },
    change(event,input){
      authorize(event,input,['generation','lease','baseRevision','operation']);
      const result=store.change(input);
      if(!result.code&&result.revision!==input.baseRevision){
        try{broadcast({generation:input.generation,revision:result.revision,items:result.items});}catch{/* CAS still prevents silent loss; caller receives its result. */}
      }
      return result;
    },
  });
}
