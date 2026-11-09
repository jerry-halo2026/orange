import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,open,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createAdmission,mapPreparedFissionOutput,requestDigest,contentKey,BusinessError} from './admission.ts';
import {isVerifiedSession,type VerifiedSession} from './supabase.ts';
import type {createMaterials,MaterialLease} from './materials.ts';

type Admission=ReturnType<typeof createAdmission>;
type Pin=Readonly<{path:string;sha256:string}>;
type Runtime=Readonly<{dotnet:string;cli:string;paths:Readonly<Record<string,string>>;pins:readonly Pin[];binding:Pin}>;
type Request={groupId:string;projectId:string;filmRev:string;job:Record<string,any>;idempotencyKey:string;sourceSelection:{video:{group:string;versionIds:string[]}[];audio:string[];bgm:string[];intro:string[];outro:string[]}};
type Output={index:number;state:string;code?:string;claimId?:string;contentKey?:string;nonce?:string};
type State={id:string;subject:string;hash:string;request:Request;dir:string;status:string;outputs:Output[];controller:AbortController;task:Promise<void>;counter:number;authDeadline:number;timer?:ReturnType<typeof setTimeout>;error?:string};
const fail=(code:string,status=503):never=>{throw new BusinessError(code,status);};
const object=(v:unknown):Record<string,any>=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('fission-invalid-input',422);return v as Record<string,any>;};
const exact=(v:unknown,keys:string[])=>{const o=object(v);if(Object.keys(o).length!==keys.length||keys.some(k=>!Object.hasOwn(o,k)))fail('fission-invalid-input',422);return o;};
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const inside=(root:string,file:string)=>{const rel=path.relative(root,file);return rel!==''&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
const uuid=(v:unknown)=>{if(typeof v!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v))fail('fission-invalid-input',422);return (v as string).toLowerCase();};
const ids=(v:unknown)=>{if(!Array.isArray(v)||v.length>10000)fail('fission-invalid-input',422);const a=(v as unknown[]).map(uuid);if(new Set(a).size!==a.length)fail('fission-invalid-input',422);return a;};
async function ordinary(file:string,missing=false){
 if(!path.isAbsolute(file)||path.normalize(file)!==file||file===path.parse(file).root)fail('fission-path-denied',403);
 for(let at=file;;at=path.dirname(at)){const s=await lstat(at).catch(e=>{if(missing&&e.code==='ENOENT')return null;throw e;});if(s&&(s.isSymbolicLink()||(at===file?s.isFile()&&s.nlink!==1:!s.isDirectory())))fail('fission-path-denied',403);if(at===path.dirname(at))break;}
 if(!missing&&(await realpath(file)).toLowerCase()!==file.toLowerCase())fail('fission-path-denied',403);
}
async function fileHash(file:string){await ordinary(file);const fd=await open(file,'r');try{const h=createHash('sha256');for await(const bytes of fd.createReadStream({autoClose:false,start:0}))h.update(bytes);return h.digest('hex');}finally{await fd.close();}}
async function jsonFile(file:string,max=4194304){await ordinary(file);const fd=await open(file,'r');try{if((await fd.stat()).size>max)fail('fission-artifact-invalid');return JSON.parse(await fd.readFile('utf8'));}finally{await fd.close();}}
function request(raw:unknown):Request{
 const r=exact(raw,['groupId','projectId','filmRev','job','idempotencyKey','sourceSelection']),selection=exact(r.sourceSelection,['video','audio','bgm','intro','outro']),job=object(r.job);
 if(typeof r.projectId!=='string'||!r.projectId||r.projectId.length>512||typeof r.filmRev!=='string'||!/^[a-f0-9]{16}$/.test(r.filmRev)||typeof r.idempotencyKey!=='string'||!r.idempotencyKey||r.idempotencyKey.length>120||typeof job.VideoDir!=='string'||!job.VideoDir||!Number.isSafeInteger(job.Count)||job.Count<0||job.Count>10000||!Number.isSafeInteger(job.Threads)||job.Threads<1||job.Threads>64)fail('fission-invalid-input',422);
 if(!Array.isArray(selection.video)||!selection.video.length||selection.video.length>10000)fail('fission-invalid-input',422);
 const names=new Set<string>(),video:Request['sourceSelection']['video']=(selection.video as unknown[]).map((raw:unknown)=>{const row=exact(raw,['group','versionIds']);if(typeof row.group!=='string'||row.group.length>100||/[\\/\x00-\x1f]/.test(row.group)||['.','..'].includes(row.group)||/[. ]$/.test(row.group)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(row.group)||names.has(row.group))fail('fission-invalid-input',422);names.add(row.group);const versionIds=ids(row.versionIds);if(!versionIds.length)fail('fission-invalid-input',422);return {group:row.group,versionIds};});
 const result={groupId:uuid(r.groupId),projectId:r.projectId,filmRev:r.filmRev,job:structuredClone(job),idempotencyKey:r.idempotencyKey,sourceSelection:{video,audio:ids(selection.audio),bgm:ids(selection.bgm),intro:ids(selection.intro),outro:ids(selection.outro)}};
 if(job.AudioDir&&!result.sourceSelection.audio.length)fail('fission-invalid-input',422);
 for(const [key,role]of [['BgmDir','bgm'],['IntroDir','intro'],['OutroDir','outro']]as const)if(!job[key]&&result.sourceSelection[role].length)fail('fission-invalid-input',422);
 if(new Set([...video.flatMap(v=>v.versionIds),...result.sourceSelection.audio,...result.sourceSelection.bgm,...result.sourceSelection.intro,...result.sourceSelection.outro]).size>10000)fail('fission-invalid-input',422);
 return result;
}
const instant=(v:unknown)=>{if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT.+(?:Z|\+00:00)$/.test(v))fail('fission-deadline-unavailable');const t=Date.parse(v as string);if(!Number.isFinite(t))fail('fission-deadline-unavailable');return t;};
/** Actual RPC cutoff, never JWT-only fallback or guessed requested duration. */
export function authorizationDeadline(ctx:VerifiedSession,materials:readonly any[]){
 if(!materials.length||!Number.isFinite(ctx.expiresAtMs))fail('fission-deadline-unavailable');let auth=ctx.expiresAtMs,until=auth;
 for(const m of materials){auth=Math.min(auth,instant(m.authNotAfter));if(!Object.hasOwn(m,'notAfter'))fail('fission-deadline-unavailable');if(m.notAfter!==null)until=Math.min(until,instant(m.notAfter));}
 until=Math.min(until,auth);if(until<=Date.now())fail('fission-authorization-expired',403);return {auth,until};
}
/** Candidate consistency only, not media equivalence, export permission or verified delivery. */
export function assertNativeCandidateReceipt(prepared:unknown,index:number,receipt:unknown):void{
 const snapshot=object(prepared),r=object(receipt),matches=Array.isArray(snapshot.outputs)?snapshot.outputs.filter((o:any)=>o.index===index):[];
 if(matches.length!==1||r.schemaVersion!==1||r.jobId!==snapshot.jobId||r.outputIndex!==index||!Array.isArray(r.sources)||!Array.isArray(r.visuals))fail('fission-output-unconfirmed');
 const expected=matches[0];if(!Array.isArray(expected.sources)||!Array.isArray(expected.cuts)||r.sources.length!==expected.sources.length||requestDigest(r.visuals)!==requestDigest(expected.cuts.map((c:any)=>c.decision)))fail('fission-output-unconfirmed');
 for(let i=0;i<r.sources.length;i++)if(r.sources[i].path!==expected.sources[i].path||r.sources[i].sha256!==expected.sources[i].sha256||r.sources[i].kind!==expected.sources[i].kind)fail('fission-output-unconfirmed');
}
/** A private startup file, not an HTTP plugin/config or credential distribution. */
export async function readFissionConfiguration(file:unknown){
 if(file===undefined)return null;if(typeof file!=='string')fail('fission-runtime-unavailable');const config=exact(await jsonFile(path.normalize(file as string),65536),['environmentId','dispatchRoot','runtime']);return config;
}
export async function createFissionDispatcher(options:{environmentId:string;dispatchRoot:string;runtime:Runtime;materials:Pick<Awaited<ReturnType<typeof createMaterials>>,'use'>;admission:Admission}){
 if(!options||typeof options.environmentId!=='string'||!options.environmentId||typeof options.materials?.use!=='function'||!options.admission)fail('fission-runtime-unavailable');
 const root=path.normalize(options.dispatchRoot),runtime=structuredClone(options.runtime);await ordinary(root,true);await mkdir(root,{recursive:true});await ordinary(root);const rootInfo=await lstat(root,{bigint:true});
 const marker=path.join(root,'orange-fission-root.json'),rootMarker={version:1,environmentId:options.environmentId};
 try{await writeFile(marker,JSON.stringify(rootMarker),{flag:'wx',mode:0o600});}catch(e){if((e as any).code!=='EEXIST')throw e;if(requestDigest(await jsonFile(marker,32768))!==requestDigest(rootMarker))fail('fission-runtime-unavailable');}
 const states=new Map<string,State>();let sealed=false;
 const current=(context:unknown)=>{if(!isVerifiedSession(context)||context.environmentId!==options.environmentId)fail('authentication-required',403);return context as VerifiedSession;};
 async function guard(){await ordinary(root);const s=await lstat(root,{bigint:true});if(s.dev!==rootInfo.dev||s.ino!==rootInfo.ino)fail('fission-path-denied',403);}
 async function own(file:string,missing=false){if(!inside(root,file))fail('fission-path-denied',403);await guard();await ordinary(file,missing);}
 async function directory(dir:string){await own(dir,true);await mkdir(dir,{recursive:true});await own(dir);}
 async function save(state:State,name:string,value:unknown){const file=path.join(state.dir,String(state.counter++).padStart(4,'0')+'-'+name+'.json');await own(file,true);await writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
 const publicState=(s:State)=>({batchId:s.id,status:s.status,outputs:s.outputs.map(({index,state,code,claimId,contentKey})=>({index,state,...(code?{code}:{}),...(claimId?{claimId}:{}),...(contentKey?{contentKey}:{})})),executionReady:false,deliveryVerified:false,...(s.error?{code:s.error}:{})});
 function check(ctx:VerifiedSession,s:State){current(ctx);if(sealed||s.controller.signal.aborted)fail('fission-cancelled');}
 function setDeadline(s:State,ctx:VerifiedSession,rows:any[]){const d=authorizationDeadline(ctx,rows);s.authDeadline=Math.min(s.authDeadline,d.auth);if(s.timer)clearTimeout(s.timer);const until=Math.min(d.until,s.authDeadline);if(until<=Date.now())fail('fission-authorization-expired',403);s.timer=setTimeout(()=>s.controller.abort('authorization-expired'),Math.min(until-Date.now(),2147483647));return {authNotAfter:new Date(s.authDeadline).toISOString(),notAfter:new Date(until).toISOString()};}
 async function verifyRuntime(){
  if(!runtime||!path.isAbsolute(runtime.dotnet)||!path.isAbsolute(runtime.cli)||!runtime.paths||!Array.isArray(runtime.pins)||!runtime.binding)fail('fission-runtime-unavailable');
  const required=['FFmpeg','FFprobe','FFmpeg6','TransitionsDir','AssetsRoot','LocalAssetsRoot'];if(Object.keys(runtime.paths).length!==6||required.some(k=>typeof runtime.paths[k]!=='string'||!path.isAbsolute(runtime.paths[k])))fail('fission-runtime-unavailable');
  for(const pin of runtime.pins){if(!/^[a-f0-9]{64}$/.test(pin.sha256)||await fileHash(path.normalize(pin.path))!==pin.sha256)fail('fission-runtime-changed');}
  for(const file of [runtime.dotnet,runtime.cli,runtime.paths.FFmpeg,runtime.paths.FFprobe,runtime.paths.FFmpeg6])if(!runtime.pins.some(p=>path.normalize(p.path)===path.normalize(file)))fail('fission-runtime-unavailable');
  if(await fileHash(path.normalize(runtime.binding.path))!==runtime.binding.sha256)fail('fission-runtime-changed');const binding=await jsonFile(path.normalize(runtime.binding.path));if(!Array.isArray(binding.graph)||binding.graph.length!==6||binding.graph.some((g:any)=>!g.allDocumentsMatched))fail('fission-runtime-unavailable');
  for(const g of binding.graph.filter((g:any)=>g.project!=='Fission.UnitTests'))for(const ext of ['dll','pdb']){const file=path.join(path.dirname(runtime.cli),g.project+'.'+ext),pin=runtime.pins.find(p=>path.normalize(p.path)===file);if(!pin||pin.sha256!==g[ext+'SHA256'])fail('fission-runtime-changed');}
 }
 function childEnv(base:string){const system=process.env.SystemRoot||'C:\\Windows',programFiles=process.env.ProgramFiles||'C:\\Program Files';return {SystemRoot:system,WINDIR:system,ComSpec:path.join(system,'System32/cmd.exe'),PATH:[path.dirname(runtime.paths.FFmpeg),path.dirname(runtime.dotnet),path.join(system,'System32'),system].join(';'),PATHEXT:'.COM;.EXE;.BAT;.CMD',HOME:base,USERPROFILE:path.join(base,'user'),APPDATA:path.join(base,'appdata'),LOCALAPPDATA:path.join(base,'localappdata'),ProgramData:path.join(base,'programdata'),ALLUSERSPROFILE:path.join(base,'programdata'),TEMP:path.join(base,'temp'),TMP:path.join(base,'temp'),TMPDIR:path.join(base,'temp'),DOTNET_CLI_HOME:path.join(base,'clihome'),DOTNET_ROOT:path.dirname(runtime.dotnet),DOTNET_ROOT_X64:path.dirname(runtime.dotnet),DOTNET_HOST_PATH:runtime.dotnet,ProgramFiles:programFiles,'ProgramFiles(x86)':process.env['ProgramFiles(x86)']||programFiles,DOTNET_NOLOGO:'1',DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1',FISSION_PARENT_STDIN_EOF:'1'};}
 async function worker(s:State,ctx:VerifiedSession,mode:string,args:string[]){
  check(ctx,s);await verifyRuntime();const envRoot=path.join(s.dir,'env-'+mode);await directory(envRoot);const env=childEnv(envRoot);for(const v of Object.values(env).filter(v=>v.startsWith(envRoot)))await directory(v);
  if(s.dir.length>=250)fail('fission-runtime-path-too-long');check(ctx,s);const allArgs=[runtime.cli,mode,...args],start=Date.now(),child=spawn(runtime.dotnet,allArgs,{cwd:s.dir,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let exit:{code:number|null;signal:NodeJS.Signals|null}|null=null,error:unknown=null,bytes=0,overflow=false,timedout=false;const stdout:Buffer[]=[],stderr:Buffer[]=[];
  const cancel=()=>{if(!child.stdin.destroyed)child.stdin.end();};s.controller.signal.addEventListener('abort',cancel,{once:true});if(s.controller.signal.aborted)cancel();
  const timer=setTimeout(()=>{timedout=true;s.controller.abort('worker-timeout');},180000);
  for(const [stream,chunks]of [[child.stdout,stdout],[child.stderr,stderr]]as const)stream.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>20*1024*1024){overflow=true;s.controller.abort('worker-log-limit');}else chunks.push(b);});
  for(const stream of [child.stdin,child.stdout,child.stderr])stream.on('error',e=>{error=e;s.controller.abort('worker-stream-error');});child.once('error',e=>{error=e;});child.once('exit',(code,signal)=>{exit={code,signal};});
  const close=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));clearTimeout(timer);s.controller.signal.removeEventListener('abort',cancel);
  await save(s,'worker-'+mode,{pid:child.pid,args:allArgs,started:start,elapsedMs:Date.now()-start,exit,close,bytes,overflow,timedout,error:!!error,aborted:s.controller.signal.aborted,abortReason:s.controller.signal.reason??null,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()});
  if(error||overflow||timedout||s.controller.signal.aborted)fail('fission-worker-unconfirmed');if(!exit||close.code!==0||(exit as {code:number|null}).code!==0)fail('fission-worker-failed');return Buffer.concat(stdout).toString();
 }
 async function copyLease(s:State,ctx:VerifiedSession,lease:MaterialLease,destination:string,meta:any){
  if(inside(root,lease.path)||lease.versionId!==meta.versionId||lease.kind!==meta.kind||lease.durationSec!==meta.durationSec)fail('fission-material-version-mismatch');await directory(path.dirname(destination));await own(destination,true);const out=await open(destination,'wx',0o600),hash=createHash('sha256'),buffer=Buffer.alloc(65536);let position=0;
  try{while(true){check(ctx,s);if(lease.signal.aborted)fail('fission-cancelled');const r=await lease.handle.read(buffer,0,buffer.length,position);if(!r.bytesRead)break;hash.update(buffer.subarray(0,r.bytesRead));let offset=0;while(offset<r.bytesRead){const w=await out.write(buffer,offset,r.bytesRead-offset,position+offset);if(!w.bytesWritten)fail('fission-stage-unconfirmed');offset+=w.bytesWritten;}position+=r.bytesRead;}await out.sync();}finally{await out.close();}
  const actual=hash.digest('hex');if(actual!==meta.contentSha256||await fileHash(destination)!==actual)fail('fission-material-version-mismatch');return {filePath:destination,versionId:lease.versionId,contentSha256:actual,resolvedMeta:{versionId:meta.versionId,contentSha256:meta.contentSha256,kind:meta.kind,durationSec:meta.durationSec}};
 }
 async function run(s:State,ctx:VerifiedSession){
  const request=s.request;try{
   const prior=await options.admission.preflightPreparedOutput(ctx,request,0);if(prior.status!=='prepare-required'){s.status='needs-reconciliation';await save(s,'prior-request',{status:prior.status,workerStarted:false});return;}check(ctx,s);
   // The native no-AudioDir branch is offline sine generation, not paid TTS. Its output lacks a registered licensed version; no generated-source execution authority is inferred here.
   if(!request.job.AudioDir){s.status='authorization-pending';s.error='fission-generation-authorization-required';await save(s,'generation-pending',{code:s.error,workerStarted:false});return;}
   const choices=[...request.sourceSelection.video.flatMap(row=>row.versionIds.map(id=>({id,role:'video',group:row.group}))),...(['audio','bgm','intro','outro']as const).flatMap(role=>request.sourceSelection[role].map(id=>({id,role,group:''})))],allIds=[...new Set(choices.map(c=>c.id))];
   const input=path.join(s.dir,'inputs'),workspace=path.join(s.dir,'worker');const effective=structuredClone(request.job),stage:any[]=[];let prepared:any;const jobFile=path.join(s.dir,'effective-job.json'),pathsFile=path.join(s.dir,'paths.json'),args=['--paths',pathsFile,'--workspace',workspace,'--task','dispatch','--attempt','run','--job',jobFile];
   s.status='preparing';await options.materials.use(ctx,allIds,'fission',async leases=>{
    const meta=await options.admission.resolve(ctx,allIds,'fission');await save(s,'prepare-deadline',setDeadline(s,ctx,meta));const map=new Map(leases.map(l=>[l.versionId,l])),permissions=new Map(meta.map((m:any)=>[m.versionId,m]));
    const abort=()=>s.controller.abort('material-lease-aborted');for(const l of leases)l.signal.addEventListener('abort',abort,{once:true});
    try{for(const role of ['video','audio','bgm','intro','outro'])await directory(path.join(input,role));
     for(let i=0;i<choices.length;i++){const choice=choices[i],lease=map.get(choice.id)!;if(!lease||!(choice.role==='video'?['video','still'].includes(lease.kind):choice.role==='intro'||choice.role==='outro'?lease.kind==='video':lease.kind==='sound'))fail('fission-source-kind-mismatch',422);
      const ext=path.extname(lease.path).toLowerCase(),allowed=lease.kind==='video'?['.mp4','.mov','.mkv','.m4v']:lease.kind==='still'?['.png','.jpg','.jpeg','.bmp']:['.wav','.mp3','.m4a'];if(!allowed.includes(ext))fail('fission-native-format-pending',422);
      const dest=path.join(input,choice.role,choice.group,String(i).padStart(4,'0')+ext);stage.push(await copyLease(s,ctx,lease,dest,permissions.get(choice.id)));}
     effective.VideoDir=path.join(input,'video');for(const[key,role]of [['AudioDir','audio'],['BgmDir','bgm'],['IntroDir','intro'],['OutroDir','outro']]as const)if(effective[key])effective[key]=path.join(input,role);delete effective.OutDir;
     await writeFile(jobFile,JSON.stringify(effective),{flag:'wx',mode:0o600});await writeFile(pathsFile,JSON.stringify(runtime.paths),{flag:'wx',mode:0o600});await save(s,'io-binding',{originalJob:request.job,effectiveJob:effective,jobFileSHA256:await fileHash(jobFile),allowedChanges:['VideoDir','AudioDir','BgmDir','IntroDir','OutroDir','OutDir']});
     const stdout=await worker(s,ctx,'prepare',args),reply=JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);const snapshot=path.join(workspace,'dispatch/run/work/prepared.json');if(reply.preparedPath!==snapshot||reply.authorizesBusiness!==false||reply.measuredAssemblyClock!==false)fail('fission-preparation-unconfirmed');prepared=await jsonFile(snapshot);if(prepared.digest!==reply.digest||prepared.measuredAssemblyClock!==false||prepared.authorizesBusiness!==false)fail('fission-preparation-unconfirmed');
     await save(s,'prepared',{snapshot,digest:prepared.digest,snapshotSHA256:await fileHash(snapshot),jobFileSHA256:await fileHash(jobFile),nativeJobSha256:prepared.jobSha256,originalIndices:prepared.outputs.map((o:any)=>o.index),stage});
    }finally{for(const l of leases)l.signal.removeEventListener('abort',abort);if(s.timer)clearTimeout(s.timer);s.timer=undefined;}
   },s.controller.signal);
   check(ctx,s);const associations=stage.map(row=>{const matches=prepared.versions.filter((v:any)=>v.path===row.filePath&&v.sha256===row.contentSha256);if(matches.length!==1||typeof matches[0].identity!=='string')fail('fission-stage-unconfirmed');return {...row,fileIdentity:matches[0].identity};});
   const plans=new Map<number,any>();s.status='admitting';for(const output of prepared.outputs){const row:Output={index:output.index,state:'mapping'};s.outputs.push(row);try{const plan=await mapPreparedFissionOutput(prepared,output.index,{projectId:request.projectId,filmRev:request.filmRev,job:request.job},associations);plans.set(output.index,plan);const claim=await options.admission.claimPreparedOutput(ctx,request,output.index,plan);await save(s,'index-'+output.index+'-claim',claim);if(claim.status==='duplicate'){row.state='duplicate';continue;}if(claim.status!=='reserved'||claim.contentKey!==contentKey(plan)||requestDigest(claim.frozenPlan)!==requestDigest(plan)){row.state='needs-reconciliation';continue;}row.claimId=claim.claimId;row.contentKey=claim.contentKey;row.nonce=randomUUID();await save(s,'index-'+output.index+'-nonce',{claimId:row.claimId,nonce:row.nonce});const started=await options.admission.start(ctx,row.claimId!,row.nonce);if(started.status!=='running'||started.claimId!==row.claimId||started.contentKey!==row.contentKey)fail('fission-start-unconfirmed');row.state='admitted';}catch(e){row.state='pending';row.code=typeof(e as any).code==='string'?(e as any).code:'fission-admission-unconfirmed';await save(s,'index-'+output.index+'-pending',{code:row.code});}}
   const selected=s.outputs.filter(o=>o.state==='admitted');if(!selected.length){s.status=s.outputs.every(o=>o.state==='duplicate')?'duplicate':'authorization-pending';return;}check(ctx,s);
   const selectedIds=[...new Set(selected.flatMap(o=>(plans.get(o.index).materials as any[]).map(m=>m.versionId)))],snapshot=path.join(workspace,'dispatch/run/work/prepared.json'),snapshotSHA=await fileHash(snapshot),jobSHA=await fileHash(jobFile);s.status='executing';
   await options.materials.use(ctx,selectedIds,'fission',async leases=>{const meta=await options.admission.resolve(ctx,selectedIds,'fission');await save(s,'execute-deadline',setDeadline(s,ctx,meta));const abort=()=>s.controller.abort('material-lease-aborted');for(const l of leases)l.signal.addEventListener('abort',abort,{once:true});try{for(const l of leases){const p=meta.find((m:any)=>m.versionId===l.versionId);if(!p||p.kind!==l.kind||p.durationSec!==l.durationSec)fail('fission-material-version-mismatch');}await worker(s,ctx,'execute-prepared',[...args,'--prepared',snapshot,'--digest',prepared.digest,'--outputs',JSON.stringify(selected.map(o=>o.index))]);if(await fileHash(snapshot)!==snapshotSHA||await fileHash(jobFile)!==jobSHA)fail('fission-preparation-changed');const outputRoot=path.join(workspace,'dispatch/run/out',prepared.jobId),report=await jsonFile(path.join(outputRoot,'report.json'));if(report.Succeeded!==selected.length||report.Failed!==0||requestDigest(report.Outputs.map((o:any)=>o.Index))!==requestDigest(selected.map(o=>o.index)))fail('fission-output-unconfirmed');for(const o of report.Outputs){for(const file of [o.Path,o.EditPlanPath]){if(typeof file!=='string'||!inside(outputRoot,file))fail('fission-output-unconfirmed');await own(file);}check(ctx,s);const receipt=await jsonFile(o.EditPlanPath);assertNativeCandidateReceipt(prepared,o.Index,receipt);const mp4=await open(o.Path,'r');try{const header=Buffer.alloc(12);if((await mp4.stat()).size<=12||(await mp4.read(header,0,12,0)).bytesRead!==12||header.toString('ascii',4,8)!=='ftyp')fail('fission-output-unconfirmed');}finally{await mp4.close();}const row=selected.find(r=>r.index===o.Index)!;row.state='rendered-unverified';}await save(s,'rendered-candidates',{report,reportSHA256:await fileHash(path.join(outputRoot,'report.json')),snapshotSHA256:snapshotSHA,deliveryVerified:false});}finally{for(const l of leases)l.signal.removeEventListener('abort',abort);if(s.timer)clearTimeout(s.timer);s.timer=undefined;}},s.controller.signal);
   check(ctx,s);s.status='rendered-unverified';
  }catch(e){s.status='needs-reconciliation';s.error=typeof(e as any).code==='string'?(e as any).code:'fission-operation-unconfirmed';for(const row of s.outputs.filter(o=>o.claimId&&o.nonce)){try{await options.admission.unknown(ctx,row.claimId!);row.state='unknown';}catch{row.state='unconfirmed';}}await save(s,'unconfirmed',{code:s.error,outputs:s.outputs});}
  finally{if(s.timer)clearTimeout(s.timer);}
 }
 async function ownedState(context:unknown,id:string){const ctx=current(context);if(!/^[a-f0-9]{24}$/.test(id))fail('fission-not-found',404);const s=states.get(id);if(s){if(s.subject!==ctx.subjectId)fail('fission-not-found',404);await options.admission.preflightPreparedOutput(ctx,s.request,0);return {ctx,state:s};}const dir=path.join(root,requestDigest([options.environmentId,ctx.subjectId]).slice(0,12),id),marker=path.join(dir,'0000-request.json');try{await own(marker);}catch(e){if((e as any).code==='ENOENT')fail('fission-not-found',404);throw e;}const saved=await jsonFile(marker);if(saved.subject!==ctx.subjectId||saved.environment!==options.environmentId)fail('fission-not-found',404);await options.admission.preflightPreparedOutput(ctx,saved.request,0);return {ctx,state:null};}
 return Object.freeze({
  async submit(context:unknown,raw:unknown){
   if(sealed)fail('fission-stopping');const ctx=current(context),r=request(raw),id=requestDigest([options.environmentId,ctx.subjectId,r.idempotencyKey]).slice(0,24),fingerprint=requestDigest(r),prior=states.get(id);
   if(prior){if(prior.subject!==ctx.subjectId||prior.hash!==fingerprint)fail('idempotency-conflict',409);await options.admission.preflightPreparedOutput(ctx,prior.request,0);current(ctx);return publicState(prior);}
   const dir=path.join(root,requestDigest([options.environmentId,ctx.subjectId]).slice(0,12),id),s:State={id,subject:ctx.subjectId,hash:fingerprint,request:r,dir,status:'preparing',outputs:[],controller:new AbortController(),task:Promise.resolve(),counter:1,authDeadline:ctx.expiresAtMs};
   // Register the actual entered promise before any await: live replay/close cannot miss a booting operation.
   states.set(id,s);
   s.task=(async()=>{
    await directory(dir);
    try{await writeFile(path.join(dir,'0000-request.json'),JSON.stringify({subject:ctx.subjectId,environment:options.environmentId,hash:fingerprint,request:r}),{flag:'wx',mode:0o600});}
    catch(e){if((e as any).code!=='EEXIST')throw e;const saved=await jsonFile(path.join(dir,'0000-request.json'));if(saved.subject!==ctx.subjectId||saved.hash!==fingerprint)fail('idempotency-conflict',409);s.status='needs-reconciliation';return;}
    await run(s,ctx);
   })().catch(e=>{s.status='needs-reconciliation';s.error=typeof(e as any).code==='string'?(e as any).code:'fission-operation-unconfirmed';});
   return publicState(s);
  },
  async status(context:unknown,id:string){const {state}=await ownedState(context,id);return state?publicState(state):{batchId:id,status:'needs-reconciliation',outputs:[],executionReady:false,deliveryVerified:false};},
  async cancel(context:unknown,id:string){const {ctx,state}=await ownedState(context,id);if(!state)return {batchId:id,status:'needs-reconciliation',outputs:[],executionReady:false,deliveryVerified:false};state.controller.abort('owner-cancel');for(const row of state.outputs.filter(o=>o.claimId)){try{await options.admission.cancel(ctx,row.claimId!);}catch{}}await state.task;return publicState(state);},
  async close(){sealed=true;for(const s of states.values())s.controller.abort('service-stop');await Promise.all([...states.values()].map(s=>s.task));},
 });
}
