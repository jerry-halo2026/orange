#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Process entry for the materials service: env in, one listening port out.
 *
 * This file owns nothing but the process shell — configuration, the startup self-check, `/health`,
 * and an orderly exit. The transport, the three-layer authorization and the route table stay in
 * `zhishang.ts` / `materials.ts` / `server.ts` and are only *composed* here.
 *
 * Rules:
 *  - configuration comes from the environment only; no file, no argv, no defaults beyond the ones
 *    documented below;
 *  - the shared secret is used for the internal-hop header and for nothing else. It is never
 *    logged, never echoed, never put in a response body, and never written anywhere;
 *  - a refusal prints exactly one machine-readable line `[materials-api] refusing: <code>` and
 *    exits non-zero — never a bare stack trace;
 *  - missing/invalid environment exits `2`; a failed self-check exits `1`; a clean shutdown exits
 *    `0` after the server has actually closed.
 *
 * Environment:
 *   MATERIALS_PORT         required. 0..65535 (`0` binds an ephemeral port; tests only).
 *   MATERIALS_SECRET       required. header-safe ASCII, at least 32 bytes.
 *   MATERIALS_CREDENTIALS  required. absolute path to the ignored credentials file.
 *   MATERIALS_BINDINGS     optional. absolute path to the ignored binding file. Absent (or a path
 *                          that does not exist) starts with an empty table: company still works,
 *                          own and ccount:<key> answer 403. A file that exists but is malformed,
 *                          a directory or a symlink refuses startup.
 *   MATERIALS_BINDINGS_MODE optional. server (default) lets this process claim and release
 *                          bindings into that file; local keeps it read-only (development only).
 *   MATERIALS_COMPANY_ACCOUNT_KEY optional. the account key scope=company reads with. Absent
 *                          keeps the company view unavailable (403) instead of borrowing the
 *                          caller's own key.
 *   MATERIALS_ORIGINS      optional. comma-separated exact origins. Absent/empty = no browser
 *                          origin is allowed.
 *   MATERIALS_SESSION_MODE optional. `hmac` (default) or `supabase`. No mode means `hmac`; there is
 *                          no refuse-everything default. `supabase` requires
 *                          MATERIALS_SUPABASE_ORIGIN and MATERIALS_SUPABASE_PUBLISHABLE_KEY, or the
 *                          process refuses to start.
 *   MATERIALS_ALLOWED_ROOT optional. absolute path; the credentials and binding files must live
 *                          inside it.
 *   MATERIALS_DEBUG_SESSION optional. 1 logs one line per refused session (request line and
 *                          principal shape only, never the secret) so a client that signs
 *                          correctly but is still refused can see which input differed.
 *   MATERIALS_SMOKE_NO_NET optional. 1 makes startup refuse (smoke-net-guard) unless a local
 *                          fetch stand-in is installed first; smoke scripts set it.
 */
import {readFileSync} from 'node:fs';
import {lstat} from 'node:fs/promises';
import {isAbsolute,normalize,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createZhishangReadOnly} from './zhishang.ts';
import {readSupplierCredentials,type SupplierCredentials} from './credentials.ts';
import {createMaterialsReadOnly} from './materials.ts';
import {createMaterialsServer,INTERNAL_SECRET_HEADER} from './server.ts';
import type {VerifiedSession} from './supabase.ts';
import type {MaterialsServerDependencies} from './server.ts';
import {createHmacVerifier,createSupabaseVerifier,type SessionMode} from './session.ts';
import {accessFor,providerBindingFor,readBindingDocument,type BindingDocument,type BindingTable} from './bindings.ts';
import {assertStaging,createRawService,type RawService} from './raw.ts';
import {hostEntry} from './hosts.ts';
import {createBindingService,type BindingService} from './binding-store.ts';
import {fail} from './errors.ts';
import type {BindingApi} from './server.ts';
import {decide} from './authorization.ts';

export type Logger=Readonly<{info(line:string):void;error(line:string):void}>;
export type Refusal=Readonly<{code:string;exitCode:number}>;
export type MaterialsEnvironment=Readonly<{
  port:number;
  secret:string;
  credentials:string;
  origins:readonly string[];
  allowedRoot:string|null;
  bindings:string;
  bindingsMode:'server'|'local';
  /** 1 means the supplier's inner-network addresses were asked for. */
  isInner:0|1;
  /** Diagnostic: log the hostname of a refused raw host. */
  debugRawHost:boolean;
  /** Optional company-view key. Absent means the company view stays unavailable. */
  companyAccountKey:string|null;
  /** Where downloaded originals land. Required: the raw route has no fallback directory. */
  staging:string;
  rawHosts:readonly string[];
  rawMaxBytes:number;
  sessionMode:SessionMode;
  supabaseOrigin:string|null;
  supabaseKey:string|null;
}>;
export type StartResult=
  Readonly<{ok:true;service:Readonly<{port:number;close():Promise<void>}>}>|
  Readonly<{ok:false;refusal:Refusal}>;
export type EnvironmentResult=Readonly<{ok:true;environment:MaterialsEnvironment}>|Readonly<{ok:false;refusal:Refusal}>;
/** The smallest stdin surface wireShutdown needs: an event source that can be resumed. */
export type StdinLike=Readonly<{on(event:string,listener:(...args:unknown[])=>void):unknown;resume?:()=>void}>;

const PREFIX='[materials-api]';
const SECRET_MIN_BYTES=32;
const SECRET_SHAPE=/^[\x21-\x7e]+$/;
const ACCOUNT_KEY=/^[\x21-\x7e]{1,512}$/;

/** Captured at import: anything else in `globalThis.fetch` is an installed stand-in. */
const PRISTINE_FETCH=globalThis.fetch;
const REQUIRED_ENDPOINTS:readonly string[]=Object.freeze(['listMaterials','listMaterialsAs','listFacets','listLabels','lookupAccount']);

const refuse=(code:string,exitCode:number):Readonly<{ok:false;refusal:Refusal}>=>({ok:false as const,refusal:Object.freeze({code,exitCode})});
const text=(value:unknown):string=>typeof value==='string'?value.trim():'';

/** Every environment decision lives here so a refusal is reproducible without a process. */
export function readEnvironment(env:Readonly<Record<string,string|undefined>>):EnvironmentResult {
  const port=text(env.MATERIALS_PORT);
  if(!port)return refuse('port-missing',2);
  if(!/^\d{1,5}$/.test(port))return refuse('port-invalid',2);
  const portNumber=Number(port);
  if(!Number.isSafeInteger(portNumber)||portNumber<0||portNumber>65535)return refuse('port-invalid',2);

  const secret=typeof env.MATERIALS_SECRET==='string'?env.MATERIALS_SECRET:'';
  if(!secret)return refuse('secret-missing',2);
  if(!SECRET_SHAPE.test(secret))return refuse('secret-invalid',2);
  if(Buffer.byteLength(secret,'utf8')<SECRET_MIN_BYTES)return refuse('secret-too-short',2);

  const credentials=text(env.MATERIALS_CREDENTIALS);
  if(!credentials)return refuse('credentials-missing',2);
  if(!isAbsolute(credentials))return refuse('credentials-not-absolute',2);

  // Optional: no binding file means an empty table, not a broken installation. A path that is set but
  // unusable (malformed, a directory, a symlink) still refuses at startup, so bsent and roken`n  // stay distinguishable.
  const bindings=text(env.MATERIALS_BINDINGS);
  if(bindings&&!isAbsolute(bindings))return refuse('bindings-not-absolute',2);
  // server lets this process own the binding file; local keeps it read-only for development.
  // Supplier request parameter, not our identity: 1 asks for the inner-network addresses.
  const isInnerText=text(env.MATERIALS_IS_INNER)||'0';
  if(isInnerText!=='0'&&isInnerText!=='1')return refuse('is-inner-invalid',2);
  const isInner:0|1=isInnerText==='1'?1:0;
  const bindingsMode=text(env.MATERIALS_BINDINGS_MODE)||'server';
  if(bindingsMode!=='server'&&bindingsMode!=='local')return refuse('bindings-mode-invalid',2);

  // Same rule as an account key in the binding file. Absent is legal; present-but-unusable is not.
  const companyKeyEnv=typeof env.MATERIALS_COMPANY_ACCOUNT_KEY==='string'?env.MATERIALS_COMPANY_ACCOUNT_KEY.trim():'';
  if(env.MATERIALS_COMPANY_ACCOUNT_KEY!==undefined&&env.MATERIALS_COMPANY_ACCOUNT_KEY!==''&&!ACCOUNT_KEY.test(companyKeyEnv))return refuse('company-key-invalid',2);

  const origins:string[]=[];
  for(const candidate of text(env.MATERIALS_ORIGINS).split(',').map(candidate=>candidate.trim()).filter(candidate=>candidate.length)){
    let parsed:URL;
    try{parsed=new URL(candidate);}catch{return refuse('origins-invalid',2);}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==candidate||parsed.pathname!=='/'||parsed.search||parsed.hash)return refuse('origins-invalid',2);
    if(!origins.includes(candidate))origins.push(candidate);
  }

  const root=text(env.MATERIALS_ALLOWED_ROOT);
  if(root&&!isAbsolute(root))return refuse('allowed-root-invalid',2);

  const staging=text(env.MATERIALS_STAGING);
  if(!staging)return refuse('staging-missing',2);
  if(!isAbsolute(staging))return refuse('staging-not-absolute',2);

  const rawHosts:string[]=[];
  for(const candidate of text(env.MATERIALS_RAW_HOSTS).split(',').map(entry=>entry.trim().toLowerCase()).filter(entry=>entry.length)){
    const normalized=hostEntry(candidate);
    if(normalized===null)return refuse('raw-hosts-invalid',2);
    if(!rawHosts.includes(normalized))rawHosts.push(normalized);
  }

  const rawMaxBytesText=text(env.MATERIALS_RAW_MAX_BYTES);
  const rawMaxBytes=rawMaxBytesText?Number(rawMaxBytesText):512*1024*1024;
  if(!/^\d{1,12}$/.test(rawMaxBytesText||'512')||!Number.isSafeInteger(rawMaxBytes)||rawMaxBytes<1||rawMaxBytes>8*1024*1024*1024)return refuse('raw-max-bytes-invalid',2);

  // No mode means `hmac`. There is deliberately no "refuse everything" default: a desktop build
  // that is wired correctly must work without setting one more variable.
  const sessionMode=text(env.MATERIALS_SESSION_MODE)||'hmac';
  if(sessionMode!=='hmac'&&sessionMode!=='supabase')return refuse('session-mode-invalid',2);
  const supabaseOrigin=text(env.MATERIALS_SUPABASE_ORIGIN);
  const supabaseKey=typeof env.MATERIALS_SUPABASE_PUBLISHABLE_KEY==='string'?env.MATERIALS_SUPABASE_PUBLISHABLE_KEY.trim():'';
  if(sessionMode==='supabase'&&(!supabaseOrigin||!supabaseKey))return refuse('supabase-config-missing',2);

  return Object.freeze({ok:true as const,environment:Object.freeze({port:portNumber,secret,credentials:normalize(credentials),bindings:bindings?normalize(bindings):'',bindingsMode:bindingsMode as 'server'|'local',isInner,debugRawHost:text(env.MATERIALS_DEBUG_RAW_HOST)==='1',companyAccountKey:companyKeyEnv||null,staging:normalize(staging),rawHosts:Object.freeze(rawHosts),rawMaxBytes,origins:Object.freeze(origins),allowedRoot:root?normalize(root):null,sessionMode:sessionMode as SessionMode,supabaseOrigin:supabaseOrigin||null,supabaseKey:supabaseKey||null})});
}

/** Case-insensitive containment on the normalized path; a sibling prefix does not pass. */
export function withinRoot(file:string,root:string):boolean {
  const left=normalize(resolve(file)).toLowerCase(),right=normalize(resolve(root)).toLowerCase();
  const base=right.endsWith(sep)?right:right+sep;
  return left===right||left.startsWith(base);
}

function version():string {
  try{
    const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {version?:unknown};
    return typeof manifest.version==='string'&&manifest.version?manifest.version:'0.0.0';
  }catch{return '0.0.0';}
}

/**
 * Compose and start the service. Never throws for an expected refusal: the caller decides how to
 * report it, which is what makes every refusal testable without spawning a process.
 *
 * Identity comes from exactly one place, chosen by `MATERIALS_SESSION_MODE`:
 *  - `hmac` (default): the Studio server signs the principal with `MATERIALS_SECRET`;
 *  - `supabase`: a bearer token is verified with `verifyBearer`.
 * There is no "refuse everything" fallback: a correctly wired desktop build starts working
 * without one more variable.
 *
 * The access view is empty until the binding store lands, so an authorized session still stops at
 * `authorization-denied` (`self-binding-required`) — and no request ever reaches the supplier.
 */
export async function startMaterialsService(options:Readonly<{env?:Readonly<Record<string,string|undefined>>;logger?:Logger;now?:()=>number}>={}):Promise<StartResult> {
  const logger=options.logger??{info:(line=>process.stdout.write(line+'\n')),error:(line=>process.stderr.write(line+'\n'))};
  const env=options.env??process.env;
  // Mechanical guard, checked first: a smoke run that forgot to install a local fetch stand-in
  // refuses to start instead of quietly reaching the supplier. Nothing else in this file can send a
  // request before the guard has decided.
  if(text(env.MATERIALS_SMOKE_NO_NET)==='1'&&globalThis.fetch===PRISTINE_FETCH)return refuse('smoke-net-guard',2);
  const configured=readEnvironment(env);
  if(!configured.ok)return configured;
  // companyFromEnv is only the first candidate; the resolved key is resolvedCompanyKey.

  const {port,secret,credentials,bindings,bindingsMode,isInner:isInnerMode,debugRawHost,rawHosts:rawHostsEnv,companyAccountKey:companyFromEnv,staging,rawMaxBytes,origins,allowedRoot,sessionMode,supabaseOrigin,supabaseKey}=configured.environment;

  if(allowedRoot&&!withinRoot(credentials,allowedRoot))return refuse('credentials-outside-root',1);
  if(allowedRoot&&bindings&&!withinRoot(bindings,allowedRoot))return refuse('bindings-outside-root',1);
  if(allowedRoot&&!withinRoot(staging,allowedRoot))return refuse('staging-outside-root',1);

  let supplier:SupplierCredentials;
  try{supplier=await readSupplierCredentials(credentials);}
  catch{return refuse('credentials-unreadable',1);}

  // The company view key, in priority order: the environment wins, then the credential file's
  // `accountKey` (the company service account), then nothing. Nothing is a legitimate state: the
  // company view answers 403 `company-view-unavailable` instead of borrowing someone's identity.
  if(supplier.accountKey!==undefined&&!ACCOUNT_KEY.test(supplier.accountKey))return refuse('company-key-invalid',2);
  const resolvedCompanyKey=companyFromEnv||supplier.accountKey||null;
  logger.info(`${PREFIX} company view: ${companyFromEnv?'env':supplier.accountKey?'credentials':'none'}`);
  // Conclusion only: which address family the supplier is asked for, never a host or an address.
  logger.info(`${PREFIX} inner mode: ${isInnerMode?'on':'off'}`);

  // The raw host allow-list is operator configuration that travels with the credential file, so a
  // desktop install does not have to pass it again: env (non-empty) wins, then credentials, then an
  // empty list, which refuses every host.
  const rawHosts=[...rawHostsEnv];
  if(rawHosts.length===0&&supplier.rawHosts!==undefined){
    if(!Array.isArray(supplier.rawHosts)||supplier.rawHosts.length>16)return refuse('raw-hosts-invalid',2);
    for(const entry of supplier.rawHosts as readonly unknown[]){
      const host=hostEntry(entry);
      if(host===null)return refuse('raw-hosts-invalid',2);
      if(!rawHosts.includes(host))rawHosts.push(host);
    }
  }
  logger.info(`${PREFIX} raw hosts: ${rawHostsEnv.length?'env':Array.isArray(supplier.rawHosts)&&supplier.rawHosts.length?'credentials':'none'} count=${rawHosts.length}`);

  // Missing and broken must stay distinguishable:
  //   - no `MATERIALS_BINDINGS`, or a path that does not exist -> empty document, process starts;
  //   - a path that exists but cannot be read as a binding document (malformed JSON, bad keys, a
  //     directory, a symlink) -> refuse at startup.
  let document:BindingDocument={bindings:new Map(),history:Object.freeze([])};
  if(!bindings){
    logger.info(`${PREFIX} bindings absent: own and account scopes unavailable`);
  }else{
    // `lstat` so a symlink (even a dangling one) counts as present and is refused below, not read as
    // a missing file.
    let exists=true;
    try{await lstat(bindings);}catch{exists=false;}
    if(!exists){
      logger.info(`${PREFIX} bindings absent: own and account scopes unavailable`);
    }else{
      try{document=await readBindingDocument(bindings);}
      catch(error){
        const code=error&&typeof error==='object'?String((error as {code?:unknown}).code):'';
        return refuse(code==='bindings-invalid'?'bindings-invalid':'bindings-unreadable',2);
      }
      // Count only: document contents (subjects, account keys) never reach a log line.
      logger.info(`${PREFIX} bindings loaded count=${document.bindings.size}`);
    }
  }
  const store=createBindingService({mode:bindingsMode,file:bindingsMode==='server'&&bindings?bindings:null,initial:document,now:options.now});

  let transport:ReturnType<typeof createZhishangReadOnly>;
  // The access view is read from the store on every call, so a claim takes effect immediately.
  const access=(subjectId:string)=>accessFor(store.table(),{companyAccountKey:resolvedCompanyKey})(subjectId);
  // The transport's second gate and the contract layer's decision must agree: both read the same
  // binding table, so a foreign key cannot slip through one while failing the other.
  try{transport=createZhishangReadOnly({environmentId:supplier.environmentId,companyKey:supplier.companyKey,companySecret:supplier.companySecret},{
    // The transport takes exactly these three fields; the optional account key stays a mapping value.

    bindingFor:providerBindingFor(()=>store.table(),{environmentId:supplier.environmentId,now:options.now,fallbackAccountKey:resolvedCompanyKey}),
    // Claiming is an exact ccount lookup performed by an authenticated subject; the transport still
    // enforces one literal filter and a bounded page, so this cannot become a directory scan.
    authorizeLookup:async()=>true,
    isInner:isInnerMode,
    authorizeAccount:async(context,accountKey)=>{const view=access(context.subjectId);return accountKey===view.companyAccountKey||decide({kind:'account',accountKey},view).allowed;}});}
  catch{return refuse('transport-unavailable',1);}
  // Endpoint set completeness: a transport missing one read path would answer 500 later, which is
  // strictly worse than refusing at startup where an operator can see it.
  for(const name of REQUIRED_ENDPOINTS){
    if(typeof (transport as unknown as Record<string,unknown>)[name]!=='function')return refuse('endpoints-incomplete',1);
  }

  let verify:MaterialsServerDependencies['verify'];
  try{
    verify=sessionMode==='supabase'
      ?createSupabaseVerifier({environmentId:supplier.environmentId,supabaseOrigin:supabaseOrigin as string,publishableKey:supabaseKey as string})
      :createHmacVerifier({secret,now:options.now,...(text(env.MATERIALS_DEBUG_SESSION)==='1'?{diagnostics:(info)=>logger.error(`${PREFIX} session refused reason=${info.reason} method=${info.method} path=${info.path} query=${JSON.stringify(info.query)} principalLength=${info.principalLength} principalSha8=${info.principalSha8??'none'} hasSignature=${info.hasSignature}`)}:{})});
  }catch{return refuse('session-mode-invalid',1);}
  // Claim / read / release. A claim is the only way a subject gets an account key, and it is
  // resolved with an exact `account` lookup - never a name match (names repeat), never an unverified
  // key handed in by the client.
  const numberIn=(value:unknown):number|undefined=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
    const source=value as {sourceType?:unknown;source?:unknown};
    if(source.sourceType!=='number'||typeof source.source!=='string'||!/^\d+$/.test(source.source))return undefined;
    const parsed=Number(source.source);
    return Number.isSafeInteger(parsed)?parsed:undefined;
  };
  const bindingApi:BindingApi=Object.freeze({
    read:(context)=>store.read(context.subjectId),
    async claim(context,input){
      const account=input.account;
      if(typeof account!=='string'||!account.length)return fail('binding-account-required',422);
      const lookup=await transport.lookupAccount(context,{field:'account',value:account});
      // `ambiguous` and `disabled` are refused exactly like `not-found`: no binding is better than a
      // wrong one.
      if(lookup.status!=='found')return fail('binding-account-not-found',400);
      const observation=lookup.account.observation as Record<string,unknown>;
      const teamId=numberIn(observation.teamId),groupId=numberIn(observation.groupId);
      return store.claim(context.subjectId,{account,accountKey:lookup.account.accountKey.value,...(teamId===undefined?{}:{teamId}),...(groupId===undefined?{}:{groupId})});
    },
    release:(context)=>store.release(context.subjectId),
  });
  // Staging must exist before the process claims to be ready: the raw route has no fallback.
  try{await assertStaging(staging);}
  catch{return refuse('staging-not-directory',1);}
  const materials=createMaterialsReadOnly({transport,access:async(context)=>access((context as {subjectId:string}).subjectId)});
  // A configured company key means the material centre is read as a company pool, so that becomes
  // the default scope; without one the safe default stays the caller's own account.
  const rawService=createRawService({
    transport,access,staging,hosts:rawHosts,maxBytes:rawMaxBytes,
    defaultScope:resolvedCompanyKey?'company':'own',
    // Diagnostic switch: a refused host is otherwise invisible, because nothing was fetched. The
    // callback prints the hostname only - never the URL, path or query.
    ...(debugRawHost?{onHostRefused:(hostname:string)=>logger.info(`${PREFIX} raw host refused host=${hostname}`)}:{}),
  });
  // The only place a successful download is logged. It carries the id, the byte count and how many
  // downloads this process has completed - the counter is what a real-machine run can use to count
  // query/raw calls without a fetch probe. No URL, no path, no key.
  let rawCount=0;
  const raw:RawService=Object.freeze({raw:async(context:unknown,videoId:unknown,videoType:unknown=1,scope?:unknown)=>{const result=await rawService.raw(context,videoId,videoType,scope);rawCount+=1;logger.info(`${PREFIX} raw videoId=${String(videoId)} bytes=${result.bytes} count=${rawCount}`);return result;}});
  const server=createMaterialsServer({verify,materials,raw,binding:bindingApi,origins,internal:Object.freeze({header:INTERNAL_SECRET_HEADER,secret}),version:version()});

  let bound:number;
  try{bound=await server.listen(port);}
  catch{await server.close().catch(()=>{});return refuse('port-unavailable',1);}

  const close=async()=>{await server.close();};
  logger.info(`${PREFIX} ready service=materials bind=127.0.0.1 port=${bound} origins=${origins.length} endpoints=${REQUIRED_ENDPOINTS.length}`);
  return Object.freeze({ok:true as const,service:Object.freeze({port:bound,close})});
}

/**
 * Orderly exit on SIGINT, SIGTERM and parent EOF on stdio. Idempotent: the first reason wins, the
 * server is closed once, and the process only leaves after the close has resolved.
 */
export function wireShutdown(options:Readonly<{
  close:()=>Promise<void>;
  stdin?:StdinLike|null;
  onSignal?:(signal:'SIGINT'|'SIGTERM',handler:()=>void)=>void;
  exit?:(code:number)=>void;
  logger?:Logger;
}>):void {
  const logger=options.logger??{info:(line=>process.stdout.write(line+'\n')),error:(line=>process.stderr.write(line+'\n'))};
  const exit=options.exit??((code:number)=>process.exit(code));
  let closing:Promise<void>|null=null;
  const stop=(reason:string)=>{
    if(closing)return;
    logger.info(`${PREFIX} stopping reason=${reason}`);
    closing=options.close().then(()=>exit(0),()=>exit(1));
  };
  const onSignal=options.onSignal??((signal,handler)=>{process.on(signal,handler);});
  onSignal('SIGINT',()=>stop('sigint'));
  onSignal('SIGTERM',()=>stop('sigterm'));
  const stdin:StdinLike|null|undefined=options.stdin===undefined?process.stdin:options.stdin;
  if(stdin){
    stdin.on('end',()=>stop('stdin-eof'));
    stdin.on('close',()=>stop('stdin-close'));
    stdin.on('error',()=>stop('stdin-error'));
    if(typeof stdin.resume==='function')stdin.resume();
  }
}

/** The real process path. Returns the exit code; only the entry guard below calls `process.exit`. */
export async function runMain(options:Readonly<{env?:Readonly<Record<string,string|undefined>>;logger?:Logger;stdin?:StdinLike|null;exit?:(code:number)=>void;stayAlive?:boolean}>={}):Promise<number> {
  const logger=options.logger??{info:(line=>process.stdout.write(line+'\n')),error:(line=>process.stderr.write(line+'\n'))};
  const started=await startMaterialsService({env:options.env,logger});
  if(!started.ok){
    logger.error(`${PREFIX} refusing: ${started.refusal.code}`);
    return started.refusal.exitCode;
  }
  if(options.stayAlive===false){await started.service.close();return 0;}
  wireShutdown({close:started.service.close,stdin:options.stdin,exit:options.exit??((code:number)=>process.exit(code)),logger});
  return -1;
}

const entry=process.argv[1];
if(entry&&resolve(entry)===resolve(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/,'')))
  void runMain().then(code=>{if(code>=0)process.exit(code);});
