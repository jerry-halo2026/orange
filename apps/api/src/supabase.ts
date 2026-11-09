import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, parse } from 'node:path';

export type VerifiedSession = Readonly<{subjectId:string;sessionId:string;expiresAtMs:number;environmentId:string}>;
export type ApiConfiguration = Readonly<{environmentId:string;supabaseOrigin:string;publishableKey:string;credentialFile:string;port:number}>;
const verified = new WeakSet<object>();
const error = (code:string,status=403) => Object.assign(new Error(code),{code,status});
const uuid = (v:unknown): v is string => typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const plain = (v:unknown): v is Record<string,unknown> => !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
function origin(value:string) { const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw error('configuration-required',503);return u.origin; }
async function safeJson(file:string) {
  if(typeof file!=='string'||!isAbsolute(file))throw error('configuration-required',503);
  file=normalize(file);if(file===parse(file).root)throw error('configuration-required',503);
  for(let p=file;;p=dirname(p)){const s=await lstat(p);if(s.isSymbolicLink()||(p===file?(!s.isFile()||s.nlink!==1||s.size>32768):!s.isDirectory()))throw error('configuration-required',503);if(p===dirname(p))break;}
  const actual=await realpath(file);if(actual.toLowerCase()!==file.toLowerCase())throw error('configuration-required',503);
  const handle=await open(file,'r');try{const s=await handle.stat();if(!s.isFile()||s.nlink!==1||s.size>32768)throw error('configuration-required',503);return JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
}
export async function readConfiguration(file:unknown):Promise<ApiConfiguration> {
  try {
    if(typeof file!=='string')throw error('configuration-required',503);
    const c=await safeJson(file);
    if(!plain(c)||Object.keys(c).sort().join()!=='credentialFile,environmentId,port,publishableKey,supabaseOrigin'||typeof c.environmentId!=='string'||!c.environmentId||typeof c.publishableKey!=='string'||!c.publishableKey||/[\r\n]/.test(c.publishableKey)||c.publishableKey.startsWith('sb_secret_')||typeof c.credentialFile!=='string'||!isAbsolute(c.credentialFile)||typeof c.supabaseOrigin!=='string'||!Number.isSafeInteger(c.port)||Number(c.port)<1||Number(c.port)>65535)throw error('configuration-required',503);
    if(c.publishableKey.split('.').length===3){try{if(JSON.parse(Buffer.from(c.publishableKey.split('.')[1],'base64url').toString()).role==='service_role')throw error('configuration-required',503);}catch(e){if((e as any).code)throw e;}}
    return Object.freeze({...c,supabaseOrigin:origin(c.supabaseOrigin)}) as ApiConfiguration;
  }catch{throw error('configuration-required',503);}
}
export function isVerifiedSession(value:unknown):value is VerifiedSession { return !!value&&typeof value==='object'&&verified.has(value)&&Date.now()<(value as VerifiedSession).expiresAtMs; }

/** No user_metadata/app_metadata authority; every HTTP request verifies this same token online. */
export async function verifyBearer(config:Pick<ApiConfiguration,'environmentId'|'supabaseOrigin'|'publishableKey'>,authorization:unknown,fetcher:typeof fetch=fetch):Promise<VerifiedSession> {
  if(typeof authorization!=='string'||!/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)||authorization.length>16384)throw error('authentication-required');
  const token=authorization.slice(7),segments=token.split('.');let claims:any,header:any;
  try{if(segments.length!==3)throw 0;header=JSON.parse(Buffer.from(segments[0],'base64url').toString('utf8'));claims=JSON.parse(Buffer.from(segments[1],'base64url').toString('utf8'));}catch{throw error('authentication-rejected');}
  const base=origin(config.supabaseOrigin);
  if(!plain(claims)||!plain(header)||!['HS256','RS256','ES256'].includes(String(header.alg))||claims.role!=='authenticated'||!uuid(claims.sub)||!uuid(claims.session_id)||typeof claims.exp!=='number'||!Number.isSafeInteger(claims.exp)||claims.exp*1000<=Date.now()||claims.iss!==base+'/auth/v1'||!(claims.aud==='authenticated'||Array.isArray(claims.aud)&&claims.aud.includes('authenticated')))throw error('authentication-rejected');
  let response:Response;
  try{response=await fetcher(base+'/auth/v1/user',{headers:{apikey:config.publishableKey,authorization},redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw error('authentication-unconfirmed',503);}
  if(response.status===401||response.status===403)throw error('authentication-rejected');
  if(!response.ok)throw error('authentication-unconfirmed',503);
  let user:any;try{user=await response.json();}catch{throw error('authentication-unconfirmed',503);}
  if(!plain(user)||user.id!==claims.sub||user.is_anonymous!==false||claims.exp*1000<=Date.now())throw error('authentication-rejected');
  const context=Object.freeze({subjectId:claims.sub,sessionId:claims.session_id,expiresAtMs:claims.exp*1000,environmentId:config.environmentId});verified.add(context);return context;
}

const RPC:Record<string,string>={resolve_materials:'orange_resolve_materials',preflight:'orange_preflight',freeze_claim:'orange_freeze_claim',claim_status:'orange_claim_status',start_attempt:'orange_start_attempt',cancel_claim:'orange_cancel_claim',mark_unknown:'orange_mark_unknown',record_delivery:'orange_record_delivery'};
function rpcResult(operation:string,value:unknown):any {
  const invalid=()=>{throw error('result-unknown',503);};
  if(operation==='resolve_materials'){
    if(!Array.isArray(value))return invalid();
    for(const m of value){if(!plain(m)||!uuid(m.versionId)||typeof m.contentSha256!=='string'||!/^[a-f0-9]{64}$/.test(m.contentSha256)||!['video','still','sound'].includes(String(m.kind))||typeof m.durationSec!=='number'||!Number.isFinite(m.durationSec)||m.durationSec<0||!Number.isSafeInteger(m.probeRevision))return invalid();}
    return value;
  }
  if(!plain(value))return invalid();
  if(operation==='preflight'&&value.status==='prepare-required'&&Object.keys(value).length===1)return value;
  if((operation==='freeze_claim'||operation==='preflight')&&value.status==='duplicate'&&Object.keys(value).length===1)return value;
  if(!uuid(value.claimId)||!uuid(value.planId)||!['reserved','running','unknown','cancel-requested','succeeded'].includes(String(value.status))||typeof value.contentKey!=='string'||!/^[a-f0-9]{64}$/.test(value.contentKey)||![0,1].includes(Number(value.historyCount))||typeof value.historyCount!=='number'||value.executionReady!==false||!plain(value.frozenPlan)||value.frozenPlan.version!==1)return invalid();
  return value;
}
export function createSupabase(config:ApiConfiguration,fetcher:typeof fetch=fetch) {
  let credential:Promise<{type:string;key:string}>|null=null;
  const secret=()=>credential??=(async()=>{try{const c=await safeJson(config.credentialFile);if(!plain(c)||Object.keys(c).sort().join()!=='key,type'||!['secret','service-role-jwt'].includes(String(c.type))||typeof c.key!=='string'||!c.key||/[\r\n]/.test(c.key))throw 0;if(c.type==='secret'&&!c.key.startsWith('sb_secret_'))throw 0;if(c.type==='service-role-jwt'){const claims=JSON.parse(Buffer.from(c.key.split('.')[1],'base64url').toString());if(claims.role!=='service_role')throw 0;}return c as {type:string;key:string};}catch{throw error('server-credential-required',503);}})();
  return {
    verify:(authorization:unknown)=>verifyBearer(config,authorization,fetcher),
    async rpc(operation:string,args:Record<string,unknown>) {
      const name=RPC[operation];if(!name)throw error('unsupported-operation',422);
      const c=await secret(),headers:Record<string,string>={apikey:c.key,'content-type':'application/json'};
      // New secret keys use apikey; legacy service JWTs additionally set their own Authorization.
      if(c.type==='service-role-jwt')headers.authorization='Bearer '+c.key;
      let response:Response;
      try{response=await fetcher(origin(config.supabaseOrigin)+'/rest/v1/rpc/'+name,{method:'POST',headers,body:JSON.stringify(args),redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw error(operation==='resolve_materials'||operation==='preflight'||operation==='claim_status'?'backend-unconfirmed':'result-unknown',503);}
      if(!response.ok){let message:string|null=null;try{const body=await response.json();if(typeof body.message==='string'&&/^orange:[a-z-]+$/.test(body.message))message=body.message.slice(7);}catch{}if(!message)throw error('backend-unconfirmed',503);throw error(message,message==='idempotency-conflict'?409:403);}
      try{return rpcResult(operation,await response.json());}catch{throw error('result-unknown',503);}
    },
  };
}