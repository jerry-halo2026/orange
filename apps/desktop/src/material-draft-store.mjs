// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { randomBytes } from 'node:crypto';

const fail=(code)=>{throw Object.assign(new Error(code),{code});};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const exact=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=(value,max,allowEmpty=false)=>typeof value==='string'&&value.length<=max&&(allowEmpty||value.length>0)&&!/[\x00-\x1f\x7f]/.test(value);
const roles=new Set(['video','voice','bgm','intro','outro']);
const keyOf=item=>JSON.stringify(item.source==='local'?['local',item.projectId,item.path]:['cloud',item.videoId]);
function validGroup(value){return text(value,128,true)&&!/[\\/]/.test(value)&&value!=='.'&&value!=='..';}
function validItem(item){
  if(!plain(item)||!roles.has(item.role)||!validGroup(item.group)||!text(item.title,200))return false;
  if(item.source==='local'){
    if(!exact(item,['source','projectId','path','title','mediaKind','role','group'])||!text(item.projectId,512)||/[\\/]/.test(item.projectId)||!text(item.path,2048)||!['video','image','audio'].includes(item.mediaKind))return false;
    const parts=item.path.split('/');
    return parts[0]==='assets'&&parts.length>=2&&parts.every(part=>part&&part!=='.'&&part!=='..'&&!/[\\\x00-\x1f\x7f]/.test(part));
  }
  return item.source==='cloud'&&exact(item,['source','videoId','title','role','group'])&&text(item.videoId,512)&&!/[\\/:]/.test(item.videoId);
}

/** Ephemeral selection intent only. A lease fences stale windows; it grants no material access. */
export function createMaterialDraftStore({createLease=()=>randomBytes(32).toString('base64url')}={}){
  let lease=null,previousLease=null,generation=null,previousGeneration=-1,scope=null,active=false,revision=0,items=[];
  const requireActive=()=>{if(!active||!lease)fail('inactive');};
  const snapshot=()=>({lease,revision,items:items.map(item=>({...item}))});
  return Object.freeze({
    startSession(nextGeneration,nextScope){
      if(lease!==null)fail('session-exists');
      if(!Number.isSafeInteger(nextGeneration)||nextGeneration<=previousGeneration)fail('stale-session');
      if(typeof nextScope!=='string'||!/^[a-f0-9]{64}$/.test(nextScope))fail('invalid-session');
      const next=createLease();
      if(!text(next,256)||next===previousLease)fail('invalid-session');
      lease=next;generation=nextGeneration;scope=nextScope;active=true;revision=0;items=[];
    },
    lock(){active=false;},
    resume(currentGeneration,currentScope){if(!lease||currentGeneration!==generation||currentScope!==scope)fail('inactive');active=true;},
    retire(){active=false;if(lease!==null)previousLease=lease;if(generation!==null)previousGeneration=generation;lease=null;generation=null;scope=null;revision=0;items=[];},
    read(input){requireActive();if(!exact(input,['generation'])||input.generation!==generation)fail('stale-session');return snapshot();},
    change(input){
      requireActive();
      if(!exact(input,['generation','lease','baseRevision','operation'])||input.generation!==generation||typeof input.lease!=='string'||input.lease!==lease)fail('stale-session');
      if(!Number.isSafeInteger(input.baseRevision)||input.baseRevision<0)fail('invalid-draft');
      if(input.baseRevision!==revision)return {code:'revision-conflict'};
      const op=input.operation;
      if(!plain(op)||typeof op.type!=='string')fail('invalid-draft');
      if(op.type==='add'){
        if(!exact(op,['type','item'])||!validItem(op.item))fail('invalid-draft');
        if(!items.some(item=>keyOf(item)===keyOf(op.item))){if(items.length>=10000)fail('invalid-draft');items=[...items,{...op.item}];revision++;}
      }else if(op.type==='remove'){
        if(!exact(op,['type','key'])||!text(op.key,4096))fail('invalid-draft');
        const next=items.filter(item=>keyOf(item)!==op.key);if(next.length!==items.length){items=next;revision++;}
      }else if(op.type==='setRole'||op.type==='setGroup'){
        const field=op.type==='setRole'?'role':'group';
        if(!exact(op,['type','key',field])||!text(op.key,4096)||(field==='role'?!roles.has(op.role):!validGroup(op.group)))fail('invalid-draft');
        const index=items.findIndex(item=>keyOf(item)===op.key);if(index<0)fail('invalid-draft');
        if(items[index][field]!==op[field]){items=items.map((item,i)=>i===index?{...item,[field]:op[field]}:item);revision++;}
      }else if(op.type==='clear'){
        if(!exact(op,['type']))fail('invalid-draft');
        if(items.length){items=[];revision++;}
      }else fail('invalid-draft');
      return snapshot();
    },
  });
}
