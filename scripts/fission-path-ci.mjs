import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Only these private descriptors may select a suite. XML and caller options
// cannot choose the expected class, count or mandatory cases.
const PATH_SUITE=Object.freeze({key:'pathPolicy',className:'Fission.UnitTests.EnginePathPolicyTests',total:43,mandatory:Object.freeze([
 'Create_LinkedWritableOrReadOnlyRoot_Rejects(symbolic: True)',
 'ValidateWritablePath_RealWindowsJunctionOrSymlinkAncestor_RejectsBeforeAnyCreation(symbolic: True)',
])});
const IO_SUITE=Object.freeze({key:'engineJobFiles',className:'Fission.UnitTests.EngineJobFilesTests',total:34,mandatory:Object.freeze([
 'CopyAudio_TrueFileSymlinkSourceRefuses','CopyAudio_TrueFileSymlinkDestinationRefuses',
 'RunAsync_FirstTransitionConcatFailureUsesFreshFallbackAndPreservesFailedEvidence(partialOutput: False)',
 'RunAsync_FirstTransitionConcatFailureUsesFreshFallbackAndPreservesFailedEvidence(partialOutput: True)',
])});
const XMLNS = 'http://microsoft.com/schemas/VisualStudio/TeamTest/2010';
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalidTrx = () => { throw new Error('TRX_INVALID'); };
const requireTrx = condition => { if (!condition) invalidTrx(); };
const xmlChar = n => n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);

// A deliberately small XML 1.0 lexer, not a general XML/DTD processor. Every
// character is consumed, attributes are quoted/unique, and namespaces cannot
// be rebound. Unknown structures fail closed instead of being ignored.
function parseTrxXml(input) {
  requireTrx(typeof input === 'string' && input.length > 0 && input.length <= 4_000_000);
  let xml = input.startsWith('\uFEFF') ? input.slice(1) : input;
  for (const ch of xml) requireTrx(xmlChar(ch.codePointAt(0)) && ch !== '\uFEFF');
  let pos = 0, nodes = 0;
  const ws = () => { const start=pos; while (' \t\r\n'.includes(xml[pos]) && pos<xml.length) pos++; return pos>start; };
  const name = () => { const found=/^[A-Za-z_][A-Za-z0-9_.-]*/.exec(xml.slice(pos)); requireTrx(found); pos+=found[0].length; return found[0]; };
  const decode = (raw, attribute = true) => {
    raw = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    if (attribute) raw = raw.replace(/[\t\n]/g, ' ');
    let out='';
    for(let i=0;i<raw.length;i++) {
      const ch=raw[i]; requireTrx(ch!=='<');
      if(ch!=='&') { out+=ch; continue; }
      const end=raw.indexOf(';',i+1); requireTrx(end!==-1);
      const entity=raw.slice(i+1,end), known={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
      if(Object.hasOwn(known,entity)) out+=known[entity];
      else { requireTrx(/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)); const number=entity[1]==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1)); requireTrx(xmlChar(number)); out+=String.fromCodePoint(number); }
      i=end;
    }
    return out;
  };
  if(xml.startsWith('<?xml')) {
    const declaration=/^<\?xml version=(?:"1\.0"|'1\.0')(?: encoding=(?:"utf-8"|'utf-8'))?(?: standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\?>/.exec(xml);
    requireTrx(declaration); pos=declaration[0].length;
  }
  function comment() { const end=xml.indexOf('-->',pos+4); requireTrx(end!==-1&&!xml.slice(pos+4,end).includes('--')&&!xml.slice(pos+4,end).endsWith('-')); pos=end+3; }
  function element(depth) {
    requireTrx(depth<12 && ++nodes<10000 && xml[pos]==='<' && /[A-Za-z_]/.test(xml[pos+1]||'')); pos++;
    const node={name:name(),attrs:Object.create(null),children:[],text:''};
    while(true) {
      const spaced=ws();
      if(xml.startsWith('/>',pos)){pos+=2;return node;}
      if(xml[pos]==='>'){pos++;break;}
      requireTrx(spaced); const key=name(); requireTrx(!Object.hasOwn(node.attrs,key)); ws(); requireTrx(xml[pos++]==='='); ws(); const quote=xml[pos++]; requireTrx(quote==='"'||quote==="'"); const end=xml.indexOf(quote,pos); requireTrx(end!==-1); node.attrs[key]=decode(xml.slice(pos,end)); pos=end+1;
    }
    while(pos<xml.length) {
      if(xml.startsWith('</',pos)) {pos+=2;requireTrx(name()===node.name);ws();requireTrx(xml[pos++]==='>');return node;}
      if(xml.startsWith('<!--',pos)){comment();continue;}
      if(xml[pos]==='<'){node.children.push(element(depth+1));continue;}
      const end=xml.indexOf('<',pos);requireTrx(end!==-1);const raw=xml.slice(pos,end);requireTrx(!raw.includes(']]>'));
      // Whitespace is permitted between elements; text content has XML entities
      // decoded and checked but is never returned or printed.
      node.text+=raw.trim()===''?raw:decode(raw, false);pos=end;
    }
    invalidTrx();
  }
  ws(); const root=element(0); ws(); requireTrx(pos===xml.length); return root;
}
const shape = {
  TestRun:['Times','TestSettings','Results','TestDefinitions','TestEntries','TestLists','ResultSummary'],
  TestSettings:['Deployment'], Results:['UnitTestResult'], UnitTestResult:['Output'],
  TestDefinitions:['UnitTest'], UnitTest:['Execution','TestMethod'], TestEntries:['TestEntry'],
  TestLists:['TestList'], ResultSummary:['Counters','Output'], Output:['StdOut','StdErr'],
  Times:[],Deployment:[],Execution:[],TestMethod:[],TestEntry:[],TestList:[],Counters:[],StdOut:[],StdErr:[],
};
function children(node,name) { return node.children.filter(child=>child.name===name); }
function one(node,name) { const found=children(node,name); requireTrx(found.length===1); return found[0]; }

function verifySuiteTrx(xml,suite) {
  const CLASS=suite.className,total=suite.total;
  try {
    const root=parseTrxXml(xml);requireTrx(root.name==='TestRun'&&root.attrs.xmlns===XMLNS);
    function validate(node,isRoot=false) {
      requireTrx(Object.hasOwn(shape,node.name));
      requireTrx(isRoot||!Object.hasOwn(node.attrs,'xmlns'));
      for(const key of Object.keys(node.attrs)) requireTrx(!key.includes(':'));
      requireTrx(['StdOut','StdErr'].includes(node.name)||node.text.trim()==='');
      for(const child of node.children) {requireTrx(shape[node.name].includes(child.name));validate(child);}
      if(!['Results','TestDefinitions','TestEntries','TestLists'].includes(node.name)) for(const childName of shape[node.name]) requireTrx(children(node,childName).length<=1);
    }
    validate(root,true);
    const results=one(root,'Results').children,definitions=one(root,'TestDefinitions').children,entries=one(root,'TestEntries').children;
    const summary=one(root,'ResultSummary'), counters=one(summary,'Counters').attrs;
    requireTrx(summary.attrs.outcome==='Completed'||summary.attrs.outcome==='Passed');
    const zero=['failed','error','timeout','aborted','inconclusive','passedButRunAborted','notRunnable','notExecuted','disconnected','warning','completed','inProgress','pending'];
    requireTrx(Object.keys(counters).length===zero.length+3);
    for(const key of ['total','executed','passed']) requireTrx(counters[key]===String(total));
    for(const key of zero) requireTrx(counters[key]==='0');
    requireTrx(results.length===total&&definitions.length===total&&entries.length===total);
    const seenIds=new Set(),seenTests=new Set(),seenNames=new Set(),byId=new Map();
    for(const def of definitions) {
      const execution=one(def,'Execution').attrs.id,method=one(def,'TestMethod').attrs;
      requireTrx(guid.test(def.attrs.id)&&guid.test(execution)&&!byId.has(def.attrs.id.toLowerCase()));
      requireTrx(method.className===CLASS&&/^[A-Za-z][A-Za-z0-9_]*$/.test(method.name));
      requireTrx(def.attrs.name===`${CLASS}.${method.name}`||def.attrs.name?.startsWith(`${CLASS}.${method.name}(`));
      byId.set(def.attrs.id.toLowerCase(),{execution:execution.toLowerCase(),name:def.attrs.name});
    }
    for(const result of results) {
      const a=result.attrs;
      requireTrx(a.outcome==='Passed'&&guid.test(a.executionId)&&guid.test(a.testId));
      const executionId=a.executionId.toLowerCase(),testId=a.testId.toLowerCase(),def=byId.get(testId);
      requireTrx(!seenIds.has(executionId)&&!seenTests.has(testId)&&!seenNames.has(a.testName));
      requireTrx(def&&def.execution===executionId&&def.name===a.testName&&a.testName.startsWith(CLASS+'.'));
      seenIds.add(executionId);seenTests.add(testId);seenNames.add(a.testName);
    }
    const entryIds=new Set();
    for(const entry of entries) {
      const a=entry.attrs;requireTrx(guid.test(a.testId)&&guid.test(a.executionId));
      const testId=a.testId.toLowerCase(),executionId=a.executionId.toLowerCase();
      requireTrx(byId.get(testId)?.execution===executionId&&seenIds.has(executionId)&&!entryIds.has(executionId));entryIds.add(executionId);
    }
    for(const name of suite.mandatory) requireTrx(seenNames.has(CLASS+'.'+name));
    return Object.freeze({total,executed:total,passed:total,failed:0,skipped:0,inconclusive:0,testNames:Object.freeze([...seenNames].sort())});
  } catch { invalidTrx(); }
}

export function verifyPathPolicyTrx(xml) {return verifySuiteTrx(xml,PATH_SUITE);}
export function verifyEngineJobFilesTrx(xml) {return verifySuiteTrx(xml,IO_SUITE);}

function safeWindowsPath(value) {
  if(typeof value!=='string'||!/^[A-Za-z]:\\/.test(value)||value.length>240) return false;
  const parts=value.slice(3).split('\\');
  return parts.length>0&&parts.every(p=>p!==''&&p!=='.'&&p!=='..'&&!/[\x00-\x1f\x7f%!&<>:"/|?*~]/.test(p)&&!/[. ]$/.test(p)&&!/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p));
}
export function validatePathCiContext(facts) {
  try {
    const exact={GITHUB_ACTIONS:'true',RUNNER_OS:'Windows',GITHUB_REPOSITORY:'jerry-halo2026/orange',ORANGE_REPOSITORY_VISIBILITY:'public',GITHUB_REF:'refs/heads/codex/t05-path-policy'};
    for(const [key,value] of Object.entries(exact)) if(facts[key]!==value) throw 0;
    if(typeof facts.GITHUB_SHA!=='string'||!/^[0-9a-f]{40}$/.test(facts.GITHUB_SHA)) throw 0;
    for(const key of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT']) if(typeof facts[key]!=='string'||! /^[1-9][0-9]*$/.test(facts[key])) throw 0;
    if(!safeWindowsPath(facts.GITHUB_WORKSPACE)) throw 0;
    const ownedRoot=path.win32.join(facts.GITHUB_WORKSPACE,'.dev','fission-ci',facts.GITHUB_RUN_ID,facts.GITHUB_RUN_ATTEMPT);
    const fixtureRoot=path.win32.join(ownedRoot,'fixtures');
    if(!safeWindowsPath(fixtureRoot)) throw 0;
    return Object.freeze({workspace:facts.GITHUB_WORKSPACE,commit:facts.GITHUB_SHA,ownedRoot,fixtureRoot});
  } catch {throw new Error('CONTEXT_INVALID');}
}

// Narrow pure CI seams: the runtime below consumes these same implementations.
// Do not trim arbitrary text: accept one Roslyn line and one optional final EOL.
export function parseCompilerVersion(output) {
  const invalid = () => {throw new Error('CI_COMPILER_SELECTION_MISMATCH');};
  if(typeof output!=='string'||output.length>200) invalid();
  const line=output.endsWith('\r\n')?output.slice(0,-2):output.endsWith('\n')?output.slice(0,-1):output;
  if(/[\r\n]/.test(line)||!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?: \([0-9a-f]{40}\))?$/.test(line)) invalid();
  return line;
}

// Machine installation roots are read-only/vetted by the runtime. All mutable
// user/cache/fixture locations derive solely from its validated attempt root.
// Generic DOTNET_ROOT serves the unchanged csc shim; the X64 apphost root and
// SDK child-host hint must instead reach the real preinstalled host/runtimes.
export function buildPathCiEnvironment(options) {
  try {
    const {systemRoot,installation,ownedRoot,programFilesX86}=options;
    if(![systemRoot,installation,ownedRoot,programFilesX86].every(safeWindowsPath)) throw 0;
    const overlaps=(a,b)=>a.toLowerCase()===b.toLowerCase()||a.toLowerCase().startsWith(b.toLowerCase()+'\\')||b.toLowerCase().startsWith(a.toLowerCase()+'\\');
    if(overlaps(ownedRoot,installation)||overlaps(ownedRoot,systemRoot)||overlaps(ownedRoot,programFilesX86)) throw 0;
    const owned=name=>{const result=path.win32.join(ownedRoot,name);if(!safeWindowsPath(result)) throw 0;return result;};
    const dirs=Object.fromEntries(['home','user','appdata','localappdata','programdata','temp','nuget','packages','clihome','toolinventory'].map(name=>[name,owned(name)]));
    const system32=path.win32.join(systemRoot,'System32'),command=path.win32.join(system32,'cmd.exe'),emptyGitConfig=owned('git.config');
    const environment={'ProgramFiles(x86)':programFilesX86,SystemRoot:systemRoot,WINDIR:systemRoot,ComSpec:command,PATH:[installation,system32,systemRoot].join(';'),PATHEXT:'.COM;.EXE;.BAT;.CMD',HOME:dirs.home,USERPROFILE:dirs.user,APPDATA:dirs.appdata,LOCALAPPDATA:dirs.localappdata,ProgramData:dirs.programdata,ALLUSERSPROFILE:dirs.programdata,TEMP:dirs.temp,TMP:dirs.temp,TMPDIR:dirs.temp,NUGET_PACKAGES:dirs.packages,NUGET_HTTP_CACHE_PATH:dirs.nuget,NUGET_PLUGINS_CACHE_PATH:dirs.nuget,NUGET_SCRATCH:dirs.temp,DOTNET_CLI_HOME:dirs.clihome,DOTNET_ROOT:dirs.toolinventory,DOTNET_ROOT_X64:installation,DOTNET_HOST_PATH:path.win32.join(installation,'dotnet.exe'),DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1',DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_NOLOGO:'1',DOTNET_ADD_GLOBAL_TOOLS_TO_PATH:'0',DOTNET_GENERATE_ASPNET_CERTIFICATE:'false',DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE:'true',DOTNET_MULTILEVEL_LOOKUP:'0',DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER:'1',MSBUILDDISABLENODEREUSE:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:emptyGitConfig,GIT_TERMINAL_PROMPT:'0',FISSION_PATH_POLICY_TEST_ROOT:owned('fixtures')};
    return Object.freeze(Object.assign(Object.create(null),environment));
  } catch {throw new Error('CI_ENVIRONMENT_INVALID');}
}

// This closure is the actual original project graph, not a replacement project.
const BUILD_ROOTS=Object.freeze(['workers/fission/src/Fission.Core','workers/fission/src/Fission.Steps','workers/fission/src/Fission.Providers','workers/fission/tests/Fission.UnitTests']);
const BUILD_PINS=Object.freeze({
 'workers/fission/src/Fission.Core/Engine/EnginePathPolicy.cs':'d8a49daab3d30260f2de29a4fb266bfd37fff501681aac55e232bf54b90107ac',
 'workers/fission/tests/Fission.UnitTests/EnginePathPolicyTests.cs':'89dbaf2d6b71c0d4dad1077715f8393872b23838117d92ffa68caf46bf50cef5',
 'workers/fission/src/Fission.Core/Engine/EngineJobFiles.cs':'4414056306ed74a7f8577d90ea2e65d2a2b2354a3bfecc934b667b16d41883e1',
 'workers/fission/src/Fission.Providers/Pipeline/FissionEngine.cs':'22664e0959690354604459316ff1c8d1573e637bd799008d87875c243d9f25cb',
 'workers/fission/tests/Fission.UnitTests/EngineJobFilesTests.cs':'199000b10d1f377088dcd294d7e5bb61a3baa24151ba5909c8772d3f46a45f3a',
 'workers/fission/tests/Fission.UnitTests/Fission.UnitTests.csproj':'1a9ada8da0c01f6512658c61f08f861063851c508f6b756cd1e9822d1a644fef',
 'workers/fission/src/Fission.Core/Fission.Core.csproj':'11c0c110e19c9eaeaef66a0382f7a3e4ff6ab395d99ca6664e1ba378371cc47c',
 'workers/fission/src/Fission.Steps/Fission.Steps.csproj':'dfb942a506bc8a64134c18be982b30dc40ef63530ce2d714305b177317c48b81',
 'workers/fission/src/Fission.Providers/Fission.Providers.csproj':'d474483d18b1594f6016d6efa62c1098b2504890a7f7a55d9cd6051f305d722c',
 'workers/fission/Directory.Build.props':'f6e395c72e106d1323d566f3694dec6b199b9d483a746de3782d88773149b83b',
 'workers/fission/tools/csc-shim/csc.bat':'5e385b1979523c8a0e366b24e088041e0447f04d5853b68a82737bf48ee6aba0',
});
const AUTH_PINS=Object.freeze({
 'apps/desktop/src/auth-service.mjs':'b4ddbc952df6513761201cb392213f7749432b8d7ade063c105598a87f780f66',
 'apps/desktop/src/auth-service.test.mjs':'032130aa427a9d31d7dd2f99101f2ec954c748763e164a29a498343f5a95d79b',
 'packages/openfilm/studio/server/project-access.mjs':'345efe1dafce55c09e9dfdcc965272509b0454d205c59dca51ad85ad06368a71',
 'packages/openfilm/studio/server/project-access.test.mjs':'4d52d5fc884986387d86b79ea8f75e56ec8c7d15ad2724d0843e20ba033be0b4',
});
const sha256=data=>createHash('sha256').update(data).digest('hex');
const canonicalText=bytes=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes).replaceAll('\r\n','\n');
function bindSourceSnapshots(snapshots,expectedPaths,pins) {
 const bad=()=>{throw new Error('CI_SOURCE_MISMATCH');};
 if(!Array.isArray(snapshots)||!Array.isArray(expectedPaths)||expectedPaths.length===0||new Set(expectedPaths).size!==expectedPaths.length||snapshots.length!==expectedPaths.length)bad();
 const expected=new Set(expectedPaths),seen=new Set(),proof=[];
 for(const item of snapshots) {
  if(!item||typeof item.path!=='string'||!expected.has(item.path)||seen.has(item.path)||!Buffer.isBuffer(item.raw)||!Buffer.isBuffer(item.canonical))bad();
  const blob=sha256(item.canonical);
  // Raw hashes are reported separately: only CRLF -> LF equivalence is allowed,
  // never BOM stripping, trimming, Unicode folding or bare-CR normalization.
  if((Object.hasOwn(pins,item.path)&&blob!==pins[item.path])||canonicalText(item.raw)!==canonicalText(item.canonical))bad();
  seen.add(item.path);proof.push(Object.freeze({path:item.path,gitBlobSha256:blob,rawSha256:sha256(item.raw)}));
 }
 for(const file of Object.keys(pins))if(!seen.has(file))bad();
 return Object.freeze(proof.sort((a,b)=>a.path.localeCompare(b.path,'en')));
}
export function validateBuildInputClosure(input) {
 try {
  const {trackedPaths,snapshots}=input;
  if(!Array.isArray(trackedPaths)||!Array.isArray(snapshots)||snapshots.some(item=>item?.linkCount!==1))throw 0;
  const projects=BUILD_ROOTS.map(root=>root+'/'+root.split('/').at(-1)+'.csproj');
  for(const file of trackedPaths) {
   if(typeof file!=='string'||file.split('/').some(part=>!part||part==='.'||part==='..')||file.includes('\\')||(!Object.hasOwn(BUILD_PINS,file)&&!BUILD_ROOTS.some(root=>file.startsWith(root+'/')&&/^[-A-Za-z0-9_/.]+\.cs$/.test(file))))throw 0;
   if(file.endsWith('.csproj')&&!projects.includes(file))throw 0;
  }
  return bindSourceSnapshots(snapshots,trackedPaths,BUILD_PINS);
 } catch {throw new Error('CI_SOURCE_MISMATCH');}
}
export function validateAuthCiProducer(snapshots) {
 try {return bindSourceSnapshots(snapshots,Object.keys(AUTH_PINS),AUTH_PINS);} catch {throw new Error('CI_SOURCE_MISMATCH');}
}

export function buildControlledIoCommands(facts) {
 const context=validatePathCiContext(facts),root=context.ownedRoot;
 const project=path.win32.join(context.workspace,'workers','fission','tests','Fission.UnitTests','Fission.UnitTests.csproj');
 const artifacts=path.win32.join(root,'artifacts');
 const restore=Object.freeze({stage:'restore',args:Object.freeze(['restore',project,'--configfile',path.win32.join(root,'NuGet.config'),'--packages',path.win32.join(root,'packages'),'--artifacts-path',artifacts,'--disable-parallel','--verbosity','quiet'])});
 const suites=[PATH_SUITE,IO_SUITE].map((suite,index)=>{
  const name=index===0?'path-policy':'engine-job-files',resultsDirectory=path.win32.join(root,'results',name),trxName=name+'.trx';
  return Object.freeze({key:suite.key,className:suite.className,total:suite.total,stage:name+'-tests',resultsDirectory,trxName,args:Object.freeze(['test',project,'--no-restore',...(index===1?['--no-build']:[]),'--artifacts-path',artifacts,'--filter','FullyQualifiedName~'+suite.className.split('.').at(-1),'--logger','trx;LogFileName='+trxName,'--results-directory',resultsDirectory,'--verbosity','quiet','--disable-build-servers'])});
 });
 return Object.freeze({restore,suites:Object.freeze(suites)});
}

const PUBLIC_PACKAGES=Object.freeze(["Microsoft.CodeCoverage/17.14.1","Microsoft.NET.Test.Sdk/17.14.1","Microsoft.TestPlatform.ObjectModel/17.14.1","Microsoft.TestPlatform.TestHost/17.14.1","Newtonsoft.Json/13.0.3","System.CodeDom/10.0.14","System.Management/10.0.14","coverlet.collector/6.0.4","xunit.abstractions/2.0.3","xunit.analyzers/1.18.0","xunit.assert/2.9.3","xunit.core/2.9.3","xunit.extensibility.core/2.9.3","xunit.extensibility.execution/2.9.3","xunit.runner.visualstudio/3.1.4","xunit/2.9.3"]);
export function verifyPublicPackageClosure(packages) {
 if(!Array.isArray(packages)||packages.length!==PUBLIC_PACKAGES.length||new Set(packages).size!==packages.length||packages.some(name=>!PUBLIC_PACKAGES.includes(name)))throw new Error('CI_SOURCE_MISMATCH');
 return Object.freeze([...packages].sort());
}

// Fixed-size diagnostic facts only: no result object/string/error is reflected.
// This helper cannot grant success; execute() still applies the original gate.
export function safeSubprocessFailure(stage,result) {
  const stages=new Set(['git-head','git-root','source-0','source-1','build-input-2','build-input-3','build-input-4','build-input-5','build-input-6','sdk-version','compiler-version','original-shim-version','runtime-versions','restore','path-policy-tests','engine-job-files-tests','source-inventory','source-blob','producer-blob','git-final-head']);
  const safeStage=typeof stage==='string'&&stages.has(stage)?stage:'unknown';
  const freeze=facts=>Object.freeze({...facts,diagnosticCodes:Object.freeze(facts.diagnosticCodes),exceptionTags:Object.freeze(facts.exceptionTags)});
  const unknown=()=>freeze({stage:safeStage,exitCode:null,signal:'UNKNOWN',spawnErrorCode:'UNKNOWN',diagnosticCodes:[],exceptionTags:[]});
  try {
    if(result===null||typeof result!=='object') return unknown();
    const status=result.status,rawSignal=result.signal,error=result.error;
    const exitCode=Number.isInteger(status)&&status>=-2147483648&&status<=4294967295?status:null;
    const signals=new Set(['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV','SIGILL','SIGFPE','SIGBREAK','SIGHUP']);
    const signal=rawSignal===null||rawSignal===undefined?null:typeof rawSignal==='string'&&signals.has(rawSignal)?rawSignal:'UNKNOWN';
    const errors=new Set(['ENOENT','EACCES','EPERM','ETIMEDOUT','ENOBUFS','EINVAL','ENOMEM','E2BIG','ENOTDIR','EISDIR','EIO','ENOEXEC']);
    const code=error===null||error===undefined?null:typeof error==='object'?error.code:undefined;
    const spawnErrorCode=error===null||error===undefined?null:typeof code==='string'&&errors.has(code)?code:'UNKNOWN';
    const prefix=value=>typeof value==='string'?value.slice(0,65536):Buffer.isBuffer(value)?Buffer.prototype.toString.call(Buffer.prototype.subarray.call(value,0,65536),'utf8'):'';
    const output=prefix(result.stdout)+'\n'+prefix(result.stderr);
    const diagnosticCodes=[...new Set([...output.matchAll(/(?:^|[^A-Za-z0-9_])((?:NU|MSB|CS|CA|NETSDK)[0-9]{4})(?=$|[^A-Za-z0-9_])/g)].map(match=>match[1]))].sort().slice(0,8);
    const exceptionTags=['ConfigurationDefaults','FileNotFoundException','NuGetConfigurationException','TypeInitializationException','UnauthorizedAccessException'].filter(tag=>new RegExp('(?:^|[^A-Za-z0-9_])'+tag+'(?=$|[^A-Za-z0-9_])').test(output));
    return freeze({stage:safeStage,exitCode,signal,spawnErrorCode,diagnosticCodes,exceptionTags});
  } catch {return unknown();}
}

export async function runPathPolicyCi() {
  // No filesystem imports, mkdir or subprocess occurs until these checks pass.
  const facts = Object.fromEntries(['GITHUB_ACTIONS','RUNNER_OS','GITHUB_REPOSITORY','ORANGE_REPOSITORY_VISIBILITY','GITHUB_REF','GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_WORKSPACE'].map(key=>[key,process.env[key]]));
  const context=validatePathCiContext(facts);
  if(process.platform!=='win32') throw new Error('CI_PLATFORM_UNAVAILABLE');
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<22||(major===22&&minor<18)) throw new Error('CI_NODE_UNAVAILABLE');
  const fs=await import('node:fs/promises');
  const {spawnSync}=await import('node:child_process');
  const hash=sha256;
  const fail = category => {throw new Error(category);};
  const equalPath = (a,b) => path.win32.normalize(a).replace(/^[a-z]:/,s=>s.toUpperCase())===path.win32.normalize(b).replace(/^[a-z]:/,s=>s.toUpperCase());
  const within = (owner,target) => equalPath(owner,target)||target.startsWith(owner+'\\');
  const ordinaryDirectory = async directory => {
    if(!safeWindowsPath(directory)&&! /^[A-Za-z]:\\$/.test(directory)) fail('CI_PATH_UNSAFE');
    let cursor=path.win32.parse(directory).root;
    for(const part of directory.slice(cursor.length).split('\\').filter(Boolean)) {
      const parent=cursor;cursor=path.win32.join(parent,part);
      const entry=await fs.lstat(cursor);
      if(!entry.isDirectory()||entry.isSymbolicLink()||!(await fs.readdir(parent)).includes(part)||!equalPath(await fs.realpath(cursor),cursor)) fail('CI_PATH_UNSAFE');
    }
  };
  const ordinaryFile = async filename => {
    await ordinaryDirectory(path.win32.dirname(filename));
    const entry=await fs.lstat(filename);
    if(!entry.isFile()||entry.isSymbolicLink()||!equalPath(await fs.realpath(filename),filename)||!(await fs.readdir(path.win32.dirname(filename))).includes(path.win32.basename(filename))) fail('CI_PATH_UNSAFE');
  };
  const createDirectory = async directory => {
    if(!safeWindowsPath(directory)||!within(context.ownedRoot,directory)) fail('CI_PATH_UNSAFE');
    await ordinaryDirectory(path.win32.dirname(directory));
    await fs.mkdir(directory); await ordinaryDirectory(directory);
  };
  await ordinaryDirectory(context.workspace);
  // Ordinary preexisting shared ancestors may be reused; the attempt itself
  // must be new. Never overwrite a previous attempt or erase failed evidence.
  let cursor=context.workspace;
  for(const component of ['.dev','fission-ci',facts.GITHUB_RUN_ID]) {
    await ordinaryDirectory(cursor);cursor=path.win32.join(cursor,component);
    try {await fs.mkdir(cursor);} catch(error) {if(error.code!=='EEXIST') throw error;}
    await ordinaryDirectory(cursor);
  }
  await createDirectory(context.ownedRoot);
  const dirs={};
  for(const name of ['home','user','appdata','localappdata','programdata','temp','nuget','packages','clihome','results','logs','fixtures','toolinventory','artifacts']) {dirs[name]=path.win32.join(context.ownedRoot,name);await createDirectory(dirs[name]);}
  if(dirs.fixtures!==context.fixtureRoot) fail('CI_PATH_UNSAFE');
  const commandPlan=buildControlledIoCommands(facts);
  for(const suite of commandPlan.suites) await createDirectory(suite.resultsDirectory);
  const writeOwned = async (filename,data) => {
    if(!within(context.ownedRoot,filename)||!safeWindowsPath(filename)) fail('CI_PATH_UNSAFE');
    await ordinaryDirectory(path.win32.dirname(filename));
    await fs.writeFile(filename,data,{flag:'wx'});await ordinaryFile(filename);
  };
  // Read only these three machine-location variables. Do not inherit process.env
  // or provider/account/feed settings into dotnet, git, cmd or the compiler.
  const systemRoot=process.env.SystemRoot,programFiles=process.env.ProgramFiles,programFilesX86=process.env['ProgramFiles(x86)'];
  if(!safeWindowsPath(systemRoot)||!safeWindowsPath(programFiles)||!safeWindowsPath(programFilesX86)) fail('CI_SYSTEM_UNAVAILABLE');
  await ordinaryDirectory(systemRoot);await ordinaryDirectory(programFiles);await ordinaryDirectory(programFilesX86);
  const system32=path.win32.join(systemRoot,'System32'),command=path.win32.join(system32,'cmd.exe');
  const installation=path.win32.join(programFiles,'dotnet'),dotnet=path.win32.join(installation,'dotnet.exe');
  const git=path.win32.join(programFiles,'Git','cmd','git.exe');
  await ordinaryFile(command);await ordinaryFile(git);
  try {await ordinaryFile(dotnet);await ordinaryDirectory(path.win32.join(installation,'sdk','10.0.403'));} catch {fail('CI_SDK_UNAVAILABLE');}
  const installedSdk=path.win32.join(installation,'sdk','10.0.403'),installedCompiler=path.win32.join(installedSdk,'Roslyn','bincore','csc.dll');
  await ordinaryFile(installedCompiler);
  const compilerSha256=hash(await fs.readFile(installedCompiler));
  const sdkInventory=path.win32.join(dirs.toolinventory,'sdk');await createDirectory(sdkInventory);
  const sdkLink=path.win32.join(sdkInventory,'10.0.403');
  await ordinaryDirectory(sdkInventory);await ordinaryDirectory(installedSdk);
  await fs.symlink(installedSdk,sdkLink,'junction');
  const verifyInventory = async () => {
    await ordinaryDirectory(sdkInventory);await ordinaryDirectory(installedSdk);
    if(JSON.stringify(await fs.readdir(sdkInventory))!==JSON.stringify(['10.0.403'])||!(await fs.lstat(sdkLink)).isSymbolicLink()||!equalPath(await fs.realpath(sdkLink),installedSdk)) fail('CI_COMPILER_SELECTION_MISMATCH');
    // This is the only intentionally linked path; it is a selection view, never
    // a package/cache/install/output location. No SDK target is modified here.
    if(hash(await fs.readFile(path.win32.join(sdkLink,'Roslyn','bincore','csc.dll')))!==compilerSha256||hash(await fs.readFile(installedCompiler))!==compilerSha256) fail('CI_COMPILER_SELECTION_MISMATCH');
  };
  await verifyInventory();
  const publicConfig=path.win32.join(context.ownedRoot,'NuGet.config');
  await writeOwned(publicConfig,'<?xml version="1.0" encoding="utf-8"?><configuration><packageSources><clear/><add key="public-nuget" value="https://api.nuget.org/v3/index.json"/></packageSources><disabledPackageSources><clear/></disabledPackageSources><packageSourceMapping><clear/></packageSourceMapping></configuration>\n');
  await writeOwned(path.win32.join(context.ownedRoot,'global.json'),JSON.stringify({sdk:{version:'10.0.403',rollForward:'disable',allowPrerelease:false}},null,2)+'\n');
  const emptyGitConfig=path.win32.join(context.ownedRoot,'git.config');await writeOwned(emptyGitConfig,'');
  // Every writable user/cache/config location belongs to this exact attempt.
  // PATH resolves the real installed muxer, not the owned inventory directory.
  const env=buildPathCiEnvironment({systemRoot,installation,ownedRoot:context.ownedRoot,programFilesX86});
  const exits={};let commandNumber=0;
  const execute = async (label,executable,args,timeout=15000,allowFailure=false,verbatim=false) => {
    await ordinaryDirectory(context.ownedRoot);await ordinaryDirectory(dirs.logs);await ordinaryDirectory(dirs.fixtures);await ordinaryFile(executable);await ordinaryDirectory(programFilesX86);await verifyInventory();
    const result=spawnSync(executable,args,{cwd:context.ownedRoot,env,timeout,maxBuffer:8*1024*1024,windowsHide:true,windowsVerbatimArguments:verbatim,killSignal:'SIGKILL'});
    if(result.error||result.signal||result.status!==0) console.log(JSON.stringify({status:'subprocess-not-passed',...safeSubprocessFailure(label,result)}));
    const prefix=String(++commandNumber).padStart(2,'0')+'-'+label;
    await writeOwned(path.win32.join(dirs.logs,prefix+'.stdout.log'),result.stdout||Buffer.alloc(0));
    await writeOwned(path.win32.join(dirs.logs,prefix+'.stderr.log'),result.stderr||Buffer.alloc(0));
    exits[label]=Number.isInteger(result.status)?result.status:null;
    if(result.error||result.signal||(!allowFailure&&result.status!==0)) fail('CI_SUBPROCESS_FAILED');
    return result;
  };
  const text = buffer => new TextDecoder('utf-8',{fatal:true}).decode(buffer).trim();
  const actualHead=text((await execute('git-head',git,['-C',context.workspace,'rev-parse','HEAD'])).stdout);
  const actualRoot=text((await execute('git-root',git,['-C',context.workspace,'rev-parse','--show-toplevel'])).stdout);
  if(actualHead!==context.commit||!equalPath(actualRoot,context.workspace)) fail('CI_SOURCE_MISMATCH');
  const fromWorkspace=file=>path.win32.join(context.workspace,...file.split('/'));
  const trackedOutput=(await execute('source-inventory',git,['-C',context.workspace,'ls-tree','-r','-z','--name-only',context.commit,'--',...BUILD_ROOTS,'workers/fission/Directory.Build.props','workers/fission/tools/csc-shim/csc.bat'])).stdout;
  const trackedText=new TextDecoder('utf-8',{fatal:true}).decode(trackedOutput);
  if(!trackedText.endsWith('\0'))fail('CI_SOURCE_MISMATCH');
  const trackedPaths=trackedText.slice(0,-1).split('\0');
  // Enumerate the actual default-Compile tree, not just the two advertised
  // test files. Symlink directories/files and untracked build inputs refuse.
  const inventoryDisk = async () => {
    const files=[];
    const walk=async relative=>{
      const directory=fromWorkspace(relative);await ordinaryDirectory(directory);
      for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
        const child=relative+'/'+entry.name,filename=fromWorkspace(child),stat=await fs.lstat(filename);
        if(stat.isSymbolicLink())fail('CI_SOURCE_MISMATCH');
        if(stat.isDirectory())await walk(child);
        else if(/\.(?:cs|csproj|props|targets|rsp)$/i.test(entry.name)){await ordinaryFile(filename);files.push(child);}
      }
    };
    for(const root of BUILD_ROOTS)await walk(root);
    for(const file of ['workers/fission/Directory.Build.props','workers/fission/tools/csc-shim/csc.bat']) {await ordinaryFile(fromWorkspace(file));files.push(file);}
    // An ambient ancestor targets/props/response file could expand the graph
    // without touching a csproj. Reject it, including case aliases, before restore.
    const ancestors=new Set(['']);
    for(const root of BUILD_ROOTS) {const parts=root.split('/');for(let i=1;i<parts.length;i++)ancestors.add(parts.slice(0,i).join('/'));}
    for(const relative of ancestors) {
      const directory=relative?fromWorkspace(relative):context.workspace;await ordinaryDirectory(directory);
      for(const name of await fs.readdir(directory))if(/\.(?:props|targets|rsp)$/i.test(name)) {
        const file=(relative?relative+'/':'')+name;
        if(file!=='workers/fission/Directory.Build.props')fail('CI_SOURCE_MISMATCH');
        await ordinaryFile(fromWorkspace(file));
      }
    }
    return files.sort();
  };
  const canonicalByPath=new Map();
  for(const file of trackedPaths) {
    // No arbitrary git path/revision is accepted from disk inventory.
    if(!Object.hasOwn(BUILD_PINS,file)&&!BUILD_ROOTS.some(root=>file.startsWith(root+'/')&&file.endsWith('.cs')))fail('CI_SOURCE_MISMATCH');
    canonicalByPath.set(file,(await execute('source-blob',git,['-C',context.workspace,'show',context.commit+':'+file])).stdout);
  }
  const readClosure=async()=>{
    const snapshots=[];
    for(const file of await inventoryDisk())snapshots.push({path:file,raw:await fs.readFile(fromWorkspace(file)),canonical:canonicalByPath.get(file),linkCount:(await fs.lstat(fromWorkspace(file))).nlink});
    return validateBuildInputClosure({trackedPaths,snapshots});
  };
  const sources=await readClosure();
  // Bind the CI producer itself to this same candidate, rather than reusing a
  // prior receipt's runner/script as evidence for new controlled IO coverage.
  const producerFiles=['scripts/fission-path-ci.mjs','scripts/fission-path-ci.test.mjs','.github/workflows/fission-path-policy.yml','.github/workflows/phase1.yml'];
  const producers=[];
  for(const file of producerFiles) {
    const canonical=(await execute('producer-blob',git,['-C',context.workspace,'show',context.commit+':'+file])).stdout;
    await ordinaryFile(fromWorkspace(file));const raw=await fs.readFile(fromWorkspace(file));
    if(canonicalText(raw)!==canonicalText(canonical))fail('CI_SOURCE_MISMATCH');
    producers.push({path:file,gitBlobSha256:hash(canonical),rawSha256:hash(raw)});
  }
  const sdk=text((await execute('sdk-version',dotnet,['--version'])).stdout);
  if(sdk!=='10.0.403') fail('CI_SDK_UNAVAILABLE');
  const compilerVersion=parseCompilerVersion(new TextDecoder('utf-8',{fatal:true}).decode((await execute('compiler-version',dotnet,['exec',path.win32.join(sdkLink,'Roslyn','bincore','csc.dll'),'/version'])).stdout));
  const shim=path.win32.join(context.workspace,'workers','fission','tools','csc-shim','csc.bat');
  const shimVersion=parseCompilerVersion(new TextDecoder('utf-8',{fatal:true}).decode((await execute('original-shim-version',command,['/d','/s','/c','""'+shim+'" /version"'],15000,false,true)).stdout));
  if(shimVersion!==compilerVersion) fail('CI_COMPILER_SELECTION_MISMATCH');
  const runtimeLines=text((await execute('runtime-versions',dotnet,['--list-runtimes'])).stdout).split(/\r?\n/);
  const runtimes=runtimeLines.map(line=>{
    const match=/^(Microsoft\.(?:NETCore|AspNetCore|WindowsDesktop)\.App) ([0-9]+\.[0-9]+\.[0-9]+) \[([^\]]+)\]$/.exec(line);
    if(!match||!equalPath(match[3],path.win32.join(installation,'shared',match[1]))) fail('CI_RUNTIME_UNAVAILABLE');
    return {name:match[1],version:match[2]};
  });
  if(!runtimes.some(r=>r.name==='Microsoft.NETCore.App'&&r.version.startsWith('10.0.'))) fail('CI_RUNTIME_UNAVAILABLE');
  const hostSha256=hash(await fs.readFile(dotnet));
  const toolSummary={commit:context.commit,node:process.versions.node,sdk,compilerVersion,compilerSha256,hostSha256,runtimes,sources,producers};
  console.log(JSON.stringify({status:'tool-and-source-selection-verified',...toolSummary}));
  await execute(commandPlan.restore.stage,dotnet,commandPlan.restore.args,180000);
  // The owned artifacts root must contain the original graph's resolved assets,
  // not extra projects/private dependencies. Original csproj hashes above pin
  // all direct PackageReference/ProjectReference declarations before any restore.
  const assets=path.win32.join(dirs.artifacts,'obj','Fission.UnitTests','project.assets.json');await ordinaryFile(assets);
  const assetsBytes=await fs.readFile(assets),assetsJson=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(assetsBytes));
  const packages=verifyPublicPackageClosure(Object.entries(assetsJson.libraries).filter(([,value])=>value.type==='package').map(([name])=>name));
  const assetProjects=Object.entries(assetsJson.libraries).filter(([,value])=>value.type==='project').map(([name])=>name.split('/')[0]).sort();
  if(JSON.stringify(assetProjects)!==JSON.stringify(['Fission.Core','Fission.Providers','Fission.Steps']))fail('CI_SOURCE_MISMATCH');
  await readClosure();
  const suites={};
  for(const suite of commandPlan.suites) {
    // Each directory was freshly created empty; there is no shared/stale TRX.
    await ordinaryDirectory(suite.resultsDirectory);
    if((await fs.readdir(suite.resultsDirectory)).length!==0)fail('CI_TRX_INVALID');
    const result=await execute(suite.stage,dotnet,suite.args,240000,true);
    await verifyInventory();await ordinaryDirectory(suite.resultsDirectory);
    const resultFiles=await fs.readdir(suite.resultsDirectory);
    if(resultFiles.length!==1||resultFiles[0]!==suite.trxName)fail('CI_TRX_INVALID');
    const trxFile=path.win32.join(suite.resultsDirectory,suite.trxName);await ordinaryFile(trxFile);
    const trx=await fs.readFile(trxFile),trxSha256=hash(trx);
    console.log(JSON.stringify({status:'test-process-finished',suite:suite.key,exitCode:result.status,trxSha256}));
    let verified;try {verified=(suite.key==='pathPolicy'?verifyPathPolicyTrx:verifyEngineJobFilesTrx)(new TextDecoder('utf-8',{fatal:true}).decode(trx));} catch {fail('CI_TRX_INVALID');}
    if(result.status!==0)fail('CI_TESTS_NOT_PASSED');
    suites[suite.key]=Object.freeze({className:suite.className,...verified,trxSha256,exitCode:result.status});
  }
  const finalHead=text((await execute('git-final-head',git,['-C',context.workspace,'rev-parse','HEAD'])).stdout);
  if(finalHead!==context.commit||JSON.stringify(await readClosure())!==JSON.stringify(sources))fail('CI_SOURCE_MISMATCH');
  for(const producer of producers){await ordinaryFile(fromWorkspace(producer.path));if(hash(await fs.readFile(fromWorkspace(producer.path)))!==producer.rawSha256)fail('CI_SOURCE_MISMATCH');}
  await verifyInventory();await ordinaryFile(dotnet);
  if(hash(await fs.readFile(dotnet))!==hostSha256)fail('CI_COMPILER_SELECTION_MISMATCH');
  const summary=Object.freeze({status:'passed-path-and-controlled-file-io-fake-codec-only',scope:'purepath+controlled-fileIO-Fakecodec-only-not-media-host-or-pilot',...toolSummary,packages,assetsSha256:hash(assetsBytes),suites:Object.freeze(suites),exitCodes:exits});
  console.log(JSON.stringify(summary));return summary;
}

// Comparing file URLs is pure: importing never probes the filesystem or runs
// commands. Only the explicitly invoked CLI enters the guarded runtime.
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  runPathPolicyCi().catch(error=>{
    const category=error instanceof Error&&/^(?:CONTEXT_INVALID|CI_(?:PLATFORM_UNAVAILABLE|NODE_UNAVAILABLE|PATH_UNSAFE|SYSTEM_UNAVAILABLE|ENVIRONMENT_INVALID|SDK_UNAVAILABLE|COMPILER_SELECTION_MISMATCH|SUBPROCESS_FAILED|SOURCE_MISMATCH|RUNTIME_UNAVAILABLE|TRX_INVALID|TESTS_NOT_PASSED))$/.test(error.message)?error.message:'CI_CAPABILITY_UNAVAILABLE';
    console.error(JSON.stringify({status:'not-passed',category}));process.exitCode=1;
  });
}
