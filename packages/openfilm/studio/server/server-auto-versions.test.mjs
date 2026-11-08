import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer, connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveIsolationProfile, isolationEnvironment, assertIsolationPath } from '../../src/development-isolation.mjs';
import { createProjectControlGuard } from './project-control-guard.mjs';
import { withProjectControlGuard } from './projects.mjs';
import { createAutoVersions } from './auto-versions.mjs';

const baseRoot = resolve('.dev/studio-auto-close/profiles');
let sequence = 0;
function fixture() {
  const profile = resolveIsolationProfile({ baseRoot, instanceId: 'studio-close', taskId: 'T02_STUDIO_CLOSE',
    attemptId: 'a-' + process.pid + '-' + Date.now() + '-' + sequence++, ports: { studio: 18475, film: 18476 } }, { approvedBaseRoot: baseRoot });
  for (const p of Object.values(profile.paths)) mkdirSync(assertIsolationPath(profile, p), { recursive: true });
  Object.assign(process.env, isolationEnvironment(profile));
  const coord = assertIsolationPath(profile, join(profile.root, 'coord'));
  const guard = createProjectControlGuard({ coordinationRoot: coord });
  return { profile, run: fn => withProjectControlGuard(guard, fn) };
}
// Establish isolated environment before loading the native server and its dependencies.
fixture();
const { startStudio } = await import('./server.mjs');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
async function eventually(fn) {
  for (let i=0;i<200;i++) { if (await fn()) return; await delay(5); }
  assert.fail('owned resource did not reach the required state');
}
const listening = port => new Promise(done => {
  const socket = connect({host:'127.0.0.1',port});
  socket.once('connect',()=>{socket.destroy();done(true);});
  socket.once('error',()=>{socket.destroy();done(false);});
});
async function free() { for (const port of [18475,18476]) assert.equal(await listening(port),false,'allocated port must be free'); }
async function blocker(port) {
  const server = createServer(socket=>socket.destroy());
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',done);});
  return () => new Promise(done=>server.close(done));
}
function saves(f, count=1) {
  const roots=Array.from({length:count},(_,i)=>join(f.profile.paths.projects,'synthetic-'+i));
  const io=roots.map(deferred), cleanup=roots.map(deferred);
  const state={entered:0,cleaned:0,working:0,on:0};
  let auto;
  const workingCalls = new Map();
  const factory=options=>{
    auto=createAutoVersions({...options,on:()=>{state.on++;return true;}, roots:()=>roots,
      working:root=>{state.working++;const n=(workingCalls.get(root)??0)+1;workingCalls.set(root,n);return n>=2;},
      save:async root=>{
        const i=roots.indexOf(root);state.entered++;
        try { await io[i].promise; writeFileSync(join(f.profile.paths.logs,'save-'+i),'synthetic'); }
        finally { await cleanup[i].promise;state.cleaned++; }
      },idleMs:1,pollMs:2});
    // Actual poll/working transition invokes the real save before the first listen can fail.
    auto.poll();
    return auto;
  };
  return {factory,state,io,cleanup,get auto(){return auto;},
    finish(){for(const d of [...io,...cleanup])d.resolve();}};
}
const options = { isolation:true,port:18475,advertise:false,openBrowser:()=>assert.fail('browser not allowed') };

test('default actual factory preserves native Studio return shape and closes both origins',async()=>{
  const f=fixture();await free();
  await f.run(async()=>{
    const studio=await startStudio(options);
    try {
      assert.deepEqual(Object.keys(studio).sort(),['close','filmOrigin','key','origin','port']);
      assert.equal(studio.origin,'http://127.0.0.1:18475');
      assert.equal(studio.filmOrigin,'http://localhost:18476');
      assert.equal(studio.port,18475);assert.equal(typeof studio.key,'string');
    } finally {await studio.close();}
  });await free();
});

for(const reject of [false,true]) test('actual save '+(reject?'rejection':'IO')+' and cleanup keep public close pending after ports close',async()=>{
  const f=fixture(),s=saves(f);await free();
  await f.run(async()=>{
    let studio, socket;
    try {
      studio=await startStudio({...options,autoVersionsFactory:s.factory});
      socket=connect({host:'127.0.0.1',port:18475});
      await new Promise((done,fail)=>{socket.once('connect',done);socket.once('error',fail);});
      let socketClosed=false;socket.once('close',()=>{socketClosed=true;});
      assert.equal(s.state.entered,1,'actual producer save entered');
      let settled=false;const closing=studio.close();closing.then(()=>{settled=true;});
      assert.strictEqual(studio.close(),closing);
      await eventually(async()=>!await listening(18475)&&!await listening(18476));
      await eventually(()=>socketClosed);
      await delay(20);assert.equal(settled,false,'original close must wait real save');
      if(reject)s.io[0].reject(new Error('SYNTHETIC_PRIVATE_SENTINEL'));else s.io[0].resolve();
      await delay(20);assert.equal(settled,false,'cleanup belongs to actual save promise');
      s.cleanup[0].resolve();await closing;assert.equal(s.state.cleaned,1);
      assert.equal(existsSync(join(f.profile.paths.logs,'save-0')),!reject);
      const counts={...s.state};s.auto.changed('late');s.auto.poll();await delay(20);
      assert.deepEqual(s.state,counts,'closed Studio never internally restarts Auto');
    } finally {socket?.destroy();s.finish();if(s.auto)await s.auto.stop();if(studio)await studio.close();}
  });await free();
});

for(const busyPort of [18475,18476]) test('actual startup failure on '+busyPort+' stops admission, closes owned network, waits save cleanup, preserves EADDRINUSE',async()=>{
  const f=fixture(),s=saves(f);await free();const unblock=await blocker(busyPort);
  await f.run(async()=>{
    let studio,settled=false,error;
    const starting=startStudio({...options,autoVersionsFactory:s.factory}).then(x=>{studio=x;settled=true;},e=>{error=e;settled=true;});
    try {
      await eventually(()=>s.state.entered===1);
      if(busyPort===18476)await eventually(async()=>!await listening(18475));
      await delay(30);assert.equal(settled,false,'original startup must wait actual save');
      const counts={...s.state};s.auto.changed('late');s.auto.poll();await delay(10);assert.deepEqual(s.state,counts);
      s.io[0].resolve();await delay(15);assert.equal(settled,false,'startup waits cleanup too');
      s.cleanup[0].resolve();await starting;assert.equal(error?.code,'EADDRINUSE');assert.equal(s.state.cleaned,1);
      assert.equal(await listening(busyPort),true,'external blocker is not closed by Studio');
    } finally {s.finish();if(s.auto)await s.auto.stop();await starting;if(studio)await studio.close();await unblock();}
  });await free();
});

test('multiple actual parallel saves wait for the last cleanup',async()=>{
  const f=fixture(),s=saves(f,2);await free();
  await f.run(async()=>{
    let studio;
    try {
      studio=await startStudio({...options,autoVersionsFactory:s.factory});assert.equal(s.state.entered,2);
      let settled=false;const closing=studio.close().then(()=>{settled=true;});
      await eventually(async()=>!await listening(18475)&&!await listening(18476));
      s.io.forEach(d=>d.resolve());s.cleanup[0].resolve();
      await delay(20);assert.equal(s.state.cleaned,1);assert.equal(settled,false);
      s.cleanup[1].resolve();await closing;assert.equal(s.state.cleaned,2);
    } finally {s.finish();if(s.auto)await s.auto.stop();if(studio)await studio.close();}
  });await free();
});

test('invalid factory types, surfaces and throws fail safely before start or listen',async()=>{
  const f=fixture();await free();let starts=0;
  const bad=[null,42,{},()=>null,()=>({}),()=>{throw new Error('SYNTHETIC_PRIVATE_SENTINEL');},
    ()=>Object.defineProperty({},'changed',{get(){throw new Error('SYNTHETIC_PRIVATE_SENTINEL');}})];
  for(const missing of ['changed','poll','start','stop','drain'])bad.push(()=>{
    const surface={changed(){},poll(){},start(){starts++;},stop(){},drain(){}};
    delete surface[missing];return surface;
  });
  await f.run(async()=>{
    for(const autoVersionsFactory of bad) {
      await assert.rejects(startStudio({...options,autoVersionsFactory}),e=>e.message==='Invalid automatic versions factory.'&&!String(e.stack).includes('SYNTHETIC_PRIVATE_SENTINEL'));
      await free();
    }
  });assert.equal(starts,0);
});
