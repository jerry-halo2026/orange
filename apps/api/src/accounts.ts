// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Exact account resolution: `account/list` filtered by one literal, matched exactly, then the
 * `accountKey` is kept in memory only.
 *
 * Rules, all asserted by `accounts.test.ts`:
 *  - one filter field per request (`account` first, `name` only after an empty `account` result),
 *    never a directory scan, never a wildcard, never `pageSize` above the transport's bound;
 *  - only an exact equality on the same field counts as a hit, and only one row may match;
 *  - a found result is cached in process memory with a TTL, and `authorize` is re-checked on
 *    every resolve, so a cache hit cannot outlive a revoked lookup permission;
 *  - `not-found` / `ambiguous` / `disabled` are never cached: an empty answer is a fact about one
 *    moment, not an attribute of the value;
 *  - nothing is written anywhere. The module imports nothing but the error helper, so it has no
 *    filesystem surface and cannot persist an account directory by construction.
 */
import {fail} from './errors.ts';
import type {AccountField,Observation} from './zhishang.ts';

export type AccountLookupResult=
  Readonly<{status:'found';field:AccountField;grants:false;account:Readonly<{account:string;accountKey:Readonly<{value:string;sourceType:'string'|'number';source:string}>;observation:Readonly<Record<string,Observation>>}>}>|
  Readonly<{status:'not-found'|'ambiguous'|'disabled';grants:false}>;

export type AccountResolution=
  Readonly<{status:'found';field:AccountField;accountKey:string;account:string;observation:Readonly<Record<string,Observation>>;cached:boolean}>|
  Readonly<{status:'not-found'|'ambiguous'|'disabled';cached:false}>;

export type AccountResolverDependencies=Readonly<{
  lookup:(context:unknown,request:Readonly<{field:AccountField;value:string}>)=>Promise<AccountLookupResult>;
  authorize:(context:unknown,value:string)=>unknown|Promise<unknown>;
  now?:()=>number;
  ttlMs?:number;
  capacity?:number;
}>;

export type AccountResolver=Readonly<{
  resolve(context:unknown,value:string):Promise<AccountResolution>;
  forget(value:string):void;
  cached():number;
}>;

const TTL_DEFAULT=10*60*1000;
const CAPACITY_DEFAULT=256;
const MAX_TTL=24*60*60*1000;
const exact=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value===value.trim()&&!/[*%\x00-\x1f\x7f]/.test(value);

export function createAccountResolver(dependencies:AccountResolverDependencies):AccountResolver {
  if(!dependencies||typeof dependencies.lookup!=='function'||typeof dependencies.authorize!=='function')return fail('configuration-required');
  const now=dependencies.now??Date.now;
  const ttlMs=Math.min(Math.max(Number(dependencies.ttlMs??TTL_DEFAULT),1),MAX_TTL);
  const capacity=Math.max(Number(dependencies.capacity??CAPACITY_DEFAULT),1);
  // Insertion-ordered map: the first key is the oldest insertion, which is the eviction victim.
  const entries=new Map<string,Readonly<{field:AccountField;accountKey:string;account:string;observation:Readonly<Record<string,Observation>>;expiresAtMs:number}>>();
  const read=()=>{const at=now();if(!Number.isSafeInteger(at)||at<0)return fail('provider-clock-unconfirmed');return at;};
  const forget=(value:string)=>{entries.delete(value);};

  async function resolve(context:unknown,value:string):Promise<AccountResolution> {
    if(!exact(value))return fail('invalid-query',422);
    let allowed:unknown;
    try{allowed=await dependencies.authorize(context,value);}catch{return fail('lookup-not-authorized',403);}
    if(allowed!==true)return fail('lookup-not-authorized',403);
    const at=read(),hit=entries.get(value);
    if(hit&&at<hit.expiresAtMs)return Object.freeze({status:'found' as const,field:hit.field,accountKey:hit.accountKey,account:hit.account,observation:hit.observation,cached:true});
    if(hit)entries.delete(value);

    let result=await dependencies.lookup(context,{field:'account',value});
    if(result.status==='not-found')result=await dependencies.lookup(context,{field:'name',value});
    if(result.status!=='found')return Object.freeze({status:result.status,cached:false as const});
    const entry=Object.freeze({field:result.field,accountKey:result.account.accountKey.value,account:result.account.account,observation:result.account.observation,expiresAtMs:at+ttlMs});
    entries.delete(value);entries.set(value,entry);
    while(entries.size>capacity){const oldest=entries.keys().next();if(oldest.done)break;entries.delete(oldest.value);}
    return Object.freeze({status:'found' as const,field:entry.field,accountKey:entry.accountKey,account:entry.account,observation:entry.observation,cached:false});
  }

  return Object.freeze({resolve,forget,cached:()=>entries.size});
}
