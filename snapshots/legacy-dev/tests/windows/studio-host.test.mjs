import assert from 'node:assert/strict';
import { test } from 'node:test';
const host = await import('../../apps/desktop/main/studio-host.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('studio-host.ts')) return {};
  throw error;
});
function fixture() {
  assert.equal(typeof host.createStudioController, 'function', 'ordinary authorized Studio lifecycle is absent');
  let signedIn = true;
  let notify;
  const mounts = [];
  const auth = { getState: () => ({kind: signedIn ? 'signed-in' : 'signed-out'}), subscribe: fn => { notify = fn; return () => {}; } };
  const control = host.createStudioController(auth, (authorized, failed) => new Promise((resolve, reject) => mounts.push({authorized, failed, resolve, reject})));
  return { control, mounts, revoke() { signedIn = false; notify({kind:'signed-out'}); } };
}
function instance() { return { closed: 0, close() { this.closed++; return Promise.resolve(); } }; }
test('ordinary Studio open coalesces and exposes only finite state', async () => {
  const f = fixture();
  assert.deepEqual(f.control.getState(), {kind:'closed',error:null});
  const one = f.control.open(); const two = f.control.open();
  assert.equal(one, two); assert.equal(f.mounts.length, 1);
  assert.deepEqual(f.control.getState(), {kind:'opening',error:null});
  f.mounts[0].resolve(instance());
  assert.deepEqual(await one, {kind:'open',error:null});
  await f.control.open(); assert.equal(f.mounts.length, 1);
});
for (const reason of ['close', 'revoke', 'dispose']) test(reason + ' while mounting never resurrects late view', async () => {
  const f = fixture(); const pending = f.control.open(); const m = f.mounts[0];
  if (reason === 'revoke') f.revoke(); else await f.control[reason]();
  assert.equal(m.authorized(), false);
  const view = instance(); m.resolve(view); await pending;
  assert.equal(view.closed, 1); assert.equal(f.control.getState().kind, 'closed');
});
test('old failure callback cannot close a newer authorized generation', async () => {
  const f = fixture(); const first = f.control.open(); const old = f.mounts[0];
  await f.control.close(); const second = f.control.open(); const current = f.mounts[1];
  current.resolve(instance()); await second;
  old.failed(); old.resolve(instance()); await first;
  assert.equal(f.control.getState().kind, 'open');
  current.failed(); assert.deepEqual(f.control.getState(), {kind:'closed',error:'failed'});
});
test('signout closes mounted resources synchronously and denies future open', async () => {
  const f = fixture(); const pending = f.control.open(); const view = instance();
  f.mounts[0].resolve(view); await pending; f.revoke();
  assert.equal(view.closed, 1);
  assert.deepEqual(await f.control.open(), {kind:'closed',error:'auth-required'});
  assert.equal(f.mounts.length, 1);
});
test('mount exceptions expose a finite error and permit a clean retry', async () => {
  const f = fixture(); const first = f.control.open(); f.mounts[0].reject(Error('secret native path'));
  assert.deepEqual(await first, {kind:'closed',error:'failed'});
  const next = f.control.open(); f.mounts[1].resolve(instance());
  assert.equal((await next).kind, 'open');
});
test('native bounds reserve 128 DIP and reject unusable sizes', () => {
  assert.equal(typeof host.studioBounds, 'function', 'trusted shell band is absent');
  assert.deepEqual(host.studioBounds({width:1100,height:760}), {x:0,y:128,width:1100,height:632});
  for (const bounds of [{width:0,height:760},{width:1100,height:128},{width:1100,height:50}]) assert.equal(host.studioBounds(bounds), null);
});
test('preview roles require actual direct-child ancestry, origin and resource type', () => {
  assert.equal(typeof host.studioRequestAllowed, 'function', 'native preview role filter is absent');
  const main = {processId:1,routingId:1,url:'http://127.0.0.1:1/'};
  const child = {processId:2,routingId:2,parent:main,url:'http://127.0.0.1:2/film.html?load=1'};
  const transport = {studioOrigin:'http://127.0.0.1:1',previewOrigin:'http://127.0.0.1:2',route(url) {
    if (url.includes('film-host=0')) return 'preview-film';
    if (url.includes('__film/')) return 'preview-runtime';
    if (url.includes('.svg')) return 'preview-asset';
    if (url.includes('/film.html')) return 'preview';
    return 'api';
  }};
  const permit = (request, authorized=true) => host.studioRequestAllowed(request, {transport,main,webContentsId:10,bootstrap:false,authorized});
  const request = {url:transport.previewOrigin+'/film.html?load=1&film-host=0',method:'GET',resourceType:'xhr',initiatorOrigin:transport.previewOrigin,frame:child,webContentsId:10};
  assert.equal(permit(request), true);
  for (const delta of [{frame:main},{frame:{...child,parent:child}},{initiatorOrigin:transport.studioOrigin},{resourceType:'subFrame'},{webContentsId:11}]) assert.equal(permit({...request,...delta}), false);
  assert.equal(permit(request,false), false);
  assert.equal(permit({...request,url:transport.previewOrigin+'/__film/timeline.mjs',resourceType:'script'}), true);
  assert.equal(permit({...request,url:transport.previewOrigin+'/card-a.svg',resourceType:'image'}), true);
  assert.equal(permit({...request,url:transport.previewOrigin+'/card-a.svg',resourceType:'xhr',method:'HEAD'}), true);
  assert.equal(permit({...request,url:transport.previewOrigin+'/card-a.svg',resourceType:'mainFrame'}), false);
  assert.equal(permit({...request,url:transport.studioOrigin+'/api/projects',resourceType:'xhr'}), false);
});

test('ordinary main binds experience runtime, guarded native bounds and shared Auth before shell load', async () => {
  const {readFile}=await import('node:fs/promises');
  const source=await readFile(new URL('../../apps/desktop/main/index.ts',import.meta.url),'utf8');
  assert.match(source,/startStudioExperience\(/,'product main still lacks real experience');
  assert.match(source,/installStudioIpc\(window, renderer, studio\)/);
  assert.match(source,/const auth = installAuthIpc\(window, renderer\)/);
  assert.match(source,/studioBounds\(window.getContentBounds\(\)\)/);
  assert.match(source,/studioRequestAllowed\(/);
  assert.match(source,/__ORANGE_STUDIO_RECEIPT_SHA256__/);
});

test('build binds five exact Git blobs in memory with a closed pure import map', async () => {
  const {registerHooks}=await import('node:module');
  registerHooks({resolve(specifier,context,next){return specifier==='vite'?{url:'data:text/javascript,export const defineConfig=x=>x;export const version="8.3.6";',shortCircuit:true}:next(specifier,context);}});
  const build=await import('../../apps/desktop/vite.config.ts');
  assert.equal(typeof build.studioExperienceBinding,'function','main lacks verified original runtime binding');
  const {plugin,ledger}=build.studioExperienceBinding();
  assert.equal(ledger.sourcePin,'2e18a4bdf54647b2ece3c0975a6f9573720c7821');
  assert.equal(ledger.files.length,5);
  assert.equal(ledger.files.reduce((sum,file)=>sum+file.bytes,0),165555);
  const binding=plugin.resolveId('virtual:orange-studio-experience');
  const code=plugin.load(binding);
  assert.match(code,/Object.freeze/);
  assert.match(code,/timelineMjs/);
  const ops=plugin.resolveId('orange-experience:ops',binding);
  const doc=plugin.resolveId('../../src/film-doc.mjs',ops);
  assert.match(plugin.load(ops),/export function applyOps/);
  assert.match(plugin.load(doc),/export function readFilm/);
  const blob = text => 'data:text/javascript;base64,'+Buffer.from(text).toString('base64');
  const docUrl = blob(plugin.load(doc));
  const opsUrl = blob(plugin.load(ops).replace("'../../src/film-doc.mjs'",JSON.stringify(docUrl)));
  const runtime = (await import(blob(code.replace('"orange-experience:film-doc"',JSON.stringify(docUrl)).replace('"orange-experience:ops"',JSON.stringify(opsUrl))))).default;
  assert.equal(Object.isFrozen(runtime),true);
  assert.equal(Object.isFrozen(runtime.browser),true);
  assert.equal(typeof runtime.pure.readFilm,'function');
  assert.equal(typeof runtime.pure.filmHtml,'function');
  assert.equal(typeof runtime.pure.applyOps,'function');
  assert.throws(()=>plugin.resolveId('node:fs',ops),/unexpected pure import/);
  assert.throws(()=>plugin.resolveId('../host.mjs',doc),/unexpected pure import/);
});

test('synchronous factory failure cannot leave a stale coalesced opening promise', async () => {
  let count=0;
  const auth={getState:()=>({kind:'signed-in'}),subscribe:()=>()=>{}};
  const controller=host.createStudioController(auth,async (_authorized,failed)=>{
    count++;
    if(count===1) failed();
    return instance();
  });
  assert.deepEqual(await controller.open(),{kind:'closed',error:'failed'});
  assert.deepEqual(await controller.open(),{kind:'open',error:null});
  assert.equal(count,2);
});

test('closing a mounting generation synchronously revokes its registered native resources', async () => {
  let finish; let revoked=false;
  const auth={getState:()=>({kind:'signed-in'}),subscribe:()=>()=>{}};
  const controller=host.createStudioController(auth,(_authorized,_failed,onInvalidate)=>new Promise(resolve=>{
    finish=resolve;
    assert.equal(typeof onInvalidate,'function','pending native mount has no immediate invalidation port');
    onInvalidate(()=>{revoked=true;});
  }));
  const pending=controller.open();
  const closing=controller.close();
  assert.equal(revoked,true,'view/token/sockets must revoke before waiting for loadURL');
  finish(instance()); await pending; await closing;
});

async function actualMainScenario(scenario = 'ordinary') {
  const {registerHooks}=await import('node:module');
  const {EventEmitter}=await import('node:events');
  const {mkdir,rm}=await import('node:fs/promises');
  const {fileURLToPath}=await import('node:url');
  const temp=fileURLToPath(new URL('../../.orange-local/task-2-native-test-'+scenario+'/',import.meta.url));
  await mkdir(temp,{recursive:true});
  const paths={}; const windows=[]; const views=[]; const transports=[]; const handlers=new Map();
  let loadDone; let startDone; let deferred=true;
  const starting=new Promise(resolve=>{startDone=resolve;});
  const loading=new Promise(resolve=>{loadDone=resolve;});
  const partition=()=>({webRequest:{onBeforeRequest(fn){this.request=fn;},onBeforeSendHeaders(fn){this.headers=fn;}},setPermissionCheckHandler(){},setPermissionRequestHandler(){},setDevicePermissionHandler(){},setDisplayMediaRequestHandler(){}});
  class Contents extends EventEmitter {
    constructor(){super();this.id=10+views.length;this.mainFrame={processId:1,routingId:this.id,url:'about:blank'};this.session=partition();this.closed=false;}
    setWindowOpenHandler(){}
    isDestroyed(){return this.closed;}
    close(){this.closed=true;this.emit('destroyed');}
    loadURL(url){this.mainFrame.url=url;return deferred?loading:Promise.resolve();}
  }
  class Window extends EventEmitter {
    constructor(){super();this.webContents=new Contents();this.children=[];this.bounds={width:1100,height:760};this.contentView={addChildView:view=>this.children.push(view),removeChildView:view=>{this.children=this.children.filter(x=>x!==view);}};windows.push(this);}
    isDestroyed(){return false;}
    getContentBounds(){return this.bounds;}
    loadURL(url){this.webContents.mainFrame.url=url;this.webContents.emit('did-navigate',{},url,-1,'');return Promise.resolve();}
    show(){this.visible=true;}
    isVisible(){return !!this.visible;}
  }
  class View {
    constructor(options){this.options=options;this.webContents=new Contents();views.push(this);}
    setBounds(bounds){this.bounds=bounds;}
  }
  const app=new EventEmitter();
  Object.assign(app,{setPath:(key,value)=>{paths[key]=value;},getPath:key=>paths[key],setAppLogsPath(){},whenReady:()=>Promise.resolve(),quit(){},exit(code){throw Error('unexpected main exit '+code);}});
  const {createDesktopAuth}=await import('../../apps/desktop/main/auth.ts');
  const creds={email:'test@example.invalid',password:'native-test-only'};
  const auth=createDesktopAuth({origin:'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',publishableKey:'sb_publishable_fixture_only_1234567'},async url=>url.includes('/token?')
    ? Response.json({access_token:'task2-native-fixture-token',expires_in:3600})
    : Response.json({id:'39c4c4ae-5e7f-46f3-91e0-6cd246c86d2a',is_anonymous:false}));
  assert.equal((await auth.signIn(creds)).state.kind,'signed-in');
  globalThis.__task2Native={
    electron:{app,BrowserWindow:Window,WebContentsView:View,session:{fromPartition:()=>partition()},ipcMain:{handle:(channel,fn)=>handlers.set(channel,fn),removeHandler:channel=>handlers.delete(channel)}},
    auth,temp,
    start:async (directory,digest,authorized,onFailure,runtime)=>{
      const transport={directory,digest,authorized,onFailure,runtime,studioOrigin:'http://127.0.0.1:11001',previewOrigin:'http://127.0.0.1:11002',closed:false,
        route(url){return url===this.studioOrigin+'/projects/local-experience'?'document':undefined;},
        requestHeaders(headers,allow){return allow?{...headers,'x-test-native':'main-only'}:headers;},
        close(){this.closed=true;return Promise.resolve();}};
      transports.push(transport);
      if(scenario.endsWith('-starting')) await starting;
      return transport;
    },
  };
  globalThis.__ORANGE_STUDIO_RECEIPT_SHA256__='a'.repeat(64);
  const data=code=>'data:text/javascript,'+encodeURIComponent(code)+'#task2-'+scenario;
  const hooks=registerHooks({resolve(specifier,context,next){
    if(specifier==='./studio-ipc.ts' && context.parentURL?.split('?')[0].endsWith('/main/index.ts')) return next(specifier+'?task2='+scenario,context);
    if(specifier==='electron') return {url:data('export const {app,BrowserWindow,WebContentsView,session,ipcMain}=globalThis.__task2Native.electron;'),shortCircuit:true};
    if(specifier==='@orange/film-adapter/node') return {url:data('export const startStudioExperience=globalThis.__task2Native.start;export function startStudioFixture(){throw Error("smoke path used")}'),shortCircuit:true};
    if(specifier==='virtual:orange-studio-experience') return {url:data('export default Object.freeze({fixture:"native-lifecycle-only"});'),shortCircuit:true};
    if(specifier==='node:os') return {url:data('export const tmpdir=()=>globalThis.__task2Native.temp;'),shortCircuit:true};
    if(specifier==='@orange/contracts') return {url:data('export function encodeStartupFrame(){};export function projectStartupFailure(){};'),shortCircuit:true};
    if(specifier==='./auth-ipc.ts'&&context.parentURL?.split('?')[0].endsWith('/main/index.ts')) return next(specifier+'?task2='+scenario,context);
    // Keep the real installer/handlers and sole real Auth service; only bind its
    // constructor dependency to the already verified local provider fixture.
    if(specifier==='./auth.ts'&&context.parentURL?.split('?')[0].endsWith('/main/auth-ipc.ts')) return {url:data('export const createDesktopAuth=()=>globalThis.__task2Native.auth;export const readSupabaseConfig=()=>null;'),shortCircuit:true};
    return next(specifier,context);
  }});
  try {
    await import(new URL('../../apps/desktop/main/index.ts',import.meta.url).href+'?task2='+scenario);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(windows.length,1);
    const window=windows[0];
    const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};
    const trustedUrl=window.webContents.mainFrame.url;
    if(scenario.startsWith('routes-')) {
      for(const suffix of ['', '#/workspace', '#/studio']) {
        const url=trustedUrl+suffix;
        window.webContents.mainFrame.url=url;
        window.webContents.emit('did-navigate-in-page',{},url,true,1,window.webContents.id);
        assert.equal(auth.getState().kind,'signed-in','approved same-document shell route must preserve verified Auth');
        assert.deepEqual(await handlers.get('orange:auth:state')(event),{kind:'signed-in'});
        assert.equal((await handlers.get('orange:auth:sign-in')(event,creds)).error,'busy');
      }
    }
    const pending=handlers.get('orange:studio:open')(event);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(views.length,scenario.endsWith('-starting')?0:1);assert.equal(windows.length,1);
    if(views.length) {
    assert.deepEqual(views[0].bounds,{x:0,y:128,width:1100,height:632});
    assert.equal(views[0].options.webPreferences.sandbox,true);
    assert.equal(Object.hasOwn(views[0].options.webPreferences,'preload'),false);
    assert.equal(views[0].webContents.mainFrame.url,transports[0].studioOrigin+'/projects/local-experience');
    }
    if(scenario !== 'ordinary') {
      if(scenario.endsWith('-open')) { loadDone();await pending;deferred=false; }
      if(scenario.startsWith('routes-')) {
        for(const suffix of ['', '#/workspace', '#/studio']) {
          const url=trustedUrl+suffix;
          window.webContents.mainFrame.url=url;
          window.webContents.emit('did-navigate-in-page',{},url,true,1,window.webContents.id);
          assert.equal(auth.getState().kind,'signed-in');
          assert.equal(transports[0].authorized(),true);
          assert.equal(transports[0].closed,false);
          assert.equal((await handlers.get('orange:studio:state')(event)).kind,scenario.endsWith('-pending')?'opening':'open');
        }
        loadDone();await pending;deferred=false;
        for(const suffix of ['', '#/workspace', '#/studio']) {
          const url=trustedUrl+suffix;
          window.webContents.mainFrame.url=url;
          window.webContents.emit('did-navigate-in-page',{},url,true,1,window.webContents.id);
          assert.equal((await handlers.get('orange:studio:state')(event)).kind,'open');
          assert.deepEqual(await handlers.get('orange:studio:close')(event),{kind:'closed',error:null});
          assert.equal(auth.getState().kind,'signed-in');
          assert.deepEqual(await handlers.get('orange:studio:open')(event),{kind:'open',error:null});
        }
        await handlers.get('orange:auth:sign-out')(event);
        for(const suffix of ['', '#/workspace', '#/studio']) {
          const url=trustedUrl+suffix;
          window.webContents.mainFrame.url=url;
          window.webContents.emit('did-navigate-in-page',{},url,true,1,window.webContents.id);
          assert.equal(auth.getState().kind,'signed-out','route identity cannot grant Auth');
          assert.deepEqual(await handlers.get('orange:studio:open')(event),{kind:'closed',error:'auth-required'});
        }
        assert.equal((await handlers.get('orange:auth:sign-in')(event,creds)).state.kind,'signed-in','legitimate routes must not permanently dispose Auth');
        assert.equal((await handlers.get('orange:studio:open')(event)).kind,'open');
        window.emit('closed');
        return;
      }
      if(scenario==='child-inpage-open') {
        window.webContents.emit('did-navigate-in-page',{},'https://foreign.invalid/',false,2,99);
        assert.equal(auth.getState().kind,'signed-in','a child in-page event does not change trusted main document');
        assert.equal(transports[0].authorized(),true);
        assert.equal(transports[0].closed,false);
        await handlers.get('orange:studio:close')(event);
        window.emit('closed');
        return;
      }
      const before=transports.length;
      if(scenario.startsWith('crash-')) window.webContents.emit('render-process-gone',{}, {reason:'crashed',exitCode:1});
      else if(scenario.startsWith('destruction-')) window.webContents.close();
      else if(scenario.startsWith('navigation-') || scenario.startsWith('redirect-') || scenario.startsWith('full-trusted-') || scenario.startsWith('child-full-')) {
        let prevented=false;
        const navigation={isMainFrame:!scenario.startsWith('child-full-'),isSameDocument:false,url:scenario.includes('trusted')?trustedUrl+'#/workspace':'https://foreign.invalid/',preventDefault(){prevented=true;}};
        window.webContents.emit(scenario.startsWith('redirect-')?'will-redirect':'will-frame-navigate',navigation);
        assert.equal(prevented,true,'shell navigation must remain prevented');
      } else {
        const invalid={
          'hash-rejected-open':trustedUrl+'#/other',
          'query-rejected-open':trustedUrl+'?x=1#/studio',
          'encoded-rejected-open':trustedUrl+'#/%73tudio',
          'case-rejected-open':trustedUrl.replace('renderer','RENDERER')+'#/studio',
          'path-rejected-open':trustedUrl.replace('/index.html','/./index.html')+'#/studio',
          'foreign-rejected-open':trustedUrl.replace('/renderer/','/foreign/')+'#/studio',
          'committed-trusted-open':trustedUrl,
        }[scenario]??'https://foreign.invalid/';
        window.webContents.mainFrame.url=invalid;
        const inPage=scenario.startsWith('in-page-')||scenario.includes('-rejected-');
        window.webContents.emit(inPage?'did-navigate-in-page':'did-navigate',{},invalid,true,1,window.webContents.id);
      }
      console.log('SHELL_TRUST_LOST',JSON.stringify({scenario,transportClosed:transports[0].closed,transportStillAuthorized:transports[0].authorized(),viewClosed:views[0]?.webContents.closed??null,childViews:window.children.length}));
      if(!scenario.endsWith('-starting')) assert.equal(transports[0].closed,true,'trusted shell loss must synchronously revoke Studio transport');
      assert.equal(transports[0].authorized(),false,'old transport authorization cannot survive shell trust loss');
      if(views[0]) assert.equal(views[0].webContents.closed,true);
      assert.equal(window.children.length,0);
      assert.equal(auth.getState().kind,'signed-out','sole Auth session must revoke with its trusted shell');
      assert.equal((await auth.signIn(creds)).error,'unavailable','lost shell cannot reauthorize itself');
      // Even an old exact-URL IPC event, or a later return to that URL, has no capability.
      window.webContents.mainFrame.url=trustedUrl;
      assert.equal((await handlers.get('orange:studio:open')(event)).kind,'closed');
      assert.equal(transports.length,before);
      loadDone();startDone();await pending;
      assert.equal(transports[0].closed,true,'late transport completion must be closed');
      transports[0].onFailure();
      assert.equal((await handlers.get('orange:studio:state')(event)).kind,'closed');
      assert.equal(window.children.length,0,'late completion/callback must not resurrect the old view');
      assert.equal(window.webContents.listenerCount('render-process-gone'),0);
      assert.equal(window.webContents.listenerCount('destroyed'),0);
      assert.equal(window.webContents.listenerCount('will-redirect'),0);
      assert.equal(window.webContents.listenerCount('did-navigate'),0);
      assert.equal(window.webContents.listenerCount('did-navigate-in-page'),0);
      assert.equal(window.webContents.listenerCount('will-frame-navigate'),1,'only the original unconditional shell navigation guard remains');
      window.emit('closed');
      return;
    }
    const close=handlers.get('orange:studio:close')(event);
    assert.equal(transports[0].closed,true);
    assert.equal(views[0].webContents.closed,true);
    assert.equal(window.children.length,0);
    loadDone();await pending;await close;deferred=false;
    assert.equal((await handlers.get('orange:studio:open')(event)).kind,'open');
    transports[0].onFailure();
    assert.equal((await handlers.get('orange:studio:state')(event)).kind,'open','stale callback must not close a newer valid generation');
    views[1].webContents.emit('render-process-gone');
    assert.equal(transports[1].closed,true);
    assert.equal((await handlers.get('orange:studio:state')(event)).kind,'closed');
    await handlers.get('orange:studio:open')(event);
    window.bounds.height=128;window.emit('resize');
    assert.equal(transports[2].closed,true);assert.equal(window.children.length,0);
    window.bounds.height=760;
    await handlers.get('orange:studio:open')(event);
    const signingOut=auth.signOut();
    assert.equal(transports[3].closed,true);assert.equal(window.children.length,0);
    await signingOut;
    window.emit('closed');
  } finally {
    loadDone();startDone();
    auth.dispose();
    hooks.deregister();
    await rm(temp,{recursive:true,force:true});
    delete globalThis.__task2Native;delete globalThis.__ORANGE_STUDIO_RECEIPT_SHA256__;
  }
}

test('actual main wiring creates no second window and revokes pending native load, crash and small bounds',()=>actualMainScenario());
for(const scenario of ['crash-open','crash-pending','navigation-open','navigation-pending','destruction-open','destruction-pending','redirect-open','committed-navigation-open','in-page-navigation-open','crash-starting']) {
  test('trusted shell '+scenario+' permanently revokes ordinary Studio and Auth',()=>actualMainScenario(scenario));
}

for(const scenario of ['routes-open','routes-pending','child-inpage-open','full-trusted-open','child-full-trusted-open','redirect-trusted-open','committed-trusted-open','hash-rejected-open','query-rejected-open','encoded-rejected-open','case-rejected-open','path-rejected-open','foreign-rejected-open']) {
  test('canonical shell policy actual-main '+scenario,()=>actualMainScenario(scenario));
}
