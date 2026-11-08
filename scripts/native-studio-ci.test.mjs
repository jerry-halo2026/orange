import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { validateNativeStudioContext, verifyNativeStudioTap, validateNativeStudioSources, validatePlaywrightArchiveEntries, parsePlaywrightArchive, validatePlaywrightMetadata } from './native-studio-ci.mjs';
const context = () => ({GITHUB_ACTIONS:'true',RUNNER_OS:'Windows',GITHUB_REPOSITORY:'jerry-halo2026/orange',ORANGE_REPOSITORY_VISIBILITY:'public',GITHUB_REF:'refs/heads/codex/t05-path-policy',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKSPACE:'D:\\a\\orange\\orange',GITHUB_EVENT_NAME:'push'});
const mandatory='real Windows file-symbolic marker refuses before native callback';
function tap() {return 'TAP version 13\n'+Array.from({length:66},(_,i)=>`# Subtest: ${i===65?mandatory:'case-'+i}\nok ${i+1} - ${i===65?mandatory:'case-'+i}\n  ---\n  duration_ms: 1\n  type: test\n  ...\n`).join('')+'1..66\n# tests 66\n# suites 0\n# pass 66\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 66\n';}
test('derives only the fresh native Studio CI namespace from the exact public topic',()=>{const got=validateNativeStudioContext(context());assert.equal(got.ownedRoot,'D:\\a\\orange\\orange\\.dev\\native-studio-ci\\123\\1');assert.equal(got.commit,'a'.repeat(40));assert.equal(validateNativeStudioContext({...context(),GITHUB_EVENT_NAME:'workflow_dispatch'}).workspace,'D:\\a\\orange\\orange');});
for(const [key,value] of Object.entries({GITHUB_ACTIONS:'false',RUNNER_OS:'Linux',GITHUB_REPOSITORY:'fork/orange',ORANGE_REPOSITORY_VISIBILITY:'private',GITHUB_REF:'refs/pull/1/merge',GITHUB_SHA:'a'.repeat(39),GITHUB_RUN_ID:'../1',GITHUB_RUN_ATTEMPT:'0',GITHUB_WORKSPACE:'\\\\server\\share',GITHUB_EVENT_NAME:'pull_request'})) test('rejects untrusted context '+key,()=>assert.throws(()=>validateNativeStudioContext({...context(),[key]:value})));
for(const workspace of ['C:\\a\\..\\orange','C:\\a\\CONIN$\\orange','C:\\a\\CONOUT$.txt\\orange','C:\\a\\bad.\\orange','C:\\a\\bad:stream\\orange','C:\\a\\UPPER~1\\orange','C:\\a\\orange\\','C:/a/orange']) test('rejects workspace alias '+JSON.stringify(workspace),()=>assert.throws(()=>validateNativeStudioContext({...context(),GITHUB_WORKSPACE:workspace})));
test('accepts exactly 66 distinct passed cases including the real file marker',()=>{const x=verifyNativeStudioTap(tap(),0);assert.equal(x.passed,66);assert.equal(x.testNames.length,66);assert.equal(x.skipped,0);});
for(const [name,change,exit] of [
 ['exit',s=>s,1],['65',s=>s.replace('1..66','1..65'),0],['67',s=>s.replace('1..66','1..67'),0],['duplicate',s=>s.replace('ok 2 - case-1','ok 2 - case-0'),0],['missing mandatory',s=>s.replaceAll(mandatory,'other'),0],['skip',s=>s.replace('ok 1 - case-0','ok 1 - case-0 # SKIP'),0],['todo',s=>s.replace('ok 1 - case-0','ok 1 - case-0 # TODO'),0],['cancelled',s=>s.replace('# cancelled 0','# cancelled 1'),0],['failed',s=>s.replace('ok 1 -','not ok 1 -'),0],['nested',s=>s.replace('ok 1 -','    ok 1 -'),0],['bail',s=>s+'Bail out!\n',0],['duplicate summary',s=>s+'# pass 66\n',0],['false pass',s=>s.replace('# pass 66','# pass 65'),0],['extra malformed result',s=>s+'ok unnumbered - injected\n',0],['incomplete',s=>s.replace('# skipped 0\n',''),0],['suite',s=>s.replace('# suites 0','# suites 1'),0]
]) test('TAP refuses '+name,()=>assert.throws(()=>verifyNativeStudioTap(change(tap()),exit)));
test('source policy rejects absent, duplicate, invented and caller-provided pin sets',()=>{for(const records of [[],[{path:'invented',raw:Buffer.from('x'),blob:Buffer.from('x'),mode:'100644',ordinary:true,nlink:1}],Array(19).fill({path:'scripts/native-studio-ci.mjs',raw:Buffer.from('x'),blob:Buffer.from('x'),mode:'100644',ordinary:true,nlink:1})]) assert.throws(()=>validateNativeStudioSources(records));assert.throws(()=>validateNativeStudioSources([], {pins:[]}));});
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
 ['packages/openfilm/studio/server/projects.mjs','b6167184e681fd959212eb8f927e8557feb5ef7b3730961c8bd8939d7ba3700d'],
 ['packages/openfilm/studio/server/auto-versions.mjs','3c064ac4a66d9495a0cfc8da333d1432839d4a19bb49e2477218251b29dd4cad'],
 ['packages/openfilm/studio/server/server.mjs','f05013ddaeb0c7ff08f49999e99f179ec4de126b39544bddd8298417d9e26d8e'],
 ['packages/openfilm/studio/server/project-control-guard.test.mjs','cb77f17415bba41f4fc8b990ed37d9dd722511b8d20468c965fe7eeb1b6a6f62'],
 ['packages/openfilm/studio/server/projects-control.test.mjs','f1dcbbc8d7ebb467ee4810d1035eeb002b140caf2cf41dd102f52bd730a5a388'],
 ['packages/openfilm/studio/server/auto-versions.test.mjs','c9f73d5bed69f1bbc2831be50d8910b650e26f4effe4df0c22a07af79c2d76fa'],
 ['packages/openfilm/studio/server/server-auto-versions.test.mjs','93f69303a3cc37f6a0ca75a25aebdb6e279b973b645c32bdaef878ffda9c07dc'],
];
function sourceRecords() {
 const digest=b=>createHash('sha256').update(b).digest('hex');
 const records=sourceFixturePins.map(([path,pin])=>{const raw=readFileSync(new URL('../'+path,import.meta.url));const lf=Buffer.from(raw.toString('utf8').replaceAll('\r\n','\n'));const blob=digest(raw)===pin?raw:lf;assert.equal(digest(blob),pin,'fixture must itself be the reviewed producer');return {path,raw:Buffer.from(raw),blob:Buffer.from(blob),mode:'100644',ordinary:true,nlink:1};});
 for(const path of ['.github/workflows/native-studio.yml','scripts/native-studio-ci.mjs','scripts/native-studio-ci.test.mjs','packages/openfilm/studio/server/project-file-symlink.test.mjs'])records.push({path,raw:Buffer.from('current candidate\r\n'),blob:Buffer.from('current candidate\n'),mode:'100644',ordinary:true,nlink:1});
 return records;
}
test('sources accept the actual 15 frozen input byte fixtures and four same-candidate producers',()=>{const result=validateNativeStudioSources(sourceRecords());assert.equal(result.length,19);assert.equal(result.find(x=>x.path==='packages/openfilm/studio/server/project-control-guard.mjs').gitBlobSha256,'ae64f900ee1895d3a6d39b92bed3e279ef20e98c0576f8bcef4862063444525c');});
for(const [name,change] of [
 ['modified raw',r=>{r[0].raw=Buffer.from('changed\n');}],['modified source and Git blob',r=>{r[0].raw=r[0].blob=Buffer.from('changed\n');}],['UTF8 BOM',r=>{r[0].raw=Buffer.concat([Buffer.from([239,187,191]),r[0].raw]);}],['invalid UTF8',r=>{r[0].raw=Buffer.from([0xc0,0xaf]);}],['bare CR',r=>{r[0].raw=Buffer.from('x\ry');}],['internal BOM',r=>{r[15].raw=r[15].blob=Buffer.from('x\uFEFFy');}],['symbolic Git mode',r=>{r[0].mode='120000';}],['nonordinary ancestor',r=>{r[0].ordinary=false;}],['hardlink',r=>{r[0].nlink=2;}],['missing',r=>r.pop()],['duplicate',r=>{r[1]=r[0];}],['untracked self',r=>{r[15].mode=undefined;}],['self raw differs from candidate',r=>{r[15].raw=Buffer.from('other\n');}]
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
test('process assessment retains fixed 66 successful TAP evidence',()=>{const assessment=assessNativeStudioProcess({status:0,stdout:Buffer.from(tap()),error:undefined,signal:null});assert.equal(assessment.ok,true);assert.equal(assessment.counts.total,66);assert.equal(assessment.counts.passed,66);assert.equal(assessment.counts.skipped,0);assert.equal(Object.hasOwn(assessment,'failure'),false);});
test('deferred process failure stays first if post-check later fails',()=>{const a=assessNativeStudioProcess({status:1,stdout:Buffer.from(tap()),error:undefined,signal:null});const d=createNativeStudioDiagnostics();d.enter('tests');d.capture(a.failure);d.enter('post-check');d.capture(thrownBy(()=>validateNativeStudioSources([])));assert.deepEqual(d.summary(),failed('tests','TAP_INVALID'));});

import { validateSystemGitMetadata } from './native-studio-ci.mjs';
const systemGit=()=>({systemRoot:'C:\\Windows',executable:'C:\\Program Files\\Git\\cmd\\git.exe',realPath:'C:\\Program Files\\Git\\cmd\\git.exe',ancestorsOrdinary:true,isFile:true,isSymbolicLink:false,nlink:2,sha256:'a'.repeat(64)});
test('fixed preinstalled Git permits legitimate regular multiple-link metadata',()=>{const x=validateSystemGitMetadata(systemGit());assert.equal(x.executable,'C:\\Program Files\\Git\\cmd\\git.exe');assert.equal(x.sha256,'a'.repeat(64));});
test('fixed preinstalled Git also permits an ordinary single-link executable',()=>assert.equal(validateSystemGitMetadata({...systemGit(),nlink:1}).executable,'C:\\Program Files\\Git\\cmd\\git.exe'));
for(const [name,patch]of [
 ['PATH-selected alternative',{executable:'C:\\tools\\git.exe'}],['workspace alternative',{executable:'D:\\a\\orange\\git.exe'}],['other drive',{executable:'D:\\Program Files\\Git\\cmd\\git.exe'}],['wrong leaf case',{executable:'C:\\Program Files\\Git\\cmd\\GIT.exe'}],['wrong ancestor case',{executable:'C:\\program files\\Git\\cmd\\git.exe'}],['relative path',{executable:'git.exe'}],['reparse leaf',{isSymbolicLink:true}],['reparse ancestor',{ancestorsOrdinary:false}],['directory',{isFile:false}],['different realpath',{realPath:'C:\\other\\git.exe'}],['realpath case alias',{realPath:'C:\\Program Files\\git\\cmd\\git.exe'}],['invalid digest',{sha256:'bad'}],['uppercase digest',{sha256:'A'.repeat(64)}],['zero links',{nlink:0}],['negative links',{nlink:-1}],['fractional links',{nlink:1.5}],['nonfinite links',{nlink:Infinity}],['unsafe link count',{nlink:Number.MAX_SAFE_INTEGER+1}],['relative SystemRoot',{systemRoot:'Windows'}],['UNC SystemRoot',{systemRoot:'\\\\server\\Windows'}]
])test('fixed Git metadata rejects '+name,()=>assert.throws(()=>validateSystemGitMetadata({...systemGit(),...patch})));
test('Git metadata acceptance does not relax workspace source hardlink policy',()=>{const r=sourceRecords();r[0].nlink=2;assert.throws(()=>validateNativeStudioSources(r));});
