import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,open,readdir,realpath,readFile} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {dirname,extname,isAbsolute,join,normalize,parse} from 'node:path';
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
import {createAdmission,requestDigest} from './admission.ts';import {isVerifiedSession,type VerifiedSession} from './supabase.ts';

type Rpc=(operation:string,args:Record<string,unknown>)=>Promise<any>;
type Options={environmentId:string;materialRoot:string};
type Receipt={subjectId:string;environmentId:string;requestHash:string;assetId:string;versionId:string;locatorId:string;fileName:string;name:string;sha256:string;byteLength:number;identity:Record<string,string>;reviewRequired:boolean;status:'preparing'|'registered';kind:'video'|'still'|'sound'|null;durationSec:number|null;probeRevision:number|null;probe:Record<string,unknown>|null;created?:boolean};
export type MaterialLease=Readonly<{versionId:string;handle:FileHandle;path:string;kind:'video'|'still'|'sound';durationSec:number;signal:AbortSignal}>;
const error=(code:string,status=503)=>Object.assign(new Error(code),{code,status});
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const equal=(a:unknown,b:unknown)=>requestDigest(a)===requestDigest(b);
async function ordinary(file:string,allowMissing=false):Promise<void>{
 const target=normalize(file);if(!isAbsolute(target)||target===parse(target).root)throw error('material-path-denied',403);
 for(let p=target;;p=dirname(p)){const s=await lstat(p).catch(e=>{if(allowMissing&&e.code==='ENOENT')return null;throw e;});if(s&&(s.isSymbolicLink()||(p===target?s.isFile()&&s.nlink!==1:!s.isDirectory())))throw error('material-path-denied',403);if(p===dirname(p))break;}
 if(!allowMissing&&(await realpath(target)).toLowerCase()!==target.toLowerCase())throw error('material-path-denied',403);
}
async function identity(fd:FileHandle){const s=await fd.stat({bigint:true});if(!s.isFile()||s.nlink!==1n)throw error('material-file-changed',403);return {dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs),nlink:String(s.nlink)};}
async function digest(fd:FileHandle){const h=createHash('sha256'),b=Buffer.alloc(65536);let at=0;while(true){const r=await fd.read(b,0,b.length,at);if(!r.bytesRead)break;h.update(b.subarray(0,r.bytesRead));at+=r.bytesRead;}return h.digest('hex');}
function receipt(value:any,context:VerifiedSession,environmentId:string):Receipt{
 if(!value||value.subjectId!==context.subjectId||value.environmentId!==environmentId||!uuid(value.assetId)||!uuid(value.versionId)||!uuid(value.locatorId)||!/^source\.[a-z0-9]{1,8}$/.test(value.fileName)||!['preparing','registered'].includes(value.status)||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.byteLength)||value.byteLength<1||!value.identity||value.identity.nlink!=='1'||value.identity.size!==String(value.byteLength))throw error('material-registration-unconfirmed');return value;
}
function facts(probe:any,head:Buffer,tail:Buffer,bytes:number):{kind:'video'|'still'|'sound';durationSec:number}{
 if(!probe||typeof probe!=='object'||typeof probe.audio!=='boolean')throw error('material-probe-unconfirmed',422);
 const picture=Number.isSafeInteger(probe.width)&&probe.width>0&&Number.isSafeInteger(probe.height)&&probe.height>0;
 if(Number.isFinite(probe.duration)&&probe.duration>0){if(picture)return {kind:'video',durationSec:probe.duration};if(probe.audio&&probe.width===undefined&&probe.height===undefined)return {kind:'sound',durationSec:probe.duration};}
 const png=head.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&tail.subarray(-12).equals(Buffer.from('0000000049454e44ae426082','hex'))&&probe.codec==='png';
 const jpeg=head.subarray(0,3).equals(Buffer.from('ffd8ff','hex'))&&tail.subarray(-2).equals(Buffer.from('ffd9','hex'))&&probe.codec==='mjpeg';
 const gif=/^GIF8[79]a/.test(head.toString('ascii',0,6))&&tail.at(-1)===0x3b&&probe.codec==='gif';
 const webp=head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WEBP'&&head.readUInt32LE(4)+8===bytes&&probe.codec==='webp';
 if(picture&&!probe.audio&&probe.duration===undefined&&(png||jpeg||gif||webp))return {kind:'still',durationSec:0};throw error('material-probe-unconfirmed',422);
}

/** A byte/version service, not a permission or media library. Only trusted Node callers receive leases. */
export async function createMaterials(options:Options,{rpc,requireReview=()=>false}:{rpc:Rpc;requireReview?:(context:VerifiedSession)=>boolean}){
 if(!options||typeof options.environmentId!=='string'||!options.environmentId||!isAbsolute(options.materialRoot)||typeof rpc!=='function')throw error('material-configuration-required');
 const root=normalize(options.materialRoot);await ordinary(root,true);
 const marker=join(root,'orange-material-store.json');
 try{await lstat(root);await ordinary(root);if(!(await readdir(root)).includes('orange-material-store.json')&&(await readdir(root)).length)throw error('material-path-denied',403);}catch(e){if((e as any).code!=='ENOENT')throw e;await ordinary(root,true);await mkdir(root);}
 await ordinary(marker,true);try{const fd=await open(marker,'wx',0o600);try{await fd.writeFile(JSON.stringify({version:1,environmentId:options.environmentId}));}finally{await fd.close();}}catch(e){if((e as any).code!=='EEXIST')throw e;}
 await ordinary(marker);if((await lstat(marker)).size>32768||!equal(JSON.parse(await readFile(marker,'utf8')),{version:1,environmentId:options.environmentId}))throw error('material-configuration-required');
 const rootStat=await lstat(root,{bigint:true}),require=createRequire(import.meta.url),nativeRoot=dirname(require.resolve('openfilm/package.json'));
 const {probe}=await import(pathToFileURL(join(nativeRoot,'studio/server/derived.mjs')).href);
 const authority=createAdmission({rpc});let sealed=false,failed=false;const entered=new Set<Promise<unknown>>(),controllers=new Set<AbortController>();
 const current=(context:unknown):VerifiedSession=>{if(!isVerifiedSession(context)||context.environmentId!==options.environmentId)throw error('authentication-required',403);return context;};
 async function guard(){await ordinary(root);const s=await lstat(root,{bigint:true});if(s.dev!==rootStat.dev||s.ino!==rootStat.ino)throw error('material-path-denied',403);}
 async function directory(dir:string){await guard();await ordinary(dir,true);await mkdir(dir,{recursive:true});await ordinary(dir);}
 const auth=(ctx:VerifiedSession)=>({p_actor:ctx.subjectId,p_session:ctx.sessionId,p_until:new Date(ctx.expiresAtMs).toISOString(),p_environment:options.environmentId});
 function operation<T>(context:unknown,signal:AbortSignal|undefined,work:(ctx:VerifiedSession,abort:AbortController)=>Promise<T>):Promise<T>{
  if(sealed)return Promise.reject(error('material-stopping'));const ctx=current(context),abort=new AbortController(),cancel=()=>abort.abort();controllers.add(abort);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)abort.abort();
  const p=Promise.resolve().then(()=>{current(ctx);if(sealed||abort.signal.aborted)throw error('material-cancelled');return work(ctx,abort);}).finally(()=>{controllers.delete(abort);signal?.removeEventListener('abort',cancel);entered.delete(p);});entered.add(p);return p;
 }
 const check=(ctx:VerifiedSession,abort:AbortController)=>{current(ctx);if(abort.signal.aborted||sealed)throw error('material-cancelled');};
 async function verifyFile(file:string,fd:FileHandle,r:Receipt){await guard();await ordinary(file);const actual=await identity(fd),pathFd=await open(file,'r');try{if(!equal(actual,await identity(pathFd))||!equal(actual,r.identity)||await digest(fd)!==r.sha256)throw error('material-file-changed',403);}finally{await pathFd.close();}}
 const stored=(ctx:VerifiedSession,r:Receipt)=>join(root,hash(options.environmentId),ctx.subjectId,r.locatorId,r.fileName);
 return Object.freeze({
  async register(context:unknown,input:{key:string;name:string},body:AsyncIterable<Uint8Array>,signal?:AbortSignal){return operation(context,signal,async(ctx,abort)=>{
   if(!input||Object.keys(input).sort().join()!=='key,name'||typeof input.key!=='string'||input.key.length<1||input.key.length>120||typeof input.name!=='string'||input.name.length>128||!input.name||/[\/\\\x00-\x1f]/.test(input.name)||!/^\.[a-z0-9]{1,8}$/i.test(extname(input.name)))throw error('invalid-input',422);
   const reviewRequired=requireReview(ctx);if(typeof reviewRequired!=='boolean')throw error('material-review-policy-unconfirmed');
   const assetId=randomUUID(),versionId=randomUUID(),locatorId=randomUUID(),fileName='source'+extname(input.name).toLowerCase(),dir=join(root,hash(options.environmentId),ctx.subjectId,locatorId),file=join(dir,fileName);
   await directory(dir);await ordinary(file,true);check(ctx,abort);const fd=await open(file,'wx+',0o600);const stopBody=()=>{if(typeof(body as any).destroy==='function')(body as any).destroy(error('material-cancelled'));};abort.signal.addEventListener('abort',stopBody,{once:true});
   try{let length=0;const h=createHash('sha256');for await(const chunk of body){check(ctx,abort);if(!(chunk instanceof Uint8Array)||length+chunk.byteLength>536870912)throw error('material-upload-limit',413);await guard();await ordinary(file);check(ctx,abort);let offset=0;while(offset<chunk.length){const result=await fd.write(chunk,offset,chunk.length-offset,length+offset);if(!result.bytesWritten)throw error('material-write-unconfirmed');offset+=result.bytesWritten;}length+=chunk.byteLength;h.update(chunk);}
    if(!length)throw error('invalid-input',422);await fd.sync();check(ctx,abort);const fileIdentity=await identity(fd),sha256=h.digest('hex'),requestHash=requestDigest({name:input.name,sha256,byteLength:length,reviewRequired});
    const r=receipt(await rpc('begin_material',{...auth(ctx),p_key:input.key,p_payload:{assetId,versionId,locatorId,fileName,name:input.name,sha256,byteLength:length,identity:fileIdentity,requestHash,reviewRequired}}),ctx,options.environmentId);check(ctx,abort);
    if(r.requestHash!==requestHash)throw error('material-registration-unconfirmed');
    if(r.status==='registered')return {assetId:r.assetId,versionId:r.versionId,registration:'registered' as const,licensed:false as const};
    if(r.created!==true||r.locatorId!==locatorId||r.versionId!==versionId)throw error('material-registration-pending');
    await verifyFile(file,fd,r);for(const relative of ['.film','.film/cache','.film/cache/probe'])await directory(join(dir,relative));
    // Native probe has no abort/timeout. Its real promise is always retained.
    check(ctx,abort);const actual=await probe(dir,fileName);check(ctx,abort);await verifyFile(file,fd,r);const head=Buffer.alloc(32),tail=Buffer.alloc(Math.min(32,length));await fd.read(head,0,Math.min(32,length),0);await fd.read(tail,0,tail.length,length-tail.length);const media=facts(actual,head,tail,length);
    const done=receipt(await rpc('finish_material',{...auth(ctx),p_key:input.key,p_hash:requestHash,p_result:{...media,probeRevision:1,probe:actual}}),ctx,options.environmentId);check(ctx,abort);if(done.status!=='registered'||done.versionId!==versionId||done.locatorId!==locatorId||done.requestHash!==requestHash)throw error('material-registration-unconfirmed');await verifyFile(file,fd,done);
    return {assetId:done.assetId,versionId:done.versionId,registration:'registered' as const,licensed:false as const};
   }finally{abort.signal.removeEventListener('abort',stopBody);try{await fd.close();}catch{failed=true;sealed=true;throw error('material-preservation-failed');}}
  });},
  async use<T>(context:unknown,versionIds:string[],purpose:'studio'|'fission'|'export',consumer:(leases:readonly MaterialLease[])=>Promise<T>,signal?:AbortSignal){return operation(context,signal,async(ctx,abort)=>{
   const permissions=await authority.resolve(ctx,versionIds,purpose);check(ctx,abort);const held:{fd:FileHandle;file:string;r:Receipt}[]=[];
   try{for(let i=0;i<versionIds.length;i++){const r=receipt(await rpc('locate_material',{...auth(ctx),p_version:versionIds[i],p_purpose:purpose}),ctx,options.environmentId);check(ctx,abort);const p=permissions[i];if(r.versionId!==p.versionId||r.sha256!==p.contentSha256||r.kind!==p.kind||r.durationSec!==p.durationSec||r.probeRevision!==p.probeRevision)throw error('material-file-changed',403);const file=stored(ctx,r);await guard();await ordinary(file);const fd=await open(file,'r');held.push({fd,file,r});await verifyFile(file,fd,r);check(ctx,abort);}
    const result=await consumer(held.map(({fd,file,r})=>Object.freeze({versionId:r.versionId,handle:fd,path:file,kind:r.kind!,durationSec:r.durationSec!,signal:abort.signal})));check(ctx,abort);
    await authority.resolve(ctx,versionIds,purpose);check(ctx,abort);for(const {fd,file,r}of held)await verifyFile(file,fd,r);return result;
   }finally{for(const {fd}of held)try{await fd.close();}catch{failed=true;sealed=true;}if(failed)throw error('material-preservation-failed');}
  });},
  async close(){sealed=true;for(const abort of controllers)abort.abort();await Promise.all([...entered].map(p=>p.catch(()=>{})));if(failed)throw error('material-preservation-failed');},
 });
}
