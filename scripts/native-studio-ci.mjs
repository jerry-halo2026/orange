import path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { validatePathCiContext } from './fission-path-ci.mjs';
import { verifyTap } from './phase1-admission.mjs';

// Fixed reviewed inputs, not caller-selected policy. These are Git blob digests;
// raw checkout bytes may differ only by CRLF versus LF, never encoding or content.
const PINS = Object.freeze({
 'packages/openfilm/src/development-isolation.mjs':'847db36ff9f20fd2ca628837809a02f787d7150c66efb5da6d91044e43d9ffd8',
 'scripts/fission-path-ci.mjs':'913d98152b45df0fac17cbad91280017faee4fe6880249d09758432e6816e4cc',
 'scripts/phase1-admission.mjs':'a56649bc301c6402d942dd094ae6cf9abe6399fc02decc5474d9b5db6c7731cd',
 'packages/openfilm/package.json':'374451a588d0975f4e8f31c4c9c3cfd41f77aed15d98e315154a7052c7dc3399',
 'pnpm-lock.yaml':'6e337f4e41abff52b05380b48517f1e479a2b96cae0a653d837b5ff6d1bd3c55',
 'scripts/phase1-isolation.test.mjs':'c6ef87ad5be39b6ea52ecbca5ebfdf47296249d20a8ae9c3b2788fa6925dba07',
 'packages/openfilm/src/development-isolation.test.mjs':'806b22cfce97f5585d00996b45cd6e3daec119970073e513d86d3eb4c14aea89',
 'packages/openfilm/studio/server/project-control-guard.mjs':'ae64f900ee1895d3a6d39b92bed3e279ef20e98c0576f8bcef4862063444525c',
 'packages/openfilm/studio/server/projects.mjs':'b6167184e681fd959212eb8f927e8557feb5ef7b3730961c8bd8939d7ba3700d',
 'packages/openfilm/studio/server/auto-versions.mjs':'3c064ac4a66d9495a0cfc8da333d1432839d4a19bb49e2477218251b29dd4cad',
 'packages/openfilm/studio/server/server.mjs':'f05013ddaeb0c7ff08f49999e99f179ec4de126b39544bddd8298417d9e26d8e',
 'packages/openfilm/studio/server/project-control-guard.test.mjs':'cb77f17415bba41f4fc8b990ed37d9dd722511b8d20468c965fe7eeb1b6a6f62',
 'packages/openfilm/studio/server/projects-control.test.mjs':'f1dcbbc8d7ebb467ee4810d1035eeb002b140caf2cf41dd102f52bd730a5a388',
 'packages/openfilm/studio/server/auto-versions.test.mjs':'c9f73d5bed69f1bbc2831be50d8910b650e26f4effe4df0c22a07af79c2d76fa',
 'packages/openfilm/studio/server/server-auto-versions.test.mjs':'93f69303a3cc37f6a0ca75a25aebdb6e279b973b645c32bdaef878ffda9c07dc',
});
const SELF = Object.freeze(['.github/workflows/native-studio.yml','scripts/native-studio-ci.mjs','scripts/native-studio-ci.test.mjs','packages/openfilm/studio/server/project-file-symlink.test.mjs']);
const TESTS = Object.freeze(['packages/openfilm/studio/server/project-control-guard.test.mjs','packages/openfilm/studio/server/projects-control.test.mjs','packages/openfilm/studio/server/auto-versions.test.mjs','packages/openfilm/studio/server/server-auto-versions.test.mjs',SELF[3]]);
const MANDATORY = 'real Windows file-symbolic marker refuses before native callback';
const PACKAGE_URL = 'https://registry.npmjs.org/playwright-core/-/playwright-core-1.61.1.tgz';
const PACKAGE_SHA512 = 'h7Qlt6m4REp25qvIdvbDtVmD4LqVXfpRxhORv9L0jzETM05p4fuPJ3dKyuSXQxDSbXnmS79HAgi9589lGSpLkg==';
const MAX_ARCHIVE = 20 * 1024 * 1024, MAX_UNPACKED = 32 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Diagnostics use identity only: never inspect thrown objects, even to redact.
const FAILURE_CODES = new Set(["ARCHIVE_ANCESTOR","ARCHIVE_CHECKSUM","ARCHIVE_COMPRESSION","ARCHIVE_COUNT","ARCHIVE_DUPLICATE","ARCHIVE_EXTRACT","ARCHIVE_FIELD","ARCHIVE_FORMAT","ARCHIVE_LINK","ARCHIVE_LIST","ARCHIVE_NUMBER","ARCHIVE_PATH","ARCHIVE_SIZE","ARCHIVE_TERMINATOR","ARCHIVE_TRAILING","ARCHIVE_TYPE","CONTEXT_INVALID","GIT_DIRTY","GIT_HIDDEN","GIT_INVALID","HEAD_CHANGED","NODE_VERSION","PACKAGE_DEPENDENCIES","PACKAGE_DIGEST","PACKAGE_EXISTS","PACKAGE_FETCH","PACKAGE_LICENSE","PACKAGE_METADATA","PACKAGE_NOTICE","PACKAGE_PIN","PACKAGE_SIZE","PACKAGE_TREE","PATH_ALIAS","PATH_CASE","PATH_EXISTS","PATH_INVALID","PATH_MISSING","PATH_TYPE","PLATFORM_INVALID","PORT_NOT_FREE","SOURCE_CHANGED","SOURCE_ENCODING","SOURCE_PIN","SOURCE_SET","SOURCE_TREE","SOURCE_TYPE","STAGE_NOT_EMPTY","TAP_COUNT","TAP_INVALID","TAP_NAME","TAP_STRUCTURE","TAP_SUMMARY","TEST_PROCESS","TOOL_CAPABILITY","TOOL_CHANGED","TOOL_HASH","TOOL_PATH","TOOL_TYPE","UNEXPECTED"]);
const FAILURE_PHASES = new Set(["context","platform-node","workspace","node-path","systemroot","system32","tar","git","owned-directory","source-snapshot","package-pins","fixture-directory","fetch","archive","tests","post-check","result","unknown"]);
const ownedFailureCodes = new WeakMap();
const diagnosticFailures = new WeakMap();
function ownedFailure(code) {
 const safe=FAILURE_CODES.has(code)?code:'UNEXPECTED';
 const error=new Error(safe);ownedFailureCodes.set(error,safe);return error;
}
export function formatNativeStudioFailure(phase,error) {
 const registered=diagnosticFailures.get(error);
 if(registered)return registered;
 return Object.freeze({status:'failed',phase:FAILURE_PHASES.has(phase)?phase:'unknown',code:ownedFailureCodes.get(error)??'UNEXPECTED'});
}
export function createNativeStudioDiagnostics() {
 let phase='unknown',first=null;
 return Object.freeze({
  enter(next){phase=FAILURE_PHASES.has(next)?next:'unknown';},
  capture(error){if(first===null)first=formatNativeStudioFailure(phase,error);return first;},
  summary(){return first;},
 });
}
function diagnosticFailure(summary) {
 const error=new Error('NATIVE_STUDIO_CI_FAILED');diagnosticFailures.set(error,summary);return error;
}
function need(condition, code) { if (!condition) throw ownedFailure(code); }
function utf8(bytes) {
 need(bytes instanceof Uint8Array && bytes.length <= 8 * 1024 * 1024,'SOURCE_ENCODING');
 need(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),'SOURCE_ENCODING');
 let text; try { text = new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { throw ownedFailure('SOURCE_ENCODING'); }
 need(!text.includes('\uFEFF') && !/\r(?!\n)/.test(text),'SOURCE_ENCODING');
 return text;
}
function relative(value) {
 need(typeof value === 'string' && value.length > 0 && value.length < 240 && !/[\\:\x00-\x1f\x7f<>"|?*~]/.test(value),'PATH_INVALID');
 for (const part of value.split('/')) need(part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),'PATH_INVALID');
 return value;
}
function windows(value) {
 need(typeof value === 'string' && /^[A-Za-z]:\\/.test(value) && value.length < 240,'PATH_INVALID');
 relative(value.slice(3).replaceAll('\\','/')); return value;
}
export function validateNativeStudioContext(facts) {
 try {
  const base = validatePathCiContext(facts);
  need(['push','workflow_dispatch'].includes(facts.GITHUB_EVENT_NAME),'CONTEXT_INVALID');
  windows(base.workspace);
  const ownedRoot = path.win32.join(base.workspace,'.dev','native-studio-ci',facts.GITHUB_RUN_ID,facts.GITHUB_RUN_ATTEMPT);
  windows(ownedRoot); windows(path.win32.join(ownedRoot,'stage','package'));
  return Object.freeze({workspace:base.workspace,commit:base.commit,ownedRoot});
 } catch { throw ownedFailure('CONTEXT_INVALID'); }
}
export function verifyNativeStudioTap(tap,exitCode) {
 need(arguments.length === 2 && typeof tap === 'string' && tap.length <= 8 * 1024 * 1024,'TAP_INVALID');
 tap = tap.replaceAll('\r\n','\n');
 let names;try {names=verifyTap(tap,exitCode,[MANDATORY]);}catch {throw ownedFailure('TAP_INVALID');}
 need(names.length === 66 && new Set(names).size === 66,'TAP_COUNT');
 need(names.every(n => /^[\x20-\x7e]{1,400}$/.test(n)),'TAP_NAME');
 for (const [key,value] of Object.entries({tests:66,suites:0,pass:66,fail:0,cancelled:0,skipped:0,todo:0})) {
  const lines = tap.split('\n').filter(line => line.startsWith('# '+key+' '));
  need(lines.length === 1 && lines[0] === '# '+key+' '+value,'TAP_SUMMARY');
 }
 for (const line of tap.split('\n')) {
  need(!/^\s*Bail out!/i.test(line),'TAP_STRUCTURE');
  if (/^\s*(?:not )?ok(?:\s|$)/.test(line)) need(/^ok [1-9][0-9]* - [^\r\n]+$/.test(line),'TAP_STRUCTURE');
 }
 return Object.freeze({total:66,passed:66,failed:0,skipped:0,cancelled:0,todo:0,testNames:Object.freeze(names)});
}
export function validateNativeStudioSources(records) {
 need(arguments.length === 1 && Array.isArray(records) && records.length === Object.keys(PINS).length + SELF.length,'SOURCE_SET');
 const seen = new Set(), summary = [];
 for (const record of records) {
  need(record && (Object.hasOwn(PINS,record.path) || SELF.includes(record.path)) && !seen.has(record.path),'SOURCE_SET'); seen.add(record.path);
  need(record.mode === '100644' && record.ordinary === true && record.nlink === 1,'SOURCE_TYPE');
  const raw = utf8(record.raw), blob = utf8(record.blob);
  need(raw.replaceAll('\r\n','\n') === blob.replaceAll('\r\n','\n'),'SOURCE_CHANGED');
  const gitBlobSha256 = hash(record.blob);
  if (Object.hasOwn(PINS,record.path)) need(gitBlobSha256 === PINS[record.path],'SOURCE_PIN');
  summary.push({path:record.path,sha256:hash(record.raw),gitBlobSha256});
 }
 return summary.sort((a,b) => a.path.localeCompare(b.path));
}
export function validatePlaywrightArchiveEntries(entries) {
 need(arguments.length === 1 && Array.isArray(entries) && entries.length > 0 && entries.length <= 512,'ARCHIVE_COUNT');
 const seen = new Map(); let total = 0;
 for (const e of entries) {
  need(e && ['file','directory'].includes(e.type) && Number.isSafeInteger(e.size) && e.size >= 0,'ARCHIVE_TYPE');
  need(e.type !== 'directory' || e.size === 0,'ARCHIVE_SIZE');
  need(typeof e.name === 'string' && (e.name === 'package/' || e.name.startsWith('package/')),'ARCHIVE_PATH');
  const name = e.type === 'directory' && e.name.endsWith('/') ? e.name.slice(0,-1) : e.name;
  relative(name); need(name === 'package' ? e.type === 'directory' : name.startsWith('package/'),'ARCHIVE_PATH');
  need(!seen.has(name.toLowerCase()),'ARCHIVE_DUPLICATE'); seen.set(name.toLowerCase(),{name,type:e.type});
  total += e.size; need(Number.isSafeInteger(total) && total <= MAX_UNPACKED,'ARCHIVE_SIZE');
 }
 for (const {name} of seen.values()) {
  const parts = name.split('/');
  for (let i=1;i<parts.length;i++) {const parent = seen.get(parts.slice(0,i).join('/').toLowerCase()); need(!parent || (parent.type === 'directory' && parent.name === parts.slice(0,i).join('/')),'ARCHIVE_ANCESTOR');}
 }
 // Two different implicit directory spellings are also aliases on Windows.
 const spellings = new Map();
 for (const {name} of seen.values()) for(let i=1;i<=name.split('/').length;i++) {const p=name.split('/').slice(0,i).join('/'), key=p.toLowerCase();need(!spellings.has(key)||spellings.get(key)===p,'ARCHIVE_DUPLICATE');spellings.set(key,p);}
 return entries;
}
export function parsePlaywrightArchive(compressed) {
 need(compressed instanceof Uint8Array && compressed.length > 0 && compressed.length <= MAX_ARCHIVE,'ARCHIVE_SIZE');
 let tar; try { tar = gunzipSync(compressed,{maxOutputLength:MAX_UNPACKED}); } catch { throw ownedFailure('ARCHIVE_COMPRESSION'); }
 need(tar.length >= 1024 && tar.length % 512 === 0,'ARCHIVE_FORMAT');
 const entries = []; let offset = 0, ended = false;
 function field(header,start,length) {
  const b=header.subarray(start,start+length), zero=b.indexOf(0), end=zero<0?b.length:zero;
  need(zero<0 || b.subarray(zero).every(x=>x===0),'ARCHIVE_FIELD'); return utf8(b.subarray(0,end));
 }
 function octal(header,start,length) {
  const b=header.subarray(start,start+length); need([...b].every(x=>x===0||x===32||(x>=48&&x<=55)),'ARCHIVE_NUMBER');
  const text=Buffer.from(b).toString('ascii').replace(/[\0 ]+$/,'').replace(/^ +/,''); need(/^[0-7]+$/.test(text),'ARCHIVE_NUMBER');
  const n=Number.parseInt(text,8); need(Number.isSafeInteger(n) && n>=0,'ARCHIVE_NUMBER'); return n;
 }
 while (offset < tar.length) {
  const h=tar.subarray(offset,offset+512);
  if (h.every(x=>x===0)) {
   need(offset+1024<=tar.length && tar.subarray(offset).every(x=>x===0),'ARCHIVE_TRAILING'); ended=true; break;
  }
  const checksum=octal(h,148,8); let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:h[i];need(sum===checksum,'ARCHIVE_CHECKSUM');
  need(h.subarray(257,263).equals(Buffer.from('ustar\0')) && h.subarray(263,265).equals(Buffer.from('00')),'ARCHIVE_FORMAT');
  need(h.subarray(157,257).every(x=>x===0) && h.subarray(500).every(x=>x===0),'ARCHIVE_LINK');
  const kind=h[156];need(kind===0||kind===48||kind===53,'ARCHIVE_TYPE');
  const prefix=field(h,345,155), name=field(h,0,100);need(name.length>0,'ARCHIVE_PATH');
  const size=octal(h,124,12); const next=offset+512+Math.ceil(size/512)*512;
  need(Number.isSafeInteger(next) && size<=MAX_UNPACKED && next<=tar.length,'ARCHIVE_SIZE');
  entries.push({name:(prefix?prefix+'/':'')+name,type:kind===53?'directory':'file',size});
  need(entries.length<=512,'ARCHIVE_COUNT');
  offset=next;
 }
 need(ended,'ARCHIVE_TERMINATOR'); return validatePlaywrightArchiveEntries(entries);
}
export function validatePlaywrightMetadata(pkg,license,notice) {
 need(pkg && Object.getPrototypeOf(pkg)===Object.prototype && pkg.name==='playwright-core' && pkg.version==='1.61.1' && pkg.license==='Apache-2.0','PACKAGE_METADATA');
 for(const key of ['scripts','dependencies','optionalDependencies','peerDependencies','bundledDependencies','bundleDependencies','devDependencies']) need(!Object.hasOwn(pkg,key),'PACKAGE_DEPENDENCIES');
 const l=utf8(license), n=utf8(notice);
 need(l.includes('Apache License') && l.includes('Version 2.0, January 2004') && l.includes('http://www.apache.org/licenses/'),'PACKAGE_LICENSE');
 need(n.trim().length>0 && /Microsoft Corporation/.test(n),'PACKAGE_NOTICE');
 return {name:'playwright-core',version:'1.61.1',license:'Apache-2.0',licenseSha256:hash(license),noticeSha256:hash(notice)};
}

// Runtime is intentionally inaccessible through configurable adapters or policy
// overrides. Importing this module only defines functions; only the direct CLI
// enters here, and context is the first operation before filesystem or processes.
// Trusted system tools and writable/source data have distinct link policies.
// This is deliberately not a caller-controlled allowHardlink switch.
export function validateSystemTarMetadata(record) {
 need(arguments.length===1 && record && record.ancestorsOrdinary===true,'TOOL_PATH');
 windows(record.systemRoot);
 const fixed=path.win32.join(record.systemRoot,'System32','tar.exe');
 need(record.executable===fixed && typeof record.realPath==='string' && record.realPath.toLowerCase()===fixed.toLowerCase(),'TOOL_PATH');
 need(record.isFile===true && record.isSymbolicLink===false && Number.isSafeInteger(record.nlink) && record.nlink>=1,'TOOL_TYPE');
 need(typeof record.sha256==='string' && /^[a-f0-9]{64}$/.test(record.sha256),'TOOL_HASH');
 return Object.freeze({executable:fixed,sha256:record.sha256});
}
const systemTarCapabilities = new WeakSet();
function systemTar(systemRoot) {
 ordinary(systemRoot,'directory');
 const parent=ordinary(path.win32.join(systemRoot,'System32'),'directory');
 need(readdirSync(parent).filter(name=>name.toLowerCase()==='tar.exe').join('')==='tar.exe','TOOL_PATH');
 const executable=path.win32.join(parent,'tar.exe'), stat=lstatSync(executable);
 // Reject links/types before reading bytes; only the fixed regular inbox file
 // may have multiple NTFS links (normal Windows component-store servicing).
 need(stat.isFile() && !stat.isSymbolicLink(),'TOOL_TYPE');
 const tool=validateSystemTarMetadata({systemRoot,executable,realPath:realpathSync.native(executable),ancestorsOrdinary:true,isFile:stat.isFile(),isSymbolicLink:stat.isSymbolicLink(),nlink:stat.nlink,sha256:hash(readFileSync(executable))});
 const capability=Object.freeze({...tool,systemRoot});systemTarCapabilities.add(capability);return capability;
}
function recheckSystemTar(capability) {
 need(systemTarCapabilities.has(capability),'TOOL_CAPABILITY');
 const current=systemTar(capability.systemRoot);
 need(current.executable===capability.executable && current.sha256===capability.sha256,'TOOL_CHANGED');
}

function ordinary(absolute,kind,missing=false) {
 windows(absolute);
 const drive=path.win32.parse(absolute).root, segments=absolute.slice(drive.length).split('\\');
 let at=drive;
 const root=lstatSync(at);need(root.isDirectory() && !root.isSymbolicLink(),'PATH_TYPE');
 for(let i=0;i<segments.length;i++) {
  const part=segments[i];
  const parent=lstatSync(at,{throwIfNoEntry:false});
  if (!parent) {need(missing,'PATH_MISSING');return absolute;}
  need(parent.isDirectory() && !parent.isSymbolicLink(),'PATH_TYPE');
  const matches=readdirSync(at).filter(name=>name.toLowerCase()===part.toLowerCase());
  need(matches.length<=1 && (!matches.length||matches[0]===part),'PATH_CASE');
  at=path.win32.join(at,part);
  const s=lstatSync(at,{throwIfNoEntry:false});
  if(!s){need(missing,'PATH_MISSING');return absolute;}
  need(!s.isSymbolicLink() && (s.isDirectory() || (i===segments.length-1 && s.isFile() && s.nlink===1)),'PATH_TYPE');
  need(realpathSync.native(at).toLowerCase()===at.toLowerCase(),'PATH_ALIAS');
 }
 const s=lstatSync(absolute);
 need(kind==='file'?s.isFile()&&s.nlink===1:s.isDirectory(),'PATH_TYPE'); return absolute;
}
function directory(absolute,fresh=false) {
 ordinary(absolute,'directory',true);
 if(fresh) need(!existsSync(absolute),'PATH_EXISTS');
 mkdirSync(absolute,{recursive:!fresh});return ordinary(absolute,'directory');
}
function privateFile(file,bytes) {ordinary(file,'file',true);need(!existsSync(file),'PATH_EXISTS');writeFileSync(file,bytes,{flag:'wx',mode:0o600});ordinary(file,'file');}
function child(executable,args,cwd,env,timeout=60_000) {
 const trustedTar=systemTarCapabilities.has(executable);
 if(trustedTar)recheckSystemTar(executable);else ordinary(executable,'file');
 const result=spawnSync(trustedTar?executable.executable:executable,args,{cwd,env,encoding:null,windowsHide:true,shell:false,timeout,maxBuffer:8*1024*1024});
 if(trustedTar)recheckSystemTar(executable);
 return result;
}
function successful(result,code) {need(!result.error && !result.signal && result.status===0,code);return result.stdout;}
function git(root,exe,env,args) {return successful(child(exe,['--no-optional-locks','-C',root,...args],root,env,15_000),'GIT_INVALID');}
function snapshot(context,gitExe,env) {
 const root=context.workspace;
 need(utf8(git(root,gitExe,env,['rev-parse','HEAD'])).trim()===context.commit,'HEAD_CHANGED');
 need(git(root,gitExe,env,['status','--porcelain=v1','--untracked-files=normal']).length===0,'GIT_DIRTY');
 const flags=utf8(git(root,gitExe,env,['ls-files','-v','-z'])).split('\0').filter(Boolean);
 need(flags.every(f=>f[0]==='H'),'GIT_HIDDEN');
 const paths=Object.keys(PINS).concat(SELF);
 const tree=utf8(git(root,gitExe,env,['ls-tree','-r','-z',context.commit,'--',...paths])).split('\0').filter(Boolean);
 const modes=new Map();
 for(const line of tree) {const match=/^([0-7]{6}) blob ([0-9a-f]{40})\t([^\0]+)$/.exec(line);need(match&&!modes.has(match[3]),'SOURCE_TREE');modes.set(match[3],match[1]);}
 return validateNativeStudioSources(paths.map(p=>{
  const file=ordinary(path.win32.join(root,...p.split('/')),'file'), stat=lstatSync(file);
  return {path:p,raw:readFileSync(file),blob:git(root,gitExe,env,['show',context.commit+':'+p]),mode:modes.get(p),ordinary:true,nlink:stat.nlink};
 }));
}
function assertSame(before,after) {need(JSON.stringify(before)===JSON.stringify(after),'SOURCE_CHANGED');}
function packagePins(root) {
 const pkg=JSON.parse(utf8(readFileSync(ordinary(path.win32.join(root,'packages','openfilm','package.json'),'file'))));
 need(pkg.dependencies?.['playwright-core']==='1.61.1','PACKAGE_PIN');
 const lock=utf8(readFileSync(ordinary(path.win32.join(root,'pnpm-lock.yaml'),'file'))).replaceAll('\r\n','\n');
 need(lock.includes('  packages/openfilm:\n    dependencies:\n      playwright-core:\n        specifier: 1.61.1\n        version: 1.61.1\n'),'PACKAGE_PIN');
 need(lock.includes('  playwright-core@1.61.1:\n    resolution: {integrity: sha512-'+PACKAGE_SHA512+'}'),'PACKAGE_PIN');
}
async function fetchPackage() {
 // One fixed public GET. No retries, redirects, cookies, authentication, or
 // package manager. Abort covers headers AND streaming the bounded response.
 const response=await fetch(PACKAGE_URL,{method:'GET',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(60_000),headers:{Accept:'application/octet-stream'}});
 need(response.ok && response.status===200 && response.url===PACKAGE_URL && response.body,'PACKAGE_FETCH');
 const declared=response.headers.get('content-length');
 need(declared===null || (/^[0-9]+$/.test(declared)&&Number.isSafeInteger(Number(declared))&&Number(declared)<=MAX_ARCHIVE),'PACKAGE_SIZE');
 const chunks=[];let length=0;
 try {for await(const chunk of response.body){length+=chunk.length;need(length<=MAX_ARCHIVE,'PACKAGE_SIZE');chunks.push(Buffer.from(chunk));}} catch {throw ownedFailure('PACKAGE_FETCH');}
 const bytes=Buffer.concat(chunks);need(bytes.length>0 && createHash('sha512').update(bytes).digest('base64')===PACKAGE_SHA512,'PACKAGE_DIGEST');return bytes;
}
function extractedTree(stage,entries) {
 const expected=new Map();
 for(const e of entries) {
  const name=e.name.replace(/\/$/,'');expected.set(name,{type:e.type,size:e.size});
  const parts=name.split('/');for(let i=1;i<parts.length;i++){const p=parts.slice(0,i).join('/');if(!expected.has(p))expected.set(p,{type:'directory',size:0});}
 }
 const seen=new Set(),files=[];
 function walk(dir,prefix='') {
  ordinary(dir,'directory');
  for(const name of readdirSync(dir)) {
   const rel=prefix?prefix+'/'+name:name;relative(rel);const want=expected.get(rel);need(want,'PACKAGE_TREE');
   const file=path.win32.join(dir,name);ordinary(file,want.type==='file'?'file':'directory');
   const stat=lstatSync(file);need(!seen.has(rel.toLowerCase()),'PACKAGE_TREE');seen.add(rel.toLowerCase());
   if(want.type==='file'){need(stat.size===want.size,'PACKAGE_TREE');files.push({path:rel,sha256:hash(readFileSync(file))});}else walk(file,rel);
  }
 }
 walk(stage);need(seen.size===expected.size,'PACKAGE_TREE');
 return files.sort((a,b)=>a.path.localeCompare(b.path));
}
function restorePackage(context,bytes,tarExe,env) {
 const entries=parsePlaywrightArchive(bytes);
 const archive=path.win32.join(context.ownedRoot,'archive','playwright-core-1.61.1.tgz');privateFile(archive,bytes);
 const listing=successful(child(tarExe,['-tf',archive],context.workspace,env),'ARCHIVE_LIST');
 const names=utf8(listing).replaceAll('\r\n','\n').split('\n');need(names.pop()==='','ARCHIVE_LIST');
 need(JSON.stringify(names)===JSON.stringify(entries.map(e=>e.name)),'ARCHIVE_LIST');
 need(createHash('sha512').update(readFileSync(ordinary(archive,'file'))).digest('base64')===PACKAGE_SHA512,'PACKAGE_DIGEST');
 const stage=path.win32.join(context.ownedRoot,'stage');
 need(readdirSync(stage).length===0,'STAGE_NOT_EMPTY');
 successful(child(tarExe,['-xf',archive,'-C',stage,'--no-same-owner','--no-same-permissions'],context.workspace,env),'ARCHIVE_EXTRACT');
 const files=extractedTree(stage,entries), packageRoot=ordinary(path.win32.join(stage,'package'),'directory');
 const pkgBytes=readFileSync(ordinary(path.win32.join(packageRoot,'package.json'),'file'));
 const metadata=validatePlaywrightMetadata(JSON.parse(utf8(pkgBytes)),readFileSync(ordinary(path.win32.join(packageRoot,'LICENSE'),'file')),readFileSync(ordinary(path.win32.join(packageRoot,'NOTICE'),'file')));
 const modules=directory(path.win32.join(context.workspace,'packages','openfilm','node_modules'));
 const target=path.win32.join(modules,'playwright-core');ordinary(target,'directory',true);need(!existsSync(target),'PACKAGE_EXISTS');
 renameSync(packageRoot,target);ordinary(target,'directory');
 // Atomic move must preserve the entire audited file closure.
 const finalFiles=extractedTree(modules,entries.map(e=>({...e,name:e.name.replace(/^package(?=\/|$)/,'playwright-core')})));
 assertSame(files.map(e=>({...e,path:e.path.replace(/^package(?=\/|$)/,'playwright-core')})),finalFiles);
 return {...metadata,archiveSha512:PACKAGE_SHA512,packageJsonSha256:hash(pkgBytes),fileCount:files.length,filesSha256:hash(JSON.stringify(files))};
}
async function assertPortsFree() {
 for(const port of [18475,18476]) for(const host of ['127.0.0.1','::1']) {
  const free=await new Promise(resolve=>{
   const socket=connect({host,port});let done=false;
   const finish=value=>{if(!done){done=true;socket.destroy();resolve(value);}};
   socket.setTimeout(1500,()=>finish(false));socket.once('connect',()=>finish(false));socket.once('error',e=>finish(e.code==='ECONNREFUSED'));
  });need(free,'PORT_NOT_FREE');
 }
 return [{port:18475,listening:false},{port:18476,listening:false}];
}
// Assessment is pure and does not propagate before the original process
// receipt can be persisted. The driver still treats every failed assessment
// as failure after post-check; no caller can replace any real CI step.
export function assessNativeStudioProcess(result) {
 try {
  need(!result.error && !result.signal,'TEST_PROCESS');
  return Object.freeze({ok:true,counts:verifyNativeStudioTap(utf8(result.stdout),result.status)});
 } catch(failure) {
  return Object.freeze({ok:false,failure});
 }
}
export async function runNativeStudioCI() {
 const diagnostics=createNativeStudioDiagnostics();
 try {
 diagnostics.enter('context');
 const context=validateNativeStudioContext(process.env); // MUST precede all IO/process/network.
 diagnostics.enter('platform-node');
 need(process.platform==='win32','PLATFORM_INVALID');
 const [major,minor]=process.versions.node.split('.').map(Number);need(major>22||(major===22&&minor>=18),'NODE_VERSION');
 diagnostics.enter('workspace');ordinary(context.workspace,'directory');
 diagnostics.enter('node-path');ordinary(process.execPath,'file');
 diagnostics.enter('systemroot');
 const systemRoot=windows(process.env.SystemRoot);ordinary(systemRoot,'directory');
 diagnostics.enter('system32');
 const system32=ordinary(path.win32.join(systemRoot,'System32'),'directory');
 diagnostics.enter('tar');
 const tarExe=systemTar(systemRoot);
 diagnostics.enter('git');
 const gitExe=ordinary(path.win32.join(path.win32.parse(systemRoot).root,'Program Files','Git','cmd','git.exe'),'file');
 diagnostics.enter('owned-directory');
 directory(path.win32.dirname(path.win32.dirname(context.ownedRoot)));
 directory(path.win32.dirname(context.ownedRoot));directory(context.ownedRoot,true);
 for(const name of ['home','appdata','localappdata','temp','cache','archive','stage','logs','results'])directory(path.win32.join(context.ownedRoot,name),true);
 const owned=name=>path.win32.join(context.ownedRoot,name);
 const emptyConfig=owned('empty.gitconfig');privateFile(emptyConfig,Buffer.alloc(0));
 const env={SystemRoot:systemRoot,WINDIR:systemRoot,ComSpec:path.win32.join(system32,'cmd.exe'),PATH:system32+';'+path.win32.dirname(gitExe),HOME:owned('home'),USERPROFILE:owned('home'),APPDATA:owned('appdata'),LOCALAPPDATA:owned('localappdata'),TEMP:owned('temp'),TMP:owned('temp'),TMPDIR:owned('temp'),XDG_CACHE_HOME:owned('cache'),npm_config_cache:owned('cache'),ORANGE_NATIVE_STUDIO_CI_TEMP:owned('temp'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:emptyConfig,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'};
 diagnostics.enter('source-snapshot');const before=snapshot(context,gitExe,env);
 diagnostics.enter('package-pins');packagePins(context.workspace);
 // Frozen tests own unique children in these existing namespaces. Never remove,
 // overwrite or claim an earlier fixture case from them.
 diagnostics.enter('fixture-directory');
 directory(path.win32.join(context.workspace,'.dev','projects-admission'));
 directory(path.win32.join(context.workspace,'.dev','studio-auto-close','profiles'));
 ordinary(path.win32.join(context.workspace,'packages','openfilm','node_modules'),'directory',true);
 const packageTarget=path.win32.join(context.workspace,'packages','openfilm','node_modules','playwright-core');
 ordinary(packageTarget,'directory',true);need(!existsSync(packageTarget),'PACKAGE_EXISTS');
 diagnostics.enter('fetch');const archive=await fetchPackage();
 diagnostics.enter('archive');const packageInfo=restorePackage(context,archive,tarExe,env);
 diagnostics.enter('post-check');
 assertSame(before,snapshot(context,gitExe,env));await assertPortsFree();
 let result,ports,counts;
 diagnostics.enter('tests');
 try {
  result=child(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1',...TESTS],context.workspace,env,300_000);
  privateFile(owned('logs/native.tap'),result.stdout??Buffer.alloc(0));privateFile(owned('logs/native.stderr'),result.stderr??Buffer.alloc(0));
  const assessment=assessNativeStudioProcess(result);
  if(assessment.ok)counts=assessment.counts;else diagnostics.capture(assessment.failure);
 } catch(error) {
  diagnostics.capture(error);
 } finally {
  diagnostics.enter('post-check');
  try {ports=await assertPortsFree();assertSame(before,snapshot(context,gitExe,env));}
  catch(error){diagnostics.capture(error);throw error;}
 }
 diagnostics.enter('result');
 // A returned process result remains auditable even for failed TAP/exit.
 if(result)privateFile(owned('results/process.json'),JSON.stringify({commit:context.commit,node:process.version,exitCode:Number.isInteger(result.status)?result.status:null,processError:Boolean(result.error),signal:Boolean(result.signal),ports,tapSha256:hash(result.stdout??Buffer.alloc(0)),stderrSha256:hash(result.stderr??Buffer.alloc(0)),source:before,package:packageInfo},null,2)+'\n');
 if(diagnostics.summary()!==null)throw diagnosticFailure(diagnostics.summary());
 recheckSystemTar(tarExe);
 const summary={commit:context.commit,node:process.version,testFiles:TESTS,...counts,exitCode:result.status,ports,source:before,package:packageInfo,tapSha256:hash(result.stdout),stderrSha256:hash(result.stderr),tarSha256:tarExe.sha256};
 privateFile(owned('results/summary.json'),JSON.stringify(summary,null,2)+'\n');
 return summary;
 } catch(error) {
  throw diagnosticFailure(diagnostics.capture(error));
 }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 runNativeStudioCI().then(summary=>process.stdout.write(JSON.stringify(summary)+'\n')).catch(error=>{process.stderr.write(JSON.stringify(formatNativeStudioFailure('unknown',error))+'\n');process.exitCode=1;});
}
