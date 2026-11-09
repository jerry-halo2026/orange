/** First-party authentication in the existing Studio utility. Never expose this object to a renderer. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createAuthService } from './auth-service.mjs';
// Resolve the app's existing bundled OpenFilm, not source-checkout-relative paths or a global package.
const nativeServer=pathToFileURL(createRequire(import.meta.url).resolve('openfilm/studio'));
const {createProjectAccessPolicy}=await import(new URL('./project-access.mjs',nativeServer));
const {createProjectControlGuard,ordinaryControlPath}=await import(new URL('./project-control-guard.mjs',nativeServer));
const {withProjectAuthority,withProjectControlGuard}=await import(new URL('./projects.mjs',nativeServer));
const {withSourceAuthorization,sourceAccessError}=await import(new URL('../../src/media-links.mjs',nativeServer));
const {readable}=await import(new URL('./files.mjs',nativeServer));
const {writeAtomic}=await import(new URL('./atomic.mjs',nativeServer));

const deny = (code = 'authentication-required') => Object.assign(new Error(code === 'project-access-denied' ? 'Project access is not available.' : 'Sign in is required.'), {code,status:403});
const samePath = (a,b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const below = (root,path) => samePath(root,path) || (process.platform === 'win32' ? path.toLowerCase().startsWith(root.toLowerCase()+sep) : path.startsWith(root+sep));

/** Explicit pointer only. Missing/invalid configuration is an actionable signed-out state, never a legacy fallback. */
export function readDesktopAuthConfiguration(environment) {
  try {
    const file = environment.ORANGE_AUTH_CONFIG_FILE;
    if (typeof file !== 'string' || !isAbsolute(file)) return null;
    ordinaryControlPath(file);
    const stat=lstatSync(file);if(!stat.isFile() || stat.nlink !== 1 || stat.size>32768)return null;
    const value=JSON.parse(readFileSync(file,'utf8'));
    if(!value || Object.getPrototypeOf(value)!==Object.prototype || !['authOrigin,environmentId,publishableKey','authOrigin,businessOrigin,environmentId,publishableKey'].includes(Object.keys(value).sort().join()))return null;
    return value;
  } catch { return null; }
}

export function createDesktopAuth({configuration,home,sharedHome=home,projects,coordinationRoot,instanceId},dependencies) {
  if(!isAbsolute(home)||!isAbsolute(projects)||!isAbsolute(coordinationRoot))throw deny();
  const guard=createProjectControlGuard({coordinationRoot});
  const roots=[resolve(home),resolve(projects)];
  const homes=[...new Set([resolve(home),resolve(sharedHome)])];
  const domainId=createHash('sha256').update('orange-desktop\0'+(configuration?.environmentId??'unconfigured')).digest('hex').slice(0,24);
  const file=join(home,'orange-project-owners.json');
  let service=null,policy=null,verified=null,handles=new Map(),sealed=true,disposed=false,failed=false,retiring=null,retired=false,epoch=0;
  let reservation=null;
  let businessRequest=null;
  let materialScope=createHash('sha256').update('unconfigured').digest('hex');
  const businessAborters=new Set();
  const materialQueues=new Map();
  const selectedSources=new Map(), selections=new WeakMap();
  const operations=new Set();
  const listeners=new Set();
  const notify = state => {for(const listener of [dependencies.onState,...listeners])try{listener?.(Object.freeze({...state}));}catch{/* notification cannot grant authority */}};
  const safeState = (kind,reason=null) => Object.freeze({kind,reason});
  function loadOwners() {
    ordinaryControlPath(file);
    if(!existsSync(file))return [];
    const stat=lstatSync(file);if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024)throw deny('project-access-denied');
    let raw;try{raw=JSON.parse(readFileSync(file,'utf8'));}catch{throw deny('project-access-denied');}
    if(!raw||raw.version!==1||Object.keys(raw).sort().join()!=='projects,version'||!Array.isArray(raw.projects))throw deny('project-access-denied');
    const seen=new Set();
    for(const item of raw.projects){
      if(!item||Object.keys(item).sort().join()!=='environmentId,projectId,root,subjectId'||['environmentId','subjectId','projectId','root'].some(k=>typeof item[k]!=='string'||!item[k])||!isAbsolute(item.root))throw deny('project-access-denied');
      const key=item.environmentId+'\0'+item.projectId;if(seen.has(key))throw deny('project-access-denied');seen.add(key);
    }
    return raw.projects;
  }
  function saveOwners(items) {
    ordinaryControlPath(home);mkdirSync(home,{recursive:true});ordinaryControlPath(file);
    const temp=join(home,`orange-owners-${randomBytes(12).toString('hex')}.tmp`);
    writeFileSync(temp,JSON.stringify({version:1,projects:items})+'\n',{flag:'wx',mode:0o600});renameSync(temp,file);
  }
  function fence(state) {
    sealed=true;policy?.dispose();handles.clear();selectedSources.clear();notify(state);
    for(const abort of businessAborters)abort();
    if(verified&&!retiring&&!retired)beginRetirement();
  }
  function beginRetirement() {
    if(retiring)return retiring;
    if(retired)return Promise.resolve();
    sealed=true;policy?.dispose();handles.clear();selectedSources.clear();
    // Assign the promise before invoking any trusted external callback.
    retiring=Promise.resolve().then(async()=>{
      await dependencies.retire();
      await Promise.all([...operations].map(operation=>operation.catch(error=>{
        // A retired picker/source request may correctly deny. Its promise is
        // already retired; do not mistake that expected outcome for failed IO preservation.
        if(['authentication-required','project-access-denied','source-selection-required','source-access-denied','source-capability-unavailable'].includes(error?.code))return;
        throw error;
      })));
      if(failed)throw new Error('Desktop preservation failed.');
      reservation?.close();reservation=null;retired=true;
      dependencies.onRetired?.();
    }).catch(()=>{failed=true;notify(safeState('locked','preservation-failed'));}).finally(()=>{retiring=null;});
    return retiring;
  }
  function makeService() {
    if(!configuration)return null;
    try {
      const {businessOrigin,...authConfiguration}=configuration;
      businessRequest=null;
      materialScope=createHash('sha256').update('unconfigured').digest('hex');
      return createAuthService({...authConfiguration,instanceId,epoch:++epoch},{fetch:dependencies.fetch,monotonicNow:dependencies.monotonicNow,requestTimeoutMs:10000,onInvalidated:fence,
        ...(businessOrigin===undefined?{}:{business:{origin:businessOrigin,bind:request=>{materialScope=createHash('sha256').update(new URL(businessOrigin).origin).digest('hex');businessRequest=request;}}})});
    } catch { return null; }
  }
  service=makeService();
  function getPublicState() {
    if(failed)return safeState('locked','preservation-failed');
    if(disposed)return safeState('disposed','disposed');
    if(retiring)return safeState('locked','preservation-pending');
    if(!service)return safeState('signed-out','configuration-required');
    return service.getPublicState();
  }
  function assertActive() {
    const state=getPublicState();
    if(sealed||state.kind!=='active'||!verified)throw deny();
    return verified;
  }
  async function runBusiness(project,kind,input,signal) {
    const evidence=assertActive();authorizeProject(project);
    if(!businessRequest)throw Object.assign(new Error('Business configuration is required.'),{code:'business-configuration-required',status:503});
    const request=businessRequest,aborter=new AbortController(),abort=()=>aborter.abort();
    businessAborters.add(abort);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const operation=Promise.resolve().then(async()=>{
      if(assertActive()!==evidence)throw deny();authorizeProject(project);
      try {
        const response=await request(kind,input,evidence,aborter.signal);
        if(assertActive()!==evidence)throw deny();authorizeProject(project);return response;
      } catch(error) {
        if(sealed||assertActive()!==evidence)throw deny();
        throw Object.assign(new Error('Business request is unconfirmed.'),{code:typeof error?.code==='string'?error.code:'business-unconfirmed',status:503});
      }
    });
    operations.add(operation);
    try{return await operation;}finally{operations.delete(operation);businessAborters.delete(abort);signal?.removeEventListener('abort',abort);}
  }
  function projectRecord(project) {
    const evidence=assertActive();
    if(!project||typeof project.id!=='string'||typeof project.path!=='string'||!isAbsolute(project.path))throw deny('project-access-denied');
    let root;try{root=realpathSync(project.path);}catch{throw deny('project-access-denied');}
    const record=loadOwners().find(r=>r.environmentId===evidence.environmentId&&r.projectId===project.id&&r.subjectId===evidence.subjectId&&samePath(r.root,root));
    if(!record)throw deny('project-access-denied');
    for(const rel of ['film.html','.film','.film/id','.film/control.json','.film/cover.jpg','.film/cover.png','.film/cover.webp','.film/cover.gif'])ordinaryControlPath(join(root,rel));
    return record;
  }
  function authorizeProject(project) {
    const evidence=assertActive();projectRecord(project);
    let handle=handles.get(project.id);
    if(!handle){
      const bound=policy.bindProject({environmentId:evidence.environmentId,ownerSubjectId:evidence.subjectId,projectId:project.id,ownership:'controlled',material:{kind:'applicable',expiresAtMs:evidence.expiresAtMs}});
      if(!bound.allowed)throw deny('project-access-denied');handle=bound.handle;handles.set(project.id,handle);
    }
    const {environmentId,subjectId,instanceId,epoch}=evidence;
    if(!policy.decide({environmentId,subjectId,instanceId,epoch,projectId:project.id},handle,'restricted').allowed)throw deny('project-access-denied');
    return true;
  }

  const fingerprint = stat => [stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs,stat.nlink].join(':');
  const sourceKey = path => process.platform==='win32'?path.toLowerCase():path;
  function sourceInfo(path,operation,evidence) {
    if(assertActive()!==evidence)throw sourceAccessError();
    if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)throw sourceAccessError();
    try {
      ordinaryControlPath(path);
      const real=realpathSync.native(path),stat=lstatSync(real);
      ordinaryControlPath(real);
      const records=loadOwners();
      const controlling=records.filter(r=>below(r.root,real)).sort((a,b)=>b.root.length-a.root.length)[0];
      const own=controlling&&controlling.environmentId===evidence.environmentId&&controlling.subjectId===evidence.subjectId?controlling:null;
      const controlled=Boolean(controlling)||roots.some(r=>below(r,real))||homes.some(r=>below(r,real));
      if(controlled&&!own)throw sourceAccessError();
      for(let at=real;;at=dirname(at)) {
        for(const marker of [join(at,'.openfilm-control.json'),join(at,'.film','control.json')]) {
          if(!existsSync(marker))continue;
          ordinaryControlPath(marker);const st=lstatSync(marker);
          if(!st.isFile()||st.nlink!==1||st.size>32768)throw sourceAccessError();
          const boundary=JSON.parse(readFileSync(marker,'utf8'));
          const known=[...homes,roots[1]].some(root=>samePath(root,at))||records.some(r=>r.environmentId===evidence.environmentId&&r.subjectId===evidence.subjectId&&samePath(r.root,at));
          if(!known||boundary?.version!==1||boundary?.domainId!==domainId)throw sourceAccessError();
        }
        if(at===dirname(at))break;
      }
      if(own){
        const suffix=real.slice(own.root.length).split(sep).filter(Boolean);
        if(suffix.includes('.film')&&operation!=='control-read')throw sourceAccessError();
        if(operation==='control-read'&&!/^\.film[\\/](?:cover\.(?:jpg|png|webp|gif))$/.test(suffix.join(sep)))throw sourceAccessError();
      }
      if(['link','linked-read','relink','directory'].includes(operation))throw sourceAccessError('source-capability-unavailable',503);
      if(operation==='read'||operation==='control-read'){
        if(!own)throw sourceAccessError();
        return {path:real,fingerprint:fingerprint(stat),evidence};
      }
      if(!stat.isFile()||stat.nlink!==1)throw sourceAccessError('source-capability-unavailable',503);
      if(operation!=='select'&&!own){
        const grant=selectedSources.get(sourceKey(real));
        if(!grant||grant.evidence!==evidence)throw sourceAccessError('source-selection-required');
        if(grant.fingerprint!==fingerprint(stat))throw sourceAccessError();
      }
      return {path:real,fingerprint:fingerprint(stat),evidence};
    } catch(error) {
      if(error?.code?.startsWith('source-'))throw error;
      throw sourceAccessError();
    }
  }
  function authorizeSource(path,operation,evidence) {
    const info=sourceInfo(path,operation,evidence);
    return Object.freeze({path:info.path,recheck:()=>{const now=sourceInfo(path,operation,evidence);if(now.fingerprint!==info.fingerprint)throw sourceAccessError();},
      assertFile:stat=>{if(assertActive()!==evidence||fingerprint(stat)!==info.fingerprint||!stat.isFile()||stat.nlink!==1)throw sourceAccessError();const now=sourceInfo(path,operation,evidence);if(now.fingerprint!==info.fingerprint)throw sourceAccessError();}});
  }

  const materialError=(code='material-metadata-unconfirmed')=>Object.assign(new Error(code),{code,status:503});
  const materialUuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
  const materialIdentity=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,stat.nlink].map(String).join(':');
  const materialPath=path=>typeof path==='string'&&!!path&&!/[\\:\x00-\x1f]/.test(path)&&path.split('/').every(part=>part&&part!=='.'&&part!=='..');
  function materialFile(project){return ordinaryControlPath(join(project.path,'.film','orange-materials.json'));}
  function loadMaterials(project,evidence){
    const file=materialFile(project);
    if(!existsSync(file))return {version:1,environmentId:evidence.environmentId,subjectId:evidence.subjectId,projectId:project.id,serviceScope:materialScope,records:[]};
    try{
      const stat=lstatSync(file);if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024)throw 0;
      const data=JSON.parse(readFileSync(file,'utf8'));
      if(!data||Object.keys(data).sort().join()!=='environmentId,projectId,records,serviceScope,subjectId,version'||data.version!==1||data.environmentId!==evidence.environmentId||data.subjectId!==evidence.subjectId||data.projectId!==project.id||data.serviceScope!==materialScope||!Array.isArray(data.records)||data.records.length>4096)throw 0;
      const keys=new Set();for(const r of data.records){const expected=r?.state==='registered'?'assetId,identity,key,name,path,sha256,state,versionId':'identity,key,name,path,sha256,state';if(!r||Object.keys(r).sort().join()!==expected||!['unknown','registered'].includes(r.state)||!materialUuid(r.key)||keys.has(r.key)||!materialPath(r.path)||typeof r.name!=='string'||!r.name||r.name.length>128||/[\/\\\x00-\x1f]/.test(r.name)||typeof r.identity!=='string'||!/^\d+:\d+:\d+:-?\d+:-?\d+:1$/.test(r.identity)||!/^[a-f0-9]{64}$/.test(r.sha256)||r.state==='registered'&&(!materialUuid(r.assetId)||!materialUuid(r.versionId)))throw 0;keys.add(r.key);}
      return data;
    }catch{throw materialError();}
  }
  async function saveMaterials(project,evidence,data){
    if(assertActive()!==evidence)throw deny();authorizeProject(project);materialFile(project);
    const bytes=JSON.stringify(data,null,2)+'\n';if(Buffer.byteLength(bytes)>1024*1024)throw materialError();await writeAtomic(materialFile(project),bytes,{mode:0o600});if(assertActive()!==evidence)throw deny();authorizeProject(project);
  }
  async function materialHash(fd,evidence,ticket){const h=createHash('sha256'),b=Buffer.alloc(65536);let at=0;while(true){if(assertActive()!==evidence)throw deny();ticket.recheck();ticket.assertFile(await fd.stat());const {bytesRead}=await fd.read(b,0,b.length,at);if(!bytesRead)break;h.update(b.subarray(0,bytesRead));at+=bytesRead;}return h.digest('hex');}
  async function materialTask(project,work){
    const evidence=assertActive();authorizeProject(project);
    const result=await controller.runNative(async()=>{const previous=materialQueues.get(project.id)||Promise.resolve();const queued=previous.catch(()=>{}).then(async()=>{if(assertActive()!==evidence)throw deny();authorizeProject(project);return work(evidence);});materialQueues.set(project.id,queued);try{return await queued;}finally{if(materialQueues.get(project.id)===queued)materialQueues.delete(project.id);}});
    if(assertActive()!==evidence)throw deny();authorizeProject(project);return result;
  }
  async function inspectMaterial(project,rel,evidence,work){
    if(!materialPath(rel)||basename(rel).length>128)throw materialError('invalid-material-source');const path=readable(project.path,rel),ticket=authorizeSource(path,'read',evidence),fd=await open(ticket.path,'r');
    try{ticket.assertFile(await fd.stat());const identity=materialIdentity(await fd.stat({bigint:true})),sha256=await materialHash(fd,evidence,ticket);return await work({fd,ticket,identity,sha256});}finally{try{await fd.close();}catch(cause){throw Object.assign(sourceAccessError('source-preservation-failed',503),{cause});}}
  }
  async function materialStatus(project,rel){return materialTask(project,evidence=>{
    const data=loadMaterials(project,evidence);
    return inspectMaterial(project,rel,evidence,async({identity,sha256})=>{
      const r=[...data.records].reverse().find(r=>r.path===rel&&r.identity===identity&&r.sha256===sha256);
      if(!r)return {state:data.records.some(r=>r.path===rel)?'stale':businessRequest?'unregistered':'unavailable',available:!!businessRequest};
      return {state:r.state,available:!!businessRequest,...(r.state==='registered'?{assetId:r.assetId,versionId:r.versionId}:{})};
    });
  });}
  async function registerMaterial(project,rel){return materialTask(project,evidence=>{
    const data=loadMaterials(project,evidence);if(!businessRequest)return {state:'unavailable',available:false};
    return inspectMaterial(project,rel,evidence,async({fd,ticket,identity,sha256})=>{
      let record=[...data.records].reverse().find(r=>r.path===rel&&r.identity===identity&&r.sha256===sha256);
      if(record?.state==='registered')return {state:'registered',available:true,assetId:record.assetId,versionId:record.versionId};
      if(!record){record={key:randomUUID(),name:basename(rel),path:rel,identity,sha256,state:'unknown'};data.records.push(record);await saveMaterials(project,evidence,data);}
      if(assertActive()!==evidence)throw deny();ticket.recheck();ticket.assertFile(await fd.stat());if(materialIdentity(await fd.stat({bigint:true}))!==identity)throw sourceAccessError();
      const stream=fd.createReadStream({start:0,autoClose:false});const completion=finished(stream,{cleanup:true});void completion.catch(()=>{});const hash=createHash('sha256');let sent=0;
      const body=(async function*(){for await(const bytes of stream){if(assertActive()!==evidence)throw deny();ticket.recheck();ticket.assertFile(await fd.stat());sent+=bytes.length;if(sent>536870912)throw materialError('material-upload-limit');hash.update(bytes);yield bytes;}})();
      const abort=()=>stream.destroy();businessAborters.add(abort);
      try{
        const reply=await runBusiness(project,'register',{key:record.key,name:record.name,body});
        if(!stream.readableEnded)return {state:'unknown',available:true};await body.return();await completion;
        if(assertActive()!==evidence)throw deny();ticket.recheck();ticket.assertFile(await fd.stat());
        if(materialIdentity(await fd.stat({bigint:true}))!==identity||sent!==Number((await fd.stat({bigint:true})).size)||hash.digest('hex')!==sha256||await materialHash(fd,evidence,ticket)!==sha256)throw sourceAccessError();
        if(reply.status!==200||reply.data?.registration!=='registered'||reply.data?.licensed!==false||!materialUuid(reply.data?.assetId)||!materialUuid(reply.data?.versionId))return {state:'unknown',available:true};
        if(JSON.stringify(loadMaterials(project,evidence))!==JSON.stringify(data))throw materialError();record.state='registered';record.assetId=reply.data.assetId;record.versionId=reply.data.versionId;await saveMaterials(project,evidence,data);ticket.recheck();ticket.assertFile(await fd.stat());if(materialIdentity(await fd.stat({bigint:true}))!==identity||await materialHash(fd,evidence,ticket)!==sha256)throw sourceAccessError();if(assertActive()!==evidence)throw deny();
        return {state:'registered',available:true,assetId:record.assetId,versionId:record.versionId};
      }catch(error){if(sealed||assertActive()!==evidence)throw deny();if(error?.code==='material-metadata-unconfirmed'||error?.code?.startsWith('source-'))throw error;return {state:'unknown',available:true};}
      finally{businessAborters.delete(abort);stream.destroy();await body.return().catch(()=>{});await completion.catch(()=>{});}
    });
  });}

  async function signIn(input) {
    if(disposed||failed||retiring)return Object.freeze({ok:false,code:disposed?'disposed':failed?'preservation-failed':'preservation-pending',state:getPublicState()});
    if(retired){service?.dispose();service=makeService();verified=null;retired=false;}
    if(!service)return Object.freeze({ok:false,code:'configuration-required',state:getPublicState()});
    const result=await service.signIn(input);
    if(!result.ok){notify(result.state);return result;}
    try {
      const evidence=service.getVerifiedEvidence();if(!evidence)throw deny();
      loadOwners();
      for(const path of [...homes,roots[1]]){ordinaryControlPath(path);mkdirSync(path,{recursive:true});}
      reservation=await guard.acquireControlledReservation({homes,roots:[roots[1]],targets:[]});
      if(!service.getVerifiedEvidence()||disposed||failed)throw deny();
      // Durable deny markers keep a separately started native CLI out after logout/restart too.
      for(const root of [...homes,roots[1]]) {
        const marker=ordinaryControlPath(join(root,'.openfilm-control.json'));
        if(existsSync(marker)){const value=JSON.parse(readFileSync(marker,'utf8'));if(value.version!==1||value.domainId!==domainId)throw deny();}
        else writeFileSync(marker,JSON.stringify({version:1,domainId})+'\n',{flag:'wx',mode:0o600});
      }
      verified=evidence;policy=createProjectAccessPolicy(evidence,{monotonicNow:dependencies.monotonicNow});sealed=false;
      notify(getPublicState());return Object.freeze({ok:true,code:'ok',state:getPublicState()});
    } catch {
      sealed=true;reservation?.close();reservation=null;
      service.dispose();service=makeService();verified=null;
      notify(getPublicState());
      return Object.freeze({ok:false,code:'project-access-denied',state:getPublicState()});
    }
  }
  async function signOut() {
    sealed=true;policy?.dispose();handles.clear();selectedSources.clear();notify(safeState('signed-out'));
    const remote=service?.signOut();
    if(verified)await beginRetirement();
    await remote;return Object.freeze({state:getPublicState()});
  }
  const controller={
    getPublicState,assertActive,signIn,signOut,
    registerMaterial,materialStatus,
    async materialVersionForSource(project,rel){const evidence=assertActive(),status=await materialStatus(project,rel);if(assertActive()!==evidence)throw deny();authorizeProject(project);if(status.state!=='registered')throw materialError('material-registration-required');return {assetId:status.assetId,versionId:status.versionId};},
    business:Object.freeze({
      resolve:(project,body,signal)=>runBusiness(project,'resolve',body,signal),
      claim:(project,body,signal)=>runBusiness(project,'claim',body,signal),
      status:(project,id,signal)=>runBusiness(project,'status',id,signal),
      cancel:(project,id,signal)=>runBusiness(project,'cancel',id,signal),
    }),
    beginSourceSelection(){const scope=Object.freeze({});selections.set(scope,assertActive());return scope;},
    completeSourceSelection(scope,paths){
      const evidence=assertActive();if(selections.get(scope)!==evidence)throw sourceAccessError();selections.delete(scope);
      if(!Array.isArray(paths))throw sourceAccessError();
      const infos=paths.map(path=>sourceInfo(path,'select',evidence));
      for(const info of infos)selectedSources.set(sourceKey(info.path),info);
      return infos.map(info=>info.path);
    },
    onState(listener){if(typeof listener!=='function')throw deny();listeners.add(listener);return()=>listeners.delete(listener);},
    windowScope(){const evidence=assertActive();return createHash('sha256').update(evidence.environmentId+'\0'+evidence.subjectId).digest('hex');},
    revalidate:async()=>service?service.revalidate():{ok:false,code:'configuration-required',state:getPublicState()},
    ownsProject(project){try{projectRecord(project);return true;}catch{return false;}},
    authorizeProject,
    authorizeProjectId(id){const evidence=assertActive();const item=loadOwners().find(r=>r.environmentId===evidence.environmentId&&r.subjectId===evidence.subjectId&&r.projectId===id);if(!item)throw deny('project-access-denied');return authorizeProject({id,path:item.root});},
    async registerCreatedProject(project){
      const evidence=assertActive();const root=realpathSync(project.path);
      if(!below(roots[1],root))throw deny('project-access-denied');
      const items=loadOwners();if(items.some(r=>r.environmentId===evidence.environmentId&&r.projectId===project.id))throw deny('project-access-denied');
      const marker=ordinaryControlPath(join(root,'.film','control.json'));mkdirSync(dirname(marker),{recursive:true});
      if(!existsSync(marker))writeFileSync(marker,JSON.stringify({version:1,domainId})+'\n',{flag:'wx',mode:0o600});
      items.push({environmentId:evidence.environmentId,subjectId:evidence.subjectId,projectId:project.id,root});saveOwners(items);authorizeProject(project);return project;
    },
    listOwnedProjects(items){assertActive();return items.filter(project=>controller.ownsProject(project));},
    async runNative(work){
      const evidence=assertActive();
      const account=createHash('sha256').update(evidence.environmentId+'\0'+evidence.subjectId).digest('hex');
      const authority={
        stateFile:join(home,'orange-accounts',account,'studio.json'),
        owns:project=>controller.ownsProject(project),
        pathAllowed:path=>{
          assertActive();let real;try{real=realpathSync(path);}catch{return false;}
          return loadOwners().some(r=>r.environmentId===evidence.environmentId&&r.subjectId===evidence.subjectId&&samePath(r.root,real));
        },
        created:project=>controller.registerCreatedProject(project),
        moved:async(project,from)=>{
          assertActive();const items=loadOwners();const item=items.find(r=>r.environmentId===evidence.environmentId&&r.subjectId===evidence.subjectId&&r.projectId===project.id&&samePath(r.root,from));
          if(!item)throw deny('project-access-denied');item.root=realpathSync(project.path);saveOwners(items);
        },
      };
      const operation=Promise.resolve().then(()=>reservation.run(()=>{try{assertActive();return true;}catch{return false;}},()=>withProjectControlGuard(guard,()=>withProjectAuthority(authority,()=>withSourceAuthorization((path,operation)=>authorizeSource(path,operation,evidence),work)))));
      operations.add(operation);
      try{return await operation;}
      catch(error){
        if(error?.code==='source-preservation-failed'){
          failed=true;sealed=true;policy?.dispose();handles.clear();selectedSources.clear();
          notify(safeState('locked','preservation-failed'));
        }
        throw error;
      }finally{operations.delete(operation);}
    },
    async dispose(){
      if(!disposed){disposed=true;sealed=true;selectedSources.clear();policy?.dispose();service?.dispose();}
      if(verified)await beginRetirement();
      const result=Object.freeze({confirmed:!failed,reason:failed?'preservation-failed':null});
      notify(failed?safeState('locked','preservation-failed'):safeState('disposed','disposed'));
      return result;
    },
  };
  return Object.freeze(controller);
}
