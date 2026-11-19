// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The single place in the system that turns a `videoId` into a downloaded original.
 *
 * This is a **user action**, not a background read: `/openapi/video/query/raw` increments the
 * supplier's download counter, so the route is `POST`, it is called exactly once per request, there
 * is no retry, no preview, and no speculative prefetch.
 *
 * The caller's `scope` decides which layer the author is judged against: `own` (only the subject's
 * own account), `company` (the company view — the public pool, any author the company can see) or
 * `account:<key>` (one granted author). It defaults to `company` when a company key is configured,
 * because the material centre is a public pool, and to `own` otherwise.
 *
 * Field requirements learned from the live API. Each missing one answers `code=20000`, which reads
 * like a generic provider failure if you do not already know the rule:
 *  - `video/query/raw` requires `{videoId, isInner:0}`. Omitting `isInner` makes the supplier answer
 *    "isInner must not be empty", so it is always sent, as the number 0 - never the string '0',
 *    and never left out as "obviously implied";
 *  - `video/list` requires `account_key`, and takes `videoIds` as a bare string (an array answers
 *    20015);
 *  - `principal.environmentId` must equal the credential file's `environmentId`, or the transport's
 *    second gate (`zhishang.ts` `current()`) refuses a session that is otherwise valid.
 *
 * One thing the caller must get right: the `scope` is signed as part of the request line, so a proxy
 * must not add or rewrite it after signing.
 *
 * Order of operations — every refusal happens before the download, and the raw call happens only
 * after the author is proven visible:
 *   1. `videoId` shape;
 *   2. the three-layer decision from the binding table, using the caller's scope;
 *   3. one bounded `video/list?videoIds=` lookup to learn the row's author (this does not touch the
 *      download counter);
 *   4. the author must be visible in that layer;
 *   5. exactly one `query/raw` call;
 *   6. the URL must be `https:` and its host must be on the configured allow-list;
 *   7. the stream is written to staging with `wx` under a size cap; a partial file is removed on
 *      every failure path, including an over-limit abort.
 *
 * The supplier URL never leaves this module: the caller gets a local path, the byte count, the
 * sha256 and the derived file name.
 */
import {createHash,randomBytes} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fail,SupplierError} from './errors.ts';
import {hostAllowed} from './hosts.ts';
import {decide, type Access, type MaterialScope} from './authorization.ts';
import type {ZhishangReadOnly} from './zhishang.ts';

export type RawResult=Readonly<{path:string;bytes:number;sha256:string;name:string}>;
export type RawService=Readonly<{raw(context:unknown,videoId:unknown,videoType?:unknown,scope?:unknown):Promise<RawResult>}>;

export type RawDependencies=Readonly<{
  transport:ZhishangReadOnly;
  access:(subjectId:string)=>Access;
  staging:string;
  hosts:readonly string[];
  /** Called with the bare hostname when a raw URL is refused; the caller decides whether to log it. */
  onHostRefused?:(hostname:string)=>void;
  maxBytes:number;
  timeoutMs?:number;
  /** company when a company view key exists, own otherwise. */
  defaultScope?:'company'|'own';
}>;

const EXTENSIONS:readonly string[]=Object.freeze(['mp4','mov','mkv','webm']);
const VIDEO_ID=/^[\x21-\x7e]{1,64}$/;
const MAX_SCOPE=600;
const DOWNLOAD_TIMEOUT_MS=10*60*1000;

const denial=(reason:string):never=>{
  throw Object.assign(fail('authorization-denied',403),{authorization:Object.freeze({layer:null,reason})});
};

/**
 * `raw-<sha256(videoId) first 32>-<6 random hex>.<ext>`.
 *
 * The hash prefix keeps a staged file traceable back to its video when an operator looks at the
 * directory; the random suffix makes every download land in its own file, so asking for the same
 * video twice cannot collide on `wx`. Traversal-free and supplier-name-free by construction.
 */
export function stagingName(videoId:string,extension:string):string {
  const prefix=createHash('sha256').update(videoId,'utf8').digest('hex').slice(0,32);
  return 'raw-'+prefix+'-'+randomBytes(3).toString('hex')+'.'+extension;
}

/** The extension allow-list, read from the URL path. Anything else is refused, never renamed. */
export function extensionOf(url:string):string|null {
  const pathname=new URL(url).pathname.toLowerCase();
  const match=/\.([a-z0-9]{1,8})$/.exec(pathname);
  const extension=match?match[1]:null;
  return extension&&EXTENSIONS.includes(extension)?extension:null;
}

export function createRawService(dependencies:RawDependencies):RawService {
  if(!dependencies||!dependencies.transport||typeof dependencies.access!=='function')return fail('configuration-required');
  const {transport,access,staging,hosts,maxBytes,onHostRefused}=dependencies;
  const timeoutMs=Number.isSafeInteger(dependencies.timeoutMs)&&(dependencies.timeoutMs as number)>0?dependencies.timeoutMs as number:DOWNLOAD_TIMEOUT_MS;
  const defaultScope=dependencies.defaultScope==='company'?'company':'own';

  /** `own` / `company` / `account:<key>`, the same three shapes the list route accepts. */
  function parseScope(input:unknown):MaterialScope {
    if(input===undefined)return defaultScope==='company'?{kind:'company'}:{kind:'own'};
    if(typeof input!=='string'||input.length>MAX_SCOPE)return fail('invalid-query',422);
    if(input==='own')return {kind:'own'};
    if(input==='company')return {kind:'company'};
    if(input.startsWith('account:')){const accountKey=input.slice(8);if(!accountKey.length)return fail('invalid-query',422);return {kind:'account',accountKey};}
    return fail('invalid-query',422);
  }

  function authorize(context:unknown,scope:MaterialScope){
    const subject=(context as {subjectId?:unknown}).subjectId;
    if(typeof subject!=='string')denial('scope-invalid');
    const view=access(subject as string);
    const decision=decide(scope,view);
    if(!decision.allowed)denial(decision.authorization.reason);
    // Belt and braces for the transport's own rule: a decision that somehow carries no account key
    // must stop here, because the supplier answers `code=20000` to an account-less request and that
    // reads as a generic provider failure instead of "we were not allowed to read this".
    const granted=decision as Extract<typeof decision,{allowed:true}>;
    if(!granted.accountKey)denial(scope.kind==='company'?'company-view-unavailable':'self-binding-required');
    return {decision:decision as Extract<typeof decision,{allowed:true}>,view};
  }

  function visible(author:string|null,layer:'public'|'self'|'granted',view:Access):boolean {
    if(author===null)return false;
    if(layer==='public')return true;
    if(layer==='self')return typeof view.selfAccountKey==='string'&&author===view.selfAccountKey;
    return view.grants.includes(author);
  }

  /**
   * Streams the body into a brand-new file (`wx`), hashing as it goes and aborting over the cap.
   *
   * Two things this must never do: leave a handle open (on Windows the caller's cleanup `rm` then
   * fails silently) and let a stream `'error'` escape (an unhandled `'error'` on a write stream takes
   * the whole process down). So every write is raced against a failure promise fed by the sink's
   * `'error'` event, and read failures arrive as a rejected `reader.read()`; both end up as a
   * first-party error, never as an uncaught exception.
   */
  async function download(url:string,target:string):Promise<{bytes:number;sha256:string}> {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    const digest=createHash('sha256');
    let bytes=0,sink:ReturnType<typeof createWriteStream>|null=null;
    const closeSink=async()=>{
      const handle=sink;sink=null;
      if(!handle)return;
      if(handle.closed)return;
      await new Promise<void>(resolve=>{handle.once('close',()=>resolve());handle.destroy();});
    };
    let writeFailed:Promise<never>|null=null;
    try{
      const response=await fetch(url,{redirect:'error',signal:controller.signal});
      if(response.status<200||response.status>=300)return fail('raw-download-failed',502);
      const source=response.body;
      if(!source)return fail('raw-download-failed',502);
      const handle=createWriteStream(target,{flags:'wx'});
      sink=handle;
      // A write-stream error (EEXIST, EACCES, ENOSPC, a staging directory removed under us) is an
      // event, not a throw: without this listener the process would die. The catch below keeps it.
      writeFailed=new Promise<never>((_,reject)=>{handle.once('error',()=>reject(new SupplierError('staging-write-failed',500)));});
      writeFailed.catch(()=>{/* handled where it is raced; this only prevents an unhandled rejection */});
      const reader=source.getReader();
      while(true){
        const chunk=await Promise.race([reader.read(),writeFailed]);
        if(chunk.done)break;
        const value=chunk.value;
        if(!(value instanceof Uint8Array))return fail('raw-download-failed',502);
        bytes+=value.byteLength;
        if(bytes>maxBytes)return fail('raw-too-large',413);
        digest.update(value);
        if(!handle.write(Buffer.from(value.buffer,value.byteOffset,value.byteLength)))await Promise.race([new Promise<void>(resolve=>{handle.once('drain',()=>resolve());}),writeFailed]);
      }
      await Promise.race([new Promise<void>((resolve,reject)=>{handle.end((error?:Error|null)=>(error?reject(new SupplierError('staging-write-failed',500)):resolve()));}),writeFailed]);
      if(!handle.closed)await Promise.race([new Promise<void>(resolve=>{handle.once('close',()=>resolve());}),writeFailed]);
      sink=null;
      return {bytes,sha256:digest.digest('hex')};
    }catch(error){
      if(error instanceof SupplierError)throw error;
      const code=error&&typeof error==='object'?(error as {code?:unknown}).code:undefined;
      if(typeof code==='string'&&code.startsWith('raw-'))throw error;
      return fail('raw-download-failed',502);
    }finally{clearTimeout(timer);await closeSink();}
  }

  return Object.freeze({
    async raw(context:unknown,videoId:unknown,videoType:unknown=1,scopeInput:unknown):Promise<RawResult>{
      if(typeof videoId!=='string'||!VIDEO_ID.test(videoId))return fail('invalid-query',422);
      // The caller's own ideoType is used verbatim for the author lookup; guessing here would
      // either miss the row or, worse, look in a category the video is not in.
      const type=videoType===undefined?1:videoType;
      if(!Number.isSafeInteger(type)||(type as number)<0||(type as number)>4)return fail('invalid-query',422);
      const scope=parseScope(scopeInput);
      const {decision,view}=authorize(context,scope);

      // Author check first: one bounded list call filtered by the exact id. It does not touch the
      // download counter; `query/raw` is still called exactly once below.
      const listing=await transport.listMaterialsAs(context,decision.accountKey,{videoIds:videoId,pageSize:1,videoType:type as number});
      const row=listing.items.find(item=>item.videoId.value===videoId)??listing.items[0];
      if(!row)denial('video-not-visible');
      const author=typeof row.observation.accountKey==='string'?row.observation.accountKey:null;
      if(!visible(author,decision.authorization.layer,view))denial('video-author-not-visible');

      const raw=await transport.rawVideoUrl(context,decision.accountKey,videoId);
      let parsed:URL;
      try{parsed=new URL(raw.url);}catch{return fail('provider-response-unconfirmed');}
      if(parsed.protocol!=='https:')return fail('raw-host-not-allowed',403);
      if(!hostAllowed(parsed.hostname,hosts)){
        // Hostname only, and only when the operator asked for it: never the URL, path or query.
        onHostRefused?.(parsed.hostname.toLowerCase());
        return fail('raw-host-not-allowed',403);
      }
      const extension=extensionOf(raw.url);
      if(!extension)return fail('raw-type-not-allowed',422);

      const name=stagingName(videoId,extension),path=join(staging,name);
      try{
        const written=await download(raw.url,path);
        // Ownership of the staged file passes to the caller on success: this module does not delete
        // it, and it must not — the caller is still reading it. Removal is the Studio server's job,
        // once its own copy/registration step has settled, via `discardStaged(path)` below.
        return Object.freeze({path,bytes:written.bytes,sha256:written.sha256,name});
      }catch(error){
        // Every failure leaves staging clean, including an over-limit abort and a write error.
        await rm(path,{force:true}).catch(()=>{});
        throw error;
      }
    },
  });
}

/**
 * Removes one staged file. Idempotent: a path that is already gone is not an error, so the caller
 * can run it in a `finally` without turning a successful download into a failure.
 */
export async function discardStaged(path:string):Promise<void> {
  if(typeof path!=='string'||!path.length)return;
  await rm(path,{force:true}).catch(()=>{});
}

/** Startup check: the staging directory must exist and be a directory. */
export async function assertStaging(staging:string):Promise<void> {
  try{
    const info=await stat(staging);
    if(info.isDirectory())return;
  }catch{/* falls through to the shared refusal */}
  return fail('staging-not-directory',1);
}
