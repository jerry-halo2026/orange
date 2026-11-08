import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { validateNativeStudioContext, verifyNativeStudioTap, validateNativeStudioSources, validatePlaywrightArchiveEntries, parsePlaywrightArchive, validatePlaywrightMetadata } from './native-studio-ci.mjs';
const context = () => ({GITHUB_ACTIONS:'true',RUNNER_OS:'Windows',GITHUB_REPOSITORY:'jerry-halo2026/orange',ORANGE_REPOSITORY_VISIBILITY:'public',GITHUB_REF:'refs/heads/codex/t05-path-policy',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKSPACE:'D:\\a\\orange\\orange',GITHUB_EVENT_NAME:'push'});
const mandatory='real Windows file-symbolic marker refuses before native callback';
function tap() {return 'TAP version 13\n'+Array.from({length:110},(_,i)=>`# Subtest: ${i===109?mandatory:'case-'+i}\nok ${i+1} - ${i===109?mandatory:'case-'+i}\n  ---\n  duration_ms: 1\n  type: test\n  ...\n`).join('')+'1..110\n# tests 110\n# suites 0\n# pass 110\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 110\n';}
test('derives only the fresh native Studio CI namespace from the exact public topic',()=>{const got=validateNativeStudioContext(context());assert.equal(got.ownedRoot,'D:\\a\\orange\\orange\\.dev\\native-studio-ci\\123\\1');assert.equal(got.commit,'a'.repeat(40));assert.equal(validateNativeStudioContext({...context(),GITHUB_EVENT_NAME:'workflow_dispatch'}).workspace,'D:\\a\\orange\\orange');});
for(const [key,value] of Object.entries({GITHUB_ACTIONS:'false',RUNNER_OS:'Linux',GITHUB_REPOSITORY:'fork/orange',ORANGE_REPOSITORY_VISIBILITY:'private',GITHUB_REF:'refs/pull/1/merge',GITHUB_SHA:'a'.repeat(39),GITHUB_RUN_ID:'../1',GITHUB_RUN_ATTEMPT:'0',GITHUB_WORKSPACE:'\\\\server\\share',GITHUB_EVENT_NAME:'pull_request'})) test('rejects untrusted context '+key,()=>assert.throws(()=>validateNativeStudioContext({...context(),[key]:value})));
for(const workspace of ['C:\\a\\..\\orange','C:\\a\\CONIN$\\orange','C:\\a\\CONOUT$.txt\\orange','C:\\a\\bad.\\orange','C:\\a\\bad:stream\\orange','C:\\a\\UPPER~1\\orange','C:\\a\\orange\\','C:/a/orange']) test('rejects workspace alias '+JSON.stringify(workspace),()=>assert.throws(()=>validateNativeStudioContext({...context(),GITHUB_WORKSPACE:workspace})));
test('accepts exactly 110 distinct passed cases including the real file marker',()=>{const x=verifyNativeStudioTap(tap(),0);assert.equal(x.passed,110);assert.equal(x.testNames.length,110);assert.equal(x.skipped,0);});
for(const [name,change,exit] of [
 ['exit',s=>s,1],['109',s=>s.replace('1..110','1..109'),0],['111',s=>s.replace('1..110','1..111'),0],['duplicate',s=>s.replace('ok 2 - case-1','ok 2 - case-0'),0],['missing mandatory',s=>s.replaceAll(mandatory,'other'),0],['skip',s=>s.replace('ok 1 - case-0','ok 1 - case-0 # SKIP'),0],['todo',s=>s.replace('ok 1 - case-0','ok 1 - case-0 # TODO'),0],['cancelled',s=>s.replace('# cancelled 0','# cancelled 1'),0],['failed',s=>s.replace('ok 1 -','not ok 1 -'),0],['nested',s=>s.replace('ok 1 -','    ok 1 -'),0],['bail',s=>s+'Bail out!\n',0],['duplicate summary',s=>s+'# pass 110\n',0],['false pass',s=>s.replace('# pass 110','# pass 109'),0],['extra malformed result',s=>s+'ok unnumbered - injected\n',0],['incomplete',s=>s.replace('# skipped 0\n',''),0],['suite',s=>s.replace('# suites 0','# suites 1'),0]
]) test('TAP refuses '+name,()=>assert.throws(()=>verifyNativeStudioTap(change(tap()),exit)));
test('source policy rejects absent, duplicate, invented and caller-provided pin sets',()=>{for(const records of [[],[{path:'invented',raw:Buffer.from('x'),blob:Buffer.from('x'),mode:'100644',ordinary:true,nlink:1}],Array(27).fill({path:'scripts/native-studio-ci.mjs',raw:Buffer.from('x'),blob:Buffer.from('x'),mode:'100644',ordinary:true,nlink:1})]) assert.throws(()=>validateNativeStudioSources(records));assert.throws(()=>validateNativeStudioSources([], {pins:[]}));});
const entries=()=>[{name:'package/',type:'directory',size:0},{name:'package/package.json',type:'file',size:64},{name:'package/LICENSE',type:'file',size:32},{name:'package/NOTICE',type:'file',size:16}];
test('archive permits only bounded regular files and directories in package',()=>assert.equal(validatePlaywrightArchiveEntries(entries()).length,4));
for(const name of ['/package/a','../a','package/../a','package/./a','package//a','package\\a','package/a:ads','package/a\0b','package/CON','package/conin$.txt','package/a.','Package/a','other/a','package/a\nb','package/a~1']) test('archive refuses path '+JSON.stringify(name),()=>assert.throws(()=>validatePlaywrightArchiveEntries([...entries(),{name,type:'file',size:1}])));
for(const type of ['symlink','hardlink','block-device','character-device','fifo','pax','unknown']) test('archive refuses type '+type,()=>assert.throws(()=>validatePlaywrightArchiveEntries([...entries(),{name:'package/bad',type,size:0}])));
test('archive rejects count, size, duplicates, case aliases and file ancestors',()=>{for(const e of [[],Array.from({length:513},(_,i)=>({name:'package/a'+i,type:'file',size:0})),[...entries(),{name:'package/large',type:'file',size:32*1024*1024}],[...entries(),entries()[1]],[...entries(),{name:'package/notice',type:'file',size:1}],[...entries(),{name:'package/LICENSE/sub',type:'file',size:1}],[...entries(),{name:'package/bad',type:'file',size:-1}],[...entries(),{name:'package/bad',type:'directory',size:1}]]) assert.throws(()=>validatePlaywrightArchiveEntries(e));});
const pkg=()=>({name:'playwright-core',version:'1.61.1',license:'Apache-2.0'});
const license=()=>Buffer.from('Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/');
const notice=()=>Buffer.from('Playwright\nCopyright Microsoft Corporation');
test('package requires exact original pin and independent Apache license material',()=>assert.equal(validatePlaywrightMetadata(pkg(),license(),notice()).name,'playwright-core'));
for(const patch of [{name:'playwright'},{version:'1.61.0'},{license:'MIT'},{scripts:{}},{dependencies:{}},{optionalDependencies:{}},{peerDependencies:{}},{bundledDependencies:[]}]) test('package refuses metadata '+Object.keys(patch),()=>assert.throws(()=>validatePlaywrightMetadata({...pkg(),...patch},license(),notice())));
test('package rejects missing or wrong LICENSE and NOTICE',()=>{for(const [l,n] of [[Buffer.alloc(0),notice()],[Buffer.from('MIT'),notice()],[license(),Buffer.alloc(0)]]) assert.throws(()=>validatePlaywrightMetadata(pkg(),l,n));});
function tarGzip(type='0',name='package/package.json') {const h=Buffer.alloc(512);h.write(name);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write('00000000002\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h.write(type,156);h.write('ustar\0',257);h.write('00',263);const sum=h.reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);return gzipSync(Buffer.concat([h,Buffer.from('{}'),Buffer.alloc(510),Buffer.alloc(1024)]));}
test('tar parser reads verified header paths and sizes without extraction',()=>assert.deepEqual(parsePlaywrightArchive(tarGzip()).map(x=>({name:x.name,type:x.type,size:x.size})),[{name:'package/package.json',type:'file',size:2}]));
for(const type of ['1','2','3','4','6','x','g','L','K']) test('tar parser rejects unsupported entry '+type,()=>assert.throws(()=>parsePlaywrightArchive(tarGzip(type))));
test('tar parser rejects traversal, malformed compressed data and oversized streams',()=>{assert.throws(()=>parsePlaywrightArchive(tarGzip('0','package/../escape')));assert.throws(()=>parsePlaywrightArchive(Buffer.from('bad')));assert.throws(()=>parsePlaywrightArchive(gzipSync(Buffer.alloc(33*1024*1024))));});


import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const sourceFixturePins = [
 ['packages/openfilm/src/development-isolation.mjs','847db36ff9f20fd2ca628837809a02f787d7150c66efb5da6d91044e43d9ffd8'],
 ['scripts/fission-path-ci.mjs','913d98152b45df0fac17cbad91280017faee4fe6880249d09758432e6816e4cc'],
 ['scripts/phase1-admission.mjs','a56649bc301c6402d942dd094ae6cf9abe6399fc02decc5474d9b5db6c7731cd'],
 ['packages/openfilm/package.json','374451a588d0975f4e8f31c4c9c3cfd41f77aed15d98e315154a7052c7dc3399'],
 ['pnpm-lock.yaml','6e337f4e41abff52b05380b48517f1e479a2b96cae0a653d837b5ff6d1bd3c55'],
 ['scripts/phase1-isolation.test.mjs','c6ef87ad5be39b6ea52ecbca5ebfdf47296249d20a8ae9c3b2788fa6925dba07'],
 ['packages/openfilm/src/development-isolation.test.mjs','806b22cfce97f5585d00996b45cd6e3daec119970073e513d86d3eb4c14aea89'],
 ['packages/openfilm/studio/server/project-control-guard.mjs','ae64f900ee1895d3a6d39b92bed3e279ef20e98c0576f8bcef4862063444525c'],
 ['packages/openfilm/studio/server/projects.mjs','8aba0b914fbc4da13c55e510cf02e6a04426f52b7e538d74ee01b62c8810ba54'],
 ['packages/openfilm/studio/server/auto-versions.mjs','3c064ac4a66d9495a0cfc8da333d1432839d4a19bb49e2477218251b29dd4cad'],
 ['packages/openfilm/studio/server/server.mjs','34d0e29bee3801a8e5cc4dbff52f4f69faf45181c80fda07981bcb80b77256b2'],
 ['packages/openfilm/studio/server/project-control-guard.test.mjs','cb77f17415bba41f4fc8b990ed37d9dd722511b8d20468c965fe7eeb1b6a6f62'],
 ['packages/openfilm/studio/server/projects-control.test.mjs','f1dcbbc8d7ebb467ee4810d1035eeb002b140caf2cf41dd102f52bd730a5a388'],
 ['packages/openfilm/studio/server/auto-versions.test.mjs','c9f73d5bed69f1bbc2831be50d8910b650e26f4effe4df0c22a07af79c2d76fa'],
 ['packages/openfilm/studio/server/server-auto-versions.test.mjs','93f69303a3cc37f6a0ca75a25aebdb6e279b973b645c32bdaef878ffda9c07dc'],
 ['packages/openfilm/studio/server/watch.mjs','192a6d2de4e8bc1fb004aed8d1590b22b12184afa4165530a5161b7a8adfb211'],
 ['packages/openfilm/studio/server/watch.test.mjs','64c3371ef56896f98016ab36f3eee08eb6eb59bdf3d755325c2cdf0285c01a31'],
 ['packages/openfilm/studio/server/server-watch-drain.test.mjs','64601c80a80f232663d56ff623076eb25e352024461cfe0af0539d1fdaa8f49c'],
 ['packages/openfilm/studio/server/person-edits.mjs','27c6a36f470b6fcef535a4ee2a1f01a23693a6fb22c749ae27649efc83dc3863'],
 ['packages/openfilm/studio/server/person-merge.mjs','6369b3aa2c5e67257833de8dde5bd836aa4b54186d97d99053452cb445662e3f'],
 ['packages/openfilm/studio/server/person-merge-worker.mjs','83ea4a07b386d88fc7bb43f5c631d88dfa89a64d2e967031ca89925aaead6c5e'],
 ['packages/openfilm/studio/server/person-edits-worker-lifecycle.test.mjs','cac7a8d56bdd5ac9e8385c4e176880b77d6f775d476f9ce36db8b59f9972e184'],
 ['packages/openfilm/studio/server/person-merge.test.mjs','53478fca489452441b125d8709fa60f479f1713843c30bae77d31a4f1731518e'],
];
function sourceRecords() {
 const digest=b=>createHash('sha256').update(b).digest('hex');
 const records=sourceFixturePins.map(([path,pin])=>{const raw=readFileSync(new URL('../'+path,import.meta.url));const lf=Buffer.from(raw.toString('utf8').replaceAll('\r\n','\n'));const blob=digest(raw)===pin?raw:lf;assert.equal(digest(blob),pin,'fixture must itself be the reviewed producer');return {path,raw:Buffer.from(raw),blob:Buffer.from(blob),mode:'100644',ordinary:true,nlink:1};});
 for(const path of ['.github/workflows/native-studio.yml','scripts/native-studio-ci.mjs','scripts/native-studio-ci.test.mjs','packages/openfilm/studio/server/project-file-symlink.test.mjs'])records.push({path,raw:Buffer.from('current candidate\r\n'),blob:Buffer.from('current candidate\n'),mode:'100644',ordinary:true,nlink:1});
 return records;
}
test('sources accept the actual 23 frozen input byte fixtures and four same-candidate producers',()=>{const result=validateNativeStudioSources(sourceRecords());assert.equal(result.length,27);assert.equal(result.find(x=>x.path==='packages/openfilm/studio/server/project-control-guard.mjs').gitBlobSha256,'ae64f900ee1895d3a6d39b92bed3e279ef20e98c0576f8bcef4862063444525c');});
for(const [name,change] of [
 ['modified raw',r=>{r[0].raw=Buffer.from('changed\n');}],['modified source and Git blob',r=>{r[0].raw=r[0].blob=Buffer.from('changed\n');}],['UTF8 BOM',r=>{r[0].raw=Buffer.concat([Buffer.from([239,187,191]),r[0].raw]);}],['invalid UTF8',r=>{r[0].raw=Buffer.from([0xc0,0xaf]);}],['bare CR',r=>{r[0].raw=Buffer.from('x\ry');}],['internal BOM',r=>{r[23].raw=r[23].blob=Buffer.from('x\uFEFFy');}],['symbolic Git mode',r=>{r[0].mode='120000';}],['nonordinary ancestor',r=>{r[0].ordinary=false;}],['hardlink',r=>{r[0].nlink=2;}],['missing',r=>r.pop()],['duplicate',r=>{r[1]=r[0];}],['untracked self',r=>{r[23].mode=undefined;}],['self raw differs from candidate',r=>{r[23].raw=Buffer.from('other\n');}]
]) test('sources refuse '+name,()=>{const r=sourceRecords();change(r);assert.throws(()=>validateNativeStudioSources(r));});
function alteredTar(change,checksum=true){const t=gunzipSync(tarGzip());change(t);if(checksum){t.fill(32,148,156);const sum=t.subarray(0,512).reduce((a,b)=>a+b,0);t.write(sum.toString(8).padStart(6,'0')+'\0 ',148);}return gzipSync(t);}
for(const [name,change,checksum] of [
 ['checksum',t=>{t[0]=65;},false],['linkname on regular file',t=>{t[157]=65;},true],['unsupported magic',t=>{t[257]=65;},true],['nonzero trailer',t=>{t[t.length-1]=65;},true],['nonzero after string NUL',t=>{t[90]=65;},true],['base256 size',t=>{t[124]=128;},true],['size overflow',t=>{t.fill(55,124,136);},true],['invalid UTF8 name',t=>{t[0]=255;},true],['nonzero unknown tail',t=>{t[510]=1;},true]
])test('tar parser refuses '+name,()=>assert.throws(()=>parsePlaywrightArchive(alteredTar(change,checksum))));
test('tar parser insists on two final zero blocks',()=>{const t=gunzipSync(tarGzip());assert.throws(()=>parsePlaywrightArchive(gzipSync(t.subarray(0,t.length-512))));assert.throws(()=>parsePlaywrightArchive(gzipSync(t.subarray(0,1024))));});
test('archive refuses implicit case aliases and unbounded numeric sizes',()=>{for(const e of [[{name:'package/Dir/a',type:'file',size:0},{name:'package/dir/b',type:'file',size:0}],[{name:'package/a',type:'file',size:Number.MAX_SAFE_INTEGER+1}],[{name:'package/a',type:'file',size:NaN}]])assert.throws(()=>validatePlaywrightArchiveEntries(e));});

// Actual import isolation, not a mock implementation of the validators. Replacing
// an import-time read/process/fetch with an eager side effect must fail this test.
import fsDefault from 'node:fs';
import cpDefault from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
test('import defines the module without filesystem process or network activity',async t=>{
 const probes=[];
 for(const [object,names] of [[fsDefault,['readFileSync','writeFileSync','lstatSync','realpathSync','readdirSync','existsSync','mkdirSync','renameSync']],[cpDefault,['spawnSync','spawn','execSync','execFileSync']]])for(const name of names){const original=object[name];t.mock.method(object,name,(...args)=>{const stack=new Error().stack??'';if(stack.includes('node:internal/modules/')&&!stack.includes('native-studio-ci.mjs?import-isolation'))return Reflect.apply(original,object,args);probes.push(name);throw new Error('IMPORT_SIDE_EFFECT');});}
 t.mock.method(globalThis,'fetch',()=>{probes.push('fetch');throw new Error('IMPORT_SIDE_EFFECT');});syncBuiltinESMExports();
 try {const module=await import('./native-studio-ci.mjs?import-isolation');assert.equal(typeof module.runNativeStudioCI,'function');assert.deepEqual(probes,[]);}finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
import { validateSystemTarMetadata } from './native-studio-ci.mjs';
const systemTar = () => ({systemRoot:'C:\\Windows',executable:'C:\\Windows\\System32\\tar.exe',realPath:'C:\\Windows\\System32\\tar.exe',ancestorsOrdinary:true,isFile:true,isSymbolicLink:false,nlink:2,sha256:'a'.repeat(64)});
test('fixed inbox System32 tar accepts legitimate WinSxS regular hardlink metadata',()=>{const x=validateSystemTarMetadata(systemTar());assert.equal(x.executable,'C:\\Windows\\System32\\tar.exe');assert.equal(x.sha256,'a'.repeat(64));});
for(const [name,patch] of [
 ['nonfixed executable',{executable:'C:\\other\\tar.exe'}],['workspace tar',{executable:'D:\\a\\orange\\tar.exe'}],['other System32 binary',{executable:'C:\\Windows\\System32\\cmd.exe'}],['symbolic link',{isSymbolicLink:true}],['reparse ancestor',{ancestorsOrdinary:false}],['realpath alias',{realPath:'C:\\other\\tar.exe'}],['directory',{isFile:false}],['zero link count',{nlink:0}],['fractional link count',{nlink:1.5}],['invalid hash',{sha256:'bad'}],['unsafe SystemRoot',{systemRoot:'C:\\Windows\\..\\elsewhere'}]
])test('fixed system tar refuses '+name,()=>assert.throws(()=>validateSystemTarMetadata({...systemTar(),...patch})));
test('workspace source hardlinks remain refused independently of system tar metadata',()=>{const r=sourceRecords();r[0].nlink=2;assert.throws(()=>validateNativeStudioSources(r));});

import { formatNativeStudioFailure, createNativeStudioDiagnostics } from './native-studio-ci.mjs';
function thrownBy(work){try{work();}catch(error){return error;}assert.fail('fixture must produce a real validator failure');}
const failed=(phase,code)=>({status:'failed',phase,code});
for(const [phase,work,code] of [
 ['context',()=>validateNativeStudioContext({}),'CONTEXT_INVALID'],
 ['source-snapshot',()=>validateNativeStudioSources([]),'SOURCE_SET'],
 ['archive',()=>validatePlaywrightArchiveEntries([]),'ARCHIVE_COUNT'],
 ['tar',()=>validateSystemTarMetadata({}),'TOOL_PATH']
])test('diagnostics identify actual module-owned validator failure at '+phase,()=>assert.deepEqual(formatNativeStudioFailure(phase,thrownBy(work)),failed(phase,code)));
test('diagnostics never trust a forged same-message or same-code error',()=>{for(const error of [new Error('CONTEXT_INVALID'),{message:'CONTEXT_INVALID',code:'CONTEXT_INVALID'},Object.assign(new Error('SOURCE_SET'),{code:'SOURCE_SET'})])assert.deepEqual(formatNativeStudioFailure('context',error),failed('context','UNEXPECTED'));});
test('diagnostics do not inspect getters coercions proxies or revoked proxies',()=>{
 let touches=0;const bad=()=>{touches++;throw Error('PRIVATE_SENTINEL');};const hostile={get message(){return bad();},get code(){return bad();},get stack(){return bad();},toString:bad,[Symbol.toPrimitive]:bad};
 const proxy=new Proxy({}, {get:bad,getPrototypeOf:bad,ownKeys:bad,getOwnPropertyDescriptor:bad,has:bad});const revoked=Proxy.revocable({},{});revoked.revoke();
 for(const error of [hostile,proxy,revoked.proxy,undefined,null,Symbol('PRIVATE_SENTINEL'),0,17n,'PRIVATE_SENTINEL\u001b\n']){const out=formatNativeStudioFailure('tests',error);assert.deepEqual(out,failed('tests','UNEXPECTED'));assert.equal(JSON.stringify(out).includes('PRIVATE_SENTINEL'),false);}
 assert.equal(touches,0);
});
test('registered errors retain only private identity metadata after hostile properties are installed',()=>{const error=thrownBy(()=>validateNativeStudioContext({}));let touches=0;for(const key of ['message','code','stack'])Object.defineProperty(error,key,{get(){touches++;throw Error('PRIVATE_SENTINEL');},configurable:true});assert.deepEqual(formatNativeStudioFailure('context',error),failed('context','CONTEXT_INVALID'));assert.equal(touches,0);});
test('diagnostic phases are closed without coercing unknown values',()=>{let touches=0;const hostile=new Proxy({}, {get(){touches++;throw Error('PRIVATE_SENTINEL');}});for(const phase of ['PRIVATE_SENTINEL\n','CONTEXT','../context',null,undefined,hostile])assert.deepEqual(formatNativeStudioFailure(phase,new Error('PRIVATE_SENTINEL')),failed('unknown','UNEXPECTED'));assert.equal(touches,0);});
test('production diagnostic tracker latches the first failure through failing cleanup',()=>{const d=createNativeStudioDiagnostics();assert.equal(d.summary(),null);d.enter('tests');d.capture(thrownBy(()=>validateNativeStudioSources([])));d.enter('post-check');d.capture(thrownBy(()=>validatePlaywrightArchiveEntries([])));assert.deepEqual(d.summary(),failed('tests','SOURCE_SET'));assert.equal(Object.isFrozen(d.summary()),true);});
test('production diagnostic tracker fails for cleanup-only failure and never retroactively succeeds',()=>{const d=createNativeStudioDiagnostics();d.enter('post-check');d.capture(thrownBy(()=>validateNativeStudioSources([])));d.enter('result');assert.deepEqual(d.summary(),failed('post-check','SOURCE_SET'));});
test('production tracker preserves an unknown first thrown value including undefined',()=>{const d=createNativeStudioDiagnostics();d.enter('fetch');d.capture(undefined);d.enter('post-check');d.capture(thrownBy(()=>validateNativeStudioSources([])));assert.deepEqual(d.summary(),failed('fetch','UNEXPECTED'));});
test('tracker cannot register arbitrary error identities or arbitrary phase strings',()=>{const forged=Object.assign(new Error('SOURCE_SET'),{code:'SOURCE_SET'});const d=createNativeStudioDiagnostics();d.enter('PRIVATE_SENTINEL\n');d.capture(forged);assert.deepEqual(d.summary(),failed('unknown','UNEXPECTED'));assert.deepEqual(formatNativeStudioFailure('tests',forged),failed('tests','UNEXPECTED'));});
for(const phase of ['context','platform-node','workspace','node-path','systemroot','system32','tar','git','owned-directory','source-snapshot','package-pins','fixture-directory','fetch','archive','tests','post-check','result'])test('production tracker reports closed phase '+phase,()=>{const d=createNativeStudioDiagnostics();d.enter(phase);d.capture(thrownBy(()=>validateNativeStudioSources([])));assert.deepEqual(d.summary(),failed(phase,'SOURCE_SET'));});
test('tracker treats hostile phases and hostile thrown values without reading either object',()=>{let touches=0;const bad=()=>{touches++;throw Error('PRIVATE_SENTINEL');};const hostile=new Proxy({}, {get:bad,getPrototypeOf:bad,ownKeys:bad});const d=createNativeStudioDiagnostics();d.enter(hostile);d.capture(hostile);assert.deepEqual(d.summary(),failed('unknown','UNEXPECTED'));assert.equal(touches,0);});
test('TAP boundary failures receive private module identity rather than foreign message recognition',()=>{const error=thrownBy(()=>verifyNativeStudioTap('TAP version 13\n1..0\n',1));assert.deepEqual(formatNativeStudioFailure('tests',error),failed('tests','TAP_INVALID'));assert.deepEqual(formatNativeStudioFailure('tests',new Error('TAP_INVALID')),failed('tests','UNEXPECTED'));});

import { assessNativeStudioProcess } from './native-studio-ci.mjs';
test('process assessment defers failed exit propagation so the driver can persist its original receipt',()=>{let assessment;assert.doesNotThrow(()=>{assessment=assessNativeStudioProcess({status:1,stdout:Buffer.from(tap()),error:undefined,signal:null});});assert.equal(assessment.ok,false);assert.deepEqual(formatNativeStudioFailure('tests',assessment.failure),failed('tests','TAP_INVALID'));});
test('process assessment defers failed TAP while preserving module error identity',()=>{let assessment;assert.doesNotThrow(()=>{assessment=assessNativeStudioProcess({status:0,stdout:Buffer.from('invalid'),error:undefined,signal:null});});assert.equal(assessment.ok,false);assert.deepEqual(formatNativeStudioFailure('tests',assessment.failure),failed('tests','TAP_INVALID'));});
for(const patch of [{error:new Error('PRIVATE_SENTINEL')},{signal:'SIGTERM'}])test('process assessment defers process failure '+Object.keys(patch)[0],()=>{let assessment;assert.doesNotThrow(()=>{assessment=assessNativeStudioProcess({status:0,stdout:Buffer.from(tap()),signal:null,...patch});});assert.equal(assessment.ok,false);assert.deepEqual(formatNativeStudioFailure('tests',assessment.failure),failed('tests','TEST_PROCESS'));});
test('process assessment retains fixed 110 successful TAP evidence',()=>{const assessment=assessNativeStudioProcess({status:0,stdout:Buffer.from(tap()),error:undefined,signal:null});assert.equal(assessment.ok,true);assert.equal(assessment.counts.total,110);assert.equal(assessment.counts.passed,110);assert.equal(assessment.counts.skipped,0);assert.equal(Object.hasOwn(assessment,'failure'),false);});
test('deferred process failure stays first if post-check later fails',()=>{const a=assessNativeStudioProcess({status:1,stdout:Buffer.from(tap()),error:undefined,signal:null});const d=createNativeStudioDiagnostics();d.enter('tests');d.capture(a.failure);d.enter('post-check');d.capture(thrownBy(()=>validateNativeStudioSources([])));assert.deepEqual(d.summary(),failed('tests','TAP_INVALID'));});

import { validateSystemGitMetadata } from './native-studio-ci.mjs';
const systemGit=()=>({systemRoot:'C:\\Windows',executable:'C:\\Program Files\\Git\\cmd\\git.exe',realPath:'C:\\Program Files\\Git\\cmd\\git.exe',ancestorsOrdinary:true,isFile:true,isSymbolicLink:false,nlink:2,sha256:'a'.repeat(64)});
test('fixed preinstalled Git permits legitimate regular multiple-link metadata',()=>{const x=validateSystemGitMetadata(systemGit());assert.equal(x.executable,'C:\\Program Files\\Git\\cmd\\git.exe');assert.equal(x.sha256,'a'.repeat(64));});
test('fixed preinstalled Git also permits an ordinary single-link executable',()=>assert.equal(validateSystemGitMetadata({...systemGit(),nlink:1}).executable,'C:\\Program Files\\Git\\cmd\\git.exe'));
for(const [name,patch]of [
 ['PATH-selected alternative',{executable:'C:\\tools\\git.exe'}],['workspace alternative',{executable:'D:\\a\\orange\\git.exe'}],['other drive',{executable:'D:\\Program Files\\Git\\cmd\\git.exe'}],['wrong leaf case',{executable:'C:\\Program Files\\Git\\cmd\\GIT.exe'}],['wrong ancestor case',{executable:'C:\\program files\\Git\\cmd\\git.exe'}],['relative path',{executable:'git.exe'}],['reparse leaf',{isSymbolicLink:true}],['reparse ancestor',{ancestorsOrdinary:false}],['directory',{isFile:false}],['different realpath',{realPath:'C:\\other\\git.exe'}],['realpath case alias',{realPath:'C:\\Program Files\\git\\cmd\\git.exe'}],['invalid digest',{sha256:'bad'}],['uppercase digest',{sha256:'A'.repeat(64)}],['zero links',{nlink:0}],['negative links',{nlink:-1}],['fractional links',{nlink:1.5}],['nonfinite links',{nlink:Infinity}],['unsafe link count',{nlink:Number.MAX_SAFE_INTEGER+1}],['relative SystemRoot',{systemRoot:'Windows'}],['UNC SystemRoot',{systemRoot:'\\\\server\\Windows'}]
])test('fixed Git metadata rejects '+name,()=>assert.throws(()=>validateSystemGitMetadata({...systemGit(),...patch})));
test('Git metadata acceptance does not relax workspace source hardlink policy',()=>{const r=sourceRecords();r[0].nlink=2;assert.throws(()=>validateNativeStudioSources(r));});

function alignmentTap(n){return 'TAP version 13\n'+Array.from({length:n},(_,i)=>`ok ${i+1} - ${i===n-1?mandatory:'alignment-'+i}\n`).join('')+`1..${n}\n# tests ${n}\n# suites 0\n# pass ${n}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;}
test('latest alignment accepts exactly110 all-passed cases',()=>assert.equal(verifyNativeStudioTap(alignmentTap(110),0).passed,110));
for(const count of [66,109,111])test('latest alignment rejects retired or incomplete count '+count,()=>assert.throws(()=>verifyNativeStudioTap(alignmentTap(count),0)));
test('latest alignment accepts actual twenty-three fixed producers plus four synthetic self records',()=>assert.equal(validateNativeStudioSources(sourceRecords()).length,27));
test('latest alignment rejects retired nineteen-record source subset',()=>{const r=sourceRecords().filter(x=>!['watch.mjs','watch.test.mjs','server-watch-drain.test.mjs','person-edits.mjs','person-merge.mjs','person-merge-worker.mjs','person-edits-worker-lifecycle.test.mjs','person-merge.test.mjs'].some(n=>x.path==='packages/openfilm/studio/server/'+n));assert.equal(r.length,19);assert.throws(()=>validateNativeStudioSources(r));});
for(const name of ['watch.mjs','watch.test.mjs','server-watch-drain.test.mjs'])test('latest alignment refuses missing new producer '+name,()=>assert.throws(()=>validateNativeStudioSources(sourceRecords().filter(x=>x.path!=='packages/openfilm/studio/server/'+name))));
test('latest alignment refuses raw versus blob mismatch on the actual watch producer',()=>{const r=sourceRecords();r.find(x=>x.path.endsWith('/watch.mjs')).raw=Buffer.from('changed raw\n');assert.throws(()=>validateNativeStudioSources(r));});
test('latest alignment refuses unreviewed server bytes even when raw and blob agree',()=>{const r=sourceRecords(),server=r.find(x=>x.path.endsWith('/server.mjs'));server.raw=server.blob=Buffer.from('not the reviewed native caller\n');assert.throws(()=>validateNativeStudioSources(r));});
// Each boundary catches a specific wrong result/count, forged exit summary,
// inherited environment, or weakened reviewed-source check. No Worker is run.
import { verifyMergeWorkerTap, deriveMergeWorkerEnvironment, assessMergeWorkerProcess } from './native-studio-ci.mjs';
const workerMandatory = ['default native worker merges two roots incrementally; stop waits for idle actual exit and restart is cold','stop waits for current and two retired actual threads, one exit at a time'];
const workerEvidence = '# owned Worker evidence: created=18, actual exits=18, peak=3, final alive=0';
function workerTap(n=51) {return 'TAP version 13\n'+Array.from({length:n},(_,i)=>`# Subtest: ${workerMandatory[i]??'worker-case-'+i}\nok ${i+1} - ${workerMandatory[i]??'worker-case-'+i}\n  ---\n  duration_ms: 1\n  type: test\n  ...\n`).join('')+workerEvidence+`\n1..${n}\n# tests ${n}\n# suites 0\n# pass ${n}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n`;}
for(const peak of [1,2,3,4])test('Worker TAP accepts fixed51 and actual-exit evidence peak '+peak,()=>{const got=verifyMergeWorkerTap(workerTap().replace('peak=3','peak='+peak),0);assert.equal(got?.total,51);assert.equal(got.passed,51);assert.equal(got.testNames.length,51);assert.deepEqual(got.workerEvidence,{created:18,actualExits:18,peak,finalAlive:0});assert.equal(Object.isFrozen(got),true);assert.equal(Object.isFrozen(got.workerEvidence),true);assert.equal(Object.isFrozen(got.testNames),true);});
test('Worker TAP accepts CRLF only as line ending normalization',()=>assert.equal(verifyMergeWorkerTap(workerTap().replaceAll('\n','\r\n'),0)?.passed,51));
for(const count of [18,33,50,52,110,161])test('Worker TAP rejects retired or non51 count '+count,()=>assert.throws(()=>verifyMergeWorkerTap(workerTap(count),0)));
for(const [name,change,exit=0] of [
 ['failed exit',s=>s,1],['null exit',s=>s,null],['string exit',s=>s,'0'],
 ['missing first mandatory',s=>s.replaceAll(workerMandatory[0],'other-one')],['missing second mandatory',s=>s.replaceAll(workerMandatory[1],'other-two')],
 ['duplicate name',s=>s.replaceAll('worker-case-3','worker-case-2')],['nested result',s=>s.replace('ok 1 -','    ok 1 -')],['nested plan',s=>s.replace('1..51','    1..51')],
 ['failed result',s=>s.replace('ok 1 -','not ok 1 -')],['skip',s=>s.replace('ok 3 - worker-case-2','ok 3 - worker-case-2 # SKIP unavailable')],['todo',s=>s.replace('ok 3 - worker-case-2','ok 3 - worker-case-2 # TODO later')],
 ['cancelled',s=>s.replace('# cancelled 0','# cancelled 1')],['skipped',s=>s.replace('# skipped 0','# skipped 1')],['todo count',s=>s.replace('# todo 0','# todo 1')],['suites',s=>s.replace('# suites 0','# suites 1')],['false pass',s=>s.replace('# pass 51','# pass 50')],['false total',s=>s.replace('# tests 51','# tests 50')],
 ['duplicate summary',s=>s+'# pass 51\n'],['missing summary',s=>s.replace('# suites 0\n','')],['bailout',s=>s+'  Bail out! failure\n'],['malformed result',s=>s+'ok injected - forged\n'],['duplicate plan',s=>s+'1..51\n'],['wrong ordinal',s=>s.replace('ok 3 -','ok 4 -')],['nonASCII name',s=>s.replaceAll('worker-case-2','worker-\u001b-name')]
])test('Worker TAP refuses '+name,()=>assert.throws(()=>verifyMergeWorkerTap(change(workerTap()),exit)));
for(const [name,line] of [
 ['missing',''],['created17',workerEvidence.replace('created=18','created=17')],['created19',workerEvidence.replace('created=18','created=19')],['exits17',workerEvidence.replace('exits=18','exits=17')],['exits19',workerEvidence.replace('exits=18','exits=19')],['zero peak',workerEvidence.replace('peak=3','peak=0')],['peak5',workerEvidence.replace('peak=3','peak=5')],['live worker',workerEvidence.replace('alive=0','alive=1')],['fractional peak',workerEvidence.replace('peak=3','peak=3.5')],['leading zero',workerEvidence.replace('created=18','created=018')],['wrong label',workerEvidence.replace('actual exits','unref')],['trailing assertion',workerEvidence+' forged'],['prefix', 'forged '+workerEvidence],['nested','    '+workerEvidence],['embedded CR',workerEvidence.replace('peak=3','peak=\r3')],['duplicate',workerEvidence+'\n'+workerEvidence],['valid plus malformed',workerEvidence+'\n# owned Worker evidence: forged'],['inline',workerEvidence.replace('# owned','ok 52 - owned')]
])test('Worker evidence refuses '+name,()=>assert.throws(()=>verifyMergeWorkerTap(workerTap().replace(workerEvidence,line),0)));
test('Worker TAP refuses caller expected-count or evidence policy overrides',()=>{assert.throws(()=>verifyMergeWorkerTap(workerTap(),0,{expected:51}));assert.throws(()=>verifyMergeWorkerTap(workerTap(33),0,{expected:33}));assert.throws(()=>verifyMergeWorkerTap(Buffer.from(workerTap()),0));assert.throws(()=>verifyMergeWorkerTap('x'.repeat(8*1024*1024+1),0));});
for(const [name,patch] of [['exit',{status:1}],['missing exit',{status:null}],['signal',{signal:'SIGTERM'}],['process error',{error:new Error('PRIVATE_SENTINEL')}],['invalid TAP',{stdout:Buffer.from('invalid')}],['forged evidence',{stdout:Buffer.from(workerTap().replace('exits=18','exits=17'))}]])test('Worker process preserves a deferred failed receipt for '+name,()=>{const result=assessMergeWorkerProcess({status:0,signal:null,stdout:Buffer.from(workerTap()),...patch});assert.equal(result?.ok,false);assert.deepEqual(Object.keys(formatNativeStudioFailure('worker-tests',result.failure)),['status','phase','code']);assert.equal(formatNativeStudioFailure('worker-tests',result.failure).phase,'worker-tests');});
test('Worker process assessment retains51 without changing Native110',()=>{const r=assessMergeWorkerProcess({status:0,signal:null,stdout:Buffer.from(workerTap())});assert.equal(r?.ok,true);assert.equal(r.counts.passed,51);assert.equal(assessNativeStudioProcess({status:0,signal:null,stdout:Buffer.from(tap())}).counts.passed,110);assert.equal(Object.hasOwn(r,'failure'),false);});
test('Worker failure stays first when final source check fails',()=>{const d=createNativeStudioDiagnostics(),a=assessMergeWorkerProcess({status:0,signal:null,stdout:Buffer.from(workerTap().replace('exits=18','exits=17'))});assert.equal(a?.ok,false);d.enter('worker-tests');d.capture(a.failure);d.enter('worker-post-check');d.capture(thrownBy(()=>validateNativeStudioSources([])));assert.deepEqual(d.summary(),failed('worker-tests','WORKER_EVIDENCE'));});
test('forged Worker evidence errors cannot claim module diagnostic identity',()=>assert.deepEqual(formatNativeStudioFailure('worker-tests',new Error('WORKER_EVIDENCE')),failed('worker-tests','UNEXPECTED')));
for(const phase of ['worker-directory','worker-tests','worker-post-check','worker-result'])test('diagnostics admit only reviewed Worker phase '+phase,()=>{const d=createNativeStudioDiagnostics();d.enter(phase);d.capture(thrownBy(()=>validateNativeStudioSources([])));assert.deepEqual(d.summary(),failed(phase,'SOURCE_SET'));});
const scratchKeys=['TEMP','TMP','TMPDIR','HOME','USERPROFILE','APPDATA','LOCALAPPDATA'];
const expectedWorkerScratch='D:\\a\\orange\\orange\\.dev\\merge-worker-lifecycle\\123\\1\\scratch';
test('Worker environment derives seven identical locations in its own run attempt',()=>{const got=deriveMergeWorkerEnvironment({...context(),PRIVATE_SENTINEL:'secret',NODE_OPTIONS:'--import=hostile',PATH:'hostile',TEMP:'C:\\Users\\real'},'C:\\Windows');assert.equal(got?.scratch,expectedWorkerScratch);assert.equal(got.ownedRoot,'D:\\a\\orange\\orange\\.dev\\merge-worker-lifecycle\\123\\1');for(const key of scratchKeys)assert.equal(got.env[key],expectedWorkerScratch);assert.equal(got.env.PATH,'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd');assert.equal(got.env.ComSpec,'C:\\Windows\\System32\\cmd.exe');assert.equal(got.env.GIT_CONFIG_GLOBAL,'D:\\a\\orange\\orange\\.dev\\native-studio-ci\\123\\1\\empty.gitconfig');assert.equal(got.env.GIT_CONFIG_NOSYSTEM,'1');assert.equal(Object.isFrozen(got),true);assert.equal(Object.isFrozen(got.env),true);assert.equal(JSON.stringify(got).includes('PRIVATE_SENTINEL'),false);assert.equal(Object.hasOwn(got.env,'NODE_OPTIONS'),false);assert.equal(Object.hasOwn(got.env,'GITHUB_TOKEN'),false);assert.equal(validateNativeStudioContext(context()).ownedRoot,'D:\\a\\orange\\orange\\.dev\\native-studio-ci\\123\\1');});
for(const patch of [{GITHUB_RUN_ID:'../other'},{GITHUB_RUN_ID:'01'},{GITHUB_RUN_ATTEMPT:'0'},{GITHUB_RUN_ATTEMPT:'../2'},{GITHUB_WORKSPACE:'D:\\a\\..\\orange'},{GITHUB_WORKSPACE:'D:\\a\\CON\\orange'},{GITHUB_REPOSITORY:'fork/orange'},{GITHUB_ACTIONS:'false'},{GITHUB_REF:'refs/heads/main'},{GITHUB_EVENT_NAME:'pull_request'}])test('Worker environment rejects unvalidated '+JSON.stringify(patch),()=>assert.throws(()=>deriveMergeWorkerEnvironment({...context(),...patch},'C:\\Windows')));
for(const root of ['Windows','C:\\Windows\\..\\elsewhere','C:\\Windows\\','C:/Windows','\\\\server\\Windows','C:\\CON','C:\\bad.'])test('Worker environment rejects unsafe system root '+JSON.stringify(root),()=>assert.throws(()=>deriveMergeWorkerEnvironment(context(),root)));
test('Worker environment rejects policy override and overlong derived namespace',()=>{assert.throws(()=>deriveMergeWorkerEnvironment(context(),'C:\\Windows',{scratch:'C:\\real'}));assert.throws(()=>deriveMergeWorkerEnvironment({...context(),GITHUB_WORKSPACE:'D:\\'+ 'a'.repeat(195)},'C:\\Windows'));});
test('different Worker attempts cannot share scratch',()=>{const a=deriveMergeWorkerEnvironment(context(),'C:\\Windows'),b=deriveMergeWorkerEnvironment({...context(),GITHUB_RUN_ATTEMPT:'2'},'C:\\Windows');assert.equal(a?.scratch,expectedWorkerScratch);assert.notEqual(a.scratch,b.scratch);});
const kernelNames=['person-edits.mjs','person-merge.mjs','person-merge-worker.mjs','person-edits-worker-lifecycle.test.mjs','person-merge.test.mjs'];
for(const name of kernelNames)for(const kind of ['missing','changed raw','changed raw and blob','hardlink'])test('Worker source pin refuses '+kind+' '+name,()=>{const r=sourceRecords(),p='packages/openfilm/studio/server/'+name,i=r.findIndex(x=>x.path===p);assert.notEqual(i,-1);if(kind==='missing')r.splice(i,1);if(kind==='changed raw')r[i].raw=Buffer.from('changed\n');if(kind==='changed raw and blob')r[i].raw=r[i].blob=Buffer.from('changed\n');if(kind==='hardlink')r[i].nlink=2;assert.throws(()=>validateNativeStudioSources(r));});
test('Worker source policy rejects the retired22-record source set',()=>{const r=sourceRecords().filter(x=>!kernelNames.some(n=>x.path==='packages/openfilm/studio/server/'+n));assert.equal(r.length,22);assert.throws(()=>validateNativeStudioSources(r));});

// Reviewed literal names, independently compared with the pinned source below.
// These fixtures do not import or execute either native test module.
const nativeWorkerNames=Object.freeze([
 "a write from an older copy: the person's edits since stay, the writer's own changes are taken",
 "a unit only the writer changed is the writer's, a return to an older value too; both changed: the person's",
 "a field's default and its absence are alike: Studio writing at 0 as nothing is no change of the person's, and named none",
 "V2: an overrides entry is merged property by property, its style key by key",
 "clips: the writer's removal stands; one the person changed stays; one added since the base stays (V6); the person's removal stands",
 "tracks: the person's move and the writer's new clips both stay; the person's order and flag over the writer's new tracks",
 "a clip whose merge would not read: only the writer's fields that make it so go back to the person's; its others stay",
 "the version a write is nearest to: the fewest units apart, the oldest of those as near; a clip one lacks counts once",
 "ties go to the person: an undo back to an older value stands over a write as near to the versions before and after",
 "notes the write agrees with: one naming a clip's unit, and one naming no clip (the stage), by the whole film",
 "ties go to the person in all a unit holds: an entry some of the versions as near lack, every property of it (seed 3649)",
 "the quick comparison of kept versions counts as distance does, and names what differing does",
 "renames: a clip the writer gave a new id is the person's clip, its edits kept under the new id; a new clip is not",
 "lines: each side's change is taken, next to each other too; where both changed the same lines, the side preferred",
 "the store, V1: a copy older than any edit of the person's, after a note too, keeps the person's value",
 "the store, V3: an older copy whose value was rounded keeps the person's value, before a note and after",
 "the store: told of an edit, an agent writing back exactly the older values from the latest copy is taken as meant",
 "the store: an undo is a write like any other: 1 → 4 → 6, undone to 4, an older copy with 1 gets 4",
 "the store: a note counts only once said passed on; each agent is given it once",
 "the store: versions share what is alike: hundreds of edits of a long film keep memory and time per edit small",
 "the store: edits of one thing in a row are one version; anchors (writes of others, the version before the person's edits) are never let go",
 "the store: an agent writing again and again keeps the versions to the caps, and its merges as quick",
 "the store: past the caps, the first version stays, and a copy older than all kept but it keeps the person's edits",
 "the store: an agent's own value is no edit of the person's: its next write changes it, and it is not named (E)",
 "the store: the agent moves what it was told of, then an old copy comes again: its move stays, and the person is not named for it (r5)",
 "the store: a note passed on lets its agent change what it named, only while no other agent has asked since the person's edit",
 "the store: a 5,000-clip film: an edit is recorded in a few ms, and a merge runs in a worker while Studio answers",
 "the store: text files as bytes, Studio's own write no news, a page in any encoding kept as it is; a person's page comes back",
 "the store, V7: a pasted layer stays over an older copy of the page with a change of its own, after a note too",
 "the store: a layer pasted, and a block the agent adds from its copy before: both, each with its own closing tag (pagecount)",
 "the store, t7d: undoing a second paste keeps the page's bytes as bytes",
 "random interleavings of the person's edits and two agents' writes, from copies of every age, merge as from the base each really had",
 "random interleavings on a page: the person's lines and each agent's own stay, as from the base each really had",
 "default native worker merges two roots incrementally; stop waits for idle actual exit and restart is cold",
 "stopped admission rejects before getters, state and configured computation",
 "getter stop reentry retains the admitted full call and same-turn native merge",
 "stop waits for a real reply, full continuation and separately gated actual exit delivery",
 "configure detaches A before B is created; A late error and exit cannot fail B",
 "stop waits for current and two retired actual threads, one exit at a time",
 "reply-error uses the original ordinary merge fallback and drains its real thread",
 "abnormal-exit uses the original ordinary merge fallback and drains its real thread",
 "error-event uses the original ordinary merge fallback and drains its real thread",
 "timeout keeps the whole person film, skips ordinary fallback, and still waits for actual exit",
 "synchronous post failure falls back without leaving a timer or an unowned thread",
 "native constructor failure preserves whole-person-film fallback and finishes bookkeeping",
 "stop reentered from real Worker construction cannot lose the newly owned thread",
 "a rejected termination is not quiescence and cannot permit restart before real exit",
 "a large merge admitted before a stopping getter still waits for its real native reply",
 "configure during real construction retains the retired thread and starts a cold replacement",
 "a throwing admitted getter rejects its call without poisoning stop or reopening admission",
 "stop and restart preserve the pending note, person edits, versions and last merge history"
]);

function sourceWorkerNames(source) {
 const literals=[...source.matchAll(/^test\('((?:[^'\\\r\n]|\\')*)',/gm)];
 const dynamic="]) test(\x60\x24{name} uses the original ordinary merge fallback and drains its real thread\x60,";
 const calls=[...source.matchAll(/\btest\(/g)].map(m=>m.index);
 const accepted=new Set(literals.map(m=>m.index));
 const dynamicIndex=source.indexOf(dynamic);
 if(dynamicIndex>=0){assert.equal(source.indexOf(dynamic,dynamicIndex+1),-1);accepted.add(dynamicIndex+3);assert.match(source,/\['reply-error', "parentPort\.postMessage/);assert.match(source,/\['abnormal-exit', 'process\.exit\(3\);'\]/);assert.match(source,/\['error-event', "throw new Error\('owned worker failure'\);"\]/);}
 assert.deepEqual(calls,[...accepted].sort((a,b)=>a-b),'every test call must use a reviewed supported literal form');
 const names=literals.map(m=>({at:m.index,name:m[1].replaceAll("\\'","'")}));
 if(dynamicIndex>=0)names.push(...['reply-error','abnormal-exit','error-event'].map(n=>({at:dynamicIndex,name:n+' uses the original ordinary merge fallback and drains its real thread'})));
 return names.sort((a,b)=>a.at-b.at).map(x=>x.name);
}
function sourceGroundedWorkerTap() {
 const paths=['packages/openfilm/studio/server/person-merge.test.mjs','packages/openfilm/studio/server/person-edits-worker-lifecycle.test.mjs'];
 // sourceRecords asserts the original producer hashes before reading literals.
 sourceRecords();
 assert.deepEqual(paths.flatMap(p=>sourceWorkerNames(readFileSync(new URL('../'+p,import.meta.url),'utf8'))),nativeWorkerNames);
 return 'TAP version 13\n'+nativeWorkerNames.map((n,i)=>'# Subtest: '+n+'\nok '+(i+1)+' - '+n+'\n').join('')+workerEvidence+'\n1..51\n# tests 51\n# suites 0\n# pass 51\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
}
test('all51 frozen native names including exact native undo arrows remain faithful',()=>{
 const got=verifyMergeWorkerTap(sourceGroundedWorkerTap(),0);assert.deepEqual(got.testNames,nativeWorkerNames);assert.equal(got.workerEvidence.actualExits,18);
});
import * as observabilityModule from './native-studio-ci.mjs';
test('owned Worker failure observation survives assessment capture and CLI bridge',()=>{
 const a=assessMergeWorkerProcess({status:7,error:null,signal:null,stdout:Buffer.from('PRIVATE_SENTINEL\n1..51\n# tests 51\n# fail 1\n'),stderr:Buffer.from('PRIVATE_SENTINEL')});
 const d=createNativeStudioDiagnostics();d.enter('worker-tests');d.observeWorker(a);d.capture(a.failure);
 const wrapped=d.failure();
 const out=observabilityModule.formatNativeStudioCliFailure(wrapped);
 assert.equal(out.workerEvidence?.exitCode,7,'CLI bridge must retain only bounded actual process observation');
 assert.equal(out.workerEvidence?.tap.fail,1);assert.equal(JSON.stringify(out).includes('PRIVATE_SENTINEL'),false);
});

const nativeUndoName='the store: an undo is a write like any other: 1 → 4 → 6, undone to 4, an older copy with 1 gets 4';
for(const [label,name] of [
 ['other Unicode','worker-雪'],['lookalike arrow',nativeUndoName.replace('→','➜')],['variation selector',nativeUndoName+'\uFE0F'],['zero width',nativeUndoName+'\u200B'],['normalization lookalike',nativeUndoName.replace('1','１')],['control',nativeUndoName+'\u001b'],['newline',nativeUndoName+'\ninjected'],['trailing space',nativeUndoName+' '],['prefix', 'x'+nativeUndoName],['nonliteral arrow name','another undo 1 → 4']
])test('native name exception remains closed for '+label,()=>assert.throws(()=>verifyMergeWorkerTap(workerTap().replaceAll('worker-case-2',name),0)));
test('Native110 does not inherit the Worker-only native Unicode exception',()=>assert.throws(()=>verifyNativeStudioTap(tap().replaceAll('case-0',nativeUndoName),0)));
for(const source of ["test(name,()=>{});","test(`unknown`,()=>{});","test('escaped\\nname',()=>{});","test('supported',()=>{});\ntest(dynamic,()=>{});"])
 test('native source extraction fails closed for unsupported form '+JSON.stringify(source),()=>assert.throws(()=>sourceWorkerNames(source)));

const failureTap=()=>"TAP version 13\n# Subtest: PRIVATE_SENTINEL\nnot ok 3 - PRIVATE_SENTINEL\n  ---\n  location: 'file:///PRIVATE_SENTINEL/person-merge.test.mjs:517:9'\n  failureType: 'testCodeFailure'\n  error: 'PRIVATE_SENTINEL'\n  code: 'ERR_TEST_FAILURE'\n  stack: |\n    PRIVATE_SENTINEL\n  ...\n1..51\n# tests 51\n# suites 0\n# pass 50\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n";
const observedResult=(patch={})=>({status:1,error:null,signal:null,stdout:Buffer.from(failureTap()),stderr:Buffer.from('PRIVATE_SENTINEL stderr'),...patch});
function observedFailure(result=observedResult(),postCheck='unknown') {
 const assessment=assessMergeWorkerProcess(result),d=createNativeStudioDiagnostics();
 d.enter('worker-tests');d.observeWorker(assessment);if(!assessment.ok)d.capture(assessment.failure);
 if(postCheck!=='unknown') {d.enter('worker-post-check');if(postCheck==='passed')d.workerPostCheck();else {const e=thrownBy(()=>validateNativeStudioSources([]));d.workerPostCheck(e);d.capture(e);}}
 return {assessment,d,error:d.failure()};
}
const cli=error=>observabilityModule.formatNativeStudioCliFailure(error);
test('CLI bounded evidence has only reviewed finite fields and whole-output hashes',()=>{
 const result=observedResult(),{error}=observedFailure(result),out=cli(error),e=out.workerEvidence;
 assert.deepEqual(Object.keys(formatNativeStudioFailure('unknown',error)),['status','phase','code']);
 assert.deepEqual(Object.keys(out),['status','phase','code','workerEvidence']);
 assert.deepEqual(Object.keys(e),['kind','node','exitCode','processError','signal','stdoutSha256','stderrSha256','tap','postCheck']);
 assert.deepEqual(Object.keys(e.tap),['plan','tests','suites','pass','fail','cancelled','skipped','todo','firstFailingOrdinal','errorCode','failureType','location']);
 assert.equal(e.kind,'native-worker-failure-evidence');assert.equal(e.node,process.version);assert.equal(e.exitCode,1);assert.equal(e.processError,false);assert.equal(e.signal,false);assert.equal(e.postCheck,'unknown');
 const sha=b=>createHash('sha256').update(b).digest('hex');assert.equal(e.stdoutSha256,sha(result.stdout));assert.equal(e.stderrSha256,sha(result.stderr));
 assert.deepEqual(e.tap,{plan:51,tests:51,suites:0,pass:50,fail:1,cancelled:0,skipped:0,todo:0,firstFailingOrdinal:3,errorCode:'ERR_TEST_FAILURE',failureType:'testCodeFailure',location:{file:'person-merge.test.mjs',line:517,column:9}});
 assert.equal(JSON.stringify(out).includes('PRIVATE_SENTINEL'),false);for(const x of [out,e,e.tap,e.tap.location])assert.equal(Object.isFrozen(x),true);
});
for(const post of ['unknown','passed','failed'])test('Worker first diagnostic survives '+post+' post-check and repeated outer wrapping',()=>{
 const {d,error}=observedFailure(observedResult(),post);const first=failed('worker-tests','TAP_INVALID');
 assert.deepEqual(d.summary(),first);assert.deepEqual(formatNativeStudioFailure('unknown',error),first);assert.equal(cli(error).workerEvidence.postCheck,post);
 d.capture(error);const outer=d.failure();assert.notEqual(outer,error);assert.deepEqual(cli(outer),cli(error));
});
test('successful Worker assessment still provides evidence on a genuine later post-check failure',()=>{
 const {assessment,error}=observedFailure(observedResult({status:0,stdout:Buffer.from(workerTap())}),'failed');
 assert.equal(assessment.ok,true);assert.deepEqual(formatNativeStudioFailure('unknown',error),failed('worker-post-check','SOURCE_SET'));assert.equal(cli(error).workerEvidence.tap.pass,51);assert.equal(cli(error).workerEvidence.postCheck,'failed');
 assert.equal(Object.hasOwn(cli(error).workerEvidence,'native'),false,'no unverified caller Native110 claim is emitted');
});
test('completed post-check cannot be retroactively changed and stale wrapper snapshots stay immutable',()=>{
 const {d,error}=observedFailure();d.enter('worker-post-check');d.workerPostCheck(new Error('PRIVATE_SENTINEL'));d.workerPostCheck();
 assert.equal(cli(error).workerEvidence.postCheck,'unknown');assert.equal(cli(d.failure()).workerEvidence.postCheck,'failed');
});
test('observations cannot attach before Worker phase or after an unrelated first failure',()=>{
 const a=assessMergeWorkerProcess(observedResult()),d=createNativeStudioDiagnostics();d.observeWorker(a);d.enter('context');d.capture(thrownBy(()=>validateNativeStudioSources([])));d.enter('worker-tests');d.observeWorker(a);assert.equal(Object.hasOwn(cli(d.failure()),'workerEvidence'),false);
 const next=createNativeStudioDiagnostics();next.enter('worker-tests');next.observeWorker(a);next.capture(a.failure);assert.equal(cli(next.failure()).workerEvidence.exitCode,1);
});
test('forged assessments, copied summaries and cross-run assessment reuse cannot acquire observations',()=>{
 const {assessment,d,error}=observedFailure();
 for(const value of [{...assessment},{ok:false,failure:assessment.failure},d.summary(),cli(error),null,undefined,Symbol('PRIVATE_SENTINEL')]){
  const other=createNativeStudioDiagnostics();other.enter('worker-tests');other.observeWorker(value);other.capture(assessment.failure);assert.equal(Object.hasOwn(cli(other.failure()),'workerEvidence'),false);
 }
 const other=createNativeStudioDiagnostics();other.enter('worker-tests');other.observeWorker(assessment);other.capture(assessment.failure);assert.equal(Object.hasOwn(cli(other.failure()),'workerEvidence'),false);
 assert.equal(Object.hasOwn(cli(assessment.failure),'workerEvidence'),false);
});
test('distinct runs and cross-error wrappers never borrow any last observation',()=>{
 const one=observedFailure(observedResult({status:7})),two=observedFailure(observedResult({status:9}));assert.equal(cli(one.error).workerEvidence.exitCode,7);assert.equal(cli(two.error).workerEvidence.exitCode,9);
 const bare=createNativeStudioDiagnostics();bare.enter('worker-tests');bare.capture(one.error);assert.equal(Object.hasOwn(cli(bare.failure()),'workerEvidence'),false);assert.equal(Object.hasOwn(cli(new Error('NATIVE_STUDIO_CI_FAILED')),'workerEvidence'),false);
 one.d.observeWorker(two.assessment);assert.equal(cli(one.d.failure()).workerEvidence.exitCode,7);
});
test('foreign error properties and even branded error properties are never inspected by the entire bridge',()=>{
 let touches=0;const bad=()=>{touches++;throw Error('PRIVATE_SENTINEL');};const hostile=new Proxy({}, {get:bad,getPrototypeOf:bad,ownKeys:bad,getOwnPropertyDescriptor:bad,has:bad});
 const revoked=Proxy.revocable({},{});revoked.revoke();
 for(const foreign of [hostile,revoked.proxy,{get message(){return bad();},get code(){return bad();},get stack(){return bad();},toJSON:bad},'PRIVATE_SENTINEL',null,undefined]) {
  const {assessment,d,error}=observedFailure(observedResult({error:foreign,signal:foreign}),'failed');
  for(const e of [assessment.failure,error])if(e)for(const key of ['message','code','stack','toJSON'])Object.defineProperty(e,key,{get:bad,configurable:true});
  assert.equal(JSON.stringify(cli(d.failure())).includes('PRIVATE_SENTINEL'),false);assert.equal(JSON.stringify(cli(error)).includes('PRIVATE_SENTINEL'),false);
  assert.equal(Object.hasOwn(cli(foreign),'workerEvidence'),false);
 }
 assert.equal(touches,0);
});
test('result getters proxies and revoked proxies cannot execute or fabricate evidence',()=>{
 let touches=0;const bad=()=>{touches++;throw Error('PRIVATE_SENTINEL');};
 const proxy=new Proxy({}, {get:bad,getPrototypeOf:bad,ownKeys:bad,getOwnPropertyDescriptor:bad});const revoked=Proxy.revocable({},{});revoked.revoke();
 for(const result of [proxy,revoked.proxy,{get stdout(){return bad();}},...['status','error','signal','stderr'].map(key=>Object.defineProperty(observedResult(),key,{get:bad}))]){const {assessment,error}=observedFailure(result);assert.equal(assessment.ok,false);assert.equal(Object.hasOwn(cli(error),'workerEvidence'),false);}
 assert.equal(touches,0);
});
test('Buffer own length iterator toJSON and coercion hooks cannot leak through observation or assessment',()=>{
 let touches=0;const bad=()=>{touches++;throw Error('PRIVATE_SENTINEL');};const bytes=Buffer.from(failureTap());
 for(const key of ['length','toJSON','toString','valueOf',Symbol.iterator,Symbol.toPrimitive])Object.defineProperty(bytes,key,{get:bad});
 const {error}=observedFailure(observedResult({stdout:bytes}));assert.equal(cli(error).workerEvidence.tap.fail,1);assert.equal(touches,0);
});
for(const [label,status] of [['missing',undefined],['null',null],['string','PRIVATE_SENTINEL'],['fraction',1.5],['NaN',NaN],['infinite',Infinity],['huge',2147483648],['negative huge',-2147483649],['hostile',new Proxy({}, {get(){throw Error('PRIVATE_SENTINEL');}})]])
 test('unknown exit status stays null for '+label,()=>{const {error}=observedFailure(observedResult({status}));assert.equal(cli(error).workerEvidence.exitCode,null);assert.equal(JSON.stringify(cli(error)).includes('PRIVATE_SENTINEL'),false);});
for(const [label,bytes] of [
 ['invalid UTF8',Buffer.from([0xc0,0xaf])],['BOM',Buffer.concat([Buffer.from([239,187,191]),Buffer.from(failureTap())])],['internal BOM',Buffer.from(failureTap()+'\uFEFF')],['bare CR',Buffer.from(failureTap()+'x\ry')],['overlong',Buffer.alloc(8*1024*1024+1)],['absent',undefined]
])test('invalid observation text stays entirely unknown for '+label,()=>{const {error}=observedFailure(observedResult({stdout:bytes}));const t=cli(error).workerEvidence.tap;assert.equal(Object.values(t).every(v=>v===null),true);assert.equal(JSON.stringify(cli(error)).includes('PRIVATE_SENTINEL'),false);});
test('observed CRLF counters are accepted without modifying provenance digest',()=>{const stdout=Buffer.from(failureTap().replaceAll('\n','\r\n')),{error}=observedFailure(observedResult({stdout}));assert.equal(cli(error).workerEvidence.tap.fail,1);assert.equal(cli(error).workerEvidence.stdoutSha256,createHash('sha256').update(stdout).digest('hex'));});
for(const key of ['tests','suites','pass','fail','cancelled','skipped','todo'])for(const [label,change] of [
 ['duplicate',s=>s+'# KEY 0\n'],['malformed',s=>s.replace(/^# KEY [0-9]+$/m,'# KEY PRIVATE_SENTINEL')],['unbounded',s=>s.replace(/^# KEY [0-9]+$/m,'# KEY 1000000')],['leading zero',s=>s.replace(/^# KEY [0-9]+$/m,'# KEY 01')]
])test('observed '+key+' is null for '+label,()=>{const changed=change(failureTap().replaceAll('# '+key+' ','# KEY ')).replaceAll('# KEY ','# '+key+' ');assert.equal(cli(observedFailure(observedResult({stdout:Buffer.from(changed)})).error).workerEvidence.tap[key],null);});
for(const [label,change] of [
 ['duplicate plan',s=>s+'1..51\n'],['bad plan',s=>s.replace('1..51','1..051')],['huge plan',s=>s.replace('1..51','1..1000000')],['nested plan',s=>s.replace('1..51','  1..51')]
])test('observed plan is null for '+label,()=>assert.equal(cli(observedFailure(observedResult({stdout:Buffer.from(change(failureTap()))})).error).workerEvidence.tap.plan,null));
for(const [label,change] of [
 ['duplicate fail result',s=>s+'not ok 3 - PRIVATE_SENTINEL\n'],['bad ordinal',s=>s.replace('not ok 3 -','not ok 03 -')],['huge ordinal',s=>s.replace('not ok 3 -','not ok 1000000 -')],['nested result',s=>s.replace('not ok 3 -','    not ok 3 -')],['malformed result',s=>s.replace('not ok 3 -','not ok PRIVATE_SENTINEL -')]
])test('malformed failed record yields no ordinal location or enum for '+label,()=>{const t=cli(observedFailure(observedResult({stdout:Buffer.from(change(failureTap()))})).error).workerEvidence.tap;for(const key of ['firstFailingOrdinal','location','errorCode','failureType'])assert.equal(t[key],null);});
for(const [label,field,change] of [
 ['unknown error','errorCode',s=>s.replace('ERR_TEST_FAILURE','PRIVATE_SENTINEL')],['duplicate error','errorCode',s=>s.replace("  code: 'ERR_TEST_FAILURE'","  code: 'ERR_TEST_FAILURE'\n  code: 'PRIVATE_SENTINEL'")],['unknown type','failureType',s=>s.replace('testCodeFailure','PRIVATE_SENTINEL')],['duplicate type','failureType',s=>s.replace("  failureType: 'testCodeFailure'","  failureType: 'testCodeFailure'\n  failureType: 'PRIVATE_SENTINEL'")],['unknown file','location',s=>s.replace('person-merge.test.mjs','PRIVATE_SENTINEL.mjs')],['bad line','location',s=>s.replace(':517:9',':0:9')],['huge column','location',s=>s.replace(':517:9',':517:1000000')],['duplicate location','location',s=>s.replace('  ---','  ---\n  location: PRIVATE_SENTINEL')]
])test('only closed known diagnostic values survive '+label,()=>{const out=cli(observedFailure(observedResult({stdout:Buffer.from(change(failureTap()))})).error);assert.equal(out.workerEvidence.tap[field],null);assert.equal(JSON.stringify(out).includes('PRIVATE_SENTINEL'),false);});
test('both and only known fixture basenames can survive private source paths',()=>{const stdout=Buffer.from(failureTap().replace('person-merge.test.mjs','person-edits-worker-lifecycle.test.mjs'));const t=cli(observedFailure(observedResult({stdout})).error).workerEvidence.tap;assert.deepEqual(t.location,{file:'person-edits-worker-lifecycle.test.mjs',line:517,column:9});});

test('failed observation cannot be attached to a different first error identity',()=>{
 const a=assessMergeWorkerProcess(observedResult()),d=createNativeStudioDiagnostics();d.enter('worker-tests');d.observeWorker(a);d.capture(new Error('PRIVATE_SENTINEL'));assert.equal(Object.hasOwn(cli(d.failure()),'workerEvidence'),false);
});
test('caller mutation after assessment cannot change captured hashes scalars counters or node',()=>{
 const result=observedResult(),a=assessMergeWorkerProcess(result),d=createNativeStudioDiagnostics();result.status=0;result.stdout.fill(65);result.stderr.fill(65);d.enter('worker-tests');d.observeWorker(a);d.capture(a.failure);
 const out=cli(d.failure());assert.equal(out.workerEvidence.exitCode,1);assert.equal(out.workerEvidence.tap.fail,1);assert.equal(out.workerEvidence.node,process.version);assert.equal(out.workerEvidence.stdoutSha256,createHash('sha256').update(Buffer.from(failureTap())).digest('hex'));
});
for(const [label,type,code,location,counters] of [
 ['file-level timeout','testCodeFailure','ERR_TEST_FAILURE',null,{pass:0,fail:1,cancelled:0}],
 ['test timeout','testTimeoutFailure','ERR_TEST_FAILURE',"  location: 'PRIVATE_SENTINEL/person-merge.test.mjs:517:9'\n",{pass:0,fail:1,cancelled:0}],
 ['parent cancellation','cancelledByParent','ERR_TEST_FAILURE',"  location: 'PRIVATE_SENTINEL/person-edits-worker-lifecycle.test.mjs:211:1'\n",{pass:0,fail:0,cancelled:1}],
 ['test error enum','testCodeFailure','ERR_TEST_TIMEOUT',null,{pass:0,fail:1,cancelled:0}],
 ['cancel error enum','cancelledByParent','ERR_TEST_CANCELLED',null,{pass:0,fail:0,cancelled:1}]
])test('safe Worker bridge observes '+label+' without asserting success or leaking the name',()=>{
 const stdout=Buffer.from("TAP version 13\n# Subtest: PRIVATE_SENTINEL/path/person-merge.test.mjs\nnot ok 1 - PRIVATE_SENTINEL/path/person-merge.test.mjs\n  ---\n"+(location??'')+"  failureType: '"+type+"'\n  code: '"+code+"'\n  error: 'PRIVATE_SENTINEL'\n  ...\n1..1\n# tests 1\n# suites 0\n# pass "+counters.pass+"\n# fail "+counters.fail+"\n# cancelled "+counters.cancelled+"\n# skipped 0\n# todo 0\n");
 const {d,error}=observedFailure(observedResult({stdout,status:1}),'failed');d.capture(error);const out=cli(d.failure());
 assert.equal(out.code,'TAP_INVALID');assert.equal(out.workerEvidence.postCheck,'failed');assert.equal(out.workerEvidence.tap.firstFailingOrdinal,1);assert.equal(out.workerEvidence.tap.failureType,type);assert.equal(out.workerEvidence.tap.errorCode,code);for(const k of Object.keys(counters))assert.equal(out.workerEvidence.tap[k],counters[k]);assert.equal(out.workerEvidence.tap.location===null,location===null);assert.equal(JSON.stringify(out).includes('PRIVATE_SENTINEL'),false);
});

test('Worker file deadline matches the native package command without raising outer budgets',()=>{
 const worker=readFileSync(new URL('./native-studio-ci.mjs',import.meta.url),'utf8');
 const native=JSON.parse(readFileSync(new URL('../packages/openfilm/package.json',import.meta.url),'utf8'));
 const workflow=readFileSync(new URL('../.github/workflows/native-studio.yml',import.meta.url),'utf8');
 assert.match(native.scripts.test,/--test-timeout=600000/);
 assert.match(worker,/child\(process\.execPath,\['--test','--test-reporter=tap','--test-concurrency=1','--test-timeout=600000',\.\.\.WORKER_TESTS\],context\.workspace,worker\.env,180_000\)/);
 assert.match(worker,/maxBuffer:8\*1024\*1024/);
 assert.match(workflow,/timeout-minutes:\s*12\b/);
});
