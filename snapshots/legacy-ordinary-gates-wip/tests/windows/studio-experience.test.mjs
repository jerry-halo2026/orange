import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as native from '../../packages/film-adapter/src/node.ts';
const repository=fileURLToPath(new URL('../..',import.meta.url));
const sha=x=>createHash('sha256').update(x).digest('hex');
const pin='2e18a4bdf54647b2ece3c0975a6f9573720c7821';
const upstream='D:/dev/orange/.research/upstream/openfilm';
const sources=[['packages/openfilm/src/film-doc.mjs','9ff98a77df6be45bace50bccca960571260a4d9a193a7bcb5e06a9261bec64e0'],['packages/openfilm/studio/server/ops.mjs','accc40f54ee1ab79cb8559c1c777894902f42c411240eb40a6d6615e26f212ef'],['packages/openfilm/src/timeline.mjs','6a38ea00b06fea92139e59a913357ccef431ca308e672273eb4f467c8e9f7385'],['packages/openfilm/src/overrides.mjs','8fab39a5f4f9696e9070a206f45d9241f54167ea2d9f47c0bcc9975333664832'],['packages/openfilm/studio/server/bridge.js','816d37b38f6d290fcee5cb9ce64a02a347c2d6521979b3ec535ea5fc85f5824b']];
const text=sources.map(([path,digest])=>{ const b=execFileSync('git',['-c','safe.directory='+upstream,'-C',upstream,'show',pin+':'+path],{maxBuffer:1000000,windowsHide:true});assert.equal(sha(b),digest);return b.toString('utf8'); });
const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const doc=await import(data(text[0]));
const ops=await import(data(text[1].replace("'../../src/film-doc.mjs'",JSON.stringify(data(text[0])))));
const runtime={sourcePin:pin,browser:{filmDocMjs:text[0],timelineMjs:text[2],overridesMjs:text[3],bridgeJs:text[4]},pure:{readFilm:doc.readFilm,filmHtml:doc.filmHtml,applyOps:ops.applyOps}};
async function setup(options={}) {
 const root=join(repository,'.orange-local','experience-tests');await mkdir(root,{recursive:true});
 const path=await mkdtemp(join(root,'run-'));assert.equal(await realpath(path),resolve(path));
 const studio=join(path,'studio');await mkdir(join(studio,'assets'),{recursive:true});
 const names=['index.html','assets/studio-test.js','assets/index-test.css',...['cyrillic-ext','cyrillic','greek-ext','greek','latin-ext','latin','vietnamese'].map(x=>'assets/inter-'+x+'-wght-normal-test.woff2')];
 const artifacts=[];for(const name of names){ const bytes=Buffer.from(name==='index.html'?(options.html??'<!doctype html><title>Trusted test Studio</title>'):name.endsWith('.css')?(options.css??name):name);await writeFile(join(studio,name),bytes);artifacts.push({name,bytes:bytes.length,sha256:sha(bytes)}); }
 const receipt=JSON.stringify({source:{pin,ledgerSha256:'ceeec16d948e301de54a8a06e2d1faa050291777833b49cd9b7edfbbc077d9d6',files:235},artifacts});await writeFile(join(studio,'studio-build.json'),receipt);
 let authorized=true,failures=0;
 const baseline=options.fixture===true||process.env.ORANGE_EXPERIENCE_BASELINE==='1';
 const experience=baseline?await native.startStudioFixture(studio,sha(receipt),()=>failures++):await native.startStudioExperience(studio,sha(receipt),()=>{if(options.throws)throw Error('auth');return authorized;},()=>failures++,options.runtime??runtime);
 const project=baseline?'fixture-project':'local-experience';
 const headers=(origin=experience.studioOrigin)=>experience.requestHeaders({Origin:origin,'Sec-Fetch-Site':'same-origin'},true);
 const get=(path,opts={})=>send(experience.studioOrigin,path,{headers:headers(),...opts});
 return {experience,project,path,get,headers,revoke:()=>{authorized=false;},failures:()=>failures,async close(){await experience.close();assert.equal(await realpath(path),resolve(path));await rm(path,{recursive:true,force:true});}};
}
function send(origin,path,{method='GET',headers={},body}={}) {return new Promise((resolve,reject)=>{const q=request(origin,{path,method,headers,timeout:2000},r=>{const chunks=[];r.on('data',x=>chunks.push(x));r.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:r.statusCode,text,headers:r.headers,json:()=>JSON.parse(text)});});});q.on('upgrade',(r,s)=>{s.destroy();resolve({status:101});});q.on('error',reject);q.on('timeout',()=>q.destroy(Error('timeout')));q.end(body);});}
async function current(s){return (await s.get('/api/projects/'+s.project)).json();}
async function edit(s,body){const raw=typeof body==='string'?body:JSON.stringify(body);return s.get('/api/projects/'+s.project+'/edit',{method:'POST',headers:{...s.headers(),'Content-Type':'application/json','Content-Length':Buffer.byteLength(raw)},body:raw});}
test('real document contains two original still clips and six seconds, not an empty fixture',async()=>{const s=await setup();try{const v=await current(s);assert.equal(v.value.tracks.length,1,'useful sample must contain a real nonempty track');assert.equal(v.value.tracks[0].clips.length,2);assert.deepEqual(v.value.stage,{w:640,h:360});assert.equal(Math.max(...v.doc.tracks.flatMap(t=>t.clips.map(c=>(c.at??0)+c.time[1]-c.time[0]))),6);assert.match(v.text,/<img/);assert.equal(doc.readFilmFile(v.text).problems.length,0);assert.match(v.project.name,/关闭即丢弃/);}finally{await s.close();}});
if(process.env.ORANGE_EXPERIENCE_BASELINE!=='1') {
test('actual pinned applyOps moves atomically and stale/null bases conflict without changing state',async()=>{const s=await setup();try{const a=await current(s);const result=await edit(s,{base:a.rev,ops:[{op:'move',clip:'card-b',at:7,track:0}]});assert.equal(result.status,200);const b=result.json();assert.equal(b.rebased,false);assert.notEqual(b.rev,a.rev);assert.notEqual(b.text,a.text);assert.equal(b.value.tracks[0].clips.find(c=>c.id==='card-b').at,7);assert.equal(doc.readFilmFile(b.text).doc.tracks[0].clips.find(c=>c.id==='card-b').at,7);for(const base of [a.rev,null]){assert.equal((await edit(s,{base,ops:[{op:'move',clip:'card-a',at:2}]})).status,409);assert.equal((await current(s)).rev,b.rev);}const undo=await edit(s,{base:b.rev,ops:[{op:'move',clip:'card-b',at:3,track:0}],undo:true});assert.equal(undo.status,200);assert.equal(undo.json().text,a.text);}finally{await s.close();}});
test('unsupported, malformed, oversize and foreign edits never commit',async()=>{const s=await setup();try{const a=await current(s);const move={op:'move',clip:'card-a',at:1};for(const body of [{base:a.rev,ops:[{...move,src:'https://invalid'}]},{base:a.rev,ops:[{...move,newTrack:0}]},{base:a.rev,ops:[{...move,track:1}]},{base:a.rev,ops:[{...move,at:31}]},{base:a.rev,ops:[{...move,at:-1}]},{base:a.rev,ops:[{...move,clip:'foreign'}]},{base:a.rev,ops:[move,move,move]},{base:a.rev,ops:[]},{base:a.rev,ops:[{op:'set',clip:'card-a',field:'src',value:'https://invalid'}]},{base:a.rev,ops:[move],extra:true},{base:a.rev,ops:[move],undo:'yes'},'{','{"base":"'+a.rev+'","ops":[],"__proto__":{}}',' '.repeat(8193)]){const r=await edit(s,body);assert.ok([400,403,413,422].includes(r.status),JSON.stringify(body));assert.equal((await current(s)).rev,a.rev);}assert.equal((await edit(s,'{"base":"'+a.rev+'","ops":[{"op":"move","clip":"card-a","at":1e999}]}')).status,422);}finally{await s.close();}});
test('exact preview scripts, raw-film and SVG routes serve real pinned bytes',async()=>{const s=await setup();try{const e=s.experience;const p='/film.html?load=1&film-missing=skip&film-dpr=1';const preview=await send(e.previewOrigin,p,{headers:s.headers()});assert.equal(preview.status,200);assert.match(preview.text,/__film\/timeline.mjs/);assert.match(preview.text,/__film\/bridge.js/);assert.doesNotMatch(preview.text,/__orangeFixtureFirstSeek|type:'seeked'/);assert.match(preview.headers['content-security-policy'],/connect-src 'self'/);const raw=await send(e.previewOrigin,p+'&film-host=0',{headers:s.headers(e.previewOrigin)});assert.equal(raw.text,(await current(s)).text);for(const [path,key] of [['timeline.mjs','timelineMjs'],['film-doc.mjs','filmDocMjs'],['overrides.mjs','overridesMjs'],['bridge.js','bridgeJs']]){const url='/__film/'+path;assert.equal(e.route(e.previewOrigin+url,'GET'),'preview-runtime');const r=await send(e.previewOrigin,url,{headers:s.headers(e.previewOrigin)});assert.equal(r.status,200);assert.equal(r.text,path==='bridge.js'?runtime.browser[key].replace('__EDITOR__',JSON.stringify(e.studioOrigin)):runtime.browser[key]);}for(const name of ['card-a.svg','card-b.svg'])for(const suffix of ['','?v=1']){const r=await send(e.previewOrigin,'/'+name+suffix,{headers:s.headers()});assert.equal(r.status,200);assert.match(r.text,/<svg/);assert.doesNotMatch(r.text,/<script|foreignObject|href=|url\(/i);assert.equal(e.route(e.previewOrigin+'/'+name+suffix,'GET'),'preview-asset');}assert.equal(e.route(e.previewOrigin+p,'GET'),'preview');assert.equal(e.route(e.previewOrigin+p+'&film-host=0','GET'),'preview-film');for(const bad of ['/film.html','/film.html?load=0&film-missing=skip',p+'&x=1',p+'&film-host=1','/__film/stage.js','/%63ard-a.svg','/card-a.svg?v=2','/a/../card-a.svg','/card-a.svg#x']){assert.equal(e.route(e.previewOrigin+bad,'GET'),undefined,bad);assert.equal((await send(e.previewOrigin,bad,{headers:s.headers()})).status,403,bad);}}finally{await s.close();}});
test('auth, host, body, route and WS boundaries are denied',async()=>{const s=await setup();try{const e=s.experience;for(const headers of [{},s.headers('https://foreign.invalid'),{...s.headers(),Host:'localhost:1'},{...s.headers(),'x-orange-studio-access':'f'.repeat(64)}])assert.equal((await send(e.studioOrigin,'/api/projects',{headers})).status,403);for(const [path,method]of [['/api/projects/local-experience/save','POST'],['/api/projects/local-experience/edit?x=1','POST'],['/api/projects/local-experience','DELETE'],['/api/projects/local-experience?x=1','GET'],['/index.html','GET']])assert.equal((await s.get(path,{method})).status,403);assert.equal((await s.get('/api/projects',{method:'GET',headers:{...s.headers(),'Content-Length':'1'},body:'a'})).status,403);const ws={...s.headers(),Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':Buffer.alloc(16).toString('base64')};assert.equal((await s.get('/api/events?visible=1',{headers:ws})).status,101);assert.equal((await s.get('/api/projects/foreign/events',{headers:ws})).status,403);assert.equal((await send(e.previewOrigin,'/api/events?visible=1',{headers:ws})).status,403);assert.equal((await s.get('/api/events?visible=1',{headers:{...ws,Origin:'https://foreign.invalid'}})).status,403);assert.equal(Object.keys(e.requestHeaders({'X-Orange-Studio-Access':'spoof'},false)).length,0);}finally{await s.close();}});
test('revocation synchronously strips capabilities, fails once, close is idempotent, reopen resets',async()=>{let initial;const s=await setup();try{initial=await current(s);await edit(s,{base:initial.rev,ops:[{op:'move',clip:'card-a',at:8}]});s.revoke();assert.equal(s.experience.route(s.experience.studioOrigin+'/','GET'),undefined);assert.deepEqual(s.experience.requestHeaders({},true),{});assert.equal(s.failures(),1);assert.equal(s.experience.route(s.experience.studioOrigin+'/','GET'),undefined);assert.equal(s.failures(),1);await Promise.all([s.experience.close(),s.experience.close()]);}finally{await s.close();}const reopened=await setup();try{assert.equal((await current(reopened)).rev,initial.rev);}finally{await reopened.close();}});
test('throwing authorization revokes rather than leaking native exception',async()=>{const s=await setup({throws:true});try{assert.equal(s.experience.route(s.experience.studioOrigin+'/','GET'),undefined);assert.deepEqual(s.experience.requestHeaders({},true),{});assert.equal(s.failures(),1);}finally{await s.close();}});
}

test('readonly media metadata describes exactly the two actual static images',async()=>{const s=await setup();try{const listing=(await s.get('/api/projects/local-experience/files')).json();assert.deepEqual(listing.files.map(f=>[f.path,f.kind]),[['card-a.svg','image'],['card-b.svg','image']]);for(const path of ['card-a.svg','card-b.svg']){const r=await s.get('/api/projects/local-experience/media?what=probe&path='+path+'&v=1');assert.equal(r.status,200);assert.equal(r.json().width,640);assert.equal(r.json().height,360);assert.equal(r.json().audio,false);}assert.equal((await s.get('/api/projects/local-experience/media?what=probe&path=foreign.svg&v=1')).status,403);}finally{await s.close();}});
test('a failing pinned operation or malformed readFilm output cannot partially commit',async()=>{for(const failure of ['apply','read']){let breakRead=false;const r={...runtime,pure:{...runtime.pure,applyOps:(film,operations)=>{const changed=runtime.pure.applyOps(film,operations);if(failure==='apply')throw Error('internal details');breakRead=true;return changed;},readFilm:v=>breakRead?{doc:{stage:{w:640,h:360},tracks:[]},problems:[]}:runtime.pure.readFilm(v)}};const s=await setup({runtime:r});try{const a=await current(s);const result=await edit(s,{base:a.rev,ops:[{op:'move',clip:'card-a',at:10}]});assert.equal(result.status,400);assert.doesNotMatch(result.text,/internal details/);assert.deepEqual(await current(s),a);}finally{await s.close();}}});
test('revocation at HTTP, headers and WebSocket entry each fails closed once',async()=>{for(const entry of ['http','headers','ws']){const s=await setup();try{const e=s.experience;const h=s.headers();s.revoke();if(entry==='headers'){assert.deepEqual(e.requestHeaders({},true),{});}else{const headers=entry==='ws'?{...h,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':Buffer.alloc(16).toString('base64')}:h;const outcome=await send(e.studioOrigin,entry==='ws'?'/api/events?visible=1':'/api/projects',{headers}).then(r=>r.status,e=>e.code);assert.ok([403,'ECONNRESET','ECONNREFUSED'].includes(outcome));}assert.equal(s.failures(),1);assert.equal(e.route(e.studioOrigin+'/','GET'),undefined);}finally{await s.close();}}});
test('native exact project entry serves the verified Studio document without a broad SPA fallback',async()=>{const s=await setup();try{const e=s.experience;assert.equal(e.route(e.studioOrigin+'/projects/local-experience','GET'),'document');const r=await s.get('/projects/local-experience');assert.equal(r.status,200);assert.match(r.text,/Trusted test Studio/);assert.match(r.headers['content-security-policy'],/frame-ancestors 'none'/);for(const path of ['/projects/local-experience/','/projects/local-experience?x=1','/projects/foreign']){assert.equal(e.route(e.studioOrigin+path,'GET'),undefined);assert.equal((await s.get(path)).status,403);}}finally{await s.close();}});

test('legacy startStudioFixture retains its empty synthetic API for existing smoke tests',async()=>{const s=await setup({fixture:true});try{assert.equal(typeof native.startStudioFixture,'function');assert.equal(typeof s.experience.showProjects,'function');const a=await current(s);assert.deepEqual(a.value.tracks,[]);assert.equal(a.rev,'fixture-only');s.experience.showProjects();assert.deepEqual((await s.get('/api/projects')).json().projects,[]);}finally{await s.close();}});

// Original planner closure uses this checkout's tracked ledger and verified capsule.
async function originalPlacementPlanner() {
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const { posix } = await import('node:path');
  const evidence = readFileSync(new URL('../../docs/evidence/film-upstream.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const captured = /<!-- studio-source ([0-9a-f]{40}) -->\n`{3}text\n([\s\S]+?)\n`{3}/.exec(evidence);
  assert(captured);
  assert.equal(captured[1], pin);
  assert.equal(sha(captured[2] + '\n'), 'ceeec16d948e301de54a8a06e2d1faa050291777833b49cd9b7edfbbc077d9d6');
  const ledger = new Map(captured[2].split('\n').map(row => {
    const match = /^([a-f0-9]{64})  (packages\/openfilm\/.+)$/.exec(row);
    assert(match);
    return [match[2], match[1]];
  }));
  assert.equal(ledger.size, 235);
  const names = [
    'packages/openfilm/src/film-doc.mjs',
    'packages/openfilm/studio/server/track-layout.mjs',
    'packages/openfilm/studio/server/ops.mjs',
    'packages/openfilm/studio/ui/src/lib/film.ts',
    'packages/openfilm/studio/ui/src/lib/film-shape.ts',
    'packages/openfilm/studio/ui/src/lib/timeline-layout.ts',
    'packages/openfilm/studio/ui/src/lib/timecode.ts',
    'packages/openfilm/studio/ui/src/lib/timeline-drag.ts',
    'packages/openfilm/studio/ui/src/lib/timeline-edit.ts',
    'packages/openfilm/studio/ui/src/lib/timeline-nav.ts',
    'packages/openfilm/studio/ui/src/lib/timeline-keys.ts',
    'packages/openfilm/studio/ui/src/lib/keymap.ts',
    'packages/openfilm/studio/ui/src/lib/timeline-prefs.ts',
    'packages/openfilm/studio/ui/src/components/Timeline.tsx',
    'packages/openfilm/studio/ui/src/components/ProjectView.tsx',
    'packages/openfilm/studio/ui/src/editor/Preview.tsx',
  ];
  const files = Object.freeze(Object.fromEntries(names.map(path => {
    let bytes;
    try { bytes = readFileSync(join(repository, '.orange-local/studio-src-2e18a4b', path)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      bytes = execFileSync('git', ['-c', 'safe.directory=' + upstream, '-C', upstream, 'show', pin + ':' + path],
        { maxBuffer: 1000000, windowsHide: true });
    }
    assert(bytes.length > 0);
    assert.equal(sha(bytes), ledger.get(path));
    return [path, bytes.toString('utf8')];
  })));
  let requireExisting = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
  let ts;
  try {
    ts = requireExisting('typescript');
    requireExisting.resolve('react');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    assert(process.env.ORANGE_UI_TYPESCRIPT_PACKAGE,
      'Set ORANGE_UI_TYPESCRIPT_PACKAGE to an existing pinned desktop package.json only for standalone author tests');
    requireExisting = createRequire(process.env.ORANGE_UI_TYPESCRIPT_PACKAGE);
    ts = requireExisting('typescript');
  }
  assert.equal(ts.version, '5.9.3');
  assert.equal(requireExisting('react/package.json').version, '19.3.1');
  const cache = new Map();
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative).exports;
    assert(Object.hasOwn(files, relative), 'Unexpected original planner import ' + relative);
    const module = { exports: {} };
    cache.set(relative, module);
    const output = ts.transpileModule(files[relative], {
      fileName: relative + '.ts',
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const requireOriginal = name => {
      if (name === 'react') return requireExisting('react');
      assert(name.startsWith('.'));
      return load(posix.normalize(posix.join(posix.dirname(relative), name)));
    };
    new Function('require', 'exports', 'module', output)(requireOriginal, module.exports, module);
    return module.exports;
  }
  const lib = name => load('packages/openfilm/studio/ui/src/lib/' + name);
  return { shape: lib('film-shape.ts'), layout: lib('timeline-layout.ts'),
    edit: lib('timeline-edit.ts'), nav: lib('timeline-nav.ts'), keys: lib('keymap.ts') };
}

test('genuine original UI nudge and drag props-at plans pass unchanged through actual server and pinned applyOps', async () => {
  const planner = await originalPlacementPlanner();
  const applied = [];
  const observedRuntime = { ...runtime, pure: { ...runtime.pure, applyOps(film, operations) {
    applied.push(structuredClone(operations));
    return runtime.pure.applyOps(film, operations);
  } } };
  const s = await setup({ runtime: observedRuntime });
  try {
    const initial = await current(s);
    const tracks = planner.layout.layoutTracks(planner.shape.filmShape(initial.doc, [], new Map()));
    const model = planner.edit.editModelOf(tracks);
    const keys = planner.keys;
    assert.equal(keys.actionOf({ key: 'ArrowRight', metaKey: false, ctrlKey: false,
      altKey: true, shiftKey: false }, keys.keymapOf(keys.DEFAULT_KEY_PREFS, false), false), 'nudge-forward');
    const nudge = planner.nav.planNudge(model, ['card-b'], 1, { magnet: false, linkage: false });
    assert.deepEqual(nudge.ops, [{ op: 'props', edits: [{ clip: 'card-b', prop: 'at', value: 3.033 }] }]);
    console.log('TASK4_ORIGINAL_NUDGE ' + JSON.stringify(nudge.ops));
    const response = await edit(s, { base: initial.rev, ops: nudge.ops });
    assert.equal(response.status, 200, 'genuine original UI props-at must not be rejected as unsupported');
    const nudged = response.json();
    assert.equal(nudged.rebased, false);
    assert.notEqual(nudged.rev, initial.rev);
    assert.equal(nudged.value.tracks[0].clips.find(c => c.id === 'card-b').at, 3.033);
    assert.deepEqual(applied[0], nudge.ops, 'do not convert props to a custom move operation');
    const drag = planner.edit.planMove(model, { ids: ['card-b'], deltaMs: 1000, pointerMs: 4000,
      mode: 'place', magnet: false, linkage: false });
    assert.deepEqual(drag.ops, [{ op: 'props', edits: [{ clip: 'card-b', prop: 'at', value: 4 }] }]);
    console.log('TASK4_ORIGINAL_DRAG ' + JSON.stringify(drag.ops));
    const dragged = await edit(s, { base: nudged.rev, ops: drag.ops });
    assert.equal(dragged.status, 200);
    assert.deepEqual(applied[1], drag.ops);
    assert.equal(doc.readFilmFile(dragged.json().text).doc.tracks[0].clips.find(c => c.id === 'card-b').at, 4);
    assert.equal(dragged.json().value.tracks[0].clips.find(c => c.id === 'card-a').at ?? 0, 0);
  } finally { await s.close(); }
});

test('exact props-at permits two fixed clips and mixed legacy move within total placement cap', async () => {
  const s = await setup();
  try {
    const initial = await current(s);
    const both = [{ op: 'props', edits: [
      { clip: 'card-a', prop: 'at', value: 1 }, { clip: 'card-b', prop: 'at', value: 5 },
    ] }];
    const first = await edit(s, { base: initial.rev, ops: both });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json().value.tracks[0].clips.map(c => [c.id, c.at]), [['card-a', 1], ['card-b', 5]]);
    const mixed = await edit(s, { base: first.json().rev, ops: [
      { op: 'move', clip: 'card-a', at: 0, track: 0 },
      { op: 'props', edits: [{ clip: 'card-b', prop: 'at', value: 30 }] },
    ] });
    assert.equal(mixed.status, 200);
    assert.equal(mixed.json().value.tracks[0].clips.find(c => c.id === 'card-a').at ?? 0, 0);
    assert.equal(mixed.json().value.tracks[0].clips.find(c => c.id === 'card-b').at, 30);
  } finally { await s.close(); }
});

test('unsafe general props, extras, prototype keys, nonfinite values and aggregate overflow never commit', async () => {
  const s = await setup();
  try {
    const initial = await current(s);
    const placement = { clip: 'card-b', prop: 'at', value: 4 };
    const props = edits => ({ op: 'props', edits });
    const move = { op: 'move', clip: 'card-a', at: 1 };
    const invalidOps = [
      [props([])], [props([placement, placement, placement])],
      [props([placement, placement]), move], [move, props([placement, placement])],
      [props([placement, placement]), props([placement])],
      [{ ...props([placement]), extra: true }], [{ op: 'props' }], [{ op: 'props', edits: {} }],
      [props([null])], [props([{ ...placement, clip: 'foreign' }])],
      ...['src', 'time', 'style', 'attrs', 'track', 'id', 'box', 'volume', 'speed', '__proto__'].map(prop => [props([{ ...placement, prop }])]),
      ...[null, '4', NaN, Infinity, -Infinity, -1, 30.001].map(value => [props([{ ...placement, value }])]),
      ...['src', 'time', 'style', 'attrs', 'track', 'id', 'extra', 'constructor', 'prototype'].map(key => [props([{ ...placement, [key]: 'forbidden' }])]),
      [props([placement]), { op: 'remove', clip: 'card-a' }],
    ];
    for (const operations of invalidOps) {
      const rejected = await edit(s, { base: initial.rev, ops: operations });
      assert.equal(rejected.status, 422, JSON.stringify(operations));
      assert.deepEqual(await current(s), initial);
    }
    for (const rawOps of [
      '[{"op":"props","edits":[{"clip":"card-b","prop":"at","value":1e999}]}]',
      '[{"op":"props","edits":[{"clip":"card-b","prop":"at","value":NaN}]}]',
      '[{"op":"props","edits":[{"clip":"card-b","prop":"at","value":4,"__proto__":{}}]}]',
      '[{"op":"props","edits":[{"clip":"card-b","prop":"at","value":4}],"__proto__":{}}]',
    ]) {
      const rejected = await edit(s, '{"base":"' + initial.rev + '","ops":' + rawOps + '}');
      assert.ok([400, 422].includes(rejected.status));
      assert.deepEqual(await current(s), initial);
    }
  } finally { await s.close(); }
});

test('props-at requires exact current base and supports bounded undo without rebase', async () => {
  const s = await setup();
  try {
    const initial = await current(s);
    const operations = [{ op: 'props', edits: [{ clip: 'card-b', prop: 'at', value: 4 }] }];
    const moved = await edit(s, { base: initial.rev, ops: operations });
    assert.equal(moved.status, 200);
    for (const base of [initial.rev, null]) {
      assert.equal((await edit(s, { base, ops: operations })).status, 409);
      assert.equal((await current(s)).rev, moved.json().rev);
    }
    const undone = await edit(s, { base: moved.json().rev,
      ops: [{ op: 'props', edits: [{ clip: 'card-b', prop: 'at', value: 3 }] }], undo: true });
    assert.equal(undone.status, 200);
    assert.equal(undone.json().rebased, false);
    assert.equal(undone.json().text, initial.text);
  } finally { await s.close(); }
});

test('props-at pure apply, validation and serialization failures preserve complete prior state', async () => {
  for (const failure of ['apply', 'read', 'serialize']) {
    let applied = false;
    const failingRuntime = { ...runtime, pure: { ...runtime.pure,
      applyOps(film, operations) {
        const changed = runtime.pure.applyOps(film, operations);
        applied = true;
        if (failure === 'apply') throw Error('private failure');
        return changed;
      },
      readFilm(film) {
        return applied && failure === 'read' ? { doc: { tracks: [] }, problems: [] } : runtime.pure.readFilm(film);
      },
      filmHtml(film, before) {
        if (applied && failure === 'serialize') throw Error('private failure');
        return runtime.pure.filmHtml(film, before);
      },
    } };
    const s = await setup({ runtime: failingRuntime });
    try {
      const initial = await current(s);
      const failed = await edit(s, { base: initial.rev, ops: [{ op: 'props', edits: [
        { clip: 'card-a', prop: 'at', value: 1 }, { clip: 'card-b', prop: 'at', value: 5 },
      ] }] });
      assert.equal(failed.status, 400);
      assert.equal(applied, true, 'validated original props must reach actual pinned applyOps before failure');
      assert.doesNotMatch(failed.text, /private failure/);
      assert.deepEqual(await current(s), initial);
    } finally { await s.close(); }
  }
});

test('deep document relative script CSS and fonts use only finite verified asset aliases', async () => {
  const fonts = ['cyrillic-ext', 'cyrillic', 'greek-ext', 'greek', 'latin-ext', 'latin', 'vietnamese']
    .map(name => 'inter-' + name + '-wght-normal-test.woff2');
  // Same relative reference forms as actual Vite output, with receipt-owned test leaves.
  const html = '<!doctype html><script type="module" crossorigin src="./assets/studio-test.js"></script>' +
    '<link rel="stylesheet" crossorigin href="./assets/index-test.css">';
  const css = fonts.map(name => '@font-face{font-family:test;src:url(./' + name + ')}').join('');
  const s = await setup({ html, css });
  try {
    const e = s.experience;
    const document = await s.get('/projects/local-experience');
    assert.equal(document.status, 200);
    assert.equal(document.text, html, 'HTML bytes must not be rewritten to fix routing');
    const deepUrl = e.studioOrigin + '/projects/local-experience';
    const refs = [...document.text.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => new URL(match[1], deepUrl));
    assert.deepEqual(refs.map(url => url.pathname), ['/projects/assets/studio-test.js', '/projects/assets/index-test.css']);
    for (const url of refs) {
      assert.equal((await s.get(url.pathname)).status, 200, 'verified deep-link asset must load');
      assert.equal(e.route(url.href, 'GET'), 'asset', 'deep-link relative asset must have the existing asset role');
    }
    const stylesheetUrl = refs[1];
    const stylesheet = await s.get(stylesheetUrl.pathname);
    assert.equal(stylesheet.text, css, 'CSS bytes must not be rewritten');
    const fontUrls = [...stylesheet.text.matchAll(/url\(([^)]+)\)/g)].map(match => new URL(match[1], stylesheetUrl));
    assert.equal(fontUrls.length, 7);
    assert.deepEqual(fontUrls.map(url => url.pathname), fonts.map(name => '/projects/assets/' + name));
    const leaves = ['studio-test.js', 'index-test.css', ...fonts];
    assert.equal(leaves.length, 9);
    for (const leaf of leaves) {
      const canonical = await s.get('/assets/' + leaf);
      const alias = await s.get('/projects/assets/' + leaf);
      assert.equal(canonical.status, 200);
      assert.equal(alias.status, 200);
      assert.equal(sha(alias.text), sha(canonical.text));
      assert.equal(alias.headers['content-type'], canonical.headers['content-type']);
      assert.equal(alias.headers['x-content-type-options'], 'nosniff');
      assert.equal(e.route(e.studioOrigin + '/assets/' + leaf, 'GET'), 'asset');
      assert.equal(e.route(e.studioOrigin + '/projects/assets/' + leaf, 'GET'), 'asset');
    }
    const bad = [
      '/projects/assets/unknown.js', '/wrongprefix/assets/studio-test.js',
      '/projects/assets/%73tudio-test.js', '/projects/assets/./studio-test.js',
      '/projects/assets/../assets/studio-test.js', '/projects/assets/../../index.html',
      '/projects/assets/Studio-test.js', '/projects/assets/studio-test.js?v=1',
      '/projects/assets/index.html', '/projects/index.html', '/projects/assets/api/projects',
      '/projects/assets/__film/timeline.mjs', '/projects\\assets\\studio-test.js',
    ];
    for (const path of bad) {
      assert.equal(e.route(e.studioOrigin + path, 'GET'), undefined, path);
      assert.equal((await s.get(path)).status, 403, path);
    }
    const alias = '/projects/assets/studio-test.js';
    assert.equal((await send(e.studioOrigin, alias)).status, 403);
    assert.equal((await send(e.studioOrigin, alias, { headers: s.headers('https://foreign.invalid') })).status, 403);
    assert.equal(e.route('https://foreign.invalid' + alias, 'GET'), undefined);
    for (const method of ['HEAD', 'POST']) {
      assert.equal(e.route(e.studioOrigin + alias, method), undefined);
      assert.equal((await s.get(alias, { method })).status, 403);
    }
    assert.equal((await s.get(alias, { headers: { ...s.headers(), 'Content-Length': '1' }, body: 'a' })).status, 403);
    assert.equal(e.route(e.previewOrigin + alias, 'GET'), undefined);
    assert.equal((await send(e.previewOrigin, alias, { headers: s.headers() })).status, 403);
  } finally { await s.close(); }
});
