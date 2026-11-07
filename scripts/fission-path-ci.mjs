import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CLASS = 'Fission.UnitTests.EnginePathPolicyTests';
const SYMBOLIC_NAMES = [
  `${CLASS}.Create_LinkedWritableOrReadOnlyRoot_Rejects(symbolic: True)`,
  `${CLASS}.ValidateWritablePath_RealWindowsJunctionOrSymlinkAncestor_RejectsBeforeAnyCreation(symbolic: True)`,
];
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

export function verifyPathPolicyTrx(xml) {
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
    for(const key of ['total','executed','passed']) requireTrx(counters[key]==='43');
    for(const key of zero) requireTrx(counters[key]==='0');
    requireTrx(results.length===43&&definitions.length===43&&entries.length===43);
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
    for(const name of SYMBOLIC_NAMES) requireTrx(seenNames.has(name));
    return Object.freeze({total:43,executed:43,passed:43,failed:0,skipped:0,inconclusive:0,testNames:Object.freeze([...seenNames].sort())});
  } catch { invalidTrx(); }
}

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

// Fixed-size diagnostic facts only: no result object/string/error is reflected.
// This helper cannot grant success; execute() still applies the original gate.
export function safeSubprocessFailure(stage,result) {
  const stages=new Set(['git-head','git-root','source-0','source-1','build-input-2','build-input-3','build-input-4','build-input-5','build-input-6','sdk-version','compiler-version','original-shim-version','runtime-versions','restore','path-policy-tests','git-final-head']);
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
  const {createHash}=await import('node:crypto');
  const hash = data => createHash('sha256').update(data).digest('hex');
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
  for(const name of ['home','user','appdata','localappdata','programdata','temp','nuget','packages','clihome','results','logs','fixtures','toolinventory']) {dirs[name]=path.win32.join(context.ownedRoot,name);await createDirectory(dirs[name]);}
  if(dirs.fixtures!==context.fixtureRoot) fail('CI_PATH_UNSAFE');
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
  const normalize = buffer => new TextDecoder('utf-8',{fatal:true}).decode(buffer).replaceAll('\r\n','\n');
  const actualHead=text((await execute('git-head',git,['-C',context.workspace,'rev-parse','HEAD'])).stdout);
  const actualRoot=text((await execute('git-root',git,['-C',context.workspace,'rev-parse','--show-toplevel'])).stdout);
  if(actualHead!==context.commit||!equalPath(actualRoot,context.workspace)) fail('CI_SOURCE_MISMATCH');
  const frozen=[['workers/fission/src/Fission.Core/Engine/EnginePathPolicy.cs','d8a49daab3d30260f2de29a4fb266bfd37fff501681aac55e232bf54b90107ac'],['workers/fission/tests/Fission.UnitTests/EnginePathPolicyTests.cs','89dbaf2d6b71c0d4dad1077715f8393872b23838117d92ffa68caf46bf50cef5']];
  const sources=[];
  for(const [file,expected] of frozen) {
    const canonical=(await execute('source-'+sources.length,git,['-C',context.workspace,'show',context.commit+':'+file])).stdout;
    const filename=path.win32.join(context.workspace,...file.split('/'));await ordinaryFile(filename);const raw=await fs.readFile(filename);
    if(hash(canonical)!==expected||normalize(raw)!==normalize(canonical)) fail('CI_SOURCE_MISMATCH');
    sources.push({path:file,gitBlobSha256:expected,rawSha256:hash(raw)});
  }
  // These original build inputs must also be exactly their checked-out commit,
  // not an environment override or a patched compiler/property/test project.
  for(const file of ['workers/fission/tools/csc-shim/csc.bat','workers/fission/Directory.Build.props','workers/fission/tests/Fission.UnitTests/Fission.UnitTests.csproj','workers/fission/src/Fission.Core/Fission.Core.csproj','workers/fission/src/Fission.Steps/Fission.Steps.csproj']) {
    const canonical=(await execute('build-input-'+sources.length,git,['-C',context.workspace,'show',context.commit+':'+file])).stdout;
    const filename=path.win32.join(context.workspace,...file.split('/'));await ordinaryFile(filename);const raw=await fs.readFile(filename);
    if(normalize(raw)!==normalize(canonical)) fail('CI_SOURCE_MISMATCH');sources.push({path:file,gitBlobSha256:hash(canonical),rawSha256:hash(raw)});
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
  const toolSummary={commit:context.commit,node:process.versions.node,sdk,compilerVersion,compilerSha256,runtimes,sources};
  console.log(JSON.stringify({status:'tool-selection-verified',...toolSummary}));
  const project=path.win32.join(context.workspace,'workers','fission','tests','Fission.UnitTests','Fission.UnitTests.csproj');
  await execute('restore',dotnet,['restore',project,'--configfile',publicConfig,'--packages',dirs.packages,'--disable-parallel','--verbosity','quiet'],180000);
  const testResult=await execute('path-policy-tests',dotnet,['test',project,'--no-restore','--filter','FullyQualifiedName~EnginePathPolicyTests','--logger','trx;LogFileName=path-policy.trx','--results-directory',dirs.results,'--verbosity','quiet','--disable-build-servers'],300000,true);
  await verifyInventory();await ordinaryDirectory(dirs.results);
  const resultFiles=(await fs.readdir(dirs.results)).filter(file=>file.toLowerCase().endsWith('.trx'));
  if(resultFiles.length!==1||resultFiles[0]!=='path-policy.trx') fail('CI_TRX_INVALID');
  const trxFile=path.win32.join(dirs.results,'path-policy.trx');await ordinaryFile(trxFile);
  const trx=await fs.readFile(trxFile),trxSha256=hash(trx);
  console.log(JSON.stringify({status:'test-process-finished',exitCode:testResult.status,trxSha256}));
  let verified;try {verified=verifyPathPolicyTrx(new TextDecoder('utf-8',{fatal:true}).decode(trx));} catch {fail('CI_TRX_INVALID');}
  if(testResult.status!==0) fail('CI_TESTS_NOT_PASSED');
  const finalHead=text((await execute('git-final-head',git,['-C',context.workspace,'rev-parse','HEAD'])).stdout);
  if(finalHead!==context.commit) fail('CI_SOURCE_MISMATCH');
  // Recheck source bytes after compilation; outputs may be only original
  // project bin/obj or this attempt's owned directories.
  for(const source of sources) {const file=path.win32.join(context.workspace,...source.path.split('/'));await ordinaryFile(file);if(hash(await fs.readFile(file))!==source.rawSha256) fail('CI_SOURCE_MISMATCH');}
  const summary=Object.freeze({status:'passed-pure-path-subset-only',...toolSummary,...verified,trxSha256,exitCodes:exits});
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
