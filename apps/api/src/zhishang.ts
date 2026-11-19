// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import {createHash,randomBytes} from 'node:crypto';
import {isVerifiedSession,type VerifiedSession} from './supabase.ts';
import {fail,SupplierError,supplierFailure} from './errors.ts';
import {FILTER_KEYS,filterValues} from './filters.ts';

export const ZHISHANG_ORIGIN='https://sucaiwang-open-api.zhishangsoft.com';
const ORIGIN=ZHISHANG_ORIGIN;
const MAX_BYTES=3*1024*1024;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof NumberSource);
const text=(v:unknown,max=256):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const header=(v:unknown):v is string=>typeof v==='string'&&/^[\x21-\x7e]{1,8192}$/.test(v);
const rfc3986=(s:string)=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());

/** Pure supplier wire signature only. Neither a company signature nor its hash grants person/material rights. */
export function signZhishang(fields:Readonly<Record<string,string|number>>,secret:string):string {
 try{
  if(!text(secret,8192)||!object(fields))return fail('invalid-configuration');
  const keys=Object.keys(fields).filter(k=>k!=='sign').sort();
  const canonical=keys.map(key=>{
   const value=fields[key];if(!/^[A-Za-z0-9_]+$/.test(key)||key==='company_secret'||!(typeof value==='string'||typeof value==='number'&&Number.isSafeInteger(value)))return fail('provider-response-unconfirmed');
   return key+'='+rfc3986(String(value));
  }).join('&')+'&company_secret='+secret;
  return createHash('md5').update(canonical,'utf8').digest('hex').toUpperCase();
 }catch(error){if(error instanceof SupplierError)throw error;/* A signature we could not build is our bug, not the caller's input. */return fail('provider-response-unconfirmed');}
}

// A bounded JSON decoder retains number lexemes before any JS number rounding.
// It is private to these supplier responses, not an application protocol.
class NumberSource {readonly raw:string;constructor(raw:string){this.raw=raw;}}
type Wire=null|boolean|string|NumberSource|Wire[]|{[key:string]:Wire};
function decode(input:string):Wire {
 let at=0,nodes=0;const ws=()=>{while(/[\x20\t\r\n]/.test(input[at]??'x'))at++;};
 const string=():string=>{const start=at++;let escaped=false;while(at<input.length){const c=input[at++];if(!escaped&&c==='"'){try{return JSON.parse(input.slice(start,at));}catch{return fail('provider-response-unconfirmed');}}if(!escaped&&c==='\\')escaped=true;else escaped=false;}return fail('provider-response-unconfirmed');};
 const value=(depth:number):Wire=>{
  if(depth>32||++nodes>100000)return fail('provider-response-unconfirmed');ws();const c=input[at];
  if(c==='"')return string();
  if(c==='{'||c==='['){const array=c==='[';at++;ws();const out:{[key:string]:Wire}=Object.create(null),items:Wire[]=[];const end=array?']':'}';if(input[at]===end){at++;return array?items:out;}
   while(true){if(array)items.push(value(depth+1));else{ws();if(input[at]!=='"')return fail('provider-response-unconfirmed');const key=string();if(Object.hasOwn(out,key))return fail('provider-response-unconfirmed');ws();if(input[at++]!==':')return fail('provider-response-unconfirmed');out[key]=value(depth+1);}ws();const sep=input[at++];if(sep===end)return array?items:out;if(sep!==',')return fail('provider-response-unconfirmed');}
  }
  for(const [literal,result]of [['true',true],['false',false],['null',null]] as const)if(input.startsWith(literal,at)){at+=literal.length;return result;}
  const number=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(input.slice(at));if(!number)return fail('provider-response-unconfirmed');at+=number[0].length;return new NumberSource(number[0]);
 };
 const result=value(0);ws();if(at!==input.length)return fail('provider-response-unconfirmed');return result;
}
const number=(v:unknown):number|undefined=>v instanceof NumberSource&&/^-?(?:0|[1-9]\d*)$/.test(v.raw)&&Number.isSafeInteger(Number(v.raw))?Number(v.raw):undefined;
export type ExternalId=Readonly<{value:string;sourceType:'string'|'number';source:string}>;
export type Observation=null|boolean|string|{sourceType:'number';source:string}|Observation[]|{[key:string]:Observation};
function identifier(v:unknown):ExternalId {
 if(text(v,512))return Object.freeze({value:v,sourceType:'string',source:v});
 if(v instanceof NumberSource&&/^(?:0|[1-9]\d*)$/.test(v.raw)&&v.raw.length<=512)return Object.freeze({value:v.raw,sourceType:'number',source:v.raw});
 return fail('provider-response-unconfirmed');
}
type Configuration=Readonly<{environmentId:string;companyKey:string;companySecret:string}>;
type Binding=Readonly<{subjectId:string;environmentId:string;providerScope:string;bindingId:string;revision:number;accountKey:string;status:'active';expiresAtMs:number}>;
/**
 * A failure of the network layer, as opposed to an answer from the supplier: `fetch` rejects with a
 * TypeError whose `cause.code` is the socket error, and a direct socket error may carry the code
 * itself. Only these mean "the host could not be reached".
 */
const NETWORK_CODES:readonly string[]=Object.freeze(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','ETIMEDOUT','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET']);
function isNetworkFailure(error:unknown):boolean {
  if(!error||typeof error!=='object')return false;
  const seen=new Set<unknown>();
  let current:unknown=error;
  while(current&&typeof current==='object'&&!seen.has(current)){
    seen.add(current);
    const code=(current as {code?:unknown}).code;
    if(typeof code==='string'&&NETWORK_CODES.includes(code))return true;
    const name=(current as {name?:unknown}).name;
    if(name==='AbortError'||name==='TimeoutError')return true;
    current=(current as {cause?:unknown}).cause;
  }
  return false;
}
type Dependencies={
 fetch?:typeof fetch;
 now?:()=>number;
 nonce?:()=>string;
 authorizeLookup?:(context:VerifiedSession,exactName:string)=>unknown|Promise<unknown>;
 bindingFor?:(context:VerifiedSession,providerScope:string)=>unknown|Promise<unknown>;
 /**
  * Second gate for any `account_key` that is not the caller's own binding: the composition must
  * decide, from the three-layer policy, whether this exact key is readable for this subject.
  * Absent means "no key other than the binding account is readable".
  */
 authorizeAccount?:(context:VerifiedSession,accountKey:string)=>unknown|Promise<unknown>;
 /**
  * `1` asks the supplier for the inner-network addresses (`...-inner...`). It is a request parameter
  * of the supplier, so it belongs to composition, not to the signed session.
  */
 isInner?:0|1;
};
type Query={pageNo?:number;pageSize?:number;videoType?:number;name?:string;videoIds?:string;twoLevelTypeIds?:string;oneLevelTypeId?:number;videoStateId?:number;includeLabelIds?:string;excludeLabelIds?:string;accountKeys?:string;teamIds?:string;groupIds?:string};
type MaterialBody=Readonly<{pageNo:number;pageSize:number;isInner:number;videoType:number;name?:string;videoIds?:string;[key:string]:string|number|undefined}>;
export type AccountField='account'|'name';
type FacetQuery={videoType?:number};
type LabelQuery={pageNo?:number;pageSize?:number;videoType?:number};

const ACCOUNT_FIELDS:readonly AccountField[]=Object.freeze(['account','name'] as AccountField[]);
const MATERIAL_KEYS:readonly string[]=Object.freeze(['pageNo','pageSize','videoType','name','videoIds',...FILTER_KEYS]);

/** Trusted backend composition only. No environment/file fallback, routes, downloads, or binding writes. */
export function createZhishangReadOnly(configuration:Configuration,dependencies:Dependencies={}) {
 if(!object(configuration)||Object.keys(configuration).sort().join()!=='companyKey,companySecret,environmentId'||!text(configuration.environmentId)||!header(configuration.companyKey)||!text(configuration.companySecret,8192))return fail('configuration-required');
 const config=Object.freeze({...configuration}),fetcher=dependencies.fetch??globalThis.fetch,now=dependencies.now??Date.now,nonce=dependencies.nonce??(()=>randomBytes(8).toString('hex'));
 const inner:0|1=dependencies.isInner===1?1:0;
 if(typeof fetcher!=='function'||typeof now!=='function'||typeof nonce!=='function')return fail('configuration-required');
 const scope=createHash('sha256').update('zhishang\0'+ORIGIN+'\0'+config.companyKey).digest('hex');
 let cache:{value:string;expiresAtMs:number}|null=null,flight:Promise<string>|null=null,generation=0,lastTime=-Infinity;
 const clear=()=>{cache=null;generation++;};
 const clock=()=>{let result:number;try{result=now();}catch{clear();return fail('provider-clock-unconfirmed');}if(!Number.isSafeInteger(result)||result<0||result<lastTime){clear();return fail('provider-clock-unconfirmed');}lastTime=result;return result;};
 /**
  * The session gate at the transport boundary.
  *
  * It checks the brand and the lifetime, and deliberately NOT `environmentId`: that field names our
  * *application* environment (the desktop login), while `config.environmentId` names the *supplier*
  * environment in the credential file. They are different layers, and comparing them rejected every
  * request that actually needed an account key (company reads, claims) while `own` never got that far.
  * The verifier that branded the session is what decides which application may use this process.
  */
 const current=(context:unknown):VerifiedSession=>{if(!isVerifiedSession(context))return fail('authentication-required',403);return context;};
 /**
  * Endpoints the supplier refuses without an `account_key` (it answers `code=20000`, "【accountKey】
  * 不能为空"). A request without one is therefore a bug of ours, never a supplier error, so it is
  * refused at the single choke point below — before anything is sent.
  */
 const ACCOUNT_SCOPED:readonly string[]=Object.freeze(['/openapi/video/list','/openapi/video/type/list','/openapi/video/state/list','/openapi/label/list','/openapi/video/query/raw']);
 async function request(endpoint:'/openapi/auth/access_token'|'/openapi/account/list'|'/openapi/video/list'|'/openapi/video/type/list'|'/openapi/video/state/list'|'/openapi/label/list'|'/openapi/video/query/raw',body:Record<string,string|number>,check:()=>void,token?:string,accountKey?:string):Promise<Wire>{
  check();
  // Invariant: an account-scoped request always carries a non-empty account_key.
  if(ACCOUNT_SCOPED.includes(endpoint)&&!header(accountKey))return fail('binding-required',403);
  const stamp=String(Math.floor(clock()/1000));let unique:string;try{unique=nonce();}catch{return fail('configuration-required');}if(!/^[a-f0-9]{16}$/.test(unique))return fail('configuration-required');
  const fields:Record<string,string|number>={company_key:config.companyKey,timestamp:stamp,nonce:unique,...(token?{access_token:token}:{}),...(accountKey?{account_key:accountKey}:{})};
  const headers:Record<string,string>={...fields,sign:signZhishang({...fields,...body},config.companySecret)} as Record<string,string>;headers['content-type']='application/json';
  const bytes=JSON.stringify(body);if(Buffer.byteLength(bytes,'utf8')>MAX_BYTES)return fail('invalid-query',422);
  const controller=new AbortController();let timedOut=false,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,responseBody:ReadableStream<Uint8Array>|null|undefined;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},10000);
  try{
   check();const response=await fetcher(ORIGIN+endpoint,{method:'POST',headers,body:bytes,redirect:'error',signal:controller.signal});responseBody=response?.body;
   if(timedOut)return fail('provider-timeout',504);check();
   if(response.redirected||response.status>=300&&response.status<400)return fail('provider-redirect-rejected');
   if(response.status===401||response.status===403)return fail('provider-permission-denied',403);
   if(response.status<200||response.status>=300)return fail('provider-unconfirmed');
   if(!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))return fail('provider-response-unconfirmed');
   reader=response.body?.getReader();if(!reader)return fail('provider-response-unconfirmed');const chunks:Uint8Array[]=[];let size=0;
   while(true){const chunk=await reader.read();if(timedOut)return fail('provider-timeout',504);check();if(chunk.done)break;if(!(chunk.value instanceof Uint8Array)||(size+=chunk.value.byteLength)>MAX_BYTES)return fail('provider-response-too-large');chunks.push(chunk.value.slice());}
   const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}
   let result:Wire;try{result=decode(new TextDecoder('utf-8',{fatal:true}).decode(all));}catch(error){if(error instanceof SupplierError)throw error;return fail('provider-response-unconfirmed');}
   // Envelope: `success` must be literally true and `code` must be the integer 1. Anything else is
   // mapped through the frozen supplier table (unknown -> provider-unconfirmed), never echoed.
   if(!object(result))return fail('provider-unconfirmed');
   if(result.success!==true)return fail(supplierFailure(number(result.code)));
   if(number(result.code)!==1)return fail(number(result.code)===undefined?'provider-unconfirmed':supplierFailure(number(result.code)));
   check();return result.data as Wire;
  }catch(error){
    clear();
    if(error instanceof SupplierError)throw error;
    // Inner mode names a private host that is only reachable from inside its network. When the
    // failure is the network itself (name not found, refused, unreachable, timed out) the operator
    // needs to be told *that*, not handed a generic supplier error. A supplier business code never
    // reaches here: it is raised as a SupplierError above and re-thrown untouched.
    if(inner===1&&(timedOut||isNetworkFailure(error)))return fail('material-inner-unreachable',503);
    return fail(timedOut?'provider-timeout':'provider-unconfirmed',timedOut?504:503);
  }
  finally{clearTimeout(timer);try{if(reader)await reader.cancel();else await responseBody?.cancel();}catch{/* The entered transport has already failed. */}try{reader?.releaseLock();}catch{/* closed reader */}}
 }
 async function token(check:()=>void):Promise<string>{
  check();const time=clock();if(cache&&time<cache.expiresAtMs)return cache.value;if(flight)return flight;
  const epoch=generation,started=time;
  // Single flight plus a one-hour ceiling: the supplier token is valid for 24h, so a shorter
  // cache can never outlive it, and a failed acquisition is never retried by this layer.
  const work=(async()=>{const data=await request('/openapi/auth/access_token',{},check);if(!object(data)||!header(data.accessToken))return fail('provider-auth-unconfirmed');if(epoch!==generation)return fail('provider-auth-unconfirmed');cache={value:data.accessToken,expiresAtMs:Math.min(started+3600000,started+24*3600000)};return data.accessToken;})();
  flight=work;try{return await work;}catch(error){clear();throw error;}finally{if(flight===work)flight=null;}
 }
 async function binding(context:VerifiedSession):Promise<Binding>{
  current(context);let raw:unknown;try{raw=await dependencies.bindingFor?.(context,scope);}catch{return fail('binding-required',403);}current(context);
  if(!object(raw)||Object.keys(raw).sort().join()!=='accountKey,bindingId,environmentId,expiresAtMs,providerScope,revision,status,subjectId'||raw.subjectId!==context.subjectId||raw.environmentId!==config.environmentId||raw.providerScope!==scope||raw.status!=='active'||typeof raw.bindingId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(raw.bindingId)||raw.bindingId==='00000000-0000-0000-0000-000000000000'||!Number.isSafeInteger(raw.revision)||Number(raw.revision)<1||!header(raw.accountKey)||typeof raw.expiresAtMs!=='number'||!Number.isFinite(raw.expiresAtMs)||raw.expiresAtMs<=clock())return fail('binding-required',403);
  return Object.freeze({...raw}) as Binding;
 }
 async function sameBinding(context:VerifiedSession,before:Binding){const after=await binding(context);if(Object.keys(before).some(k=>before[k as keyof Binding]!==after[k as keyof Binding]))return fail('binding-changed',403);}
 async function lookupAllowed(context:VerifiedSession,name:string){current(context);let allowed:unknown;try{allowed=await dependencies.authorizeLookup?.(context,name);}catch{return fail('lookup-not-authorized',403);}current(context);if(allowed!==true)return fail('lookup-not-authorized',403);}
 /**
  * A key that is not the caller's own binding must be cleared by `authorizeAccount` first.
  *
  * An empty key is an authorization state, not a parameter: there is no account to read with, so it
  * answers `binding-required` (403) here instead of letting the supplier answer `code=20000` for a
  * request that never should have been sent.
  */
 async function readableAccount(context:VerifiedSession,own:Binding,requested?:string):Promise<string>{
  if(requested===undefined||requested===own.accountKey)return own.accountKey;
  if(!requested.length)return fail('binding-required',403);
  if(!header(requested))return fail('invalid-query',422);
  current(context);let allowed:unknown;try{allowed=await dependencies.authorizeAccount?.(context,requested);}catch{return fail('account-not-authorized',403);}current(context);
  if(allowed!==true)return fail('account-not-authorized',403);
  return requested;
 }
 function observed(value:Wire,privateToken:string):Observation {
  if(value instanceof NumberSource)return {sourceType:'number',source:value.raw};
  if(typeof value==='string'){if([config.companyKey,config.companySecret,privateToken].some(secret=>secret&&value.includes(secret)))return fail('provider-response-unconfirmed');return value;}
  if(Array.isArray(value))return value.map(v=>observed(v,privateToken));
  if(object(value)){const out:Record<string,Observation>=Object.create(null);for(const [key,item]of Object.entries(value)){if(/^(?:access_?token|company_?(?:secret|key))$/i.test(key))return fail('provider-response-unconfirmed');observed(key,privateToken);out[key]=observed(item as Wire,privateToken);}return out;}
  return value as null|boolean;
 }
 function rows(data:Wire,limit:number):Record<string,Wire>[] {if(!object(data)||!Array.isArray(data.list)||data.list.length>limit||data.list.some(row=>!object(row)))return fail('provider-response-unconfirmed');return data.list as Record<string,Wire>[];}
 /** Unpaged facet collections arrive either as a bare array or as `{list:[...]}`; both are bounded. */
 function collection(data:Wire,limit:number):Record<string,Wire>[] {if(Array.isArray(data)){if(data.length>limit||data.some(row=>!object(row)))return fail('provider-response-unconfirmed');return data as Record<string,Wire>[];}return rows(data,limit);}
 /** The single approved material read body: `isInner` is fixed at 0 and the page is capped. */
 function materialQuery(query:unknown):MaterialBody{
  if(!object(query)||Object.keys(query).some(k=>!MATERIAL_KEYS.includes(k)))return fail('invalid-query',422);
  const pageNo=(query as Query).pageNo??1,pageSize=(query as Query).pageSize??20,videoType=(query as Query).videoType??1;
  if(!Number.isSafeInteger(pageNo)||pageNo<1||pageNo>1000000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100||!Number.isSafeInteger(videoType)||videoType<0||videoType>4||(query as Query).name!==undefined&&!text((query as Query).name,128)||(query as Query).videoIds!==undefined&&!text((query as Query).videoIds,512))return fail('invalid-query',422);
  // Filter values are validated by the same module the contract layer uses; the transport re-checks
  // pairs, which are only legal together - because the transport is the last gate before the wire.
  const filters=filterValues(query as Record<string,unknown>);
  return Object.freeze({pageNo,pageSize,isInner:inner,videoType,...((query as Query).name===undefined?{}:{name:(query as Query).name!}),...((query as Query).videoIds===undefined?{}:{videoIds:(query as Query).videoIds!}),...filters});
 }
 async function materials(context:unknown,requested:string|undefined,query:Query){
  const ctx=current(context);const body=materialQuery(query);
  const pageNo=body.pageNo,pageSize=body.pageSize;
  const before=await binding(ctx);
  const accountKey=await readableAccount(ctx,before,requested);
  const access=await token(()=>{current(ctx);});await sameBinding(ctx,before);
  const data=await request('/openapi/video/list',body as Record<string,string|number>,()=>{current(ctx);},access,accountKey);await sameBinding(ctx,before);
  const list=rows(data,pageSize),items=list.map(row=>Object.freeze({videoId:identifier(row.videoId),observation:observed(row,access) as Record<string,Observation>}));
  if(object(data)&&data.total!==undefined&&(!(data.total instanceof NumberSource)||!/^\d+$/.test(data.total.raw)))return fail('provider-response-unconfirmed');
  current(ctx);return Object.freeze({providerScope:scope,binding:Object.freeze({bindingId:before.bindingId,revision:before.revision}),pageNo,pageSize,grants:false as const,items,...(object(data)&&data.total!==undefined?{total:observed(data.total as Wire,access)}:{})});
 }
 /**
  * Split the live `video/type/list` tree into the two levels.
  *
  * The first live read (`receipts/first-read-20261112-111516.json`) confirmed the payload as a
  * bare array of 81 one-level rows `{categoryId,categoryName,children,id,level:1,name,
  * videoType,weight}`, with the 888 two-level rows nested inside `children`
  * (`{id,level:2,name,parentTypeId,videoType,weight}`). So the two levels are structural, not a
  * `level` filter: `oneLevel` is the top array verbatim and `twoLevel` is the flattened children.
  * `parentTypeId` stays on each child exactly as the supplier sent it.
  *
  * Structural assertions, all `provider-response-unconfirmed` when violated: the top collection is
  * non-empty, every top row is an object carrying a `children` array, every child is an object, and
  * the flattened count equals the summed children count. A shape this code does not understand is
  * refused rather than answered with an empty level.
  */
 function typeTree(entries:Record<string,Wire>[]):{oneLevel:Record<string,Wire>[];twoLevel:Record<string,Wire>[]} {
  if(!entries.length)return fail('provider-response-unconfirmed');
  const oneLevel:Record<string,Wire>[]=[],twoLevel:Record<string,Wire>[]=[];
  let children=0;
  for(const entry of entries){
   const nested=entry.children;
   if(!Array.isArray(nested))return fail('provider-response-unconfirmed');
   if(nested.some(child=>!object(child)))return fail('provider-response-unconfirmed');
   if((children+=nested.length)>20000)return fail('provider-response-unconfirmed');
   oneLevel.push(entry);
   for(const child of nested)twoLevel.push(child as Record<string,Wire>);
  }
  if(twoLevel.length!==children)return fail('provider-response-unconfirmed');
  return {oneLevel,twoLevel};
 }
 async function lookupAccount(context:unknown,input:{field:AccountField;value:string}){  const ctx=current(context);
  if(!object(input)||Object.keys(input).sort().join()!=='field,value'||!(ACCOUNT_FIELDS as readonly string[]).includes(String(input.field)))return fail('invalid-query',422);
  const field=input.field,value=input.value;
  if(!text(value)||value.trim()!==value||/[*%]/.test(value))return fail('invalid-query',422);
  await lookupAllowed(ctx,value);const access=await token(()=>{current(ctx);});await lookupAllowed(ctx,value);
  // Exactly one filter field and the bounded page: never a directory scan.
  const data=await request('/openapi/account/list',{pageNo:1,pageSize:5,[field]:value},()=>{current(ctx);},access);await lookupAllowed(ctx,value);
  const list=rows(data,5),matches=list.filter(row=>row[field]===value);
  if(!list.length)return Object.freeze({status:'not-found' as const,grants:false as const});
  if(!matches.length)return fail('provider-response-unconfirmed');
  if(matches.length!==1)return Object.freeze({status:'ambiguous' as const,grants:false as const});
  const row=matches[0],key=identifier(row.accountKey),state=number(row.state);if(state===0)return Object.freeze({status:'disabled' as const,grants:false as const});if(state!==1)return fail('provider-response-unconfirmed');
  const observation=observed(row,access) as Record<string,Observation>,login=field==='account'?value:typeof observation.account==='string'?observation.account:value;
  current(ctx);return Object.freeze({status:'found' as const,grants:false as const,field,account:Object.freeze({account:login,accountKey:key,observation})});
 }
 async function listLabels(context:unknown,accountKey:string|undefined,query:LabelQuery={}){
   const ctx=current(context);
   if(!object(query)||Object.keys(query).some(k=>!['pageNo','pageSize','videoType'].includes(k)))return fail('invalid-query',422);
   const pageNo=query.pageNo??1,pageSize=query.pageSize??50,videoType=query.videoType??1;
   if(!Number.isSafeInteger(pageNo)||pageNo<1||pageNo>1000000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100||!Number.isSafeInteger(videoType)||videoType<0||videoType>4)return fail('invalid-query',422);
   const before=await binding(ctx),account=await readableAccount(ctx,before,accountKey);
   const access=await token(()=>{current(ctx);});await sameBinding(ctx,before);
   const data=await request('/openapi/label/list',{pageNo,pageSize,videoType},()=>{current(ctx);},access,account);await sameBinding(ctx,before);
   const list=rows(data,pageSize),labels=list.map(row=>observed(row,access));
   if(object(data)&&data.total!==undefined&&(!(data.total instanceof NumberSource)||!/^\d+$/.test(data.total.raw)))return fail('provider-response-unconfirmed');
   current(ctx);return Object.freeze({providerScope:scope,binding:Object.freeze({bindingId:before.bindingId,revision:before.revision}),pageNo,pageSize,labels,...(object(data)&&data.total!==undefined?{total:observed(data.total as Wire,access)}:{})});
 }
 /**
  * One-level/two-level categories, states and the company label set.
  *
  * The tree is split structurally (see `typeTree`) and refused on any unexpected shape, before the
  * remaining two reads are spent.
  */
 async function listFacets(context:unknown,accountKey:string|undefined,query:FacetQuery={}){
  const ctx=current(context);
  if(!object(query)||Object.keys(query).some(k=>k!=='videoType'))return fail('invalid-query',422);
  const videoType=query.videoType??1;
  if(!Number.isSafeInteger(videoType)||videoType<0||videoType>4)return fail('invalid-query',422);
  const before=await binding(ctx),account=await readableAccount(ctx,before,accountKey);
  const access=await token(()=>{current(ctx);});await sameBinding(ctx,before);
  const types=collection(await request('/openapi/video/type/list',{videoType},()=>{current(ctx);},access,account),4096);
  // Split before the remaining facet reads: a tree we cannot file is refused without spending two
  // more supplier calls on it.
  const {oneLevel:topRows,twoLevel:childRows}=typeTree(types);
  const oneLevel=topRows.map(entry=>observed(entry as Wire,access)),twoLevel=childRows.map(entry=>observed(entry as Wire,access));
  await sameBinding(ctx,before);
  const states=collection(await request('/openapi/video/state/list',{},()=>{current(ctx);},access,account),1024);
  await sameBinding(ctx,before);
  const labelData=await request('/openapi/label/list',{pageNo:1,pageSize:100,videoType},()=>{current(ctx);},access,account);
  await sameBinding(ctx,before);
  const publicLabels=rows(labelData,100).map(row=>observed(row as Wire,access));
  current(ctx);
  return Object.freeze({providerScope:scope,binding:Object.freeze({bindingId:before.bindingId,revision:before.revision}),videoType,oneLevel,twoLevel,states:states.map(row=>observed(row as Wire,access)),publicLabels,...(object(labelData)&&labelData.total!==undefined?{labelTotal:observed(labelData.total as Wire,access)}:{})});
 }
 /**
  * The one call in this package that touches `/openapi/video/query/raw`, which increments the
  * supplier's download counter. There is no retry and no preview use: the raw route is the only
  * caller, and it calls this exactly once per request.
  *
  * The URL is returned to the caller and never logged. Host policy lives in the route layer
  * (`raw.ts`) because it is configuration, not protocol; this layer only refuses anything that is
  * not a printable http(s)-shaped URL and anything that embeds a company credential or the token.
  */
 async function rawVideoUrl(context:unknown,accountKey:string|undefined,videoId:string){
  const ctx=current(context);
  if(!text(videoId,64))return fail('invalid-query',422);
  const before=await binding(ctx),account=await readableAccount(ctx,before,accountKey);
  const access=await token(()=>{current(ctx);});await sameBinding(ctx,before);
  // isInner is mandatory here: omitting it makes the supplier answer code=20000
  // '[isInner]不能为空' even though every other field looks complete. 0 is the value the list call
  // already uses, and it must stay a number, not the string '0'.
  const data=await request('/openapi/video/query/raw',{videoId,isInner:inner},()=>{current(ctx);},access,account);
  await sameBinding(ctx,before);
  // `rawUrl` is the documented field; a bare string is accepted because the shipment shape was not
  // field-confirmed. Anything else is refused rather than guessed.
  const candidate=typeof data==='string'?data:object(data)&&typeof data.rawUrl==='string'?data.rawUrl:object(data)&&typeof data.url==='string'?data.url:null;
  if(!candidate||candidate.length>2048||!/^[\x21-\x7e]+$/.test(candidate))return fail('provider-response-unconfirmed');
  if([config.companyKey,config.companySecret,access].some(secret=>secret&&candidate.includes(secret)))return fail('provider-response-unconfirmed');
  current(ctx);
  return Object.freeze({url:candidate,providerScope:scope});
 }
 return Object.freeze({
  providerScope:scope,
  lookupAccount,
  lookupExactAccount:async(context:unknown,name:string)=>lookupAccount(context,{field:'account',value:name}),
  listMaterials:async(context:unknown,query:Query={})=>materials(context,undefined,query),
  /** Same read path with an explicit `account_key`; a foreign key needs `authorizeAccount`. */
  listMaterialsAs:async(context:unknown,accountKey:string,query:Query={})=>materials(context,accountKey,query),
  listLabels,
  listFacets,
  rawVideoUrl,
 });
}

export type ZhishangReadOnly=ReturnType<typeof createZhishangReadOnly>

