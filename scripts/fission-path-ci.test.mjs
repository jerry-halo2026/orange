import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('./fission-path-ci.mjs').catch(() => ({}));
const verify = xml => { assert.equal(typeof api.verifyPathPolicyTrx, 'function', 'missing TRX capability'); return api.verifyPathPolicyTrx(xml); };
const context = facts => { assert.equal(typeof api.validatePathCiContext, 'function', 'missing context capability'); return api.validatePathCiContext(facts); };
const CLASS = 'Fission.UnitTests.EnginePathPolicyTests';
const names = [
  `${CLASS}.Create_LinkedWritableOrReadOnlyRoot_Rejects(symbolic: True)`,
  `${CLASS}.ValidateWritablePath_RealWindowsJunctionOrSymlinkAncestor_RejectsBeforeAnyCreation(symbolic: True)`,
  ...Array.from({length:41}, (_,i) => `${CLASS}.SyntheticValidCase${i}(component: "safe & < > ' 中文")`),
];
const escape = s => s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll("'",'&apos;');
const guid = i => `00000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`;
function fixture() {
 const results = names.map((n,i) => `<UnitTestResult executionId="${guid(i)}" testId="${guid(i+50)}" testName="${escape(n)}" outcome="Passed" />`).join('');
 const defs = names.map((n,i) => `<UnitTest id="${guid(i+50)}" name="${escape(n)}"><Execution id="${guid(i)}"/><TestMethod className="${CLASS}" name="${n.slice(CLASS.length+1).split('(')[0]}"/></UnitTest>`).join('');
 const entries = names.map((_,i) => `<TestEntry testId="${guid(i+50)}" executionId="${guid(i)}"/>`).join('');
 return `<?xml version="1.0" encoding="utf-8"?><TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>${results}</Results><TestDefinitions>${defs}</TestDefinitions><TestEntries>${entries}</TestEntries><ResultSummary outcome="Completed"><Counters total="43" executed="43" passed="43" failed="0" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0"/></ResultSummary></TestRun>`;
}
const facts = () => ({GITHUB_ACTIONS:'true', RUNNER_OS:'Windows', GITHUB_REPOSITORY:'jerry-halo2026/orange', ORANGE_REPOSITORY_VISIBILITY:'public', GITHUB_REF:'refs/heads/codex/t05-path-policy', GITHUB_SHA:'a'.repeat(40), GITHUB_RUN_ID:'123', GITHUB_RUN_ATTEMPT:'1', GITHUB_WORKSPACE:'D:\\a\\orange\\orange'});
test('accepts 43 linked all-passed results and both actual symbolic True names', () => {
 const result = verify(fixture()); assert.equal(result.passed,43); assert.equal(result.executed,43); assert.deepEqual([...result.testNames].sort(), [...names].sort());
});
test('accepts legitimate predefined and decimal or hexadecimal numeric XML escapes', () => {
 const xml = fixture().replaceAll('&quot;','&#34;').replaceAll('&apos;','&#x27;').replaceAll('中文','&#20013;&#x6587;'); assert.equal(verify(xml).passed,43);
});
const invalid = {
 zero: x=>x.replaceAll('="43"','="0"'), incomplete: x=>x.replace(/<UnitTestResult[^>]+\/>/,''), duplicateId: x=>x.replaceAll(guid(1),guid(0)), duplicateName: x=>x.replaceAll(escape(names[1]),escape(names[0])), missingSymbolic: x=>x.replaceAll('symbolic: True','symbolic: False'), wrongClass: x=>x.replaceAll(CLASS, 'Other.Class'), badDefinition: x=>x.replace(`className="${CLASS}"`,'className="Wrong.Class"'), badMethod: x=>x.replace('name="Create_LinkedWritableOrReadOnlyRoot_Rejects"','name="DifferentMethod"'), missingEntry: x=>x.replace(/<TestEntry[^>]+\/>/,''), mismatchEntry: x=>x.replace('<TestEntry testId="'+guid(50)+'"','<TestEntry testId="'+guid(999)+'"'), missingDefinitions: x=>x.replace(/<TestDefinitions>[\s\S]*?<\/TestDefinitions>/,''), mismatchCounter: x=>x.replace('passed="43"','passed="42"'), missingCounter: x=>x.replace('failed="0"',''), extraCounter: x=>x.replace('failed="0"','failed="0" skipped="1"'), duplicateSummary: x=>x.replace('</TestRun>', '<ResultSummary outcome="Completed"><Counters total="43"/></ResultSummary></TestRun>'), nestedSummary: x=>x.replace('</Results>','<ResultSummary outcome="Completed"/></Results>'), wrongSummary: x=>x.replace('outcome="Completed"','outcome="Failed"'), dtd: x=>'<!DOCTYPE TestRun>'+x, externalEntity: x=>'<!DOCTYPE TestRun [<!ENTITY x SYSTEM "file:///private">]>'+x, customEntity: x=>'<!DOCTYPE TestRun [<!ENTITY x "hello">]>'+x, undeclaredEntity: x=>x.replace('safe &amp;', 'safe &unknown;'), invalidNumeric: x=>x.replace('&amp;','&#0;'), surrogateNumeric: x=>x.replace('&amp;','&#xD800;'), tooLargeNumeric: x=>x.replace('&amp;','&#x110000;'), rawAmpersand: x=>x.replace('&amp;','&'), rawLess: x=>x.replace('&lt;','<'), duplicateAttribute: x=>x.replace('outcome="Passed"','outcome="Passed" outcome="Passed"'), unquotedAttribute: x=>x.replace('outcome="Passed"','outcome=Passed'), truncated: x=>x.slice(0,-10), mismatchedTag: x=>x.replace('</Results>','</TestDefinitions>'), trailingRoot: x=>x+'<TestRun/>', unknownElement: x=>x.replace('<Results>','<Unknown/><Results>'), prefixedElement: x=>x.replace('<Results>','<x:Results>'), wrongNamespace: x=>x.replace('http://microsoft.com/schemas/VisualStudio/TeamTest/2010','https://wrong.example'), changedNamespace: x=>x.replace('<Results>','<Results xmlns="urn:wrong">'), processingInstruction: x=>x.replace('<Results>','<?custom data?><Results>'), badComment: x=>x.replace('<Results>','<!-- bad -- comment --><Results>'), invalidControl: x=>x.replace('safe','safe\u0001'), badExecutionId: x=>x.replaceAll(guid(0),'not-guid'), missingName: x=>x.replace(/ testName="[^"]+"/,''), ambiguousSummaryText: x=>x.replace('<ResultSummary','garbage<ResultSummary'), unknownSummaryChild: x=>x.replace('</ResultSummary>','<RunInfos><RunInfo outcome="Error"/></RunInfos></ResultSummary>'), nonzeroError: x=>x.replace('error="0"','error="1"'), duplicateCounters: x=>x.replace('</ResultSummary>','<Counters/></ResultSummary>'), nestedResult: x=>x.replace('<Results>','<Results><Results>'), invalidTextEntity: x=>x.replace('</ResultSummary>','<Output><StdOut>&evil;</StdOut></Output></ResultSummary>'), missingSpace: x=>x.replace('outcome="Passed" />','outcome="Passed"testId="x" />'), bomInside: x=>x.replace('<Results>','\uFEFF<Results>'), rawCloseText: x=>x.replace('</ResultSummary>','<Output><StdOut>bad ]]></StdOut></Output></ResultSummary>'), malformedDeclaration: x=>x.replace('version="1.0"','version="2.0"'), missingResultOutcome: x=>x.replace(' outcome="Passed"',''), nonString: ()=>null,
};
for (const [name, mutate] of Object.entries(invalid)) test(`rejects TRX ${name}`, () => assert.throws(()=>verify(mutate(fixture())), {message:/^TRX_INVALID$/}));
for (const outcome of ['Failed','Skipped','NotExecuted','Inconclusive','Error','Aborted','Timeout','Canceled','Cancelled','Todo','InProgress','Pending']) test(`rejects result outcome ${outcome}`, () => assert.throws(()=>verify(fixture().replace('outcome="Passed"',`outcome="${outcome}"`)), {message:/^TRX_INVALID$/}));
test('context derives only this run attempt owned fixtures', () => {
 const result=context(facts()); assert.equal(result.ownedRoot,'D:\\a\\orange\\orange\\.dev\\fission-ci\\123\\1'); assert.equal(result.fixtureRoot,result.ownedRoot+'\\fixtures');
});
for(const [key,value] of Object.entries({GITHUB_ACTIONS:'false',RUNNER_OS:'Linux',GITHUB_REPOSITORY:'other/orange',ORANGE_REPOSITORY_VISIBILITY:'private',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'A'.repeat(40),GITHUB_RUN_ID:'0',GITHUB_RUN_ATTEMPT:'-1'})) test(`rejects untrusted context ${key}`,()=>assert.throws(()=>context({...facts(),[key]:value}),{message:/^CONTEXT_INVALID$/}));
for (const value of ['','relative','C:relative','\\root','\\\\server\\share','\\\\?\\C:\\work','C:\\','C:\\a\\..\\b','C:\\a\\.\\b','C:/a/b','C:\\a\\','C:\\a\\bad.','C:\\a\\bad ','C:\\a\\CON.txt','C:\\a\\COM¹','C:\\a\\name~1','C:\\a\\file:stream','C:\\a\\bad?name','C:\\a\\bad\nname']) test(`rejects unsafe workspace ${JSON.stringify(value)}`,()=>assert.throws(()=>context({...facts(),GITHUB_WORKSPACE:value}),{message:/^CONTEXT_INVALID$/}));
for(const value of ['01','1.0','1e2','+1',' 1','1/2']) test(`rejects ambiguous run id ${value}`,()=>assert.throws(()=>context({...facts(),GITHUB_RUN_ID:value}),{message:/^CONTEXT_INVALID$/}));
test('rejects hostile facts without leaking private exception',()=>assert.throws(()=>context(new Proxy({}, {get(){throw Error('PRIVATE');}})), {message:/^CONTEXT_INVALID$/}));
test('imports only guarded capabilities and pure review seams without running CI or IO',()=>{assert.deepEqual(Object.keys(api).sort(),['buildPathCiEnvironment','parseCompilerVersion','runPathPolicyCi','safeSubprocessFailure','validatePathCiContext','verifyPathPolicyTrx']);});

test('accepts generated TRX multiline stdout without returning its private text',()=> {
 const result=verify(fixture().replace('</ResultSummary>','<Output><StdOut>adapter starting&#xD;\n  adapter finished\n&lt;safe&gt;</StdOut></Output></ResultSummary>')); assert.equal(result.passed,43); assert.equal(JSON.stringify(result).includes('adapter starting'),false);
});
test('accepts well-formed comments without trusting their apparent results',()=>assert.equal(verify(fixture().replace('<Results>','<!-- no extra result --><Results>')).passed,43));
for(const value of ['C:\\a\\percent%name','C:\\a\\bang!name','C:\\a\\amp&name']) test(`rejects shell-expanding workspace ${value}`,()=>assert.throws(()=>context({...facts(),GITHUB_WORKSPACE:value}),{message:/^CONTEXT_INVALID$/}));

test('accepts positive decimal run identifiers without lossy numeric conversion',()=>assert.equal(context({...facts(),GITHUB_RUN_ID:'9007199254740992'}).ownedRoot,'D:\\a\\orange\\orange\\.dev\\fission-ci\\9007199254740992\\1'));
test('rejects context whose owned fixture path exceeds its lexical bound before IO',()=>assert.throws(()=>context({...facts(),GITHUB_WORKSPACE:'D:\\'+('a'.repeat(220))}),{message:/^CONTEXT_INVALID$/}));
test('import succeeds with filesystem writes and child processes denied',async()=>{
 const {spawnSync}=await import('node:child_process'); const {fileURLToPath}=await import('node:url');
 const moduleUrl=new URL('./fission-path-ci.mjs',import.meta.url);
 const code=`globalThis.fetch=()=>{throw new Error('network forbidden')}; const m=await import(${JSON.stringify(moduleUrl.href)}); console.log(Object.keys(m).sort().join(','));`;
 const child=spawnSync(process.execPath,['--permission','--allow-fs-read='+fileURLToPath(moduleUrl),'--input-type=module','-e',code],{encoding:'utf8',env:{SystemRoot:process.env.SystemRoot},timeout:15000,windowsHide:true});
 assert.equal(child.status,0, 'pure import must need no write or child-process permission');assert.equal(child.stdout.trim(),'buildPathCiEnvironment,parseCompilerVersion,runPathPolicyCi,safeSubprocessFailure,validatePathCiContext,verifyPathPolicyTrx');assert.equal(child.stderr,'');
});

test('rejects duplicate GUID identities disguised by hexadecimal letter casing',()=>{
 const xml=fixture().replaceAll(guid(0),'aaaaaaaa-0000-0000-0000-000000000001').replaceAll(guid(1),'AAAAAAAA-0000-0000-0000-000000000001');assert.throws(()=>verify(xml),{message:/^TRX_INVALID$/});
});
test('rejects duplicate test definition GUID identities disguised by casing',()=>{
 const xml=fixture().replaceAll(guid(50),'bbbbbbbb-0000-0000-0000-000000000001').replaceAll(guid(51),'BBBBBBBB-0000-0000-0000-000000000001');assert.throws(()=>verify(xml),{message:/^TRX_INVALID$/});
});

const compilerVersion = output => { assert.equal(typeof api.parseCompilerVersion,'function','missing strict compiler-version capability'); return api.parseCompilerVersion(output); };
const environment = options => { assert.equal(typeof api.buildPathCiEnvironment,'function','missing clean CI environment capability'); return api.buildPathCiEnvironment(options); };
const environmentOptions = () => ({systemRoot:'C:\\Windows',programFilesX86:'C:\\Program Files (x86)',installation:'C:\\Program Files\\dotnet',ownedRoot:'D:\\a\\orange\\orange\\.dev\\fission-ci\\123\\1'});
for(const version of [
 '5.6.0-2.26230.102 (caa81fa4971f74880cdab61990cb1b11420939ec)',
 '5.6.0-2.26230.102', '5.6.0', '5.6.0 (caa81fa4971f74880cdab61990cb1b11420939ec)',
 '5.6.0-2.26230.102+build.1',
]) test(`accepts exact single-line Roslyn version shape ${version}`,()=> {
 assert.equal(compilerVersion(version),version); assert.equal(compilerVersion(version+'\r\n'),version); assert.equal(compilerVersion(version+'\n'),version);
});
for(const output of [
 '', null, 5.6, 'PRIVATE ERROR BODY', ' 5.6.0', '5.6.0 ', '5.6.0\nextra text', '5.6.0\r\nextra text',
 'extra text\n5.6.0', '5.6.0\n\n', '5.6.0\r', '5.6.0 (abc123)',
 '5.6.0 (caa81fa4971f74880cdab61990cb1b11420939eg)',
 '5.6.0 (caa81fa4971f74880cdab61990cb1b11420939ec) EXTRA',
 '5.6.0 (caa81fa4971f74880cdab61990cb1b11420939ec\n)', '5.6.0()', '5.6.0-',
 '5.6.0 (caa81fa4971f74880cdab61990cb1b11420939ec) (caa81fa4971f74880cdab61990cb1b11420939ec)',
]) test(`rejects unsafe compiler-version output ${JSON.stringify(output)}`,()=>assert.throws(()=>compilerVersion(output),{message:/^CI_COMPILER_SELECTION_MISMATCH$/}));
test('clean environment separates original shim SDK inventory from real apphost runtime root',()=>{
 const env=environment(environmentOptions());assert.equal(env.DOTNET_ROOT,'D:\\a\\orange\\orange\\.dev\\fission-ci\\123\\1\\toolinventory');assert.equal(env.DOTNET_ROOT_X64,'C:\\Program Files\\dotnet');assert.equal(env.DOTNET_HOST_PATH,'C:\\Program Files\\dotnet\\dotnet.exe');assert.equal(env.PATH,'C:\\Program Files\\dotnet;C:\\Windows\\System32;C:\\Windows');assert.equal(env.FISSION_PATH_POLICY_TEST_ROOT,'D:\\a\\orange\\orange\\.dev\\fission-ci\\123\\1\\fixtures');
});
test('clean environment owns user cache config and temp locations without inheriting supplied secrets',()=>{
 const input=Object.freeze({...environmentOptions(),GITHUB_TOKEN:'PRIVATE',NUGET_AUTH_TOKEN:'PRIVATE',PATH:'PRIVATE',inheritedEnvironment:{PRIVATE_FEED:'PRIVATE',DOTNET_ROOT_X64:'PRIVATE'}});
 const env=environment(input);
 const own='D:\\a\\orange\\orange\\.dev\\fission-ci\\123\\1';
 const locations={HOME:'home',USERPROFILE:'user',APPDATA:'appdata',LOCALAPPDATA:'localappdata',ProgramData:'programdata',ALLUSERSPROFILE:'programdata',TEMP:'temp',TMP:'temp',TMPDIR:'temp',NUGET_PACKAGES:'packages',NUGET_HTTP_CACHE_PATH:'nuget',NUGET_PLUGINS_CACHE_PATH:'nuget',NUGET_SCRATCH:'temp',DOTNET_CLI_HOME:'clihome',GIT_CONFIG_GLOBAL:'git.config',FISSION_PATH_POLICY_TEST_ROOT:'fixtures'};
 for(const [name,directory] of Object.entries(locations))assert.equal(env[name],own+'\\'+directory);
 for(const forbidden of ['GITHUB_TOKEN','NUGET_AUTH_TOKEN','PRIVATE_FEED','inheritedEnvironment','NODE_OPTIONS','MSBuildSDKsPath','DOTNET_ROOT_X86'])assert.equal(Object.hasOwn(env,forbidden),false);
 assert.equal(Object.values(env).includes('PRIVATE'),false);assert.equal(Object.getPrototypeOf(env),null);assert.equal(Object.isFrozen(env),true);assert.equal(Object.values(env).every(value=>typeof value==='string'),true);
});
for(const [key,value] of [['systemRoot','relative'],['installation','\\\\host\\share'],['ownedRoot','D:\\a\\..\\escape'],['ownedRoot','C:\\Program Files\\dotnet\\scratch']]) test(`rejects unsafe environment location ${key} ${value}`,()=>assert.throws(()=>environment({...environmentOptions(),[key]:value}),{message:/^CI_ENVIRONMENT_INVALID$/}));
test('environment construction sanitizes hostile input errors',()=>assert.throws(()=>environment(new Proxy({}, {get(){throw Error('PRIVATE');}})),{message:/^CI_ENVIRONMENT_INVALID$/}));

test('clean environment includes only the explicit read-only ProgramFiles(x86) OS fact',()=>{
 const env=environment({...environmentOptions(),ProgramFiles:'PRIVATE',ProgramW6432:'PRIVATE',SystemDrive:'PRIVATE'});assert.equal(env['ProgramFiles(x86)'],'C:\\Program Files (x86)');for(const key of ['ProgramFiles','ProgramW6432','SystemDrive','CommonProgramFiles','CommonProgramFiles(x86)','CommonProgramW6432'])assert.equal(Object.hasOwn(env,key),false);
});
for(const value of [undefined,null,'','relative','C:relative','C:\\Program Files (x86)\\..\\escape','\\\\server\\share','\\\\?\\C:\\Program Files (x86)','C:\\bad.','C:\\bad%name','D:\\a\\orange\\orange\\.dev\\fission-ci\\123\\1','D:\\a\\orange\\orange\\.dev\\fission-ci\\123\\1\\nuget','D:\\a\\orange\\orange']) test(`rejects invalid or owned-overlapping ProgramFiles(x86) ${JSON.stringify(value)}`,()=>assert.throws(()=>environment({...environmentOptions(),programFilesX86:value}),{message:/^CI_ENVIRONMENT_INVALID$/}));
const failure = (stage,result) => {assert.equal(typeof api.safeSubprocessFailure,'function','missing bounded subprocess diagnostic capability');return api.safeSubprocessFailure(stage,result);};
test('failure summary exposes only fixed stage numeric exit status and bounded diagnostic facts',()=>{
 const result=failure('restore',{status:1,signal:null,error:null,stdout:Buffer.from('PRIVATE path user token NU1301 : private feed\nMSB4018 failed ConfigurationDefaults'),stderr:'System.TypeInitializationException PRIVATE args CS0518 CA1859 NETSDK1045 NU1301',args:['PRIVATE'],env:{TOKEN:'PRIVATE'}});
 assert.deepEqual(JSON.parse(JSON.stringify(result)),{stage:'restore',exitCode:1,signal:null,spawnErrorCode:null,diagnosticCodes:['CA1859','CS0518','MSB4018','NETSDK1045','NU1301'],exceptionTags:['ConfigurationDefaults','TypeInitializationException']});assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.diagnosticCodes),true);assert.equal(Object.isFrozen(result.exceptionTags),true);
});
for(const stage of ['git-head','git-root','source-0','source-1','build-input-2','build-input-3','build-input-4','build-input-5','build-input-6','sdk-version','compiler-version','original-shim-version','runtime-versions','restore','path-policy-tests','git-final-head'])test(`retains known subprocess stage ${stage}`,()=>assert.equal(failure(stage,{status:1}).stage,stage));
for(const stage of ['PRIVATE','restore\nPRIVATE','source-99',null,{},new Proxy({}, {get(){throw Error('PRIVATE');}})])test('unknown subprocess stage never reflects supplied label',()=>assert.equal(failure(stage,{status:1}).stage,'unknown'));
for(const code of ['ENOENT','EACCES','EPERM','ETIMEDOUT','ENOBUFS','EINVAL','ENOMEM','E2BIG','ENOTDIR','EISDIR','EIO','ENOEXEC']) test(`retains allowlisted spawn error code ${code}`,()=>{
 const result=failure('restore',{status:null,signal:null,error:{code,get message(){throw Error('PRIVATE');}}});assert.equal(result.spawnErrorCode,code);assert.equal(result.exitCode,null);
});
for(const signal of ['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV','SIGILL','SIGFPE','SIGBREAK','SIGHUP'])test(`retains allowlisted subprocess signal ${signal}`,()=>assert.equal(failure('path-policy-tests',{status:null,signal}).signal,signal));
test('unknown signal and spawn error are fixed enums not supplied text',()=>{
 const result=failure('restore',{status:1,signal:'PRIVATE',error:{code:'PRIVATE',message:'PRIVATE'},stdout:'PRIVATE',stderr:'PRIVATE'});assert.equal(result.signal,'UNKNOWN');assert.equal(result.spawnErrorCode,'UNKNOWN');assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});
for(const value of ['1',NaN,Infinity,1.5,-2147483649,4294967296,{},null])test(`unsafe subprocess exit code becomes null ${typeof value}`,()=>assert.equal(failure('restore',{status:value}).exitCode,null));
for(const value of [0,1,-2147483648,3221225477,4294967295])test(`preserves numeric subprocess exit code ${value}`,()=>assert.equal(failure('restore',{status:value}).exitCode,value));
test('hostile subprocess getters and nonobjects return fixed safe unknown facts',()=>{
 for(const value of [null,undefined,'PRIVATE',new Proxy({}, {get(){throw Error('PRIVATE');}})]) {
  const result=failure('restore',value);assert.deepEqual(JSON.parse(JSON.stringify(result)),{stage:'restore',exitCode:null,signal:'UNKNOWN',spawnErrorCode:'UNKNOWN',diagnosticCodes:[],exceptionTags:[]});assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
 }
});
test('diagnostic matching rejects embedded or oversized codes and limits unique codes',()=>{
 const stdout=['PRIVATE_NU1301','xCS0518','MSB12345','NETSDK10450','CA1859extra',...Array.from({length:20},(_,i)=>'NU'+String(1000+i))].join(' ');
 assert.deepEqual(failure('restore',{status:1,stdout}).diagnosticCodes,['NU1000','NU1001','NU1002','NU1003','NU1004','NU1005','NU1006','NU1007']);
});
test('diagnostics scan only bounded raw-output prefixes and never stringify objects',()=>{
 const hostile={toString(){throw Error('PRIVATE');},toJSON(){throw Error('PRIVATE');}};assert.deepEqual(failure('restore',{status:1,stdout:hostile,stderr:'x'.repeat(65536)+' NU1301 ConfigurationDefaults'}).diagnosticCodes,[]);assert.deepEqual(failure('restore',{status:1,stdout:'x'.repeat(65536)+' ConfigurationDefaults'}).exceptionTags,[]);
});
test('nonzero test subprocess failure can be summarized without granting TRX success',()=>{
 assert.equal(failure('path-policy-tests',{status:1,stderr:'NU1301 PRIVATE'}).exitCode,1);assert.throws(()=>verify(fixture().replace('outcome="Passed"','outcome="Failed"')),{message:/^TRX_INVALID$/});
});
