import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';import {randomUUID,createHash} from 'node:crypto';import {createRequire,syncBuiltinESMExports} from 'node:module';
import {verifyBearer} from './supabase.ts';import {createAdmission,requestDigest} from './admission.ts';import {createApiServer} from './server.ts';
const repositoryRoot=fileURLToPath(new URL('../../../',import.meta.url)),sourceRoot=path.dirname(fileURLToPath(import.meta.url));
const material=await import('./materials.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return null;throw error;});
test('material producer is a real native-probe/DB registration and FD service, not a caller approval oracle',async()=>{
 assert.equal(typeof material?.createMaterials,'function','actual material entity service is implemented');
 assert.ok((await fs.stat(path.join(sourceRoot,'server.ts'))).isFile(),'actual child API source root is the original current source directory, independent of cwd');
});
const own=process.env.ORANGE_MATERIAL_TEST_ROOT!;assert.ok(own&&path.resolve(own).startsWith(path.join(repositoryRoot,'.dev/material-producer')+path.sep));
const support=await import(pathToFileURL(path.join(own,'rpc.mjs')).href),sessions=JSON.parse(await fs.readFile(path.join(own,'sessions.json'),'utf8'));
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',q=support.quote;
const cp=createRequire(import.meta.url)('node:child_process'),nativeExec=cp.execFile,processes:any[]=[];let holdProbe:((release:()=>void)=>void)|null=null;
cp.execFile=function(...args:any[]){if(holdProbe&&String(args[0]).toLowerCase().includes('ffprobe')){const callback=args.at(-1),held=holdProbe;holdProbe=null;args[args.length-1]=(...values:any[])=>held(()=>callback(...values));}const child=Reflect.apply(nativeExec,this,args) as import('node:child_process').ChildProcess;if(String(args[0]).toLowerCase().includes('ffprobe')){const receipt:any={pid:child.pid,exit:null,close:null};processes.push(receipt);child.once('exit',(code:number,signal:string)=>receipt.exit={code,signal});child.once('close',(code:number,signal:string)=>receipt.close={code,signal});}return child;};syncBuiltinESMExports();
test.after(async()=>{cp.execFile=nativeExec;syncBuiltinESMExports();await fs.writeFile(path.join(own,'native-probe-processes-'+process.pid+'.json'),JSON.stringify(processes,null,2));assert.ok(processes.every(p=>p.exit&&p.close&&p.exit.code===p.close.code&&p.close.signal===null),'actual native ffprobe exit+close receipts including deliberate corrupt media refusal');});
const ctx=async(actor=A)=>{const token='eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({sub:actor,session_id:actor===A?sessions.A:sessions.B,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated',aud:'authenticated',iss:'https://material.supabase.co/auth/v1'})).toString('base64url')+'.synthetic';return verifyBearer({environmentId:'local-material',supabaseOrigin:'https://material.supabase.co',publishableKey:'synthetic-public'},'Bearer '+token,async()=>Response.json({id:actor,is_anonymous:false}));};
const fail=(code:string)=>(e:any)=>e?.code===code;
async function setup(review=false){const root=path.join(own,'store-'+randomUUID()),calls:string[]=[];const rpc=async(op:string,args:any)=>{calls.push(op);return support.rpc(op,args);};return {root,calls,rpc,service:await material!.createMaterials({environmentId:'local-material',materialRoot:root},{rpc,requireReview:()=>review})};}
const body=(bytes:Uint8Array)=>({async *[Symbol.asyncIterator](){yield bytes;}});
const bytes=(name:string)=>fs.readFile(path.join(own,'media',name));
async function register(s:any,name='audio.wav',key=randomUUID()){return s.service.register(await ctx(),{key,name},body(await bytes(name)));}
async function license(version:string,purposes=['studio','fission','export']){await support.sql(`insert into orange_business.licenses values('${randomUUID()}',${q(version)},${q(A)},1,ARRAY[${purposes.map(q).join(',')}],now()+interval '1 hour',false,'explicit synthetic local rights fixture');`);}
const inside=(file:string)=>{assert.ok(path.resolve(file).startsWith(path.resolve(own)+path.sep));return file;};

test('actual MP4 WAV PNG bytes use native probe and persist immutable exact versions without granting licenses or reviews',async()=>{
 const s=await setup();try{for(const [name,kind]of [['video.mp4','video'],['audio.wav','sound'],['still.png','still']]){const r=await register(s,name);assert.equal(r.licensed,false);assert.equal(r.registration,'registered');assert.doesNotMatch(JSON.stringify(r),/locator|handle|fileName|store-/);
 const db=await support.sql(`select json_build_object('kind',kind,'duration',duration_sec,'licenses',(select count(*) from orange_business.licenses where version_id=v.id),'reviews',(select count(*) from orange_business.material_reviews where version_id=v.id)) from orange_business.asset_versions v where id=${q(r.versionId)}`);const v=JSON.parse(db.stdout.trim());assert.equal(v.kind,kind);assert.equal(v.licenses,0);assert.equal(v.reviews,0);if(kind==='still')assert.equal(v.duration,0);else assert.ok(v.duration>3.9&&v.duration<4.1);
 let used=false;const before=s.calls.length;await assert.rejects(s.service.use(await ctx(),[r.versionId],'studio',async()=>{used=true;}),fail('material-unavailable'));assert.equal(used,false);assert.deepEqual(s.calls.slice(before),['resolve_materials']);}}
 finally{await s.service.close();}
});

test('registration samekey response loss and new service restart return original identities without reprobe; changed payload conflicts',async()=>{
 const s=await setup(),key=randomUUID();let first:any;try{first=await register(s,'audio.wav',key);const probes=processes.length;const again=await register(s,'audio.wav',key);assert.deepEqual(again,first);assert.equal(processes.length,probes);await s.service.close();const reopened=await material!.createMaterials({environmentId:'local-material',materialRoot:s.root},{rpc:s.rpc});try{assert.deepEqual(await reopened.register(await ctx(),{key,name:'audio.wav'},body(await bytes('audio.wav'))),first);assert.equal(processes.length,probes);await assert.rejects(reopened.register(await ctx(),{key,name:'different.wav'},body(await bytes('audio.wav'))),fail('idempotency-conflict'));}finally{await reopened.close();}}finally{await s.service.close();}
});

test('fresh exact-version licenses permit real FD reads; another subject and samehash unlicensed aliases do not',async()=>{
 const s=await setup();try{const r=await register(s);await license(r.versionId);const original=await bytes('audio.wav');for(const purpose of ['studio','fission'] as const){const actual=await s.service.use(await ctx(),[r.versionId],purpose,async leases=>{assert.ok(leases[0].handle.fd>=0);const b=Buffer.alloc(original.length);await leases[0].handle.read(b,0,b.length,0);return createHash('sha256').update(b).digest('hex');});assert.equal(actual,createHash('sha256').update(original).digest('hex'));}
 await assert.rejects(s.service.use(await ctx(B),[r.versionId],'studio',async()=>assert.fail()),fail('material-unavailable'));const alias=await register(s);assert.notEqual(alias.versionId,r.versionId);await assert.rejects(s.service.use(await ctx(),[alias.versionId],'studio',async()=>assert.fail()),fail('material-unavailable'));}finally{await s.service.close();}
});

test('trusted required-review policy cannot be replaced by client approved; latest synthetic review and license govern every use',async()=>{
 const s=await setup(true);try{const r=await register(s,'still.png');await license(r.versionId);await assert.rejects(s.service.use(await ctx(),[r.versionId],'studio',async()=>assert.fail()),fail('material-unavailable'));
 for(const [revision,decision,allowed]of [[1,'rejected',false],[2,'approved',true],[3,'withdrawn',false]] as const){await support.sql(`insert into orange_business.material_reviews values(${q(r.versionId)},${revision},${q(A)},${q(decision)},'explicit synthetic reviewer confirmation only');`);if(allowed)assert.equal(await s.service.use(await ctx(),[r.versionId],'studio',async()=>true),true);else await assert.rejects(s.service.use(await ctx(),[r.versionId],'studio',async()=>assert.fail()),fail('material-unavailable'));}
 await assert.rejects(s.service.register(await ctx(),{key:randomUUID(),name:'still.png',approved:true} as any,body(await bytes('still.png'))),fail('invalid-input'));}finally{await s.service.close();}
});

for(const attack of ['replace','hardlink','parent-alias'])test('locator denies actual owned file '+attack+' even when bytes/hash remain identical',async()=>{
 const s=await setup();try{const r=await register(s);await license(r.versionId);let file='';await s.service.use(await ctx(),[r.versionId],'studio',async leases=>{file=inside(leases[0].path);});
 if(attack==='replace'){await fs.rename(file,inside(file+'.preserved'));await fs.copyFile(file+'.preserved',file);}
 if(attack==='hardlink')await fs.link(file,inside(file+'.alias'));
 if(attack==='parent-alias'){const dir=inside(path.dirname(file)),kept=inside(dir+'-preserved');await fs.rename(dir,kept);await fs.symlink(kept,dir,'junction');}
 await assert.rejects(s.service.use(await ctx(),[r.versionId],'studio',async()=>assert.fail()),e=>/material-(?:file-changed|path-denied)/.test((e as any).code));}finally{await s.service.close();}
});

test('stop seals admission but awaits actual consumer and native probe completion; abort is not preservation',async()=>{
 const s=await setup(),r=await register(s);await license(r.versionId);let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);const work=s.service.use(await ctx(),[r.versionId],'fission',async leases=>{entered();await held;assert.equal(leases[0].signal.aborted,true);return true;});const denied=assert.rejects(work,fail('material-cancelled'));await ready;let stopped=false;const closing=s.service.close().then(()=>stopped=true);await Promise.resolve();assert.equal(stopped,false);await assert.rejects(s.service.use(await ctx(),[r.versionId],'studio',async()=>true),fail('material-stopping'));release();await denied;await closing;
 const p=await setup();let finish!:()=>void,arrived!:()=>void;const reached=new Promise<void>(r=>arrived=r);holdProbe=callback=>{finish=callback;arrived();};const registration=register(p,'video.mp4');const rejected=assert.rejects(registration,fail('material-cancelled'));await reached;stopped=false;const drain=p.service.close().then(()=>stopped=true);await Promise.resolve();assert.equal(stopped,false,'opaque original probe callback/cache work is still pending');finish();await rejected;await drain;
});

test('revoked rights during actual consumption cannot yield an accepted result',async()=>{
 const s=await setup();try{const r=await register(s);await license(r.versionId);await assert.rejects(s.service.use(await ctx(),[r.versionId],'studio',async()=>{await support.sql(`update orange_business.licenses set revoked=true where version_id=${q(r.versionId)}`);return 'not an authorized artifact';}),fail('material-unavailable'));}finally{await s.service.close();}
});

test('original API actually ingests bounded local bytes, keeps locator private, and missing config only disables materials',async()=>{
 const s=await setup(),context=await ctx(),verify=async(header:unknown)=>{if(header!=='Bearer synthetic-only')throw Object.assign(Error('authentication-required'),{code:'authentication-required',status:403});return context;},admission=createAdmission({rpc:s.rpc});const api=createApiServer({verify,admission,materials:s.service});await api.listen(18581);
 try{const res=await fetch('http://127.0.0.1:18581/api/materials/local',{method:'POST',headers:{authorization:'Bearer synthetic-only',connection:'close','content-type':'application/octet-stream','idempotency-key':randomUUID(),'x-material-name':'audio.wav'},body:new Uint8Array(await bytes('audio.wav'))});assert.equal(res.status,200);const data=await res.json();assert.equal(data.licensed,false);assert.doesNotMatch(JSON.stringify(data),/locator|handle|store-|source\.wav/);await assert.rejects(s.service.use(context,[data.versionId],'studio',async()=>assert.fail()),fail('material-unavailable'));}finally{await api.close();}
 const absent=createApiServer({verify,admission});await absent.listen(18582);try{const res=await fetch('http://127.0.0.1:18582/api/materials/local',{method:'POST',headers:{authorization:'Bearer synthetic-only',connection:'close'}});assert.equal(res.status,503);await res.text();}finally{await absent.close();}
});

test('forged principals reject asynchronously before any material storage or RPC authority',async()=>{
 const s=await setup();try{const before=s.calls.length;await assert.rejects(s.service.register({subjectId:A} as any,{key:randomUUID(),name:'audio.wav'},body(await bytes('audio.wav'))),fail('authentication-required'));await assert.rejects(s.service.use({subjectId:A} as any,[randomUUID()],'studio',async()=>assert.fail()),fail('authentication-required'));assert.equal(s.calls.length,before);}finally{await s.service.close();}
});

test('actual concurrent PG connections allocate exactly one material identity and reject samekey changed payload',async()=>{
 const context=await ctx(),name='race.wav',data=await bytes('audio.wav'),sha256=createHash('sha256').update(data).digest('hex'),key=randomUUID();const payload=()=>({assetId:randomUUID(),versionId:randomUUID(),locatorId:randomUUID(),fileName:'source.wav',name,sha256,byteLength:data.length,identity:{dev:'1',ino:'1',size:String(data.length),mtimeNs:'1',ctimeNs:'1',nlink:'1'},reviewRequired:false,requestHash:requestDigest({name,sha256,byteLength:data.length,reviewRequired:false})});const args={p_actor:A,p_session:context.sessionId,p_until:new Date(context.expiresAtMs).toISOString(),p_environment:'local-material',p_key:key};
 const [a,b]=await Promise.all([support.rpc('begin_material',{...args,p_payload:payload()}),support.rpc('begin_material',{...args,p_payload:payload()})]);assert.deepEqual([a.created,b.created].sort(),[false,true]);assert.equal(a.assetId,b.assetId);assert.equal(a.versionId,b.versionId);assert.equal(a.locatorId,b.locatorId);await assert.rejects(support.rpc('begin_material',{...args,p_payload:{...payload(),name:'changed.wav',requestHash:requestDigest({name:'changed.wav',sha256,byteLength:data.length,reviewRequired:false})}}),fail('idempotency-conflict'));
});

test('truncated still metadata cannot be invented into a licensed zero-duration version',async()=>{
 const s=await setup(),key=randomUUID();try{const image=await bytes('still.png');await assert.rejects(s.service.register(await ctx(),{key,name:'broken.png'},body(image.subarray(0,image.length-12))),e=>(e as any).code==='material-probe-unconfirmed'||(e as any).status===422);const result=await support.sql(`select count(*) from orange_business.material_ingestions r join orange_business.asset_versions v on v.id=r.version_id where request_key=${q(key)}`);assert.equal(result.stdout.trim(),'0');}finally{await s.service.close();}
});

test('SQL idempotent reply rechecks real session deadline after an actual advisory lock wait',async()=>{
 const s=await setup(),key=randomUUID(),context=await ctx();let blocking:Promise<any>|undefined;
 try{const r=await register(s,'audio.wav',key),raw=await support.sql(`select orange_business.ingestion_reply(r) from orange_business.material_ingestions r where version_id=${q(r.versionId)}`),saved=JSON.parse(raw.stdout.trim());
 const payload={assetId:randomUUID(),versionId:randomUUID(),locatorId:randomUUID(),fileName:saved.fileName,name:saved.name,sha256:saved.sha256,byteLength:saved.byteLength,identity:saved.identity,requestHash:saved.requestHash,reviewRequired:saved.reviewRequired};
 blocking=support.sql(`begin;select pg_advisory_xact_lock(hashtextextended(${q('material:'+A+':'+key)},0));select pg_sleep(3);commit;`);await new Promise(r=>setTimeout(r,200));
 await assert.rejects(support.rpc('begin_material',{p_actor:A,p_session:context.sessionId,p_until:new Date(Date.now()+1000).toISOString(),p_environment:'local-material',p_key:key,p_payload:payload}),fail('authentication-required'));
 }finally{await blocking;await s.service.close();}
});

test('old provider binding revisions deny before any actual locator opens',async()=>{
 const s=await setup();try{const r=await register(s);await license(r.versionId);const binding=randomUUID();await support.sql(`insert into orange_business.bindings values(${q(binding)},${q(A)},2,true,now()+interval '1 hour');update orange_business.assets set source_kind='zhishang',binding_id=${q(binding)},binding_revision=1 where id=${q(r.assetId)};`);const before=s.calls.length;await assert.rejects(s.service.use(await ctx(),[r.versionId],'fission',async()=>assert.fail()),fail('material-unavailable'));assert.deepEqual(s.calls.slice(before),['resolve_materials']);}finally{await s.service.close();}
});

test('actual API process loss after committed registration restarts with exact old version and no second native probe',async()=>{
 const {spawn}=await import('node:child_process'),{EventEmitter}=await import('node:events');const dir=inside(path.join(own,'restart-'+randomUUID()));await fs.mkdir(dir);const store=path.join(dir,'store'),base=sourceRoot;
 async function start(mode:string){const file=path.join(dir,mode+'.mjs');const code=`import {pathToFileURL} from 'node:url';import {createRequire,syncBuiltinESMExports} from 'node:module';
 const own=${JSON.stringify(own)},base=${JSON.stringify(base)},mode=${JSON.stringify(mode)};
 const cp=createRequire(import.meta.url)('node:child_process'),original=cp.execFile,probeReceipts=[];cp.execFile=function(...args){const child=Reflect.apply(original,this,args);if(String(args[0]).includes('ffprobe')){const r={pid:child.pid,exit:null,close:null};probeReceipts.push(r);child.once('exit',(code,signal)=>r.exit={code,signal});child.once('close',(code,signal)=>r.close={code,signal});}return child;};syncBuiltinESMExports();
 const {rpc}=await import(pathToFileURL(own+'/rpc.mjs')),{createMaterials}=await import(pathToFileURL(base+'/materials.ts')),{createApiServer}=await import(pathToFileURL(base+'/server.ts')),{createAdmission}=await import(pathToFileURL(base+'/admission.ts')),{verifyBearer}=await import(pathToFileURL(base+'/supabase.ts'));
 const actor=${JSON.stringify(A)},claims={sub:actor,session_id:${JSON.stringify(sessions.A)},exp:Math.floor(Date.now()/1000)+3600,role:'authenticated',aud:'authenticated',iss:'https://material.supabase.co/auth/v1'},token='eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.synthetic';
 const context=await verifyBearer({environmentId:'local-material',supabaseOrigin:'https://material.supabase.co',publishableKey:'synthetic-public'},'Bearer '+token,async()=>Response.json({id:actor,is_anonymous:false}));
 const entity=await createMaterials({environmentId:'local-material',materialRoot:${JSON.stringify(store)}},{rpc});
 const wrapped={...entity,register:async(...args)=>{const result=await entity.register(...args);process.send({type:'registered',result,probeReceipts});if(mode==='first')await new Promise(()=>{});return result;}};
 const api=createApiServer({verify:async header=>{if(header!=='Bearer synthetic-only')throw Error('no');return context;},admission:createAdmission({rpc}),materials:wrapped});await api.listen(18581);process.on('message',message=>{if(message==='crash')process.exit(19);if(message==='stop')void api.close().then(()=>process.disconnect());});process.send({type:'ready'});`;
 await fs.writeFile(file,code,{flag:'wx'});const child=spawn(process.execPath,[file],{cwd:dir,env:{...process.env},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']}),events=new EventEmitter();let exit:any=null,close:any=null,stderr='',last:any=null;assert.ok(child.stdout&&child.stderr);child.stdout.resume();child.stderr.on('data',b=>stderr+=b);child.on('message',(message:any)=>{if(message.type==='registered')last=message;events.emit(message.type,message);});child.once('exit',(code,signal)=>exit={code,signal});const closed=new Promise<any>(resolve=>child.once('close',async(code,signal)=>{close={code,signal};await fs.writeFile(path.join(dir,mode+'-receipt.json'),JSON.stringify({pid:child.pid,exit,close,expectedFault:mode==='first',last,stderr},null,2));resolve(close);}));const wait=(event:string)=>new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('own API '+event+' deadline')),10000);events.once(event,message=>{clearTimeout(timer);resolve(message);});});await wait('ready');return {child,wait,closed,last:()=>last,close:()=>close};}
 let first:Awaited<ReturnType<typeof start>>|undefined,recovered:Awaited<ReturnType<typeof start>>|undefined;const key=randomUUID(),abort=new AbortController();
 try{first=await start('first');const committed=first.wait('registered');const request=fetch('http://127.0.0.1:18581/api/materials/local',{method:'POST',headers:{authorization:'Bearer synthetic-only',connection:'close','content-type':'application/octet-stream','idempotency-key':key,'x-material-name':'audio.wav'},body:new Uint8Array(await bytes('audio.wav')),signal:abort.signal}).catch(()=>null);const saved=await committed;assert.equal(saved.probeReceipts.length,1);assert.ok(saved.probeReceipts.every((p:any)=>p.exit?.code===0&&p.close?.code===0));abort.abort();await request;first.child.send('crash');assert.equal((await first.closed).code,19,'intentional lost-response process failure, not successful preservation');
 recovered=await start('recovered');const received=recovered.wait('registered');const res=await fetch('http://127.0.0.1:18581/api/materials/local',{method:'POST',headers:{authorization:'Bearer synthetic-only',connection:'close','content-type':'application/octet-stream','idempotency-key':key,'x-material-name':'audio.wav'},body:new Uint8Array(await bytes('audio.wav'))});assert.equal(res.status,200);assert.deepEqual(await res.json(),saved.result);assert.equal((await received).probeReceipts.length,0);recovered.child.send('stop');assert.equal((await recovered.closed).code,0);
 }finally{abort.abort();for(const p of [first,recovered])if(p&&!p.close()){p.child.send('crash');await p.closed;}}
});

test('stop before an entered microtask starts performs no new storage write or RPC',async()=>{
 const s=await setup(),context=await ctx(),data=await bytes('audio.wav'),work=s.service.register(context,{key:randomUUID(),name:'audio.wav'},body(data));const denied=assert.rejects(work,fail('material-cancelled'));const stopped=s.service.close();await denied;await stopped;assert.equal(s.calls.length,0);assert.deepEqual(await fs.readdir(s.root),['orange-material-store.json']);
});
