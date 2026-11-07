import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
const handlers = new Map(); const bridges = {}; const invoked = [];
let response = {kind:'open',error:null};
globalThis.__studioTestElectron = {
  ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},
  contextBridge:{exposeInMainWorld:(key,value)=>{bridges[key]=value;}},
  ipcRenderer:{invoke:async (...args)=>{invoked.push(args); if(response instanceof Error) throw response; return response;}},
};
const moduleUrl = 'data:text/javascript,' + encodeURIComponent('export const {ipcMain,contextBridge,ipcRenderer}=globalThis.__studioTestElectron;');
registerHooks({resolve(specifier,context,next){return specifier==='electron'?{url:moduleUrl,shortCircuit:true}:next(specifier,context);}});
const {studioChannels} = await import('../../apps/desktop/studio-contract.ts');
const ipc = await import('../../apps/desktop/main/studio-ipc.ts').catch(error => {
  if(error.code==='ERR_MODULE_NOT_FOUND' && error.message.includes('studio-ipc.ts')) return {};
  throw error;
});
function setup() {
  assert.equal(typeof ipc.installStudioIpc,'function','ordinary Studio IPC is absent');
  handlers.clear(); const window = new EventEmitter();
  window.webContents={mainFrame:{url:pathToFileURL('E:/trusted-shell/index.html').href}};
  window.isDestroyed=()=>false;
  let calls=0;
  const controller={getState:()=>{calls++;return {kind:'closed',error:null};},open:async()=>{calls++;return {kind:'open',error:null};},close:async()=>{calls++;return {kind:'closed',error:null};},dispose:()=>{}};
  ipc.installStudioIpc(window,'E:/trusted-shell/index.html',controller);
  const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};
  return {window,event,calls:()=>calls};
}
test('all ordinary IPC methods accept only exact shell main frame and no arguments',async()=>{
  const f=setup();
  for(const channel of Object.values(studioChannels)) {
    assert.equal((await handlers.get(channel)(f.event)).error,null);
    const before=f.calls();
    for(const event of [{...f.event,sender:{}},{...f.event,senderFrame:{...f.event.senderFrame}},{...f.event,senderFrame:{url:'file:///E:/evil/index.html'}}, {...f.event,senderFrame:null}]) assert.deepEqual(await handlers.get(channel)(event),{kind:'closed',error:'failed'});
    assert.deepEqual(await handlers.get(channel)(f.event,undefined),{kind:'closed',error:'failed'});
    assert.deepEqual(await handlers.get(channel)(f.event,{bounds:{y:0}}),{kind:'closed',error:'failed'});
    assert.equal(f.calls(),before);
  }
  f.window.webContents.mainFrame.url += '#fake';
  assert.deepEqual(await handlers.get(studioChannels.open)(f.event),{kind:'closed',error:'failed'});
});
test('closed shell removes every Studio handler',()=>{
  const f=setup(); f.window.emit('closed'); assert.equal(handlers.size,0);
});
test('Studio preload is frozen noargs-only and rejects malformed or leaking DTOs',async()=>{
  await import('../../apps/desktop/preload/index.ts');
  assert.ok(bridges.orangeStudio,'ordinary orangeStudio bridge is absent');
  assert.equal(Object.isFrozen(bridges.orangeStudio),true);
  assert.deepEqual(Object.keys(bridges.orangeStudio).sort(),['close','getState','open']);
  for(const method of ['getState','open','close']) {
    response={kind:'open',error:null}; assert.deepEqual(await bridges.orangeStudio[method](),response);
    const before=invoked.length;
    assert.deepEqual(await bridges.orangeStudio[method](undefined),{kind:'closed',error:'failed'});
    assert.equal(invoked.length,before);
    for(const invalid of [{kind:'open',error:null,token:'secret'},{kind:'open',error:'failed'},null,{kind:'closed',error:'internal secret'},new Error('secret')]) {
      response=invalid;
      assert.deepEqual(await bridges.orangeStudio[method](),{kind:'closed',error:'failed'});
    }
  }
});
test('Auth installer returns its sole native service and rejects extra arguments',async()=>{
  const {installAuthIpc}=await import('../../apps/desktop/main/auth-ipc.ts');
  const {authChannels}=await import('../../apps/desktop/auth-contract.ts');
  const window=new EventEmitter(); window.webContents={mainFrame:{url:pathToFileURL('E:/trusted-shell/index.html').href}};
  const auth=installAuthIpc(window,'E:/trusted-shell/index.html');
  assert.equal(typeof auth?.subscribe,'function','main must share the exact Auth IPC service');
  const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};
  assert.deepEqual(handlers.get(authChannels.state)(event),auth.getState());
  for(const key of ['state','signOut']) assert.throws(()=>handlers.get(authChannels[key])(event,undefined),/Authentication request rejected/);
  assert.throws(()=>handlers.get(authChannels.signIn)(event,{},'extra'),/Authentication request rejected/);
  window.emit('closed');
});

const shellBase=pathToFileURL('E:/trusted-shell/index.html').href;
const shellAllowed=[shellBase,shellBase+'#/workspace',shellBase+'#/studio'];
const shellRejected=[
  shellBase+'?',shellBase+'?x=1',shellBase+'?x=1#/studio',shellBase+'#/studio?x=1',
  shellBase+'#/%73tudio',shellBase+'#/%77orkspace',shellBase+'#%2Fstudio',
  shellBase+'#/Workspace',shellBase+'#/unknown',shellBase+'#',shellBase+'#/',
  shellBase.replace('index.html','%69ndex.html')+'#/studio',
  shellBase.replace('trusted-shell','TRUSTED-shell')+'#/studio',
  shellBase.replace('/index.html','/./index.html')+'#/studio',
  shellBase.replace('trusted-shell','other-shell')+'#/studio',
  shellBase.replace('file:///E:','file://localhost/E:')+'#/studio',
  shellBase.replace('file:','FILE:')+'#/studio',shellBase.replace('E:','e:')+'#/studio',
  'https://foreign.invalid/#/studio',null,{},
];
test('canonical shell URL policy accepts exactly base and two literal hash routes',async()=>{
  const trust=await import('../../apps/desktop/main/shell-trust.ts').catch(error=>{
    if(error.code==='ERR_MODULE_NOT_FOUND' && error.message.includes('shell-trust.ts')) return {};
    throw error;
  });
  assert.equal(typeof trust.isTrustedShellUrl,'function','one shared exact shell URL policy is absent');
  for(const url of shellAllowed) assert.equal(trust.isTrustedShellUrl(url,shellBase),true,String(url));
  for(const url of shellRejected) assert.equal(trust.isTrustedShellUrl(url,shellBase),false,String(url));
});
test('every Studio IPC accepts both required hash routes without weakening frame/noargs checks',async()=>{
  const f=setup();
  for(const url of shellAllowed) {
    f.window.webContents.mainFrame.url=url;
    for(const channel of Object.values(studioChannels)) {
      assert.equal((await handlers.get(channel)(f.event)).error,null,url+' '+channel);
      const before=f.calls();
      for(const event of [{...f.event,sender:{}},{...f.event,senderFrame:{...f.event.senderFrame}},{...f.event,senderFrame:null}]) assert.deepEqual(await handlers.get(channel)(event),{kind:'closed',error:'failed'});
      assert.deepEqual(await handlers.get(channel)(f.event,undefined),{kind:'closed',error:'failed'});
      assert.deepEqual(await handlers.get(channel)(f.event,{}),{kind:'closed',error:'failed'});
      assert.equal(f.calls(),before);
    }
  }
  const before=f.calls();
  for(const url of shellRejected) {
    f.window.webContents.mainFrame.url=url;
    for(const channel of Object.values(studioChannels)) assert.deepEqual(await handlers.get(channel)(f.event),{kind:'closed',error:'failed'},String(url));
  }
  assert.equal(f.calls(),before);
  f.window.emit('closed');
});
test('every Auth IPC shares exact hash URL policy and retains sender/frame/arity rejection',async()=>{
  const {installAuthIpc}=await import('../../apps/desktop/main/auth-ipc.ts');
  const {authChannels}=await import('../../apps/desktop/auth-contract.ts');
  const window=new EventEmitter();window.webContents={mainFrame:{url:shellBase}};
  const saved={url:process.env.ORANGE_SUPABASE_URL,key:process.env.ORANGE_SUPABASE_PUBLISHABLE_KEY};
  delete process.env.ORANGE_SUPABASE_URL;delete process.env.ORANGE_SUPABASE_PUBLISHABLE_KEY;
  let auth;
  try { auth=installAuthIpc(window,'E:/trusted-shell/index.html'); }
  finally {
    if(saved.url===undefined) delete process.env.ORANGE_SUPABASE_URL;else process.env.ORANGE_SUPABASE_URL=saved.url;
    if(saved.key===undefined) delete process.env.ORANGE_SUPABASE_PUBLISHABLE_KEY;else process.env.ORANGE_SUPABASE_PUBLISHABLE_KEY=saved.key;
  }
  const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};
  const methods=[[authChannels.state,[]],[authChannels.signIn,[{}]],[authChannels.signOut,[]]];
  for(const url of shellAllowed) {
    window.webContents.mainFrame.url=url;
    for(const [channel,args] of methods) {
      const result=await handlers.get(channel)(event,...args);
      assert.deepEqual(channel===authChannels.signIn?result.state:result,{kind:'unavailable'},url+' '+channel);
      for(const bad of [{...event,sender:{}},{...event,senderFrame:{...event.senderFrame}},{...event,senderFrame:null}]) assert.throws(()=>handlers.get(channel)(bad,...args),/Authentication request rejected/);
      assert.throws(()=>handlers.get(channel)(event,...args,undefined),/Authentication request rejected/);
    }
    assert.throws(()=>handlers.get(authChannels.signIn)(event),/Authentication request rejected/);
  }
  for(const url of shellRejected) {
    window.webContents.mainFrame.url=url;
    for(const [channel,args] of methods) assert.throws(()=>handlers.get(channel)(event,...args),/Authentication request rejected/,String(url));
  }
  auth.dispose();window.emit('closed');
});
