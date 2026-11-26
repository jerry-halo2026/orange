// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Minimal HTTP surface for the material centre: `GET /api/materials/{list,facets,labels}` and
 * `POST /api/materials/raw`.
 *
 * Boundaries, all deliberate:
 *  - loopback only; the server refuses to bind anywhere else and never follows a redirect;
 *  - an `Origin` header that is not explicitly allow-listed is rejected, so a browser page from
 *    another origin cannot read the response even with a valid bearer token;
 *  - the session is verified by the injected `verify` (the same branded-session path the transport
 *    requires); there is no second identity mechanism here;
 *  - reads are `GET`; `raw` is the only `POST`, the only route that takes a body, and the only route
 *    that can download an original. No response is cached (`cache-control: no-store`);
 *  - query parameters are parsed into the contract layer's own names, one occurrence each.
 *    A repeated parameter is rejected rather than resolved by a last-wins rule.
 *
 * `video/query/raw` is reachable from exactly one place: the raw route, which calls it once.
 */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {fail,SupplierError,toPublicError} from './errors.ts';
import type {VerifiedSession} from './supabase.ts';
import type {MaterialScope} from './authorization.ts';
import {FILTER_KEYS} from './filters.ts';
import type {MaterialsReadOnly} from './materials.ts';
import type {RawService} from './raw.ts';
import type {PublicBinding} from './binding-store.ts';

export type MaterialsServerDependencies=Readonly<{
  verify:Verify;
  materials:MaterialsReadOnly;
  /** Exact origins allowed to read cross-origin. Absent means "no browser origin is allowed". */
  origins?:readonly string[];
  /**
   * The internal hop between the Studio server and this process. When present, every non-health
   * route requires the exact secret in this header. It is compared in constant time and is never
   * echoed, logged, or included in a response body.
   */
  internal?:Readonly<{header:string;secret:string}>;
  /** The only route that downloads an original. Absent means the route answers configuration-required. */
  raw?:RawService;
  /** Claim/read/release the caller's own cloud-steward binding. */
  binding?:BindingApi;
  /** Reported by `/health` only. Never config, never a capability. */
  version?:string;
}>;

/** The one header the Studio server uses to prove the internal hop. */
export const INTERNAL_SECRET_HEADER='x-materials-secret';

/**
 * What a session verifier is allowed to look at. The method, path and raw query are part of it so
 * the shared-secret signature can cover the whole request line instead of only the headers.
 */
export type VerifyRequest=Readonly<{
  authorization:string|undefined;
  method:string;
  path:string;
  query:string;
  header(name:string):string|undefined;
}>;
export type Verify=(request:VerifyRequest)=>Promise<VerifiedSession>;

/** Claim input after the route has parsed and shape-checked it. */
export type BindingClaim=Readonly<{account?:string;accountKey?:string}>;
export type BindingApi=Readonly<{
  read(context:VerifiedSession):PublicBinding|null;
  claim(context:VerifiedSession,input:BindingClaim):Promise<PublicBinding>;
  release(context:VerifiedSession):Promise<boolean>;
}>;

const ROUTES=Object.freeze({list:'/api/materials/list',facets:'/api/materials/facets',labels:'/api/materials/labels',raw:'/api/materials/raw',binding:'/api/materials/binding'});
// The list route accepts the supplier's filter dimensions (contract 8.1) as single string values;
// the value rules live in filters.ts, shared with the transport.
const PARAMS=Object.freeze({list:['pageNo','pageSize','videoType','name','videoIds','scope',...FILTER_KEYS],facets:['videoType','scope'],labels:['pageNo','pageSize','videoType','scope']});

function send(response:ServerResponse,status:number,payload:unknown){
  if(response.destroyed||response.writableEnded)return;
  response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
  response.end(JSON.stringify(payload));
}

function single(url:URL,name:string):string|undefined {
  const values=url.searchParams.getAll(name);
  if(values.length>1)return fail('invalid-query',422);
  return values[0];
}

function integer(value:string|undefined,name:string):number|undefined {
  if(value===undefined)return undefined;
  if(!/^(?:0|[1-9]\d{0,6})$/.test(value))return fail('invalid-query',422);
  return Number(value);
}

/** `own` and `company` are the two built-in scopes; a third-party view must name its key. */
function scope(value:string|undefined):MaterialScope|undefined {
  if(value===undefined)return undefined;
  if(value==='own')return Object.freeze({kind:'own' as const});
  if(value==='company')return Object.freeze({kind:'company' as const});
  if(value.startsWith('account:'))return Object.freeze({kind:'account' as const,accountKey:value.slice(8)});
  return fail('invalid-query',422);
}

function query(url:URL,route:'list'|'facets'|'labels'){
  const allowed=PARAMS[route];
  for(const name of url.searchParams.keys())if(!allowed.includes(name))return fail('invalid-query',422);
  const shared={videoType:integer(single(url,'videoType'),'videoType'),scope:scope(single(url,'scope'))};
  if(route==='facets')return shared;
  const paging={pageNo:integer(single(url,'pageNo'),'pageNo'),pageSize:integer(single(url,'pageSize'),'pageSize')};
  if(route==='labels')return {...shared,...paging};
  const filters:Record<string,string>={};
  for(const key of FILTER_KEYS){
    const value=single(url,key);
    if(value!==undefined)filters[key]=value;
  }
  return {...shared,...paging,name:single(url,'name'),videoIds:single(url,'videoIds'),...filters};
}

/** Constant-time comparison of the internal-hop secret; a length mismatch is a plain false. */
function secretMatches(provided:unknown,expected:string):boolean {
  if(typeof provided!=='string'||!provided.length||!expected.length)return false;
  const left=Buffer.from(provided,'utf8'),right=Buffer.from(expected,'utf8');
  if(left.length!==right.length)return false;
  return timingSafeEqual(left,right);
}

/** The one body shape this service accepts: `{videoId, videoType?}`, nothing else. */
async function rawBody(request:IncomingMessage):Promise<Readonly<{videoId:string;videoType:number;scope:string|undefined}>> {
  const type=String(request.headers['content-type']??'').toLowerCase();
  if(!type.startsWith('application/json'))return fail('invalid-query',422);
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of request){
    size+=chunk.length;
    if(size>1024)return fail('invalid-query',422);
    chunks.push(Buffer.from(chunk));
  }
  let parsed:unknown;
  try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return fail('invalid-query',422);}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return fail('invalid-query',422);
  const record=parsed as Record<string,unknown>;
  if(Object.keys(record).some(key=>key!=='videoId'&&key!=='videoType'&&key!=='scope'))return fail('invalid-query',422);
  const videoId=record.videoId;
  if(typeof videoId!=='string')return fail('invalid-query',422);
  // `videoType` is the card's own field, passed through untouched: default 1, 0..4, never coerced.
  const videoType=record.videoType===undefined?1:record.videoType;
  if(!Number.isSafeInteger(videoType)||(videoType as number)<0||(videoType as number)>4)return fail('invalid-query',422);
  // scope keeps the list route's shape (own / company / ccount:<key>); raw.ts validates it.
  const scope=record.scope;
  if(scope!==undefined&&typeof scope!=='string')return fail('invalid-query',422);
  return Object.freeze({videoId,videoType:videoType as number,scope});
}

/** `{account?, accountKey?}`: at least one, each a short printable string, nothing else. */
async function bindingBody(request:IncomingMessage):Promise<BindingClaim> {
  const type=String(request.headers['content-type']??'').toLowerCase();
  if(!type.startsWith('application/json'))return fail('invalid-query',422);
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of request){
    size+=chunk.length;
    if(size>1024)return fail('invalid-query',422);
    chunks.push(Buffer.from(chunk));
  }
  let parsed:unknown;
  try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return fail('invalid-query',422);}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return fail('invalid-query',422);
  const record=parsed as Record<string,unknown>;
  if(Object.keys(record).some(key=>key!=='account'&&key!=='accountKey'))return fail('invalid-query',422);
  const read=(value:unknown):string|undefined=>{
    if(value===undefined)return undefined;
    if(typeof value!=='string'||!value.length||value.length>256||!/^[\x21-\x7e]+$/.test(value))return fail('invalid-query',422);
    return value;
  };
  const account=read(record.account),accountKey=read(record.accountKey);
  if(account===undefined&&accountKey===undefined)return fail('invalid-query',422);
  return Object.freeze({...(account===undefined?{}:{account}),...(accountKey===undefined?{}:{accountKey})});
}
export function createMaterialsServer(dependencies:MaterialsServerDependencies){
  if(!dependencies||typeof dependencies.verify!=='function'||!dependencies.materials)return fail('configuration-required');
  const origins=Object.freeze([...(dependencies.origins??[])]);
  let stopping=false;

  async function handle(request:IncomingMessage,response:ServerResponse){
    if(stopping)return send(response,503,{code:'stopping'});
    const method=request.method??'GET';
    const url=new URL(request.url??'/','http://127.0.0.1');
    if(url.pathname!=='/health'&&!(Object.values(ROUTES) as readonly string[]).includes(url.pathname))return send(response,404,{code:'not-found'});
    const origin=request.headers.origin;
    if(origin!==undefined&&(typeof origin!=='string'||!origins.includes(origin)))return send(response,403,{code:'origin-rejected'});
    // The raw route is the only `POST` that downloads; the binding route is the only route that
    // mutates state, and it owns `GET`/`POST`/`DELETE`.
    const isRaw=url.pathname===ROUTES.raw,isBinding=url.pathname===ROUTES.binding;
    if(isBinding?(method!=='GET'&&method!=='POST'&&method!=='DELETE'):isRaw?method!=='POST':method!=='GET'&&method!=='HEAD')return send(response,405,{code:'method-not-allowed'});
    if(url.pathname==='/health')return send(response,200,{ok:true,version:dependencies.version??'0.0.0'});
    // Internal hop first: a process that is only meant to be called by the Studio server does not
    // answer material reads to anyone else, even with a valid bearer token.
    if(dependencies.internal){
      const provided=request.headers[dependencies.internal.header];
      if(!secretMatches(provided,dependencies.internal.secret))return send(response,403,{code:'internal-auth-required'});
    }

    const context=await dependencies.verify({authorization:request.headers.authorization,method,path:url.pathname,query:url.search.slice(1),header:(name)=>{const value=request.headers[name.toLowerCase()];return Array.isArray(value)?value[0]:value;}});
    if(isBinding){
      if(!dependencies.binding)return fail('configuration-required');
      if(method==='GET')return send(response,200,{binding:dependencies.binding.read(context)});
      if(method==='DELETE')return send(response,200,{binding:null,released:await dependencies.binding.release(context)});
      return send(response,200,{binding:await dependencies.binding.claim(context,await bindingBody(request))});
    }
    if(isRaw){
      if(!dependencies.raw)return fail('configuration-required');
      const body=await rawBody(request);
      return send(response,200,await dependencies.raw.raw(context,body.videoId,body.videoType,body.scope));
    }
    const route:'list'|'facets'|'labels'=url.pathname===ROUTES.facets?'facets':url.pathname===ROUTES.labels?'labels':'list';
    const parsed=query(url,route);
    if(route==='facets'){const result=await dependencies.materials.facets(context,parsed as never);return send(response,200,result);}
    if(route==='labels'){const result=await dependencies.materials.labels(context,parsed as never);return send(response,200,result);}
    const result=await dependencies.materials.list(context,parsed as never);return send(response,200,result);
  }

  const server=createServer((request,response)=>{
    const task=handle(request,response).catch((error:unknown)=>{
      const body=toPublicError(error);
      send(response,body.status,{code:body.code,message:body.message,...(body.reason?{reason:body.reason}:{})});
    });
    void task;
  });

  return Object.freeze({
    /** `0` binds an ephemeral loopback port (tests only). The host is not a parameter. */
    async listen(port=0):Promise<number>{
      if(!Number.isSafeInteger(port)||port<0||port>65535||stopping)return Promise.reject(new SupplierError('invalid-query',422));
      await new Promise<void>((ready,failed)=>{
        const settled=(error?:Error)=>{server.removeListener('listening',listening);server.removeListener('error',settled);error?failed(error):ready();};
        const listening=()=>settled();
        server.once('error',settled);server.once('listening',listening);
        server.listen(port,'127.0.0.1');
      });
      const address=server.address();
      if(!address||typeof address==='string')return Promise.reject(new SupplierError('configuration-required',503));
      return address.port;
    },
    close(){stopping=true;return new Promise<void>((done)=>{if(!server.listening)return done();server.closeIdleConnections();server.close(()=>done());});},
  });
}
