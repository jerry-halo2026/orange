import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
let api = {};
try { api = await import('./phase1-admission.mjs'); } catch(e) { if(e.code!=='ERR_MODULE_NOT_FOUND') throw e; }
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hash=x=>createHash('sha256').update(x).digest('hex');
const head=spawnSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
let baseline,scratch;
function fn(name){assert.equal(typeof api[name],'function',`missing ${name} admission behavior`);return api[name];}
before(()=>{mkdirSync(path.join(root,'.dev/admission-fixtures'),{recursive:true});scratch=mkdtempSync(path.join(root,'.dev/admission-fixtures/cases-'));if(api.collectGitState) baseline=api.collectGitState(root,head,[]);});
function card(){return {taskId:'T01',assignmentRevision:4,authorAgent:'author-a',worktreePath:root,branch:'codex/t01-isolation',workingBaselineCommit:head,candidateHead:head,dependencyCommits:[],writeAllowlist:['scripts/phase1-admission.mjs','scripts/phase1-admission.test.mjs','.github/workflows/phase1.yml'],resourceLeases:[{kind:'cpu',exclusive:false}],admission:{tests:[],dependencies:[],activeCards:[],sharedWriteGrants:['scripts/phase1-admission.mjs','scripts/phase1-admission.test.mjs','.github/workflows/phase1.yml']}};}
// Controlled decision facts, not a claim about the actual managed worktree.
// Real collector snapshots (including coordinator dirty paths) are tested separately.
function state(){return {root,head,branch:'codex/t01-isolation',linked:true,baselineAncestor:true,baselineApprovalAncestor:true,approvalAncestor:true,dependencyAncestors:{},changedPaths:[],contentHashes:{}};}
const registry={executionAuthorized:true,tasks:[{id:'T01',status:'in_progress',dependsOn:[],externalGates:[]},{id:'T05.a',status:'ready',dependsOn:['T01'],externalGates:[]},{id:'K07',status:'pending',externalGates:[]}]};
function decide(c=card(),s=state(),active=[],deps=[]){return fn('evaluateAdmission')({card:c,registry,state:s,activeCards:active,dependencies:deps});}
function reject(change,reason){const c=card(),s=state(),a=[];change(c,s,a);assert.throws(()=>decide(c,s,a),reason);}
test('collects actual linked worktree branch head ancestry and changes',()=>{fn('collectGitState');assert.equal(baseline.head,head);assert.equal(typeof baseline.branch,'string');assert.equal(typeof baseline.linked,'boolean');assert.equal(baseline.baselineAncestor,true);assert.ok(Array.isArray(baseline.changedPaths));});
test('admits independent ready CPU without waiting for unrelated K or M1',()=>assert.deepEqual(decide(),{admitted:true,taskId:'T01',assignmentRevision:4}));
for(const [name,change,reason] of [
 ['branch mismatch',(c,s)=>s.branch='dev',/BRANCH/],['head mismatch',(c,s)=>s.head='a'.repeat(40),/HEAD/],['not linked',(c,s)=>s.linked=false,/WORKTREE/],['baseline ancestry',(c,s)=>s.baselineAncestor=false,/BASELINE/],
 ['dependency ancestry',(c,s)=>{c.dependencyCommits=['b'.repeat(40)];s.dependencyAncestors={['b'.repeat(40)]:false};},/DEPENDENCY/],
 ['untracked outside allowlist',(c,s)=>s.changedPaths.push('unexpected.txt'),/WRITE/],['staged root write',(c,s)=>s.changedPaths.push('package.json'),/WRITE/],['unstaged lock write',(c,s)=>s.changedPaths.push('pnpm-lock.yaml'),/WRITE/],['rename source outside allowlist',(c,s)=>s.changedPaths.push('old/shared.ts','scripts/phase1-admission.mjs'),/WRITE/],
 ['case alias',(c,s)=>s.changedPaths.push('Scripts/phase1-admission.mjs'),/PATH|WRITE/],['traversal',(c,s)=>s.changedPaths.push('scripts/../package.json'),/PATH/],['shared root without grant',(c,s)=>{c.admission.sharedWriteGrants=[];s.changedPaths=['.github/workflows/phase1.yml'];},/SHARED/],['policy modification',(c,s)=>s.registryChanged=true,/POLICY/],
])test(`rejects ${name}`,()=>reject(change,reason));
for(const r of [{kind:'directory',value:path.join(root,'.dev/one'),exclusive:true},{kind:'port',value:18471,exclusive:true},{kind:'database',value:'phase1-a',exclusive:true},{kind:'desktop',value:'windows-session',exclusive:true},{kind:'gpu',value:'gpu-0',exclusive:true}])test(`rejects overlapping ${r.kind} lease`,()=>reject((c,s,a)=>{c.resourceLeases=[r];a.push({...card(),taskId:'T05.a',worktreePath:root+'-other',writeAllowlist:['workers/a.cs'],resourceLeases:[r]});},/RESOURCE/));
test('rejects nested directory lease',()=>reject((c,s,a)=>{c.resourceLeases=[{kind:'directory',value:'.dev/one',exclusive:true}];a.push({...card(),taskId:'T05.a',worktreePath:root+'-other',writeAllowlist:['workers/a.cs'],resourceLeases:[{kind:'directory',value:path.join(root,'.dev/one/nested'),exclusive:true}]});},/RESOURCE/));
test('rejects active writer overlap across worktrees',()=>reject((c,s,a)=>a.push({...card(),taskId:'T05.a',worktreePath:root+'-other'}),/OVERLAP/));
test('rejects another writer in same worktree',()=>reject((c,s,a)=>a.push({...card(),taskId:'T05.a',writeAllowlist:['workers/a.cs']}),/WORKTREE/));
test('rejects stale active card revision',()=>reject((c,s,a)=>a.push({...card(),assignmentRevision:0}),/CARD/));
test('requires exact non-author reviewed dependency subset but not entire producer completion',()=>{
 const c=card();c.taskId='T05.a';c.admission.dependencies=[{taskId:'T01',commit:head,authorAgent:'producer',source:[{path:'source.mjs',sha256:'a'.repeat(64)}],fixtures:[{path:'fixture.json',sha256:'b'.repeat(64)}],review:{path:'review.json',sha256:'c'.repeat(64)}}];
 const d={...structuredClone(c.admission.dependencies[0]),reviewEvidence:{reviewerAgent:'reviewer',authorAgent:'producer',commit:head,spec:'approved',quality:'approved',source:c.admission.dependencies[0].source,fixtures:c.admission.dependencies[0].fixtures}};
 assert.equal(decide(c,state(),[],[d]).admitted,true);
 for(const mutate of [x=>x.reviewEvidence.reviewerAgent='producer',x=>x.source[0].sha256='d'.repeat(64),x=>x.reviewEvidence.spec='pending',x=>x.reviewEvidence.fixtures=[]]){const altered=structuredClone(d);mutate(altered);assert.throws(()=>decide(c,state(),[],[altered]),/DEPENDENCY|REVIEW/);}
});
function fixture(body){const file=path.join(scratch,`${Math.random().toString(16).slice(2)}.test.mjs`);writeFileSync(file,body);return {path:path.relative(root,file).replaceAll('\\','/'),sha256:hash(readFileSync(file)),requiredNames:['required compatibility']};}
function run(spec){return fn('runApprovedTests')(root,{fixtureNamespace:path.relative(root,scratch).replaceAll('\\','/'),tests:[spec]});}
test('executes trusted node test and observes named assertion',()=>{const result=run(fixture("import {test} from 'node:test';test('required compatibility',()=>{});"));assert.equal(result[0].exitCode,0);assert.deepEqual(result[0].names,['required compatibility']);});
for(const [name,body]of[
 ['compatibility failure',"import {test} from 'node:test';test('required compatibility',()=>{throw Error('incompatible')});"],['skip',"import {test} from 'node:test';test('required compatibility',{skip:true},()=>{});"],['todo',"import {test} from 'node:test';test('required compatibility',{todo:true},()=>{});"],['cancel',"import {test} from 'node:test';test('required compatibility',{timeout:5},()=>new Promise(()=>{}));"],['missing required name',"import {test} from 'node:test';test('other',()=>{});"],['zero tests','']
])test(`rejects actual ${name}`,()=>assert.throws(()=>run(fixture(body)),/TEST|TAP/));
test('ignores author provided PASS and exitCode',()=>{const spec=fixture("import {test} from 'node:test';test('required compatibility',()=>{throw Error('bad')});");spec.exitCode=0;spec.status='PASS';assert.throws(()=>run(spec),/TEST/);});
test('rejects altered test bytes shell commands recursive gate tests and undeclared fixture namespace',()=>{const spec=fixture("import {test} from 'node:test';test('required compatibility',()=>{});");assert.throws(()=>run({...spec,sha256:'0'.repeat(64)}),/TEST/);assert.throws(()=>run({...spec,command:'echo PASS'}),/TEST/);assert.throws(()=>run({...spec,path:'scripts/phase1-admission.test.mjs'}),/TEST/);assert.throws(()=>api.runApprovedTests(root,{tests:[spec]}),/TEST/);});
test('rejects incomplete zero skipped failing TAP despite exit zero',()=>{fn('verifyTap');for(const tap of['TAP version 13\n1..0\n','TAP version 13\nok 1 - required compatibility\n','TAP version 13\nok 1 - required compatibility # SKIP\n1..1\n','TAP version 13\nok 1 - required compatibility\n1..2\n','TAP version 13\nnot ok 1 - required compatibility\n1..1\n'])assert.throws(()=>api.verifyTap(tap,0,['required compatibility']),/TAP/);});
const anchors={approvalCommit:'5bf11257eacb3eb333451e0212342d47677cf981',approvalCardSha256:'7cd0c6e4c2ffdfd062acf8fd0012eefc86eb2809c9319dab0d72f5fd078f9d91',expectedRevision:4,candidateHead:head,cardPath:'docs/execution/t01-admission-assignment.json'};
test('loads approval from immutable Git blob rather than worktree CRLF bytes',()=>{const b=fn('loadApproval')(root,anchors);assert.equal(b.card.assignmentRevision,4);assert.equal(b.registry.tasks[0].id,'T01');});
test('rejects absent malformed mismatched anchors or stale approval revision',()=>{fn('loadApproval');for(const k of ['approvalCommit','approvalCardSha256','expectedRevision','candidateHead'])assert.throws(()=>api.loadApproval(root,{...anchors,[k]:undefined}),/ANCHOR/);assert.throws(()=>api.loadApproval(root,{...anchors,approvalCardSha256:'0'.repeat(64)}),/APPROVAL/);assert.throws(()=>api.loadApproval(root,{...anchors,expectedRevision:3}),/REVISION/);});
test('actual CLI fails closed with sanitized missing-anchor output',()=>{fn('loadApproval');const r=spawnSync(process.execPath,[path.join(root,'scripts/phase1-admission.mjs'),'--root',root],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/ADMISSION_DENIED:ANCHOR/);assert.doesNotMatch(r.stderr,/ at |Error:|E:\\/);});
test('real revision4 allocation cannot self-admit without approved executable policy',()=>{fn('loadApproval');const r=spawnSync(process.execPath,[path.join(root,'scripts/phase1-admission.mjs'),'--root',root,'--card',anchors.cardPath,'--approval-commit',anchors.approvalCommit,'--approval-card-sha256',anchors.approvalCardSha256,'--expected-revision','4','--candidate-head',head],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/ADMISSION_DENIED:MISSING_TEST_POLICY/);});

test('rejects unknown task and absent consumed dependency evidence',()=>{const c=card();c.taskId='not-registered';assert.throws(()=>decide(c),/REGISTRY/);const d=card();d.taskId='T05.a';d.admission.dependencies=[{taskId:'T01',commit:head}];assert.throws(()=>decide(d),/DEPENDENCY/);});
test('parses both Git rename and copy endpoints from NUL records',()=>{assert.deepEqual(fn('parseNameStatus')(Buffer.from('R100\0old/a.ts\0new/a.ts\0M\0space name.ts\0C100\0copy/from.ts\0copy/to.ts\0')),['old/a.ts','new/a.ts','space name.ts','copy/from.ts','copy/to.ts']);assert.throws(()=>api.parseNameStatus(Buffer.from('R100\0one\0')),/GIT/);});
test('CPU and relative directories stay independent across roots',()=>{const c=card();c.resourceLeases.push({kind:'directory',value:'.dev/isolated',exclusive:true});const a={...card(),taskId:'T05.a',worktreePath:root+'-other',writeAllowlist:['workers/a.cs'],resourceLeases:[{kind:'cpu',exclusive:false},{kind:'directory',value:'.dev/isolated',exclusive:true}]};assert.equal(decide(c,state(),[a]).admitted,true);});
test('rejects absolute resource traversal and path aliases rather than normalizing collisions',()=>{for(const value of [path.join(root,'.dev')+'/../other',path.join(root,'.dev')+'/bad./out',path.join(root,'.dev')+'/PROGRA~1/out'])reject((c,s,a)=>{c.resourceLeases=[{kind:'directory',value,exclusive:true}];a.push({...card(),taskId:'T05.a',worktreePath:root+'-other',writeAllowlist:['workers/a.cs'],resourceLeases:[{kind:'directory',value:path.join(root,'.dev/good'),exclusive:true}]});},/PATH/);});

// These are ordinary tiny repositories, never git worktrees. Identity is explicitly
// synthetic and command-scoped; no Orange source commit/config is touched.
function tinyRepo() {
 const repo=mkdtempSync(path.join(scratch,'git-'));mkdirSync(path.join(repo,'empty-hooks'));
 const invoke=(...args)=>{const r=spawnSync('git',['-c',`core.hooksPath=${path.join(repo,'empty-hooks')}`,'-c','core.autocrlf=false','-c','user.name=Admission fixture only','-c','user.email=admission-fixture@example.invalid','-C',repo,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 invoke('init','--template=','-b','codex/fixture');
 const put=(name,bytes)=>{mkdirSync(path.dirname(path.join(repo,name)),{recursive:true});writeFileSync(path.join(repo,name),bytes);};
 const save=()=>{invoke('add','--all');invoke('commit','--no-gpg-sign','-m','Synthetic admission test fixture');return invoke('rev-parse','HEAD');};
 return {repo,invoke,put,save};
}
test('real Git collector sees staged rename endpoints unstaged edits and untracked files',()=>{
 fn('collectGitState');const f=tinyRepo();f.put('old name.ts','original\n');f.put('edit.ts','before\n');const initial=f.save();
 f.invoke('mv','old name.ts','new name.ts');f.put('edit.ts','after\n');f.put('untracked.ts','new\n');
 const s=api.collectGitState(f.repo,initial,[]);assert.equal(s.linked,false);assert.deepEqual([...s.changedPaths].sort(),['edit.ts','new name.ts','old name.ts','untracked.ts']);
 const next=f.save();assert.notEqual(next,initial);assert.deepEqual([...api.collectGitState(f.repo,initial,[initial]).changedPaths].sort(),['edit.ts','new name.ts','old name.ts','untracked.ts']);
});
function trustedFixture() {
 const f=tinyRepo();f.put('source.mjs','export const answer = 42;\n');f.put('fixture.bin',Buffer.from([0,255,10,13]));f.put('docs/execution/project-tasks.json',JSON.stringify(registry));const dependencyCommit=f.save();
 const entry=p=>({path:p,sha256:hash(readFileSync(path.join(f.repo,p))),gitBlobSha256:hash(spawnSync('git',['-C',f.repo,'show',`${dependencyCommit}:${p}`]).stdout)});
 const source=[entry('source.mjs')],fixtures=[entry('fixture.bin')];
 f.put('review.json',JSON.stringify({authorAgent:'producer',reviewerAgent:'independent-fixture-reviewer',commit:dependencyCommit,spec:'approved',quality:'approved',source,fixtures}));
 const review={path:'review.json',sha256:hash(readFileSync(path.join(f.repo,'review.json'))),gitBlobSha256:hash(readFileSync(path.join(f.repo,'review.json')))};
 const testPath='.dev/admission-fixtures/trusted/case.test.mjs';f.put(testPath,"import {test} from 'node:test';test('required compatibility',()=>{});\n");
 const c={...card(),worktreePath:f.repo,branch:'codex/fixture',workingBaselineCommit:dependencyCommit,dependencyCommits:[dependencyCommit],admission:{fixtureNamespace:'.dev/admission-fixtures/trusted',tests:[{path:testPath,sha256:hash(readFileSync(path.join(f.repo,testPath))),requiredNames:['required compatibility']}],sharedWriteGrants:[],activeCards:[],dependencies:[{taskId:'T01',authorAgent:'producer',commit:dependencyCommit,source,fixtures,review}]}};
 delete c.candidateHead;f.put('docs/execution/card.json',JSON.stringify(c));const approvedCommit=f.save();
 const anchors={approvalCommit:approvedCommit,approvalCardSha256:hash(spawnSync('git',['-C',f.repo,'show',`${approvedCommit}:docs/execution/card.json`]).stdout),expectedRevision:4,candidateHead:approvedCommit,cardPath:'docs/execution/card.json'};
 return {...f,anchors,bundle:api.loadApproval(f.repo,anchors)};
}
test('trusted approval ignores candidate card widening and actual CLI rejects policy changes',()=>{
 fn('loadApproval');const f=trustedFixture();const altered=structuredClone(f.bundle.card);altered.writeAllowlist.push('package.json');altered.admission.tests=[];f.put(f.anchors.cardPath,JSON.stringify(altered));
 assert.ok(!api.loadApproval(f.repo,f.anchors).card.writeAllowlist.includes('package.json'));
 assert.throws(()=>fn('runAdmission')(f.repo,f.anchors),/POLICY_CHANGED/);
 const r=spawnSync(process.execPath,[path.join(root,'scripts/phase1-admission.mjs'),'--root',f.repo,'--card',f.anchors.cardPath,'--approval-commit',f.anchors.approvalCommit,'--approval-card-sha256',f.anchors.approvalCardSha256,'--expected-revision','4','--candidate-head',f.anchors.candidateHead],{encoding:'utf8'});assert.equal(r.status,1);assert.equal(r.stderr.trim(),'ADMISSION_DENIED:POLICY_CHANGED');
});
test('reads exact dependency source fixture and review bytes at declared commits and worktree',()=>{
 fn('loadEvidence');const f=trustedFixture();assert.equal(api.loadEvidence(f.repo,f.bundle).dependencies[0].reviewEvidence.reviewerAgent,'independent-fixture-reviewer');
 f.put('source.mjs','export const answer = 42;\r\n');assert.throws(()=>api.loadEvidence(f.repo,f.bundle),/DEPENDENCY_HASH/);
 const explicit=structuredClone(f.bundle);explicit.card.admission.dependencies[0].source[0].sha256=hash(readFileSync(path.join(f.repo,'source.mjs')));
 assert.equal(api.loadEvidence(f.repo,explicit).dependencies.length,1); // Explicit different raw and Git-blob hashes, not normalization.
 f.put('source.mjs','export const answer = 42;\n');f.put('fixture.bin',Buffer.from([0,254,10,13]));assert.throws(()=>api.loadEvidence(f.repo,f.bundle),/DEPENDENCY_HASH/);
 f.put('fixture.bin',Buffer.from([0,255,10,13]));f.put('review.json','{}');assert.throws(()=>api.loadEvidence(f.repo,f.bundle),/REVIEW_HASH/);
});
test('trusted active cards need exact immutable blob hash and current assignment revision',()=>{
 fn('loadEvidence');const f=trustedFixture();const c={...card(),worktreePath:f.repo+'-other',taskId:'T05.a',status:'active'};f.put('active.json',JSON.stringify(c));const at=f.save();
 const b=structuredClone(f.bundle);b.anchors.approvalCommit=at;b.card.admission.activeCards=[{path:'active.json',sha256:hash(readFileSync(path.join(f.repo,'active.json'))),assignmentRevision:4}];assert.equal(api.loadEvidence(f.repo,b).activeCards.length,1);
 b.card.admission.activeCards[0].assignmentRevision=3;assert.throws(()=>api.loadEvidence(f.repo,b),/CARD_REVISION/);
 b.card.admission.activeCards[0].assignmentRevision=4;b.card.admission.activeCards[0].sha256='0'.repeat(64);assert.throws(()=>api.loadEvidence(f.repo,b),/CARD_HASH/);
});

test('cannot omit a registry dependency subset just because the producer is unfinished',()=>{const c=card();c.taskId='T05.a';assert.throws(()=>decide(c),/DEPENDENCY/);});
test('actual gate rejects candidate changes to its existing registry policy',()=>{fn('runAdmission');const f=trustedFixture();f.put('docs/execution/project-tasks.json',JSON.stringify({...registry,executionAuthorized:false}));assert.throws(()=>api.runAdmission(f.repo,f.anchors),/POLICY_CHANGED/);});
test('malformed independent anchors fail closed before reading candidate policy',()=>{fn('loadApproval');for(const [key,value]of[['approvalCommit','HEAD'],['approvalCommit','A'.repeat(40)],['approvalCardSha256','bad'],['candidateHead',''],['expectedRevision',0],['expectedRevision',1.2]])assert.throws(()=>api.loadApproval(root,{...anchors,[key]:value}),/ANCHOR/);});

test('rejects dangling junction resource aliases before resolving a nonexistent child',()=>{const link=path.join(scratch,'dangling-junction');symlinkSync(path.join(scratch,'never-created-target'),link,'junction');reject((c,s,a)=>{c.resourceLeases=[{kind:'directory',value:path.join(link,'child'),exclusive:true}];a.push({...card(),taskId:'T05.a',worktreePath:root+'-other',writeAllowlist:['workers/a.cs'],resourceLeases:[{kind:'directory',value:path.join(scratch,'other'),exclusive:true}]});},/PATH/);});
for(const p of ['packages/openfilm/studio/server/server.mjs','docs/discovery/07_统一数据契约草案.md'])test(`shared ${p} needs explicit grant beyond writer allowlist`,()=>reject((c,s)=>{c.writeAllowlist.push(p);s.changedPaths=[p];},/SHARED/));
test('trusted name pattern must still execute required named assertions',()=>{const spec=fixture("import {test} from 'node:test';test('required compatibility',()=>{});");assert.equal(run({...spec,namePattern:'required compatibility'})[0].names[0],'required compatibility');assert.throws(()=>run({...spec,namePattern:'nonexistent'}),/TEST|TAP/);});

test('collector fingerprints current bytes even when the changed path set stays identical',()=>{fn('collectGitState');const f=tinyRepo();f.put('source.mjs','before\n');const at=f.save();f.put('source.mjs','version a\n');const a=api.collectGitState(f.repo,at,[]);f.put('source.mjs','version b\n');const b=api.collectGitState(f.repo,at,[]);assert.deepEqual(a.changedPaths,b.changedPaths);assert.notDeepEqual(a.contentHashes,b.contentHashes);});
test('collector rejects Git flags that conceal worktree modifications',()=>{fn('collectGitState');const f=tinyRepo();f.put('hidden.mjs','before\n');const at=f.save();f.invoke('update-index','--assume-unchanged','hidden.mjs');f.put('hidden.mjs','hidden change\n');assert.throws(()=>api.collectGitState(f.repo,at,[]),/GIT_HIDDEN/);});

test('actor diff starts at immutable coordinator approval not earlier working source baseline',()=>{
 const f=tinyRepo();f.put('source.mjs','source baseline\n');const sourceBaseline=f.save();f.put('docs/execution/card.json','{"coordinator":"approved"}\n');f.put('docs/execution/status.json','{"allocation":"approved"}\n');const approval=f.save();f.put('source.mjs','allowed author change\n');
 const s=fn('collectGitState')(f.repo,sourceBaseline,[],approval);assert.deepEqual(s.changedPaths,['source.mjs']);
 const c={...card(),worktreePath:f.repo,branch:'codex/fixture',candidateHead:approval,workingBaselineCommit:sourceBaseline,writeAllowlist:['source.mjs']};c.admission.sharedWriteGrants=['source.mjs'];
 // Ordinary fixture repository: only managed-link registration is a synthetic unit
 // input. All commits, ancestry, source bytes and changed paths above are real Git.
 assert.equal(decide(c,{...s,linked:true}).admitted,true);
 f.put('docs/execution/status.json','{"allocation":"candidate changed"}\n');assert.throws(()=>decide(c,{...api.collectGitState(f.repo,sourceBaseline,[],approval),linked:true}),/WRITE/);
 f.put('docs/execution/status.json','{"allocation":"approved"}\n');f.put('docs/execution/card.json','{"writeAllowlist":["*"]}\n');assert.throws(()=>decide(c,{...api.collectGitState(f.repo,sourceBaseline,[],approval),linked:true}),/WRITE/);
});
test('working baseline must precede both approval and candidate, and approval must precede candidate',()=>{
 const f=tinyRepo();f.put('source.mjs','first\n');const first=f.save();f.put('source.mjs','second\n');const second=f.save();
 const s=fn('collectGitState')(f.repo,second,[],first);assert.equal(s.baselineAncestor,true);assert.equal(s.baselineApprovalAncestor,false);
 const c={...card(),worktreePath:f.repo,branch:'codex/fixture',candidateHead:second,workingBaselineCommit:second,writeAllowlist:['source.mjs']};assert.throws(()=>decide(c,{...s,linked:true}),/BASELINE/);
 const actual=api.collectGitState(f.repo,first,[],first);assert.equal(actual.approvalAncestor,true);assert.throws(()=>decide(c,{...actual,linked:true,approvalAncestor:false}),/APPROVAL/);
});

// Round 1 review reproducer: target is an isolated sibling, never an external path.
for(const location of ['.dev','.dev/admission-fixtures','.dev/admission-fixtures/runner-temp'])test(`runner rejects junction at ${location} before mkdir or child execution`,()=>{
 const base=mkdtempSync(path.join(scratch,'temp-alias-')),approvedRoot=path.join(base,'approved-root'),outside=path.join(base,'outside-target');mkdirSync(approvedRoot);mkdirSync(outside);
 const fixtureRel='.dev/admission-fixtures/trusted/case.test.mjs';
 // Keep the fixture outside aliased .dev and explicitly use a nested namespace;
 // fixture policy validation must not be reached once temp containment is unsafe.
 const marker=path.join(outside,'escaped-sentinel');const source="import {test} from 'node:test';import {writeFileSync} from 'node:fs';import {join} from 'node:path';test('required compatibility',()=>writeFileSync(join(process.env.TEMP,'escaped-sentinel'),'executed'));";
 const ancestor=path.dirname(path.join(approvedRoot,location));mkdirSync(ancestor,{recursive:true});symlinkSync(outside,path.join(approvedRoot,location),'junction');
 const actualFixture=path.join(approvedRoot,fixtureRel);mkdirSync(path.dirname(actualFixture),{recursive:true});writeFileSync(actualFixture,source);
 const before=readFileSync(actualFixture);
 assert.throws(()=>fn('runApprovedTests')(approvedRoot,{fixtureNamespace:'.dev/admission-fixtures/trusted',tests:[{path:fixtureRel,sha256:hash(before),requiredNames:['required compatibility']}]}),/PATH/);
 assert.equal(existsSync(marker),false,'test handler must not execute through temp alias');
 // mkdir of the runner path must not appear under either aliased ancestor.
 if(location!=='.dev/admission-fixtures/runner-temp')assert.equal(existsSync(path.join(outside,location==='.dev'?'admission-fixtures/runner-temp':'runner-temp')),false,'no prevalidation mkdir side effect');
});
for(const status of ['blocked_personal_binding','blocked','pending','proposed','unknown',undefined])test(`registry lifecycle ${String(status)} cannot be CPU admitted`,()=>{
 const r=structuredClone(registry);r.tasks[0].status=status;
 assert.throws(()=>fn('evaluateAdmission')({card:card(),registry:r,state:state(),activeCards:[],dependencies:[]}),/REGISTRY/);
});
test('unresolved external gate prevents CPU admission even in ready lifecycle',()=>{const r=structuredClone(registry);r.tasks[0].status='ready';r.tasks[0].externalGates=['verified personal binding'];assert.throws(()=>fn('evaluateAdmission')({card:card(),registry:r,state:state(),activeCards:[],dependencies:[]}),/REGISTRY/);});
test('explicit ready claimed and in_progress CPU lifecycle without external gates remains admitted',()=>{for(const status of ['ready','claimed','in_progress']){const r=structuredClone(registry);r.tasks[0].status=status;r.tasks[0].externalGates=[];assert.equal(fn('evaluateAdmission')({card:card(),registry:r,state:state(),activeCards:[],dependencies:[]}).admitted,true);}});
test('executes exact trusted native no-profile flavor compatibility tests with pinned bytes and names',()=>{
 const p='apps/desktop/src/flavor.test.mjs';const gitBytes=spawnSync('git',['-C',root,'show',`${head}:${p}`]).stdout;
 const result=fn('runApprovedTests')(root,{tests:[{path:p,commit:head,sha256:hash(readFileSync(path.join(root,p))),gitBlobSha256:hash(gitBytes),requiredNames:['which app this is: packaged, the release unless built as the preview; from source, dev when asked','the preview shares nothing with an installed OpenFilm or the dev app',"every app makes its projects in the person's one library"]}]});
 assert.equal(result[0].exitCode,0);assert.equal(result[0].names.length,3);
});

test('runner rejects a junction in its approved root ancestor chain before creating temp',()=>{
 const base=mkdtempSync(path.join(scratch,'root-alias-')),target=path.join(base,'target-root'),alias=path.join(base,'alias-root');mkdirSync(target);symlinkSync(target,alias,'junction');
 const rel='.dev/admission-fixtures/trusted/case.test.mjs',source="import {test} from 'node:test';import {writeFileSync} from 'node:fs';import {join} from 'node:path';test('required compatibility',()=>writeFileSync(join(process.env.TEMP,'handler-executed'),'yes'));";
 mkdirSync(path.dirname(path.join(target,rel)),{recursive:true});writeFileSync(path.join(target,rel),source);
 assert.throws(()=>fn('runApprovedTests')(alias,{fixtureNamespace:'.dev/admission-fixtures/trusted',tests:[{path:rel,sha256:hash(source),requiredNames:['required compatibility']}]}),/PATH/);
 assert.equal(existsSync(path.join(target,'.dev/admission-fixtures/runner-temp')),false);
});
for(const type of ['dangling junction','file'])test(`runner rejects ${type} temp alias without target or handler side effects`,()=>{
 const base=mkdtempSync(path.join(scratch,'temp-type-')),approvedRoot=path.join(base,'approved-root'),missing=path.join(base,'missing-target');mkdirSync(approvedRoot);
 const rel='.dev/admission-fixtures/trusted/case.test.mjs',source="import {test} from 'node:test';import {writeFileSync} from 'node:fs';import {join} from 'node:path';test('required compatibility',()=>writeFileSync(join(process.env.TEMP,'handler-executed'),'yes'));";
 mkdirSync(path.dirname(path.join(approvedRoot,rel)),{recursive:true});writeFileSync(path.join(approvedRoot,rel),source);
 const temp=path.join(approvedRoot,'.dev/admission-fixtures/runner-temp');if(type==='file')writeFileSync(temp,'not a directory');else symlinkSync(missing,temp,'junction');
 assert.throws(()=>fn('runApprovedTests')(approvedRoot,{fixtureNamespace:'.dev/admission-fixtures/trusted',tests:[{path:rel,sha256:hash(source),requiredNames:['required compatibility']}]}),/PATH/);
 assert.equal(existsSync(missing),false);if(type==='file')assert.equal(readFileSync(temp,'utf8'),'not a directory');
});

test('real staged coordinator paths remain visible and factual admission refuses out-of-allow writes',()=>{
 const f=tinyRepo();f.put('source.mjs','approved source\n');const at=f.save();f.put('docs/execution/status.json','{"coordinator":"pending bookkeeping"}\n');f.invoke('add','docs/execution/status.json');
 const factual=fn('collectGitState')(f.repo,at,[],at);assert.deepEqual(factual.changedPaths,['docs/execution/status.json']);assert.equal(factual.contentHashes['docs/execution/status.json'],hash(readFileSync(path.join(f.repo,'docs/execution/status.json'))));
 const c={...card(),worktreePath:f.repo,branch:'codex/fixture',candidateHead:at,workingBaselineCommit:at,writeAllowlist:['source.mjs']};
 // Only managed-link registration is synthetic for this ordinary repository;
 // the out-of-allow staged change is collected truthfully and never filtered.
 assert.throws(()=>decide(c,{...factual,linked:true}),/WRITE/);
});
