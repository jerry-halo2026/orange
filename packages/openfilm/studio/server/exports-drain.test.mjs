import { test, after } from 'node:test';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as nativeFs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveIsolationProfile, isolationEnvironment } from '../../src/development-isolation.mjs';

const baseRoot = resolve('.dev/exports-drain');
const profile = resolveIsolationProfile({ baseRoot, instanceId: 'tests', taskId: 'T02', attemptId: `a-${Date.now()}-${process.pid}`, ports: { studio: 18479, film: 18480 } }, { approvedBaseRoot: baseRoot });
Object.assign(process.env, isolationEnvironment(profile));
for (const key of ['TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = profile.paths.temp;
await Promise.all(Object.values(profile.paths).map(p => mkdir(p, { recursive: true })));
const { createExports, ExportError, renameOutput } = await import('./exports.mjs');
const { filmHtml, readFilmFile } = await import('../../src/film-doc.mjs');
const { parseFilmSubtitleStyle } = await import('./film-subtitle.mjs');
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
async function fixture(name) {
  const root = join(profile.paths.projects, name);
  const folder = join(profile.paths.exports, name);
  await mkdir(root, { recursive: true });
  await mkdir(folder, { recursive: true });
  await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [] }));
  assert.ok(readFilmFile(await readFile(join(root, 'film.html'), 'utf8')).doc, 'native film document prevents browser fallback');
  return { project: { id: name, name, path: root }, folder };
}
const cues = { cues: [{ startMs: 0, durMs: 1000, text: 'Synthetic words' }], style: parseFilmSubtitleStyle(null) };

test('stop identity is stable after a real captions entry and rejects late work without waiting orphans', async () => {
  const f = await fixture('captions'); const entered = gate(); const held = gate();
  const q = createExports({ captions: async () => { entered.release(); await held.promise; return cues; } });
  q.start(f.project, { kind: 'subtitles' }, { folder: f.folder });
  await entered.promise;
  const stopping = q.stopAll();
  try {
    assert.equal(q.stopAll(), stopping);
    assert.throws(() => q.start(f.project, { kind: 'subtitles' }, { folder: f.folder }), ExportError);
    assert.throws(() => q.startAll(f.project, { jobs: [{ kind: 'subtitles' }], folder: f.folder }), ExportError);
    assert.equal(q.list(f.project.id).length, 1);
    assert.equal(await Promise.race([stopping.then(() => 'ended'), delay(40, 'pending')]), 'pending');
  } finally { held.release(); await stopping; }
  assert.deepEqual(await readdir(f.folder), []);
});

test('stop does not declare quiescence after eight seconds while captions still owns work', async () => {
  const f = await fixture('long-captions'); const entered = gate(); const held = gate();
  const q = createExports({ captions: async () => { entered.release(); await held.promise; return cues; } });
  q.start(f.project, { kind: 'subtitles' }, { folder: f.folder }); await entered.promise;
  const stopping = q.stopAll(); let settled = false; stopping.then(() => { settled = true; });
  try { await delay(8200); assert.equal(settled, false); }
  finally { held.release(); await delay(100); await stopping; }
  assert.deepEqual(await readdir(f.folder), []);
});

test('project folder cancellation at real copy progress never publishes a final folder', async () => {
  const f = await fixture('project-copy');
  await writeFile(join(f.project.path, 'note.txt'), 'ordinary project bytes');
  const published = []; let q; let copied = false;
  q = createExports({ onChange(job) {
    if (job.phase === 'copying' && job.progress === 0.99) { copied = true; q.stopAll(); }
    if (job.out) published.push(job.out);
  } });
  q.start(f.project, { kind: 'project', as: 'folder' }, { folder: f.folder });
  while (!copied) await delay(10);
  await q.stopAll();
  assert.equal(published.length, 0, 'no final publication after cancellation');
  assert.deepEqual(await readdir(f.folder), []);
});

test('reentrant waiting callback fences the rest of startAll and returns identical stop promise', async () => {
  const f = await fixture('reentrant'); let q; let stop; const seen = [];
  q = createExports({ onChange(job) { seen.push(job.status); if (job.status === 'waiting') stop = q.stopAll(); } });
  assert.throws(() => q.startAll(f.project, { jobs: [{ kind: 'subtitles' }, { kind: 'subtitles' }], folder: f.folder }), ExportError);
  assert.equal(q.stopAll(), stop); await stop;
  assert.equal(q.list(f.project.id).length, 1); assert.equal(q.busy(), false);
  assert.deepEqual(seen, ['waiting', 'cancelled']);
});

// REAL Node child, original one-shot wire, ordinary text only: never a media encoder.
const children = { created: 0, exits: 0, closes: 0, live: 0, peak: 0, pids: [], owners: [] };
function ownership(child, script) {
  const owner = { pid: child.pid, script, created: Date.now(), events: [] };
  children.owners.push(owner);
  child.once('exit', (code, signal) => owner.events.push({ event: 'exit', code, signal, at: Date.now() }));
  child.once('close', (code, signal) => owner.events.push({ event: 'close', code, signal, at: Date.now() }));
}
async function rendererFixture(name, type = 'done') {
  const script = join(profile.paths.temp, `${name}.cjs`);
  const release = join(profile.paths.temp, `${name}.release`);
  await writeFile(script, `const fs=require('node:fs');
process.on('message', async m => {
 if(!m.args || !m.opts) return;
 fs.writeFileSync(m.opts.out, 'ordinary text, NOT encoded media');
 process.send({type:'progress',done:1,total:1});
 process.send(${JSON.stringify(type)} === 'done' ? {type:'done',result:{out:m.opts.out,encoder:'libx264',lines:[]}} : {type:'failed',error:'fixture failure'});
 const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stderr.write('owned fixture stderr tail\\n');process.disconnect();}},10);
});`);
  let child; const sent = gate(); const closed = gate();
  return { sent, closed, release: () => writeFile(release, 'release'), get child() { return child; },
    forkRenderer(modulePath, args, options) {
      assert.ok(modulePath.endsWith('render-worker.mjs')); assert.deepEqual(args, []);
      child = fork(script, args, options); ownership(child, script); children.created++; children.live++; children.peak = Math.max(children.peak, children.live); children.pids.push(child.pid);
      assert.ok(children.live <= 2);
      child.on('message', m => { if (m.type === type) sent.release(); });
      child.on('exit', () => { children.exits++; });
      child.on('close', () => { children.closes++; children.live--; closed.release(); });
      return child;
    }
  };
}
for (const type of ['done', 'failed']) test(`real renderer ${type} IPC is not completion while its owned process remains alive`, async () => {
  const f = await fixture(`child-${type}`); const renderer = await rendererFixture(type, type);
  const q = createExports({ trustedNode: { forkRenderer: renderer.forkRenderer, encoders: async () => new Set(['libx264']) } });
  q.start(f.project, { kind: 'video', codec: 'h264', hardware: false, burnSubtitles: false }, { folder: f.folder });
  await renderer.sent.promise;
  await delay(30); const stop = q.stopAll();
  try { assert.equal(await Promise.race([stop.then(() => 'ended'), delay(80, 'pending')]), 'pending'); }
  finally { await renderer.release(); await renderer.closed.promise; await stop; }
  assert.equal(children.live, 0);
});

test('entered final copy remains owned through cancellation and its real cleanup tail', async () => {
  const f = await fixture('fs-gates'); const entered = gate(); const held = gate(); const cleaning = gate(); const cleanHeld = gate();
  const q = createExports({ trustedNode: { fs: {
    async copyFile(...args) { entered.release(); await held.promise; return nativeFs.copyFile(...args); },
    async rm(...args) { cleaning.release(); await cleanHeld.promise; return nativeFs.rm(...args); }
  } } });
  q.start(f.project, { kind: 'project', as: 'folder' }, { folder: f.folder }); await entered.promise;
  const stop = q.stopAll();
  assert.equal(await Promise.race([stop.then(() => 'ended'), delay(30, 'pending')]), 'pending');
  held.release(); await cleaning.promise;
  assert.equal(await Promise.race([stop.then(() => 'ended'), delay(30, 'pending')]), 'pending');
  cleanHeld.release(); await stop; assert.deepEqual(await readdir(f.folder), []);
});

test('cleanup failure remains observable and does not claim an owned partial disappeared', async () => {
  const f = await fixture('cleanup-failure'); const entered = gate(); const held = gate();
  const q = createExports({ trustedNode: { fs: {
    async copyFile(...args) { entered.release(); await held.promise; return nativeFs.copyFile(...args); },
    async rm() { throw new Error('owned cleanup denied'); }
  } } });
  q.start(f.project, { kind: 'project', as: 'folder' }, { folder: f.folder }); await entered.promise;
  const stop = q.stopAll(); const refused = assert.rejects(stop, AggregateError);
  held.release(); await refused;
  assert.ok((await readdir(f.folder)).some(n => n.includes('.partial-')));
});

test('actual project zip retains ordinary source bytes and native zip format', async () => {
  const f = await fixture('zip'); const ended = gate();
  await writeFile(join(f.project.path, 'ordinary.txt'), 'plain handoff text');
  const q = createExports({ onChange: job => { if (job.status === 'done' || job.status === 'failed') ended.release(job); } });
  q.start(f.project, { kind: 'project', as: 'zip' }, { folder: f.folder }); const job = await ended.promise;
  assert.equal(job.status, 'done', job.error); const bytes = await readFile(job.out);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50); assert.ok(bytes.includes(Buffer.from('ordinary.txt')));
  await q.stopAll();
});

test('running preparing callback can stop without losing entered task completion', async () => {
  const f = await fixture('prepare-stop'); let q; let stop; const seen = [];
  q = createExports({ onChange(job) { seen.push(job.status); if (job.phase === 'preparing') stop = q.stopAll(); }, captions: async () => { throw new Error('must not enter after known abort'); } });
  q.start(f.project, { kind: 'subtitles' }, { folder: f.folder });
  while (!stop) await delay(5); await stop;
  assert.equal(q.busy(), false); assert.deepEqual(await readdir(f.folder), []);
});

test('immediate stop cannot forget a task already entered before its running notification', async () => {
  const f = await fixture('early-stop'); const statuses = []; let captionCalls = 0;
  const q = createExports({ onChange: job => statuses.push(job.status), captions: async () => { captionCalls++; return cues; } });
  q.start(f.project, { kind: 'subtitles' }, { folder: f.folder });
  await q.stopAll(); const atStop = [...statuses]; await delay(60);
  assert.deepEqual(statuses, atStop, 'no callbacks or IO remain after stop settles');
  assert.equal(captionCalls, 0);
});

test('entered real rename completes before stop and its moved destination is cleaned after cancellation', async () => {
  const f = await fixture('rename-gate'); const entered = gate(); const held = gate();
  const q = createExports({ trustedNode: { fs: { async rename(...args) { entered.release(); await held.promise; return nativeFs.rename(...args); } } } });
  q.start(f.project, { kind: 'project', as: 'folder' }, { folder: f.folder }); await entered.promise;
  const stop = q.stopAll();
  assert.equal(await Promise.race([stop.then(() => 'ended'), delay(40, 'pending')]), 'pending');
  held.release(); await stop; assert.deepEqual(await readdir(f.folder), []);
});

test('independent factories own only their own actual child and preserve normal successful output', async () => {
  const a = await fixture('isolation-a'), b = await fixture('isolation-b');
  const ra = await rendererFixture('isolation-a'), rb = await rendererFixture('isolation-b');
  const ended = gate();
  const qa = createExports({ trustedNode: { forkRenderer: ra.forkRenderer, encoders: async () => new Set(['libx264']) } });
  const qb = createExports({ onChange: job => { if (job.status === 'done' || job.status === 'failed') ended.release(job); }, trustedNode: { forkRenderer: rb.forkRenderer, encoders: async () => new Set(['libx264']) } });
  const ask = { kind: 'video', codec: 'h264', hardware: false, burnSubtitles: false };
  qa.start(a.project, ask, { folder: a.folder }); qb.start(b.project, ask, { folder: b.folder });
  await Promise.all([ra.sent.promise, rb.sent.promise]); const sa = qa.stopAll();
  await ra.release(); await sa;
  assert.equal(rb.child.exitCode, null); assert.equal(qb.busy(), true);
  await rb.release(); const job = await ended.promise; await qb.stopAll();
  assert.equal(job.status, 'done', job.error); assert.equal(await readFile(job.out, 'utf8'), 'ordinary text, NOT encoded media');
  assert.equal(children.live, 0);
});

test('throwing cancellation callbacks cannot abandon another queued or running operation', async () => {
  const f = await fixture('callbacks'); const entered = gate(); const held = gate(); let reentered;
  const q = createExports({ captions: async () => { entered.release(); await held.promise; return cues; }, onChange(job) {
    if (job.status === 'cancelled') { reentered = q.stopAll(); throw new Error('observer failure'); }
  } });
  q.startAll(f.project, { jobs: [{ kind: 'subtitles' }, { kind: 'subtitles' }], folder: f.folder }); await entered.promise;
  const stop = q.stopAll(); const rejected = assert.rejects(stop, AggregateError);
  assert.equal(reentered, stop);
  assert.equal(await Promise.race([stop.then(() => 'ended', () => 'failed'), delay(30, 'pending')]), 'pending');
  held.release(); await rejected; assert.equal(q.busy(), false); assert.deepEqual(await readdir(f.folder), []);
});

test('batch notification error propagates without leaving earlier admitted work orphaned', async () => {
  const f = await fixture('batch-notify'); let calls = 0;
  const q = createExports({ captions: async () => cues, onChange(job) { if (job.status === 'waiting' && ++calls === 2) throw new Error('second observer'); } });
  assert.throws(() => q.startAll(f.project, { jobs: [{ kind: 'subtitles' }, { kind: 'subtitles' }], folder: f.folder }), /second observer/);
  await assert.rejects(q.stopAll(), AggregateError); assert.equal(q.busy(), false);
});

after(async () => {
  assert.equal(children.live, 0);
  assert.equal(children.created, children.exits);
  assert.equal(children.created, children.closes);
  for (const owner of children.owners) owner.scriptSha256 = createHash('sha256').update(await readFile(owner.script)).digest('hex');
  await writeFile(join(profile.root, 'child-receipt.json'), JSON.stringify({ ...children, profile: profile.root, actualMediaPassed: false }, null, 2));
  console.log(`EXPORTS_CHILD created=${children.created} exits=${children.exits} closes=${children.closes} peak=${children.peak} final=${children.live}`);
});

test('ignored cancel escalates only the fresh owned fixture PID and still waits for actual close', async () => {
  const f = await fixture('ignored-cancel'); const r = await rendererFixture('ignored-cancel');
  const q = createExports({ trustedNode: { forkRenderer: r.forkRenderer, encoders: async () => new Set(['libx264']) } });
  q.start(f.project, { kind: 'video', codec: 'h264', hardware: false, burnSubtitles: false }, { folder: f.folder }); await r.sent.promise;
  const stop = q.stopAll();
  assert.equal(await Promise.race([stop.then(() => 'ended'), delay(100, 'pending')]), 'pending');
  await stop; await r.closed.promise; assert.equal(children.live, 0); assert.deepEqual(await readdir(f.folder), []);
});

test('actual clone copy remains owned and cancellation preserves the earlier completed export', async () => {
  const f = await fixture('clone'); const r = await rendererFixture('clone'); const entered = gate(), held = gate();
  const q = createExports({ trustedNode: { forkRenderer: r.forkRenderer, encoders: async () => new Set(['libx264']), fs: {
    async copyFile(...args) { entered.release(); await held.promise; return nativeFs.copyFile(...args); }
  } } });
  const ask = { kind: 'video', codec: 'h264', hardware: false, burnSubtitles: false };
  q.startAll(f.project, { jobs: [{ ...ask, label: 'a' }, { ...ask, label: 'b' }], folder: f.folder });
  await r.sent.promise; await r.release(); await entered.promise;
  const stop = q.stopAll(); assert.equal(await Promise.race([stop.then(() => 'ended'), delay(40, 'pending')]), 'pending');
  held.release(); await stop;
  const jobs = q.list(f.project.id); assert.deepEqual(jobs.map(j => j.status), ['cancelled', 'done']);
  assert.equal(await readFile(jobs[1].out, 'utf8'), 'ordinary text, NOT encoded media');
  assert.equal((await readdir(f.folder)).length, 1);
});

test('actual exit and stderr tail are followed by close before stop resolves', async () => {
  const f = await fixture('exit-close'); const script = join(profile.paths.temp, 'exit-close.cjs'); const exited = gate(), closed = gate(); let child; const events=[]; let stop;
  await writeFile(script, `const fs=require('node:fs'); process.on('message',m=>{if(!m.opts)return;fs.writeFileSync(m.opts.out,'ordinary bytes');process.send({type:'done',result:{out:m.opts.out,encoder:'libx264',lines:[]}},()=>{process.stderr.write('tail before exit\\n');process.exit(0);});});`);
  const q = createExports({ trustedNode: { encoders: async () => new Set(['libx264']), forkRenderer(modulePath,args,options) {
    child = fork(script,args,options); ownership(child, script); children.created++; children.live++; children.peak=Math.max(children.peak,children.live); children.pids.push(child.pid);
    child.stderr.on('data',()=>events.push('stderr')); child.once('exit',()=>{children.exits++; events.push('exit'); stop=q.stopAll(); stop.then(()=>events.push('stopped')); exited.release();}); child.once('close',()=>{children.closes++; children.live--; events.push('close'); closed.release();}); return child;
  } } });
  q.start(f.project, { kind:'video', codec:'h264', hardware:false, burnSubtitles:false }, { folder:f.folder });
  await exited.promise; await stop; await closed.promise;
  assert.ok(events.indexOf('exit') < events.indexOf('close'));
  assert.ok(events.indexOf('stderr') < events.indexOf('stopped'));
  assert.ok(events.indexOf('close') < events.indexOf('stopped'));
});

test('synchronous renderer factory failure produces a failed job without orphan ownership', async () => {
  const f=await fixture('fork-throw'); const ended=gate();
  const q=createExports({onChange:job=>{if(job.status==='failed')ended.release(job);},trustedNode:{encoders:async()=>new Set(['libx264']),forkRenderer(){throw new Error('owned fork refused');}}});
  q.start(f.project,{kind:'video',codec:'h264',hardware:false,burnSubtitles:false},{folder:f.folder});
  const job=await ended.promise; assert.match(job.error,/owned fork refused/); await q.stopAll(); assert.equal(q.busy(),false);
});

test('a throwing running callback retains original failed-job semantics and drains other work', async () => {
  const f=await fixture('running-throw');const ended=gate();
  const q=createExports({captions:async()=>cues,onChange(job){if(job.phase==='preparing')throw new Error('prepare observer');if(job.status==='failed'||job.status==='done')ended.release(job);}});
  q.start(f.project,{kind:'subtitles'},{folder:f.folder}); const job=await ended.promise;
  await assert.rejects(q.stopAll(),AggregateError); assert.equal(job.status,'failed'); assert.match(job.error,/prepare observer/);
});

test('trusted Node seams reject malformed and accessor surfaces before invoking external code', () => {
  let invoked=0;
  for(const trustedNode of [null, [], {oops:()=>{}}, {fs:[]}, {get encoders(){invoked++;return ()=>{};}}]) {
    assert.throws(()=>createExports({trustedNode}), error=>error instanceof ExportError && error.message==='invalid trusted Node functions');
  }
  assert.equal(invoked,0);
});

test('done IPC followed by abnormal actual exit fails rather than publishing the part', async () => {
  const f=await fixture('abnormal');const r=await rendererFixture('abnormal');const ended=gate();
  const file=join(profile.paths.temp,'abnormal.cjs');await writeFile(file,(await readFile(file,'utf8')).replace('process.disconnect();','process.exit(7);'));
  const q=createExports({onChange:job=>{if(job.status==='failed'||job.status==='done')ended.release(job);},trustedNode:{forkRenderer:r.forkRenderer,encoders:async()=>new Set(['libx264'])}});
  q.start(f.project,{kind:'video',codec:'h264',hardware:false,burnSubtitles:false},{folder:f.folder});await r.sent.promise;await r.release();
  const job=await ended.promise;await q.stopAll();assert.equal(job.status,'failed');assert.match(job.error,/exit 7/);assert.deepEqual(await readdir(f.folder),[]);
});

test('actual child send failure still owns the process until its cancellation close', async () => {
  const f=await fixture('send-failure');const r=await rendererFixture('send-failure');const ended=gate();
  const file=join(profile.paths.temp,'send-failure.cjs');await writeFile(file,(await readFile(file,'utf8')).replace('if(!m.args || !m.opts) return;',"if(m.type==='cancel'){process.disconnect();return;} if(!m.args || !m.opts) return;"));
  const q=createExports({onChange:job=>{if(job.status==='failed')ended.release(job);},trustedNode:{encoders:async()=>new Set(['libx264']),forkRenderer(...args){
    const child=r.forkRenderer(...args);const send=child.send.bind(child);let first=true;
    child.send=(...message)=>{if(first){first=false;throw new Error('owned IPC send refused');}return send(...message);};return child;
  }}});
  q.start(f.project,{kind:'video',codec:'h264',hardware:false,burnSubtitles:false},{folder:f.folder});const job=await ended.promise;await q.stopAll();
  assert.match(job.error,/owned IPC send refused/);await r.closed.promise;assert.equal(children.live,0);
});

test('subtitle publication callback cancellation cannot write after the fence', async () => {
  const f=await fixture('subtitle-publication');let q;let stop;const published=[];
  q=createExports({captions:async()=>cues,onChange(job){if(job.out)published.push(job.out);if(job.encoder==='srt'&&!stop)stop=q.stopAll();}});
  q.start(f.project,{kind:'subtitles'},{folder:f.folder});while(!stop)await delay(5);await stop;assert.deepEqual(published,[]);
  assert.deepEqual(await readdir(f.folder),[]);
});

test('actual asynchronous spawn error retains ownership through close without inventing a started Node process', async () => {
  const f = await fixture('async-spawn-error');
  const missing = join(profile.paths.temp, 'deliberately-absent-node.exe');
  await assert.rejects(nativeFs.stat(missing), { code: 'ENOENT' });
  const receipt = { attempts: 0, startedNode: 0, exits: 0, closes: 0, errors: [], events: [], execPath: missing };
  const observed = gate(); let child; let stopping;
  const q = createExports({ trustedNode: {
    encoders: async () => new Set(['libx264']),
    forkRenderer(modulePath, args, options) {
      receipt.attempts++;
      child = fork(modulePath, args, { ...options, execPath: missing });
      child.once('spawn', () => { receipt.startedNode++; });
      child.on('error', error => {
        receipt.errors.push({ code: error.code, message: error.message });
        receipt.events.push('error');
        stopping ??= q.stopAll();
        stopping.then(() => receipt.events.push('stopped'));
        observed.release();
      });
      child.once('exit', () => { receipt.exits++; receipt.events.push('exit'); });
      child.once('close', () => { receipt.closes++; receipt.events.push('close'); });
      return child;
    }
  } });
  q.start(f.project, { kind: 'video', codec: 'h264', hardware: false, burnSubtitles: false }, { folder: f.folder });
  await observed.promise; await stopping;
  assert.equal(q.stopAll(), stopping);
  assert.equal(child.pid, undefined);
  assert.equal(receipt.attempts, 1);
  assert.equal(receipt.startedNode, 0);
  assert.equal(receipt.exits, 0);
  assert.equal(receipt.closes, 1);
  assert.equal(receipt.errors[0].code, 'ENOENT');
  assert.ok(receipt.events.indexOf('error') < receipt.events.indexOf('close'));
  assert.ok(receipt.events.indexOf('close') < receipt.events.indexOf('stopped'));
  // Stop during error delivery retains the native cancellation precedence, not a fabricated successful job.
  assert.equal(q.list(f.project.id)[0].status, 'cancelled');
  assert.equal(q.busy(), false);
  assert.deepEqual(await readdir(f.folder), []);
  await writeFile(join(profile.root, 'spawn-error-receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(`EXPORTS_SPAWN attempts=${receipt.attempts} started=${receipt.startedNode} exits=${receipt.exits} closes=${receipt.closes} error=${receipt.errors[0].code}`);
});

test('waiting callback reentrant start then throw cannot detach an entered operation from stop', async () => {
  const a = await fixture('waiting-throw-a'), b = await fixture('waiting-throw-b');
  const entered = gate(), held = gate(); const events = []; let q; let nested = false;
  q = createExports({ captions: async root => { events.push({ type: 'captions', root }); entered.release(); await held.promise; return cues; }, onChange(job) {
    events.push({ type: job.status, project: job.project });
    if (job.project === a.project.id && job.status === 'waiting' && !nested) {
      nested = true; q.start(b.project, { kind: 'subtitles' }, { folder: b.folder }); throw new Error('waiting observer threw after reentrant start');
    }
  } });
  assert.throws(() => q.start(a.project, { kind: 'subtitles' }, { folder: a.folder }), /waiting observer threw/);
  await entered.promise;
  const stop = q.stopAll(); const ending = stop.then(() => 'ended', () => 'failed');
  try { assert.equal(await Promise.race([ending, delay(40, 'pending')]), 'pending'); }
  finally { held.release(); await ending; await delay(50); }
  await assert.rejects(stop, AggregateError);
  const count = events.length; await delay(30); assert.equal(events.length, count);
  assert.equal(q.busy(), false); assert.deepEqual(await readdir(a.folder), []); assert.deepEqual(await readdir(b.folder), []);
});

test('synchronous owned output removal failure is retained and does not escape task completion', async () => {
  const f = await fixture('sync-rm'); const r = await rendererFixture('sync-rm'); const removed = [];
  const q = createExports({ trustedNode: { encoders: async () => new Set(['libx264']), forkRenderer: r.forkRenderer, fs: {
    rm(file, options) { removed.push(file); if (file.startsWith(f.folder) && file.includes('.partial-')) throw new Error('synchronous owned output rm failure'); return nativeFs.rm(file, options); }
  } } });
  q.start(f.project, { kind: 'video', codec: 'h264', hardware: false, burnSubtitles: false }, { folder: f.folder }); await r.sent.promise;
  const stop = q.stopAll(); const ending = stop.then(() => 'ended', () => 'failed');
  await r.release(); await ending;
  await assert.rejects(stop, AggregateError);
  assert.equal(q.busy(), false); assert.equal(removed.length, 1);
  assert.deepEqual(q.list(f.project.id)[0].outputs, removed);
  assert.ok((await readdir(f.folder)).some(name => name.includes('.partial-')));
});

test('synchronous staging tidy failure is observable without abandoning real copied files', async () => {
  const f = await fixture('sync-tidy'); const entered = gate(), held = gate(); const attempted = [];
  const q = createExports({ trustedNode: { fs: {
    async copyFile(...args) { entered.release(); await held.promise; return nativeFs.copyFile(...args); },
    rm(file, options) { attempted.push(file); if (file.startsWith(f.folder) && file.includes('.partial-')) throw new Error('synchronous staging tidy failure'); return nativeFs.rm(file, options); }
  } } });
  q.start(f.project, { kind: 'project', as: 'folder' }, { folder: f.folder }); await entered.promise;
  const stop = q.stopAll(); const rejected = assert.rejects(stop, AggregateError);
  held.release(); await rejected;
  assert.equal(q.busy(), false); assert.equal(attempted.length, 1);
  const remaining = await readdir(f.folder); assert.equal(remaining.length, 1); assert.ok(remaining[0].includes('.partial-'));
  assert.ok((await readdir(join(f.folder, remaining[0]))).length > 0);
});

async function nativeOutputJob(f, outputs) {
  let q; q = createExports({ onChange(job) { if (job.status === 'waiting') q.stopAll(); } });
  const job = q.start(f.project, { kind: 'subtitles' }, { folder: f.folder }); await q.stopAll();
  job.outputs = [...outputs]; job.out = outputs[0]; return job;
}

test('shared native rename keeps earlier outputs owned when cancellation arrives during a second real rename', async () => {
  const f = await fixture('rename-multiple'); const first = join(f.folder, 'first.txt'), part = join(f.folder, 'second.partial'), out = join(f.folder, 'second.txt');
  await writeFile(first, 'earlier ordinary output'); await writeFile(part, 'current ordinary output');
  const job = await nativeOutputJob(f, [first, part]); const abort = new AbortController(); const entered = gate(), held = gate();
  const operation = renameOutput(job, part, out, abort.signal, async (...args) => { entered.release(); await held.promise; return nativeFs.rename(...args); });
  const result = operation.then(() => 'done', () => 'cancelled'); await entered.promise; abort.abort();
  try { assert.equal(await Promise.race([result, delay(30, 'pending')]), 'pending'); }
  finally { held.release(); await result; }
  await assert.rejects(operation, /cancelled/);
  assert.deepEqual(job.outputs, [first, out]); assert.equal(job.out, first);
  assert.equal(await readFile(first, 'utf8'), 'earlier ordinary output'); assert.equal(await readFile(out, 'utf8'), 'current ordinary output');
  await assert.rejects(nativeFs.stat(part), { code: 'ENOENT' });
  // These files are intentionally retained as direct-helper evidence, not a claim of queue/media cleanup.
});

test('shared native rename accounts for its first output after actual success', async () => {
  const f = await fixture('rename-first'); const part = join(f.folder, 'first.partial'), out = join(f.folder, 'first.txt');
  await writeFile(part, 'ordinary first'); const job = await nativeOutputJob(f, [part]);
  await renameOutput(job, part, out, new AbortController().signal);
  assert.deepEqual(job.outputs, [out]); assert.equal(job.out, out); assert.equal(await readFile(out, 'utf8'), 'ordinary first');
});

test('shared native rename preserves earlier output order on normal second completion', async () => {
  const f = await fixture('rename-normal'); const first = join(f.folder, 'first.txt'), part = join(f.folder, 'second.partial'), out = join(f.folder, 'second.txt');
  await writeFile(first, 'first'); await writeFile(part, 'second'); const job = await nativeOutputJob(f, [first, part]);
  await renameOutput(job, part, out, new AbortController().signal);
  assert.deepEqual(job.outputs, [first, out]); assert.equal(job.out, first); assert.equal(await readFile(out, 'utf8'), 'second');
});

test('shared native rename failure never invents ownership of an unwritten destination', async () => {
  const f = await fixture('rename-failed'); const first = join(f.folder, 'first.txt'), part = join(f.folder, 'missing.partial'), out = join(f.folder, 'unwritten.txt');
  await writeFile(first, 'first'); const job = await nativeOutputJob(f, [first, part]);
  await assert.rejects(renameOutput(job, part, out, new AbortController().signal), { code: 'ENOENT' });
  assert.deepEqual(job.outputs, [first, part]); assert.equal(job.out, first); await assert.rejects(nativeFs.stat(out), { code: 'ENOENT' });
});
