// @ts-check
/** The original Fission CLI lifecycle, not shared admission or a second task protocol. */
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,open,readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {assertSourceAccess} from '../../src/media-links.mjs';
import {bringIn} from './files.mjs';
import {importFissionEditPlan} from './fission-import.mjs';
import {readProjectFilm} from './film.mjs';

export class FissionError extends Error {
  /** @param {string} code @param {number} status @param {string} message */
  constructor(code,status,message){super(message);this.code=code;this.status=status;}
}
/** @param {string} code @param {number} [status] @param {string} [message] @returns {never} */
function fail(code,status=409,message='The Fission operation could not safely finish.'){throw new FissionError(code,status,message);}
const hash=(/** @type {Buffer|string} */ bytes)=>createHash('sha256').update(bytes).digest('hex');
const inside=(/** @type {string} */ root,/** @type {string} */ file)=>{const rel=path.relative(root,file);return rel && rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
/** @param {string} file */
async function ordinary(file){for(let at=path.resolve(file);;at=path.dirname(at)){const s=await lstat(at);if(s.isSymbolicLink()||(at===path.resolve(file)?!s.isFile()||s.nlink!==1:!s.isDirectory()))fail('source-capability-unavailable');if(at===path.dirname(at))break;}return file;}
/** @param {string} file */
async function sourceHash(file){assertSourceAccess(file,'copy');await ordinary(file);const h=await open(file,'r');try{const before=await h.stat();const bytes=await h.readFile();const after=await lstat(file);assertSourceAccess(file,'copy');if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)fail('source-changed');return hash(bytes);}finally{await h.close();}}
/** Trusted Node startup options only. No renderer JSON can supply any option here.
 * @param {{business?:ReturnType<typeof import('../../../../apps/desktop/src/desktop-auth.mjs').createDesktopAuth>['business'],runtime?:{dotnet:string,cli:string,paths:Record<string,string>},selftest?:{projectPath:string,jobSHA256:string,inputs:{path:string,sha256:string}[],approvedBaseRoot:string}}} [options] */
export function createFission(options={}){
  /** @type {Map<string,{task:Promise<any>,cancel:()=>void}>} */ const active=new Map();let sealed=false;
  /** @type {Set<Promise<any>>} */ const pending=new Set();
  /** @type {Set<AbortController>} */ const businessControllers=new Set();
  /** @type {Promise<void>|null} */ let terminal=null;
  /** @template T @param {Promise<T>} operation */
  function track(operation){const task=operation.finally(()=>pending.delete(task));pending.add(task);return task;}
  /** @param {{id:string,path:string}} project @param {'resolve'|'claim'|'status'|'cancel'} kind @param {any} input @param {AbortSignal} [signal] */
  async function businessCall(project,kind,input,signal){
    if(sealed||signal?.aborted)fail('fission-cancelled');
    if(!options.business)fail('admission-required',503);
    const before=await readProjectFilm(project.path),controller=new AbortController(),abort=()=>controller.abort();businessControllers.add(controller);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted||sealed)abort();
    try{
      if(controller.signal.aborted)fail('fission-cancelled');
      const body=kind==='claim'?{...input,projectId:project.id,filmRev:before.rev}:input;
      /** @param {{status:number,data:any}} reply */
      const validate=async reply=>{
        if(controller.signal.aborted||sealed)fail('fission-cancelled');
        if((await readProjectFilm(project.path)).rev!==before.rev)fail('native-revision-changed');
        if(!reply||!Number.isInteger(reply.status)||reply.status<200||reply.status>599||!reply.data||typeof reply.data!=='object')fail('business-unconfirmed',503);
        const plan=reply.data.frozenPlan;
        if(plan&&(plan.projectId!==project.id||kind==='claim'&&plan.filmRev!==before.rev))fail('business-project-mismatch',403);
        return reply;
      };
      if(kind==='cancel'){
        const status=await validate(await options.business.status(project,input,controller.signal));
        if(status.status>=400)return status;
        if(!status.data.frozenPlan)fail('business-unconfirmed',503);
      }
      return await validate(await options.business[kind](project,body,controller.signal));
    }catch(error){
      if(error instanceof FissionError||['authentication-required','project-access-denied'].includes(/** @type {any} */(error)?.code))throw error;
      fail('business-unconfirmed',503);
    }finally{signal?.removeEventListener('abort',abort);businessControllers.delete(controller);}
  }
  /** @param {{id:string,path:string,name:string}} project @param {any} job @param {AbortSignal} signal @param {{groupId?:string,idempotencyKey?:string}} [request] */
  async function execute(project,job,signal,request){
    const assertRunning=()=>{if(signal.aborted||sealed)fail("fission-cancelled");};
    assertRunning();
    if(options.business){
      if(typeof request?.groupId!=='string'||typeof request.idempotencyKey!=='string'||!request.groupId||!request.idempotencyKey)fail('business-context-required',503);
      // Only the backend can prepare/freeze/admit. No successful claim (nor a
      // startup selftest) is permission to use the not-yet-connected executor.
      return businessCall(project,'claim',{groupId:request.groupId,idempotencyKey:request.idempotencyKey,job},signal);
    }
    const bound=options.selftest, runtime=options.runtime;
    if(!bound||bound.projectPath!==project.path||hash(JSON.stringify(job))!==bound.jobSHA256)fail('admission-required',503,'Fission business admission is not connected yet.');
    if(!runtime||job.Count!==1||job.Threads!==1||job.UseNvenc!==false||job.RandomHFlip!==false||!bound.inputs.length)fail('selftest-configuration',503);
    // Validate every trusted synthetic source before any mkdir/copy/worker launch.
    const inputMap=new Map(bound.inputs.map(row=>[path.resolve(project.path,row.path),row.sha256]));
    for(const [file,sha] of inputMap){if(!inside(project.path,file)||await sourceHash(file)!==sha)fail('source-changed');assertRunning();}
    for(const key of ['FFmpeg','FFprobe','FFmpeg6','TransitionsDir','AssetsRoot','LocalAssetsRoot'])if(typeof runtime.paths[key]!=='string'||!path.isAbsolute(runtime.paths[key]))fail('selftest-configuration',503);
    await ordinary(runtime.dotnet);await ordinary(runtime.cli);assertRunning();
    const attempt='a-'+Date.now()+'-'+randomUUID(), stage=path.join(project.path,'assets','.fission-inputs',attempt), workspace=path.join(project.path,'assets','.fission-work',attempt);
    const staged={...job};
    for(const key of ['VideoDir','AudioDir','BgmDir','IntroDir','OutroDir']){
      if(!job[key])continue;
      if(typeof job[key]!=='string'||path.isAbsolute(job[key]))fail('source-capability-unavailable');
      const dir=path.resolve(project.path,job[key]);if(!inside(project.path,dir))fail('source-capability-unavailable');
      const dest=path.join(stage,key);let count=0;
      for(const [file,sha] of inputMap){if(!inside(dir,file))continue;const rel=path.relative(dir,file);if(rel.split(path.sep).length>2)fail('selftest-configuration');
        const into=path.relative(project.path,path.join(dest,path.dirname(rel))).split(path.sep).join('/');
        assertRunning();const landed=await bringIn(project.path,into,[file],'copy');
        if(await sourceHash(path.join(project.path,landed[0]))!==sha)fail('source-changed');count++;
      }
      if(!count)fail('selftest-configuration');staged[key]=dest;
    }
    assertRunning();await mkdir(workspace,{recursive:true});const pathsFile=path.join(workspace,'paths.json'),jobFile=path.join(workspace,'job.json');
    await writeFile(pathsFile,JSON.stringify(runtime.paths),{flag:'wx'});delete staged.OutDir;
    await writeFile(jobFile,JSON.stringify(staged),{flag:'wx'});
    const args=[runtime.cli,'run','--paths',pathsFile,'--workspace',workspace,'--task','studio','--attempt','run','--job',jobFile];
    assertRunning();const child=spawn(runtime.dotnet,args,{cwd:project.path,env:{...process.env,FISSION_PARENT_STDIN_EOF:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']});
    let bytes=0,interrupted=false;const logs=/** @type {Buffer[]} */([]);let exit=/** @type {{code:number|null,signal:NodeJS.Signals|null}|null} */(null);let childError=null;
    const cancel=()=>{interrupted=true;child.stdin.end();};signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
    for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{bytes+=b.length;if(bytes>20*1024*1024)cancel();else logs.push(b);});
    for(const stream of [child.stdin,child.stdout,child.stderr])stream.on('error',error=>{childError=error;});
    child.once('exit',(code,signal)=>{exit={code,signal};});child.once('error',error=>{childError=error;});
    const deadline=setTimeout(cancel,180000);
    const close=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));clearTimeout(deadline);signal.removeEventListener('abort',cancel);
    await writeFile(path.join(workspace,'worker-lifecycle.json'),JSON.stringify({pid:child.pid,exit,close,interrupted,error:childError?true:false}),{flag:'wx'});
    await writeFile(path.join(workspace,'worker.log'),Buffer.concat(logs),{flag:'wx'});
    if(interrupted||sealed)fail('fission-cancelled');const ended=/** @type {{code:number|null}|null} */(exit);if(childError||!ended||close.code!==0||ended.code!==0)fail('fission-worker-failed');
    const outRoot=path.join(workspace,'studio','run','out');const dirs=await readdir(outRoot);if(dirs.length!==1)fail('fission-output-invalid');
    const reportFile=path.join(outRoot,dirs[0],'report.json');await ordinary(reportFile);const report=JSON.parse(await readFile(reportFile,'utf8'));
    if(report.Succeeded!==1||report.Failed!==0||report.StopReason!=='countReached'||report.Outputs.length!==1)fail('fission-output-invalid');
    const output=report.Outputs[0];for(const file of [output.Path,output.EditPlanPath]){if(typeof file!=='string'||!inside(outRoot,file))fail('fission-output-invalid');await ordinary(file);}
    const mp4=await open(output.Path,'r');try{const header=Buffer.alloc(12);await mp4.read(header,0,12,0);if(header.toString('ascii',4,8)!=='ftyp')fail('fission-output-invalid');}finally{await mp4.close();}
    for(const [file,sha] of inputMap)if(await sourceHash(file)!==sha)fail('source-changed');
    assertRunning();const imported=await importFissionEditPlan(await readFile(output.EditPlanPath),{name:project.name+' - Fission',sourceRoots:[stage],approvedBaseRoot:bound.approvedBaseRoot,internalDraft:true,nativeAudioProfile:'fission-v1'});
    return {report,project:imported.project,blockingCapabilities:imported.blockingCapabilities,previewEquivalent:false,businessAdmitted:false};
  }
  return {
    capabilities:(/** @type {{path:string}|undefined} */ project)=>{const available=!options.business&&!!options.selftest&&!!options.runtime&&project?.path===options.selftest.projectPath;return {available,mode:options.business?'business-preparation-required':available?'isolated-synthetic-selftest':'admission-required',businessAdmitted:false,previewEquivalent:false};},
    /** @param {{id:string,path:string,name:string}} project @param {any} job @param {{groupId?:string,idempotencyKey?:string}} [request] */
    run(project,job,request){if(sealed)return Promise.reject(new FissionError('fission-stopping',409,'Fission is stopping.'));if(active.has(project.id))return Promise.reject(new FissionError('fission-busy',409,'This project already has a Fission run.'));
      const controller=new AbortController();const record={task:/** @type {Promise<any>} */(Promise.resolve()),cancel:()=>controller.abort()};active.set(project.id,record);
      record.task=track(execute(project,job,controller.signal,request).finally(()=>{active.delete(project.id);}));return record.task;},
    /** @param {{id:string,path:string}} project @param {any} body */
    resolve(project,body){return track(businessCall(project,'resolve',body));},
    /** @param {{id:string,path:string}} project @param {string} id */
    status(project,id){return track(businessCall(project,'status',id));},
    /** Cancel is cooperative, and resolves only after the actual original CLI exit+close. Remote cancel returns its actual result, never a fabricated release. @param {string|{id:string,path:string}} project @param {string} [claimId] */
    async cancel(project,claimId){if(typeof project!=='string'&&claimId)return track(businessCall(project,'cancel',claimId));const record=active.get(typeof project==='string'?project:project.id);if(record){record.cancel();await record.task.catch(()=>{});}if(options.business)return {status:503,data:{code:'result-unknown'}};},
    stopAll(){if(terminal)return terminal;sealed=true;for(const record of active.values())record.cancel();for(const controller of businessControllers)controller.abort();terminal=Promise.all([...pending].map(task=>task.catch(()=>{}))).then(()=>{});return terminal;},
  };
}
