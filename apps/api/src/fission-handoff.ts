import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {open,lstat} from 'node:fs/promises';import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {createAdmission,BusinessError,requestDigest} from './admission.ts';
import {createFissionDispatcher} from './fission-dispatch.ts';
import {isVerifiedSession,type VerifiedSession} from './supabase.ts';
import type {createMaterials} from './materials.ts';
type Ref=Readonly<{batchId:string;index:number}>;
type Options={dispatcher:Awaited<ReturnType<typeof createFissionDispatcher>>;materials:Pick<Awaited<ReturnType<typeof createMaterials>>,'use'>;admission:ReturnType<typeof createAdmission>;runtime:{paths:Readonly<Record<string,string>>;pins:readonly {path:string;sha256:string}[]}};
function fail(code:string,status=503):never{throw new BusinessError(code,status);}
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
/** Fixed native output clock, checked before decode/evidence. Unknown clocks are not verified. */
export function assertFissionVideoClock(video:any,fps:number,duration:number){
 const rate=(raw:unknown)=>{if(typeof raw!=='string'||!/^\d+\/\d+$/.test(raw))fail('fission-video-verification-unconfirmed');const [n,d]=(raw as string).split('/').map(Number);if(!Number.isSafeInteger(n)||!Number.isSafeInteger(d)||n<=0||d<=0)fail('fission-video-verification-unconfirmed');return n/d;};
 const r=rate(video.r_frame_rate),avg=rate(video.avg_frame_rate),count=typeof video.nb_frames==='string'&&/^\d+$/.test(video.nb_frames)?Number(video.nb_frames):NaN,clock=Number(video.duration);
 if(!Number.isFinite(fps)||fps<=0||!Number.isFinite(duration)||duration<=0||Math.abs(r-fps)>1e-7||Math.abs(avg-fps)>1e-7||!Number.isSafeInteger(count)||count<=0||!Number.isFinite(clock)||clock<=0||Math.abs(count/fps-clock)>1/fps+1e-7||Math.abs(count/fps-duration)>1/fps+1e-7)fail('fission-video-verification-unconfirmed');
}
/** Concrete source/actual-file consumer. No caller JSON can create an evidence object. */
export function createFissionHandoff(options:Options){
 if(typeof options?.dispatcher?.withCandidate!=='function'||typeof options.materials?.use!=='function'||!options.admission||!options.runtime)fail('fission-handoff-unavailable');
 let sealed=false,failed=false;const entered=new Set<Promise<unknown>>(),controllers=new Set<AbortController>(),handles=new Set<FileHandle>();
 const evidence=new WeakMap<object,{context:VerifiedSession;claimId:string;nonce:string;contentKey:string;digest:string;evidenceId:string;active:boolean;deadline:number;signal:AbortSignal;video:any;videoHash:string}>();
 function current(ctx:unknown):VerifiedSession{if(!isVerifiedSession(ctx))fail('authentication-required',403);if(sealed||failed)fail('fission-preservation-failed');return ctx as VerifiedSession;}
 async function digest(fd:FileHandle,signal?:AbortSignal){const h=createHash('sha256'),buffer=Buffer.alloc(65536);let at=0;while(true){if(signal?.aborted)fail('fission-handoff-aborted');const r=await fd.read(buffer,0,buffer.length,at);if(!r.bytesRead)break;h.update(buffer.subarray(0,r.bytesRead));at+=r.bytesRead;}return h.digest('hex');}
 async function closeOwned(fd:FileHandle){try{await fd.close();handles.delete(fd);}catch{failed=true;sealed=true;fail('fission-preservation-failed');}}
 async function tool(c:any,label:string,exe:string,args:string[]){
  current(c.context);if(c.signal.aborted||Date.now()>=c.deadline)fail('fission-handoff-aborted');const pin=options.runtime.pins.find(p=>path.normalize(p.path)===path.normalize(exe));if(!pin)fail('fission-runtime-unavailable');const fd=await open(exe,'r');handles.add(fd);
  try{if((await fd.stat()).nlink!==1||await digest(fd,c.signal)!==pin.sha256)fail('fission-runtime-changed');if(c.signal.aborted||Date.now()>=c.deadline)fail('fission-handoff-aborted');
   const sys=process.env.SystemRoot||'C:\\Windows',env={SystemRoot:sys,WINDIR:sys,PATH:[path.dirname(exe),path.join(sys,'System32'),sys].join(';'),HOME:c.workingRoot,USERPROFILE:c.workingRoot,APPDATA:c.workingRoot,LOCALAPPDATA:c.workingRoot,TEMP:c.workingRoot,TMP:c.workingRoot};
   const started=Date.now(),child=spawn(exe,args,{cwd:c.workingRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let exit:{code:number|null;signal:NodeJS.Signals|null}|null=null,error:unknown=null,bytes=0,timedout=false,overflow=false;const stdout:Buffer[]=[],stderr:Buffer[]=[];
   const abort=()=>child.kill();c.signal.addEventListener('abort',abort,{once:true});if(c.signal.aborted)abort();const timer=setTimeout(()=>{timedout=true;child.kill();},180000);
   for(const stream of [child.stdout,child.stderr])stream.once('error',e=>{error=e;child.kill();});child.once('error',e=>error=e);child.once('exit',(code,signal)=>exit={code,signal});for(const [s,a]of [[child.stdout,stdout],[child.stderr,stderr]]as const)s.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>20*1024*1024){overflow=true;child.kill();}else a.push(b);});
   const close=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));clearTimeout(timer);c.signal.removeEventListener('abort',abort);const observed={label,pid:child.pid,started,elapsedMs:Date.now()-started,exit,close,timedout,overflow,error:!!error};
   if(error||timedout||overflow||c.signal.aborted||!exit||(exit as {code:number|null}).code!==0||close.code!==0)fail('fission-video-verification-unconfirmed');return {bytes:Buffer.concat(stdout),observed};
  }finally{await closeOwned(fd);}
 }
 function operation<T>(context:unknown,signal:AbortSignal|undefined,work:(ctx:VerifiedSession,controller:AbortController)=>Promise<T>):Promise<T>{
  const ctx=current(context),controller=new AbortController(),abort=()=>controller.abort('caller-aborted');controllers.add(controller);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=Promise.resolve().then(()=>work(ctx,controller)).catch(e=>{if(['fission-preservation-failed','material-preservation-failed'].includes((e as any).code)){failed=true;sealed=true;}throw e;}).finally(()=>{entered.delete(task);controllers.delete(controller);signal?.removeEventListener('abort',abort);});entered.add(task);return task;
 }
 return Object.freeze({
  withStudioPlan<T>(context:unknown,ref:Ref,consumer:(manifest:any)=>Promise<T>,signal?:AbortSignal){return operation(context,signal,(ctx,abort)=>options.dispatcher.withCandidate(ctx,ref,'studio',async c=>{
   if(c.receipt.transitions.shader!==null)fail('fission-resource-distribution-pending',422);
   const nativePlan=structuredClone(c.receipt);for(let i=0;i<nativePlan.sources.length;i++)nativePlan.sources[i].path='sources/'+i+c.sources[i].extension;
   const serialized=JSON.stringify(nativePlan),manifest={nativePlan,originalIndex:c.outputIndex,claimId:c.claimId,originalSidecarSHA256:c.receiptSHA256,transportNativePlanSHA256:hash(serialized),sources:c.sources.map((s:any)=>({ordinal:s.ordinal,versionId:s.versionId,contentSha256:s.sha256,kind:s.kind,durationSec:s.durationSec,extension:s.extension})),blockingCapabilities:[...new Set(['fission-postmix-loudnorm','media-equivalence-unverified',...c.receipt.blockingCapabilities])],exportReady:false,equivalenceVerified:false};
   return consumer(manifest);
  },abort.signal));},
  withSource<T>(context:unknown,ref:Ref,ordinal:number,consumer:(source:any)=>Promise<T>,signal?:AbortSignal){return operation(context,signal,(ctx,abort)=>options.dispatcher.withCandidate(ctx,ref,'studio',async c=>{
   if(!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=c.sources.length)fail('fission-source-ordinal-invalid',404);const source=c.sources[ordinal],lease=c.leases.find((l:any)=>l.versionId===source.versionId);if(!lease)fail('fission-source-association-pending');
   return consumer({handle:lease.handle,signal:c.signal,sha256:source.sha256,byteLength:(await lease.handle.stat()).size,ordinal,versionId:source.versionId});
  },abort.signal));},
  withVerifiedVideo<T>(context:unknown,ref:Ref,consumer:(verified:any)=>Promise<T>,signal?:AbortSignal){return operation(context,signal,(ctx,abort)=>options.dispatcher.withCandidate(ctx,ref,'export',async c=>{
   current(ctx);if(!c.video||c.signal.aborted)fail('fission-video-verification-unconfirmed');const videoHash=await digest(c.video.fd,c.signal);if(videoHash!==c.video.sha)fail('fission-candidate-changed');
   const probe=await tool({...c,context:ctx},'ffprobe',options.runtime.paths.FFprobe,['-v','error','-show_streams','-show_format','-of','json',c.video.file]),meta=JSON.parse(probe.bytes.toString()),videos=meta.streams?.filter((s:any)=>s.codec_type==='video'),audio=meta.streams?.filter((s:any)=>s.codec_type==='audio'),plan=c.claim.frozenPlan;
   const duration=Number(meta.format?.duration),fps=Number(plan.fps);if(videos?.length!==1||audio?.length!==1||!Number.isFinite(duration)||duration<=0||Number(videos[0].width)!==c.receipt.stage.w||Number(videos[0].height)!==c.receipt.stage.h||Math.abs(duration-c.receipt.durationSec)>1/fps||Math.abs(duration-plan.durationSec)>1/fps)fail('fission-video-verification-unconfirmed');
   if(c.receipt.fps!==fps)fail('fission-video-verification-unconfirmed');assertFissionVideoClock(videos[0],fps,duration);
   const decode=await tool({...c,context:ctx},'decode',options.runtime.paths.FFmpeg,['-nostdin','-v','error','-threads','1','-i',c.video.file,'-f','null','-']);if(await digest(c.video.fd,c.signal)!==videoHash)fail('fission-candidate-changed');
   const token=Object.freeze({}),value={context:ctx,claimId:c.claimId,nonce:c.nonce,contentKey:c.claim.contentKey,digest:requestDigest({kind:'video',claim:c.claimId,index:c.outputIndex,nonce:c.nonce,contentKey:c.claim.contentKey,videoHash,receiptHash:c.receiptSHA256,snapshotHash:c.snapshotSHA256}),evidenceId:randomUUID(),active:true,deadline:c.deadline,signal:c.signal,video:c.video.fd,videoHash};evidence.set(token,value);
   try{return await consumer({claimId:c.claimId,evidence:token,handle:c.video.fd,byteLength:c.video.size,sha256:videoHash,signal:c.signal,verification:{probe:meta,processes:[probe.observed,decode.observed],receiptSHA256:c.receiptSHA256,index:c.outputIndex}});}finally{value.active=false;}
  },abort.signal));},
  async verifyDelivery(context:VerifiedSession,claimId:string,received:unknown){
   const ctx=current(context),record=received&&typeof received==='object'?evidence.get(received as object):undefined;
   if(!record||!record.active||record.context!==ctx||record.context.subjectId!==ctx.subjectId||record.context.sessionId!==ctx.sessionId||record.context.environmentId!==ctx.environmentId||record.claimId!==claimId||record.signal.aborted||Date.now()>=record.deadline)fail('fission-delivery-evidence-denied',403);
   if(await digest(record.video,record.signal)!==record.videoHash||record.signal.aborted||Date.now()>=record.deadline)fail('fission-candidate-changed');
   return {evidenceId:record.evidenceId,kind:'video' as const,contentKey:record.contentKey,digest:record.digest};
  },
  async close(){sealed=true;for(const c of controllers)c.abort('service-stop');await Promise.all([...entered].map(p=>p.then(()=>{},()=>{})));if(failed||handles.size)fail('fission-preservation-failed');},
 });
}
