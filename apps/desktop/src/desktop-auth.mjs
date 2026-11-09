/** First-party authentication in the existing Studio utility. Never expose this object to a renderer. */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createAuthService } from './auth-service.mjs';
// Resolve the app's existing bundled OpenFilm, not source-checkout-relative paths or a global package.
const nativeServer=pathToFileURL(createRequire(import.meta.url).resolve('openfilm/studio'));
const {createProjectAccessPolicy}=await import(new URL('./project-access.mjs',nativeServer));
const {createProjectControlGuard,ordinaryControlPath}=await import(new URL('./project-control-guard.mjs',nativeServer));
const {withProjectAuthority,withProjectControlGuard}=await import(new URL('./projects.mjs',nativeServer));

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
    if(!value || Object.getPrototypeOf(value)!==Object.prototype || Object.keys(value).sort().join()!=='authOrigin,environmentId,publishableKey')return null;
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
    sealed=true;policy?.dispose();handles.clear();notify(state);
    if(verified&&!retiring&&!retired)beginRetirement();
  }
  function beginRetirement() {
    if(retiring)return retiring;
    if(retired)return Promise.resolve();
    sealed=true;policy?.dispose();handles.clear();
    // Assign the promise before invoking any trusted external callback.
    retiring=Promise.resolve().then(async()=>{
      await dependencies.retire();
      await Promise.all([...operations]);
      reservation?.close();reservation=null;retired=true;
      dependencies.onRetired?.();
    }).catch(()=>{failed=true;notify(safeState('locked','preservation-failed'));}).finally(()=>{retiring=null;});
    return retiring;
  }
  function makeService() {
    if(!configuration)return null;
    try {
      return createAuthService({...configuration,instanceId,epoch:++epoch},{fetch:dependencies.fetch,monotonicNow:dependencies.monotonicNow,requestTimeoutMs:10000,onInvalidated:fence});
    } catch { return null; }
  }
  service=makeService();
  function getPublicState() {
    if(disposed)return safeState('disposed','disposed');
    if(failed)return safeState('locked','preservation-failed');
    if(retiring)return safeState('locked','preservation-pending');
    if(!service)return safeState('signed-out','configuration-required');
    return service.getPublicState();
  }
  function assertActive() {
    const state=getPublicState();
    if(sealed||state.kind!=='active'||!verified)throw deny();
    return verified;
  }
  function projectRecord(project) {
    const evidence=assertActive();
    if(!project||typeof project.id!=='string'||typeof project.path!=='string'||!isAbsolute(project.path))throw deny('project-access-denied');
    let root;try{root=realpathSync(project.path);}catch{throw deny('project-access-denied');}
    const record=loadOwners().find(r=>r.environmentId===evidence.environmentId&&r.projectId===project.id&&r.subjectId===evidence.subjectId&&samePath(r.root,root));
    if(!record)throw deny('project-access-denied');return record;
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
      return Object.freeze({ok:false,code:'project-access-denied',state:getPublicState()});
    }
  }
  async function signOut() {
    sealed=true;policy?.dispose();handles.clear();notify(safeState('signed-out'));
    const remote=service?.signOut();
    if(verified)await beginRetirement();
    await remote;return Object.freeze({state:getPublicState()});
  }
  const controller={
    getPublicState,assertActive,signIn,signOut,
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
      const operation=Promise.resolve().then(()=>reservation.run(()=>{try{assertActive();return true;}catch{return false;}},()=>withProjectControlGuard(guard,()=>withProjectAuthority(authority,work))));
      operations.add(operation);try{return await operation;}finally{operations.delete(operation);}
    },
    async dispose(){if(disposed)return;disposed=true;sealed=true;policy?.dispose();service?.dispose();if(verified)await beginRetirement();notify(safeState('disposed','disposed'));},
  };
  return Object.freeze(controller);
}
