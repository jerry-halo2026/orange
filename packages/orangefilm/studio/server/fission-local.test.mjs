// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,realpath,rename,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createLocalFission,readLocalFissionConfiguration} from './fission-local.mjs';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';

async function fixture(slow=false,outputCount=2,stopReason='countReached',failedCount=0,subtitleOutcome='applied',tamper=false){
 const testRoot=process.env.ORANGE_LOCAL_FISSION_TEST_ROOT||await realpath(tmpdir());const root=await mkdtemp(path.join(testRoot,'fission-local-'));
 const inputs=path.join(root,'chosen'),video=path.join(inputs,'video'),audio=path.join(inputs,'audio'),workspace=path.join(root,'workspace');
 await mkdir(path.join(video,'1'),{recursive:true});await mkdir(audio);await mkdir(workspace);
 await writeFile(path.join(video,'1','a.mp4'),'selected video');await writeFile(path.join(audio,'a.wav'),'selected audio');
 const cli=path.join(root,'fixture-cli.cjs');await writeFile(cli,`
// 窄替身：只用于错误路径与并发；协议正确性由真实 CLI 用例证明，别把它当真实链路
const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2),value=n=>a[a.indexOf(n)+1];
const root=process.env.FISSION_NAMESPACE_ROOT,job=process.env.FISSION_NAMESPACE_JOB;if(!root||!job)throw Error('namespace handshake was not requested');
const jobRoot=path.join(root,job),core=[jobRoot,path.join(jobRoot,'inputs'),path.join(jobRoot,'worker'),path.join(jobRoot,'records')];const mk=d=>{fs.mkdirSync(d,{recursive:true});const lf=path.join(d,'.fission-namespace.lock');fs.writeFileSync(lf,'');const st=fs.statSync(lf,{bigint:true}),ds=fs.statSync(d,{bigint:true});return {path:d,lock:lf,volume:String(st.dev),index:String(st.ino),dirVolume:String(ds.dev),dirIndex:String(ds.ino),identity:'fixture'};};const entries=core.map(mk);

const run=()=>{try{const native=JSON.parse(fs.readFileSync(value('--job'),'utf8'));if(native.SubtitleEnabled){const metadata=JSON.parse(fs.readFileSync(path.join(path.dirname(native.AudioDir),'meta.json'),'utf8'));if(!Array.isArray(metadata.items)||!metadata.items.some(item=>item.file==='a.wav'&&typeof item.text==='string'&&item.text.length))throw Error('subtitle metadata missing');}
const out=path.join(value('--workspace'),'local','run','out','native');fs.mkdirSync(out,{recursive:true});const rows=[];for(let i=0;i<${outputCount};i++){const v=path.join(out,'v'+i+'.mp4'),p=path.join(out,'v'+i+'.edit-plan.json');fs.writeFileSync(v,Buffer.from([0,0,0,16,102,116,121,112,0,0,0,0]));fs.writeFileSync(p,JSON.stringify({sources:[{path:native.VideoDir}],subtitles:{requested:true,outcome:${JSON.stringify(subtitleOutcome)},cues:[{text:'synthetic'}]}}));rows.push({Index:i,Title:'Video '+i,Path:v,EditPlanPath:p,DurationSec:4});}fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({Succeeded:rows.length,Failed:${failedCount},Failures:${failedCount}?[{Index:9,Code:'TEST',Message:'synthetic'}]:[],StopReason:${JSON.stringify(stopReason)},Outputs:rows}));;const manifest=rows.map(row=>{const st=fs.statSync(row.Path,{bigint:true});const hash=require('node:crypto').createHash('sha256').update(fs.readFileSync(row.Path)).digest('hex');return {index:row.Index,path:row.Path,volume:String(st.dev),fileIndex:String(st.ino),sha256:${tamper?'true':'false'}?'0'.repeat(64):hash};});process.stderr.write('[Fission:OUTPUTS] '+JSON.stringify(manifest)+String.fromCharCode(10))}catch(e){process.stderr.write('[FIXTURE-ERR] '+e.message+String.fromCharCode(10));process.exit(9);}};
let buffer='',acked=false,started=false;const marker=()=>process.stderr.write('[Fission:JOB-FINISHED] 0'+String.fromCharCode(10));process.stdin.setEncoding('utf8');process.stdin.resume();process.stdin.on('data',chunk=>{buffer+=chunk;let at;
 while((at=buffer.indexOf(String.fromCharCode(10)))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
  if(!acked){acked=true;fs.writeFileSync(path.join(jobRoot,'intent.json'),line);let parsed={};try{parsed=JSON.parse(line);}catch{}for(const role of Array.isArray(parsed.roles)?parsed.roles:[])entries.push(mk(path.join(jobRoot,'inputs',role)));entries.push(mk(path.join(jobRoot,'worker','local')));entries.push(mk(path.join(jobRoot,'worker','local','run')));process.stderr.write('[Fission:NAMESPACE-HELD] '+JSON.stringify({version:1,jobId:job,root,entries})+String.fromCharCode(10));continue;}
  if(line==='START'&&!started){started=true;${slow==='stubborn'?'':slow?'setTimeout(()=>{run();marker();},10000);':'run();marker();'}}else if(line==='DONE'){process.exit(0);}}});
process.stdin.on('end',()=>{${slow==='stubborn'?'setInterval(()=>{},1000);':'process.exit(130);'}});
`);
 let current={id:'a',environmentId:'local-test',subjectId:'a'},picked={video,audio};const owner=current;
 const options={workspaceRoot:workspace,runtime:{dotnet:process.execPath,cli,paths:{}},pickFolder:async role=>picked[role]??null,assertSession:e=>e===current};const service=createLocalFission(options);
 return {root,video,audio,workspace,owner,service,options,setCurrent:value=>current=value,setPicked:(role,value)=>{picked[role]=value;}};
}
async function until(service,owner,id,predicate){for(let i=0;i<200;i++){const s=service.status(owner,id);if(predicate(s))return s;await new Promise(r=>setTimeout(r,10));}throw Error('timed out');}
test('configured Studio media tools resolve to the same binaries used by Fission',async()=>{
 const root=await mkdtemp(path.join(process.env.ORANGE_LOCAL_FISSION_TEST_ROOT||tmpdir(),'fission-config-')),suffix=process.platform==='win32'?'.exe':'';
 const ff=path.join(root,'ffmpeg'+suffix),probe=path.join(root,'ffprobe'+suffix),other=path.join(root,'other'+suffix),cli=path.join(root,'cli.dll');
 for(const p of [ff,probe,other,cli])await writeFile(p,'fixture');
 const config={dotnet:other,cli,paths:{FFmpeg:ff,FFprobe:probe,FFmpeg6:other,TransitionsDir:root,AssetsRoot:root,LocalAssetsRoot:root}},file=path.join(root,'config.json');
 await writeFile(file,JSON.stringify(config));assert.equal((await readLocalFissionConfiguration(file)).paths.FFprobe,probe);
 await writeFile(file,JSON.stringify({...config,paths:{...config.paths,FFprobe:other}}));await assert.rejects(readLocalFissionConfiguration(file),e=>e.code==='fission-configuration-invalid');
 /* FontsDir 是可选字体目录：可以缺席（目录还没随包落下），存在时必须是普通目录，相对路径一律拒。 */
 const missingFonts=path.join(root,'fonts-not-yet');
 await writeFile(file,JSON.stringify({...config,paths:{...config.paths,FontsDir:missingFonts}}));
 assert.equal((await readLocalFissionConfiguration(file)).paths.FontsDir,missingFonts,'缺目录也接受');
 await writeFile(file,JSON.stringify({...config,paths:{...config.paths,FontsDir:root}}));
 assert.equal((await readLocalFissionConfiguration(file)).paths.FontsDir,root,'已存在的目录接受');
 await writeFile(file,JSON.stringify({...config,paths:{...config.paths,FontsDir:'fonts'}}));
 await assert.rejects(readLocalFissionConfiguration(file),e=>e.code==='fission-configuration-invalid','相对路径拒绝');
 await writeFile(file,JSON.stringify({...config,paths:{...config.paths,FontsDir:other}}));
 await assert.rejects(readLocalFissionConfiguration(file),e=>e.code==='fission-configuration-invalid','文件不是字体目录');
});
test('two results from selected local folders keep originals and create no Studio project',async()=>{
 const f=await fixture(),other=createLocalFission(f.options);try{const v=await f.service.select(f.owner,'video'),a=await f.service.select(f.owner,'audio');assert.deepEqual(v.groups,[{name:'1',count:1}]);assert.equal(JSON.stringify(v).includes(f.video),false);
 const request={requestId:randomUUID(),selections:{video:v.selectionId,audio:a.selectionId},job:{Count:2,Threads:1,UseNvenc:false}};const started=f.service.start(f.owner,request);assert.equal(f.service.start(f.owner,request).jobId,started.jobId);assert.equal(other.start(f.owner,request).jobId,started.jobId);assert.equal(f.service.find(f.owner,request.requestId).jobId,started.jobId);assert.throws(()=>f.service.start(f.owner,{...request,job:{Count:3}}),e=>e.code==='fission-request-conflict');const done=await until(f.service,f.owner,started.jobId,s=>['completed','failed'].includes(s.status));assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(other.status(f.owner,started.jobId).status,'completed');assert.equal(done.outputs.length,2);assert.doesNotMatch(JSON.stringify(done),/[A-Z]:\\\\|edit-plan/);
 const source=f.service.getDraftSource(f.owner,{jobId:started.jobId,index:0});assert.match(source.planPath,/\.edit-plan\.json$/);assert.equal(source.sourceRoots.length,2);assert.equal(await readFile(path.join(f.video,'1','a.mp4'),'utf8'),'selected video');assert.equal(await readFile(path.join(f.audio,'a.wav'),'utf8'),'selected audio');
 const o=await f.service.openOutput(f.owner,{jobId:started.jobId,index:0,start:4,end:7});let b=Buffer.alloc(0);for await(const chunk of o.stream)b=Buffer.concat([b,chunk]);assert.equal(b.toString(),'ftyp');await assert.rejects(f.service.openOutput(f.owner,{jobId:started.jobId,index:0,start:99}),e=>e.status===416);
 }finally{await other.close();await f.service.close();}
});
test('rejects forged paths and other account; cancellation waits for worker close',async()=>{
 const f=await fixture(true);try{const v=await f.service.select(f.owner,'video'),a=await f.service.select(f.owner,'audio');assert.throws(()=>f.service.start(f.owner,{requestId:randomUUID(),selections:{video:v.selectionId},job:{VideoDir:f.video}}),e=>e.code==='fission-job-invalid');const s=f.service.start(f.owner,{requestId:randomUUID(),selections:{video:v.selectionId,audio:a.selectionId},job:{Count:2}});await until(f.service,f.owner,s.jobId,x=>x.status==='running');const cancelled=await f.service.cancel(f.owner,s.jobId);assert.equal(cancelled.status,'cancelled');f.setCurrent({id:'b',environmentId:'local-test',subjectId:'b'});assert.throws(()=>f.service.status(f.owner,s.jobId),e=>e.code==='authentication-required');assert.throws(()=>f.service.status({id:'b'},s.jobId),e=>e.code==='authentication-required'||e.code==='fission-not-found');}finally{await f.service.close();}
});
test('completed and uncertain tasks recover for their owner without launching again',async()=>{
 const f=await fixture();let restored;try{const v=await f.service.select(f.owner,'video'),a=await f.service.select(f.owner,'audio');const requestId=randomUUID(),input={requestId,selections:{video:v.selectionId,audio:a.selectionId},job:{Count:2}};const s=f.service.start(f.owner,input);await until(f.service,f.owner,s.jobId,x=>x.status==='completed'||x.status==='failed');assert.equal(f.service.status(f.owner,s.jobId).status,'completed');await f.service.close();restored=createLocalFission(f.options);assert.equal(restored.list(f.owner)[0].jobId,s.jobId);assert.equal(restored.find(f.owner,requestId).status,'completed');assert.equal(restored.start(f.owner,input).jobId,s.jobId);
 const unknown=randomUUID(),pendingId=randomUUID(),pending=path.join(f.workspace,pendingId);await mkdir(pending);const {createHash}=await import('node:crypto');const key=createHash('sha256').update(JSON.stringify([f.owner.environmentId,f.owner.subjectId])).digest('hex');await writeFile(path.join(pending,'intent.json'),JSON.stringify({version:1,jobId:pendingId,ownerKey:key,requestId:unknown,fingerprint:JSON.stringify({selections:{video:'old'},job:{}})}));assert.equal(restored.find(f.owner,unknown).status,'needs-reconciliation');assert.throws(()=>restored.start(f.owner,{requestId:unknown,selections:{video:'new'},job:{}}),e=>e.code==='fission-request-conflict');
 const other={environmentId:'local-test',subjectId:'b'};f.setCurrent(other);assert.equal(restored.list(other).length,0);
 }finally{await restored?.close();await f.service.close();}
});
test('zero, over-limit, failures and unknown stop reasons never report complete',async()=>{
 for(const [count,reason,failed,error] of [[0,'countReached',0,'fission-output-invalid'],[3,'countReached',0,'fission-output-incomplete'],[1,'materialShort',0,'fission-output-invalid'],[1,'countReached',1,'fission-output-invalid']]){const f=await fixture(false,count,reason,failed);try{const v=await f.service.select(f.owner,'video'),a=await f.service.select(f.owner,'audio');const s=f.service.start(f.owner,{requestId:randomUUID(),selections:{video:v.selectionId,audio:a.selectionId},job:{Count:2}});const done=await until(f.service,f.owner,s.jobId,x=>x.status==='completed'||x.status==='failed');assert.equal(done.status,'failed');assert.equal(done.error,error);assert.deepEqual(done.outputs,[]);assert.throws(()=>f.service.getDraftSource(f.owner,{jobId:s.jobId,index:0}),e=>e.status===404);await assert.rejects(f.service.openOutput(f.owner,{jobId:s.jobId,index:0}),e=>e.status===404);}finally{await f.service.close();}}
});
test('Count is an upper limit: one available voice can produce and recover one result when Count is three',async()=>{
 for(const reason of ['countReached','audioExhausted']){const f=await fixture(false,1,reason);let restored;try{const v=await f.service.select(f.owner,'video'),a=await f.service.select(f.owner,'audio'),requestId=randomUUID();const s=f.service.start(f.owner,{requestId,selections:{video:v.selectionId,audio:a.selectionId},job:{Count:3}});const done=await until(f.service,f.owner,s.jobId,x=>x.status==='completed'||x.status==='failed');assert.equal(done.status,'completed',done.error);assert.equal(done.outputs.length,1);const persisted=JSON.parse(await readFile(path.join(f.workspace,s.jobId,'result.json'),'utf8'));assert.equal(persisted.requestedCount,3);assert.equal(persisted.actualCount,1);assert.equal(persisted.stopReason,reason);await f.service.close();restored=createLocalFission(f.options);const recovered=restored.find(f.owner,requestId);assert.equal(recovered.status,'completed');assert.equal(recovered.outputs.length,1);}finally{await restored?.close();await f.service.close();}}
});
test('legacy empty, partial and inconsistent receipts stay unavailable on recovery',async()=>{
 const f=await fixture();let service;try{const v=await f.service.select(f.owner,'video'),a=await f.service.select(f.owner,'audio');const requestId=randomUUID(),s=f.service.start(f.owner,{requestId,selections:{video:v.selectionId,audio:a.selectionId},job:{Count:2}});const done=await until(f.service,f.owner,s.jobId,x=>x.status==='completed'||x.status==='failed');assert.equal(done.status,'completed',done.error);await f.service.close();const dir=path.join(f.workspace,s.jobId),intentPath=path.join(dir,'intent.json'),resultPath=path.join(dir,'result.json'),intent=JSON.parse(await readFile(intentPath,'utf8')),result=JSON.parse(await readFile(resultPath,'utf8'));
  const checks=[{intent:{...intent,version:1,requestedCount:undefined},result:{version:1,status:'completed',outputs:[]}},{intent:{...intent,version:1,requestedCount:undefined},result:{version:1,status:'completed',outputs:result.outputs}},{intent,result:{...result,version:2}},{intent,result:{...result,actualCount:0,outputs:[]}},{intent,result:{...result,stopReason:'userStopped'}},{intent,result:{...result,outputs:result.outputs.slice(0,1)}},{intent,result:{...result,outputs:[result.outputs[0],{...result.outputs[1],index:result.outputs[0].index}]}},{intent,result:{...result,outputs:[result.outputs[0],{...result.outputs[1],index:2}]}},{intent,result:{...result,requestedCount:1}}];
  for(const item of checks){await writeFile(intentPath,JSON.stringify(item.intent));await writeFile(resultPath,JSON.stringify(item.result));service=createLocalFission(f.options);const state=service.find(f.owner,requestId);assert.equal(state.status,'needs-reconciliation');assert.deepEqual(state.outputs,[]);assert.throws(()=>service.getDraftSource(f.owner,{jobId:s.jobId,index:0}),e=>e.status===404);await assert.rejects(service.openOutput(f.owner,{jobId:s.jobId,index:0}),e=>e.status===404);await service.close();service=null;}
 }finally{await service?.close();await f.service.close();}
});
test('stubborn owned child is forced to exit; unknown exit stays reconciliation required',async()=>{
 const f=await fixture('stubborn');let service=createLocalFission({...f.options,stopGraceMs:100,stopDeadlineMs:5000});try{const v=await service.select(f.owner,'video'),a=await service.select(f.owner,'audio');const s=service.start(f.owner,{requestId:randomUUID(),selections:{video:v.selectionId,audio:a.selectionId},job:{Count:2}});await until(service,f.owner,s.jobId,x=>x.status==='running');assert.equal((await service.cancel(f.owner,s.jobId)).status,'cancelled');await service.close();
  let stubbornChild=null;try{service=createLocalFission({...f.options,spawn:(...args)=>{stubbornChild=spawn(...args);return stubbornChild;},terminate:()=>false,stopGraceMs:10,stopDeadlineMs:300});const v2=await service.select(f.owner,'video'),a2=await service.select(f.owner,'audio');const t=service.start(f.owner,{requestId:randomUUID(),selections:{video:v2.selectionId,audio:a2.selectionId},job:{Count:2}});await until(service,f.owner,t.jobId,x=>x.status==='running');await assert.rejects(service.cancel(f.owner,t.jobId),e=>e.code==='fission-preservation-failed');assert.equal(service.status(f.owner,t.jobId).status,'needs-reconciliation');await assert.rejects(service.close(),e=>e.code==='fission-preservation-failed');}finally{try{stubbornChild?.kill('SIGKILL');}catch{}}
 }finally{await f.service.close();}
});
test('two independent processes claim one request once and reject a different input',async()=>{
 const f=await fixture();const requestId=randomUUID(),readyA=path.join(f.root,'ready-a'),readyB=path.join(f.root,'ready-b'),go=path.join(f.root,'go');const resultA=path.join(f.root,'a.json'),resultB=path.join(f.root,'b.json'),script=path.join(f.root,'race.mjs');
 /* 从本文件算，不从 cwd 算：`pnpm --filter orangefilm test` 从包目录跑，仓库根也跑，两处必须找到同一个模块 */
 const moduleUrl=new URL('./fission-local.mjs',import.meta.url).href;
 await writeFile(script,`import {writeFile,access} from 'node:fs/promises';import {createLocalFission} from ${JSON.stringify(moduleUrl)};const [root,cli,ready,go,result,requestId]=process.argv.slice(2);const owner={environmentId:'local-test',subjectId:'a'};const service=createLocalFission({workspaceRoot:root,runtime:{dotnet:process.execPath,cli,paths:{}},pickFolder:async()=>null,assertSession:e=>e===owner});await writeFile(ready,'1');for(;;){try{await access(go);break}catch{await new Promise(r=>setTimeout(r,5));}}const value=service.start(owner,{requestId,selections:{video:'shared-selection'},job:{Count:2}});await writeFile(result,JSON.stringify(value));await new Promise(r=>setTimeout(r,100));await service.close();`);
 const cli=f.options.runtime.cli,children=[spawn(process.execPath,[script,f.workspace,cli,readyA,go,resultA,requestId],{stdio:'ignore'}),spawn(process.execPath,[script,f.workspace,cli,readyB,go,resultB,requestId],{stdio:'ignore'})];
 try{for(let i=0;i<300;i++){try{await readFile(readyA);await readFile(readyB);break;}catch{if(i===299)throw Error('children not ready');await new Promise(r=>setTimeout(r,10));}}await writeFile(go,'1');await Promise.all(children.map(c=>new Promise((resolve,reject)=>{c.once('error',reject);c.once('close',code=>code===0?resolve():reject(Error('child failed '+code)));})));const a=JSON.parse(await readFile(resultA,'utf8')),b=JSON.parse(await readFile(resultB,'utf8'));assert.equal(a.jobId,b.jobId);const fsp=await import('node:fs/promises');
assert.equal((await fsp.readdir(path.join(f.workspace,'.requests'))).length,1,'请求围栏只能有一条');
const claims=await fsp.readdir(path.join(f.workspace,'.requests'));
const claimDir=path.join(f.workspace,'.requests',claims[0]);
const claimFiles=await fsp.readdir(claimDir);
assert.equal(claimFiles.length,1,'每个请求围栏只能有一个说明文件');
const claim=JSON.parse(await fsp.readFile(path.join(claimDir,claimFiles[0]),'utf8'));
assert.equal(claim.requestId,requestId.toLowerCase(),'围栏记录必须对应同一请求');
assert.equal(claim.jobId,a.jobId,'围栏记录必须指向同一个任务');assert.throws(()=>f.service.start(f.owner,{requestId,selections:{video:'different'},job:{Count:2}}),e=>e.code==='fission-request-conflict');
 }finally{for(const child of children)if(child.exitCode===null)child.kill();await f.service.close();}
});
test('an interrupted claim before its payload blocks automatic restart',async()=>{
 const f=await fixture();try{const {createHash}=await import('node:crypto'),requestId=randomUUID(),key=createHash('sha256').update(JSON.stringify([f.owner.environmentId,f.owner.subjectId])).digest('hex');await mkdir(path.join(f.workspace,'.requests',key+'-'+requestId),{recursive:true});const s=f.service.start(f.owner,{requestId,selections:{video:'old'},job:{Count:2}});assert.equal(s.status,'needs-reconciliation');assert.equal(f.service.find(f.owner,requestId).status,'needs-reconciliation');assert.equal(f.service.list(f.owner).length,1);}finally{await f.service.close();}
});
test('all explicitly disabled scene groups and out-of-range transitions fail before any job is created',async()=>{
 const f=await fixture();try{const v=await f.service.select(f.owner,'video'),a=await f.service.select(f.owner,'audio');const request=job=>({requestId:randomUUID(),selections:{video:v.selectionId,audio:a.selectionId},job:{Count:2,...job}});
  assert.throws(()=>f.service.start(f.owner,request({SceneGroups:[{Name:'1',Enabled:false},{Name:'2',Enabled:false}]})),e=>e.code==='fission-scene-groups-disabled'&&e.status===400&&/至少启用/.test(e.message));
  for(const value of [-0.1,2.01,'2',null,Number.NaN])assert.throws(()=>f.service.start(f.owner,request({TransitionSec:value})),e=>e.code==='fission-transition-range'&&e.status===400&&/0 到 2/.test(e.message));
  assert.deepEqual(await readdir(f.workspace),[]);
  for(const value of [0,2]){const s=f.service.start(f.owner,request({TransitionSec:value,SceneGroups:[{Name:'1',Enabled:true},{Name:'2',Enabled:false}]}));const done=await until(f.service,f.owner,s.jobId,x=>x.status==='completed'||x.status==='failed');assert.equal(done.status,'completed',done.error);}
 }finally{await f.service.close();}
});
test('enabled subtitles require matching local voice metadata and stage it at the original Fission location',async()=>{
 for(const place of ['inside','parent']){const f=await fixture();try{const file=place==='inside'?path.join(f.audio,'meta.json'):path.join(path.dirname(f.audio),'meta.json');const source=JSON.stringify({privateIgnored:'not copied',items:[{file:'a.wav',text:'Synthetic subtitle.',extra:'not copied'}]});await writeFile(file,source);const v=await f.service.select(f.owner,'video'),a=await f.service.select(f.owner,'audio'),s=f.service.start(f.owner,{requestId:randomUUID(),selections:{video:v.selectionId,audio:a.selectionId},job:{Count:2,SubtitleEnabled:true}});const done=await until(f.service,f.owner,s.jobId,x=>x.status==='completed'||x.status==='failed');assert.equal(done.status,'completed',done.error);const staged=JSON.parse(await readFile(path.join(f.workspace,s.jobId,'inputs','meta.json'),'utf8'));assert.deepEqual(staged,{items:[{file:'a.wav',text:'Synthetic subtitle.'}]});assert.equal(await readFile(file,'utf8'),source);assert.doesNotMatch(JSON.stringify(done),/Synthetic subtitle/);}finally{await f.service.close();}}
 for(const scenario of ['no-audio','no-meta','partial','ambiguous']){const f=await fixture();let spawned=0;const service=createLocalFission({...f.options,spawn:(...args)=>{spawned++;return spawn(...args);}});try{const v=await service.select(f.owner,'video'),a=scenario==='no-audio'?null:await service.select(f.owner,'audio');if(scenario==='partial'){await writeFile(path.join(f.audio,'b.wav'),'extra');await writeFile(path.join(f.audio,'meta.json'),JSON.stringify({items:[{file:'a.wav',text:'Synthetic subtitle.'}]}));}if(scenario==='ambiguous')await writeFile(path.join(f.audio,'meta.json'),JSON.stringify({items:[{file:'a.wav',text:'One'},{file:'a.wav',text:'Two'}]}));const s=service.start(f.owner,{requestId:randomUUID(),selections:{video:v.selectionId,audio:a?.selectionId??null},job:{Count:2,SubtitleEnabled:true}});const done=await until(service,f.owner,s.jobId,x=>x.status==='completed'||x.status==='failed');assert.equal(done.status,'failed');assert.equal(done.error,'fission-subtitle-text-required');assert.match(done.logs.join(' '),/缺少匹配文案/);assert.equal(spawned,0);assert.deepEqual(done.outputs,[]);}finally{await service.close();await f.service.close();}}
 const f=await fixture(false,2,'countReached',0,'missing-text');try{await writeFile(path.join(f.audio,'meta.json'),JSON.stringify({items:[{file:'a.wav',text:'Synthetic subtitle.'}]}));const v=await f.service.select(f.owner,'video'),a=await f.service.select(f.owner,'audio'),s=f.service.start(f.owner,{requestId:randomUUID(),selections:{video:v.selectionId,audio:a.selectionId},job:{Count:2,SubtitleEnabled:true}});const done=await until(f.service,f.owner,s.jobId,x=>x.status==='completed'||x.status==='failed');assert.equal(done.status,'failed');assert.equal(done.error,'fission-subtitle-not-applied');assert.deepEqual(done.outputs,[]);}finally{await f.service.close();}
});
test('workspace junction is rejected at initialization and after root replacement without writing outside',async()=>{
 const f=await fixture();try{const outside=path.join(f.root,'outside'),link=path.join(f.root,'initial-link'),moved=path.join(f.root,'workspace-original');await mkdir(outside);await symlink(outside,link,process.platform==='win32'?'junction':'dir');assert.throws(()=>createLocalFission({...f.options,workspaceRoot:link}),e=>e.code==='fission-workspace-invalid');assert.deepEqual(await readdir(outside),[]);
  const v=await f.service.select(f.owner,'video');await rename(f.workspace,moved);await symlink(outside,f.workspace,process.platform==='win32'?'junction':'dir');assert.throws(()=>f.service.start(f.owner,{requestId:randomUUID(),selections:{video:v.selectionId},job:{Count:2}}),e=>e.code==='fission-workspace-invalid');assert.deepEqual(await readdir(outside),[]);
 }finally{await f.service.close();}
});
test('a junction inserted below the root or a replaced ordinary root cannot redirect claims',async()=>{
 const nested=await fixture();try{const outside=path.join(nested.root,'outside');await mkdir(outside);await symlink(outside,path.join(nested.workspace,'.requests'),process.platform==='win32'?'junction':'dir');assert.throws(()=>nested.service.start(nested.owner,{requestId:randomUUID(),selections:{video:'x'},job:{Count:2}}),e=>e.code==='fission-workspace-invalid');assert.deepEqual(await readdir(outside),[]);}finally{await nested.service.close();}
 const changed=await fixture();try{await rename(changed.workspace,path.join(changed.root,'workspace-original'));await mkdir(changed.workspace);assert.throws(()=>changed.service.start(changed.owner,{requestId:randomUUID(),selections:{video:'x'},job:{Count:2}}),e=>e.code==='fission-workspace-invalid');assert.deepEqual(await readdir(changed.workspace),[]);}finally{await changed.service.close();}
});
test('an in-flight picker is aborted and retirement waits for its actual settlement',async()=>{
 const f=await fixture();let opened,release,wasAborted=false;const entered=new Promise(r=>{opened=r;}),closed=new Promise(r=>{release=r;});const service=createLocalFission({...f.options,pickFolder:async(role,{signal})=>{assert.equal(role,'video');signal.addEventListener('abort',()=>{wasAborted=true;},{once:true});opened();await closed;return f.video;}});
 try{const selection=service.select(f.owner,'video');await entered;let retired=false;const retiring=service.retire(f.owner).then(()=>{retired=true;});await new Promise(r=>setTimeout(r,25));assert.equal(wasAborted,true);assert.equal(retired,false);release();await assert.rejects(selection,e=>e.code==='fission-cancelled');await retiring;assert.equal(retired,true);}finally{release();await service.close();await f.service.close();}
});
test('picker unconfirmed close prevents account retirement and seals that owner',async()=>{
 const f=await fixture();let opened;const entered=new Promise(r=>{opened=r;});const service=createLocalFission({...f.options,pickFolder:async(_role,{signal})=>{opened();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));throw Object.assign(Error('not confirmed'),{code:'source-preservation-failed'});}});
 try{const selection=service.select(f.owner,'video');await entered;const selected=assert.rejects(selection,e=>e.code==='source-preservation-failed');await assert.rejects(service.retire(f.owner),e=>e.code==='source-preservation-failed');await selected;assert.throws(()=>service.select(f.owner,'video'),e=>e.code==='source-preservation-failed');await assert.rejects(service.close(),e=>e.code==='source-preservation-failed');}finally{await f.service.close();}
});

/* 从本文件算：测试从包目录跑（pnpm --filter orangefilm test），CLI 却在仓库根的 workers/fission 下 */
const CLI_DLL=fileURLToPath(new URL('../../../../workers/fission/src/Fission.Cli/bin/Release/net10.0/Fission.Cli.dll',import.meta.url));
const DOTNET_HOST=process.env.DOTNET_HOST_PATH||'C:'+path.sep+'Program Files'+path.sep+'dotnet'+path.sep+'dotnet.exe';
/* CLI 是构建产物，不在版本库里：没有就按名字跳过，跳过名写着怎么造出来 —— 而不是抛错拖垮整个文件，也不是静默通过 */
const CLI_MISSING=existsSync(CLI_DLL)?false:'needs the Fission CLI built here: dotnet build workers/fission/Fission.slnx -c Release (workers/fission/src/Fission.Cli/bin/Release/net10.0/Fission.Cli.dll)';
function assertRenameRefused(fsmod,dir){
  let moved=false;try{fsmod.renameSync(dir,dir+'-moved');moved=true;}catch{moved=false;}
  assert.equal(moved,false,'必须拒绝改名: '+dir);
  assert.ok(fsmod.existsSync(dir),'目录必须仍在原处: '+dir);
}
async function untilSlow(service,owner,id,predicate,ms=30000){const deadline=Date.now()+ms;for(;;){const s=service.status(owner,id);if(predicate(s))return s;if(Date.now()>deadline)return s;await new Promise(r=>setTimeout(r,50));}}
test('real Fission CLI completes the namespace handshake before it reads paths or job files',{skip:CLI_MISSING},async()=>{
  const fsmod=await import('node:fs');
  const base=process.env.ORANGE_LOCAL_FISSION_TEST_ROOT||await realpath(tmpdir());const root=await mkdtemp(path.join(base,'fission-realcli-'));
  const workspace=path.join(root,'workspace'),read=path.join(root,'read'),video=path.join(root,'chosen','video');
  await mkdir(workspace);await mkdir(read);await mkdir(path.join(video,'1'),{recursive:true});
  await writeFile(path.join(video,'1','a.mp4'),'synthetic non-media');const audio=path.join(root,'chosen','audio');await mkdir(audio);await writeFile(path.join(audio,'a.wav'),'synthetic non-audio');
  const engine=path.join(read,'engine.cmd');await writeFile(engine,'@exit /b 3'+String.fromCharCode(10));
  const paths={FFmpeg:engine,FFprobe:engine,FFmpeg6:engine,TransitionsDir:read,AssetsRoot:read,LocalAssetsRoot:read};
  const owner={id:'a',environmentId:'local-test',subjectId:'a'};
  const service=createLocalFission({workspaceRoot:workspace,runtime:{dotnet:DOTNET_HOST,cli:CLI_DLL,paths},pickFolder:async role=>role==='video'?video:audio,assertSession:e=>e===owner});
  try{
    const v=await service.select(owner,'video'),a=await service.select(owner,'audio');
    const started=service.start(owner,{requestId:randomUUID(),selections:{video:v.selectionId,audio:a.selectionId},job:{Count:1,Threads:1,SplitMode:'None',RandomHFlip:false,SceneGroups:[{Name:'1',TakePerOutput:1}]}});
    const done=await untilSlow(service,owner,started.jobId,s=>s.status==='failed'||s.status==='completed');
    const jobDir=path.join(workspace,started.jobId);
    const logPath=path.join(jobDir,'worker.log');const log=fsmod.existsSync(logPath)?fsmod.readFileSync(logPath,'utf8'):'';
    assert.ok(fsmod.existsSync(jobDir),'任务目录必须由 CLI 创建');
    assert.ok(fsmod.existsSync(path.join(jobDir,'intent.json')),'CLI 必须写入 intent.json');
    assert.ok(/\[Fission:NAMESPACE-HELD\]/.test(log),'真实 CLI 必须完成命名空间握手: log='+JSON.stringify(log.slice(0,300))+' done='+JSON.stringify(done));
    assert.ok(!/\[Fission:CFG_ARGS\]/.test(log),'不得因时序问题在握手前读配置: '+log.slice(0,400));
assert.ok(!/\[Fission:CFG_NAMESPACE\]/.test(log),'命名空间必须建立成功: '+log.slice(0,400));
    assert.ok(/\[Fission:(JOB-FINISHED|MAT_[A-Z0-9_]+|ENGINE_[A-Z0-9_]+)\]/.test(log),'必须走到终态标记而不是静默退出: '+JSON.stringify(log.slice(-800)));
    assert.equal(done.status,'failed','合成引擎必然失败，但必须走到终态');
    assert.ok(fsmod.existsSync(path.join(jobDir,'inputs','video','1','a.mp4')),'素材副本必须落到 inputs/video');
    assert.ok(!fsmod.existsSync(path.join(jobDir,'worker','.fission-namespace.lock')),'释放后锁文件必须清理');
    assert.ok(fsmod.existsSync(path.join(jobDir,'paths.json'))&&fsmod.existsSync(path.join(jobDir,'job.json')),'父进程在 ack 之后写入的配置必须存在');
  }finally{await service.close();}
});

test('every runtime write root stays pinned while the real engine runs',{skip:CLI_MISSING},async()=>{
  const fsmod=await import('node:fs');
  const base=process.env.ORANGE_LOCAL_FISSION_TEST_ROOT||await realpath(tmpdir());
  const root=await mkdtemp(path.join(base,'fission-pinned-'));
  const workspace=path.join(root,'workspace'),read=path.join(root,'read'),video=path.join(root,'chosen','video'),audio=path.join(root,'chosen','audio');
  await mkdir(workspace);await mkdir(read);await mkdir(path.join(video,'1'),{recursive:true});await mkdir(audio);
  await writeFile(path.join(video,'1','a.mp4'),'synthetic non-media');await writeFile(path.join(audio,'a.wav'),'synthetic non-audio');
  const engine=path.join(read,'engine.cmd');await writeFile(engine,'@ping -n 20 127.0.0.1 >nul'+String.fromCharCode(10));
  const paths={FFmpeg:engine,FFprobe:engine,FFmpeg6:engine,TransitionsDir:read,AssetsRoot:read,LocalAssetsRoot:read};
  const owner={id:'a',environmentId:'local-test',subjectId:'a'};
  const service=createLocalFission({workspaceRoot:workspace,runtime:{dotnet:DOTNET_HOST,cli:CLI_DLL,paths},pickFolder:async role=>role==='video'?video:audio,assertSession:e=>e===owner,stopGraceMs:500,stopDeadlineMs:120000});
  try{
    const v=await service.select(owner,'video'),a=await service.select(owner,'audio');
    const started=service.start(owner,{requestId:randomUUID(),selections:{video:v.selectionId,audio:a.selectionId},job:{Count:1,Threads:1,SplitMode:'None',RandomHFlip:false,SceneGroups:[{Name:'1',TakePerOutput:1}]}});
    const state=await untilSlow(service,owner,started.jobId,s=>s.status==='running'||s.status==='failed',90000);
    assert.equal(state.status,'running',JSON.stringify(state));
    const jobDir=path.join(workspace,started.jobId),runRoot=path.join(jobDir,'worker','local','run');
    for(const dir of [jobDir,path.join(jobDir,'inputs'),path.join(jobDir,'worker'),path.join(jobDir,'records'),path.join(jobDir,'inputs','video'),path.join(jobDir,'worker','local'),runRoot])
      assertRenameRefused(fsmod,dir);
    for(const name of ['work','out','cache']){
      const target=path.join(runRoot,name);
      let seen=false;for(let i=0;i<3600;i++){if(fsmod.existsSync(target)){seen=true;break;}await new Promise(r=>setTimeout(r,25));}
      assert.ok(seen,'引擎写根必须已创建: '+target);
      assertRenameRefused(fsmod,target);
    }
    await service.cancel(owner,started.jobId);
  }finally{await service.close();}
});

test('a tampered product manifest never reports completed',async()=>{
  const f=await fixture(false,1,'countReached',0,'applied',true);
  try{const v=await f.service.select(f.owner,'video'),a=await f.service.select(f.owner,'audio');
   const started=f.service.start(f.owner,{requestId:randomUUID(),selections:{video:v.selectionId,audio:a.selectionId},job:{Count:1}});
   const done=await until(f.service,f.owner,started.jobId,s=>s.status==='completed'||s.status==='failed');
   assert.equal(done.status,'failed','清单哈希不符时不得报完成');
   assert.equal(done.error,'fission-output-invalid');
  }finally{await f.service.close();}
});

test('legacy naming aliases are canonicalised and unknown ones are refused',async()=>{
  const f=await fixture(true,1);
  try{
    const v=await f.service.select(f.owner,'video'),a=await f.service.select(f.owner,'audio');
    const started=f.service.start(f.owner,{requestId:randomUUID(),selections:{video:v.selectionId,audio:a.selectionId},job:{Count:1,Naming:'Number'}});
    await until(f.service,f.owner,started.jobId,s=>s.status!=='preparing');
    const jobFile=path.join(f.workspace,started.jobId,'job.json');
    if((await import('node:fs/promises')).access(jobFile).then(()=>true,()=>false)){
      const written=JSON.parse(await readFile(jobFile,'utf8'));
      assert.equal(written.Naming,'Sequence','旧值 Number 必须被规范化成 Sequence');
    }
    await f.service.cancel(f.owner,started.jobId);
    assert.throws(()=>f.service.start(f.owner,{requestId:randomUUID(),selections:{video:v.selectionId,audio:a.selectionId},job:{Count:1,Naming:'Bogus'}}),e=>e.code==='fission-job-invalid');
  }finally{await f.service.close();}
});
