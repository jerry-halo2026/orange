import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { connect, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveIsolationProfile, isolationEnvironment } from '../../src/development-isolation.mjs';
import { createProjectControlGuard } from './project-control-guard.mjs';
import { withProjectControlGuard, createProject } from './projects.mjs';
import { createWatchers } from './watch.mjs';
import { readProjectFilm, settleProjectFilm } from './film.mjs';
import * as personEdits from './person-edits.mjs';
import { filmHtml } from '../../src/film-doc.mjs';
import { createHash } from 'node:crypto';
import { createAutoVersions } from './auto-versions.mjs';
let seq=0;
function fixture() {
 const baseRoot=resolve('.dev/studio-watch-close/profiles');
 const profile=resolveIsolationProfile({baseRoot,instanceId:'studio-watch',taskId:'T02_STUDIO_WATCH',attemptId:`a-${process.pid}-${Date.now()}-${seq++}`,ports:{studio:18475,film:18476}},{approvedBaseRoot:baseRoot});
 for(const p of Object.values(profile.paths)) fs.mkdirSync(p,{recursive:true});
 Object.assign(process.env,isolationEnvironment(profile));
 const guard=createProjectControlGuard({coordinationRoot:join(profile.root,'coord')});
 const root=join(profile.paths.projects,'synthetic');fs.mkdirSync(root);fs.writeFileSync(join(root,'film.html'),'initial');
 return {profile,root,run:fn=>withProjectControlGuard(guard,fn)};
}
fixture();
const {startStudio}=await import('./server.mjs');
const options={port:18475,isolation:true,advertise:false,openBrowser:()=>assert.fail('no browser')};
const gate=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
async function entered(p) {let timer;try{await Promise.race([p,new Promise((_,r)=>timer=setTimeout(()=>r(Error('entered gate timed out')),5000))]);}finally{clearTimeout(timer);}}
async function until(fn){for(let i=0;i<500;i++){if(await fn())return;await delay(5);}assert.fail('owned resource did not reach gate');}
async function pending(p){let done=false;Promise.resolve(p).then(()=>done=true,()=>done=true);await new Promise(r=>setImmediate(r));assert.equal(done,false,'close must retain actual entered work');}
const listening=port=>new Promise(r=>{const s=connect({host:'127.0.0.1',port});s.once('connect',()=>{s.destroy();r(true);});s.once('error',()=>{s.destroy();r(false);});});
async function free(){for(const p of [18475,18476])assert.equal(await listening(p),false);}
function observe(){const original=fs.watch,records=[];let released=false;fs.watch=function(...args){const w=Reflect.apply(original,fs,args),emit=w.emit;const record={observed:0,delivered:0,pending:[]};records.push(record);w.emit=function(e,...v){if(e!=='close')return Reflect.apply(emit,this,[e,...v]);record.observed++;const forward=()=>{record.delivered++;Reflect.apply(emit,w,[e,...v]);};if(released)forward();else record.pending.push(forward);return true;};return w;};syncBuiltinESMExports();const release=()=>{released=true;for(const r of records)for(const f of r.pending.splice(0))f();};return {records,release,restore(){release();fs.watch=original;syncBuiltinESMExports();}};}
async function stream(studio,id){const socket=connect({host:'127.0.0.1',port:18475});socket.on('error',()=>{});await new Promise(r=>socket.once('connect',r));socket.write(`GET /api/projects/${id}/events HTTP/1.1\r\nHost: 127.0.0.1:18475\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\nx-studio-key: ${studio.key}\r\n\r\n`);await entered(new Promise(r=>socket.once('data',r)));return socket;}

test('original websocket consumer waits actual FSWatcher close delivery after both origins and existing socket close',async()=>{
 const f=fixture(),o=observe();let studio,socket;await free();
 try{await f.run(async()=>{const project=await createProject('native-close');studio=await startStudio(options);socket=await stream(studio,project.id);assert.ok(o.records.length>0);const socketClosed=new Promise(r=>socket.once('close',r));const closing=studio.close();assert.equal(studio.close(),closing);await until(()=>o.records.every(r=>r.observed===1));await until(async()=>!await listening(18475)&&!await listening(18476));await entered(socketClosed);assert.ok(o.records.every(r=>r.delivered===0));await pending(closing);o.release();await closing;assert.ok(o.records.every(r=>r.delivered===1));});}finally{o.release();socket?.destroy();if(studio)await studio.close();o.restore();}await free();
});

// These seams wrap native IO and the real manager; no substitute drain lifecycle.
function reads(f,count=1){
 const roots=Array.from({length:count},(_,i)=>{const r=join(f.profile.paths.projects,'read-'+i);fs.mkdirSync(r);fs.writeFileSync(join(r,'film.html'),'native-'+i);return r;});
 const gates=roots.map(()=>({entered:gate(),io:gate(),cleanup:gate()})),completed=[],seen=[];let manager, enteredCount=0;
 const factory=opts=>{manager=createWatchers({...opts,trustedNode:{readProjectFilm:async root=>{const i=roots.indexOf(root),g=gates[i];enteredCount++;g.entered.release();try{await g.io.promise;const value=await readProjectFilm(root);completed.push(value.text);return value;}finally{await g.cleanup.promise;}}}});for(const r of roots)manager.subscribe(r,e=>seen.push(e));return manager;};
 return {factory,roots,gates,completed,seen,get enteredCount(){return enteredCount;},get manager(){return manager;},finish(){for(const g of gates){g.io.release();g.cleanup.release();}}};
}
test('pending actual initial read and cleanup remain owned after network close; terminal admission cannot restart',async()=>{
 const f=fixture(),r=reads(f);let studio;await free();
 try{await f.run(async()=>{studio=await startStudio({...options,watchersFactory:r.factory});await entered(r.gates[0].entered.promise);const closing=studio.close();assert.equal(studio.close(),closing);await until(async()=>!await listening(18475)&&!await listening(18476));await pending(closing);r.gates[0].io.release();await until(()=>r.completed.length===1);await pending(closing);r.manager.subscribe(f.root,e=>r.seen.push(e));r.manager.move(r.roots[0],f.root);r.manager.emit(f.root,{type:'history'});assert.deepEqual(r.manager.roots(),[]);r.gates[0].cleanup.release();await closing;assert.deepEqual(r.completed,['native-0']);assert.deepEqual(r.seen,[]);});}finally{r.finish();if(studio)await studio.close();if(r.manager)await r.manager.drain();}await free();
});

for(const kind of ['film','files'])test(`Studio owns native ${kind} merge keepAside and actual replacement cleanup`,async()=>{
 const f=fixture(),e=gate(),release=gate(),cleanup=gate(),settled=gate();let studio,manager;const seen=[];
 const original={stage:{w:1920,h:1080},tracks:[]},ours={stage:{w:1000,h:1080},tracks:[]},theirs={stage:{w:1920,h:720},tracks:[]};
 const key=kind==='film'?'settleProjectFilm':'settleFiles',native=kind==='film'?settleProjectFilm:personEdits.settleFiles;
 try{await f.run(async()=>{studio=await startStudio({...options,watchersFactory:opts=>{manager=createWatchers({...opts,trustedNode:{[key]:async(...args)=>{try{return await native(...args);}finally{settled.release();await cleanup.promise;}}}});return manager;}});
 personEdits.configure({keep:async(root,files)=>{e.release();await release.promise;fs.mkdirSync(join(root,'.evidence'),{recursive:true});for(const [name,value]of Object.entries(files))fs.writeFileSync(join(root,'.evidence',name),value);}});
 if(kind==='film'){const html=filmHtml(ours);fs.writeFileSync(join(f.root,'film.html'),html);personEdits.filmWritten(f.root,original,ours,createHash('sha256').update(html).digest('hex').slice(0,16));}else{fs.writeFileSync(join(f.root,'page.html'),'ours\nbase\n');personEdits.filesWritten(f.root,{'page.html':'base\n'},{'page.html':'ours\nbase\n'});}
 manager.subscribe(f.root,event=>seen.push(event));fs.writeFileSync(join(f.root,kind==='film'?'film.html':'page.html'),kind==='film'?filmHtml(theirs):'base\ntheirs\n');await entered(e.promise);const closing=studio.close();await until(async()=>!await listening(18475)&&!await listening(18476));await pending(closing);release.release();await entered(settled.promise);await pending(closing);cleanup.release();await closing;
 if(kind==='film')assert.deepEqual((await readProjectFilm(f.root)).value.stage,ours.stage);else assert.equal(fs.readFileSync(join(f.root,'page.html'),'utf8'),'ours\nbase\ntheirs\n');assert.ok(fs.readdirSync(join(f.root,'.evidence')).some(n=>n.startsWith('merged.')));assert.ok(!fs.readdirSync(f.root).some(n=>n.endsWith('.tmp')));assert.deepEqual(seen,[]);
 });}finally{release.release();cleanup.release();if(studio)await studio.close();if(manager)await manager.drain();personEdits.forget(f.root);personEdits.configure({keep:async()=>{}});}await free();
});

test('Studio drains parallel current and retired roots from unsubscribe closeAll and move until the last real read',async()=>{
 const f=fixture(),io=[],entries=[],seen=[];let manager,studio;await free();
 const read=async(root)=>{const g=gate();io.push(g);const value=await readProjectFilm(root);entries.push(root);await g.promise;return value;};
 try{await f.run(async()=>{studio=await startStudio({...options,watchersFactory:opts=>{manager=createWatchers({...opts,trustedNode:{readProjectFilm:read}});return manager;}});
 const b=join(f.profile.paths.projects,'other');fs.mkdirSync(b);fs.writeFileSync(join(b,'film.html'),'other');
 const stale=manager.subscribe(f.root,e=>seen.push(e));await until(()=>io.length===1);stale();manager.subscribe(f.root,e=>seen.push(e));manager.subscribe(b,e=>seen.push(e));await until(()=>io.length===3);manager.closeAll();manager.subscribe(f.root,e=>seen.push(e));await until(()=>io.length===4);manager.move(f.root,b);await until(()=>io.length===5);stale();assert.deepEqual(manager.roots(),[b]);
 const closing=studio.close();io.slice(0,-1).forEach(g=>g.release());await pending(closing);assert.equal(entries.length,5,'unrelated roots entered without global serialization');io.at(-1).release();await closing;assert.deepEqual(seen,[]);manager.subscribe(b,()=>{});assert.deepEqual(manager.roots(),[]);
 });}finally{io.forEach(g=>g.release());if(studio)await studio.close();if(manager)await manager.drain();}await free();
});

for(const busy of [18475,18476])test(`actual listen ${busy} failure waits native read cleanup and preserves blocker/error object`,async()=>{
 const f=fixture(),r=reads(f),blocker=createServer(s=>s.destroy());let studio,error,settled=false,starting,captured;await free();
 // Capture the actual emitted listen error object, not a reconstructed code/message.
 const {Server}=await import('node:net'),emit=Server.prototype.emit;
 Server.prototype.emit=function(event,...args){if(event==='error'&&args[0]?.code==='EADDRINUSE')captured=args[0];return Reflect.apply(emit,this,[event,...args]);};
 await new Promise((ok,no)=>{blocker.once('error',no);blocker.listen(busy,'127.0.0.1',ok);});
 try{await f.run(async()=>{starting=startStudio({...options,watchersFactory:r.factory}).then(s=>{studio=s;settled=true;},e=>{error=e;settled=true;});await entered(r.gates[0].entered.promise);await until(()=>!!captured);assert.equal(settled,false);r.gates[0].io.release();await until(()=>r.completed.length===1);await pending(starting);r.gates[0].cleanup.release();await starting;assert.equal(error,captured);assert.equal(error.code,'EADDRINUSE');assert.equal(await listening(busy),true);assert.deepEqual(r.manager.roots(),[]);});}finally{r.finish();if(starting)await starting;if(studio)await studio.close();if(r.manager)await r.manager.drain();await new Promise(r=>blocker.close(r));Server.prototype.emit=emit;}await free();
});

for(const first of ['watch','auto'])test(`real Auto and watcher cleanup retain stable reentrant close; ${first} released first`,async()=>{
 const f=fixture(),r=reads(f),save=gate(),saved=gate(),cleanup=gate(),autoEntered=gate();let studio,auto,reentered,watchReentered,working=0;await free();
 try{await f.run(async()=>{studio=await startStudio({...options,watchersFactory:opts=>{const m=r.factory(opts),drain=m.drain;m.drain=()=>{if(studio)watchReentered=studio.close();return drain();};return m;},autoVersionsFactory:opts=>{auto=createAutoVersions({...opts,on:()=>true,roots:()=>[f.root],working:()=>++working>1,save:async()=>{autoEntered.release();try{await save.promise;fs.writeFileSync(join(f.root,'.auto-evidence'),'saved');saved.release();}finally{await cleanup.promise;}}});auto.poll();const stop=auto.stop;auto.stop=()=>{if(studio)reentered=studio.close();return stop();};return auto;}});await entered(autoEntered.promise);await entered(r.gates[0].entered.promise);const closing=studio.close();assert.equal(reentered,closing);assert.equal(watchReentered,closing);assert.equal(studio.close(),closing);await until(async()=>!await listening(18475)&&!await listening(18476));await pending(closing);
 if(first==='watch'){r.finish();await r.manager.drain();await pending(closing);save.release();await entered(saved.promise);await pending(closing);cleanup.release();}else{save.release();await entered(saved.promise);cleanup.release();await auto.drain();await pending(closing);r.finish();}await closing;assert.equal(fs.readFileSync(join(f.root,'.auto-evidence'),'utf8'),'saved');assert.deepEqual(r.completed,['native-0']);
 });}finally{r.finish();save.release();cleanup.release();if(auto)await auto.stop();if(studio)await studio.close();if(r.manager)await r.manager.drain();}await free();
});

test('sanitized invalid watcher factories and surfaces never start Auto or bind',async()=>{
 const f=fixture();let starts=0;const bad=[null,42,{},()=>null,()=>({}),()=>{throw Error('PRIVATE_SENTINEL');},()=>Object.defineProperty({},'subscribe',{get(){throw Error('PRIVATE_SENTINEL');}})];
 for(const missing of ['subscribe','move','roots','emit','closeAll','drain'])bad.push(()=>{const m=createWatchers();delete m[missing];return m;});
 await f.run(async()=>{for(const watchersFactory of bad){await assert.rejects(startStudio({...options,watchersFactory,autoVersionsFactory:()=>{starts++;return createAutoVersions({on:()=>false,working:()=>false,roots:()=>[],save:async()=>{}});}}),e=>e.message==='Invalid project watchers factory.'&&!e.stack.includes('PRIVATE_SENTINEL'));await free();}});assert.equal(starts,0);
});
for(const kind of ['type','surface','getter','throw','start'])test(`obtained native manager drains if subsequent Auto ${kind} initialization fails`,async()=>{
 const f=fixture(),r=reads(f);let starting,settled=false,error;await free();const autoVersionsFactory=kind==='type'?null:()=>{if(kind==='throw')throw Error('PRIVATE_SENTINEL');if(kind==='getter')return Object.defineProperty({},'changed',{get(){throw Error('PRIVATE_SENTINEL');}});if(kind==='surface')return {};const auto=createAutoVersions({on:()=>false,working:()=>false,roots:()=>[],save:async()=>{}});auto.start=()=>{throw Error('PRIVATE_SENTINEL');};return auto;};
 try{await f.run(async()=>{starting=startStudio({...options,watchersFactory:r.factory,autoVersionsFactory}).then(()=>settled=true,e=>{error=e;settled=true;});await entered(r.gates[0].entered.promise);await pending(starting);assert.equal(settled,false);r.gates[0].io.release();await until(()=>r.completed.length===1);await pending(starting);r.gates[0].cleanup.release();await starting;assert.equal(error.message,'Invalid automatic versions factory.');assert.ok(!error.stack.includes('PRIVATE_SENTINEL'));assert.deepEqual(r.manager.roots(),[]);});}finally{r.finish();if(starting)await starting;if(r.manager)await r.manager.drain();}await free();
});

test('cleanup rejection waits other actual native completion before rejecting close',async()=>{
 const f=fixture(),r=reads(f),failure=Error('synthetic cleanup');let studio;await free();
 try{await f.run(async()=>{studio=await startStudio({...options,watchersFactory:r.factory,autoVersionsFactory:opts=>{const auto=createAutoVersions({...opts,on:()=>false});const stop=auto.stop;auto.stop=()=>{stop();return Promise.reject(failure);};return auto;}});await entered(r.gates[0].entered.promise);let error;const closing=studio.close().catch(e=>error=e);await until(async()=>!await listening(18475)&&!await listening(18476));await pending(closing);r.gates[0].io.release();await until(()=>r.completed.length===1);await pending(closing);r.gates[0].cleanup.release();await closing;assert.equal(error,failure);});}finally{r.finish();if(studio)await studio.close().catch(()=>{});if(r.manager)await r.manager.drain();}await free();
});

// fix13: exactly these two cases use advertise, with isolated metadata and a fresh explicit key.
for (const fault of ['mkdirSync', 'writeFileSync']) test(`post-listen isolated metadata ${fault} fault drains native watch and Auto before preserving error`, async () => {
  const f = fixture(), r = reads(f), injected = Error('synthetic metadata fault');
  const fired = gate(), autoEntered = gate(), save = gate(), saved = gate(), autoCleanup = gate();
  const { Server } = await import('node:net');
  const emit = Server.prototype.emit, original = fs[fault], owned = new Set(), listeningPorts = [];
  const home = resolve(f.profile.paths.home), runFile = join(home, 'run.json');
  let auto, starting, returned, startupError, working = 0, statesAtFault, watchEnteredAtFault, autoEnteredAtFault, autoHasEntered = false;
  await free();
  assert.equal(fs.existsSync(runFile), false, 'new profile cannot take over an advertisement');
  assert.equal(resolve(process.env.OPENFILM_HOME), home);
  assert.ok(runFile.startsWith(f.profile.root + '\\'));
  Server.prototype.emit = function (event, ...args) {
    if (event === 'listening' && [18475, 18476].includes(this.address()?.port)) {
      owned.add(this); listeningPorts.push(this.address().port);
    }
    return Reflect.apply(emit, this, [event, ...args]);
  };
  fs[fault] = function (target, ...args) {
    const exact = typeof target === 'string' && resolve(target) === (fault === 'mkdirSync' ? home : runFile);
    if (exact && owned.size === 2) {
      statesAtFault = [...owned].map(server => server.listening);
      watchEnteredAtFault = r.enteredCount;
      autoEnteredAtFault = autoHasEntered;
      fired.release();
      throw injected; // Before touching the exact own-profile metadata path.
    }
    return Reflect.apply(original, fs, [target, ...args]);
  };
  syncBuiltinESMExports();
  try {
    await f.run(async () => {
      starting = startStudio({ ...options, advertise: true,
        key: createHash('sha256').update(f.profile.root).digest('hex'),
        watchersFactory: r.factory,
        autoVersionsFactory: opts => {
          auto = createAutoVersions({ ...opts, on: () => true, roots: () => [f.root],
            working: () => ++working > 1,
            save: async () => {
              autoHasEntered = true;
              autoEntered.release();
              try { await save.promise; fs.writeFileSync(join(f.root, '.metadata-auto'), 'saved'); saved.release(); }
              finally { await autoCleanup.promise; }
            },
          });
          auto.poll();
          return auto;
        },
      }).then(studio => { returned = studio; }, error => { startupError = error; });
      await entered(fired.promise);
      await entered(r.gates[0].entered.promise);
      await entered(autoEntered.promise);
      assert.deepEqual(listeningPorts, [18475, 18476]);
      assert.deepEqual(statesAtFault, [true, true], 'both listeners really existed when metadata failed');
      assert.equal(watchEnteredAtFault, 1, 'actual watcher read already entered before the metadata fault');
      assert.equal(autoEnteredAtFault, true, 'actual Auto save already entered before the metadata fault');
      await pending(starting); // Behavioral RED: pre-fix caller rejects here while IO is still entered.
      await until(async () => !await listening(18475) && !await listening(18476));
      r.gates[0].io.release();
      await until(() => r.completed.length === 1);
      await pending(starting);
      r.gates[0].cleanup.release();
      await r.manager.drain();
      await pending(starting); // Actual Auto save still owns startup completion.
      save.release();
      await entered(saved.promise);
      await pending(starting);
      autoCleanup.release();
      await starting;
      assert.equal(startupError, injected);
      assert.equal(returned, undefined);
      assert.equal(fs.existsSync(runFile), false, 'fault happened before advertisement was written');
      assert.equal(fs.readFileSync(join(f.root, '.metadata-auto'), 'utf8'), 'saved');
      assert.deepEqual(r.completed, ['native-0']);
    });
  } finally {
    fs[fault] = original; syncBuiltinESMExports();
    r.finish(); save.release(); autoCleanup.release();
    if (starting) await starting;
    if (returned) await returned.close();
    if (r.manager) await r.manager.drain();
    if (auto) await auto.stop();
    // RED cleanup owns only the two actual listener objects observed above.
    for (const server of owned) {
      server.closeAllConnections();
      if (server.listening) await new Promise(done => server.close(done));
    }
    Server.prototype.emit = emit;
  }
  await free();
});

test('late upgrade real projectById read released after close cannot handshake or acquire subscriptions and handles', async () => {
  const f = fixture(), lookupEntered = gate(), release = gate(), readFinished = gate(), rechecked = gate();
  const fsPromises = (await import('node:fs/promises')).default;
  const { Server } = await import('node:net');
  const originalRead = fsPromises.readFile, originalEmit = Server.prototype.emit;
  const observed = observe(), bytes = [], handshakeAttempts = [];
  let studio, socket, serverSocket, manager, subscriptions = 0, watcherReads = 0, readResult, released = false;
  await free();
  try {
    await f.run(async () => {
      const project = await createProject('late-upgrade');
      studio = await startStudio({ ...options, watchersFactory: opts => {
        manager = createWatchers({ ...opts, trustedNode: {
          readProjectFilm: async (...args) => { watcherReads++; return readProjectFilm(...args); },
        } });
        const subscribe = manager.subscribe;
        manager.subscribe = (...args) => { subscriptions++; return subscribe(...args); };
        return manager;
      } });
      const stateFile = join(f.profile.paths.home, 'studio.json');
      fsPromises.readFile = async function (file, ...args) {
        if (typeof file === 'string' && resolve(file) === resolve(stateFile)) {
          lookupEntered.release(); await release.promise;
          readResult = await Reflect.apply(originalRead, fsPromises, [file, ...args]);
          readFinished.release();
          return readResult;
        }
        return Reflect.apply(originalRead, fsPromises, [file, ...args]);
      };
      syncBuiltinESMExports();
      Server.prototype.emit = function (event, ...args) {
        if (event === 'upgrade' && args[0].url === `/api/projects/${project.id}/events`) {
          serverSocket = args[1];
          const write = serverSocket.write, destroy = serverSocket.destroy;
          serverSocket.write = function (chunk, ...rest) {
            if (String(chunk).startsWith('HTTP/1.1 101')) handshakeAttempts.push(String(chunk).slice(0, 12));
            return Reflect.apply(write, this, [chunk, ...rest]);
          };
          serverSocket.destroy = function (...values) {
            if (released) rechecked.release();
            return Reflect.apply(destroy, this, values);
          };
        }
        return Reflect.apply(originalEmit, this, [event, ...args]);
      };
      socket = connect({ host: '127.0.0.1', port: 18475 });
      socket.on('error', () => {});
      socket.on('data', data => bytes.push(data));
      await entered(new Promise(done => socket.once('connect', done)));
      socket.write(`GET /api/projects/${project.id}/events HTTP/1.1\r\nHost: 127.0.0.1:18475\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\nx-studio-key: ${studio.key}\r\n\r\n`);
      await entered(lookupEntered.promise);
      assert.equal(readResult, undefined, 'actual native state read is held before IO');
      const socketClosed = new Promise(done => socket.once('close', done));
      await studio.close();
      await entered(socketClosed);
      await free();
      const handlesAtClose = observed.records.length;
      assert.equal(subscriptions, 0);
      released = true; release.release();
      await entered(readFinished.promise);
      await entered(rechecked.promise); // Actual original upgrade continuation reached its post-query stop check.
      assert.ok(JSON.parse(readResult).recent.some(entry => entry.id === project.id));
      assert.deepEqual(handshakeAttempts, []);
      assert.ok(!Buffer.concat(bytes).toString().includes('101 Switching Protocols'));
      assert.equal(subscriptions, 0);
      assert.equal(watcherReads, 0);
      assert.equal(observed.records.length, handlesAtClose);
      assert.deepEqual(manager.roots(), []);
    });
  } finally {
    release.release();
    fsPromises.readFile = originalRead; syncBuiltinESMExports();
    Server.prototype.emit = originalEmit;
    socket?.destroy(); serverSocket?.destroy();
    if (studio) await studio.close();
    if (manager) await manager.drain();
    observed.restore();
  }
  await free();
});
