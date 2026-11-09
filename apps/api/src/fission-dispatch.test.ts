import test from 'node:test';import assert from 'node:assert/strict';
test('concrete Fission dispatcher exists rather than a supplied fake prepare callback',async()=>{
 const m=await import('./fission-dispatch.ts');assert.equal(typeof m.createFissionDispatcher,'function');
});
test('existing admission exposes internal original-index preflight and prepared claim without changing single claims',async()=>{
 const {createAdmission}=await import('./admission.ts');const a=createAdmission({rpc:async()=>{throw Error('not used');}});
 assert.equal(typeof (a as any).preflightPreparedOutput,'function');assert.equal(typeof (a as any).claimPreparedOutput,'function');assert.equal(typeof a.prepareAndClaim,'function');
});

import {mkdir} from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {verifyBearer} from './supabase.ts';import {createAdmission} from './admission.ts';
const actor='11111111-1111-4111-8111-111111111111',session='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',envId='dispatch-fixture';
async function context(){const token=['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({sub:actor,session_id:session,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated',aud:'authenticated',iss:'https://fixture.supabase.co/auth/v1'})).toString('base64url'),'synthetic-signature'].join('.');return verifyBearer({environmentId:envId,supabaseOrigin:'https://fixture.supabase.co',publishableKey:'public-fixture'},'Bearer '+token,async()=>Response.json({id:actor,is_anonymous:false}));}
const request=()=>({groupId:'99999999-9999-4999-8999-999999999999',projectId:'native-not-a-path',filmRev:'0123456789abcdef',job:{VideoDir:'selection-video',AudioDir:'selection-audio',Count:3,Threads:1,OutWidth:1080,OutHeight:1920,OutFps:30,UseNvenc:false},idempotencyKey:randomUUID(),sourceSelection:{video:[{group:'',versionIds:['10000000-0000-4000-8000-000000000001']}],audio:['10000000-0000-4000-8000-000000000002'],bgm:[],intro:[],outro:[]}});
async function unit(rpc:(op:string,args:any)=>Promise<any>,use:(...args:any[])=>Promise<any>){const {createFissionDispatcher}=await import('./fission-dispatch.ts');const own=process.env.ORANGE_PG_TEST_ROOT;assert(own?.includes(path.join('.dev','fission-dispatch')));const root=path.join(own!,'unit-'+randomUUID());await mkdir(root);const admission=createAdmission({rpc});return createFissionDispatcher({environmentId:envId,dispatchRoot:root,runtime:{} as any,materials:{use} as any,admission});}

test('allowed live replay refreshes authority while joining the same held entered operation',async()=>{
 let release!:(v:any)=>void,entered!:()=>void;const held=new Promise(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});let useCalls=0,gateCalls=0;
 const d=await unit(async()=>{gateCalls++;if(gateCalls===1){entered();return held;}return{status:'prepare-required'};},async()=>{useCalls++;throw Error('should not stage');}),ctx=await context(),r=request();
 try{const a=await d.submit(ctx,r);await started;const b=await d.submit(ctx,r);assert.equal(a.batchId,b.batchId);assert.equal(a.status,'preparing');assert.equal(b.status,'preparing');assert.equal(gateCalls,2,'replay must refresh independently without waiting for or repeating initial work');}
 finally{release({status:'prepare-required'});await d.close();}assert.equal(useCalls,0);
});
test('a stored or unknown prepared-index preflight cannot rerun physical preparation',async()=>{
 let useCalls=0;const d=await unit(async()=>({status:'duplicate'}),async()=>{useCalls++;throw Error('physical input must not be entered');}),ctx=await context();
 const state=await d.submit(ctx,request());for(let i=0;i<20;i++){if((await d.status(ctx,state.batchId)).status!=='preparing')break;await new Promise(r=>setTimeout(r,5));}await d.close();assert.equal(useCalls,0);
});

test('native generated source without a registered licensed version is pending before material or child work',async()=>{
 let useCalls=0;const d=await unit(async()=>({status:'prepare-required'}),async()=>{useCalls++;throw Error('no generation permission');}),ctx=await context(),r=request();r.job.AudioDir=null as any;(r.job as any).GeneratedAudioCount=3;r.sourceSelection.audio=[];
 const result=await d.submit(ctx,r);let status;for(let i=0;i<30;i++){status=await d.status(ctx,result.batchId);if(status.status!=='preparing')break;await new Promise(r=>setTimeout(r,5));}assert.equal(status?.status,'authorization-pending');assert.equal(useCalls,0);await d.close();
});

test('actual Auth/lease deadline metadata is mandatory and the earliest known cutoff wins',async()=>{
 const {authorizationDeadline}=await import('./fission-dispatch.ts'),ctx=await context(),now=Date.now();
 const result=authorizationDeadline(ctx,[{authNotAfter:new Date(now+2000).toISOString(),notAfter:new Date(now+900).toISOString()}]);assert.equal(result.until,now+900);assert.equal(result.auth,now+2000);
 for(const row of [{notAfter:null},{authNotAfter:'9999999999',notAfter:null},{authNotAfter:new Date(now+2000).toISOString()},{authNotAfter:new Date(now-1).toISOString(),notAfter:null}])assert.throws(()=>authorizationDeadline(ctx,[row]));
});

if(process.env.ORANGE_DISPATCH_INTEGRATION==='1'){
 const fs=await import('node:fs/promises'),cp=await import('node:child_process'),stream=await import('node:stream');
 const own=process.env.ORANGE_PG_TEST_ROOT!,record=JSON.parse(await fs.readFile(path.join(own,'container-record.json'),'utf8')),docker=process.env.ORANGE_DISPATCH_DOCKER!;
 assert.match(record.database,/^orange_dispatch_/);let pgNumber=0;
 const q=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'";
 async function pg(query:string){const args=['--config',path.join(own,'clean/docker-config'),'exec','-i','--user','postgres',record.id,'psql','-X','-U','postgres','-d',record.database,'-At','-v','ON_ERROR_STOP=1'];let exit:any=null;const child=cp.spawn(docker,args,{cwd:own,env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']}),stdout:Buffer[]=[],stderr:Buffer[]=[];child.stdout.on('data',b=>stdout.push(b));child.stderr.on('data',b=>stderr.push(b));child.once('exit',(code,signal)=>exit={code,signal});const close=await new Promise<any>((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));child.stdin.end(query);});const out=Buffer.concat(stdout).toString(),err=Buffer.concat(stderr).toString();await fs.writeFile(path.join(own,'dispatch-pg-'+Date.now()+'-'+process.pid+'-'+(++pgNumber)+'.json'),JSON.stringify({args,exit,close,stdout:out,stderr:err}),{flag:'wx'});if(close.code){const e:any=Error('fixture SQL failed');const code=/orange:([a-z-]+)/.exec(err)?.[1];e.code=code??'backend-unconfirmed';e.status=403;throw e;}return out.trim().split('\n').at(-1)!;}
 const allowed:Record<string,string>={resolve_materials:'orange_resolve_materials',preflight:'orange_preflight',freeze_claim:'orange_freeze_claim',claim_status:'orange_claim_status',start_attempt:'orange_start_attempt',cancel_claim:'orange_cancel_claim',mark_unknown:'orange_mark_unknown',begin_material:'orange_begin_material',finish_material:'orange_finish_material',locate_material:'orange_locate_material'};
 const rpc=async(op:string,args:Record<string,unknown>)=>{assert(allowed[op]);const value=(key:string,v:unknown)=>v===null?'NULL':['p_plan','p_payload','p_result'].includes(key)?q(JSON.stringify(v))+'::jsonb':Array.isArray(v)?'ARRAY['+v.map(q).join(',')+']::uuid[]':q(v);return JSON.parse(await pg('SET ROLE service_role;select public.'+allowed[op]+'('+Object.entries(args).map(([k,v])=>k+'=>'+value(k,v)).join(',')+');'));};
 const tree=async(dir:string):Promise<string[]>=>{const all:string[]=[];for(const entry of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())all.push(...await tree(p));else if(!entry.isSymbolicLink())all.push(p);}return all;};
 async function fixture(){
  const {createMaterials}=await import('./materials.ts'),{createFissionDispatcher}=await import('./fission-dispatch.ts'),ctx=await context(),group=randomUUID(),root=path.join(own,'real-'+randomUUID());await fs.mkdir(root);await pg(`INSERT INTO orange_business.groups VALUES(${q(group)},1,true);INSERT INTO orange_business.memberships VALUES(${q(group)},${q(actor)},1,true,now()+interval '1 hour');`);
  const materials=await createMaterials({environmentId:envId,materialRoot:path.join(root,'store')},{rpc}),versions:{id:string;sha:string;kind:string;duration:number}[]=[];
  const inputs=JSON.parse(await fs.readFile(process.env.ORANGE_DISPATCH_INPUTS!,'utf8'));
  for(const [i,file]of (inputs as string[]).entries()){const name=i===6?'voice.wav':'clip'+i+'.mp4',bytes=await fs.readFile(file),registered=await materials.register(ctx,{key:'dispatch-source-'+randomUUID(),name},stream.Readable.from([bytes]));assert.equal(registered.licensed,false);await pg(`INSERT INTO orange_business.licenses VALUES(${q(randomUUID())},${q(registered.versionId)},${q(actor)},1,ARRAY['studio','fission','export'],now()+interval '10 minutes',false,'approved-self-owned-dispatch-fixture');`);const meta=(await createAdmission({rpc}).resolve(ctx,[registered.versionId],'fission'))[0];versions.push({id:registered.versionId,sha:meta.contentSha256,kind:meta.kind,duration:meta.durationSec});}
  const r:any=request();r.groupId=group;r.sourceSelection.video=[{group:'1red',versionIds:versions.slice(0,3).map(v=>v.id)},{group:'2blue',versionIds:versions.slice(3,6).map(v=>v.id)}];r.sourceSelection.audio=[versions[6].id];Object.assign(r.job,{AudioUses:3,TargetDurationSec:4,RandomHFlip:false,TransitionSec:0,SubtitleEnabled:false,Pick:'Sequential',SplitMode:'None',Naming:'Sequence',SceneGroups:[{Name:'1red',Enabled:true,TakePerOutput:1,Rule:'Sequential',Speed:1,UseThenDelete:false,AllowReuse:false},{Name:'2blue',Enabled:true,TakePerOutput:1,Rule:'Sequential',Speed:1,UseThenDelete:false,AllowReuse:false}]});
  const runtime=JSON.parse(await fs.readFile(process.env.ORANGE_DISPATCH_RUNTIME!,'utf8')),admission=createAdmission({rpc}),dispatchRoot=path.join(root,'dispatch');let d:any;return {ctx,group,root,materials,versions,r,runtime,admission,dispatchRoot,createFissionDispatcher};
 }
 async function tool(label:string,exe:string,args:string[],root:string){let exit:any=null;const child=cp.spawn(exe,args,{cwd:root,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']}),stdout:Buffer[]=[],stderr:Buffer[]=[];child.stdout.on('data',b=>stdout.push(b));child.stderr.on('data',b=>stderr.push(b));child.once('exit',(code,signal)=>exit={code,signal});const close=await new Promise<any>((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));});await fs.writeFile(path.join(root,label+'.json'),JSON.stringify({exe,args,pid:child.pid,exit,close,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()}),{flag:'wx'});assert.equal(close.code,0,Buffer.concat(stderr).toString());return Buffer.concat(stdout);}
 test('real registered licensed FD -> actual Count3 prepare -> real PG per-index duplicate -> same-snapshot subset via original API',async()=>{
  const f=await fixture(),{createApiServer}=await import('./server.ts'),{mapPreparedFissionOutput}=await import('./admission.ts');let phases=0,seeded=false;const leaseFacts:any[]=[];
  const use:typeof f.materials.use=async(ctx,ids,purpose,consumer,signal)=>{const seen:any[]=[];const result=await f.materials.use(ctx,ids,purpose,async leases=>{seen.push(...leases);return consumer(leases);},signal);leaseFacts.push({ids:[...ids],closedAfterConsumer:seen.every(l=>l.handle.fd===-1)});if(++phases===1){
   const files=await tree(f.dispatchRoot),journal=files.find(p=>p.endsWith('-prepared.json'));assert(journal);const preparedRecord=JSON.parse(await fs.readFile(journal!,'utf8')),snapshot=JSON.parse(await fs.readFile(preparedRecord.snapshot,'utf8')),associations=preparedRecord.stage.map((s:any)=>({...s,fileIdentity:snapshot.versions.find((v:any)=>v.path===s.filePath).identity}));
   const plan=await mapPreparedFissionOutput(snapshot,1,{projectId:f.r.projectId,filmRev:f.r.filmRev,job:f.r.job},associations);const prior=await f.admission.claimPreparedOutput(ctx,{...f.r,idempotencyKey:'prior-'+randomUUID()},1,plan);assert.equal(prior.status,'reserved');seeded=true;
  }return result;};
  const d=await f.createFissionDispatcher({environmentId:envId,dispatchRoot:f.dispatchRoot,runtime:f.runtime,materials:{use},admission:f.admission});
  const api=createApiServer({verify:async()=>context(),admission:f.admission,materials:f.materials,dispatcher:d});await api.listen(18581);
  try{const post=await fetch('http://127.0.0.1:18581/api/fission/batches',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(f.r)});assert.equal(post.status,202);const initial:any=await post.json();let state:any;
   for(let i=0;i<500;i++){const response=await fetch('http://127.0.0.1:18581/api/fission/batches/'+initial.batchId);assert.equal(response.status,200);state=await response.json();if(!['preparing','admitting','executing'].includes(state.status))break;await new Promise(r=>setTimeout(r,20));}
   assert.equal(state.status,'rendered-unverified',JSON.stringify(state));assert(seeded);assert.deepEqual(state.outputs.map((o:any)=>[o.index,o.state]),[[0,'rendered-unverified'],[1,'duplicate'],[2,'rendered-unverified']]);assert.equal(state.deliveryVerified,false);assert(!JSON.stringify(state).includes(f.root));assert.equal(leaseFacts.length,2);assert(leaseFacts.every(v=>v.closedAfterConsumer));assert.equal(leaseFacts[0].ids.length,7);assert.equal(leaseFacts[1].ids.length,5);
   const files=await tree(f.dispatchRoot),preparedRecord=JSON.parse(await fs.readFile(files.find(p=>p.endsWith('-prepared.json'))!,'utf8')),snapshot=JSON.parse(await fs.readFile(preparedRecord.snapshot,'utf8')),reportFile=files.find(p=>path.basename(p)==='report.json')!,report=JSON.parse(await fs.readFile(reportFile,'utf8'));assert.deepEqual(report.Outputs.map((o:any)=>o.Index),[0,2]);assert.equal(snapshot.outputs.length,3);assert.equal(report.ConsumeLog.length,2);assert(!files.some(p=>p.endsWith(path.join('o1','c000.mp4'))));assert(!files.some(p=>path.dirname(p)===path.dirname(reportFile)&&path.basename(p)==='002.mp4'));
   const media=[];for(const o of report.Outputs){const meta=JSON.parse((await tool('probe-'+o.Index,f.runtime.paths.FFprobe,['-v','error','-show_streams','-show_format','-of','json',o.Path],f.root)).toString());assert.equal(meta.streams.filter((s:any)=>s.codec_type==='audio').length,1);assert.equal(Number(meta.streams.find((s:any)=>s.codec_type==='video').nb_frames),120);assert(Math.abs(Number(meta.format.duration)-4)<=1/30);await tool('decode-'+o.Index,f.runtime.paths.FFmpeg,['-nostdin','-v','error','-threads','1','-i',o.Path,'-f','null','-'],f.root);const sidecar=JSON.parse(await fs.readFile(o.EditPlanPath,'utf8'));assert.equal(sidecar.outputIndex,o.Index);assert(sidecar.sources.every((s:any)=>s.path!==o.Path));media.push({index:o.Index,path:o.Path,meta,sidecar});}
   assert.equal(await pg('select count(*) from orange_business.deliveries d join orange_business.claims c on c.id=d.claim_id where c.group_id='+q(f.group)),'0');assert.equal(await pg('select count(*) from orange_business.claims where group_id='+q(f.group)+" and state='succeeded'"),'0');
   await fs.writeFile(path.join(own,'real-dispatch-consumption.json'),JSON.stringify({root:f.root,batch:state,leaseFacts,preparedRecord,report,media,actualSource:'actual material registration/probe/FD+original production CLI+realSQL',auth:'synthetic managed Auth fixtures only; not real cloud Login',businessDelivery:false},null,2),{flag:'wx'});
  }finally{await api.close();}
 });
}

test('a native candidate receipt must match the exact prepared original index and decisions, not merely exist',async()=>{
 const {assertNativeCandidateReceipt}=await import('./fission-dispatch.ts') as any;assert.equal(typeof assertNativeCandidateReceipt,'function');
 const visual={source:0,role:'main',group:'x',startSec:0,durationSec:2,speed:1,hflip:false},source={path:'owned-original.mp4',sha256:'a'.repeat(64),kind:'video',durationSec:2};
 const prepared={jobId:'job-fixture',outputs:[{index:2,sources:[source],cuts:[{decision:visual}]}]},receipt={schemaVersion:1,jobId:'job-fixture',outputIndex:2,sources:[source],visuals:[visual]};
 assertNativeCandidateReceipt(prepared,2,receipt);
 for(const mutate of [(r:any)=>r.outputIndex=1,(r:any)=>r.jobId='other',(r:any)=>r.sources[0].sha256='b'.repeat(64),(r:any)=>r.visuals[0].startSec=1]){const changed=structuredClone(receipt);mutate(changed);assert.throws(()=>assertNativeCandidateReceipt(prepared,2,changed));}
});

test('unknown owner-bound batch references return not-found, not an internal path error',async()=>{
 const d=await unit(async()=>({status:'prepare-required'}),async()=>{throw Error('unused');}),ctx=await context();try{await assert.rejects(d.status(ctx,'f'.repeat(24)),(e:any)=>e.status===404);}finally{await d.close();}
});

test('client paths/runtime/prepared/owner flags and unbranded identities never become source authority',async()=>{
 let uses=0;const d=await unit(async()=>({status:'prepare-required'}),async()=>{uses++;throw Error('no source authority');}),ctx=await context();try{
  for(const extra of ['owner','prepared','runtime','approved'])await assert.rejects(d.submit(ctx,{...request(),[extra]:true}));
  const paths=request();paths.sourceSelection.audio=['C:\\private\\not-a-version.wav'];await assert.rejects(d.submit(ctx,paths));
  await assert.rejects(d.submit({...ctx} as any,request()));assert.equal(uses,0);
 }finally{await d.close();}
});

test('same parent intent with changed source selection conflicts while the original real entered promise remains owned',async()=>{
 let release!:(v:any)=>void;const held=new Promise(r=>{release=r;}),d=await unit(async()=>held,async()=>{throw Error('unused');}),ctx=await context(),r=request();
 try{await d.submit(ctx,r);const changed=structuredClone(r);changed.sourceSelection.audio=['20000000-0000-4000-8000-000000000002'];await assert.rejects(d.submit(ctx,changed),(e:any)=>e.status===409);}finally{release({status:'prepare-required'});await d.close();}
});

test('retained request marker after a new dispatcher instance is reconciliation-needed without preparing again',async()=>{
 const {createFissionDispatcher}=await import('./fission-dispatch.ts'),ctx=await context(),r=request(),own=process.env.ORANGE_PG_TEST_ROOT!;const root=path.join(own,'restart-'+randomUUID());await mkdir(root);let calls=0,uses=0;
 const make=()=>createFissionDispatcher({environmentId:envId,dispatchRoot:root,runtime:{} as any,materials:{use:async()=>{uses++;throw Error('no reroll');}} as any,admission:createAdmission({rpc:async()=>{calls++;return{status:'duplicate'};}})});
 const first=await make();await first.submit(ctx,r);await first.close();const before=calls,second=await make(),reply=await second.submit(ctx,r);await second.close();assert.equal(calls,before);assert.equal(uses,0);assert.equal((await second.status(ctx,reply.batchId)).status,'needs-reconciliation');
});

test('a lost prepared-index freeze response is propagated unknown, never acknowledged or auto-prepared',async()=>{
 const {readFile}=await import('node:fs/promises'),r=request(),ctx=await context(),plan=JSON.parse(await readFile(new URL('../fixtures/prepared-v1.json',import.meta.url),'utf8'));plan.projectId=r.projectId;plan.filmRev=r.filmRev;plan.job=r.job;const ops:string[]=[];
 const a=createAdmission({rpc:async op=>{ops.push(op);if(op==='preflight')return{status:'prepare-required'};throw Object.assign(Error('unknown after commit'),{code:'result-unknown',status:503});}});
 await assert.rejects(a.claimPreparedOutput(ctx,r,2,plan),(e:any)=>e.code==='result-unknown');assert.deepEqual(ops,['preflight','freeze_claim']);
});

test('GET and repeated POST both refuse a retained batch after current group authority is revoked',async()=>{
 let revoked=false,gateCalls=0,useCalls=0;
 const d=await unit(async()=>{gateCalls++;if(revoked)throw Object.assign(Error('group-access-denied'),{code:'group-access-denied',status:403});return{status:'duplicate'};},async()=>{useCalls++;throw Error('must not reread material');}),ctx=await context(),r=request();
 try{const first=await d.submit(ctx,r);await d.status(ctx,first.batchId);revoked=true;
  await assert.rejects(d.status(ctx,first.batchId),(e:any)=>e.code==='group-access-denied');const before=gateCalls;
  await assert.rejects(d.submit(ctx,r),(e:any)=>e.code==='group-access-denied');assert.equal(gateCalls,before+1,'repeat POST must perform its own fresh preflight');assert.equal(useCalls,0);
 }finally{await d.close();}
});