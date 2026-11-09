import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveIsolationProfile, isolationEnvironment } from '../../src/development-isolation.mjs';

const own = process.env.ORANGE_MATERIAL_TEST_ROOT;
assert(own && resolve(own) === own && own.includes('.dev'));
const baseRoot = join(own, 'profiles'); let sequence = 0;
async function profile() {
  const p = resolveIsolationProfile({ baseRoot, instanceId: 'material', taskId: 'T04_LOCAL', attemptId: 'a-' + process.pid + '-' + Date.now() + '-' + ++sequence, ports: { studio: 18551, film: 18552 } }, { approvedBaseRoot: baseRoot });
  for (const dir of Object.values(p.paths)) await fs.mkdir(dir, { recursive: true });
  Object.assign(process.env, isolationEnvironment(p)); return p;
}
await profile();
const { createDesktopAuth } = await import('../../../../apps/desktop/src/desktop-auth.mjs');
const { startStudio } = await import('./server.mjs');
const { createProject } = await import('./projects.mjs');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
async function setup(options = {}) {
  const p = await profile(); let subject = B;
  const auth = createDesktopAuth({ configuration: { environmentId: 'material-fixture', authOrigin: 'https://auth.invalid', publishableKey: 'public-fixture' }, home: p.paths.home, sharedHome: p.paths.sharedHome, projects: p.paths.projects, coordinationRoot: join(p.root, 'coord'), instanceId: 'material-' + sequence }, {
    fetch: async url => url.includes('/token?') ? Response.json({ access_token: 'synthetic', refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 600, user: { id: subject } }) : url.endsWith('/auth/v1/user') ? Response.json({ id: subject, is_anonymous: false }) : new Response(null, { status: 204 }),
    monotonicNow: () => 10, retire: async () => {}, onState: () => {},
  });
  const input = { email: 'fixture@example.invalid', password: 'not-real' };
  assert.equal((await auth.signIn(input)).ok, true); const b = await auth.runNative(() => createProject('Owner B'));
  await fs.mkdir(join(b.path, 'assets')); const bFile = join(b.path, 'assets', 'owner-only.txt'); await fs.writeFile(bFile, 'synthetic B only');
  await auth.signOut(); subject = A; assert.equal((await auth.signIn(input)).ok, true);
  const a = await auth.runNative(() => createProject('Owner A')); await fs.mkdir(join(a.path, 'assets'));
  const aFile = join(a.path, 'assets', 'owned.txt'); await fs.writeFile(aFile, 'synthetic A own');
  const external = join(p.root, 'external.txt'); await fs.writeFile(external, 'synthetic external selected data');
  const studio = await auth.runNative(() => startStudio({ port: 18551, key: 'material-local-key', isolation: true, advertise: false, desktopAuth: auth, pickFiles: async ask => options.picker ? options.picker({ ask, external, aFile, bFile, auth, p }) : [external], openBrowser: () => assert.fail('no browser/OS dialog in fixture') }));
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(studio.origin + path, { method, headers: { origin: studio.origin, 'x-studio-key': studio.key, connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const text = await res.text(); let value; try { value = JSON.parse(text); } catch { value = text; } return { status: res.status, value };
  };
  return { p, auth, studio, a, b, aFile, bFile, external, call, input, setSubject: value => { subject = value; }, close: async () => { await studio.close(); await auth.dispose(); } };
}

test('controlled A cannot copy B bytes through its otherwise-owned native bring endpoint', async () => {
  const f = await setup();
  try {
    assert.equal((await f.call('/api/projects/' + f.b.id)).status, 403);
    const result = await f.call('/api/projects/' + f.a.id + '/files/bring', 'POST', { paths: [f.bFile], into: 'assets' });
    assert.equal(result.status, 403, 'owning the destination does not authorize reading B');
    assert.equal(await fs.readFile(f.bFile, 'utf8'), 'synthetic B only');
    assert.equal((await fs.readdir(join(f.a.path, 'assets'))).includes('owner-only.txt'), false);
  } finally { await f.close(); }
});

test('an unselected ordinary external raw path requires actual source selection', async () => {
  const f = await setup();
  try {
    const result = await f.call('/api/projects/' + f.a.id + '/files/bring', 'POST', { paths: [f.external], into: 'assets' });
    assert.equal(result.status, 403); assert.equal(result.value.code, 'source-selection-required');
  } finally { await f.close(); }
});

test('mixed native bring batch is fully rejected before its first destination directory or copy', async () => {
  const f = await setup();
  try {
    const result = await f.call('/api/projects/' + f.a.id + '/files/bring', 'POST', { paths: [f.aFile, f.bFile], into: 'assets/rejected-batch' });
    assert.equal(result.status, 403);
    await assert.rejects(fs.stat(join(f.a.path, 'assets', 'rejected-batch')), { code: 'ENOENT' });
  } finally { await f.close(); }
});
test('the original server picker selection imports to the native list and original Op remains usable', async () => {
  const f = await setup();
  try {
    const picked = await f.call('/api/pick-files', 'POST', { title: 'Synthetic picker fixture' });
    assert.equal(picked.status, 200); assert.deepEqual(picked.value.paths, [f.external]);
    const brought = await f.call('/api/projects/' + f.a.id + '/files/bring', 'POST', { paths: picked.value.paths, into: 'assets' });
    assert.equal(brought.status, 200); assert.deepEqual(brought.value.landed, ['assets/external.txt']);
    assert.equal(await fs.readFile(join(f.a.path, brought.value.landed[0]), 'utf8'), 'synthetic external selected data');
    const listed = await f.call('/api/projects/' + f.a.id + '/files');
    assert.equal(listed.status, 200); assert(listed.value.files.some(file => file.path === 'assets/external.txt'));
    const initial = await f.call('/api/projects/' + f.a.id);
    assert.equal((await f.call('/api/projects/' + f.a.id + '/edit', 'POST', { base: initial.value.rev, ops: [{ op: 'stage', w: 720, h: 1280 }] })).status, 200);
    const reopened = await f.call('/api/projects/' + f.a.id); assert.equal(reopened.value.doc.stage.w, 720);
    const source = await fetch(initial.value.folder + 'assets/external.txt'); assert.equal(source.status, 200); assert.equal(await source.text(), 'synthetic external selected data');
  } finally { await f.close(); }
});

test('a real picker result cannot authorize a known B project source', async () => {
  const f = await setup({ picker: async ({ bFile }) => [bFile] });
  try {
    const result = await f.call('/api/pick-files', 'POST', {});
    assert.equal(result.status, 403); assert.equal(result.value.code, 'source-access-denied');
    assert.equal((await f.call('/api/projects/' + f.a.id + '/files/bring', 'POST', { paths: [f.bFile], into: 'assets' })).status, 403);
  } finally { await f.close(); }
});

test('a picked source fingerprint cannot silently authorize changed bytes', async () => {
  const f = await setup();
  try {
    assert.equal((await f.call('/api/pick-files', 'POST', {})).status, 200);
    await fs.writeFile(f.external, 'changed selected file version and size');
    const result = await f.call('/api/projects/' + f.a.id + '/files/bring', 'POST', { paths: [f.external], into: 'assets' });
    assert.equal(result.status, 403); assert.equal(result.value.code, 'source-access-denied');
  } finally { await f.close(); }
});

test('an old global link and a hardlink cannot expose B through the owned film origin', async () => {
  const f = await setup();
  try {
    const initial = await f.call('/api/projects/' + f.a.id);
    const alias = join(f.a.path, 'assets', 'hard-alias.txt'); await fs.link(f.bFile, alias);
    const hard = await fetch(initial.value.folder + 'assets/hard-alias.txt');
    assert([403, 404].includes(hard.status)); assert.notEqual(await hard.text(), 'synthetic B only');
    const link = join(f.a.path, 'assets', 'linked-directory'); await fs.symlink(join(f.b.path, 'assets'), link, 'junction');
    await fs.writeFile(join(f.p.paths.home, 'links.json'), JSON.stringify({ places: [join(f.b.path, 'assets')] }));
    const linked = await fetch(initial.value.folder + 'assets/linked-directory/owner-only.txt');
    assert([403, 404].includes(linked.status)); assert.notEqual(await linked.text(), 'synthetic B only');
  } finally { await f.close(); }
});

test('unknown controlled sources, unproven directories and persistent links are explicit refusal', async () => {
  const f = await setup();
  try {
    const unknown = join(f.p.root, 'unknown-controlled'); await fs.mkdir(unknown);
    await fs.writeFile(join(unknown, '.openfilm-control.json'), JSON.stringify({ version: 1, domainId: 'unknown' }));
    const unknownFile = join(unknown, 'data.txt'); await fs.writeFile(unknownFile, 'unknown owner bytes');
    const denied = await f.call('/api/projects/' + f.a.id + '/files/bring', 'POST', { paths: [unknownFile], into: 'assets' });
    assert.equal(denied.status, 403); assert.equal(denied.value.code, 'source-access-denied');
    assert.equal((await f.call('/api/projects/' + f.a.id + '/files/bring', 'POST', { paths: [join(f.a.path, 'assets')], into: 'assets' })).status, 503);
    assert.equal((await f.call('/api/projects/' + f.a.id + '/files/bring', 'POST', { paths: [f.aFile], mode: 'link', into: 'assets' })).status, 503);
    assert.equal((await f.call('/api/projects/' + f.a.id + '/fonts')).status, 503);
  } finally { await f.close(); }
});

test('logout invalidates selection grants rather than transferring them to a later account', async () => {
  const f = await setup();
  try {
    assert.equal((await f.call('/api/pick-files', 'POST', {})).status, 200);
    await f.auth.signOut(); assert.equal((await f.auth.signIn(f.input)).ok, true);
    const result = await f.call('/api/projects/' + f.a.id + '/files/bring', 'POST', { paths: [f.external], into: 'assets' });
    assert.equal(result.status, 403); assert.equal(result.value.code, 'source-selection-required');
  } finally { await f.close(); }
});

test('late system selection cannot survive retirement or become the next identity selection', async () => {
  let entered, release; const started = new Promise(r => entered = r); const held = new Promise(r => release = r);
  const f = await setup({ picker: async () => { entered(); return held; } });
  try {
    const picking = f.call('/api/pick-files', 'POST', {}); await started;
    const retiring = f.auth.signOut(); f.setSubject(B);
    assert.equal((await f.auth.signIn(f.input)).code, 'preservation-pending');
    release([f.external]); const result = await picking; assert.equal(result.status, 403);
    await retiring; assert.equal((await f.auth.signIn(f.input)).ok, true);
    await assert.rejects(f.auth.runNative(async () => {
      const { assertSourceAccess } = await import('../../src/media-links.mjs'); assertSourceAccess(f.external, 'copy');
    }), { code: 'source-selection-required' });
  } finally { release([]); await f.close(); }
});
async function actualImportCallbacks(f, pathOf, trace) {
  const {createRequire}=await import('node:module');const require=createRequire(import.meta.url),ts=require('typescript');
  const source=await fs.readFile(new URL('../ui/src/components/ProjectView.tsx',import.meta.url),'utf8');
  const extract=name=>{
    const start=source.indexOf('  const '+name+' = React.useCallback(');assert(start>=0);
    const end=source.indexOf('\n  }, [',start);assert(end>start);const close=source.indexOf(');',end);assert(close>end);
    return source.slice(start,close+2);
  };
  const apiSource=await fs.readFile(new URL('../ui/src/api.ts',import.meta.url),'utf8');const start=apiSource.indexOf('export class ApiError extends Error');const end=apiSource.indexOf('\n}',start)+2;
  const classModule={exports:{}};new Function('module','exports',ts.transpileModule(apiSource.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(classModule,classModule.exports);
  const compiled=ts.transpileModule(extract('onBring')+'\n'+extract('onImport')+'\nmodule.exports={onImport};',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const postJson=async(path,body)=>{const r=await f.call(path,'POST',body);return {ok:r.status>=200&&r.status<300,status:r.status,answer:r.value};};
  class XHR {
    upload={};open(method,url){this.method=method;this.url=url;}
    send(file){trace.xhrs++;void(async()=>{
      this.upload.onprogress?.({lengthComputable:true,loaded:file.size,total:file.size});
      const response=await fetch(f.studio.origin+this.url,{method:this.method,headers:{origin:f.studio.origin,'x-studio-key':f.studio.key,connection:'close'},body:file,signal:AbortSignal.timeout(5000)});
      this.status=response.status;this.responseText=await response.text();this.onload();
    })().catch(()=>this.onerror());}
  }
  const module={exports:{}};
  new Function('React','projectApi','postJson','t','studioHost','XMLHttpRequest','toast','ApiError','module','exports',compiled)(
    {useCallback:fn=>fn},'/api/projects/'+f.a.id,postJson,key=>key,{folders:{pathOf}},XHR,{show:()=>{}},classModule.exports.ApiError,module,module.exports);
  return {onImport:module.exports.onImport,ApiError:classModule.exports.ApiError};
}

test('actual original File import callback falls back to existing XHR only for ordinary unselected external bytes',async()=>{
  const f=await setup(),trace={xhrs:0};
  try{
    const callback=await actualImportCallbacks(f,()=>f.external,trace);const progress=[];
    const landed=await callback.onImport([new File(['synthetic external selected data'],'external.txt')],'assets',(...args)=>progress.push(args));
    assert.equal(trace.xhrs,1);assert.deepEqual(landed,['assets/external.txt']);
    assert.equal(await fs.readFile(join(f.a.path,landed[0]),'utf8'),'synthetic external selected data');assert(progress.some(p=>p[1]===1));
  }finally{await f.close();}
});

test('actual original File import callback never falls back for forbidden B and preserves native error code',async()=>{
  const f=await setup(),trace={xhrs:0};
  try{
    const callback=await actualImportCallbacks(f,()=>f.bFile,trace);
    await assert.rejects(callback.onImport([new File(['synthetic B only'],'owner-only.txt')],'assets',()=>{}),error=>error instanceof callback.ApiError&&error.status===403&&error.body.code==='source-access-denied');
    assert.equal(trace.xhrs,0);assert.equal((await fs.readdir(join(f.a.path,'assets'))).includes('owner-only.txt'),false);
  }finally{await f.close();}
});

test('actual original mixed File import does not recopy earlier success when one external File needs XHR',async()=>{
  const f=await setup(),trace={xhrs:0};
  try{
    const callback=await actualImportCallbacks(f,file=>file.name==='owned.txt'?f.aFile:f.external,trace);
    const landed=await callback.onImport([new File(['synthetic A own'],'owned.txt'),new File(['synthetic external selected data'],'external.txt')],'assets',()=>{});
    assert.equal(trace.xhrs,1);assert.equal(landed.length,2);assert.equal(new Set(landed).size,2);
    const names=await fs.readdir(join(f.a.path,'assets'));assert.equal(names.filter(n=>n.startsWith('owned')).length,2);assert(names.includes('external.txt'));
  }finally{await f.close();}
});
test('a nested unknown controlled boundary is not authorized by owning an outer project',async()=>{
  const f=await setup();
  try{
    const nested=join(f.a.path,'assets','unknown-controlled');await fs.mkdir(nested);
    await fs.writeFile(join(nested,'.openfilm-control.json'),JSON.stringify({version:1,domainId:'unknown-controlled-domain'}));
    const file=join(nested,'private.txt');await fs.writeFile(file,'nested unknown owner bytes');
    const result=await f.call('/api/projects/'+f.a.id+'/files/bring','POST',{paths:[file],into:'assets/forbidden-nested'});
    assert.equal(result.status,403);assert.equal(result.value.code,'source-access-denied');
    await assert.rejects(fs.stat(join(f.a.path,'assets','forbidden-nested')),{code:'ENOENT'});
  }finally{await f.close();}
});

test('actual source open swapped to a foreign hardlink is rejected before reading or destination creation',async t=>{
  const f=await setup();const {syncBuiltinESMExports}=await import('node:module');let swapped=false;const actualOpen=fs.open;
  try{
    assert.equal((await f.call('/api/pick-files','POST',{})).status,200);
    t.mock.method(fs,'open',async function(file,...args){
      if(file===f.external&&!swapped){swapped=true;await fs.rename(f.external,f.external+'.preserved');await fs.link(f.bFile,f.external);}
      return actualOpen.call(fs,file,...args);
    });syncBuiltinESMExports();
    const result=await f.call('/api/projects/'+f.a.id+'/files/bring','POST',{paths:[f.external],into:'assets/swap-blocked'});
    assert.equal(swapped,true,'the actual native FileHandle open was exercised');assert.equal(result.status,403);
    assert.equal(result.value.code,'source-access-denied');await assert.rejects(fs.stat(join(f.a.path,'assets','swap-blocked')),{code:'ENOENT'});
    assert.equal(await fs.readFile(f.bFile,'utf8'),'synthetic B only');
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await f.close();}
});
test('unmarked standalone native validation retains its original FileError for a malformed source',async()=>{
  const {bringIn,FileError}=await import('./files.mjs');const directory=join(own,'standalone-invalid-'+process.pid+'-'+Date.now());await fs.mkdir(directory,{recursive:true});
  await assert.rejects(bringIn(directory,'assets',[null],'copy'),error=>error instanceof FileError&&error.status===400);
});
test('unknown actual source handle retirement is preservation failure, never an ordinary access denial',async t=>{
  const f=await setup();const {syncBuiltinESMExports}=await import('node:module');const actualOpen=fs.open;let held,closeHeld;
  try{
    assert.equal((await f.call('/api/pick-files','POST',{})).status,200);
    t.mock.method(fs,'open',async function(file,...args){const handle=await actualOpen.call(fs,file,...args);if(file===f.external){held=handle;closeHeld=handle.close.bind(handle);handle.close=async()=>{throw Error('synthetic owned source close is unconfirmed');};}return handle;});syncBuiltinESMExports();
    const result=await f.call('/api/projects/'+f.a.id+'/files/bring','POST',{paths:[f.external],into:'assets'});
    assert(held,'actual owned source handle was retained by the failure fixture');
    assert.equal(result.value.code,'source-preservation-failed');assert.equal(f.auth.getPublicState().reason,'preservation-failed');
    assert.equal((await f.auth.signIn(f.input)).code,'preservation-failed');
  }finally{t.mock.restoreAll();syncBuiltinESMExports();if(closeHeld)await closeHeld();await f.close();}
});