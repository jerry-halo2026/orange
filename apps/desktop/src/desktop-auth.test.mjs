// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { testRoot } from '../../../packages/orangefilm/src/test-roots.mjs';
/* TSX 编成 CJS 后 require 不了两个 .ts/.tsx 依赖（见 display-name.test.mjs 的同名垫片） */
const repoBrand = JSON.parse(readFileSync(new URL('../../../brand.json', import.meta.url), 'utf8'));
const shimFor = (req) => (id) => (id.endsWith('brand.generated.ts') ? { brand: repoBrand }
  : id.startsWith('orangefilm/studio-ui/') ? { BrandMark: () => null }
  : req(id));

// The controller's home/projects roots must be an owned, absolute, canonical
// directory: `testRoot()` returns the long form so `resolve(root) === root`.
const root = testRoot('desktop-auth');
assert.ok(resolve(root) === root, 'testRoot() returns a canonical absolute path');
await mkdir(root, { recursive: true });
const mod = await import('./desktop-auth.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
// The same native modules the controller itself resolves, so the project API below is the one it guards.
const { createProject, listProjects, projectById, openProject } = await import(new URL('./projects.mjs', pathToFileURL(createRequire(import.meta.url).resolve('orangefilm/studio'))));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const configuration = {environmentId:'isolated-test',authOrigin:'https://auth.invalid',publishableKey:'public-fixture'};
const input = {email:'synthetic@example.invalid',password:'not-a-real-password'};
async function setup(options = {}) {
  assert.equal(typeof mod.createDesktopAuth, 'function', 'real native desktop auth controller exists');
  const home = await mkdtemp(join(root, 'controller-'));
  const projects = join(home, 'projects'); await mkdir(projects);
  let now = 10, subject = A;
  const calls = [], states = [];
  const fetch = async (url, request) => {
    calls.push({url, method:request.method});
    if (url.endsWith('/auth/v1/token?grant_type=password')) return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',token_type:'bearer',expires_in:60,user:{id:subject}});
    if (url.endsWith('/auth/v1/user')) return Response.json({id:subject,is_anonymous:false});
    if (url.endsWith('/auth/v1/logout?scope=local')) return new Response(null,{status:204});
    throw Error('unexpected endpoint');
  };
  const controller = mod.createDesktopAuth({configuration,home,projects,coordinationRoot:join(home,'coord'),instanceId:'test-instance'}, {
    fetch,monotonicNow:()=>now,retire:options.retire ?? (async()=>{}),onState:state=>states.push(state), ...options.dependencies,
  });
  return {controller,home,projects,calls,states,setTime:value=>{now=value;},setSubject:value=>{subject=value;}};
}

test('desktop login controller is signed out until actual two-step Auth succeeds; public state has no secrets', async () => {
  const s=await setup();
  assert.equal(s.controller.getPublicState().kind,'signed-out');
  assert.throws(()=>s.controller.assertActive(),{code:'authentication-required'});
  assert.equal((await s.controller.signIn(input)).ok,true);
  assert.equal(s.controller.getPublicState().kind,'active');
  assert.deepEqual(s.calls.map(c=>new URL(c.url).pathname),['/auth/v1/token','/auth/v1/user']);
  assert.doesNotMatch(JSON.stringify(s.controller.getPublicState()),/synthetic-access|synthetic-refresh|11111111|auth\.invalid/);
  await s.controller.dispose();
});

test('configuration is explicit, absent leaves configuration-required, privileged or malformed configuration never transports',async()=>{
  const home=await mkdtemp(join(root,'config-'));
  const absent=mod.createDesktopAuth({configuration:null,home,projects:join(home,'projects'),coordinationRoot:join(home,'coord'),instanceId:'configuration-test'},{fetch:()=>{throw Error('must not transport');},monotonicNow:()=>0,retire:async()=>{},onState:()=>{}});
  assert.equal(absent.getPublicState().reason,'configuration-required');
  assert.equal((await absent.signIn(input)).ok,false);
  assert.equal(typeof mod.readDesktopAuthConfiguration,'function');
  assert.equal(mod.readDesktopAuthConfiguration({}),null);
  const file=join(home,'explicit.json'); await writeFile(file,JSON.stringify(configuration));
  assert.deepEqual(mod.readDesktopAuthConfiguration({ORANGE_AUTH_CONFIG_FILE:file}),configuration);
  await writeFile(file,'{bad');assert.equal(mod.readDesktopAuthConfiguration({ORANGE_AUTH_CONFIG_FILE:file}),null);
  await absent.dispose();
});

test('an installer without an environment says so; the reason stays on a whitelist',async()=>{
  const home=await mkdtemp(join(root,'config-reason-'));
  const make=(configurationReason)=>mod.createDesktopAuth({configuration:null,home,projects:join(home,'projects'),coordinationRoot:join(home,'coord'),instanceId:'reason-test',configurationReason},{fetch:()=>{throw Error('must not transport');},monotonicNow:()=>0,retire:async()=>{},onState:()=>{}});
  const incomplete=make('install-incomplete');
  assert.equal(incomplete.getPublicState().reason,'install-incomplete');
  /* the wire code of a refused sign-in does not change: only the state a person is shown does */
  assert.equal((await incomplete.signIn(input)).code,'configuration-required');
  assert.equal(make('install-conflict').getPublicState().reason,'install-conflict');
  /* a caller cannot put free text in the window: anything unrecognised is the generic development reason */
  assert.equal(make('something-a-server-said').getPublicState().reason,'configuration-required');
  assert.equal(make(undefined).getPublicState().reason,'configuration-required');
  await incomplete.dispose();
});

test('new native project ownership persists by environment subject original id and root; unknown history and another owner deny',async()=>{
  const s=await setup();await s.controller.signIn(input);
  const project={id:'原生_nonUUID-1',path:join(s.projects,'native')}; await mkdir(project.path);
  await writeFile(join(project.path,'film.html'),'original');
  assert.throws(()=>s.controller.authorizeProject(project),{code:'project-access-denied'});
  await s.controller.registerCreatedProject(project);
  assert.equal(s.controller.authorizeProject(project),true);
  assert.equal(s.controller.ownsProject(project),true);
  assert.equal(s.controller.ownsProject({...project,path:join(s.projects,'other')}),false);
  await s.controller.signOut();
  assert.equal(await readFile(join(project.path,'film.html'),'utf8'),'original');
  s.setSubject(B);await s.controller.signIn(input);
  assert.throws(()=>s.controller.authorizeProject(project),{code:'project-access-denied'});
  await s.controller.dispose();
  const reopened=mod.createDesktopAuth({configuration,home:s.home,projects:s.projects,coordinationRoot:join(s.home,'coord2'),instanceId:'new-instance'},{fetch:async(url)=>url.includes('/token?')?Response.json({access_token:'other',refresh_token:'refresh',token_type:'bearer',expires_in:60,user:{id:A}}):Response.json({id:A,is_anonymous:false}),monotonicNow:()=>20,retire:async()=>{},onState:()=>{}});
  await reopened.signIn(input);assert.equal(reopened.authorizeProject(project),true);await reopened.dispose();
});

test('logout seals synchronously, waits for entered operations and retirement, then permits a new account',async()=>{
  let release,retireStarted=false;const retirement=new Promise(r=>release=r);
  const s=await setup({retire:async()=>{retireStarted=true;await retirement;}});await s.controller.signIn(input);
  const out=s.controller.signOut();
  assert.throws(()=>s.controller.assertActive(),{code:'authentication-required'});
  assert.equal((await s.controller.signIn(input)).code,'preservation-pending');
  await Promise.resolve();assert.equal(retireStarted,true);
  release();await out;s.setSubject(B);assert.equal((await s.controller.signIn(input)).ok,true);
  await s.controller.dispose();
});

test('failed preservation locks future activation; expired authority cannot return from network failure or late login',async()=>{
  const s=await setup({retire:async()=>{throw Error('private-path must not escape');}});await s.controller.signIn(input);
  await s.controller.signOut();
  assert.equal((await s.controller.signIn(input)).code,'preservation-failed');
  assert.doesNotMatch(JSON.stringify(s.controller.getPublicState()),/private-path/);
  const e=await setup();await e.controller.signIn(input);e.setTime(60010);
  assert.equal(e.controller.getPublicState().kind,'expired');
  assert.throws(()=>e.controller.assertActive(),{code:'authentication-required'});
  await e.controller.dispose();await s.controller.dispose();
});

test('original desktop Login component renders accessible native account fields and an actionable missing configuration state',async()=>{
  const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
  let source='';try{source=await readFile(new URL('../shell/Login.tsx',import.meta.url),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  assert.ok(source.length>0,'the original desktop shell has an actual Login component');
  const ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
new Function('require','module','exports',compiled)(shimFor(require),module,module.exports);
  assert.equal(typeof module.exports.Login,'function');
  const html=renderToStaticMarkup(React.createElement(module.exports.Login,{state:{kind:'signed-out',reason:null},onSignedIn(){}}));
  assert.match(html,/type="email"/);assert.match(html,/type="password"/);assert.match(html,/autocomplete="current-password"/i);assert.match(html,/登录/);
  const missing=renderToStaticMarkup(React.createElement(module.exports.Login,{state:{kind:'signed-out',reason:'configuration-required'},onSignedIn(){}}));
  assert.match(missing,/配置/);assert.match(missing,/disabled/);
});

test('original parent quit never reports preservation on timeout before its owned utility exit',async t=>{
  const {EventEmitter}=await import('node:events');const {startWindowStudio}=await import('./studio.mjs');
  t.mock.timers.enable({apis:['setTimeout']});
  const child=new EventEmitter();child.pid=12345;let killed=0;child.kill=()=>{killed++;};child.postMessage=()=>{};
  const up=await startWindowStudio({home:'unused',port:1,env:{},log(){},onExit(){}},{takeover:async()=>{},forkStudio:async()=>({child,origin:'synthetic',filmOrigin:'synthetic-film',key:'synthetic'})});
  let settled=false;const quitting=up.quit();void quitting.then(()=>{settled=true;},()=>{settled=true;});
  t.mock.timers.tick(10000);await Promise.resolve();
  assert.equal(killed,1);assert.equal(settled,false,'kill request is not a utility exit or preservation receipt');
  child.emit('exit',1);await assert.rejects(quitting,/retire|preserv|close|exit/i);
});

test('original desktop consumes the separately built shell only in explicit isolated source development',async()=>{
  const mod=await import('./studio.mjs');assert.equal(typeof mod.windowEditorDirectory,'function');
  const build=await mkdtemp(join(root,'built-shell-'));await writeFile(join(build,'index.html'),'native shell fixture');
  assert.equal(mod.windowEditorDirectory({packaged:false,isolated:true,explicit:build,bundled:'original-shell'}),build);
  assert.equal(mod.windowEditorDirectory({packaged:true,isolated:true,explicit:build,bundled:'original-shell'}),'original-shell');
  assert.equal(mod.windowEditorDirectory({packaged:false,isolated:false,explicit:build,bundled:'original-shell'}),'original-shell');
  assert.throws(()=>mod.windowEditorDirectory({packaged:false,isolated:true,explicit:'relative',bundled:'original-shell'}),/shell|directory/i);
});

async function actualMainRetirement(directory) {
  const {EventEmitter}=await import('node:events');const {writeWindowState}=await import('./window-state.mjs');
  const {createHash}=await import('node:crypto');const source=await readFile(new URL('./main.mjs',import.meta.url),'utf8');
  const start=source.indexOf('function saveState('),end=source.indexOf('\n/** Links out of the page',start);
  assert.ok(start>=0&&end>start,'actual main saveState extraction must match');
  const matched=/onAuthRetire:\s*(async \(\) => \{[\s\S]*?\n    \}),\n    onAuthRetired:/.exec(source);
  assert.ok(matched,'actual main onAuthRetire extraction must match');
  const savedSource=source.slice(start,end),retireSource=matched[1];
  await writeFile(join(directory.endsWith('.blocked')?resolve(directory,'..'):directory,'main-functions-source.sha256'),createHash('sha256').update(savedSource+'\n'+retireSource).digest('hex'));
  const contents=new EventEmitter();let destroyed=0;contents.isDestroyed=()=>false;contents.close=()=>{destroyed++;contents.emit('destroyed');};
  const views=new Map([['project-view',{webContents:contents}]]);
  // Compile the exact production function bytes, without importing Electron or
  // substituting a rewritten retirement function. Only window/view inputs are synthetic.
  const retireAgents=async()=>{};
  let draftLocks=0;const materialDraftStore={lock(){draftLocks++;assert.equal(destroyed,0,'draft seals before views close');}};
  const create=new Function('writeWindowState','directory','views','retireAgents','materialDraftStore',`
    let win={isMaximized:()=>false,isFullScreen:()=>false,getNormalBounds:()=>({x:1,y:2,width:1000,height:700})};
    let state={},tabs={saved:()=>({tabs:[{id:'native-project'}],active:0})},accountStateDir=directory,desktopAuthActive=true,agentResourcesUsed=false;
    const HOME='home';${savedSource}\nconst retire=${retireSource};return {retire,saveState,snapshot:()=>({accountStateDir,tabs,views:views.size})};`);
  return {caller:create(writeWindowState,directory,views,retireAgents,materialDraftStore),destroyed:()=>destroyed,draftLocks:()=>draftLocks};
}

for(const failure of ['mkdir','rename'])test(`actual main account retirement refuses ${failure} failure before destroying its existing views`,async()=>{
  const directory=await mkdtemp(join(root,'main-save-'));
  let target=directory;
  if(failure==='mkdir'){target=join(directory,'state.blocked');await writeFile(target,'keep original bytes');}
  else await mkdir(join(directory,'window.json'));
  const test=await actualMainRetirement(target);
  assert.doesNotThrow(()=>test.caller.saveState(),'ordinary non-retirement save compatibility remains best effort');
  assert.doesNotThrow(()=>test.caller.saveState({syntheticWindowEvent:true}),'ordinary window event arguments cannot enable strict retirement mode');
  assert.equal(await test.caller.retire(),false,'unpreserved native state must not authorize retirement');
  assert.equal(test.destroyed(),0);assert.equal(test.caller.snapshot().accountStateDir,target);assert.equal(test.caller.snapshot().views,1);assert.ok(test.caller.snapshot().tabs);
});

test('actual main account retirement succeeds only after its real window state is written',async()=>{
 const directory=await mkdtemp(join(root,'main-save-ok-'));const test=await actualMainRetirement(directory);
 assert.equal(await test.caller.retire(),true);assert.equal(test.draftLocks(),1);assert.equal(test.destroyed(),1);assert.equal(test.caller.snapshot().accountStateDir,null);
 assert.equal(JSON.parse(await readFile(join(directory,'window.json'),'utf8')).tabs.tabs[0].id,'native-project');
});

test('controller completion notification waits for actual operations and guard release, not merely retire callback',async()=>{
 let release,entered;const hold=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);const events=[];
 const s=await setup({retire:async()=>{events.push('studio-closed');},dependencies:{onRetired:()=>events.push('confirmed')}});await s.controller.signIn(input);
 const work=s.controller.runNative(async()=>{events.push('entered');entered();await hold;events.push('operation-closed');});await ready;
 const out=s.controller.signOut();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['entered','studio-closed']);
 release();await work;await out;
 assert.deepEqual(events,['entered','studio-closed','operation-closed','confirmed']);
 const registry=JSON.parse(await readFile(join(s.home,'coord','registry.json'),'utf8'));assert.equal(registry.reservations.length,0);
 await s.controller.dispose();
});

test('real guard release lock failure never emits retirement success and leaves account switch locked',async()=>{
 const events=[];const s=await setup({dependencies:{onRetired:()=>events.push('confirmed')}});await s.controller.signIn(input);
 /* A lock is held by a live pid now (project-control-guard.mjs reclaims one whose holder is gone): this process is the
    holder, so the release really is refused and nothing is destroyed. Text without a pid would be reclaimed as
    abandoned and the retirement would go through, which is not the case under test. */
 await writeFile(join(s.home,'coord','meta.lock'),String(process.pid),{flag:'wx'});
 await s.controller.signOut();assert.deepEqual(events,[]);assert.equal(s.controller.getPublicState().reason,'preservation-failed');
 assert.equal((await s.controller.signIn(input)).code,'preservation-failed');assert.equal(await readFile(join(s.home,'coord','meta.lock'),'utf8'),String(process.pid));
 await s.controller.dispose();assert.deepEqual(events,[]);
});

/* A sign-in whose controlled reservation cannot be taken (here: another Studio on the same machine already holds an
   overlapping one) still opens the projects of this device, and changes nothing: the folder is the device's work. */
async function degradedPair(environmentId) {
  const base=await mkdtemp(join(root,'degraded-'));
  const home=join(base,'home'),library=join(base,'library');
  await mkdir(home);await mkdir(library);
  const saved={ORANGE_HOME:process.env.ORANGE_HOME,ORANGE_SHARED_HOME:process.env.ORANGE_SHARED_HOME,ORANGE_LIBRARY:process.env.ORANGE_LIBRARY};
  Object.assign(process.env,{ORANGE_HOME:home,ORANGE_SHARED_HOME:home,ORANGE_LIBRARY:library});
  const calls=[];let now=10,subject=A;
  const fetch=async(url,request)=>{
    calls.push({url,method:request.method});
    if(url.endsWith('/auth/v1/token?grant_type=password'))return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',token_type:'bearer',expires_in:60,user:{id:subject}});
    if(url.endsWith('/auth/v1/user'))return Response.json({id:subject,is_anonymous:false});
    throw Error('unexpected endpoint');
  };
  const controller=instanceId=>mod.createDesktopAuth({configuration:{...configuration,environmentId},home,sharedHome:home,projects:library,coordinationRoot:join(base,'coord'),instanceId},{fetch,monotonicNow:()=>now,retire:async()=>{},onState:()=>{}});
  return {base,home,library,controller,restore:()=>{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}};
}

test('a sign-in without its reservation lists and opens this device\'s projects, and every change stays refused',async()=>{
  const f=await degradedPair('degraded-device');
  try {
    const resident=f.controller('resident-instance');
    assert.equal((await resident.signIn(input)).ok,true);
    const created=await resident.runNative(()=>createProject('P08 素材验证'));
    assert.equal(created.name,'P08 素材验证');
    /* the same machine's second Studio: its reservation overlaps the resident one, so it signs in without a lease */
    const degraded=f.controller('degraded-instance');
    const signed=await degraded.signIn(input);
    assert.equal(signed.ok,true,'a degraded sign-in is still a sign-in');
    assert.equal(degraded.getPublicState().kind,'active');
    /* 200: the projects of this device are listed without an owner record and without a reservation */
    const listed=await degraded.runNative(()=>listProjects());
    assert.deepEqual(listed.map(project=>project.name),['P08 素材验证']);
    assert.equal(listed[0].id,created.id);
    assert.equal((await degraded.runNative(()=>projectById(created.id))).path,created.path,'and each of them opens');
    /* a change is a lease holder's: no reservation, no new project, nothing written */
    await assert.rejects(degraded.runNative(()=>createProject('denied without a lease')),{code:'control-required',status:403});
    assert.equal(listed.some(project=>project.name==='denied without a lease'),false);
    assert.equal(existsSync(join(f.library,'denied without a lease')),false);
    /* a path outside this device is still the account's to prove */
    const outside=join(f.base,'elsewhere');await mkdir(outside);await writeFile(join(outside,'film.html'),'synthetic');
    await assert.rejects(degraded.runNative(()=>openProject(outside)),{code:'project-access-denied',status:403});
    assert.equal(existsSync(join(outside,'.film')),false,'a refused path is not given a project');
    /* no registry record was written for the read: the resident Studio still holds the only reservation */
    const registry=JSON.parse(await readFile(join(f.base,'coord','registry.json'),'utf8'));
    assert.equal(registry.readers.length,0);assert.equal(registry.reservations.length,1);
    await degraded.dispose();await resident.dispose();
  } finally { f.restore(); }
});

/* 2026-11-26: the session outlives the process. A sign-in seals the rotating refresh token under the home; the next
   controller exchanges it at start-up and is active without a password — activated exactly as a sign-in is. */
test('a sealed session resumes at the next start, and signing out forgets it', async () => {
  const s = await setup();
  assert.equal((await s.controller.signIn(input)).ok, true);
  const sealed = join(s.home, 'session', 'refresh.bin');
  assert.ok(existsSync(sealed), 'the refresh token is sealed under the home');
  assert.equal((readFileSync(sealed, 'utf8')).includes('synthetic-refresh'), true, 'the fixture seals its own token');
  await s.controller.dispose();

  /* the next start: same home, a fresh controller, a fetch that only answers a refresh exchange */
  const resumed = mod.createDesktopAuth({configuration, home: s.home, projects: s.projects, coordinationRoot: join(s.home, 'coord2'), instanceId: 'next-instance'}, {
    fetch: async (url) => {
      if (url.endsWith('/auth/v1/token?grant_type=refresh_token')) return Response.json({access_token: 'next-access', refresh_token: 'next-refresh', token_type: 'bearer', expires_in: 60, user: {id: A}});
      if (url.endsWith('/auth/v1/user')) return Response.json({id: A, is_anonymous: false});
      throw Error('unexpected endpoint');
    },
    monotonicNow: () => 30, retire: async () => {}, onState: () => {},
  });
  const restored = await resumed.restore();
  assert.equal(restored.ok, true, 'the sealed session resumes');
  assert.equal(resumed.getPublicState().kind, 'active');
  /* the restored session holds the project authority a signed-in one holds: it can take a project into its care */
  const project = { id: 'resumed-project-1', path: join(s.projects, 'resumed') };
  await mkdir(project.path, { recursive: true });
  await writeFile(join(project.path, 'film.html'), '{"stage":{"w":1920,"h":1080},"tracks":[]}');
  await resumed.registerCreatedProject(project);
  assert.equal(resumed.authorizeProject(project), true, 'the restored session owns what it registers');
  await resumed.dispose();

  /* a controller that signs out leaves nothing for the next start */
  const s2 = await setup();
  assert.equal((await s2.controller.signIn(input)).ok, true);
  assert.ok(existsSync(join(s2.home, 'session', 'refresh.bin')));
  await s2.controller.signOut();
  assert.equal(existsSync(join(s2.home, 'session', 'refresh.bin')), false, 'signing out forgets the sealed session');
  await s2.controller.dispose();
});

test('a sealed session the upstream refuses is forgotten, and an unreadable one never throws', async () => {
  const s = await setup();
  assert.equal((await s.controller.signIn(input)).ok, true);
  await s.controller.dispose();
  const refused = mod.createDesktopAuth({configuration, home: s.home, projects: s.projects, coordinationRoot: join(s.home, 'coord3'), instanceId: 'refused-instance'}, {
    fetch: async () => Response.json({error_code: 'refresh_token_not_found'}, {status: 400}),
    monotonicNow: () => 40, retire: async () => {}, onState: () => {},
  });
  const result = await refused.restore();
  assert.equal(result.ok, false);
  assert.equal(refused.getPublicState().kind, 'signed-out', 'a refused token is a signed-out start, not a half state');
  assert.equal(existsSync(join(s.home, 'session', 'refresh.bin')), false, 'the refused token is forgotten');
  await refused.dispose();

  /* a blob that is not ours: signed out, no throw */
  const home = await mkdtemp(join(root, 'corrupt-'));
  const projects = join(home, 'projects'); await mkdir(projects);
  mkdirSync(join(home, 'session'), {recursive: true});
  writeFileSync(join(home, 'session', 'refresh.bin'), 'garbage-not-a-sealed-record');
  const corrupt = mod.createDesktopAuth({configuration, home, projects, coordinationRoot: join(home, 'coord'), instanceId: 'corrupt-instance'}, {
    fetch: () => { throw Error('must not transport for an unreadable blob'); }, monotonicNow: () => 50, retire: async () => {}, onState: () => {},
  });
  assert.equal((await corrupt.restore()).ok, false);
  assert.equal(corrupt.getPublicState().kind, 'signed-out');
  await corrupt.dispose();
});

/* 2026-11-26: an hour-long access token would sign the app out mid-day; the app renews it a minute at a time, and only
   ever for the same person. */
test('a session near its deadline is renewed in place, and the rotated token is what stays sealed', async () => {
  const home = await mkdtemp(join(root, 'renew-'));
  const projects = join(home, 'projects'); await mkdir(projects);
  let now = 10;
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/auth/v1/token?grant_type=password')) return Response.json({access_token:'first',refresh_token:'first-refresh',token_type:'bearer',expires_in:3600,user:{id:A}});
    if (url.endsWith('/auth/v1/token?grant_type=refresh_token')) return Response.json({access_token:'second',refresh_token:'second-refresh',token_type:'bearer',expires_in:3600,user:{id:A}});
    if (url.endsWith('/auth/v1/user')) return Response.json({id:A,is_anonymous:false});
    throw Error('unexpected endpoint');
  };
  const controller = mod.createDesktopAuth({configuration, home, projects, coordinationRoot: join(home,'coord'), instanceId:'renew-instance'}, {fetch, monotonicNow: () => now, retire: async () => {}, onState: () => {}});
  assert.equal((await controller.signIn(input)).ok, true);
  assert.equal((await controller.renewIfNeeded()).code, 'not-yet', 'a fresh session is left alone');

  now = 3600_000 - 60_000;           /* one minute of the hour left: inside the five-minute window */
  const renewed = await controller.renewIfNeeded();
  assert.equal(renewed.ok, true);
  assert.equal(renewed.state.kind, 'active');
  assert.equal(controller.assertActive().subjectId, A, 'the same person');
  assert.equal(readFileSync(join(home,'session','refresh.bin'),'utf8').includes('second-refresh'), true, 'the rotated token is sealed');
  assert.equal(calls.filter((u) => u.endsWith('grant_type=refresh_token')).length, 1);
  await controller.dispose();
});

test('a renewal the upstream refuses forgets the token instead of pretending to be signed in', async () => {
  const home = await mkdtemp(join(root, 'renew-no-'));
  const projects = join(home, 'projects'); await mkdir(projects);
  let now = 10, refuse = false;
  const fetch = async (url) => {
    if (url.endsWith('grant_type=password')) return Response.json({access_token:'first',refresh_token:'first-refresh',token_type:'bearer',expires_in:3600,user:{id:A}});
    if (url.endsWith('grant_type=refresh_token')) return refuse ? Response.json({error_code:'refresh_token_not_found'}, {status:400}) : Response.json({access_token:'second',refresh_token:'second-refresh',token_type:'bearer',expires_in:3600,user:{id:A}});
    return Response.json({id:A,is_anonymous:false});
  };
  const controller = mod.createDesktopAuth({configuration, home, projects, coordinationRoot: join(home,'coord'), instanceId:'renew-refused'}, {fetch, monotonicNow: () => now, retire: async () => {}, onState: () => {}});
  assert.equal((await controller.signIn(input)).ok, true);
  refuse = true;
  now = 3600_000 - 60_000;
  const refused = await controller.renewIfNeeded();
  assert.equal(refused.ok, false);
  await controller.dispose();
});