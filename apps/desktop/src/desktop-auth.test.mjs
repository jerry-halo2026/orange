import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = process.env.ORANGE_LOGIN_TEST_ROOT;
assert.ok(root && resolve(root) === root, 'an explicit owned test root is required');
await mkdir(root, { recursive: true });
const mod = await import('./desktop-auth.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
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
  const module={exports:{}};new Function('require','module','exports',compiled)(require,module,module.exports);
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
  const create=new Function('writeWindowState','directory','views',`
    let win={isMaximized:()=>false,isFullScreen:()=>false,getNormalBounds:()=>({x:1,y:2,width:1000,height:700})};
    let state={},tabs={saved:()=>({tabs:[{id:'native-project'}],active:0})},accountStateDir=directory,desktopAuthActive=true,agentResourcesUsed=false;
    const HOME='home';${savedSource}\nconst retire=${retireSource};return {retire,saveState,snapshot:()=>({accountStateDir,tabs,views:views.size})};`);
  return {caller:create(writeWindowState,directory,views),destroyed:()=>destroyed};
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
 assert.equal(await test.caller.retire(),true);assert.equal(test.destroyed(),1);assert.equal(test.caller.snapshot().accountStateDir,null);
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
 await writeFile(join(s.home,'coord','meta.lock'),'synthetic foreign holder preserved',{flag:'wx'});
 await s.controller.signOut();assert.deepEqual(events,[]);assert.equal(s.controller.getPublicState().reason,'preservation-failed');
 assert.equal((await s.controller.signIn(input)).code,'preservation-failed');assert.equal(await readFile(join(s.home,'coord','meta.lock'),'utf8'),'synthetic foreign holder preserved');
 await s.controller.dispose();assert.deepEqual(events,[]);
});

test('private system selection scopes cannot be forged, reused, or transferred to the next epoch',async()=>{
  const s=await setup();await s.controller.signIn(input);
  const external=await mkdtemp(join(root,'ordinary-source-'));const file=join(external,'source.txt');await writeFile(file,'synthetic source');
  const {assertSourceAccess}=await import('../../../packages/openfilm/src/media-links.mjs');
  await assert.rejects(s.controller.runNative(()=>assertSourceAccess(file,'copy')),{code:'source-selection-required'});
  assert.throws(()=>s.controller.completeSourceSelection({},[file]),{code:'source-access-denied'});
  const scope=s.controller.beginSourceSelection();assert.deepEqual(s.controller.completeSourceSelection(scope,[file]),[file]);
  assert.throws(()=>s.controller.completeSourceSelection(scope,[file]),{code:'source-access-denied'});
  const ticket=await s.controller.runNative(()=>assertSourceAccess(file,'copy'));assert.equal(ticket.path,file);
  const late=s.controller.beginSourceSelection();await s.controller.signOut();s.setSubject(B);await s.controller.signIn(input);
  assert.throws(()=>s.controller.completeSourceSelection(late,[file]),{code:'source-access-denied'});
  assert.throws(()=>ticket.recheck(),{code:'source-access-denied'});
  await assert.rejects(s.controller.runNative(()=>assertSourceAccess(file,'copy')),{code:'source-selection-required'});
  await s.controller.dispose();
});

test('expiry retires private source selection without granting ownership or exposing source state',async()=>{
  const s=await setup();await s.controller.signIn(input);
  const directory=await mkdtemp(join(root,'expiry-source-'));const file=join(directory,'source.txt');await writeFile(file,'synthetic');
  const scope=s.controller.beginSourceSelection();s.setTime(60010);
  assert.throws(()=>s.controller.completeSourceSelection(scope,[file]),{code:'authentication-required'});
  assert.doesNotMatch(JSON.stringify(s.controller.getPublicState()),/expiry-source|synthetic-access|subjectId|epoch/);
  await s.controller.dispose();
});