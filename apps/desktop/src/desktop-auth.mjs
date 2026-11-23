// 漏 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner鈥檚 written permission.

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
const {withProjectAuthority,withProjectControlGuard,withProjectControlGuardAllowingRead}=await import(new URL('./projects.mjs',nativeServer));
const {isolatedControlPolicy}=await import(new URL('./isolation-control-policy.mjs',nativeServer));
const {readIsolationProfile}=await import(new URL('../../src/development-isolation.mjs',nativeServer));

const deny = (code = 'authentication-required') => Object.assign(new Error(code === 'project-access-denied' ? 'Project access is not available.' : 'Sign in is required.'), {code,status:403});
const samePath = (a,b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const below = (root,path) => samePath(root,path) || (process.platform === 'win32' ? path.toLowerCase().startsWith(root.toLowerCase()+sep) : path.startsWith(root+sep));

/** `path` under `to` where it was under `from` (the same separators both sides), or null when it is not under `from`. */
function rebase(path,from,to) {
  const a=process.platform==='win32'?path.toLowerCase():path;
  const b=process.platform==='win32'?from.toLowerCase():from;
  if(a===b)return to;
  if(!a.startsWith(b+sep))return null;
  return to+path.slice(from.length);
}

/**
 * The owner records whose project root moved with the product's folder (locations.mjs `migrateProductFolder`): every
 * `root` that was under the old folder is rewritten under the new one, so the projects a person already has stay
 * theirs after the rename. `registerCreatedProject` wrote those roots as real paths when the projects were made, and
 * `projectRecord` matches a project by its real path: without this, every one of them would answer
 * `project-access-denied`.
 *
 * Only `root` changes: the environment, subject and project ids, and every other key, are written back as they were.
 * A file this does not know (another version, not the shape loadOwners reads) is left exactly as it was 鈥?the migration
 * of a folder must not be the reason a person's records are dropped. Returns how many records moved.
 *
 * @param {{ home: string, from: string, to: string }} options
 */
export function migrateOwnerRoots({home,from,to}) {
  const file=join(home,'orange-project-owners.json');
  try {
    if(!existsSync(file))return 0;
    const stat=lstatSync(file);if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024)return 0;
    const raw=JSON.parse(readFileSync(file,'utf8'));
    if(!raw||raw.version!==1||!Array.isArray(raw.projects))return 0;
    let moved=0;
    const projects=raw.projects.map(item=>{
      const root=item&&typeof item.root==='string'?rebase(item.root,from,to):null;
      if(!root)return item;
      moved+=1;return {...item,root};
    });
    if(!moved)return 0;
    const temp=join(home,`orange-owners-${randomBytes(12).toString('hex')}.tmp`);
    writeFileSync(temp,JSON.stringify({version:1,projects})+'\n',{flag:'wx',mode:0o600});renameSync(temp,file);
    return moved;
  } catch { return 0; }
}

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

/** The reasons a signed-out state may carry when there is no usable configuration: see auth-env-file.mjs. */
const CONFIGURATION_REASONS = ['configuration-required', 'install-incomplete', 'install-conflict'];

export function createDesktopAuth({configuration,home,sharedHome=home,projects,coordinationRoot,instanceId,configurationReason},dependencies) {
  if(!isAbsolute(home)||!isAbsolute(projects)||!isAbsolute(coordinationRoot))throw deny();
  const guard=createProjectControlGuard({coordinationRoot});
  const roots=[resolve(home),resolve(projects)];
  const homes=[...new Set([resolve(home),resolve(sharedHome)])];
  const domainId=createHash('sha256').update('orange-desktop\0'+(configuration?.environmentId??'unconfigured')).digest('hex').slice(0,24);
  function expectedMarker() {
    const profile=readIsolationProfile();
    if(!profile)return {version:1,domainId};
    const trusted=isolatedControlPolicy(profile);
    const root=process.platform==='win32'?trusted.baseRoot.toLowerCase():trusted.baseRoot;
    return {version:2,domainId,coordinationId:createHash('sha256').update(root).digest('hex')};
  }
  function verifyMarker(path,create=false) {
    ordinaryControlPath(path);const expected=expectedMarker();
    if(!existsSync(path)&&create)writeFileSync(path,JSON.stringify(expected)+'\n',{flag:'wx',mode:0o600});
    const value=JSON.parse(readFileSync(path,'utf8'));
    if(!value||Object.keys(value).sort().join()!==Object.keys(expected).sort().join()||Object.keys(expected).some(k=>value[k]!==expected[k]))throw deny('project-access-denied');
  }
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
      await Promise.all([...operations].map(operation=>operation.catch(error=>{
        // A request denied by retirement has finished; it is not a failed resource close.
        if(['authentication-required','project-access-denied'].includes(error?.code))return;
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
      return createAuthService({...configuration,instanceId,epoch:++epoch},{fetch:dependencies.fetch,monotonicNow:dependencies.monotonicNow,requestTimeoutMs:10000,onInvalidated:fence});
    } catch { return null; }
  }
  /* Why there is no configuration, when the caller knows: an installed app whose installer is incomplete says so,
     instead of asking its user to configure something they cannot. Anything outside the whitelist stays the generic
     development reason 鈥?a free-form string must never reach the window. */
  const offlineReason = CONFIGURATION_REASONS.includes(configurationReason) ? configurationReason : 'configuration-required';
  service=makeService();
  /* 浠呭紑鍙戞満锛歄PENFILM_DEV_AUTH=off 涓旈潪鎵撳寘杩涚▼鏃讹紝缁欏嚭涓€涓湰鍦?dev 涓讳綋锛岀渷鎺夌櫥褰曘€?     鎵撳寘鏋勫缓鍦?main.mjs 閲屽啓 OPENFILM_APP_PACKAGED=1锛屽洜姝ゅ彂甯冨寘姘歌繙涓嶄細璧拌繖閲屻€?*/
  function getPublicState() {
    if(failed)return safeState('locked','preservation-failed');
    if(disposed)return safeState('disposed','disposed');
    if(retiring)return safeState('locked','preservation-pending');
    if(!service)return safeState('signed-out',offlineReason);
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
    if(readIsolationProfile())verifyMarker(join(root,'.film','control.json'));
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
    let result=await service.signIn(input);
    /* The environment may already have been activated on this machine (its activation state survives a restart), and
       the service then answers `switch-required` instead of signing in. On a single-user machine that is exactly the
       case the service's own retirement is for: retire the previous activation, then sign in once more. Nothing is
       loosened 鈥?a still-refused sign-in is returned as it is. */
    if(result&&result.code==='switch-required'){
      try{ await service.signOut(); }catch{ /* retirement is best effort; the retry below decides */ }
      result=await service.signIn(input);
    }
    if(!result.ok){notify(result.state);return result;}
    let step='evidence';let evidence=null;
    try {
      evidence=service.getVerifiedEvidence();if(!evidence)throw deny();
      step='loadOwners';loadOwners();
      step='mkdir';
      for(const path of [...homes,roots[1]]){ordinaryControlPath(path);mkdirSync(path,{recursive:true});}
      step='reservation';
      /* A hard kill leaves the reservation of a process that no longer exists; reclaim those once and try again, so a
         restart restores the full read/write state instead of quietly staying read-only. */
      try { reservation=await guard.acquireControlledReservation({homes,roots:[roots[1]],targets:[]}); }
      catch (busy) {
        if (busy?.code !== 'control-busy') throw busy;
        const freed = await guard.reclaimDead?.();
        if (!freed) throw busy;
        reservation=await guard.acquireControlledReservation({homes,roots:[roots[1]],targets:[]});
      }
      step='recheck';
      if(!service.getVerifiedEvidence()||disposed||failed)throw deny();
      // Durable deny markers keep a separately started native CLI out after logout/restart too.
      step='markers';
      for(const root of [...homes,roots[1]]) {
        const marker=ordinaryControlPath(join(root,'.openfilm-control.json'));
        verifyMarker(marker,true);
      }
      step='policy';
      verified=evidence;policy=createProjectAccessPolicy(evidence,{monotonicNow:dependencies.monotonicNow});sealed=false;
      notify(getPublicState());return Object.freeze({ok:true,code:'ok',state:getPublicState()});
    } catch (error) {
      /* The workspace seal is ours, not the identity layer's: a marker or reservation that cannot be written must not
         turn a successful Supabase sign-in into "this sign-in is not active". The step and cause are recorded, the
         reservation is released, and the person stays signed in 鈥?the seal's guarantees degrade, the session does not. */
      try {
        const diag = join(homes[0], 'auth-diag.log');
        mkdirSync(homes[0], { recursive: true });
        writeFileSync(diag, `${new Date().toISOString()}\tstep=${step}\tcode=${error?.code ?? 'no-code'}\tmessage=${String(error?.message ?? error)}\n`, { flag: 'a' });
        process.stderr.write(`[auth] seal failed at ${step}: ${error?.message ?? error} (${error?.code ?? 'no-code'}) 鈥?signed in anyway\n`);
      } catch { /* diagnostics must never be the reason a sign-in fails */ }
      reservation?.close();reservation=null;
      if(evidence){
        verified=evidence;
        try { policy=createProjectAccessPolicy(evidence,{monotonicNow:dependencies.monotonicNow}); } catch { policy=null; }
        sealed=false;notify(getPublicState());
        return Object.freeze({ok:true,code:'ok',state:getPublicState()});
      }
      sealed=true;
      service.dispose();service=makeService();verified=null;
      notify(getPublicState());
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
      verifyMarker(marker,true);
      items.push({environmentId:evidence.environmentId,subjectId:evidence.subjectId,projectId:project.id,root});saveOwners(items);authorizeProject(project);return project;
    },
    listOwnedProjects(items){assertActive();return items.filter(project=>controller.ownsProject(project));},
    async runNative(work){
      const evidence=assertActive();
      const account=createHash('sha256').update(evidence.environmentId+'\0'+evidence.subjectId).digest('hex');
      const accountOwned=real=>loadOwners().some(r=>r.environmentId===evidence.environmentId&&r.subjectId===evidence.subjectId&&samePath(r.root,real));
      const authority={
        stateFile:join(home,'orange-accounts',account,'studio.json'),
        owns:project=>controller.ownsProject(project),
        pathAllowed:path=>{
          assertActive();let real;try{real=realpathSync(path);}catch{return false;}
          return accountOwned(real);
        },
        created:project=>controller.registerCreatedProject(project),
        moved:async(project,from)=>{
          assertActive();const items=loadOwners();const item=items.find(r=>r.environmentId===evidence.environmentId&&r.subjectId===evidence.subjectId&&r.projectId===project.id&&samePath(r.root,from));
          if(!item)throw deny('project-access-denied');item.root=realpathSync(project.path);saveOwners(items);
        },
      };
      /* The projects on this device are the device's: a session that could not take its reservation still reads every
         project below the folder local projects live in, without an owner record. A path outside it stays the account's
         to prove, and nothing changes without a lease: `readOnly` refuses every list change, and no owner record is
         written. */
      const deviceAuthority=Object.freeze({
        stateFile:authority.stateFile,readOnly:true,
        owns:project=>{assertActive();let real;try{real=realpathSync(project.path);}catch{return false;}return below(roots[1],real)||accountOwned(real);},
        pathAllowed:path=>{assertActive();let real;try{real=realpathSync(path);}catch{return false;}return below(roots[1],real)||accountOwned(real);},
        created:async()=>{throw deny('project-access-denied');},
        moved:async()=>{throw deny('project-access-denied');},
      });
      /* A sign-in that degraded past the seal has no reservation. Its cause is ours (a coordination record another copy
         left behind), not the person's, so the project must still open: the guard's context is established without a
         lease, and the authority reads this device's projects and refuses to change them. */
      if(!reservation){
        try {
          mkdirSync(homes[0], { recursive: true });
          writeFileSync(join(homes[0], 'auth-diag.log'), `${new Date().toISOString()}\tdegraded=no-reservation\top=project-access\n`, { flag: 'a' });
        } catch { /* diagnostics never block */ }
        return await withProjectControlGuardAllowingRead(guard, () => withProjectAuthority(deviceAuthority, work), {readOnly:true});
      }
      const operation=Promise.resolve().then(()=>reservation.run(()=>{try{assertActive();return true;}catch{return false;}},()=>withProjectControlGuard(guard,()=>withProjectAuthority(authority,work))));
      operations.add(operation);try{return await operation;}finally{operations.delete(operation);}
    },
    async dispose(){if(!disposed){disposed=true;sealed=true;policy?.dispose();service?.dispose();if(verified)await beginRetirement();notify(getPublicState());}return Object.freeze({confirmed:!failed,reason:failed?'preservation-failed':null});},
  };
  return Object.freeze(controller);
}
