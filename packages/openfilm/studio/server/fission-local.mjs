// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-nocheck
/** Local, user-selected Fission jobs. Only trusted Studio code may provide paths. */
import {spawn as spawnProcess} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,createReadStream,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {lstat, mkdir, open, readdir, readFile, writeFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import path from 'node:path';

const roles=['video','audio','bgm','intro','outro'];
const pathFields=new Set(['VideoDir','AudioDir','BgmDir','IntroDir','OutroDir','OutDir']);
const jobFields=new Set(('SceneGroups ImageDurMinSec ImageDurMaxSec Count Threads TargetDurationSec GeneratedAudioCount GeneratedAudioDurationSec AudioUses OutWidth OutHeight OutFps VoiceVolume BgmVolume SplitMode SceneThreshold AvgPieces BySeconds RandomMinSec RandomMaxSec Align Pick AllowVideoReuse RandomHFlip TransitionSec TransitionName SubtitleEnabled SubtitleStyle SubtitlePos SubtitleFontSize CoverAtSec Naming UseNvenc NvencGate').split(' '));
const exts={video:new Set(['.mp4','.mov','.mkv','.m4v','.jpg','.jpeg','.png','.bmp']),audio:new Set(['.mp3','.wav','.m4a','.srt']),bgm:new Set(['.mp3','.wav','.m4a']),intro:new Set(['.mp4','.mov','.mkv','.m4v']),outro:new Set(['.mp4','.mov','.mkv','.m4v'])};
const err=(code,status=503)=>Object.assign(new Error(code),{code,status});
const within=(root,file)=>{const r=path.relative(root,file);return !!r&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const runtimeKeys=['FFmpeg','FFprobe','FFmpeg6','TransitionsDir','AssetsRoot','LocalAssetsRoot','FontsDir'];
// FFmpeg6（gltransition）与 FontsDir（随包字体目录）都是可选键：缺省时单引擎与系统字体仍能工作。
const requiredRuntimeKeys=runtimeKeys.filter(key=>key!=='FFmpeg6'&&key!=='FontsDir');
const hasRuntimeKeys=keys=>{
 if(!Array.isArray(keys)||keys.length<requiredRuntimeKeys.length||keys.length>runtimeKeys.length)return false;
 if(new Set(keys).size!==keys.length)return false;
 return keys.every(key=>runtimeKeys.includes(key))&&requiredRuntimeKeys.every(key=>keys.includes(key));
};
// 旧客户端发过 "Number"/"Sequential" 这类值；原生 C# 只认 AudioFileName/Sequence/RandomTitle。
// 这里做一次显式别名映射，遇到不认识的值仍然拒绝，不做猜测性放行。
const namingAliases=new Map([['number','Sequence'],['sequence','Sequence'],['sequential','Sequence'],['audiofilename','AudioFileName'],['audio','AudioFileName'],['randomtitle','RandomTitle'],['random','RandomTitle']]);
const canonicalNaming=value=>{
 if(value===undefined||value===null)return undefined;
 if(typeof value!=='string')throw err('fission-job-invalid',400);
 const found=namingAliases.get(value.toLowerCase());
 if(!found)throw Object.assign(new Error('命名规则不受支持。'),{code:'fission-job-invalid',status:400});
 return found;
};
function validateUserJob(job){
 if(job.Naming!==undefined&&job.Naming!==null)canonicalNaming(job.Naming);
 if(job.SceneGroups!==undefined&&job.SceneGroups!==null){
  if(!Array.isArray(job.SceneGroups)||job.SceneGroups.some(g=>!object(g)||(g.Enabled!==undefined&&typeof g.Enabled!=='boolean')))throw err('fission-job-invalid',400);
  if(job.SceneGroups.length&&job.SceneGroups.every(g=>g.Enabled===false))throw Object.assign(new Error('请至少启用一个场景组。'),{code:'fission-scene-groups-disabled',status:400});
 }
 if(job.TransitionSec!==undefined&&(typeof job.TransitionSec!=='number'||!Number.isFinite(job.TransitionSec)||job.TransitionSec<0||job.TransitionSec>2))throw Object.assign(new Error('转场时长需在 0 到 2 秒之间。'),{code:'fission-transition-range',status:400});
}

/** Read a local owner-supplied runtime configuration, never a renderer value. */
export async function readLocalFissionConfiguration(file){
 if(typeof file!=='string'||!path.isAbsolute(file))throw err('fission-configuration-invalid');
 const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>32768)throw err('fission-configuration-invalid');
 let value;try{value=JSON.parse(await readFile(file,'utf8'));}catch{throw err('fission-configuration-invalid');}
 if(!object(value)||Object.keys(value).sort().join(',')!=='cli,dotnet,paths'||!object(value.paths)||!hasRuntimeKeys(Object.keys(value.paths)))throw err('fission-configuration-invalid');
 // Native Studio renders by invoking ffmpeg and ffprobe by name. The isolated
 // utility prepends this directory to PATH, so it must resolve the same tools.
 const suffix=process.platform==='win32'?'.exe':'';
 const ff=value.paths.FFmpeg,fp=value.paths.FFprobe;
 const fold=x=>process.platform==='win32'?x.toLowerCase():x;
 if(typeof ff!=='string'||typeof fp!=='string'||fold(path.basename(ff))!=='ffmpeg'+suffix||fold(path.basename(fp))!=='ffprobe'+suffix||fold(path.dirname(ff))!==fold(path.dirname(fp)))throw err('fission-configuration-invalid');
 for(const [key,v] of Object.entries({dotnet:value.dotnet,cli:value.cli,...value.paths})){
  if(typeof v!=='string'||!path.isAbsolute(v))throw err('fission-configuration-invalid');
  /* FontsDir 是可选字体目录：可以写进配置，但目录此刻可能还没随包落下。
     存在时仍必须是普通目录（不跟随链接）；缺失不算配置错误（引擎会回落到系统字体）。 */
  if(key==='FontsDir'){
   let stat;
   try{stat=await lstat(v);}catch(error){if(error&&error.code==='ENOENT')continue;throw error;}
   if(stat.isSymbolicLink()||!stat.isDirectory())throw err('fission-configuration-invalid');
   continue;
  }
  const stat=await lstat(v);const dir=['TransitionsDir','AssetsRoot','LocalAssetsRoot'].includes(key);if(stat.isSymbolicLink()||(dir?!stat.isDirectory():!stat.isFile()||stat.nlink!==1))throw err('fission-configuration-invalid');
 }
 return value;
}

/** A fixed trusted runtime and native picker are supplied by Studio, never by the renderer. */
const NL=String.fromCharCode(10);
export function createLocalFission({workspaceRoot,runtime,pickFolder,assertSession,spawn=spawnProcess,terminate,stopGraceMs=3000,stopDeadlineMs=12000}){
 if(!path.isAbsolute(workspaceRoot)||!runtime||!path.isAbsolute(runtime.dotnet)||!path.isAbsolute(runtime.cli)||!object(runtime.paths)||typeof pickFolder!=='function'||typeof assertSession!=='function')throw err('fission-configuration-invalid');
 if(!Number.isSafeInteger(stopGraceMs)||!Number.isSafeInteger(stopDeadlineMs)||stopGraceMs<0||stopDeadlineMs<=stopGraceMs)throw err('fission-configuration-invalid');
 const normalizedRoot=path.resolve(workspaceRoot),fold=x=>process.platform==='win32'?x.toLowerCase():x;
 if(fold(normalizedRoot)!==fold(workspaceRoot))throw err('fission-workspace-invalid');
 const inspectDir=dir=>{const stat=lstatSync(dir,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||fold(realpathSync.native(dir))!==fold(dir))throw err('fission-workspace-invalid');return stat;};
 const inspectRoot=()=>{try{let at=normalizedRoot,rootStat;for(;;){const stat=inspectDir(at);if(at===normalizedRoot)rootStat=stat;const parent=path.dirname(at);if(parent===at)break;at=parent;}return rootStat;}catch{throw err('fission-workspace-invalid');}};
 const initialRoot=inspectRoot();
 const guardRoot=()=>{const current=inspectRoot();if(current.dev!==initialRoot.dev||current.ino!==initialRoot.ino)throw err('fission-workspace-invalid');};
 const checkIdentity=at=>{const known=namespaceIdentities.get(fold(at));if(!known)return;let stat;try{stat=lstatSync(at,{bigint:true});}catch{throw err('fission-workspace-invalid');}if(stat.dev!==0n&&BigInt(known.volume)!==stat.dev)throw err('fission-workspace-invalid');if(stat.ino!==0n&&BigInt(known.index)!==stat.ino){throw err('fission-workspace-invalid');}};
 const guardWrite=dir=>{guardRoot();const target=path.resolve(dir);if(fold(target)!==fold(normalizedRoot)&&!within(normalizedRoot,target))throw err('fission-workspace-invalid');for(let at=target;fold(at)!==fold(normalizedRoot);at=path.dirname(at)){try{inspectDir(at);}catch(e){if(e?.code==='ENOENT')continue;throw err('fission-workspace-invalid');}checkIdentity(at);}};
 const mkdirOwned=async(dir,options)=>{guardWrite(path.dirname(dir));await mkdir(dir,options);guardWrite(dir);};
 const writeOwned=async(file,data,options)=>{guardWrite(path.dirname(file));await writeFile(file,data,options);guardWrite(path.dirname(file));};
 const forceStop=terminate??(child=>{if(!child.pid)return false;if(process.platform!=='win32')return child.kill('SIGKILL');return new Promise(resolve=>{const tool=path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe');const killer=spawnProcess(tool,['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('error',()=>resolve(false));killer.once('close',code=>resolve(code===0));});});
 const selections=new Map(),jobs=new Map(),requests=new WeakMap(),streams=new Set(),pickers=new Set(),pickerFailures=new Map();let sealed=false;const namespaceIdentities=new Map();
 const check=owner=>{if(sealed)throw err('fission-stopping');if(pickerFailures.has(owner))throw err('source-preservation-failed');try{if(assertSession(owner)===false)throw 0;}catch{throw err('authentication-required',403);}};
 const same=(s,owner)=>{check(owner);if(s.owner!==owner)throw err('fission-not-found',404);};
 const ownerKey=owner=>{if(typeof owner?.environmentId!=='string'||!owner.environmentId||typeof owner?.subjectId!=='string'||!owner.subjectId)throw err('authentication-required',403);return createHash('sha256').update(JSON.stringify([owner.environmentId,owner.subjectId])).digest('hex');};
 const requestJobId=(key,requestId)=>{const h=createHash('sha256').update(key+'\0'+requestId).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);};
 const unknown=(owner,id)=>({id,owner,root:path.join(workspaceRoot,id),inputs:path.join(workspaceRoot,id,'inputs'),worker:path.join(workspaceRoot,id,'worker'),recordRoot:path.join(workspaceRoot,id,'records'),controller:new AbortController(),child:null,outputs:[],status:'needs-reconciliation',error:'fission-recovery-required',logs:['上次任务状态未确认，请核对后再操作'],task:Promise.resolve()});
 function claim(owner,requestId,fingerprint){
  check(owner);const key=ownerKey(owner),id=requestJobId(key,requestId),base=path.join(workspaceRoot,'.requests');
  try{guardWrite(workspaceRoot);mkdirSync(base,{recursive:true});guardWrite(base);}catch(e){if(e?.code==='fission-workspace-invalid')throw e;throw err('fission-recovery-unavailable');}
  const dir=path.join(base,key+'-'+requestId),file=path.join(dir,'claim.json');let created=false;
  try{guardWrite(base);mkdirSync(dir);guardWrite(dir);created=true;}catch(e){if(e?.code==='fission-workspace-invalid')throw e;if(e?.code!=='EEXIST')throw err('fission-recovery-unavailable');}
  if(created){let fd;try{guardWrite(dir);fd=openSync(file,'wx',0o600);guardWrite(dir);writeFileSync(fd,JSON.stringify({version:1,ownerKey:key,requestId,jobId:id,fingerprint}));fsyncSync(fd);closeSync(fd);return {created:true,id};}catch(e){if(fd!==undefined)try{closeSync(fd);}catch{}if(e?.code==='fission-workspace-invalid')throw e;throw err('fission-recovery-required');}}
  try{const ds=lstatSync(dir),st=lstatSync(file);if(!ds.isDirectory()||ds.isSymbolicLink()||!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>32768)throw 0;const prior=JSON.parse(readFileSync(file,'utf8'));if(prior.version!==1||prior.ownerKey!==key||prior.requestId!==requestId||prior.jobId!==id||typeof prior.fingerprint!=='string')throw 0;if(prior.fingerprint!==fingerprint)throw err('fission-request-conflict',409);return {created:false,id};}catch(e){if(e?.code==='fission-request-conflict')throw e;return {created:false,id};}
 }
 function recover(owner){
  check(owner);guardRoot();const key=ownerKey(owner);let entries;try{entries=readdirSync(workspaceRoot,{withFileTypes:true});}catch(e){if(e?.code==='ENOENT')return [];throw err('fission-recovery-unavailable');}
  const found=[];for(const entry of entries){if(!entry.isDirectory()||!/^[a-f0-9-]{36}$/.test(entry.name))continue;const root=path.join(workspaceRoot,entry.name);let intent;
   try{const file=path.join(root,'intent.json'),st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>32768)continue;intent=JSON.parse(readFileSync(file,'utf8'));}catch{continue;}
   if(![1,2].includes(intent.version)||intent.jobId!==entry.name||intent.ownerKey!==key||typeof intent.requestId!=='string'||typeof intent.fingerprint!=='string')continue;
   let j=jobs.get(intent.jobId);if(j&&(j.owner!==owner||(j.status==='needs-reconciliation'&&!j.preservationUnknown)))j=null;
   if(!j){j=unknown(owner,intent.jobId);
    try{const resultFile=path.join(root,'result.json'),st=lstatSync(resultFile);if(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<=1048576){const result=JSON.parse(readFileSync(resultFile,'utf8')),count=intent.requestedCount,seen=new Set();if(intent.version===2&&Number.isSafeInteger(count)&&count>=0&&count<=10000&&result.version===3&&result.requestedCount===count&&result.status==='completed'&&['countReached','audioExhausted'].includes(result.stopReason)&&Array.isArray(result.outputs)&&result.actualCount===result.outputs.length&&result.actualCount>0&&(count===0||result.actualCount<=count)&&result.outputs.every(o=>Number.isSafeInteger(o.index)&&o.index>=0&&(count===0||o.index<count)&&!seen.has(o.index)&&seen.add(o.index)&&typeof o.path==='string'&&typeof o.planPath==='string'&&within(j.worker,o.path)&&within(j.worker,o.planPath)&&lstatSync(o.path).isFile()&&lstatSync(o.planPath).isFile())){j.outputs=result.outputs;j.status='completed';j.error=null;j.logs=[`已恢复已完成的本地任务，实际 ${result.actualCount} 条`];}}}catch{}
    jobs.set(j.id,j);
   }
   let own=requests.get(owner);if(!own){own=new Map();requests.set(owner,own);}const previous=own.get(intent.requestId);if(!previous||(previous.job.status==='needs-reconciliation'&&!previous.job.preservationUnknown))own.set(intent.requestId,{fingerprint:intent.fingerprint,job:j});found.push(j);
  }
  try{const base=path.join(workspaceRoot,'.requests');guardWrite(base);for(const entry of readdirSync(base,{withFileTypes:true})){
    const prefix=key+'-';if(!entry.isDirectory()||!entry.name.startsWith(prefix))continue;const requestId=entry.name.slice(prefix.length);if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(requestId))continue;
    const id=requestJobId(key,requestId);let j=jobs.get(id);if(!j||j.owner!==owner){j=unknown(owner,id);jobs.set(id,j);}if(!found.includes(j))found.push(j);
    try{const file=path.join(base,entry.name,'claim.json'),st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>32768)continue;const record=JSON.parse(readFileSync(file,'utf8'));if(record.version!==1||record.ownerKey!==key||record.requestId!==requestId||record.jobId!==id||typeof record.fingerprint!=='string')continue;let own=requests.get(owner);if(!own){own=new Map();requests.set(owner,own);}if(!own.has(requestId))own.set(requestId,{fingerprint:record.fingerprint,job:j});}catch{}
  }}catch(e){if(e?.code==='fission-workspace-invalid')throw e;if(e?.code!=='ENOENT')throw err('fission-recovery-unavailable');}return found;
 }
 async function ordinary(file,dir){let at=path.resolve(file),first=true;for(;;){const s=await lstat(at);if(s.isSymbolicLink()||(first?(dir?!s.isDirectory():!s.isFile()||s.nlink!==1):!s.isDirectory()))throw err('fission-source-invalid',400);first=false;const up=path.dirname(at);if(up===at)break;at=up;}}
 async function contents(dir,role){
  await ordinary(dir,true);const files=[],groups=[];
  const scan=async(base,relative,depth)=>{for(const d of await readdir(base,{withFileTypes:true})){
   const abs=path.join(base,d.name),rel=path.join(relative,d.name);if(d.isSymbolicLink())throw err('fission-source-invalid',400);
   if(d.isDirectory()){if(role==='video'&&depth===0){await ordinary(abs,true);const before=files.length;await scan(abs,rel,1);groups.push({name:d.name,count:files.length-before});}continue;}
   if(!d.isFile()||!exts[role].has(path.extname(d.name).toLowerCase()))continue;
   await ordinary(abs,false);files.push({abs,rel});
  }};
  await scan(dir,'',0);return {files,groups};
 }
 async function copyFile(source,target,owner,signal){
  check(owner);if(signal.aborted)throw err('fission-cancelled',409);await ordinary(source,false);
  const src=await open(source,'r');let dest;
  try{const before=await src.stat();await mkdirOwned(path.dirname(target),{recursive:true});guardWrite(path.dirname(target));dest=await open(target,'wx',0o600);
   const buf=Buffer.alloc(1024*1024);let pos=0;for(;;){check(owner);if(signal.aborted)throw err('fission-cancelled',409);const {bytesRead}=await src.read(buf,0,buf.length,pos);check(owner);if(!bytesRead)break;let offset=0;while(offset<bytesRead){guardWrite(path.dirname(target));const w=await dest.write(buf,offset,bytesRead-offset,pos+offset);if(!w.bytesWritten)throw err('fission-copy-failed');offset+=w.bytesWritten;}pos+=bytesRead;}
   const after=await src.stat(),at=await lstat(source);if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||after.dev!==at.dev||after.ino!==at.ino||after.size!==at.size||pos!==before.size)throw err('fission-source-changed',409);
  }finally{await dest?.close();await src.close();}
 }
 async function subtitleMetadata(owner,selection,files,signal){
  const audioFiles=files.filter(f=>['.mp3','.wav','.m4a'].includes(path.extname(f.rel).toLowerCase()));
  if(!audioFiles.length)throw err('fission-subtitle-text-required',400);
  let source=null;for(const candidate of [path.join(selection.path,'meta.json'),path.join(path.dirname(selection.path),'meta.json')]){try{await lstat(candidate);source=candidate;break;}catch(e){if(e?.code!=='ENOENT')throw err('fission-subtitle-text-required',400);}}
  if(!source)throw err('fission-subtitle-text-required',400);
  await ordinary(source,false);check(owner);if(signal.aborted)throw err('fission-cancelled',409);
  let handle;try{
   handle=await open(source,'r');const before=await handle.stat();if(before.size>2*1024*1024)throw 0;
   const data=JSON.parse(await handle.readFile('utf8'));check(owner);if(signal.aborted)throw err('fission-cancelled',409);
   const after=await handle.stat(),at=await lstat(source);if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||after.dev!==at.dev||after.ino!==at.ino||after.size!==at.size||!object(data)||!Array.isArray(data.items))throw 0;
   const items=audioFiles.map(file=>{const name=path.basename(file.rel),matches=data.items.filter(item=>object(item)&&item.file===name);if(matches.length!==1||typeof matches[0].text!=='string'||!matches[0].text.trim())throw 0;return {file:name,text:matches[0].text};});
   return JSON.stringify({items});
  }catch(e){if(e?.code==='authentication-required'||e?.code==='fission-cancelled')throw e;throw err('fission-subtitle-text-required',400);}finally{await handle?.close();}
 }
 const snapshot=j=>({jobId:j.id,status:j.status,logs:[...j.logs],outputs:j.status==='completed'?j.outputs.map(x=>({index:x.index,state:'completed',title:x.title,durationSec:x.durationSec})):[],...(j.error?{error:j.error}:{})});
  const namespaceHeld=(child,intent,signal,job)=>new Promise((resolve,reject)=>{
   const prefix='[Fission:NAMESPACE-HELD] ';let buffer='';
   const settle=(fn,value)=>{child.stderr.off('data',onData);child.off('exit',onExit);child.off('error',onError);signal.removeEventListener('abort',onAbort);fn(value);};
   const onData=chunk=>{buffer+=chunk.toString('utf8');if(buffer.length>65536)return settle(reject,err('fission-workspace-invalid'));let at;
    while((at=buffer.indexOf(NL))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line.startsWith(prefix))continue;let receipt;
     try{receipt=JSON.parse(line.slice(prefix.length));}catch{return settle(reject,err('fission-workspace-invalid'));}
     if(receipt?.version!==1||String(receipt?.jobId??'')!==job.id)return settle(reject,err('fission-workspace-invalid'));
     const entries=Array.isArray(receipt?.entries)?receipt.entries:null;if(!entries)return settle(reject,err('fission-workspace-invalid'));
     const byPath=new Map(entries.map(x=>[fold(String(x?.path??'')),x]));
     for(const dir of [job.root,job.inputs,job.worker,job.recordRoot]){const entry=byPath.get(fold(path.resolve(dir)));if(!entry||typeof entry.volume!=='string'||typeof entry.index!=='string')return settle(reject,err('fission-workspace-invalid'));
      const lock=path.join(dir,'.fission-namespace.lock');if(!existsSync(lock))return settle(reject,err('fission-workspace-invalid'));const stat=lstatSync(lock,{bigint:true});
      if(stat.dev!==0n&&BigInt(entry.volume)!==stat.dev)return settle(reject,err('fission-workspace-invalid'));if(stat.ino!==0n&&BigInt(entry.index)!==stat.ino)return settle(reject,err('fission-workspace-invalid'));}
     for(const [key,value] of byPath)namespaceIdentities.set(key,{volume:value.dirVolume??value.volume,index:value.dirIndex??value.index});     return settle(resolve,receipt);}};
   const onExit=()=>settle(reject,err('fission-preservation-failed'));
   const onError=()=>settle(reject,err('fission-preservation-failed'));
   const onAbort=()=>settle(reject,err('fission-cancelled',409));
   child.stderr.on('data',onData);child.once('exit',onExit);child.once('error',onError);signal.addEventListener('abort',onAbort,{once:true});
   const ackTimer=setTimeout(()=>settle(reject,err('fission-preservation-failed')),60000);if(ackTimer.unref)ackTimer.unref();
   try{child.stdin.write(intent+NL);}catch{settle(reject,err('fission-preservation-failed'));}
  });
  const jobFinished=(child,signal,job)=>new Promise((resolve,reject)=>{
   const prefix='[Fission:JOB-FINISHED] ';let buffer='';
   const settle=(fn,value)=>{child.stderr.off('data',onData);child.off('exit',onExit);signal.removeEventListener('abort',onAbort);fn(value);};
   const skip=new Set(['NAMESPACE-HELD','WORKSPACE-HELD','STOPPED','JOB-FINISHED']);
   const onData=chunk=>{buffer+=chunk.toString('utf8');if(buffer.length>262144)return settle(reject,err('fission-preservation-failed'));let at;
    while((at=buffer.indexOf(NL))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
     if(line.startsWith('[Fission:NVENC-FALLBACK] ')){job.logs.push('显卡编码不可用，已改用 CPU 编码：'+line.slice('[Fission:NVENC-FALLBACK] '.length).trim());continue;}
     if(line.startsWith('[Fission:OUTPUTS] ')){try{job.manifest=JSON.parse(line.slice('[Fission:OUTPUTS] '.length));}catch{return settle(reject,err('fission-output-invalid'));}continue;}
     if(line.startsWith(prefix)){const code=Number(line.slice(prefix.length).trim());if(!Number.isSafeInteger(code))return settle(reject,err('fission-preservation-failed'));return settle(resolve,{code});}
     const failure=/^\[Fission:([A-Z0-9_]+)\]/.exec(line);if(failure&&!skip.has(failure[1]))return settle(resolve,{code:null,failure:failure[1]});}};
   const onExit=()=>settle(reject,err('fission-worker-failed'));
   const onAbort=()=>settle(reject,err('fission-cancelled',409));
   if(child.exitCode!==null||child.signalCode!==null)return settle(reject,err('fission-worker-failed'));
   child.stderr.on('data',onData);child.once('exit',onExit);signal.addEventListener('abort',onAbort,{once:true});
  });
  const namespaceReleased=(child,closed)=>new Promise(resolve=>{const timer=setTimeout(()=>resolve({released:false,code:null}),stopDeadlineMs);closed.then(result=>{clearTimeout(timer);resolve({released:true,code:result?.code??null});},()=>{clearTimeout(timer);resolve({released:false,code:null});});try{child.stdin.write('DONE'+NL);}catch{}});
  const hashFile=file=>new Promise((resolve,reject)=>{const hash=createHash('sha256');const stream=createReadStream(file);stream.on('data',chunk=>hash.update(chunk));stream.on('error',reject);stream.on('end',()=>resolve(hash.digest('hex')));});
  const verifyManifest=async(job,outputs)=>{
   const manifest=job.manifest;
   if(!Array.isArray(manifest)||manifest.length!==outputs.length)throw err('fission-output-invalid');
   for(const item of manifest){
    if(!Number.isSafeInteger(item?.index)||typeof item.path!=='string'||typeof item.volume!=='string'||typeof item.fileIndex!=='string'||typeof item.sha256!=='string'||!/^[0-9a-f]{64}$/.test(item.sha256))throw err('fission-output-invalid');
    const output=outputs.find(x=>x.index===item.index);
    if(!output||fold(output.path)!==fold(item.path))throw err('fission-output-invalid');
    const stat=lstatSync(item.path,{bigint:true});
    if(stat.dev!==0n&&BigInt(item.volume)!==stat.dev)throw err('fission-output-invalid');
    if(stat.ino!==0n&&BigInt(item.fileIndex)!==stat.ino)throw err('fission-output-invalid');
    if(await hashFile(item.path)!==item.sha256)throw err('fission-output-invalid');
   }
  };

  const releaseQuietly=child=>{if(!child||child.exitCode!==null||child.signalCode!==null)return;try{child.stdin.write('DONE'+NL);}catch{}};
  async function run(j,options){
   let child=null,abortHook=null,graceHandle=null,deadlineHandle=null;
   try{
    check(j.owner);
    const selected={};for(const role of roles){const id=options.selections[role];if(id===null||id===undefined)continue;const s=selections.get(id);if(!s||s.owner!==j.owner||s.role!==role)throw err('fission-selection-invalid',400);selected[role]=s;}
    if(!selected.video)throw err('fission-video-required',400);
    if(options.job.SubtitleEnabled===true&&!selected.audio)throw err('fission-subtitle-text-required',400);
    j.manifest=null;
    const intent=JSON.stringify({version:2,roles:Object.keys(selected),jobId:j.id,ownerKey:ownerKey(j.owner),requestId:options.requestId,fingerprint:j.fingerprint,requestedCount:j.requestedCount});
    const pathsFile=path.join(j.root,'paths.json'),jobFile=path.join(j.root,'job.json');
    // The shipped configuration names a host as `dotnet` and leaves `cli` as the published Fission.Cli.dll, and this
    // is the shape a .NET program is started in: spawn(dotnet, [cli, 'run', …]). Starting the apphost itself —
    // spawn(<Fission.Cli.exe>, args.slice(1)) — is possible (Program.cs reads args[0] as the mode, and the host
    // already forwards `run` first), but it needs the configuration's `cli` to name the .exe rather than the dll,
    // which is the packing step's decision (apps/desktop/scripts/fission-publish.mjs); until that changes, keep it.
    const args=[runtime.cli,'run','--paths',pathsFile,'--workspace',j.worker,'--task','local','--attempt','run','--job',jobFile];
    const prepared={};for(const role of roles){const s=selected[role];if(!s)continue;const data=await contents(s.path,role);if(!data.files.length)throw err('fission-folder-empty',400);prepared[role]={data,meta:role==='audio'&&options.job.SubtitleEnabled===true?await subtitleMetadata(j.owner,s,data.files,j.controller.signal):null};}
    check(j.owner);
    child=spawn(runtime.dotnet,args,{cwd:normalizedRoot,windowsHide:true,env:{...process.env,FISSION_NAMESPACE_ROOT:normalizedRoot,FISSION_NAMESPACE_JOB:j.id,FISSION_NAMESPACE_TAKEOVER:j.takeover?'1':'0'},stdio:['pipe','pipe','pipe']});
    let size=0,failed=false,graceTimer=null,deadlineTimer=null,forceResult=null,resolveTimeout;const timeout=new Promise(resolve=>{resolveTimeout=resolve;});
    const abort=()=>{if(graceTimer!==null)return;try{child.stdin?.end();}catch{}graceTimer=setTimeout(()=>{try{forceResult=Promise.resolve(forceStop(child)).catch(()=>false);}catch{forceResult=Promise.resolve(false);}},stopGraceMs);graceHandle=graceTimer;deadlineTimer=setTimeout(()=>resolveTimeout(null),stopDeadlineMs);deadlineHandle=deadlineTimer;};
    abortHook=abort;j.controller.signal.addEventListener('abort',abort,{once:true});if(j.controller.signal.aborted)abort();
    const logs=[];for(const stream of [child.stdout,child.stderr]){stream?.on('data',chunk=>{size+=chunk.length;if(size<=10*1024*1024)logs.push(chunk);else{failed=true;abort();}});stream?.on('error',()=>{failed=true;});}child.stdin?.on('error',()=>{failed=true;});child.once('error',()=>{failed=true;});
    const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
    await namespaceHeld(child,intent,j.controller.signal,j);
    const native={...options.job};const canonicalName=canonicalNaming(native.Naming);if(canonicalName!==undefined)native.Naming=canonicalName;for(const role of roles){const s=selected[role],preparedRole=prepared[role];if(!s||!preparedRole)continue;const dst=path.join(j.inputs,role);guardWrite(dst);if(preparedRole.meta!==null)await writeOwned(path.join(j.inputs,'meta.json'),preparedRole.meta,{flag:'wx',mode:0o600});for(const f of preparedRole.data.files)await copyFile(f.abs,path.join(dst,f.rel),j.owner,j.controller.signal);native[{video:'VideoDir',audio:'AudioDir',bgm:'BgmDir',intro:'IntroDir',outro:'OutroDir'}[role]]=dst;}
    check(j.owner);if(j.controller.signal.aborted)throw err('fission-cancelled',409);
    await writeOwned(pathsFile,JSON.stringify(runtime.paths),{flag:'wx'});await writeOwned(jobFile,JSON.stringify(native),{flag:'wx'});
    guardWrite(j.worker);j.status='running';j.logs.push('本地素材已准备，Fission 正在执行');child.stdin.write('START'+NL);
    const abortedStop=new Promise(resolve=>{if(j.controller.signal.aborted)resolve(true);else j.controller.signal.addEventListener('abort',()=>resolve(true),{once:true});});
    const settled=await Promise.race([jobFinished(child,j.controller.signal,j).then(result=>result,error=>({error})),abortedStop.then(()=>({aborted:true}))]);
    j.controller.signal.removeEventListener('abort',abort);
    if(settled.aborted){const ended=await Promise.race([closed,timeout]);if(graceTimer!==null)clearTimeout(graceTimer);const stopped=ended&&forceResult?await Promise.race([forceResult,timeout]):true;if(deadlineTimer!==null)clearTimeout(deadlineTimer);if(!ended)j.preservationUnknown=true;throw err(j.preservationUnknown?'fission-preservation-failed':'fission-cancelled',j.preservationUnknown?undefined:409);}
    if(deadlineTimer!==null)clearTimeout(deadlineTimer);
    // 失败路径也要留下 worker.log：诊断不能被“先抛错”吞掉
    await writeOwned(path.join(j.root,'worker.log'),Buffer.concat(logs),{flag:'wx'});if(j.controller.signal.aborted)throw err('fission-cancelled',409);check(j.owner);
    if(settled.error)throw settled.error;if(settled.failure)throw err('fission-worker-failed');const code=settled.code;
    if(failed||code!==0)throw err('fission-worker-failed');
    const out=path.join(j.worker,'local','run','out'),dirs=(await readdir(out,{withFileTypes:true})).filter(d=>d.isDirectory());if(dirs.length!==1)throw err('fission-output-invalid');
    const report=JSON.parse(await readFile(path.join(out,dirs[0].name,'report.json'),'utf8'));if(!Array.isArray(report.Outputs)||!Array.isArray(report.Failures)||report.Failures.length!==0||report.Failed!==0||!['countReached','audioExhausted'].includes(report.StopReason)||report.Succeeded!==report.Outputs.length||report.Succeeded<1)throw err('fission-output-invalid');
   const indices=new Set();for(const item of report.Outputs){if(!Number.isSafeInteger(item.Index)||item.Index<0||indices.has(item.Index)||typeof item.Path!=='string'||typeof item.EditPlanPath!=='string'||!within(out,item.Path)||!within(out,item.EditPlanPath))throw err('fission-output-invalid');indices.add(item.Index);await ordinary(item.Path,false);await ordinary(item.EditPlanPath,false);const h=await open(item.Path,'r');try{const b=Buffer.alloc(12);if((await h.read(b,0,12,0)).bytesRead!==12||b.toString('ascii',4,8)!=='ftyp')throw err('fission-output-invalid');}finally{await h.close();}if(native.SubtitleEnabled===true){const stat=await lstat(item.EditPlanPath);if(stat.size>4*1024*1024)throw err('fission-subtitle-not-applied');const plan=JSON.parse(await readFile(item.EditPlanPath,'utf8')),subtitle=plan?.subtitles;if(!object(subtitle)||subtitle.requested!==true||subtitle.outcome!=='applied'||!Array.isArray(subtitle.cues)||!subtitle.cues.length)throw err('fission-subtitle-not-applied');}j.outputs.push({index:item.Index,title:String(item.Title??'').slice(0,160),durationSec:item.DurationSec,path:item.Path,planPath:item.EditPlanPath});}
    await verifyManifest(j,j.outputs);
    if(j.requestedCount>0&&(report.Succeeded>j.requestedCount||[...indices].some(index=>index>=j.requestedCount)))throw err('fission-output-incomplete');
   check(j.owner);await writeOwned(path.join(j.root,'result.json'),JSON.stringify({version:3,status:'completed',requestedCount:j.requestedCount,actualCount:report.Succeeded,stopReason:report.StopReason,outputs:j.outputs}),{flag:'wx',mode:0o600});
    const released=await namespaceReleased(child,closed);
    if(!released.released)j.logs.push('命名空间释放未确认，请核对后继续');
    if(released.code!==null&&released.code!==code)throw err('fission-worker-failed');
check(j.owner);j.status='completed';j.logs.push(`Fission 批量任务已完成，实际 ${report.Succeeded} 条`);
   }catch(e){if(abortHook)try{j.controller.signal.removeEventListener('abort',abortHook);}catch{}if(graceHandle!==null)clearTimeout(graceHandle);if(deadlineHandle!==null)clearTimeout(deadlineHandle);if(child&&!j.controller.signal.aborted)releaseQuietly(child);try{child?.stdin?.end();}catch{}j.status=j.preservationUnknown?'needs-reconciliation':j.controller.signal.aborted?'cancelled':'failed';j.error=typeof e?.code==='string'?e.code:'fission-failed';j.logs.push(j.preservationUnknown?'任务退出未确认，请核对后再操作':j.status==='cancelled'?'任务已取消':j.error==='fission-subtitle-text-required'?'已开启字幕，但配音文件缺少匹配文案':j.error==='fission-subtitle-not-applied'?'字幕未能生成，请检查素材后重试':'任务未完成，请检查配置和素材');}
  }
 return Object.freeze({
  select(owner,role){check(owner);if(!roles.includes(role))throw err('fission-role-invalid',400);const controller=new AbortController(),entry={owner,controller,promise:null};const task=(async()=>{const picked=await pickFolder(role,{signal:controller.signal});if(controller.signal.aborted)throw err('fission-cancelled',409);check(owner);if(picked===null||picked===undefined)return null;if(typeof picked!=='string'||!path.isAbsolute(picked))throw err('fission-source-invalid',400);const dir=path.resolve(picked);if(within(workspaceRoot,dir)||within(dir,workspaceRoot)||dir===workspaceRoot)throw err('fission-source-invalid',400);const data=await contents(dir,role);if(controller.signal.aborted)throw err('fission-cancelled',409);check(owner);const id=randomUUID();selections.set(id,{owner,role,path:dir});return {selectionId:id,role,name:path.basename(dir),groups:data.groups};})();entry.promise=task.catch(e=>{if(e?.code==='source-preservation-failed'){pickerFailures.set(owner,e);throw e;}if(controller.signal.aborted)throw err('fission-cancelled',409);throw e;}).finally(()=>pickers.delete(entry));pickers.add(entry);return entry.promise;},
  start(owner,input){check(owner);if(!object(owner)||!object(input)||typeof input.requestId!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.requestId)||!object(input.selections)||!object(input.job)||Object.keys(input).some(x=>!['requestId','selections','job'].includes(x))||Object.keys(input.selections).some(x=>!roles.includes(x))||Object.keys(input.job).some(x=>pathFields.has(x)||!jobFields.has(x)))throw err('fission-job-invalid',400);validateUserJob(input.job);const requestedCount=input.job.Count??3;if(!Number.isSafeInteger(requestedCount)||requestedCount<0||requestedCount>10000)throw err('fission-job-invalid',400);ownerKey(owner);recover(owner);const safe=JSON.parse(JSON.stringify(input));safe.requestId=safe.requestId.toLowerCase();let own=requests.get(owner);if(!own){own=new Map();requests.set(owner,own);}const prior=own.get(safe.requestId),fingerprint=JSON.stringify({selections:safe.selections,job:safe.job});if(fingerprint.length>16000)throw err('fission-job-invalid',400);if(prior){if(prior.fingerprint!==fingerprint)throw err('fission-request-conflict',409);
 // 接管重跑暂不接线：CLI 侧能力在，但产品级重试需要“清陈旧 attempt 目录 + 新 controller + 非 wx 写入”，未设计完成前不启用（见回执 R3-01/R3-02）。
 return snapshot(prior.job);}const reserved=claim(owner,safe.requestId,fingerprint);if(!reserved.created){recover(owner);const existing=requests.get(owner)?.get(safe.requestId);if(existing){if(existing.fingerprint!==fingerprint)throw err('fission-request-conflict',409);return snapshot(existing.job);}return snapshot(unknown(owner,reserved.id));}const id=reserved.id,root=path.join(workspaceRoot,id);const j={id,owner,root,fingerprint,requestedCount,inputs:path.join(root,'inputs'),worker:path.join(root,'worker'),recordRoot:path.join(root,'records'),controller:new AbortController(),child:null,outputs:[],status:'preparing',error:null,logs:['正在准备本地素材副本']};jobs.set(id,j);own.set(safe.requestId,{fingerprint,job:j});j.task=run(j,safe);return snapshot(j);},
  find(owner,requestId){check(owner);if(typeof requestId!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestId))throw err('fission-not-found',404);requestId=requestId.toLowerCase();recover(owner);const entry=object(owner)&&requests.get(owner)?.get(requestId);if(entry){same(entry.job,owner);return snapshot(entry.job);}const key=ownerKey(owner),id=requestJobId(key,requestId),dir=path.join(workspaceRoot,'.requests',key+'-'+requestId);guardWrite(path.dirname(dir));try{const stat=lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw 0;}catch{throw err('fission-not-found',404);}return snapshot(unknown(owner,id));},
  list(owner){check(owner);recover(owner);return [...jobs.values()].filter(j=>j.owner===owner).map(snapshot);},
  status(owner,id){check(owner);recover(owner);const j=jobs.get(id);if(!j)throw err('fission-not-found',404);same(j,owner);return snapshot(j);},
  async cancel(owner,id){const j=jobs.get(id);if(!j)throw err('fission-not-found',404);same(j,owner);j.controller.abort();await j.task;if(j.preservationUnknown)throw err('fission-preservation-failed');check(owner);return snapshot(j);},
  getDraftSource(owner,{jobId,index}){const j=jobs.get(jobId);if(!j)throw err('fission-not-found',404);same(j,owner);const o=j.outputs.find(x=>x.index===index);if(j.status!=='completed'||!o)throw err('fission-not-found',404);return {planPath:o.planPath,sourceRoots:[j.inputs,j.worker],recordRoot:j.recordRoot};},
  async openOutput(owner,{jobId,index,start=0,end}){const j=jobs.get(jobId);if(!j)throw err('fission-not-found',404);same(j,owner);const o=j.outputs.find(x=>x.index===index);if(j.status!=='completed'||!o)throw err('fission-not-found',404);await ordinary(o.path,false);const fd=await open(o.path,'r');try{const stat=await fd.stat(),size=stat.size,last=end??size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(last)||start<0||last<start||last>=size)throw err('fission-range-invalid',416);check(owner);let finish;const closed=new Promise(resolve=>{finish=resolve;});const stream=Readable.from((async function*(){let pos=start;while(pos<=last){check(owner);const b=Buffer.alloc(Math.min(65536,last-pos+1)),r=await fd.read(b,0,b.length,pos);check(owner);if(!r.bytesRead)throw err('fission-output-invalid');pos+=r.bytesRead;yield b.subarray(0,r.bytesRead);}})());const record={owner,stream,closed};streams.add(record);stream.once('close',()=>{void fd.close().finally(()=>{streams.delete(record);finish();});});return {size,start,end:last,stream};}catch(e){await fd.close();throw e;}},
  async retire(owner){for(const [id,s] of selections)if(s.owner===owner)selections.delete(id);const pending=[...pickers].filter(p=>p.owner===owner);for(const p of pending)p.controller.abort();const tasks=[...jobs.values()].filter(j=>j.owner===owner);for(const j of tasks)j.controller.abort();const closing=[...streams].filter(s=>s.owner===owner);for(const s of closing)s.stream.destroy();await Promise.allSettled([...tasks.map(j=>j.task),...pending.map(p=>p.promise)]);await Promise.all(closing.map(s=>s.closed));if(pickerFailures.has(owner))throw err('source-preservation-failed');if(tasks.some(j=>j.preservationUnknown))throw err('fission-preservation-failed');},
  async close(){sealed=true;selections.clear();const pending=[...pickers];for(const p of pending)p.controller.abort();const tasks=[...jobs.values()];for(const j of tasks)j.controller.abort();const closing=[...streams];for(const s of closing)s.stream.destroy();await Promise.allSettled([...tasks.map(j=>j.task),...pending.map(p=>p.promise)]);await Promise.all(closing.map(s=>s.closed));if(pickerFailures.size)throw err('source-preservation-failed');if(tasks.some(j=>j.preservationUnknown))throw err('fission-preservation-failed');},
 });
}
