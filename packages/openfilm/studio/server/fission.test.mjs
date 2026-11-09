import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {resolveIsolationProfile,isolationEnvironment} from '../../src/development-isolation.mjs';
const own=process.env.FISSION_NATIVE_TEST_ROOT;assert(own && path.isAbsolute(own));
const baseRoot=path.join(own,'native-profile');const profile=resolveIsolationProfile({baseRoot,instanceId:'native',taskId:'T06_NATIVE',attemptId:'a-'+process.pid,ports:{studio:18561,film:18562}},{approvedBaseRoot:baseRoot});
for(const dir of Object.values(profile.paths))mkdirSync(dir,{recursive:true});Object.assign(process.env,isolationEnvironment(profile));
const {createFission}=await import('./fission.mjs');
const {createProject}=await import('./projects.mjs');
test('ordinary original Fission job cannot self-assert shared admission or launch a worker',async()=>{
  const service=createFission();const project=await createProject('Admission pending');
  try { await assert.rejects(service.run(project,{VideoDir:'assets',Count:1,Threads:1,selfDeclaredSynthetic:true,approved:true}),e=>e.code==='admission-required' && e.status===503);await assert.rejects(fs.stat(path.join(project.path,'assets')),{code:'ENOENT'}); }
  finally {await service.stopAll();}
});
test('trusted startup selftest is bound to the exact original job and cannot be enabled by renderer JSON',async()=>{
  const project=await createProject('Exact developer binding');const job={VideoDir:'assets/video',AudioDir:'assets/voice',Count:1,Threads:1,UseNvenc:false,RandomHFlip:false};
  const service=createFission({selftest:{projectPath:project.path,jobSHA256:createHash('sha256').update(JSON.stringify(job)).digest('hex'),inputs:[],approvedBaseRoot:baseRoot}});
  try {await assert.rejects(service.run(project,{...job,Count:2}),e=>e.code==='admission-required');await assert.rejects(fs.stat(path.join(project.path,'assets')),{code:'ENOENT'});}
  finally {await service.stopAll();}
});

const {importFissionEditPlan}=await import('./fission-import.mjs');
const {qualifyFissionRender}=await import('../../src/fission-render.mjs');
const {readProjectFilm,editProjectFilm}=await import('./film.mjs');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function syntheticPlan(){
 const root=path.join(own,'source-'+Date.now());await fs.mkdir(root);const visual=path.join(root,'red.mp4'),voice=path.join(root,'voice.wav');await fs.writeFile(visual,'synthetic video marker never decoded');await fs.writeFile(voice,'synthetic audio marker never decoded');
 return {root,p:{schemaVersion:1,jobId:'unit',outputIndex:0,stage:{w:1080,h:1920},fps:30,durationSec:2,sources:[{path:visual,sha256:digest(await fs.readFile(visual)),kind:'video',durationSec:2},{path:voice,sha256:digest(await fs.readFile(voice)),kind:'sound',durationSec:4}],visuals:[{source:0,role:'main',group:'1',startSec:0,durationSec:2,speed:1,hflip:false}],alignment:{action:'trim',inputDurationSec:2,outputDurationSec:2,tempo:1,loops:1},audio:{voice:{source:1,volume:1,loop:false},music:null,loudnorm:{integratedLUFS:-14,truePeakDBTP:-1.5,loudnessRangeLU:11}},transitions:{requestedName:'',durationSec:0,selectedName:null,shader:null,outcome:'none',tailPaddingSec:0.2},subtitles:{requested:false,outcome:'disabled',timingSource:'sentence-weighted-approximation',cues:[],style:null},exportReady:true,equivalenceVerified:true,blockingCapabilities:[]}};
}
test('native importer preserves original editable sound role and full context; current edits and source bytes determine gate eligibility',async()=>{
 const {root,p}=await syntheticPlan();const result=await importFissionEditPlan(JSON.stringify(p),{sourceRoots:[root],approvedBaseRoot:baseRoot,internalDraft:true,nativeAudioProfile:'fission-v1'});
 const film=await readProjectFilm(result.project.path);const voice=film.value.tracks[1].clips[0];assert.equal(voice.attrs['data-fission-role'],'voice');assert.deepEqual(voice.time,[0,2]);
 const qualified=qualifyFissionRender(result.project.path,{kind:'video',codec:'h264'});assert.equal(qualified.fullVoiceSec,4);
 const edited=await editProjectFilm(result.project.path,film.rev,[{op:'set',clip:voice.id,field:'volume',value:0.7}]);assert(qualifyFissionRender(result.project.path));
 await editProjectFilm(result.project.path,edited.rev,[{op:'set',clip:voice.id,field:'time',value:[1,2]}]);assert.equal(qualifyFissionRender(result.project.path).preserveSourceTail,false,'the legal native trim now evaluates the current audible composition');
 await fs.rm(path.join(result.project.path,'.film','fission-handoff.json'));await fs.rm(path.join(result.project.path,'.film','fission-edit-plan.json'));
 assert.throws(()=>qualifyFissionRender(result.project.path),e=>e.code==='FISSION_EXPORT_BLOCKED','removing project sidecars cannot erase the trusted original import provenance');
});

test('original Studio HTTP exposes pending admission honestly and refuses forged Fission jobs with no worker',async()=>{
 const {startStudio}=await import('./server.mjs');const studio=await startStudio({port:18561,key:'native-fission-selftest',isolation:true,advertise:false,openBrowser:()=>assert.fail('no GUI in HTTP fixture')});
 try{const project=await createProject('HTTP pending');const call=async(method,body)=>{const res=await fetch(studio.origin+'/api/projects/'+project.id+'/fission',{method,headers:{origin:studio.origin,'x-studio-key':studio.key,connection:'close','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});return {status:res.status,value:await res.json()};};
 const caps=await call('GET');assert.equal(caps.status,200);assert.equal(caps.value.businessAdmitted,false);assert.equal(caps.value.available,false);
 const rejected=await call('POST',{VideoDir:'assets',Count:1,Threads:1,approved:true});assert.equal(rejected.status,503);assert.equal(rejected.value.code,'admission-required');
 }finally{await studio.close();}
});

test('original ProjectView continuation opens only the actual native project returned by a successful original job request',async()=>{
 const {fileURLToPath}=await import('node:url');const module=await import('../../node_modules/typescript/lib/typescript.js');const ts=module.default??module;
 const file=fileURLToPath(new URL('../ui/src/components/ProjectView.tsx',import.meta.url));const source=ts.createSourceFile(file,await fs.readFile(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fn=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='submitProjectFission');assert(fn,'the real ProjectView must own and call its native Fission continuation');
 const code=ts.transpileModule(fn.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;const {submitProjectFission}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const calls=[],opened=[];const job={VideoDir:'assets/video',AudioDir:'assets/voice',Count:1,Threads:1,UseNvenc:false,RandomHFlip:false};
 await submitProjectFission('original-a',job,id=>opened.push(id),async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({project:{id:'original-imported'},report:{Succeeded:1}}),{status:200});});
 assert.deepEqual(opened,['original-imported']);assert.equal(calls[0].url,'/api/projects/original-a/fission');assert.deepEqual(JSON.parse(calls[0].init.body),job);
 await assert.rejects(submitProjectFission('original-a',job,id=>opened.push(id),async()=>new Response(JSON.stringify({error:'admission required',code:'admission-required'}),{status:503})),/admission required/);
 assert.deepEqual(opened,['original-imported'],'rejection must never navigate or claim an editable project');
});

test('cancel before original worker launch seals that run and performs no staging or child attempt',async()=>{
 const project=await createProject('Cancel before launch');const root=path.join(own,'cancel-read');await fs.mkdir(root);const marker=path.join(root,'not-executable.exe'),cli=path.join(root,'not-cli.dll');await fs.writeFile(marker,'synthetic never executable');await fs.writeFile(cli,'synthetic never executable');
 const input=path.join(project.path,'assets','video','scene.mp4');await fs.mkdir(path.dirname(input),{recursive:true});await fs.writeFile(input,'synthetic input never decoded');
 const job={VideoDir:'assets/video',Count:1,Threads:1,UseNvenc:false,RandomHFlip:false};const runtime={dotnet:marker,cli,paths:Object.fromEntries(['FFmpeg','FFprobe','FFmpeg6','TransitionsDir','AssetsRoot','LocalAssetsRoot'].map(k=>[k,k.endsWith('Dir')||k.endsWith('Root')?root:marker]))};
 const service=createFission({runtime,selftest:{projectPath:project.path,jobSHA256:digest(JSON.stringify(job)),inputs:[{path:'assets/video/scene.mp4',sha256:digest(await fs.readFile(input))}],approvedBaseRoot:baseRoot}});
 try{const task=service.run(project,job);const cancel=service.cancel(project.id);await assert.rejects(task,e=>e.code==='fission-cancelled');await cancel;await assert.rejects(fs.stat(path.join(project.path,'assets','.fission-inputs')),{code:'ENOENT'});}
 finally{await service.stopAll();}
});

for(const effect of ['hflip','subtitles','transition','transition-fallback'])test('unsupported '+effect+' remains visible and blocked at the real original exports batch gate',async()=>{
 const {root,p}=await syntheticPlan();
 if(effect==='hflip')p.visuals[0].hflip=true;
 if(effect==='subtitles'){p.subtitles={...p.subtitles,requested:true,outcome:'applied',cues:[{startSec:0,endSec:2,text:'Synthetic'}],style:{preset:'basic',position:'bottom',fontSize:42,assStyle:'synthetic-not-equivalent',fadeInSec:.12,fadeOutSec:.12}};}
 if(effect==='transition-fallback')p.transitions={...p.transitions,requestedName:'fade',selectedName:'fade',durationSec:.2,outcome:'fallback-no-transition'};
 if(effect==='transition'){const shader=path.join(root,'fade.glsl');await fs.writeFile(shader,'synthetic shader never executed');p.transitions={...p.transitions,requestedName:'fade',selectedName:'fade',durationSec:.2,shader:{path:shader,sha256:digest(await fs.readFile(shader))},outcome:'applied'};}
 const result=await importFissionEditPlan(JSON.stringify(p),{sourceRoots:[root],approvedBaseRoot:baseRoot,internalDraft:true,nativeAudioProfile:'fission-v1'});
 const {createExports}=await import('./exports.mjs');const exports=createExports();try{const required=effect==='hflip'?'fission-hflip-equivalence':effect==='subtitles'?'fission-ass-style':effect==='transition'?'fission-glsl-transition':'fission-glsl-transition-fallback';assert.throws(()=>exports.start(result.project,{kind:'video',codec:'h264'}),e=>e.code==='FISSION_EXPORT_BLOCKED'&&e.blockingCapabilities.includes(required));assert.throws(()=>exports.startAll(result.project,{jobs:[{kind:'video',codec:'h264'},{kind:'video',codec:'h264'}]}),e=>e.code==='FISSION_EXPORT_BLOCKED');assert.deepEqual(exports.list(result.project.id),[]);}finally{await exports.stopAll();}
});

test('a trusted synthetic startup binding never advertises another native project as runnable',async()=>{
 const a=await createProject('Bound A'),b=await createProject('Unbound B');const service=createFission({runtime:{dotnet:'unused',cli:'unused',paths:{}},selftest:{projectPath:a.path,jobSHA256:'0'.repeat(64),inputs:[],approvedBaseRoot:baseRoot}});
 try{assert.equal(service.capabilities(a).available,true);assert.equal(service.capabilities(b).available,false);assert.equal(service.capabilities(b).mode,'admission-required');}
 finally{await service.stopAll();}
});

test('private provenance recording refuses a junction instead of writing outside its owned native home',async()=>{
 const {recordFissionOrigin}=await import('../../src/fission-render.mjs');const prior={...process.env},baseRoot=path.join(own,'origin-boundary'),p=resolveIsolationProfile({baseRoot,instanceId:'m',taskId:'T06',attemptId:'a',ports:{studio:18561,film:18562}},{approvedBaseRoot:baseRoot});for(const dir of Object.values(p.paths))await fs.mkdir(dir,{recursive:true});
 const project=path.join(p.paths.projects,'Origin'),outside=path.join(p.root,'outside-home');await fs.mkdir(path.join(project,'.film'),{recursive:true});await fs.mkdir(outside);await fs.writeFile(path.join(project,'.film','fission-handoff.json'),'{}');await fs.symlink(outside,path.join(p.paths.home,'fission-origins'),'junction');Object.assign(process.env,isolationEnvironment(p));
 try{assert.throws(()=>recordFissionOrigin(project),e=>e.code==='FISSION_EXPORT_BLOCKED');assert.deepEqual(await fs.readdir(outside),[],'no receipt may land through a substituted private directory');}
 finally{for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);}
});

for(const control of ['at','trim','speed','fade','split','hidden','muted'])test('native voice '+control+' stays consumable through original Ops and current-film qualification',async()=>{
 const {root,p}=await syntheticPlan();const imported=await importFissionEditPlan(JSON.stringify(p),{sourceRoots:[root],approvedBaseRoot:baseRoot,internalDraft:true,nativeAudioProfile:'fission-v1'});const before=await readProjectFilm(imported.project.path),voice=before.value.tracks[1].clips[0];
 const ops=control==='fade'?[{op:'props',edits:[{clip:voice.id,prop:'fade',value:[.2,.2]}]}]:control==='split'?[{op:'split',clip:voice.id,at:1,time:[0,1],restTime:[1,2]}]:control==='hidden'||control==='muted'?[{op:'track',track:1,field:control,value:true}]:[{op:'set',clip:voice.id,field:control==='trim'?'time':control,value:control==='at'?.5:control==='trim'?[.5,2]:control==='speed'?2:[.2,.2]}];
 await editProjectFilm(imported.project.path,before.rev,ops);const reopened=await readProjectFilm(imported.project.path);assert.equal(reopened.problems.length,0);const qualified=qualifyFissionRender(imported.project.path,{kind:'video',codec:'h264'});assert(qualified,'legal original native controls must not be permanently disabled');
 if(control==='split'){assert.equal(reopened.value.tracks[1].clips.length,2);assert.equal(qualified.preserveSourceTail,true,'pure split preserves the original full-source Fission effect context');}
 else assert.equal(qualified.preserveSourceTail,false,'edits evaluate current native audible buses, not a frozen replacement timeline');
 assert.equal(JSON.parse(await fs.readFile(path.join(imported.project.path,'.film/fission-edit-plan.json'),'utf8')).sources[1].durationSec,4,'original execution receipt is immutable');
});

test('one owned source used as voice and music preserves distinct native clip-id roles, not a filename guess',async()=>{
 const {root,p}=await syntheticPlan();p.audio.music={source:1,volume:.35,loop:true};const imported=await importFissionEditPlan(JSON.stringify(p),{sourceRoots:[root],approvedBaseRoot:baseRoot,internalDraft:true,nativeAudioProfile:'fission-v1'}),film=await readProjectFilm(imported.project.path),qualified=qualifyFissionRender(imported.project.path);const voice=film.value.tracks[1].clips[0],music=film.value.tracks[2].clips[0];assert.equal(voice.src,music.src);assert.notEqual(voice.id,music.id);assert.equal(qualified.roles[voice.id],'voice');assert.equal(qualified.roles[music.id],'music');const {fissionAudioClips}=await import('../../src/fission-render.mjs');const clips=fissionAudioClips([voice,music].map(c=>({clip:c.id,file:qualified.sources[c.src].path,at:c.at??0,from:c.time[0],to:c.time[1],speed:1,volume:c.volume??1})),qualified);assert.deepEqual(clips.map(c=>c.role),['voice','music']);assert.equal(clips[1].loopSource,true);
});
test('legal native audio edits do not authorize a newly referenced asset without the pending rights increment',async()=>{
 const {root,p}=await syntheticPlan();const imported=await importFissionEditPlan(JSON.stringify(p),{sourceRoots:[root],approvedBaseRoot:baseRoot,internalDraft:true,nativeAudioProfile:'fission-v1'}),film=await readProjectFilm(imported.project.path),voice=film.value.tracks[1].clips[0];await fs.writeFile(path.join(imported.project.path,'assets','unreceipted.wav'),'synthetic not yet admitted');await editProjectFilm(imported.project.path,film.rev,[{op:'set',clip:voice.id,field:'src',value:'assets/unreceipted.wav'}]);assert.throws(()=>qualifyFissionRender(imported.project.path),e=>e.code==='FISSION_EXPORT_BLOCKED'&&e.blockingCapabilities.includes('fission-source-rights-increment-required'));
});

test('original native project rename preserves its id and Fission qualification instead of binding permission to a folder spelling',async()=>{
 const {root,p}=await syntheticPlan(),imported=await importFissionEditPlan(JSON.stringify(p),{sourceRoots:[root],approvedBaseRoot:baseRoot,internalDraft:true,nativeAudioProfile:'fission-v1'});const {renameProject}=await import('./projects.mjs');const name='Renamed-'+Date.now(),target=path.resolve(profile.paths.projects,name);assert(target.startsWith(path.resolve(profile.paths.projects)+path.sep),'both directory move endpoints remain inside the owned native library');const receipt=digest(await fs.readFile(path.join(imported.project.path,'.film/fission-edit-plan.json')));const renamed=await renameProject(imported.project.id,name);assert.equal(renamed.id,imported.project.id);assert.equal(renamed.path,target);assert(qualifyFissionRender(renamed.path));assert.equal(digest(await fs.readFile(path.join(renamed.path,'.film/fission-edit-plan.json'))),receipt);
});

test('business relay binds the original Job to actual native id/revision, never invokes selftest, and rejects an in-flight film change',async()=>{
 const project=await createProject('Private business wire'),job={VideoDir:'assets/video',Count:1,Threads:1,UseNvenc:false};const before=await readProjectFilm(project.path);let finish,entered;const pending=new Promise(r=>finish=r),ready=new Promise(r=>entered=r);let observed;
 const service=createFission({business:{claim:async(p,body)=>{assert.equal(p.id,project.id);observed=body;entered();return pending;}}});
 const work=service.run(project,job,{groupId:'11111111-1111-4111-8111-111111111111',idempotencyKey:'stable-operation'});const rejected=assert.rejects(work,e=>e.code==='native-revision-changed');
 await Promise.race([ready,work]);assert.deepEqual(observed,{groupId:'11111111-1111-4111-8111-111111111111',idempotencyKey:'stable-operation',projectId:project.id,filmRev:before.rev,job});
 await editProjectFilm(project.path,before.rev,[{op:'stage',w:1080,h:1920}]);finish({status:503,data:{code:'trusted-preparation-unavailable'}});await rejected;await service.stopAll();
 await assert.rejects(fs.stat(path.join(project.path,'assets','.fission-work')),{code:'ENOENT'});
});

test('business cancel checks the backend claim project before mutation and preserves uncertainty without retry',async()=>{
 const project=await createProject('Claim boundary'),id='11111111-1111-4111-8111-111111111111';let mutations=0;
 const service=createFission({business:{status:async()=>({status:200,data:{frozenPlan:{projectId:'another-project'}}}),cancel:async()=>{mutations++;return {status:200,data:{status:'cancel-requested'}};}}});
 try{await assert.rejects(service.cancel(project,id),e=>e.code==='business-project-mismatch');assert.equal(mutations,0,'do not cancel a foreign claim first and check afterward');}finally{await service.stopAll();}
 const uncertain=createFission({business:{status:async()=>({status:200,data:{frozenPlan:{projectId:project.id}}}),cancel:async()=>{mutations++;throw Object.assign(Error('private URL must not escape'),{code:'business-unconfirmed',status:503});}}});
 try{await assert.rejects(uncertain.cancel(project,id),e=>e.code==='business-unconfirmed'&&e.status===503&&!e.message.includes('private URL'));assert.equal(mutations,1,'never retry an uncertain cancel');}finally{await uncertain.stopAll();}
});

test('business original HTTP reaches the actual backend with private Bearer, exact Job and current film revision; missing producer remains 503',async()=>{
 const {createDesktopAuth}=await import('../../../../apps/desktop/src/desktop-auth.mjs');
 const {createApiServer}=await import('../../../../apps/api/src/server.ts'),{createAdmission,contentKey}=await import('../../../../apps/api/src/admission.ts'),{verifyBearer}=await import('../../../../apps/api/src/supabase.ts');
 const base=path.join(own,'business-http'),bp=resolveIsolationProfile({baseRoot:base,instanceId:'business',taskId:'T03_BUSINESS',attemptId:'a-'+process.pid,ports:{studio:18571,film:18572}},{approvedBaseRoot:base});for(const dir of Object.values(bp.paths))await fs.mkdir(dir,{recursive:true});
 const prior={...process.env};Object.assign(process.env,isolationEnvironment(bp));
 const actor='11111111-1111-4111-8111-111111111111',group='33333333-3333-4333-8333-333333333333',claim='44444444-4444-4444-8444-444444444444';
 const token=['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({sub:actor,session_id:'22222222-2222-4222-8222-222222222222',exp:Math.floor(Date.now()/1000)+60,role:'authenticated',aud:'authenticated',iss:'https://fixture.supabase.co/auth/v1'})).toString('base64url'),'fixture-signature'].join('.');
 const savedPlan=JSON.parse(await fs.readFile(new URL('../../../../apps/api/fixtures/prepared-v1.json',import.meta.url),'utf8'));
 const job={...savedPlan.job,VideoDir:'assets/video',AudioDir:'assets/voice',Count:1,Threads:1,UseNvenc:false},seen=[],auth=[];let materialDenied=false,cancelUnknown=false,existing=null,duplicate=false,delayResolve=null,resolveEntered=null,remoteFinished=false;
 const admission=createAdmission({rpc:async(operation,args)=>{if(operation==='preflight')return duplicate?{status:'duplicate'}:existing??{status:'prepare-required'};if(operation==='claim_status')return existing;if(operation==='resolve_materials'){if(materialDenied)throw Object.assign(Error('denied'),{code:'material-access-denied',status:403});if(delayResolve){resolveEntered();await delayResolve;remoteFinished=true;}return args.p_ids.map(versionId=>({versionId,contentSha256:'a'.repeat(64),kind:'video',durationSec:10,probeRevision:1}));}if(operation==='cancel_claim'&&cancelUnknown)throw Object.assign(Error('unconfirmed'),{code:'result-unknown',status:503});throw Error('unexpected synthetic RPC');}});
 const backend=createApiServer({verify:authorization=>{auth.push(authorization);return verifyBearer({environmentId:'business',supabaseOrigin:'https://fixture.supabase.co',publishableKey:'public-fixture'},authorization,async()=>Response.json({id:actor,is_anonymous:false}));},admission:{...admission,prepareAndClaim:async(ctx,body)=>{seen.push(body);return admission.prepareAndClaim(ctx,body);}}});
 let studio,controller;await backend.listen(18471);
 try{
  controller=createDesktopAuth({configuration:{environmentId:'business',authOrigin:'https://fixture.supabase.co',publishableKey:'public-fixture',businessOrigin:'http://127.0.0.1:18471'},home:bp.paths.home,sharedHome:bp.paths.sharedHome,projects:bp.paths.projects,coordinationRoot:path.join(bp.paths.home,'coord'),instanceId:'business-http'}, {fetch:async(url,init)=>url.includes('/auth/v1/token?')?Response.json({access_token:token,refresh_token:'synthetic-refresh',token_type:'bearer',expires_in:60,user:{id:actor}}):url.endsWith('/auth/v1/user')?Response.json({id:actor,is_anonymous:false}):url.includes('/auth/v1/logout')?new Response(null,{status:204}):fetch(url,init),monotonicNow:()=>performance.now(),retire:async()=>{},onState(){}});
  assert.equal((await controller.signIn({email:'fixture@example.invalid',password:'synthetic-only'})).ok,true);
  const project=await controller.runNative(()=>createProject('Actual backend relay'));const film=await readProjectFilm(project.path);
  const {startStudio}=await import('./server.mjs');studio=await startStudio({port:18571,key:'business-fixture-key',isolation:true,advertise:false,desktopAuth:controller,fissionOptions:{business:controller.business},openBrowser:()=>assert.fail('no browser')});
  const call=async(method,suffix,body,headers={})=>{const r=await fetch(studio.origin+'/api/projects/'+project.id+'/'+suffix,{method,headers:{origin:studio.origin,'x-studio-key':studio.key,'content-type':'application/json',connection:'close',...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});return {status:r.status,value:await r.json()};};
  const versionId='55555555-5555-4555-8555-555555555555';const materials=await call('POST','materials/resolve',{purpose:'studio',versionIds:[versionId]});assert.equal(materials.status,200);assert.equal(materials.value.materials[0].versionId,versionId);
  const denied=await call('POST','materials/resolve',{purpose:'studio',versionIds:[versionId]},{'x-studio-key':'wrong'});assert.equal(denied.status,401);assert.equal(auth.length,1);
  materialDenied=true;assert.equal((await call('POST','materials/resolve',{purpose:'studio',versionIds:[versionId]})).status,403);assert.equal(controller.getPublicState().kind,'active');
  const result=await call('POST','fission?projectId=forged&filmRev=0000000000000000',job,{'x-orange-group-id':group,'idempotency-key':'one-stable-key'});assert.equal(result.status,503);assert.equal(result.value.code,'trusted-preparation-unavailable');assert.deepEqual(seen,[{groupId:group,idempotencyKey:'one-stable-key',projectId:project.id,filmRev:film.rev,job}]);
  const unboundCancel=await call('DELETE','fission');assert.equal(unboundCancel.status,503);assert.equal(unboundCancel.value.code,'result-unknown');assert.equal(unboundCancel.value.stopped,undefined,'local stopping cannot confirm a remote claim rollback');
  Object.assign(savedPlan,{projectId:project.id,filmRev:film.rev,job});existing={claimId:claim,planId:'66666666-6666-4666-8666-666666666666',status:'unknown',contentKey:contentKey(savedPlan),historyCount:0,executionReady:false,frozenPlan:savedPlan};
  const status=await call('GET','fission/claims/'+claim);assert.equal(status.status,200);assert.deepEqual(status.value,existing,'unknown remains held, not a released/reserved fabrication');
  duplicate=true;const repeat=await call('POST','fission',job,{'x-orange-group-id':group,'idempotency-key':'duplicate-stable-key'});assert.equal(repeat.status,409);assert.deepEqual(repeat.value,{status:'duplicate'});assert.equal(seen.at(-1).idempotencyKey,'duplicate-stable-key');
  cancelUnknown=true;const cancel=await call('POST','fission/claims/'+claim+'/cancel',{});assert.equal(cancel.status,503);assert.equal(cancel.value.code,'result-unknown');
  assert.ok(auth.every(value=>value==='Bearer '+token));assert.doesNotMatch(JSON.stringify(materials.value)+JSON.stringify(result.value)+JSON.stringify(controller.getPublicState()),new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  await assert.rejects(fs.stat(path.join(project.path,'assets','.fission-work')),{code:'ENOENT'});
  materialDenied=false;let finish;delayResolve=new Promise(r=>finish=r);const entered=new Promise(r=>resolveEntered=r);const late=call('POST','materials/resolve',{purpose:'studio',versionIds:[versionId]});await entered;
  const logout=controller.signOut();assert.notEqual(controller.getPublicState().kind,'active');const rejected=await late;assert.equal(rejected.status,403);await logout;assert.equal(remoteFinished,false,'aborting the local transport is not an assertion that the backend rolled back');
  finish();await new Promise(r=>setTimeout(r,10));assert.notEqual(controller.getPublicState().kind,'active');assert.equal((await readProjectFilm(project.path)).rev,film.rev);
 }finally{await studio?.close();await controller?.dispose();await backend.close();for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);}
});
