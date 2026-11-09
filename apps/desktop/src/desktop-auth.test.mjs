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
  const controller = mod.createDesktopAuth({configuration:options.configuration??configuration,home,projects,coordinationRoot:join(home,'coord'),instanceId:'test-instance'}, {
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

test('desktop material registration holds the original owned source and persists a stable key before actual binary relay',async()=>{
 let s,seenKey;const bytes=Buffer.from('synthetic original owned bytes');s=await businessController(async(url,init)=>{
  assert.equal(new URL(url).pathname,'/api/materials/local');const metadata=JSON.parse(await readFile(join(s.project.path,'.film','orange-materials.json'),'utf8'));assert.equal(metadata.records.length,1);seenKey=init.headers['idempotency-key'];assert.equal(metadata.records[0].key,seenKey);assert.equal(metadata.records[0].state,'unknown');const chunks=[];for await(const b of init.body)chunks.push(Buffer.from(b));assert.deepEqual(Buffer.concat(chunks),bytes);return Response.json({assetId:A,versionId:B,registration:'registered',licensed:false});
 });
 await mkdir(join(s.project.path,'assets'));await writeFile(join(s.project.path,'assets','own.wav'),bytes);
 try{assert.equal(typeof s.controller.registerMaterial,'function','original controller has real private native registration operation');const result=await s.controller.registerMaterial(s.project,'assets/own.wav');assert.equal(result.state,'registered');assert.equal(result.versionId,B);assert.equal((await s.controller.materialStatus(s.project,'assets/own.wav')).state,'registered');assert.doesNotMatch(JSON.stringify(result),/only-private|subject|environment|[A-Z]:|projectPath/);const data=JSON.parse(await readFile(join(s.project.path,'.film','orange-materials.json'),'utf8'));assert.equal(data.records[0].key,seenKey);assert.doesNotMatch(JSON.stringify(data),/only-private/);}finally{await s.controller.dispose();}
});

test('unknown material registration reuses its exact prior key and malformed metadata is preserved rather than reset',async()=>{
 const keys=[];const s=await businessController(async(url,init)=>{keys.push(init.headers['idempotency-key']);for await(const chunk of init.body)assert.ok(chunk.length);throw Error('synthetic lost response');});await mkdir(join(s.project.path,'assets'));const file=join(s.project.path,'assets','own.wav');await writeFile(file,'stable source');
 try{assert.equal(typeof s.controller.registerMaterial,'function');assert.equal((await s.controller.registerMaterial(s.project,'assets/own.wav')).state,'unknown');assert.equal((await s.controller.registerMaterial(s.project,'assets/own.wav')).state,'unknown');assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);const metadata=join(s.project.path,'.film','orange-materials.json');await writeFile(metadata,'{incomplete original metadata');await assert.rejects(s.controller.registerMaterial(s.project,'assets/own.wav'),e=>e.code==='material-metadata-unconfirmed');assert.equal(await readFile(metadata,'utf8'),'{incomplete original metadata');assert.equal(await readFile(file,'utf8'),'stable source');assert.equal(keys.length,2);}finally{await s.controller.dispose();}
});

test('material source changes invalidate the old unknown association but explicit new registration preserves its history',async()=>{
 const keys=[];const s=await businessController(async(url,init)=>{keys.push(init.headers['idempotency-key']);for await(const b of init.body)assert.ok(b.length);throw Error('synthetic outcome unknown');});await mkdir(join(s.project.path,'assets'));const file=join(s.project.path,'assets','change.wav');await writeFile(file,'first actual bytes');
 try{assert.equal((await s.controller.registerMaterial(s.project,'assets/change.wav')).state,'unknown');const before=JSON.parse(await readFile(join(s.project.path,'.film','orange-materials.json'),'utf8'));await writeFile(file,'different actual bytes');assert.equal((await s.controller.materialStatus(s.project,'assets/change.wav')).state,'stale');assert.equal((await s.controller.registerMaterial(s.project,'assets/change.wav')).state,'unknown');const after=JSON.parse(await readFile(join(s.project.path,'.film','orange-materials.json'),'utf8'));assert.equal(after.records.length,2);assert.deepEqual(after.records[0],before.records[0]);assert.notEqual(keys[0],keys[1]);}finally{await s.controller.dispose();}
});

test('material signout aborts but waits actual transport/body and closes the real source FD before releasing its reservation',async()=>{
 const {createRequire,syncBuiltinESMExports}=await import('node:module'),fs=createRequire(import.meta.url)('node:fs/promises'),original=fs.open;let held,entered,finish,signal;const ready=new Promise(r=>entered=r),response=new Promise(r=>finish=r);
 fs.open=async(...args)=>{const fd=await original(...args);if(String(args[0]).endsWith('hold.wav'))held=fd;return fd;};syncBuiltinESMExports();
 let s;try{s=await businessController(async(url,init)=>{signal=init.signal;for await(const b of init.body)assert.ok(b.length);entered();return response;});await mkdir(join(s.project.path,'assets'));await writeFile(join(s.project.path,'assets','hold.wav'),'held actual source');const work=s.controller.registerMaterial(s.project,'assets/hold.wav');const rejected=assert.rejects(work,e=>e.code==='authentication-required');await ready;assert.ok((await held.stat()).isFile());let done=false;const out=s.controller.signOut();void out.then(()=>done=true);assert.equal(signal.aborted,true);await new Promise(r=>setTimeout(r,5));assert.equal(done,false);assert.equal(JSON.parse(await readFile(join(s.home,'coord','registry.json'),'utf8')).reservations.length,1);finish(Response.json({assetId:A,versionId:B,registration:'registered',licensed:false}));await rejected;await out;await assert.rejects(held.stat(),e=>e.code==='EBADF');assert.equal(JSON.parse(await readFile(join(s.project.path,'.film','orange-materials.json'),'utf8')).records[0].state,'unknown');s.setBusinessSubject(B);assert.equal((await s.controller.signIn(input)).ok,true);await assert.rejects(s.controller.materialStatus(s.project,'assets/hold.wav'),e=>e.code==='project-access-denied');}
 finally{fs.open=original;syncBuiltinESMExports();finish?.(Response.json({}));await s?.controller.dispose();}
});

test('same-owner material association reopens with the same request key; wrong origin and altered metadata cannot be adopted',async()=>{
 const keys=[];const s=await businessController(async(url,init)=>{keys.push(init.headers['idempotency-key']);for await(const b of init.body)assert.ok(b.length);throw Error('synthetic unknown');});await mkdir(join(s.project.path,'assets'));await writeFile(join(s.project.path,'assets','reopen.wav'),'same source');await s.controller.registerMaterial(s.project,'assets/reopen.wav');await s.controller.dispose();
 const configuration={environmentId:'isolated-test',authOrigin:'https://auth.invalid',publishableKey:'public-fixture',businessOrigin:'http://127.0.0.1:18572'};
 const dependencies={fetch:async(url,init)=>{if(url.includes('/token?'))return Response.json({access_token:'synthetic-reopen',refresh_token:'synthetic-refresh',token_type:'bearer',expires_in:60,user:{id:A}});if(url.endsWith('/auth/v1/user'))return Response.json({id:A,is_anonymous:false});if(url.includes('/logout'))return new Response(null,{status:204});for await(const b of init.body)assert.ok(b.length);keys.push(init.headers['idempotency-key']);return Response.json({assetId:A,versionId:B,registration:'registered',licensed:false});},monotonicNow:()=>20,retire:async()=>{},onState(){}};
 const opened=mod.createDesktopAuth({configuration,home:s.home,projects:s.projects,coordinationRoot:join(s.home,'coord'),instanceId:'material-reopen'},dependencies);try{assert.equal((await opened.signIn(input)).ok,true);assert.equal((await opened.materialStatus(s.project,'assets/reopen.wav')).state,'unknown');assert.equal((await opened.registerMaterial(s.project,'assets/reopen.wav')).state,'registered');assert.equal(keys[0],keys[1]);assert.deepEqual(await opened.materialVersionForSource(s.project,'assets/reopen.wav'),{assetId:A,versionId:B});const file=join(s.project.path,'.film','orange-materials.json'),data=JSON.parse(await readFile(file,'utf8'));await opened.signOut();configuration.businessOrigin='http://127.0.0.1:18622';assert.equal((await opened.signIn(input)).ok,true);await assert.rejects(opened.materialStatus(s.project,'assets/reopen.wav'),e=>e.code==='material-metadata-unconfirmed','a newly bound business origin cannot adopt the old origin association');data.serviceScope='0'.repeat(64);const bytes=JSON.stringify(data);await writeFile(file,bytes);await assert.rejects(opened.registerMaterial(s.project,'assets/reopen.wav'),e=>e.code==='material-metadata-unconfirmed');assert.equal(await readFile(file,'utf8'),bytes);}finally{await opened.dispose();}
});

test('material upload retires the actual body iterator even if transport replies before asking for its completion',async()=>{
 let iterator;const s=await businessController(async(url,init)=>{iterator=init.body[Symbol.asyncIterator]();const first=await iterator.next();assert.ok(first.value.length);return Response.json({assetId:A,versionId:B,registration:'registered',licensed:false});});await mkdir(join(s.project.path,'assets'));await writeFile(join(s.project.path,'assets','early.wav'),'actual streamed bytes');
 try{await s.controller.registerMaterial(s.project,'assets/early.wav');assert.deepEqual(await iterator.next(),{value:undefined,done:true},'the owned body is actually done, not a detached source iterator after FD close');}finally{await s.controller.dispose();}
});

test('hardlinked private material metadata is refused without resetting its prior bytes or uploading',async()=>{
 const {link}=await import('node:fs/promises');let calls=0;const s=await businessController(async(url,init)=>{calls++;for await(const b of init.body)assert.ok(b.length);throw Error('unknown');});await mkdir(join(s.project.path,'assets'));await writeFile(join(s.project.path,'assets','hardlink.wav'),'source preserved');
 try{await s.controller.registerMaterial(s.project,'assets/hardlink.wav');const file=join(s.project.path,'.film','orange-materials.json'),prior=await readFile(file);await link(file,file+'.kept-alias');await assert.rejects(s.controller.registerMaterial(s.project,'assets/hardlink.wav'),e=>['control-invalid','material-metadata-unconfirmed'].includes(e.code));assert.deepEqual(await readFile(file),prior);assert.equal(calls,1);}finally{await s.controller.dispose();}
});

test('epoch invalidation during actual final atomic association save cannot return registered to the retired caller',async()=>{
 const {createRequire,syncBuiltinESMExports}=await import('node:module'),fs=createRequire(import.meta.url)('node:fs/promises'),original=fs.rename;let writes=0,entered,release,s;const ready=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 fs.rename=async(...args)=>{if(String(args[1]).endsWith('orange-materials.json')&&++writes===2){entered();await held;}return original(...args);};syncBuiltinESMExports();
 try{s=await businessController(async(url,init)=>{for await(const b of init.body)assert.ok(b.length);return Response.json({assetId:A,versionId:B,registration:'registered',licensed:false});});await mkdir(join(s.project.path,'assets'));await writeFile(join(s.project.path,'assets','late-save.wav'),'actual source');const work=s.controller.registerMaterial(s.project,'assets/late-save.wav'),denied=assert.rejects(work,e=>e.code==='authentication-required');await ready;const out=s.controller.signOut();release();await denied;await out;assert.throws(()=>s.controller.assertActive());}
 finally{release?.();fs.rename=original;syncBuiltinESMExports();await s?.controller.dispose();}
});

test('a genuine source edit during final atomic save cannot return a registered association for the changed bytes',async()=>{
 const {createRequire,syncBuiltinESMExports}=await import('node:module'),fs=createRequire(import.meta.url)('node:fs/promises'),original=fs.rename;let writes=0,entered,release,s;const ready=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 fs.rename=async(...args)=>{if(String(args[1]).endsWith('orange-materials.json')&&++writes===2){entered();await held;}return original(...args);};syncBuiltinESMExports();
 try{s=await businessController(async(url,init)=>{for await(const b of init.body)assert.ok(b.length);return Response.json({assetId:A,versionId:B,registration:'registered',licensed:false});});await mkdir(join(s.project.path,'assets'));const file=join(s.project.path,'assets','changed-save.wav');await writeFile(file,'original source');const work=s.controller.registerMaterial(s.project,'assets/changed-save.wav'),denied=assert.rejects(work,e=>e.code?.startsWith('source-'));await ready;await writeFile(file,'new actual bytes');release();await denied;assert.equal((await s.controller.materialStatus(s.project,'assets/changed-save.wav')).state,'stale');assert.equal(await readFile(file,'utf8'),'new actual bytes');}
 finally{release?.();fs.rename=original;syncBuiltinESMExports();await s?.controller.dispose();}
});

test('a native filename outside the qualified registration bound cannot poison the existing association file',async()=>{
 let calls=0;const s=await businessController(async(url,init)=>{calls++;for await(const b of init.body)assert.ok(b.length);return Response.json({assetId:A,versionId:B,registration:'registered',licensed:false});});await mkdir(join(s.project.path,'assets'));await writeFile(join(s.project.path,'assets','normal.wav'),'source');
 try{await s.controller.registerMaterial(s.project,'assets/normal.wav');const file=join(s.project.path,'.film','orange-materials.json'),before=await readFile(file),name='a'.repeat(129)+'.wav';await writeFile(join(s.project.path,'assets',name),'retained local bytes');await assert.rejects(s.controller.registerMaterial(s.project,'assets/'+name),e=>e.code==='invalid-material-source');assert.deepEqual(await readFile(file),before);assert.equal(calls,1);assert.equal((await s.controller.materialStatus(s.project,'assets/normal.wav')).state,'registered');}finally{await s.controller.dispose();}
});

test('material real source FD close failure keeps preservation locked and reservation held; fixture cleanup cannot clear failure',async()=>{
 const {createRequire,syncBuiltinESMExports}=await import('node:module'),fs=createRequire(import.meta.url)('node:fs/promises'),originalOpen=fs.open;
 const injected=Object.assign(new Error('synthetic actual source close refusal'),{code:'EIO'});let held,physicalClose,s,fenced=false;
 fs.open=async(...args)=>{const fd=await originalOpen(...args);if(String(args[0]).endsWith('preserve-close.wav')){held=fd;physicalClose=fd.close.bind(fd);fd.close=async()=>{throw injected;};}return fd;};syncBuiltinESMExports();
 try{
  s=await businessController(async()=>assert.fail('status close failure must not call a backend'));await mkdir(join(s.project.path,'assets'));await writeFile(join(s.project.path,'assets','preserve-close.wav'),'actual retained source bytes');
  let requestError;await s.controller.materialStatus(s.project,'assets/preserve-close.wav').catch(error=>{requestError=error;});const openBefore=(await held.stat()).isFile();await s.controller.signOut();s.setBusinessSubject(B);const activation=await s.controller.signIn(input),disposal=await s.controller.dispose(),reservation=JSON.parse(await readFile(join(s.home,'coord','registry.json'),'utf8')).reservations.length,openAfter=(await held.stat()).isFile();
  await writeFile(join(root,'material-close-'+process.pid+'.json'),JSON.stringify({requestCode:requestError?.code,causalCode:requestError?.cause?.code,openBefore,openAfter,activation:{ok:activation.ok,code:activation.code},disposal,reservation,fixtureCleanupNotYetRun:true}));
  assert.equal(requestError?.code,'source-preservation-failed');assert.equal(requestError.cause,injected,'preserve actual close failure cause');assert.equal(openBefore,true);assert.equal(openAfter,true);assert.equal(disposal.confirmed,false);assert.equal(reservation,1);assert.equal(activation.ok,false);fenced=true;
 }finally{
  fs.open=originalOpen;syncBuiltinESMExports();if(held&&physicalClose){held.close=physicalClose;await physicalClose();await assert.rejects(held.stat(),e=>e.code==='EBADF');}
  if(s){const after=await s.controller.dispose();if(fenced){assert.equal(after.confirmed,false,'manual fixture closure does not prove earlier product close or clear the failed latch');assert.equal(JSON.parse(await readFile(join(s.home,'coord','registry.json'),'utf8')).reservations.length,1);}}
 }
});

test('business configuration retains legacy login and permits only the explicit optional trusted backend origin',async()=>{
 const home=await mkdtemp(join(root,'business-config-')),file=join(home,'config.json');
 const value={...configuration,businessOrigin:'http://127.0.0.1:18572'};await writeFile(file,JSON.stringify(value));
 assert.deepEqual(mod.readDesktopAuthConfiguration({ORANGE_AUTH_CONFIG_FILE:file}),value);
 const s=await setup({configuration:value});assert.equal((await s.controller.signIn(input)).ok,true);assert.equal(typeof s.controller.business?.resolve,'function');await s.controller.dispose();
});

async function businessController(handler,retire=async()=>{}){
 let subject=A;
 const s=await setup({configuration:{...configuration,businessOrigin:'http://127.0.0.1:18572'},retire,dependencies:{fetch:async(url,init)=>{
  if(url.includes('/auth/v1/token?'))return Response.json({access_token:subject===A?'only-private-access':'only-private-access-b',refresh_token:'only-private-refresh',token_type:'bearer',expires_in:60,user:{id:subject}});
  if(url.endsWith('/auth/v1/user'))return Response.json({id:subject,is_anonymous:false});
  if(url.includes('/auth/v1/logout'))return new Response(null,{status:204});
  return handler(url,init);
 }}});
 assert.equal((await s.controller.signIn(input)).ok,true,'optional business config must not break native login');
 const project={id:'opaque-business-'+Date.now(),path:join(s.projects,'owned')};await mkdir(project.path);await writeFile(join(project.path,'film.html'),'native film');await s.controller.registerCreatedProject(project);return {...s,project,setBusinessSubject:value=>{subject=value;}};
}

test('business controller requires an owned project and keeps the current token entirely in the service closure',async()=>{
 let calls=0;const s=await businessController(async(url,init)=>{calls++;assert.equal(init.headers.authorization,'Bearer only-private-access');return Response.json({materials:[]});});
 try{
  const reply=await s.controller.business.resolve(s.project,{purpose:'studio',versionIds:[]});assert.equal(reply.status,200);
  await assert.rejects(s.controller.business.resolve({...s.project,id:'foreign'},{purpose:'studio',versionIds:[]}),e=>e.code==='project-access-denied');assert.equal(calls,1);
  assert.doesNotMatch(JSON.stringify(s.controller.getPublicState())+await readFile(join(s.home,'orange-project-owners.json'),'utf8'),/only-private/);
 }finally{await s.controller.dispose();}
});

test('business retirement seals immediately and cannot release its reservation before the actual request settles',async()=>{
 let finish,entered;const transport=new Promise(r=>finish=r),ready=new Promise(r=>entered=r);let signal;
 const s=await businessController(async(url,init)=>{signal=init.signal;entered();return transport;});
 const pending=s.controller.business.resolve(s.project,{purpose:'studio',versionIds:[]});const rejected=assert.rejects(pending,e=>/authentication|required|superseded|disposed/.test(e.code));await ready;
 let retired=false;const out=s.controller.signOut();void out.then(()=>retired=true);
 assert.equal(signal.aborted,true);assert.throws(()=>s.controller.assertActive());assert.equal((await s.controller.signIn(input)).code,'preservation-pending');
 await new Promise(r=>setTimeout(r,10));assert.equal(retired,false);
 const before=JSON.parse(await readFile(join(s.home,'coord','registry.json'),'utf8'));assert.equal(before.reservations.length,1);
 finish(Response.json({materials:[]}));await rejected;await out;const after=JSON.parse(await readFile(join(s.home,'coord','registry.json'),'utf8'));assert.equal(after.reservations.length,0);
 s.setBusinessSubject(B);assert.equal((await s.controller.signIn(input)).ok,true);assert.equal(s.controller.ownsProject(s.project),false,'A response/owner must never become a B capability');
 await s.controller.dispose();
});

test('business expiry fences pending operations before accepting their response, and the original utility injects only its private adapter',async()=>{
 let finish,entered;const pending=new Promise(r=>finish=r),ready=new Promise(r=>entered=r);
 const s=await businessController(async()=>{entered();return pending;});const work=s.controller.business.resolve(s.project,{purpose:'studio',versionIds:[]});const denied=assert.rejects(work,e=>e.code==='authentication-required');await ready;
 s.setTime(60010);assert.equal(s.controller.getPublicState().kind,'expired');assert.throws(()=>s.controller.assertActive());finish(Response.json({materials:[]}));await denied;await s.controller.dispose();
 const source=await readFile(new URL('./studio-process.mjs',import.meta.url),'utf8');assert.match(source,/fissionOptions:\s*\{\s*business:\s*desktopAuth\.business\s*\}/,'actual original utility startup must pass its private controller adapter, not accept renderer installation');
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
  await e.controller.dispose();assert.equal((await s.controller.dispose()).confirmed,false);
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

async function actualMainRetirement(directory, retireAgents = async()=>{}) {
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
  const create=new Function('writeWindowState','directory','views','retireAgents',`
    let win={isMaximized:()=>false,isFullScreen:()=>false,getNormalBounds:()=>({x:1,y:2,width:1000,height:700})};
    let state={},tabs={saved:()=>({tabs:[{id:'native-project'}],active:0})},accountStateDir=directory,desktopAuthActive=true,agentResourcesUsed=false;
    const HOME='home';${savedSource}\nconst retire=${retireSource};return {retire,saveState,snapshot:()=>({accountStateDir,tabs,views:views.size})};`);
  return {caller:create(writeWindowState,directory,views,retireAgents),destroyed:()=>destroyed};
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
 assert.equal((await s.controller.dispose()).confirmed,false);assert.deepEqual(events,[]);
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
// Forward T03.quit: no successful process exit or permanently disposed UI after a refused activation.
test('failed controller disposal propagates preservation failure rather than a false success',async()=>{
 const s=await setup({retire:async()=>{throw Error('parent window unavailable');}});await s.controller.signIn(input);
 assert.deepEqual(await s.controller.dispose(),{confirmed:false,reason:'preservation-failed'});
});
test('workspace rejection publishes the same retryable state as the final public and HTTP result',async()=>{
 const first=await setup();await first.controller.signIn(input);
 const events=[];const second=mod.createDesktopAuth({configuration,home:first.home,projects:first.projects,coordinationRoot:join(first.home,'coord'),instanceId:'samecoord-reopen'}, {fetch:async url=>url.includes('/token?')?Response.json({access_token:'fixture',refresh_token:'fixture',token_type:'bearer',expires_in:60,user:{id:A}}):Response.json({id:A,is_anonymous:false}),monotonicNow:()=>10,retire:async()=>{},onState:state=>events.push(state)});
 const result=await second.signIn(input);assert.equal(result.code,'project-access-denied');assert.deepEqual(events.at(-1),second.getPublicState());assert.deepEqual(result.state,second.getPublicState());assert.equal(result.state.kind,'signed-out');await first.controller.dispose();await second.dispose();
});
test('successful actual disposal releases the same guard namespace for a reopened controller',async()=>{
 const s=await setup();await s.controller.signIn(input);await s.controller.dispose();
 const reopened=mod.createDesktopAuth({configuration,home:s.home,projects:s.projects,coordinationRoot:join(s.home,'coord'),instanceId:'actual-reopen'}, {fetch:async url=>url.includes('/token?')?Response.json({access_token:'fixture',refresh_token:'fixture',token_type:'bearer',expires_in:60,user:{id:A}}):Response.json({id:A,is_anonymous:false}),monotonicNow:()=>10,retire:async()=>{},onState:()=>{}});
 assert.equal((await reopened.signIn(input)).ok,true);await reopened.dispose();
});

test('actual main waits for the Agent retirement receipt before destroying original project views',async()=>{
 const directory=await mkdtemp(join(root,'main-agent-retire-'));let release;const pending=new Promise(r=>release=r);
 const observed=await actualMainRetirement(directory,()=>pending),closing=observed.caller.retire();
 await Promise.resolve();assert.equal(observed.destroyed(),0);release({confirmed:true});assert.equal(await closing,true);assert.equal(observed.destroyed(),1);
});

test('unknown original source preservation cannot release its real controlled reservation on dispose',async()=>{
 const s=await setup();await s.controller.signIn(input);
 await assert.rejects(s.controller.runNative(async()=>{throw Object.assign(Error('synthetic native unknown source close'),{code:'source-preservation-failed'});}),{code:'source-preservation-failed'});
 const outcome=await s.controller.dispose().catch(()=>({confirmed:false}));assert.equal(outcome.confirmed,false);
 const registry=JSON.parse(await readFile(join(s.home,'coord','registry.json'),'utf8'));assert.equal(registry.reservations.length,1,'unknown original source resources must retain their barrier');
});
// Forward P1: real original controller/utility bytes and native HTTP/WS/film, not renderer locking.
async function quitAuthorityFixture(directory) {
 const {fileURLToPath,pathToFileURL}=await import('node:url'),{spawn}=await import('node:child_process'),{EventEmitter}=await import('node:events');
 const sourceRoot=fileURLToPath(new URL('../../../',import.meta.url)),source=await readFile(new URL('./studio-process.mjs',import.meta.url),'utf8');
 const stopStart=source.indexOf('async function stop() {'),stopEnd=source.indexOf('\n/** the folders',stopStart),messageStart=source.indexOf("parent.on('message', ({ data }) => {"),messageEnd=source.indexOf('\n});',messageStart)+4;
 const retirement=/retire:(async\(\)=>\{[\s\S]*?\n  \}),\n  \/\/ Only/.exec(source);assert.ok(stopStart>=0&&stopEnd>stopStart&&messageStart>=0&&messageEnd>messageStart&&retirement,'actual utility source extraction must match');
 const utilitySource=source.slice(stopStart,stopEnd),messageSource=source.slice(messageStart,messageEnd),retireSource=retirement[1],script=join(directory,'actual-utility-fixture.mjs');
 await writeFile(script,`import {mkdir} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {pathToFileURL} from 'node:url';
 const base=${JSON.stringify(sourceRoot)},own=${JSON.stringify(directory)};
 const {resolveIsolationProfile,isolationEnvironment}=await import(pathToFileURL(join(base,'packages/openfilm/src/development-isolation.mjs')));
 const baseRoot=join(own,'profiles'),profile=resolveIsolationProfile({baseRoot,instanceId:'quit-authority',taskId:'T03_QUIT',attemptId:'actual-'+process.pid,ports:{studio:18551,film:18552}},{approvedBaseRoot:baseRoot});for(const dir of Object.values(profile.paths))await mkdir(dir,{recursive:true});Object.assign(process.env,isolationEnvironment(profile));
 const {createDesktopAuth}=await import(pathToFileURL(join(base,'apps/desktop/src/desktop-auth.mjs'))),{startStudio}=await import(pathToFileURL(join(base,'packages/openfilm/studio/server/server.mjs')));
 let studio=null,stopping=false,parentRetirement=null,working=[];const asking=new Map(),send=message=>process.send(message),parent={on:(name,fn)=>process.on(name,data=>fn({data}))};
 ${utilitySource}
 ${messageSource}
 const configuration={environmentId:'fixture-authority',authOrigin:'https://auth.invalid',publishableKey:'public-fixture'},subject='11111111-1111-4111-8111-111111111111',coord=join(profile.paths.home,'.orange-coordination');
 const desktopAuth=createDesktopAuth({configuration,home:profile.paths.home,sharedHome:profile.paths.sharedHome,projects:profile.paths.projects,coordinationRoot:coord,instanceId:'actual-child'},{fetch:async url=>url.includes('/token?')?Response.json({access_token:'synthetic',refresh_token:'synthetic',token_type:'bearer',expires_in:600,user:{id:subject}}):Response.json({id:subject,is_anonymous:false}),monotonicNow:()=>10,onState:state=>send({type:'auth-fixture',state}),retire:${retireSource}});
 const signed=await desktopAuth.signIn({email:'fixture@example.invalid',password:'synthetic-only'});if(!signed.ok)throw Error('fixture signin failed');
 const {createProject}=await import(pathToFileURL(join(base,'packages/openfilm/studio/server/projects.mjs')));const project=await desktopAuth.runNative(()=>createProject('Authoritative quit fixture'));
 const editor=join(profile.root,'editor');await mkdir(editor);await (await import('node:fs/promises')).writeFile(join(editor,'index.html'),'<html>original isolated shell fixture</html>');
 studio=await desktopAuth.runNative(()=>startStudio({port:18551,key:'synthetic-quit-key',isolation:true,advertise:false,desktopAuth,editorDir:editor,openBrowser:()=>{throw Error('no browser');}}));send({type:'fixture-ready',origin:studio.origin,filmOrigin:studio.filmOrigin,coord,projectId:project.id,projectPath:project.path});`);
 const events=new EventEmitter(),child=spawn(process.execPath,[script],{cwd:directory,env:{...process.env},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let stderr='',exit=null,close=null;child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',()=>{});const closed=new Promise(resolve=>child.once('close',(code,signal)=>{close={code,signal};resolve(close);}));child.once('exit',(code,signal)=>exit={code,signal});child.on('message',message=>events.emit(message.type,message));
 const wait=(name,timeout=5000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture '+name+' deadline')),timeout);events.once(name,value=>{clearTimeout(timer);resolve(value);});});
 const ready=await wait('fixture-ready');return {child,events,wait,ready,closed,observed:()=>({exit,close,stderr}),send:data=>child.send(data)};
}
for(const rejectAgent of [false,true])test('native quit seals authoritative HTTP WS film during Agent wait and preserves rejection='+rejectAgent,async()=>{
 const directory=await mkdtemp(join(root,'quit-authority-')),fixture=await quitAuthorityFixture(directory),{quitAfterStudio}=await import('./window-lifecycle.mjs'),{connect}=await import('node:net');
 let release,reject;const agents=new Promise((yes,no)=>{release=yes;reject=no;});void agents.catch(()=>{});let quits=0,failures=0,mainSealed=false;
 const window=await actualMainRetirement(directory,()=>agents);
 fixture.events.on('auth-retire',message=>{void window.caller.retire().then(ok=>fixture.send({type:'auth-parent-retired',id:message.id,ok}),()=>fixture.send({type:'auth-parent-retired',id:message.id,ok:false}));});
 const studio={quit(){fixture.send({type:'quit'});return fixture.closed.then(result=>{if(result.code!==0||result.signal)throw Error('utility preservation failed');});}};
 const closing=quitAfterStudio({preventDefault(){}},{quitting:false,markQuitting(){},studio,closeAgents:()=>{mainSealed=true;return agents;},quit:()=>quits++,confirmQuit(){},onFailure:()=>failures++});
 const api=async suffix=>{const response=await fetch(fixture.ready.origin+suffix,{headers:{'x-studio-key':'synthetic-quit-key',origin:fixture.ready.origin,connection:'close'},signal:AbortSignal.timeout(3000)});return {status:response.status,value:await response.json()};};
 try{
 await new Promise(r=>setTimeout(r,100));assert.equal(mainSealed,true);assert.equal((await api('/api/projects')).status,403,'not just main UI: original utility must already reject business while Agent is pending');assert.notEqual((await api('/api/auth/state')).value.kind,'active');
 const next=await fetch(fixture.ready.origin+'/api/auth/sign-in',{method:'POST',headers:{'x-studio-key':'synthetic-quit-key',origin:fixture.ready.origin,'content-type':'application/json',connection:'close'},body:JSON.stringify({email:'b@example.invalid',password:'synthetic-only'}),signal:AbortSignal.timeout(3000)});assert.equal((await next.json()).ok,false,'pending authoritative retirement cannot activate B');
 const before=await readFile(join(fixture.ready.projectPath,'film.html'));const edit=await fetch(fixture.ready.origin+'/api/projects/'+fixture.ready.projectId+'/edit',{method:'POST',headers:{'x-studio-key':'synthetic-quit-key',origin:fixture.ready.origin,'content-type':'application/json',connection:'close'},body:JSON.stringify({base:null,ops:[{op:'stage',w:1080,h:1920}]}),signal:AbortSignal.timeout(3000)});assert.equal(edit.status,403);await edit.text();assert.deepEqual(await readFile(join(fixture.ready.projectPath,'film.html')),before,'denied native edit leaves actual film bytes unchanged');
 const film=await fetch(fixture.ready.filmOrigin+'/p/'+fixture.ready.projectId+'/film.html',{signal:AbortSignal.timeout(3000)});assert.equal(film.status,403);await film.text();
 const ws=await new Promise((resolve,reject)=>{const socket=connect({host:'127.0.0.1',port:18551});let text='';socket.on('connect',()=>socket.write('GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:18551\r\nOrigin: '+fixture.ready.origin+'\r\nx-studio-key: synthetic-quit-key\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: c3ludGhldGljLXRlc3Q=\r\nSec-WebSocket-Version: 13\r\n\r\n'));socket.on('data',bytes=>text+=bytes);socket.on('error',reject);socket.on('close',()=>resolve(text));});assert.match(ws,/^HTTP\/1\.1 403/);
 const pending=JSON.parse(await readFile(join(fixture.ready.coord,'registry.json'),'utf8'));assert.equal(pending.reservations.length,1);
 if(rejectAgent)reject(Error('actual Agent retirement refused'));else release({confirmed:true});await closing;await fixture.closed;
 assert.equal(fixture.observed().exit.code,rejectAgent?1:0);assert.equal(fixture.observed().close.signal,null);assert.equal(quits,rejectAgent?0:1);assert.equal(failures,rejectAgent?1:0);assert.equal(window.destroyed(),rejectAgent?0:1);
 const registry=JSON.parse(await readFile(join(fixture.ready.coord,'registry.json'),'utf8'));assert.equal(registry.reservations.length,rejectAgent?1:0);
 }finally{
 release?.({confirmed:true});if(!fixture.observed().close){fixture.send({type:'quit'});await Promise.race([fixture.closed,new Promise(r=>setTimeout(r,5000))]);if(!fixture.observed().close)fixture.child.kill();}
 await closing;
 }
});
