import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const load=()=>import('./admission.ts');
const fixture=()=>readFile(new URL('../fixtures/prepared-v1.json',import.meta.url),'utf8').then(JSON.parse);
test('actual prepared content has a canonical key independent of project, path/name and export-only scaling',async()=>{
 const m=await load();assert.equal(typeof m.contentKey,'function','real admission content encoder exists');const a=await fixture(),b=structuredClone(a);b.projectId='another opaque project';b.filmRev='fedcba9876543210';b.job.VideoDir='assets/renamed';b.job.Threads=8;b.job.OutWidth=720;b.job.OutHeight=1280;b.scenes[0].name='01 renamed';b.scenes[0].clips[0].atSec=-0;
 assert.match(m.contentKey(a),/^[a-f0-9]{64}$/);assert.equal(m.contentKey(a),m.contentKey(b));assert.notEqual(m.requestDigest(a),m.requestDigest(b));
});
test('changing actual voice/BGM/seconds/crop changes content while immutable reference IDs alone do not',async()=>{
 const m=await load();assert.equal(typeof m.contentKey,'function');const a=await fixture();for(const change of [(b:any)=>b.materials[1].contentSha256='d'.repeat(64),(b:any)=>b.materials[2].contentSha256='e'.repeat(64),(b:any)=>{b.scenes[0].clips[0].fromSec=19;b.scenes[0].clips[0].toSec=24;},(b:any)=>b.scenes[0].clips[0].hflip=true]){const b=structuredClone(a);change(b);assert.notEqual(m.contentKey(a),m.contentKey(b));}
 const b=structuredClone(a),old=b.materials[0].versionId;b.materials[0].versionId='20000000-0000-4000-8000-000000000001';for(const scene of b.scenes)for(const clip of scene.clips)if(clip.versionId===old)clip.versionId=b.materials[0].versionId;assert.equal(m.contentKey(a),m.contentKey(b));
});
test('unknown fields, unresolved effective decisions, bad units and unsafe values refuse preparation',async()=>{
 const m=await load();assert.equal(typeof m.contentKey,'function');const a=await fixture();for(const change of [(b:any)=>b.approved=true,(b:any)=>b.version=2,(b:any)=>b.scenes[0].clips[0].speed=NaN,(b:any)=>b.scenes[0].clips[0].fromSec=-1,(b:any)=>b.materials[0].durationSec=1,(b:any)=>b.job.TransitionSec=0.3]){const b=structuredClone(a);change(b);assert.throws(()=>m.contentKey(b));}
});
test('HTTP supplied prepared/owner/admin fields cannot replace the missing trusted worker producer',async()=>{
 const m=await load();assert.equal(typeof m.createAdmission,'function');let writes=0;const admission=m.createAdmission({rpc:async()=>{writes++;return {};}});await assert.rejects(admission.prepareAndClaim({subjectId:'forged'}, {prepared:await fixture(),owner:'forged',approved:true}),/auth|trusted|prepar|field/i);assert.equal(writes,0);
});

const bearer=(overrides:Record<string,unknown>={})=>['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({sub:'11111111-1111-4111-8111-111111111111',session_id:'22222222-2222-4222-8222-222222222222',exp:Math.floor(Date.now()/1000)+60,role:'authenticated',aud:'authenticated',iss:'https://fixture.supabase.co/auth/v1',...overrides})).toString('base64url'),'fixture-signature'].join('.');
test('backend principal is minted only after the exact Bearer getUser and same sub/session/expiry',async()=>{
 const m=await import('./supabase.ts');assert.equal(typeof m.verifyBearer,'function');const token=bearer(),calls:Array<{url:string;authorization:string|null}>=[];
 const ctx=await m.verifyBearer({environmentId:'fixture',supabaseOrigin:'https://fixture.supabase.co',publishableKey:'public-fixture'},'Bearer '+token,async(url,request)=>{calls.push({url:String(url),authorization:new Headers(request?.headers).get('authorization')});return Response.json({id:'11111111-1111-4111-8111-111111111111',is_anonymous:false});});
 assert.equal(m.isVerifiedSession(ctx),true);assert.equal(m.isVerifiedSession({...ctx}),false);assert.equal(calls.length,1);assert.equal(calls[0].authorization,'Bearer '+token);assert.equal(calls[0].url,'https://fixture.supabase.co/auth/v1/user');assert.ok(!JSON.stringify(ctx).includes(token));
});
test('bad actor/anonymous/service JWT/expired/unknown verification cannot reach business authority',async()=>{
 const m=await import('./supabase.ts');assert.equal(typeof m.verifyBearer,'function');const cfg={environmentId:'fixture',supabaseOrigin:'https://fixture.supabase.co',publishableKey:'public-fixture'};
 for(const [token,user]of [[bearer(),{id:'33333333-3333-4333-8333-333333333333',is_anonymous:false}],[bearer(),{id:'11111111-1111-4111-8111-111111111111',is_anonymous:true}],[bearer({exp:1}),{}],[bearer({role:'service_role'}),{}],[bearer({session_id:null}),{}]])await assert.rejects(m.verifyBearer(cfg,'Bearer '+token,async()=>Response.json(user)));
 await assert.rejects(m.verifyBearer(cfg,'Bearer '+bearer(),async()=>{throw Error('fixture transport offline');}));
});
test('native still has zero intrinsic duration while a prepared positive hold is valid content',async()=>{
 const {contentKey}=await import('./admission.ts'),p=await fixture();p.materials[0].kind='still';p.materials[0].durationSec=0;p.job.ImageDurMinSec=5;p.job.ImageDurMaxSec=5;p.scenes[0].clips[0].fromSec=0;p.scenes[0].clips[0].toSec=5;
 assert.match(contentKey(p),/^[a-f0-9]{64}$/);const changed=structuredClone(p);changed.scenes[0].clips[0].toSec=4;changed.durationSec=4;changed.audio.voice.toSec=4;changed.job.ImageDurMinSec=4;changed.job.ImageDurMaxSec=4;assert.notEqual(contentKey(changed),contentKey(p));
 for(const kind of ['video','sound']){const invalid=structuredClone(p);invalid.materials[0].kind=kind;assert.throws(()=>contentKey(invalid));}
});
test('one actual HTTP backend authenticates and rejects public prepared/owner flags without dispatch',async()=>{
 const m=await import('./server.ts');assert.equal(typeof m.createApiServer,'function');const auth=await import('./supabase.ts'),domain=await import('./admission.ts');let calls=0;
 const cfg={environmentId:'fixture',supabaseOrigin:'https://fixture.supabase.co',publishableKey:'public-fixture'};const api=m.createApiServer({verify:header=>auth.verifyBearer(cfg,header,async()=>Response.json({id:'11111111-1111-4111-8111-111111111111',is_anonymous:false})),admission:domain.createAdmission({rpc:async()=>{calls++;return {status:'prepare-required'};}})});await api.listen(18571);
 try{
 const absent=await fetch('http://127.0.0.1:18571/api/fission/claims',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(absent.status,403);await absent.text();
 const invalid=await fetch('http://127.0.0.1:18571/api/fission/claims',{method:'POST',headers:{authorization:'Bearer '+bearer(),'content-type':'application/json'},body:JSON.stringify({prepared:await fixture(),owner:'forged',approved:true})});assert.equal(invalid.status,422);await invalid.text();assert.equal(calls,0);
 const p=await fixture(),missing=await fetch('http://127.0.0.1:18571/api/fission/claims',{method:'POST',headers:{authorization:'Bearer '+bearer(),'content-type':'application/json'},body:JSON.stringify({groupId:'99999999-9999-4999-8999-999999999999',projectId:p.projectId,filmRev:p.filmRev,job:p.job,idempotencyKey:'missing-native-prepare'})});assert.equal(missing.status,503);assert.equal((await missing.json()).code,'trusted-preparation-unavailable');assert.equal(calls,1);
 }finally{await api.close();}
});
test('explicit external config and server credential reference accept safe native or slash paths but never default env data',async()=>{
 const {mkdir,writeFile}=await import('node:fs/promises'),path=await import('node:path'),{readConfiguration,createSupabase}=await import('./supabase.ts');
 const root=process.env.ORANGE_BUSINESS_TEST_ROOT;if(!root)throw Error('own root required');const dir=path.join(root,'config-'+Date.now());await mkdir(dir,{recursive:true});
 const credentialFile=path.join(dir,'server-credential.json'),file=path.join(dir,'api.json');await writeFile(credentialFile,JSON.stringify({type:'secret',key:'sb_secret_synthetic_only'}));await writeFile(file,JSON.stringify({environmentId:'fixture',supabaseOrigin:'https://fixture.supabase.co',publishableKey:'public-fixture',credentialFile,port:18571}));
 const cfg=await readConfiguration(file.replaceAll('\\','/'));assert.equal(cfg.port,18571);await assert.rejects(readConfiguration(undefined));
 const requests:Array<{url:string;headers:Headers}>=[];const service=createSupabase(cfg,async(url,init)=>{requests.push({url:String(url),headers:new Headers(init?.headers)});return Response.json({status:'prepare-required'});});const result=await service.rpc('preflight',{p_key:'synthetic'});assert.equal(result.status,'prepare-required');assert.equal(requests.length,1);assert.equal(requests[0].headers.get('apikey'),'sb_secret_synthetic_only');assert.equal(requests[0].headers.has('authorization'),false);
 await assert.rejects(service.rpc('arbitrary-sql',{sql:'select *'}));assert.equal(requests.length,1);
});
test('RPC transport never turns malformed success or unexpected SQL/config error into business success',async()=>{
 const {mkdir,writeFile}=await import('node:fs/promises'),path=await import('node:path'),{createSupabase}=await import('./supabase.ts');const root=process.env.ORANGE_BUSINESS_TEST_ROOT;if(!root)throw Error('own root required');const dir=path.join(root,'rpc-'+Date.now());await mkdir(dir,{recursive:true});const file=path.join(dir,'key.json');await writeFile(file,JSON.stringify({type:'secret',key:'sb_secret_synthetic_only'}));const cfg={environmentId:'fixture',supabaseOrigin:'https://fixture.supabase.co',publishableKey:'public-fixture',credentialFile:file,port:18571};
 for(const body of [null,true,{},[],{status:'reserved',claimId:'forged'}])await assert.rejects(createSupabase(cfg,async()=>Response.json(body)).rpc('freeze_claim',{}),/unknown|unconfirmed|invalid/i);
 await assert.rejects(createSupabase(cfg,async()=>Response.json({code:'PGRST202',message:'function not available'},{status:404})).rpc('preflight',{}),error=>(error as any).status===503);
 await assert.rejects(createSupabase(cfg,async()=>{throw Error('fixture lost after commit');}).rpc('freeze_claim',{}),error=>(error as any).code==='result-unknown');
});
test('domain refuses inconsistent stored-plan or empty exact-version resolution instead of a false success',async()=>{
 const {verifyBearer}=await import('./supabase.ts'),{createAdmission}=await import('./admission.ts'),p=await fixture();const ctx=await verifyBearer({environmentId:'fixture',supabaseOrigin:'https://fixture.supabase.co',publishableKey:'public-fixture'},'Bearer '+bearer(),async()=>Response.json({id:'11111111-1111-4111-8111-111111111111',is_anonymous:false}));
 const invalid=createAdmission({rpc:async()=>({claimId:'44444444-4444-4444-8444-444444444444',planId:'55555555-5555-4555-8555-555555555555',status:'reserved',contentKey:'a'.repeat(64),historyCount:0,executionReady:false,frozenPlan:{version:1}})});
 await assert.rejects(invalid.prepareAndClaim(ctx,{groupId:'99999999-9999-4999-8999-999999999999',projectId:p.projectId,filmRev:p.filmRev,job:p.job,idempotencyKey:'corrupt-stored-plan'}),/unconfirmed|unknown|invalid/i);
 await assert.rejects(createAdmission({rpc:async()=>[]}).resolve(ctx,[p.materials[0].versionId]),/unconfirmed|unknown|unavailable/i);
});
test('health distinguishes a configured trusted adapter from an absent one without claiming worker execution readiness',async()=>{
 const {createApiServer}=await import('./server.ts'),{createAdmission}=await import('./admission.ts');const domain=createAdmission({rpc:async()=>{throw Error('health cannot call DB');},prepare:async()=>fixture()});const api=createApiServer({verify:async()=>{throw Error('health does not authenticate');},admission:domain});await api.listen(18571);try{const response=await fetch('http://127.0.0.1:18571/health'),info=await response.json();assert.equal(info.workerPreparation,'adapter-configured');assert.equal(info.deliveryVerifier,'not-connected');assert.equal(info.executionReady,false);}finally{await api.close();}
});
test('stored duplicate response is returned without invoking trusted prepare again',async()=>{
 const {verifyBearer}=await import('./supabase.ts'),{createAdmission}=await import('./admission.ts'),p=await fixture();const ctx=await verifyBearer({environmentId:'fixture',supabaseOrigin:'https://fixture.supabase.co',publishableKey:'public-fixture'},'Bearer '+bearer(),async()=>Response.json({id:'11111111-1111-4111-8111-111111111111',is_anonymous:false}));let prepared=0;
 const domain=createAdmission({rpc:async()=>({status:'duplicate'}),prepare:async()=>{prepared++;return p;}});const result=await domain.prepareAndClaim(ctx,{groupId:'99999999-9999-4999-8999-999999999999',projectId:p.projectId,filmRev:p.filmRev,job:p.job,idempotencyKey:'stored-duplicate'});assert.deepEqual(result,{status:'duplicate'});assert.equal(prepared,0);
});