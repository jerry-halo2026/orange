import {createHash,randomBytes} from 'node:crypto';
import {isVerifiedSession,type VerifiedSession} from './supabase.ts';

const ORIGIN='https://sucaiwang-open-api.zhishangsoft.com';
const MAX_BYTES=3*1024*1024;
class SupplierError extends Error {
 readonly code:string;readonly status:number;
 constructor(code:string,status=503){super(code);this.code=code;this.status=status;}
}
const fail=(code:string,status?:number):never=>{throw new SupplierError(code,status);};
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
   const value=fields[key];if(!/^[A-Za-z0-9_]+$/.test(key)||key==='company_secret'||!(typeof value==='string'||typeof value==='number'&&Number.isSafeInteger(value)))return fail('invalid-query',422);
   return key+'='+rfc3986(String(value));
  }).join('&')+'&company_secret='+secret;
  return createHash('md5').update(canonical,'utf8').digest('hex').toUpperCase();
 }catch(error){if(error instanceof SupplierError)throw error;return fail('invalid-query',422);}
}

// A bounded JSON decoder retains number lexemes before any JS number rounding.
// It is private to these three supplier responses, not an application protocol.
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
type ExternalId=Readonly<{value:string;sourceType:'string'|'number';source:string}>;
type Observation=null|boolean|string|{sourceType:'number';source:string}|Observation[]|{[key:string]:Observation};
function identifier(v:unknown):ExternalId {
 if(text(v,512))return Object.freeze({value:v,sourceType:'string',source:v});
 if(v instanceof NumberSource&&/^(?:0|[1-9]\d*)$/.test(v.raw)&&v.raw.length<=512)return Object.freeze({value:v.raw,sourceType:'number',source:v.raw});
 return fail('provider-response-unconfirmed');
}
type Configuration=Readonly<{environmentId:string;companyKey:string;companySecret:string}>;
type Binding=Readonly<{subjectId:string;environmentId:string;providerScope:string;bindingId:string;revision:number;accountKey:string;status:'active';expiresAtMs:number}>;
type Dependencies={fetch?:typeof fetch;now?:()=>number;nonce?:()=>string;authorizeLookup?:(context:VerifiedSession,exactName:string)=>unknown|Promise<unknown>;bindingFor?:(context:VerifiedSession,providerScope:string)=>unknown|Promise<unknown>};
type Query={pageNo?:number;pageSize?:number;videoType?:number;name?:string;videoIds?:string};

/** Trusted backend composition only. No environment/file fallback, routes, downloads, or binding writes. */
export function createZhishangReadOnly(configuration:Configuration,dependencies:Dependencies={}) {
 if(!object(configuration)||Object.keys(configuration).sort().join()!=='companyKey,companySecret,environmentId'||!text(configuration.environmentId)||!header(configuration.companyKey)||!text(configuration.companySecret,8192))return fail('configuration-required');
 const config=Object.freeze({...configuration}),fetcher=dependencies.fetch??globalThis.fetch,now=dependencies.now??Date.now,nonce=dependencies.nonce??(()=>randomBytes(8).toString('hex'));
 if(typeof fetcher!=='function'||typeof now!=='function'||typeof nonce!=='function')return fail('configuration-required');
 const scope=createHash('sha256').update('zhishang\0'+ORIGIN+'\0'+config.companyKey).digest('hex');
 let cache:{value:string;expiresAtMs:number}|null=null,flight:Promise<string>|null=null,generation=0,lastTime=-Infinity;
 const clear=()=>{cache=null;generation++;};
 const clock=()=>{let result:number;try{result=now();}catch{clear();return fail('provider-clock-unconfirmed');}if(!Number.isSafeInteger(result)||result<0||result<lastTime){clear();return fail('provider-clock-unconfirmed');}lastTime=result;return result;};
 const current=(context:unknown):VerifiedSession=>{if(!isVerifiedSession(context)||context.environmentId!==config.environmentId)return fail('authentication-required',403);return context;};
 async function request(endpoint:'/openapi/auth/access_token'|'/openapi/account/list'|'/openapi/video/list',body:Record<string,string|number>,check:()=>void,token?:string,accountKey?:string):Promise<Wire>{
  check();const stamp=String(Math.floor(clock()/1000));let unique:string;try{unique=nonce();}catch{return fail('configuration-required');}if(!/^[a-f0-9]{16}$/.test(unique))return fail('configuration-required');
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
   if(!object(result)||result.success!==true||number(result.code)!==1)return fail('provider-unconfirmed');check();return result.data as Wire;
  }catch(error){clear();if(error instanceof SupplierError)throw error;return fail(timedOut?'provider-timeout':'provider-unconfirmed',timedOut?504:503);}
  finally{clearTimeout(timer);try{if(reader)await reader.cancel();else await responseBody?.cancel();}catch{/* The entered transport has already failed. */}try{reader?.releaseLock();}catch{/* closed reader */}}
 }
 async function token(check:()=>void):Promise<string>{
  check();const time=clock();if(cache&&time<cache.expiresAtMs)return cache.value;if(flight)return flight;
  const epoch=generation,started=time;
  const work=(async()=>{const data=await request('/openapi/auth/access_token',{},check);if(!object(data)||!header(data.accessToken))return fail('provider-auth-unconfirmed');if(epoch!==generation)return fail('provider-auth-unconfirmed');cache={value:data.accessToken,expiresAtMs:started+3600000};return data.accessToken;})();
  flight=work;try{return await work;}catch(error){clear();throw error;}finally{if(flight===work)flight=null;}
 }
 async function binding(context:VerifiedSession):Promise<Binding>{
  current(context);let raw:unknown;try{raw=await dependencies.bindingFor?.(context,scope);}catch{return fail('binding-required',403);}current(context);
  if(!object(raw)||Object.keys(raw).sort().join()!=='accountKey,bindingId,environmentId,expiresAtMs,providerScope,revision,status,subjectId'||raw.subjectId!==context.subjectId||raw.environmentId!==config.environmentId||raw.providerScope!==scope||raw.status!=='active'||typeof raw.bindingId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(raw.bindingId)||raw.bindingId==='00000000-0000-0000-0000-000000000000'||!Number.isSafeInteger(raw.revision)||Number(raw.revision)<1||!header(raw.accountKey)||typeof raw.expiresAtMs!=='number'||!Number.isFinite(raw.expiresAtMs)||raw.expiresAtMs<=clock())return fail('binding-required',403);
  return Object.freeze({...raw}) as Binding;
 }
 async function sameBinding(context:VerifiedSession,before:Binding){const after=await binding(context);if(Object.keys(before).some(k=>before[k as keyof Binding]!==after[k as keyof Binding]))return fail('binding-changed',403);}
 async function lookupAllowed(context:VerifiedSession,name:string){current(context);let allowed:unknown;try{allowed=await dependencies.authorizeLookup?.(context,name);}catch{return fail('lookup-not-authorized',403);}current(context);if(allowed!==true)return fail('lookup-not-authorized',403);}
 function observed(value:Wire,privateToken:string):Observation {
  if(value instanceof NumberSource)return {sourceType:'number',source:value.raw};
  if(typeof value==='string'){if([config.companyKey,config.companySecret,privateToken].some(secret=>secret&&value.includes(secret)))return fail('provider-response-unconfirmed');return value;}
  if(Array.isArray(value))return value.map(v=>observed(v,privateToken));
  if(object(value)){const out:Record<string,Observation>=Object.create(null);for(const [key,item]of Object.entries(value)){if(/^(?:access_?token|company_?(?:secret|key))$/i.test(key))return fail('provider-response-unconfirmed');observed(key,privateToken);out[key]=observed(item as Wire,privateToken);}return out;}
  return value as null|boolean;
 }
 function rows(data:Wire,limit:number):Record<string,Wire>[] {if(!object(data)||!Array.isArray(data.list)||data.list.length>limit||data.list.some(row=>!object(row)))return fail('provider-response-unconfirmed');return data.list as Record<string,Wire>[];}
 return Object.freeze({
  providerScope:scope,
  async lookupExactAccount(context:unknown,name:string){
   const ctx=current(context);if(!text(name)||name.trim()!==name||/[*%]/.test(name))return fail('invalid-query',422);await lookupAllowed(ctx,name);const access=await token(()=>{current(ctx);});await lookupAllowed(ctx,name);
   const data=await request('/openapi/account/list',{pageNo:1,pageSize:5,account:name},()=>{current(ctx);},access);await lookupAllowed(ctx,name);
   const list=rows(data,5),matches=list.filter(row=>row.account===name);
   if(!list.length)return Object.freeze({status:'not-found' as const,grants:false as const});
   if(!matches.length)return fail('provider-response-unconfirmed');
   if(matches.length!==1)return Object.freeze({status:'ambiguous' as const,grants:false as const});
   const row=matches[0],key=identifier(row.accountKey),state=number(row.state);if(state===0)return Object.freeze({status:'disabled' as const,grants:false as const});if(state!==1)return fail('provider-response-unconfirmed');
   const observation=observed(row,access) as Record<string,Observation>;current(ctx);return Object.freeze({status:'found' as const,grants:false as const,account:Object.freeze({account:name,accountKey:key,observation})});
  },
  async listMaterials(context:unknown,query:Query={}){
   const ctx=current(context);if(!object(query)||Object.keys(query).some(k=>!['pageNo','pageSize','videoType','name','videoIds'].includes(k)))return fail('invalid-query',422);
   const pageNo=query.pageNo??1,pageSize=query.pageSize??20,videoType=query.videoType??1;
   if(!Number.isSafeInteger(pageNo)||pageNo<1||pageNo>1000000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100||!Number.isSafeInteger(videoType)||videoType<0||videoType>4||query.name!==undefined&&!text(query.name,128)||query.videoIds!==undefined&&!text(query.videoIds,512))return fail('invalid-query',422);
   const before=await binding(ctx),access=await token(()=>{current(ctx);});await sameBinding(ctx,before);
   const data=await request('/openapi/video/list',{pageNo,pageSize,isInner:0,videoType,...(query.name===undefined?{}:{name:query.name}),...(query.videoIds===undefined?{}:{videoIds:query.videoIds})},()=>{current(ctx);},access,before.accountKey);await sameBinding(ctx,before);
   const list=rows(data,pageSize),items=list.map(row=>Object.freeze({videoId:identifier(row.videoId),observation:observed(row,access) as Record<string,Observation>}));
   if(object(data)&&data.total!==undefined&&(!(data.total instanceof NumberSource)||!/^\d+$/.test(data.total.raw)))return fail('provider-response-unconfirmed');
   current(ctx);return Object.freeze({providerScope:scope,binding:Object.freeze({bindingId:before.bindingId,revision:before.revision}),pageNo,pageSize,grants:false as const,items,...(object(data)&&data.total!==undefined?{total:observed(data.total as Wire,access)}:{})});
  },
 });
}
