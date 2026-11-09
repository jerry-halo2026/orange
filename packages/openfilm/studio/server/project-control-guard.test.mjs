import test from 'node:test';
import assert from 'node:assert/strict';
test('actual admission factory exists', async () => {
 const mod = await import('./project-control-guard.mjs');
 assert.equal(typeof mod.createProjectControlGuard, 'function');
});
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createProjectControlGuard } from './project-control-guard.mjs';
const base = mkdtempSync(resolve('.dev/projects-admission/guard-'));
function setup() { const root = mkdtempSync(join(base,'case-')); const target=join(root,'target'); mkdirSync(target); return {root,target,coord:join(root,'coord'),guard:createProjectControlGuard({coordinationRoot:join(root,'coord')}),r:{homes:[],roots:[],targets:[target]}}; }
test('factory is lazy; descriptors, proxies, inherited and relative inputs fail closed', async () => {
 const {root,guard}=setup(); const absent=join(root,'not-created'); createProjectControlGuard({coordinationRoot:absent}); assert.equal(existsSync(absent),false);
 for(const options of [{get coordinationRoot(){throw Error('getter executed');}},new Proxy({},{}),{coordinationRoot:'relative'}]) assert.throws(()=>createProjectControlGuard(options),{code:'control-invalid'});
 for(const r of [{homes:[],roots:[],targets:[]},{homes:[],roots:[],targets:['relative']},{homes:[],roots:[],get targets(){throw Error('getter executed');}},new Proxy({},{})]) await assert.rejects(guard.withNativeAccess(r,()=>{}),{code:'control-invalid'});
});
test('shared readers, nested/sibling reference lifetimes, exceptions and closed leases', async () => {
 const {guard,r,coord}=setup(); let lease;
 await guard.withNativeAccess(r, async l=>{ lease=l; await guard.withNativeAccess(r,async()=>{
  assert.equal(JSON.parse(readFileSync(join(coord,'registry.json'))).readers.length,2);
  await assert.rejects(guard.acquireControlledReservation(r),{code:'control-busy'});
 }); assert.equal(JSON.parse(readFileSync(join(coord,'registry.json'))).readers.length,1); });
 assert.throws(()=>lease.assertActive(),{code:'control-invalid'}); await assert.rejects(lease.include(r.targets),{code:'control-invalid'});
 await assert.rejects(guard.withNativeAccess(r,()=>{throw Error('synthetic');}),/synthetic/);
 const held=await guard.acquireControlledReservation(r); await assert.rejects(guard.withNativeAccess(r,()=>{}),{code:'control-busy'}); held.close(); held.close();
 assert.deepEqual(JSON.parse(readFileSync(join(coord,'registry.json'))),{version:1,readers:[],reservations:[]});
});
test('include checks a newly marked leaf even below an admitted parent',async()=>{
 const {guard,r,target}=setup(); await guard.withNativeAccess(r,async lease=>{const leaf=join(target,'leaf');mkdirSync(leaf);writeFileSync(join(leaf,'.openfilm-control.json'),JSON.stringify({version:1,domainId:'synthetic'}));await assert.rejects(lease.include([leaf]),{code:'control-required'});});
});
test('unknown registry and persistent metadata lock are preserved and denied',async()=>{
 const {guard,r,coord}=setup();mkdirSync(coord);writeFileSync(join(coord,'registry.json'),'{bad');await assert.rejects(guard.withNativeAccess(r,()=>{}),{code:'control-invalid'});assert.equal(readFileSync(join(coord,'registry.json'),'utf8'),'{bad');
 writeFileSync(join(coord,'meta.lock'),'synthetic');await assert.rejects(guard.withNativeAccess(r,()=>{}),{code:'control-busy'});assert.equal(readFileSync(join(coord,'meta.lock'),'utf8'),'synthetic');
});
test('coordination hardlinks and directory junctions are refused',async()=>{
 const {root,coord,r}=setup();mkdirSync(coord);const original=join(root,'ordinary');writeFileSync(original,'{}');linkSync(original,join(coord,'registry.json'));
 await assert.rejects(createProjectControlGuard({coordinationRoot:coord}).withNativeAccess(r,()=>{}),{code:'control-invalid'});
 const alias=join(root,'alias');symlinkSync(coord,alias,'junction');await assert.rejects(createProjectControlGuard({coordinationRoot:alias}).withNativeAccess(r,()=>{}),{code:'control-invalid'});
});
test('real child process shares readers; reservation excludes both processes',async()=>{
 const {guard,r,coord}=setup();
 const code=`import {createProjectControlGuard} from ${JSON.stringify(new URL('./project-control-guard.mjs',import.meta.url).href)}; const guard=createProjectControlGuard({coordinationRoot:${JSON.stringify(coord)}}); await guard.withNativeAccess(${JSON.stringify(r)},async()=>{process.stdout.write('ready\\n');await new Promise(resolve=>process.stdin.once('data',resolve));});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['pipe','pipe','pipe']}); let stderr='';child.stderr.on('data',d=>stderr+=d);
 const exit=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>resolve(code));});
 try {await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('child exited before ready')));});
 await guard.withNativeAccess(r,async()=>{assert.equal(JSON.parse(readFileSync(join(coord,'registry.json'))).readers.length,2);await assert.rejects(guard.acquireControlledReservation(r),{code:'control-busy'});});
 } finally {child.stdin.end('release');}
 assert.equal(await exit,0);assert.equal(stderr,'');const h=await guard.acquireControlledReservation(r);h.close();
});
test('real controlled reservation blocks native access in another Node process',async()=>{
 const {guard,r,coord}=setup();const held=await guard.acquireControlledReservation(r);
 const code=`import {createProjectControlGuard} from ${JSON.stringify(new URL('./project-control-guard.mjs',import.meta.url).href)};try{await createProjectControlGuard({coordinationRoot:${JSON.stringify(coord)}}).withNativeAccess(${JSON.stringify(r)},()=>{});process.exitCode=2;}catch(e){process.exitCode=e.code==='control-busy'?0:3;}`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});
 try {assert.equal(await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);}),0);}finally{held.close();}
});
test('sibling reader stays registered when another sibling throws',async()=>{
 const {guard,r}=setup();let release,started;const ready=new Promise(r=>started=r),hold=new Promise(r=>release=r);
 const reader=guard.withNativeAccess(r,async()=>{started();await hold;});await ready;
 await assert.rejects(guard.withNativeAccess(r,()=>{throw Error('synthetic');}),/synthetic/);
 await assert.rejects(guard.acquireControlledReservation(r),{code:'control-busy'});release();await reader;
 const handle=await guard.acquireControlledReservation(r);handle.close();
});
test('markers through junction and missing tail are denied; raw dot traversal cannot erase a marker',async()=>{
 const {guard,r,root,target}=setup();writeFileSync(join(target,'.openfilm-control.json'),JSON.stringify({version:1,domainId:'synthetic'}));const alias=join(root,'alias');symlinkSync(target,alias,'junction');
 await assert.rejects(guard.withNativeAccess({...r,targets:[join(alias,'missing','tail')]},()=>{}),e=>e.code==='control-required'||e.code==='control-invalid');
 await assert.rejects(guard.withNativeAccess({...r,targets:[target+'/..'+'/other']},()=>{}),{code:'control-required'});
});
test('coordination IO errors are fixed codes, never raw filesystem diagnostics',async()=>{
 const {coord,r}=setup();writeFileSync(coord,'synthetic');await assert.rejects(createProjectControlGuard({coordinationRoot:coord}).withNativeAccess(r,()=>{}),{code:'control-invalid',message:'Project control is invalid.'});
});
async function childMutex(coord, short) {
 const code=`import {openSync,closeSync,unlinkSync} from 'node:fs'; const file=${JSON.stringify(join(coord,'meta.lock'))};const fd=openSync(file,'wx');process.stdout.write('ready\\n');${short?"await new Promise(r=>setTimeout(r,20));":"await new Promise(r=>process.stdin.once('data',r));"}closeSync(fd);unlinkSync(file);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['pipe','pipe','pipe']});const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('mutex child exited early')));});return {child,exited};
}
test('fix1 real child short metadata mutex at callback exit does not orphan native reader',async()=>{
 const {guard,r,coord}=setup();let child;try{await guard.withNativeAccess(r,async()=>{child=await childMutex(coord,true);});}finally{if(child)assert.equal(await child.exited,0);}
 const reservation=await guard.acquireControlledReservation(r);reservation.close();assert.equal(JSON.parse(readFileSync(join(coord,'registry.json'))).readers.length,0);
});
test('fix1 exhausted release retains own cleanup; next acquisition recovers without deleting foreign reservation',async()=>{
 const {guard,r,coord,root}=setup();const foreign=createProjectControlGuard({coordinationRoot:coord});const other={homes:[],roots:[],targets:[join(root,'other')]};const foreignHandle=await foreign.acquireControlledReservation(other);let child,lease;
 try {await assert.rejects(guard.withNativeAccess(r,async l=>{lease=l;child=await childMutex(coord,false);}),{code:'control-busy'});assert.throws(()=>lease.assertActive(),{code:'control-invalid'});}
 finally {if(child){child.child.stdin.end('release');assert.equal(await child.exited,0);}}
 const reservation=await guard.acquireControlledReservation(r);assert.equal(JSON.parse(readFileSync(join(coord,'registry.json'))).reservations.length,2);reservation.close();assert.equal(JSON.parse(readFileSync(join(coord,'registry.json'))).reservations.length,1);foreignHandle.close();
});
test('fix1 sync native finally also retries a real child short metadata mutex',async()=>{
 const {guard,r,coord}=setup();await guard.withNativeAccess(r,()=>{});let child;
 // Parent sync callback creates its reader before handing the metadata lock to an actual child.
 const ready=join(coord,'ready');
 const code=`import {openSync,closeSync,unlinkSync,writeFileSync} from 'node:fs'; const file=${JSON.stringify(join(coord,'meta.lock'))}; const fd=openSync(file,'wx');writeFileSync(${JSON.stringify(ready)},'ready');await new Promise(r=>setTimeout(r,20));closeSync(fd);unlinkSync(file);`;
 guard.withNativeAccessSync(r,()=>{child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});const pause=new Int32Array(new SharedArrayBuffer(4));let attempts=0;while(!existsSync(ready)&&attempts++<1000)Atomics.wait(pause,0,0,2);assert.equal(existsSync(ready),true);});
 assert.equal(await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}),0);const h=await guard.acquireControlledReservation(r);h.close();
});

test('desktop controlled reservation admits only its private scope and validates every nested native operation',async()=>{
 const {guard,r,target}=setup();const held=await guard.acquireControlledReservation(r);
 assert.equal(typeof held.run,'function');let allowed=true;
 writeFileSync(join(target,'.openfilm-control.json'),JSON.stringify({version:1,domainId:'synthetic-desktop'}));
 await held.run(()=>allowed,()=>guard.withNativeAccess(r,async lease=>{lease.assertActive();await lease.include([join(target,'new')]);assert.equal(guard.isControlledAccess(),true);allowed=false;assert.throws(()=>lease.assertActive(),{code:'control-required'});}));
 await assert.rejects(held.run(()=>false,()=>guard.withNativeAccess(r,()=>{})),{code:'control-required'});
 await assert.rejects(held.run(()=>true,()=>guard.withNativeAccess({...r,targets:[resolve(target,'..','outside')]},()=>{})),{code:'control-invalid'});
 held.close();await assert.rejects(held.run(()=>true,()=>{}),{code:'control-invalid'});
 await assert.rejects(guard.withNativeAccess(r,()=>{}),{code:'control-required'});
});