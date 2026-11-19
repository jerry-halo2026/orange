// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** A WebContents belongs permanently to the account generation in which it was created. */
export function createViewGenerationFence(){
  const generations=new WeakMap();
  return Object.freeze({
    register(contents,generation){
      if(!contents||(typeof contents!=='object'&&typeof contents!=='function')||!Number.isSafeInteger(generation)||generation<0)throw Error('invalid-view-generation');
      if(generations.has(contents)&&generations.get(contents)!==generation)throw Error('view-generation-rebind-denied');
      generations.set(contents,generation);
    },
    isCurrent(contents,generation){
      return !!contents&&(typeof contents==='object'||typeof contents==='function')&&Number.isSafeInteger(generation)&&generations.get(contents)===generation;
    },
  });
}
