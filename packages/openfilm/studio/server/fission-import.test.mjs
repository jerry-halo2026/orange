import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveIsolationProfile, isolationEnvironment } from '../../src/development-isolation.mjs';

const own = process.env.FISSION_HANDOFF_ATTEMPT;
assert.match(own ?? '', /[\\/]\.dev[\\/](?:fission-studio-handoff|fission-native-chain)[\\/]attempt-\d+-\d+$/);
const baseRoot = path.join(own, 'native-profiles');
const profile = resolveIsolationProfile({ baseRoot, instanceId: 'handoff', taskId: 'T06_HANDOFF', attemptId: 'a-' + process.pid + '-' + Date.now(), ports: own.includes('fission-native-chain') ? { studio: 18561, film: 18562 } : { studio: 18501, film: 18502 } }, { approvedBaseRoot: baseRoot });
for (const directory of Object.values(profile.paths)) mkdirSync(directory, { recursive: true });
Object.assign(process.env, isolationEnvironment(profile));
const sampleBytes = await fs.readFile(process.env.FISSION_HANDOFF_SAMPLE);
const sample = JSON.parse(sampleBytes);
assert.equal(sample.durationSec, 4, 'consume the passing actual C# sample, not a hand-written substitute');
const { importFissionEditPlan } = await import('./fission-import.mjs');
const { readProjectFilm, editProjectFilm } = await import('./film.mjs');
const { readState } = await import('./projects.mjs');
const { readVtt } = await import('../../src/captions.mjs');
const roots = [path.join(own, 'fixtures')];
const options = () => ({ name: 'Internal Fission Draft', sourceRoots: roots, approvedBaseRoot: baseRoot, internalDraft: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const invoke = (plan, opts) => importFissionEditPlan(Buffer.isBuffer(plan) ? plan : Buffer.from(JSON.stringify(plan)), opts);

async function rejectedBeforeCreation(plan, given = options()) {
  const state = JSON.stringify(await readState());
  const projects = (await fs.readdir(profile.paths.projects)).sort();
  await assert.rejects(invoke(plan, given), error => error.code === 'FISSION_IMPORT_INVALID' && !error.message.includes(own));
  assert.equal(JSON.stringify(await readState()), state);
  assert.deepEqual((await fs.readdir(profile.paths.projects)).sort(), projects);
}

test('actual C# decisions create a native independently editable draft, persist, reopen and undo through original Op', async () => {
  const result = await invoke(sampleBytes, options());
  assert(result?.project?.id, 'actual native project is required');
  assert.equal(result.exportReady, false); assert.equal(result.equivalenceVerified, false);
  assert(result.blockingCapabilities.includes('fission-postmix-loudnorm'));
  assert(result.project.path.startsWith(profile.paths.projects + path.sep));
  const film = await readProjectFilm(result.project.path);
  assert.equal(film.problems.length, 0);
  assert.deepEqual(film.value.stage, { w: 1080, h: 1920 });
  const visuals = film.value.tracks.flatMap(track => track.clips).filter(clip => clip.src.endsWith('.mp4'));
  assert.equal(visuals.length, 2);
  assert.deepEqual(visuals.map(clip => [clip.at ?? 0, ...clip.time, clip.speed ?? 1, clip.volume]), [[0, 0, 2, 1, 0], [2, 0, 2, 1, 0]]);
  const sounds = film.value.tracks.flatMap(track => track.clips).filter(clip => clip.src.endsWith('.mp3'));
  assert.equal(sounds.length, 1); assert.equal(sounds[0].volume ?? 1, 1);
  assert.equal(hash(await fs.readFile(path.join(result.project.path, sounds[0].src))), sample.sources[sample.audio.voice.source].sha256);
  const captionTrack = film.value.tracks.find(track => track.captions);
  assert(captionTrack); const vtt = readVtt(await fs.readFile(path.join(result.project.path, captionTrack.captions.src), 'utf8'));
  assert.deepEqual(vtt.cues.map(cue => [cue.start, cue.end, cue.text]), [[0, 1.6, '甲。'], [1.6, 4, '乙乙。']]);
  const edited = await editProjectFilm(result.project.path, film.rev, [{ op: 'set', clip: visuals[0].id, field: 'time', value: [0.5, 2] }]);
  assert.deepEqual((await readProjectFilm(result.project.path)).value.tracks[0].clips[0].time, [0.5, 2]);
  await editProjectFilm(result.project.path, edited.rev, [{ op: 'set', clip: visuals[0].id, field: 'time', value: [0, 2] }], { undo: true });
  const reopened = await readProjectFilm(result.project.path);
  assert.deepEqual(reopened.value.tracks[0].clips[0].time, [0, 2]);
  const metadata = JSON.parse(await fs.readFile(path.join(result.project.path, '.film', 'fission-handoff.json'), 'utf8'));
  assert.equal(metadata.exportReady, false); assert.equal(metadata.equivalenceVerified, false);
  assert.equal(metadata.sourcePlanSHA256, hash(sampleBytes));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.project.path, '.film', 'fission-edit-plan.json'), 'utf8')), sample);
  for (const source of sample.sources) assert.equal(hash(await fs.readFile(source.path)), source.sha256);
  await fs.writeFile(path.join(own, 'native-consumption-' + process.pid + '.json'), JSON.stringify({ producerSampleSHA256: hash(sampleBytes), project: result.project.id, internalPath: result.project.path, visualClips: 2, voiceTracks: 1, captionCues: 2, reeditedAndUndone: true, exportReady: false, equivalenceVerified: false }), { flag: 'wx' });
});

test('JSON cannot assert export readiness or hide blockers', async () => {
  const changed = structuredClone(sample); changed.exportReady = true; changed.equivalenceVerified = true; changed.blockingCapabilities = [];
  const result = await invoke(changed, options());
  assert(result?.project?.id);
  assert.equal(result.exportReady, false); assert.equal(result.equivalenceVerified, false);
  assert(result.blockingCapabilities.includes('fission-postmix-loudnorm'));
  assert(result.blockingCapabilities.includes('fission-ass-style'));
});

for (const name of ['version', 'nonfinite', 'hash', 'relative-path', 'unknown-field', 'bad-source-index', 'zero-speed', 'alignment-tempo', 'alignment-loops']) {
  test('invalid ' + name + ' is refused before native project creation', async () => {
    const p = structuredClone(sample);
    if (name === 'version') p.schemaVersion = 2;
    if (name === 'nonfinite') p.durationSec = NaN;
    if (name === 'hash') p.sources[0].sha256 = '0'.repeat(64);
    if (name === 'relative-path') p.sources[0].path = 'not-absolute.mp4';
    if (name === 'unknown-field') p.sourceRoots = roots;
    if (name === 'bad-source-index') p.visuals[0].source = 999;
    if (name === 'zero-speed') p.visuals[0].speed = 0;
    if (name === 'alignment-tempo') p.alignment.tempo = 2;
    if (name === 'alignment-loops') p.alignment.loops = 2;
    await rejectedBeforeCreation(p);
  });
}

test('sourceRoots are trusted caller scope, not claimed by a JSON path or matching hash', async () => {
  await rejectedBeforeCreation(sample, { ...options(), sourceRoots: [path.join(own, 'not-approved')] });
});

test('real directory junction source is refused even with matching bytes under lexical scope', async () => {
  const p = structuredClone(sample); const link = path.join(own, 'fixtures', 'linked-source-' + process.pid);
  await fs.symlink(path.dirname(p.sources[0].path), link, 'junction');
  p.sources[0].path = path.join(link, path.basename(p.sources[0].path));
  await rejectedBeforeCreation(p);
});

test('internal isolation is mandatory and cannot fall back to normal recent projects', async () => {
  await rejectedBeforeCreation(sample, { ...options(), internalDraft: false });
});
test('real file hardlink source is not a separately approved original', async () => {
  const p = structuredClone(sample);
  const copy = path.join(own, 'fixtures', 'hardlink-original-' + process.pid + '.mp4');
  const link = path.join(own, 'fixtures', 'hardlink-alias-' + process.pid + '.mp4');
  await fs.copyFile(p.sources[0].path, copy); await fs.link(copy, link);
  p.sources[0].path = link;
  await rejectedBeforeCreation(p);
});

test('actual C# loop record imports repeated native clips and preserved generated voice source', async () => {
  const bytes = await fs.readFile(process.env.FISSION_HANDOFF_LOOP_SAMPLE);
  const p = JSON.parse(bytes); assert.equal(p.alignment.action, 'loop'); assert.equal(p.durationSec, 6);
  const result = await invoke(bytes, options()); const film = await readProjectFilm(result.project.path);
  const video = film.value.tracks[0].clips;
  assert.deepEqual(video.map(c => [c.at ?? 0, ...c.time]), [[0, 0, 2], [2, 0, 2], [4, 0, 2]]);
  const voice = film.value.tracks[1].clips[0]; assert.deepEqual(voice.time, [0, 6]);
  assert.equal(hash(await fs.readFile(path.join(result.project.path, voice.src))), p.sources[p.audio.voice.source].sha256);
  assert.equal(result.exportReady, false);
});