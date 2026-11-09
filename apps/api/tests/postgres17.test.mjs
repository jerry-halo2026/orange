import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const own=resolve(process.env.ORANGE_PG_TEST_ROOT||''),family=resolve(fileURLToPath(new URL('../../../.dev/business-producer',import.meta.url)));
assert(own.startsWith(family+sep),'explicit owned PG test root');
const instance=JSON.parse(readFileSync(join(own,'container-record.json'),'utf8'));assert(/^[a-f0-9]{64}$/.test(instance.id));
let sequence=0;
export async function sql(query,{role='postgres',expectedFailure=false}={}) {
 const env={...process.env,DOCKER_CONFIG:join(own,'clean/docker-config')};delete env.DOCKER_CONTEXT;
 return new Promise((yes,no)=>{let stdout='',stderr='',exit=null;const id=++sequence,child=spawn('docker',['--config',env.DOCKER_CONFIG,'exec','-i','--user','postgres',instance.id,'psql','-X','-U','postgres','-d','orange_test','-At','-v','ON_ERROR_STOP=1'],{env,cwd:own,windowsHide:true,stdio:['pipe','pipe','pipe']});const timer=setTimeout(()=>child.kill(),60000);child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',no);child.once('exit',(code,signal)=>exit={code,signal});child.once('close',(code,signal)=>{clearTimeout(timer);const result={exit,close:{code,signal},stdout,stderr};writeFileSync(join(own,'pg-case-'+Date.now()+'-'+process.pid+'-'+id+'.json'),JSON.stringify(result,null,2),{flag:'wx'});if(code&&!expectedFailure)no(Error('SQL failed: '+stderr));else yes(result);});child.stdin.end((role==='postgres'?'':'SET ROLE '+role+';\n')+query+'\n');});
}
test('actual isolated PostgreSQL17 is reachable before any business RED',async()=>{
 const r=await sql("select current_setting('server_version_num')::int/10000,current_database()");assert.match(r.stdout,/17\|orange_test/);
});
test('business producer installs real private RLS and privileged RPC rather than an in-memory oracle',async()=>{
 const r=await sql("select count(*) from pg_proc p join pg_namespace n on p.pronamespace=n.oid where n.nspname='public' and p.proname in ('orange_resolve_materials','orange_preflight','orange_freeze_claim','orange_claim_status','orange_start_attempt','orange_cancel_claim','orange_mark_unknown','orange_record_delivery')");assert.equal(Number(r.stdout.trim()),8);
});
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',SA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',SB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
const json=v=>quote(JSON.stringify(v))+'::jsonb';
const until=()=>quote(new Date(Date.now()+3600000).toISOString())+'::timestamptz';
const principal=actor=>[quote(actor)+'::uuid',quote(actor===A?SA:SB)+'::uuid',until()];
async function rpc(name,actor,args=[],options={}){const r=await sql('select public.orange_'+name+'('+[...principal(actor),...args].join(',')+')',{role:'service_role',...options});if(r.close.code)return r;return JSON.parse(r.stdout.trim().split('\n').at(-1));}
let caseData;
async function domainFixture(){
 if(caseData)return caseData;const {randomUUID}=await import('node:crypto'),{contentKey,requestDigest}=await import('../src/admission.ts');
 const group=randomUUID(),otherGroup=randomUUID(),original=JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/prepared-v1.json',import.meta.url)),'utf8'));const plans={};const setup=[];
 setup.push("ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS private_forbidden text;");
 setup.push(`INSERT INTO orange_business.groups VALUES(${quote(group)},1,true),(${quote(otherGroup)},1,true);`);
 for(const g of [group,otherGroup])for(const actor of [A,B])setup.push(`INSERT INTO orange_business.memberships VALUES(${quote(g)},${quote(actor)},1,true,now()+interval '1 hour');`);
 for(const actor of [A,B]){const plan=structuredClone(original);for(const material of plan.materials){const old=material.versionId,version=randomUUID(),asset=randomUUID();material.versionId=version;for(const s of plan.scenes)for(const c of s.clips)if(c.versionId===old)c.versionId=version;for(const key of ['voice','music'])if(plan.audio[key]?.versionId===old)plan.audio[key].versionId=version;
 setup.push(`INSERT INTO orange_business.assets(id,owner_id,source_kind,source_ref,active) VALUES(${quote(asset)},${quote(actor)},'local','synthetic-owned-source',true);`);
 setup.push(`INSERT INTO orange_business.asset_versions(id,asset_id,revision,sha256,kind,duration_sec,probe_revision,review_required) VALUES(${quote(version)},${quote(asset)},1,${quote(material.contentSha256)},${quote(material.kind)},${material.durationSec},1,false);`);
 setup.push(`INSERT INTO orange_business.licenses VALUES(${quote(randomUUID())},${quote(version)},${quote(actor)},1,ARRAY['studio','fission','export'],now()+interval '1 hour',false,'synthetic-rights-evidence');`);
 }plans[actor]=plan;}
 await sql(setup.join('\n'));caseData={group,otherGroup,plans,contentKey,requestDigest,randomUUID};return caseData;
}
test('privileged business uses only the scoped actual managed Auth columns',async()=>{
 const d=await domainFixture(),result=await rpc('preflight',A,[quote(d.group),quote('schema-scope'),quote('0'.repeat(64))]);assert.equal(result.status,'prepare-required');
 const direct=await sql('select private_forbidden from auth.sessions',{role:'service_role',expectedFailure:true});assert.notEqual(direct.close.code,0,'backend never needs arbitrary managed Auth columns');
});
const planVariant=(plan,n)=>{const result=structuredClone(plan);result.scenes[0].clips[0].fromSec=20+n/100;result.scenes[0].clips[0].toSec=25+n/100;return result;};
async function freeze(actor,key,plan,group,hash){const d=await domainFixture();return rpc('freeze_claim',actor,[quote(group||d.group),quote(d.group+':'+key),quote(hash||d.requestDigest({key,projectId:plan.projectId,job:plan.job})),json(plan),quote(d.contentKey(plan))]);}
test('Node and real PG17 encode the same canonical bytes/key including negative zero and actual still holds',async()=>{
 const d=await domainFixture(),a=structuredClone(d.plans[A]);a.scenes[0].clips[0].atSec=-0;
 const r=await sql('select orange_business.content_key('+json(a)+')',{role:'service_role'});assert.equal(r.stdout.trim().split('\n').at(-1),d.contentKey(a));
 const still=structuredClone(a);still.materials[0].kind='still';still.materials[0].durationSec=0;still.scenes[0].clips[0].fromSec=0;still.scenes[0].clips[0].toSec=5;still.job.ImageDurMinSec=5;still.job.ImageDurMaxSec=5;
 const s=await sql('select orange_business.content_key('+json(still)+')',{role:'service_role'});assert.equal(s.stdout.trim().split('\n').at(-1),d.contentKey(still));
});
test('two independent actual PG connections race same-group actors to exactly one immutable claim',async()=>{
 const d=await domainFixture(),[a,b]=await Promise.all([freeze(A,'race-a',d.plans[A]),freeze(B,'race-b',d.plans[B])]);assert.deepEqual([a.status,b.status].sort(),['duplicate','reserved']);assert.ok(!JSON.stringify(a.status==='duplicate'?a:b).includes('projectId'));
 const count=await sql('select count(*) from orange_business.claims where group_id='+quote(d.group)+' and content_key='+quote(d.contentKey(d.plans[A])));assert.equal(Number(count.stdout.trim()),1);
});
test('same idempotency intent returns stored exact plan after response loss; changed request conflicts',async()=>{
 const d=await domainFixture(),plan=planVariant(d.plans[A],1),key='lost-response',hash='1'.repeat(64);const first=await freeze(A,key,plan,null,hash),again=await freeze(A,key,planVariant(d.plans[A],2),null,hash);assert.equal(again.claimId,first.claimId);assert.deepEqual(again.frozenPlan,plan,'never hand a rerolled local candidate to execution');
 const changed=await rpc('freeze_claim',A,[quote(d.group),quote(d.group+':'+key),quote('2'.repeat(64)),json(plan),quote(d.contentKey(plan))],{expectedFailure:true});assert.notEqual(changed.close.code,0);assert.match(changed.stderr,/idempotency-conflict/);
});
test('only effective voice or BGM content changes can make new same-group claims, export scale cannot',async()=>{
 const d=await domainFixture(),base=planVariant(d.plans[A],3),first=await freeze(A,'export-original',base);assert.equal(first.status,'reserved');const resized=structuredClone(base);resized.projectId='renamed-copy';resized.job.OutWidth=720;resized.job.OutHeight=1280;assert.equal((await freeze(A,'export-variant',resized)).status,'duplicate');
 for(const [index,label]of [[1,'voice'],[2,'music']]){const p=structuredClone(base),id=d.randomUUID(),asset=d.randomUUID(),sha=(index===1?'d':'e').repeat(64),old=p.materials[index].versionId;p.materials[index].versionId=id;p.materials[index].contentSha256=sha;p.audio[label==='voice'?'voice':'music'].versionId=id;
 await sql(`INSERT INTO orange_business.assets(id,owner_id,source_kind,source_ref,active) VALUES(${quote(asset)},${quote(A)},'local','synthetic-new-audio',true);INSERT INTO orange_business.asset_versions VALUES(${quote(id)},${quote(asset)},1,${quote(sha)},'sound',${p.materials[index].durationSec},1,false);INSERT INTO orange_business.licenses VALUES(${quote(d.randomUUID())},${quote(id)},${quote(A)},1,ARRAY['fission','studio','export'],NULL,false,'synthetic-new-audio-rights');`);
 assert.equal((await freeze(A,'changed-'+label,p)).status,'reserved');assert.ok(old!==id);}
});
test('current membership revocation and stale frozen authorization cannot be resurrected by JWT or replay',async()=>{
 const d=await domainFixture(),p=planVariant(d.plans[A],4),c=await freeze(A,'member-revoke',p);await sql('update orange_business.memberships set active=false,revision=revision+1 where group_id='+quote(d.group)+' and subject_id='+quote(A));
 const denied=await rpc('claim_status',A,[quote(c.claimId)],{expectedFailure:true});assert.notEqual(denied.close.code,0);assert.match(denied.stderr,/group-membership-required/);
 await sql('update orange_business.memberships set active=true where group_id='+quote(d.group)+' and subject_id='+quote(A));const stale=await rpc('start_attempt',A,[quote(c.claimId),quote(d.randomUUID())],{expectedFailure:true});assert.notEqual(stale.close.code,0);assert.match(stale.stderr,/stale-authorization/);
 const retained=await sql('select count(*) from orange_business.claims where id='+quote(c.claimId));assert.equal(Number(retained.stdout.trim()),1);
});
test('exact version rights and needed human review are separate; ordinary valid local media adds no review gate',async()=>{
 const d=await domainFixture(),p=planVariant(d.plans[A],5),v=p.materials[0].versionId;const ok=await rpc('resolve_materials',A,[`ARRAY[${quote(v)}]::uuid[]`,quote('studio')]);assert.equal(ok.length,1);
 const version=d.randomUUID(),asset=d.randomUUID();await sql(`INSERT INTO orange_business.assets(id,owner_id,source_kind,source_ref,active) VALUES(${quote(asset)},${quote(A)},'local','synthetic-candidate',true);INSERT INTO orange_business.asset_versions VALUES(${quote(version)},${quote(asset)},1,${quote('f'.repeat(64))},'video',30,1,true);INSERT INTO orange_business.licenses VALUES(${quote(d.randomUUID())},${quote(version)},${quote(A)},1,ARRAY['fission','studio'],NULL,false,'synthetic-candidate-rights');`);
 const pending=await rpc('resolve_materials',A,[`ARRAY[${quote(version)}]::uuid[]`,quote('fission')],{expectedFailure:true});assert.notEqual(pending.close.code,0);
 await sql(`INSERT INTO orange_business.material_reviews VALUES(${quote(version)},1,${quote(A)},'approved','synthetic-real-human-confirmation-ref');`);assert.equal((await rpc('resolve_materials',A,[`ARRAY[${quote(version)}]::uuid[]`,quote('fission')])).length,1);
 await sql(`INSERT INTO orange_business.material_reviews VALUES(${quote(version)},2,${quote(A)},'withdrawn','synthetic-revocation-ref');`);const withdrawn=await rpc('resolve_materials',A,[`ARRAY[${quote(version)}]::uuid[]`,quote('fission')],{expectedFailure:true});assert.notEqual(withdrawn.close.code,0);
 const foreign=await rpc('resolve_materials',B,[`ARRAY[${quote(v)}]::uuid[]`,quote('studio')],{expectedFailure:true});assert.notEqual(foreign.close.code,0);
});
test('revoked/expired exact source license or changed source binding denies without deleting company records',async()=>{
 const d=await domainFixture(),v=d.plans[B].materials[0].versionId;await sql('update orange_business.licenses set revoked=true,revision=revision+1 where version_id='+quote(v));const revoked=await rpc('resolve_materials',B,[`ARRAY[${quote(v)}]::uuid[]`,quote('fission')],{expectedFailure:true});assert.notEqual(revoked.close.code,0);await sql('update orange_business.licenses set revoked=false,not_after=now()-interval \'1 second\' where version_id='+quote(v));const expired=await rpc('resolve_materials',B,[`ARRAY[${quote(v)}]::uuid[]`,quote('fission')],{expectedFailure:true});assert.notEqual(expired.close.code,0);await sql('update orange_business.licenses set not_after=now()+interval \'1 hour\' where version_id='+quote(v));
 const bind=d.randomUUID();await sql(`INSERT INTO orange_business.bindings VALUES(${quote(bind)},${quote(B)},1,true,NULL);UPDATE orange_business.assets SET source_kind='zhishang',binding_id=${quote(bind)},binding_revision=1 WHERE id=(SELECT asset_id FROM orange_business.asset_versions WHERE id=${quote(v)});`);assert.equal((await rpc('resolve_materials',B,[`ARRAY[${quote(v)}]::uuid[]`,quote('fission')])).length,1);await sql('update orange_business.bindings set revision=2 where id='+quote(bind));const stale=await rpc('resolve_materials',B,[`ARRAY[${quote(v)}]::uuid[]`,quote('fission')],{expectedFailure:true});assert.notEqual(stale.close.code,0);
});
test('unknown after restart or long disconnection stays occupied and never automatically dispatches/rerolls',async()=>{
 const d=await domainFixture(),p=planVariant(d.plans[A],6),claim=await freeze(A,'unknown-original',p);await rpc('start_attempt',A,[quote(claim.claimId),quote(d.randomUUID())]);await rpc('mark_unknown',A,[quote(claim.claimId)]);await sql('update orange_business.claims set created_at=now()-interval \'10 years\' where id='+quote(claim.claimId));const read=await rpc('claim_status',A,[quote(claim.claimId)]);assert.equal(read.status,'unknown');assert.equal(read.executionReady,false);assert.equal((await freeze(A,'unknown-new-key',p)).status,'duplicate');const restart=await rpc('start_attempt',A,[quote(claim.claimId),quote(d.randomUUID())],{expectedFailure:true});assert.notEqual(restart.close.code,0);
});
test('verified two-output delivery is exactly one content history; cancel/late success preserves unknown instead of freeing',async()=>{
 const d=await domainFixture(),p=planVariant(d.plans[A],7),c=await freeze(A,'two-exits',p);await rpc('start_attempt',A,[quote(c.claimId),quote(d.randomUUID())]);const args=kind=>[quote(c.claimId),quote(d.randomUUID()),quote(kind),quote(d.contentKey(p)),quote('a'.repeat(64))];const first=await rpc('record_delivery',A,args('nle')),second=await rpc('record_delivery',A,args('video'));assert.equal(first.historyCount,1);assert.equal(second.historyCount,1);
 const q=planVariant(d.plans[A],8),cancelled=await freeze(A,'cancel-late',q);await rpc('start_attempt',A,[quote(cancelled.claimId),quote(d.randomUUID())]);await rpc('cancel_claim',A,[quote(cancelled.claimId)]);const late=await rpc('record_delivery',A,[quote(cancelled.claimId),quote(d.randomUUID()),quote('video'),quote(d.contentKey(q)),quote('b'.repeat(64))]);assert.equal(late.status,'unknown');assert.equal(late.historyCount,0);assert.equal((await freeze(A,'cancel-no-reroll',q)).status,'duplicate');
});
test('low-privilege direct DML/RPC denied; immutable versions/plans never overwrite prior decisions',async()=>{
 const d=await domainFixture();for(const role of ['anon','authenticated']){const direct=await sql('select * from orange_business.claims',{role,expectedFailure:true});assert.notEqual(direct.close.code,0);const called=await sql(`select public.orange_preflight(${principal(A).join(',')},${quote(d.group)},'forged',${quote('0'.repeat(64))})`,{role,expectedFailure:true});assert.notEqual(called.close.code,0);}
 const rls=await sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='orange_business' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity");assert.equal(Number(rls.stdout.trim()),11);const changed=await sql('update orange_business.asset_versions set sha256='+quote('0'.repeat(64))+' where id='+quote(d.plans[A].materials[0].versionId),{expectedFailure:true});assert.notEqual(changed.close.code,0);assert.match(changed.stderr,/immutable/);
});
test('malformed integer/version administrative fields cannot bypass SQL canonical decoder',async()=>{
 const d=await domainFixture(),p=planVariant(d.plans[A],9);for(const mutate of [x=>x.version='1',x=>x.scenes[0].ordinal=0.5,x=>x.filmRev=1234567890123456]){const invalid=structuredClone(p);mutate(invalid);const r=await sql('select orange_business.content_key('+json(invalid)+')',{role:'service_role',expectedFailure:true});assert.notEqual(r.close.code,0,'SQL must reject the same malformed business envelope as TS');}
});
// Own subprocess composition uses real production HTTP/domain code, synthetic Auth/prepare only,
// and actual PG17 RPC functions. No product test-mode or HTTP prepared authority is added.
async function actualApiProcess(settings){
 const fs=await import('node:fs'),p=await import('node:path'),cp=await import('node:child_process'),url=await import('node:url');
 const {createApiServer}=await import(url.pathToFileURL(settings.server).href),{createAdmission}=await import(url.pathToFileURL(settings.admission).href),{verifyBearer}=await import(url.pathToFileURL(settings.supabase).href);
 const plan=JSON.parse(fs.readFileSync(settings.plan,'utf8')),allowed={preflight:'orange_preflight',freeze_claim:'orange_freeze_claim',claim_status:'orange_claim_status',resolve_materials:'orange_resolve_materials',cancel_claim:'orange_cancel_claim'};
 const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
 const value=(key,v)=>v===null?'NULL':key==='p_plan'?quote(JSON.stringify(v))+'::jsonb':Array.isArray(v)?'ARRAY['+v.map(quote).join(',')+']::uuid[]':quote(v);
 let serial=0,prepared=0;
 const rpc=async(operation,args)=>{
  if(!allowed[operation])throw Error('fixture fixed RPC only');
  const query='SET ROLE service_role;select public.'+allowed[operation]+'('+Object.entries(args).map(([key,v])=>key+'=>'+value(key,v)).join(',')+');';
  const result=await new Promise((yes,no)=>{let stdout='',stderr='',exit=null;const env={...process.env,DOCKER_CONFIG:settings.dockerConfig};delete env.DOCKER_CONTEXT;const child=cp.spawn('docker',['--config',settings.dockerConfig,'exec','-i','--user','postgres',settings.container,'psql','-X','-U','postgres','-d','orange_test','-At','-v','ON_ERROR_STOP=1'],{cwd:settings.own,env,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',no);child.once('exit',(code,signal)=>exit={code,signal});child.once('close',(code,signal)=>{const r={exit,close:{code,signal},stdout,stderr};fs.writeFileSync(p.join(settings.own,settings.mode+'-rpc-'+(++serial)+'.json'),JSON.stringify(r),{flag:'wx'});if(code||signal)no(Error('fixture SQL RPC failed'));else yes(JSON.parse(stdout.trim().split('\n').at(-1)));});child.stdin.end(query);});
  if(settings.mode==='first'&&operation==='freeze_claim'){process.send({type:'claim-committed',claimId:result.claimId,status:result.status});await new Promise(()=>{});}
  return result;
 };
 const admission=createAdmission({rpc,prepare:async()=>{prepared++;process.send({type:'prepared',count:prepared});if(settings.mode!=='first')throw Error('must not reroll after process restart');return plan;}});
 const api=createApiServer({verify:header=>verifyBearer({environmentId:'fixture',supabaseOrigin:'https://fixture.supabase.co',publishableKey:'public-fixture'},header,async()=>Response.json({id:settings.actor,is_anonymous:false})),admission});
 await api.listen(18571);process.send({type:'ready',pid:process.pid});
 process.on('message',message=>{if(message==='stop')void api.close().then(()=>{process.send({type:'stopped',prepared});process.exit(0);},()=>process.exit(1));});
}
test('actual HTTP to PG survives commit-response loss and a new API process without reprepare or duplicate claim',async()=>{
 const {EventEmitter}=await import('node:events'),d=await domainFixture(),caseRoot=join(own,'api-process-'+Date.now()+'-'+process.pid);(await import('node:fs')).mkdirSync(caseRoot,{recursive:true});const plan=planVariant(d.plans[A],11),planFile=join(caseRoot,'trusted-private-prepare.json');writeFileSync(planFile,JSON.stringify(plan),{flag:'wx'});
 const token=['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({sub:A,session_id:SA,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated',aud:'authenticated',iss:'https://fixture.supabase.co/auth/v1'})).toString('base64url'),'synthetic-signature'].join('.');
 async function start(mode){
  const settings={own:caseRoot,mode,plan:planFile,actor:A,container:instance.id,dockerConfig:join(own,'docker-config'),server:fileURLToPath(new URL('../src/server.ts',import.meta.url)),admission:fileURLToPath(new URL('../src/admission.ts',import.meta.url)),supabase:fileURLToPath(new URL('../src/supabase.ts',import.meta.url))};
  const script=join(caseRoot,mode+'.mjs');writeFileSync(script,'('+actualApiProcess.toString()+')('+JSON.stringify(settings)+').catch(()=>process.exit(1));',{flag:'wx'});
  const events=new EventEmitter();let exit=null,closed=null,prepared=0,stderr='';const child=spawn(process.execPath,[script],{cwd:caseRoot,env:{...process.env},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});child.stdout.on('data',()=>{});child.stderr.on('data',b=>stderr+=b);child.once('exit',(code,signal)=>exit={code,signal});const completion=new Promise(resolve=>child.once('close',(code,signal)=>{closed={code,signal};writeFileSync(join(caseRoot,mode+'-process.json'),JSON.stringify({pid:child.pid,exit,close:closed,prepared,stderr}),{flag:'wx'});resolve(closed);}));child.on('message',message=>{if(message.type==='prepared')prepared=message.count;events.emit(message.type,message);});
  const wait=(type)=>new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('API fixture '+type+' timeout')),10000);events.once(type,value=>{clearTimeout(timer);yes(value);});});await wait('ready');return{child,events,completion,wait,prepared:()=>prepared,closed:()=>closed};
 }
 let first,recovered;const abort=new AbortController(),key=d.group+':api-loss',request={groupId:d.group,projectId:plan.projectId,filmRev:plan.filmRev,job:plan.job,idempotencyKey:key},ask=()=>fetch('http://127.0.0.1:18571/api/fission/claims',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(request),signal:abort.signal});
 try{
  first=await start('first');const committed=first.wait('claim-committed'),lost=ask().catch(()=>null),record=await committed;assert.ok(record.claimId);assert.equal(first.prepared(),1);abort.abort();await lost;
  first.child.kill('SIGTERM');await first.completion;assert.ok(first.closed(),'actual first process close is observed');
  recovered=await start('recovered');const response=await fetch('http://127.0.0.1:18571/api/fission/claims',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(request)}),result=await response.json();assert.equal(response.status,200);assert.equal(result.claimId,record.claimId);assert.deepEqual(result.frozenPlan,plan);assert.equal(recovered.prepared(),0);assert.equal(result.executionReady,false);
  const count=await sql('select count(*) from orange_business.claims where owner_id='+quote(A)+' and idempotency_key='+quote(key));assert.equal(Number(count.stdout.trim()),1);
  recovered.child.send('stop');assert.equal((await recovered.completion).code,0);
 }finally{abort.abort();for(const process of [first,recovered])if(process&&!process.closed()){process.child.kill('SIGTERM');await process.completion;}}
});
test('sensitive SQL rejects expired or deleted/banned/anonymous live authority instead of JWT metadata',async()=>{
 const d=await domainFixture(),args=[quote(d.group),quote('sensitive-probe'),quote('0'.repeat(64))];
 const expired=await sql(`select public.orange_preflight(${quote(A)},${quote(SA)},now()-interval '1 second',${args.join(',')})`,{role:'service_role',expectedFailure:true});assert.notEqual(expired.close.code,0);
 for(const mutation of ["is_anonymous=true","deleted_at=now()","banned_until=now()+interval '1 hour'"]){await sql('update auth.users set '+mutation+' where id='+quote(A));const denied=await rpc('preflight',A,args,{expectedFailure:true});assert.notEqual(denied.close.code,0);await sql('update auth.users set is_anonymous=false,deleted_at=null,banned_until=null where id='+quote(A));}
 await sql('update auth.sessions set not_after=now()-interval \'1 second\' where id='+quote(SA));const old=await rpc('preflight',A,args,{expectedFailure:true});assert.notEqual(old.close.code,0);await sql('update auth.sessions set not_after=now()+interval \'2 hours\' where id='+quote(SA));
 const missing=await sql(`select public.orange_preflight(${quote(A)},${quote(d.randomUUID())},now()+interval '1 hour',${args.join(',')})`,{role:'service_role',expectedFailure:true});assert.notEqual(missing.close.code,0);
});
test('NULL mandatory claim/idempotency data cannot authorize a prepared result',async()=>{
 const d=await domainFixture(),p=planVariant(d.plans[A],13);for(const args of [[quote(d.group),'NULL',quote('0'.repeat(64))],[quote(d.group),quote('null-hash'),'NULL']]){const r=await rpc('preflight',A,args,{expectedFailure:true});assert.ok(r.close&&r.close.code!==0,'missing idem data must reject, not return prepare-required');}
 const nil=await rpc('freeze_claim',A,[quote(d.group),quote(d.group+':nil-content-key'),quote('0'.repeat(64)),json(p),'NULL'],{expectedFailure:true});assert.ok(nil.close&&nil.close.code!==0);
});
test('independent cancellation and late-success transactions never release or double-count content',async()=>{
 const d=await domainFixture(),p=planVariant(d.plans[A],14),c=await freeze(A,'concurrent-cancel',p);await rpc('start_attempt',A,[quote(c.claimId),quote(d.randomUUID())]);
 await Promise.all([rpc('cancel_claim',A,[quote(c.claimId)]),rpc('record_delivery',A,[quote(c.claimId),quote(d.randomUUID()),quote('video'),quote(d.contentKey(p)),quote('c'.repeat(64))])]);
 const final=await rpc('claim_status',A,[quote(c.claimId)]);assert.ok(['succeeded','unknown'].includes(final.status));assert.equal(final.historyCount,final.status==='succeeded'?1:0);assert.equal((await freeze(A,'concurrent-no-release',p)).status,'duplicate');
 const n=await sql('select count(*) from orange_business.deliveries where claim_id='+quote(c.claimId));assert.equal(Number(n.stdout.trim()),1);
});
test('fresh-source private helpers and public RPCs keep invoker/default-deny privileges',async()=>{
 const functions=await sql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='orange_business' and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))");assert.equal(Number(functions.stdout.trim()),0);
 const definers=await sql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('orange_business','public') and p.proname like 'orange_%' and p.prosecdef");assert.equal(Number(definers.stdout.trim()),0);
});
test('definite duplicate admission result binds actor/key/requestHash and replays without preparing',async()=>{
 const d=await domainFixture(),p=planVariant(d.plans[A],20),q=planVariant(d.plans[B],20);assert.equal((await freeze(A,'duplicate-source',p)).status,'reserved');const key=d.group+':duplicate-request',hash='d'.repeat(64);
 const duplicate=await rpc('freeze_claim',B,[quote(d.group),quote(key),quote(hash),json(q),quote(d.contentKey(q))]);assert.deepEqual(duplicate,{status:'duplicate'});
 const replay=await rpc('preflight',B,[quote(d.group),quote(key),quote(hash)]);assert.deepEqual(replay,duplicate,'samekey duplicate must not return prepare-required');
 const changed=await rpc('preflight',B,[quote(d.group),quote(key),quote('e'.repeat(64))],{expectedFailure:true});assert.ok(changed.close&&changed.close.code!==0);assert.match(changed.stderr,/idempotency-conflict/);
 const otherGroup=await rpc('preflight',B,[quote(d.otherGroup),quote(key),quote(hash)],{expectedFailure:true});assert.ok(otherGroup.close&&otherGroup.close.code!==0);
});
test('changing payload/content after samekey duplicate conflicts instead of creating a new claim',async()=>{
 const d=await domainFixture(),p=planVariant(d.plans[A],21),q=planVariant(d.plans[B],21);assert.equal((await freeze(A,'duplicate-change-source',p)).status,'reserved');const key=d.group+':duplicate-change',hash='6'.repeat(64);
 assert.equal((await rpc('freeze_claim',B,[quote(d.group),quote(key),quote(hash),json(q),quote(d.contentKey(q))])).status,'duplicate');
 const changed=planVariant(d.plans[B],22),result=await rpc('freeze_claim',B,[quote(d.group),quote(key),quote('7'.repeat(64)),json(changed),quote(d.contentKey(changed))],{expectedFailure:true});assert.ok(result.close&&result.close.code!==0,'duplicate must bind the request even when no claim row is created');assert.match(result.stderr,/idempotency-conflict/);
});
test('HTTP duplicate result survives response loss and API restart without calling prepare twice',async()=>{
 const {EventEmitter}=await import('node:events'),d=await domainFixture(),caseRoot=join(own,'api-duplicate-'+Date.now()+'-'+process.pid);(await import('node:fs')).mkdirSync(caseRoot,{recursive:true});const plan=planVariant(d.plans[A],23);await freeze(A,'api-duplicate-original',plan);const planFile=join(caseRoot,'trusted-prepare.json');writeFileSync(planFile,JSON.stringify(plan),{flag:'wx'});
 const token=['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({sub:A,session_id:SA,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated',aud:'authenticated',iss:'https://fixture.supabase.co/auth/v1'})).toString('base64url'),'synthetic-signature'].join('.');
 async function start(mode){const settings={own:caseRoot,mode,plan:planFile,actor:A,container:instance.id,dockerConfig:join(own,'docker-config'),server:fileURLToPath(new URL('../src/server.ts',import.meta.url)),admission:fileURLToPath(new URL('../src/admission.ts',import.meta.url)),supabase:fileURLToPath(new URL('../src/supabase.ts',import.meta.url))},script=join(caseRoot,mode+'.mjs');writeFileSync(script,'('+actualApiProcess.toString()+')('+JSON.stringify(settings)+').catch(()=>process.exit(1));',{flag:'wx'});const events=new EventEmitter();let exit=null,closed=null,prepared=0,stderr='';const child=spawn(process.execPath,[script],{cwd:caseRoot,env:{...process.env},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});child.stdout.on('data',()=>{});child.stderr.on('data',b=>stderr+=b);child.once('exit',(code,signal)=>exit={code,signal});const completion=new Promise(yes=>child.once('close',(code,signal)=>{closed={code,signal};writeFileSync(join(caseRoot,mode+'-receipt.json'),JSON.stringify({pid:child.pid,exit,close:closed,prepared,stderr}),{flag:'wx'});yes(closed);}));child.on('message',message=>{if(message.type==='prepared')prepared=message.count;events.emit(message.type,message);});const wait=type=>new Promise((yes,no)=>{const t=setTimeout(()=>no(Error('duplicate API timeout')),10000);events.once(type,message=>{clearTimeout(t);yes(message);});});await wait('ready');return {child,completion,wait,prepared:()=>prepared,closed:()=>closed};}
 let first,recovery;const abort=new AbortController(),key=d.group+':api-duplicate-result',body={groupId:d.group,projectId:plan.projectId,filmRev:plan.filmRev,job:plan.job,idempotencyKey:key};
 try{first=await start('first');const committed=first.wait('claim-committed'),pending=fetch('http://127.0.0.1:18571/api/fission/claims',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal:abort.signal}).catch(()=>null);assert.equal((await committed).status,'duplicate');abort.abort();await pending;first.child.kill('SIGTERM');await first.completion;
 recovery=await start('recovered');const response=await fetch('http://127.0.0.1:18571/api/fission/claims',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,409);assert.deepEqual(await response.json(),{status:'duplicate'});assert.equal(recovery.prepared(),0);const count=await sql('select count(*) from orange_business.fission_duplicate_requests where owner_id='+quote(A)+' and idempotency_key='+quote(key));assert.equal(Number(count.stdout.trim()),1);recovery.child.send('stop');assert.equal((await recovery.completion).code,0);
 }finally{abort.abort();for(const proc of [first,recovery])if(proc&&!proc.closed()){proc.child.kill('SIGTERM');await proc.completion;}}
});