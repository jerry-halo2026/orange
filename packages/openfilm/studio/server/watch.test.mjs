import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revOf } from './film.mjs';
import { createWatchers, watchFolder, watchTree } from './watch.mjs';

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const until = async (ready) => {
  for (const end = Date.now() + 4000; !ready() && Date.now() < end;) await settle(25);
  assert.ok(ready(), 'the presence change was reported');
};

test('a deleted film is said missing once, never gone, while its folder remains; no empty film is published', async () => {
  const root = mkdtempSync(join(tmpdir(), 'of-watch-film-gone-'));
  writeFileSync(join(root, 'film.html'), 'original');
  mkdirSync(join(root, '.film'));
  const seen = [];
  const stop = watchFolder(root, (event) => seen.push(event));
  try {
    await settle(600);
    seen.length = 0;
    rmSync(join(root, 'film.html'));
    await until(() => seen.some((e) => e.type === 'film-missing'));
    writeFileSync(join(root, '.film', 'cache'), 'cache written after deletion');
    await settle(2200);
    assert.deepEqual(seen, [{ type: 'film-missing' }]);
  } finally {
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a film deleted and written again seconds later (an agent replacing it whole) comes back as a film, the same text too', async () => {
  const root = mkdtempSync(join(tmpdir(), 'of-watch-film-back-'));
  writeFileSync(join(root, 'film.html'), 'original');
  const seen = [];
  const stop = watchFolder(root, (event) => seen.push(event));
  try {
    await settle(600);
    seen.length = 0;
    rmSync(join(root, 'film.html'));
    await until(() => seen.some((e) => e.type === 'film-missing'));
    await settle(1500);
    writeFileSync(join(root, 'film.html'), 'original');
    await until(() => seen.some((e) => e.type === 'film'));
    assert.deepEqual(seen, [{ type: 'film-missing' }, { type: 'film', rev: revOf('original') }]);
    /* gone again, then for good with its folder: gone */
    rmSync(root, { recursive: true, force: true });
    await until(() => seen.some((e) => e.type === 'gone'));
  } finally {
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a film briefly removed during a save is refreshed, without closing its editor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'of-watch-save-'));
  writeFileSync(join(root, 'film.html'), 'before');
  const seen = [];
  const stop = watchFolder(root, (event) => seen.push(event));
  try {
    await settle(600);
    seen.length = 0;
    rmSync(join(root, 'film.html'));
    await settle(200);
    writeFileSync(join(root, 'film.html'), 'after');
    await until(() => seen.some((e) => e.type === 'film' && e.rev === revOf('after')));
    assert.ok(!seen.some((e) => e.type === 'gone' || (e.type === 'film' && e.rev === revOf(''))));
  } finally {
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('presence is checked even when no native watcher could start, and stops on unsubscribe', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'of-watch-missing-'));
  const seen = [];
  const stop = watchFolder(join(scratch, 'gone-before-subscribe'), (event) => seen.push(event));
  try {
    await until(() => seen.some((e) => e.type === 'gone'));
  } finally { await stop(); }
  const cancelled = [];
  const cancel = watchFolder(join(scratch, 'also-gone'), (event) => cancelled.push(event));
  await cancel();
  await settle(1600);
  assert.deepEqual(cancelled, []);
  rmSync(scratch, { recursive: true, force: true });
});

test('film.html changes come with their revision, other files as one files event; .film/ is not watched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'of-watch-'));
  writeFileSync(join(root, 'film.html'), '{"stage":{"w":1,"h":1},"tracks":[]}');
  mkdirSync(join(root, '.film'));
  mkdirSync(join(root, 'assets'));
  const watchers = createWatchers();
  const seen = [];
  const stop = watchers.subscribe(root, (e) => seen.push(e));
  try {
  /* macOS reports the folder's own creation a moment late: let it pass before the writes this test counts */
  await settle(600);
  seen.length = 0;

  const text = '{"stage":{"w":2,"h":2},"tracks":[]}';
  writeFileSync(join(root, 'film.html'), text);
  writeFileSync(join(root, 'assets', 'a.wav'), 'x');
  writeFileSync(join(root, 'assets', 'b.wav'), 'y');
  await settle();
  assert.deepEqual(seen.find((e) => e.type === 'film'), { type: 'film', rev: revOf(text) });
  assert.equal(seen.filter((e) => e.type === 'files').length, 1, 'several files settle into one event');

  seen.length = 0;
  writeFileSync(join(root, 'film.html'), text);
  writeFileSync(join(root, '.film', 'cache'), 'z');
  await settle();
  assert.deepEqual(seen, [], 'the same text again, and Studio\'s own folder, are no change');

  /* Studio's own half-written siblings (atomic.mjs, the asset index) */
  writeFileSync(join(root, 'film.html.0123456789ab.tmp'), text);
  writeFileSync(join(root, 'assets', 'index.jsonl.123e4567-e89b-12d3-a456-426614174000.tmp'), '');
  await settle();
  assert.deepEqual(seen, [], 'Studio\'s own half-written files are no change');
  } finally {
    await stop();
    await watchers.drain();
  }
});

test('watching folder by folder (Linux): a file replaced by a rename is seen every time, and new folders are taken in', async () => {
  const root = mkdtempSync(join(tmpdir(), 'of-tree-'));
  writeFileSync(join(root, 'film.html'), '{}');
  mkdirSync(join(root, 'node_modules'));
  const names = new Set();
  const close = watchTree(root, (name) => names.add(name), false);
  try {
    for (const n of [1, 2]) {
      writeFileSync(join(root, `film.html.${n}.tmp`), `{"n":${n}}`);
      renameSync(join(root, `film.html.${n}.tmp`), join(root, 'film.html'));
      await settle(150);
      assert.ok(names.has('film.html'), `replacement ${n} seen`);
      names.clear();
    }
    mkdirSync(join(root, 'scenes'));
    await settle(150);
    writeFileSync(join(root, 'scenes', 'a.html'), '<p>');
    writeFileSync(join(root, 'node_modules', 'x.js'), '');
    await settle(150);
    assert.ok(names.has('scenes/a.html'), 'a file in a folder made while watching');
    assert.ok(![...names].some((n) => n?.startsWith('node_modules/')), 'ignored folders are not watched');
  } finally {
    await close();
  }
});


test('renamed folders keep their listeners and original unsubscribe functions through repeated moves', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'of-watch-rename-'));
  const from = join(scratch, 'Untitled');
  const to = join(scratch, 'Named film');
  const again = join(scratch, 'Final film');
  mkdirSync(from);
  writeFileSync(join(from, 'film.html'), 'initial');
  const watchers = createWatchers();
  const first = [], second = [];
  const stopFirst = watchers.subscribe(from, (event) => first.push(event));
  const stopSecond = watchers.subscribe(from, (event) => second.push(event));
  try {
    await settle(600);
    renameSync(from, to);
    watchers.move(from, to);
    assert.deepEqual(watchers.roots(), [to]);
    await settle(600);
    first.length = second.length = 0;
    writeFileSync(join(to, 'film.html'), 'renamed');
    writeFileSync(join(to, 'scene.html'), '<p>new scene</p>');
    await settle();
    for (const seen of [first, second]) {
      assert.deepEqual(seen.filter((e) => e.type === 'film'), [{ type: 'film', rev: revOf('renamed') }]);
      assert.ok(seen.some((e) => e.type === 'files' && e.paths?.includes('scene.html')));
    }
    const history = { type: 'history' };
    watchers.emit(to, history);
    assert.equal(first.at(-1), history);
    assert.equal(second.at(-1), history);
    stopFirst();
    stopFirst(); // closing the same page twice must not stop the other one
    first.length = second.length = 0;
    renameSync(to, again);
    watchers.move(to, again);
    await settle(600);
    second.length = 0;
    writeFileSync(join(again, 'film.html'), 'renamed again');
    await settle();
    assert.deepEqual(first, [], 'the first page stays unsubscribed after another rename');
    assert.deepEqual(second.filter((e) => e.type === 'film'), [{ type: 'film', rev: revOf('renamed again') }]);
    watchers.emit(from, history);
    watchers.emit(to, history);
    assert.ok(!second.some((e) => e.type === 'history'), 'old paths no longer route events');
    stopSecond();
    assert.deepEqual(watchers.roots(), [], 'the original final unsubscribe closes the moved watcher');
  } finally {
    await watchers.drain();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('moving into an already watched path preserves both subscriptions', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'of-watch-merge-'));
  const from = join(scratch, 'before'), to = join(scratch, 'after');
  mkdirSync(from);
  mkdirSync(to);
  const watchers = createWatchers();
  const first = [], second = [];
  const stopFirst = watchers.subscribe(from, (event) => first.push(event));
  const stopSecond = watchers.subscribe(to, (event) => second.push(event));
  try {
    watchers.move(from, to);
    watchers.move(to, to);
    watchers.move(join(scratch, 'not watched'), to);
    assert.deepEqual(watchers.roots(), [to]);
    watchers.emit(to, { type: 'history' });
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    stopFirst();
    watchers.emit(to, { type: 'history' });
    assert.equal(first.length, 1);
    assert.equal(second.length, 2);
    stopSecond();
    assert.deepEqual(watchers.roots(), []);
  } finally {
    await watchers.drain();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a watched project's folder that goes is said gone; one renamed in Studio (moved) is not", async () => {
  const root = mkdtempSync(join(tmpdir(), 'of-watch-gone-'));
  writeFileSync(join(root, 'film.html'), '{"stage":{"w":1,"h":1},"tracks":[]}');
  const watchers = createWatchers();
  const seen = [];
  const stop = watchers.subscribe(root, (e) => seen.push(e));
  try {
    await settle(600);
    /* renamed by Studio: the watch follows it, and nothing is gone */
    const renamed = `${root}-renamed`;
    renameSync(root, renamed);
    watchers.move(root, renamed);
    await settle(900);
    assert.ok(!seen.some((e) => e.type === 'gone'), JSON.stringify(seen));
    /* deleted (or moved away outside Studio) */
    rmSync(renamed, { recursive: true, force: true });
    await settle(1200);
    assert.ok(seen.some((e) => e.type === 'gone'), JSON.stringify(seen));
  } finally {
    await stop();
  }
});
import { readProjectFilm, settleProjectFilm } from './film.mjs';
import { settleFiles } from './person-edits.mjs';
const enteredWithin = async (promise) => { let timer; try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('work did not enter')), 3500); })]); } finally { clearTimeout(timer); } };
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'of-drain-')); writeFileSync(join(root, 'film.html'), 'initial'); return root; };
const pendingThroughTurn = async (promise) => { let done = false; Promise.resolve(promise).then(() => { done = true; }); await new Promise(r => setImmediate(r)); assert.equal(done, false, 'entered work is still owned'); };

test('drain waits for an entered real initial read and close is stable', async () => {
  const root = fixture(), entered = gate(), release = gate(), seen = []; let read;
  const stop = watchFolder(root, event => seen.push(event), { trustedNode: {
    readProjectFilm: async (...args) => { entered.release(); await release.promise; return read = await readProjectFilm(...args); },
  } });
  try {
    await enteredWithin(entered.promise);
    assert.ok(read === undefined);
    const closed = stop(); assert.ok(closed instanceof Promise); assert.equal(stop(), closed);
    await pendingThroughTurn(closed); release.release(); await closed;
    assert.equal(read.text, 'initial'); assert.deepEqual(seen, []);
  } finally { release.release(); await stop(); rmSync(root, { recursive: true, force: true }); }
});

for (const kind of ['film', 'files']) test(`drain owns entered actual ${kind} settle from native FS events`, async () => {
  const root = fixture(), entered = gate(), release = gate(), seen = []; let completed = false;
  const key = kind === 'film' ? 'settleProjectFilm' : 'settleFiles';
  const original = kind === 'film' ? settleProjectFilm : settleFiles;
  const watchers = createWatchers({ trustedNode: { [key]: async (...args) => { entered.release(); await release.promise; const result = await original(...args); completed = true; return result; } } });
  watchers.subscribe(root, event => seen.push(event));
  try {
    writeFileSync(join(root, kind === 'film' ? 'film.html' : 'page.html'), 'changed');
    await enteredWithin(entered.promise);
    assert.equal(typeof watchers.drain, 'function');
    const draining = watchers.drain(); assert.equal(watchers.drain(), draining);
    await pendingThroughTurn(draining); release.release(); await enteredWithin(draining); assert.equal(completed, true); assert.deepEqual(seen, []);
  } finally { release.release(); if (watchers.drain) await watchers.drain(); else watchers.closeAll(); rmSync(root, { recursive: true, force: true }); }
});

test('terminal drain owns retired roots, parallel reads, and stale unsubscribe cannot close a fresh membership', async () => {
  const a = fixture(), b = fixture(), release = gate(), seen = []; let entered = 0, completed = 0;
  const watchers = createWatchers({ trustedNode: { readProjectFilm: async (...args) => { entered++; await release.promise; const value = await readProjectFilm(...args); completed++; return value; } } });
  try {
    const stale = watchers.subscribe(a, () => {}); watchers.subscribe(b, () => {});
    watchers.closeAll(); watchers.subscribe(a, () => {}); stale();
    assert.deepEqual(watchers.roots(), [a]);
    await new Promise(r => setImmediate(r)); assert.equal(entered, 3);
    const draining = watchers.drain(); await pendingThroughTurn(draining);
    watchers.subscribe(b, event => seen.push(event)); watchers.move(a, b); watchers.emit(a, { type: 'history' });
    assert.deepEqual(watchers.roots(), []); release.release(); await enteredWithin(draining); assert.equal(completed, 3); assert.deepEqual(seen, []);
  } finally { release.release(); if (watchers.drain) await watchers.drain(); else watchers.closeAll(); for (const root of [a,b]) rmSync(root, { recursive: true, force: true }); }
});

// Instrument real Node watchers only: native close still runs, but its actual emitted
// close notification is held before the producer's listener. No fake watcher/IO.
const observeActualWatchers = () => {
  const original = fs.watch, records = []; let released = false;
  fs.watch = function (...args) {
    const watcher = Reflect.apply(original, fs, args), emit = watcher.emit;
    const delivered = gate();
    const record = { watcher, observed: 0, delivered: 0, pending: [], done: delivered.promise };
    records.push(record);
    watcher.emit = function (event, ...values) {
      if (event !== 'close') return Reflect.apply(emit, this, [event, ...values]);
      record.observed++;
      const forward = () => { record.delivered++; Reflect.apply(emit, watcher, [event, ...values]); delivered.release(); };
      if (released) forward(); else record.pending.push(forward);
      return true;
    };
    return watcher;
  };
  syncBuiltinESMExports();
  const release = () => { released = true; for (const record of records) for (const forward of record.pending.splice(0)) forward(); };
  return { records, release, async restore() {
    release();
    try { for (const { watcher } of records) watcher.close(); await enteredWithin(Promise.all(records.map(r => r.done))); }
    finally { fs.watch = original; syncBuiltinESMExports(); }
  } };
};

for (const native of [true, false]) test(`actual ${native ? 'native' : 'fallback'} close event gates completion and reentrant close forbids handle growth`, async () => {
  const root = fixture(), entered = gate(), observed = observeActualWatchers(); let closing; let calls = 0;
  const stop = watchTree(root, () => { calls++; closing = stop(); entered.release(); }, native);
  try {
    assert.equal(observed.records.length, 1, 'one actual root watcher');
    mkdirSync(join(root, 'child')); await enteredWithin(entered.promise);
    await until(() => observed.records.every(r => r.observed === 1));
    assert.equal(observed.records.length, 1, 'no fallback child watcher after reentry');
    assert.equal(observed.records[0].delivered, 0);
    assert.ok(closing instanceof Promise); assert.equal(stop(), closing);
    await pendingThroughTurn(closing);
    observed.release(); await enteredWithin(closing);
    assert.ok(observed.records.every(r => r.delivered === 1));
    writeFileSync(join(root, 'child', 'later.txt'), 'later'); await settle(160);
    assert.equal(calls, 1); assert.equal(observed.records.length, 1);
  } finally { observed.release(); try { await enteredWithin(stop()); } finally { await observed.restore(); rmSync(root, { recursive: true, force: true }); } }
});

test('manager drain waits for real native watcher close notification separately from initial IO', async () => {
  const root = fixture(), ready = gate(), observed = observeActualWatchers(), seen = [];
  const watchers = createWatchers({ trustedNode: { readProjectFilm: async (...args) => { const value = await readProjectFilm(...args); ready.release(); return value; } } });
  try {
    watchers.subscribe(root, event => seen.push(event)); await enteredWithin(ready.promise);
    const draining = watchers.drain(); assert.equal(watchers.drain(), draining);
    await until(() => observed.records.length === 1 && observed.records[0].observed === 1);
    assert.equal(observed.records[0].delivered, 0); await pendingThroughTurn(draining);
    observed.release(); await enteredWithin(draining); assert.equal(observed.records[0].delivered, 1); assert.deepEqual(seen, []);
  } finally { observed.release(); try { await enteredWithin(watchers.drain()); } finally { await observed.restore(); rmSync(root, { recursive: true, force: true }); } }
});

import { filmHtml } from '../../src/film-doc.mjs';
import * as personEdits from './person-edits.mjs';

for (const kind of ['film', 'files']) test(`actual ${kind} merge keepAside and replacement finish before drain`, async () => {
  const root = fixture(), entered = gate(), release = gate();
  const original = { stage: { w: 1920, h: 1080 }, tracks: [] };
  const ours = { stage: { w: 1000, h: 1080 }, tracks: [] };
  const theirs = { stage: { w: 1920, h: 720 }, tracks: [] };
  if (kind === 'film') {
    writeFileSync(join(root, 'film.html'), filmHtml(ours));
    personEdits.filmWritten(root, original, ours, revOf(filmHtml(ours)));
  } else {
    writeFileSync(join(root, 'page.html'), 'ours\nbase\n');
    personEdits.filesWritten(root, { 'page.html': 'base\n' }, { 'page.html': 'ours\nbase\n' });
  }
  personEdits.configure({ keep: async (folder, files) => {
    assert.equal(folder, root); entered.release(); await release.promise;
    mkdirSync(join(root, '.evidence'), { recursive: true });
    for (const [name, value] of Object.entries(files)) writeFileSync(join(root, '.evidence', name), value);
  } });
  const stop = watchFolder(root, () => {});
  try {
    writeFileSync(join(root, kind === 'film' ? 'film.html' : 'page.html'), kind === 'film' ? filmHtml(theirs) : 'base\ntheirs\n');
    await enteredWithin(entered.promise);
    const closing = stop(); assert.ok(closing instanceof Promise); await pendingThroughTurn(closing);
    release.release(); await enteredWithin(closing);
    if (kind === 'film') assert.deepEqual((await readProjectFilm(root)).value.stage, ours.stage, 'native stage merge is one unit; the person wins the conflict');
    else assert.equal(readFileSync(join(root, 'page.html'), 'utf8'), 'ours\nbase\ntheirs\n');
    assert.ok(readdirSync(join(root, '.evidence')).some(name => name.startsWith('merged.')));
    assert.ok(!readdirSync(root).some(name => name.endsWith('.tmp')), 'actual replacement cleanup finished');
  } finally { release.release(); await stop(); personEdits.configure({ keep: async () => {} }); personEdits.forget(root); rmSync(root, { recursive: true, force: true }); }
});

test('presence-only missing root owns its entered real 400ms grace and emits nothing after close', async () => {
  const parent = fixture(), root = join(parent, 'never-existed'), entered = gate(), seen = [];
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => { const timer = originalTimeout(callback, ms, ...args); if (ms === 400) entered.release(); return timer; };
  const stop = watchFolder(root, e => seen.push(e));
  try {
    await enteredWithin(entered.promise); const closing = stop(); assert.ok(closing instanceof Promise);
    await pendingThroughTurn(closing); await enteredWithin(closing); assert.deepEqual(seen, []);
  } finally { globalThis.setTimeout = originalTimeout; await stop(); rmSync(parent, { recursive: true, force: true }); }
});

test('film send reentrant drain stops files settle and remaining subscribers', async () => {
  const root = fixture(), entered = gate(), readReady = gate(); let files = 0, listeners = 0, draining;
  const watchers = createWatchers({ onChange: (_root, e) => { if (e.type === 'film') { draining = watchers.drain(); entered.release(); } }, trustedNode: {
    readProjectFilm: async (...args) => { const read = await readProjectFilm(...args); readReady.release(); return read; },
    settleFiles: async (...args) => { files++; return await settleFiles(...args); },
  } });
  watchers.subscribe(root, () => { listeners++; }); watchers.subscribe(root, () => { listeners++; });
  try {
    await enteredWithin(readReady.promise);
    writeFileSync(join(root, 'film.html'), 'replacement'); writeFileSync(join(root, 'page.html'), 'page');
    await enteredWithin(entered.promise); await draining; assert.equal(files, 0); assert.equal(listeners, 0);
  } finally { if (watchers.drain) await watchers.drain(); else watchers.closeAll(); rmSync(root, { recursive: true, force: true }); }
});

test('queued debounce is cancelled synchronously by close', async () => {
  const root = fixture(), entered = gate(), seen = []; let settles = 0;
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => { const timer = originalTimeout(callback, ms, ...args); if (ms === 120) entered.release(); return timer; };
  const stop = watchFolder(root, event => seen.push(event), { trustedNode: { settleFiles: async (...args) => { settles++; return await settleFiles(...args); } } });
  try { writeFileSync(join(root, 'page.html'), 'page'); await enteredWithin(entered.promise); await stop(); await settle(160); assert.equal(settles, 0); assert.deepEqual(seen, []); }
  finally { globalThis.setTimeout = originalTimeout; await stop(); rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ['sync', 'async']) test(`${mode} failure is sunk while another entered root remains owned`, async () => {
  const a = fixture(), b = fixture(), release = gate(), entered = gate(); let count = 0;
  const watchers = createWatchers({ trustedNode: { readProjectFilm: (...args) => {
    if (args[0] === a) { if (mode === 'sync') throw new Error('synthetic'); return Promise.reject(new Error('synthetic')); }
    entered.release(); return release.promise.then(async () => { count++; return await readProjectFilm(...args); });
  } } });
  try {
    watchers.subscribe(a, () => {}); watchers.subscribe(b, () => {}); await enteredWithin(entered.promise);
    const closing = watchers.drain(); await pendingThroughTurn(closing); release.release(); await enteredWithin(closing); assert.equal(count, 1);
  } finally { release.release(); if (watchers.drain) await watchers.drain(); else watchers.closeAll(); for (const root of [a,b]) rmSync(root, { recursive: true, force: true }); }
});

test('move target merge and last unsubscribe retain every entered original read until terminal drain', async () => {
  const a = fixture(), b = fixture(), release = gate(); let entered = 0, finished = 0;
  const watchers = createWatchers({ trustedNode: { readProjectFilm: async (...args) => { entered++; await release.promise; const result = await readProjectFilm(...args); finished++; return result; } } });
  try {
    const first = watchers.subscribe(a, () => {}), second = watchers.subscribe(b, () => {});
    await until(() => entered === 2); watchers.move(a, b); await until(() => entered === 3);
    first(); assert.deepEqual(watchers.roots(), [b]); second(); assert.deepEqual(watchers.roots(), []);
    const closing = watchers.drain(); assert.equal(watchers.drain(), closing); await pendingThroughTurn(closing);
    release.release(); await enteredWithin(closing); assert.equal(finished, 3);
  } finally { release.release(); if (watchers.drain) await enteredWithin(watchers.drain()); else watchers.closeAll(); for (const root of [a,b]) rmSync(root, { recursive: true, force: true }); }
});

test('external initial read reentry cannot escape task registration', async () => {
  const root = fixture(), entered = gate(), release = gate(), seen = []; let closing, completed = false;
  const watchers = createWatchers({ trustedNode: { readProjectFilm: async (...args) => {
    closing = watchers.drain(); entered.release(); await release.promise;
    const result = await readProjectFilm(...args); completed = true; return result;
  } } });
  try {
    watchers.subscribe(root, event => seen.push(event)); await enteredWithin(entered.promise);
    await pendingThroughTurn(closing); release.release(); await enteredWithin(closing); assert.equal(completed, true); assert.deepEqual(seen, []);
  } finally { release.release(); if (watchers.drain) await enteredWithin(watchers.drain()); else watchers.closeAll(); rmSync(root, { recursive: true, force: true }); }
});
