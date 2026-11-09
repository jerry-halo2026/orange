import { recordFissionOrigin } from '../../src/fission-render.mjs';
// @ts-check
/** Internal isolated drafts only. No HTTP route, authorization or export grant. */
import { createHash } from 'node:crypto';
import { lstat, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { readIsolationProfile, assertIsolationPath } from '../../src/development-isolation.mjs';
import { clipIdFor, clipKind, readFilm } from '../../src/film-doc.mjs';
import { cueEscape, writeVtt } from '../../src/captions.mjs';
import { createProject } from './projects.mjs';
import { bringIn, importFile } from './files.mjs';
import { EMPTY_FILM, readProjectFilm, editProjectFilm } from './film.mjs';
import { applyOps } from './ops.mjs';

class ImportError extends Error {
  constructor() { super('The isolated Fission draft could not be imported.'); this.code = 'FISSION_IMPORT_INVALID'; }
}
/** @returns {never} */
const invalid = () => { throw new ImportError(); };
/** @param {any} value @param {string[]} keys */
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
const number = (/** @type {any} */ value, min = 0) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min) invalid(); };
const positive = (/** @type {any} */ value) => { number(value); if (!(value > 0)) invalid(); };
const bool = (/** @type {any} */ value) => { if (typeof value !== 'boolean') invalid(); };
const text = (/** @type {any} */ value) => { if (typeof value !== 'string' || value.length > 1_000_000) invalid(); };
const sha = (/** @type {any} */ value) => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); };
const list = (/** @type {any} */ value) => { if (!Array.isArray(value) || value.length > 10_000) invalid(); };
/** @param {any} p */
function validate(p) {
  object(p, ['schemaVersion', 'jobId', 'outputIndex', 'stage', 'fps', 'durationSec', 'sources', 'visuals', 'alignment', 'audio', 'transitions', 'subtitles', 'exportReady', 'equivalenceVerified', 'blockingCapabilities']);
  if (p.schemaVersion !== 1) invalid(); text(p.jobId); if (!p.jobId) invalid();
  number(p.outputIndex); if (!Number.isSafeInteger(p.outputIndex)) invalid();
  object(p.stage, ['w', 'h']);
  for (const n of [p.stage.w, p.stage.h, p.fps]) if (!Number.isSafeInteger(n) || n <= 0 || n > 16384) invalid();
  positive(p.durationSec); list(p.sources); list(p.visuals); if (!p.sources.length || !p.visuals.length) invalid();
  for (const source of p.sources) {
    object(source, ['path', 'sha256', 'kind', 'durationSec']); text(source.path); sha(source.sha256); positive(source.durationSec);
    if (!['video', 'still', 'sound'].includes(source.kind) || clipKind(source.path) !== source.kind) invalid();
  }
  const sourceIndex = (/** @type {any} */ i, /** @type {string[]} */ kinds) => {
    if (!Number.isSafeInteger(i) || i < 0 || !p.sources[i] || !kinds.includes(p.sources[i].kind)) invalid();
  };
  for (const v of p.visuals) {
    object(v, ['source', 'role', 'group', 'startSec', 'durationSec', 'speed', 'hflip']);
    sourceIndex(v.source, ['video', 'still']);
    if (!['intro', 'main', 'outro'].includes(v.role)) invalid(); text(v.group); number(v.startSec); positive(v.durationSec); positive(v.speed); bool(v.hflip);
    if (v.startSec + v.durationSec > p.sources[v.source].durationSec + 1 / p.fps) invalid();
  }
  object(p.alignment, ['action', 'inputDurationSec', 'outputDurationSec', 'tempo', 'loops']);
  if (!['trim', 'speed', 'loop'].includes(p.alignment.action)) invalid();
  positive(p.alignment.inputDurationSec); positive(p.alignment.outputDurationSec); positive(p.alignment.tempo);
  if (!Number.isSafeInteger(p.alignment.loops) || p.alignment.loops < 1 || p.alignment.loops > 10000) invalid();
  const aligned = p.alignment;
  if (aligned.action === 'trim' && (aligned.tempo !== 1 || aligned.loops !== 1 || aligned.outputDurationSec > aligned.inputDurationSec + 1 / p.fps)) invalid();
  if (aligned.action === 'speed' && (aligned.loops !== 1 || Math.abs(aligned.tempo - aligned.inputDurationSec / aligned.outputDurationSec) > 1e-9)) invalid();
  if (aligned.action === 'loop' && (aligned.tempo !== 1 || aligned.loops !== Math.ceil(aligned.outputDurationSec / aligned.inputDurationSec))) invalid();
  if (p.durationSec > aligned.outputDurationSec + 1 / p.fps) invalid();
  object(p.audio, ['voice', 'music', 'loudnorm']);
  const audio = (/** @type {any} */ a) => { object(a, ['source', 'volume', 'loop']); sourceIndex(a.source, ['sound']); number(a.volume); bool(a.loop); };
  audio(p.audio.voice); if (p.audio.voice.loop !== false) invalid(); if (p.audio.music !== null) audio(p.audio.music);
  object(p.audio.loudnorm, ['integratedLUFS', 'truePeakDBTP', 'loudnessRangeLU']);
  if (p.audio.loudnorm.integratedLUFS !== -14 || p.audio.loudnorm.truePeakDBTP !== -1.5 || p.audio.loudnorm.loudnessRangeLU !== 11) invalid();
  object(p.transitions, ['requestedName', 'durationSec', 'selectedName', 'shader', 'outcome', 'tailPaddingSec']);
  text(p.transitions.requestedName); number(p.transitions.durationSec); number(p.transitions.tailPaddingSec);
  if (!['none', 'applied', 'fallback-no-transition'].includes(p.transitions.outcome)) invalid();
  if (p.transitions.selectedName !== null) text(p.transitions.selectedName);
  if (p.transitions.shader !== null) { object(p.transitions.shader, ['path', 'sha256']); text(p.transitions.shader.path); sha(p.transitions.shader.sha256); }
  if (p.transitions.outcome === 'applied' && (!p.transitions.shader || !p.transitions.selectedName || !(p.transitions.durationSec > 0))) invalid();
  object(p.subtitles, ['requested', 'outcome', 'timingSource', 'cues', 'style']); bool(p.subtitles.requested);
  if (!['disabled', 'missing-text', 'applied'].includes(p.subtitles.outcome) || p.subtitles.timingSource !== 'sentence-weighted-approximation') invalid();
  list(p.subtitles.cues); let previous = 0;
  for (const cue of p.subtitles.cues) {
    object(cue, ['startSec', 'endSec', 'text']); number(cue.startSec); positive(cue.endSec); text(cue.text);
    if (cue.endSec <= cue.startSec || cue.startSec < previous) invalid(); previous = cue.endSec;
  }
  if (p.subtitles.style !== null) {
    object(p.subtitles.style, ['preset', 'position', 'fontSize', 'assStyle', 'fadeInSec', 'fadeOutSec']);
    text(p.subtitles.style.preset); text(p.subtitles.style.position); positive(p.subtitles.style.fontSize); text(p.subtitles.style.assStyle);
    number(p.subtitles.style.fadeInSec); number(p.subtitles.style.fadeOutSec);
  }
  if (p.subtitles.outcome === 'applied' && !p.subtitles.style) invalid();
  bool(p.exportReady); bool(p.equivalenceVerified); list(p.blockingCapabilities); p.blockingCapabilities.forEach(text);
}

/** @param {string} value @param {boolean} directory */
async function ordinary(value, directory) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || value === path.parse(value).root || /[\0-\x1f]/.test(value)) invalid();
  for (let current = value; ; current = path.dirname(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || (current === value && !directory && info.nlink !== 1)
      || (current !== value || directory ? !info.isDirectory() : !info.isFile())) invalid();
    if (current === path.dirname(current)) break;
  }
  if (await realpath(value) !== value) invalid();
}
/** @param {string} root @param {string} file */
const inside = (root, file) => { const rel = path.relative(root, file); return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
/** @param {import('node:fs/promises').FileHandle} handle */
async function digest(handle) {
  const hash = createHash('sha256');
  for await (const bytes of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(bytes);
  return hash.digest('hex');
}
/** @param {any} plan */
function blockers(plan) {
  const values = ['fission-postmix-loudnorm', 'media-equivalence-unverified'];
  if (plan.transitions.outcome === 'applied') values.push('fission-glsl-transition');
  if (plan.subtitles.outcome === 'applied') values.push('fission-ass-style', 'sentence-weighted-approximation');
  if (plan.subtitles.outcome === 'missing-text') values.push('fission-subtitle-text-missing');
  if (plan.visuals.some((/** @type {any} */ v) => v.hflip)) values.push('fission-hflip-equivalence');
  const sum = plan.visuals.reduce((/** @type {number} */ n, /** @type {any} */ v) => n + v.durationSec / v.speed, 0);
  if (Math.abs(sum - plan.alignment.inputDurationSec) > 1 / plan.fps) values.push('fission-alignment-duration-drift');
  return values;
}

/** Translate immutable decisions into original native Ops, not another timeline. @param {any} p @param {string[]} paths @param {string | null} captionSrc */
function nativeOps(p, paths, captionSrc) {
  /** @type {import('./ops.mjs').Op[]} */
  const ops = [{ op: 'stage', w: p.stage.w, h: p.stage.h }];
  /** @type {string[]} */
  const taken = []; let sequence = 0, count = 0;
  const target = Math.min(p.durationSec, p.alignment.outputDurationSec);
  const tempo = p.alignment.action === 'speed' ? p.alignment.tempo : 1;
  const one = p.visuals.reduce((/** @type {number} */ n, /** @type {any} */ v) => n + v.durationSec / v.speed / tempo, 0);
  const loops = p.alignment.action === 'loop' ? Math.ceil(target / one) : 1;
  if (!Number.isSafeInteger(loops) || loops < 1 || loops * p.visuals.length > 10000) invalid();
  let at = 0;
  for (let loop = 0; loop < loops; loop++) for (const v of p.visuals) {
    if (at >= target - 1e-9) break;
    const rate = v.speed * tempo, length = Math.min(v.durationSec / rate, target - at);
    const still = p.sources[v.source].kind === 'still';
    const id = clipIdFor('fission-v-' + ++sequence + path.extname(paths[v.source]), taken); taken.push(id);
    const clip = { id, src: paths[v.source], at, time: still ? [0, length] : [v.startSec, v.startSec + length * rate],
      ...(still ? {} : { speed: rate, volume: 0 }),
      ...(v.hflip ? { style: 'animation: fission_flip_' + sequence + ' 0.001s linear both' } : {}) };
    if (v.hflip) ops.push({ op: 'keyframes', set: { ['fission_flip_' + sequence]: '0% { scale: -1 1 } 100% { scale: -1 1 }' } });
    ops.push({ op: 'insert', clip, at, ...(count++ ? { track: 0 } : { newTrack: 0 }) }); at += length;
  }
  const sound = (/** @type {any} */ a, /** @type {number} */ track, /** @type {string} */ role) => {
    const duration = p.sources[a.source].durationSec; let time = 0, first = true;
    const repeats = a.loop ? Math.ceil(target / duration) : 1;
    if (repeats > 10000) invalid();
    for (let i = 0; i < repeats && time < target; i++) {
      const length = Math.min(duration, target - time);
      const id = clipIdFor('fission-a-' + ++sequence + path.extname(paths[a.source]), taken); taken.push(id);
      ops.push({ op: 'insert', clip: { id, src: paths[a.source], time: [0, length], volume: a.volume, attrs: { "data-fission-role": role } }, at: time,
        ...(first ? { newTrack: track } : { track }) }); first = false; time += length;
    }
  };
  sound(p.audio.voice, 1, "voice");
  if (p.audio.music !== null) sound(p.audio.music, 2, "music");
  if (captionSrc) ops.push({ op: 'captions', at: p.audio.music !== null ? 3 : 2, captions: { src: captionSrc, kind: 'subtitles', label: 'Fission subtitles (approximate)' } });
  const checked = readFilm(applyOps(/** @type {import('./ops.mjs').FilmValue} */ (structuredClone(/** @type {unknown} */ (EMPTY_FILM))), ops));
  if (!checked.doc || checked.problems.length) invalid();
  return ops;
}

/**
 * Consume the actual C# sidecar bytes. Every target is an explicitly approved
 * development profile; sourceRoots and internalDraft are trusted caller facts,
 * never accepted from JSON. Never use as an owner/permission or export gate.
 * @param {Buffer | string} input
 * @param {{ name?: string, sourceRoots: string[], approvedBaseRoot: string, internalDraft: boolean, nativeAudioProfile?: "fission-v1" }} options
 */
export async function importFissionEditPlan(input, options) {
  /** @type {import('node:fs/promises').FileHandle[]} */
  const handles = [];
  /** @type {Awaited<ReturnType<typeof createProject>> | null} */
  let project = null;
  try {
    if (!options || options.internalDraft !== true || !Array.isArray(options.sourceRoots) || !options.sourceRoots.length) invalid();
    const profile = readIsolationProfile();
    if (!profile || profile.baseRoot !== options.approvedBaseRoot) invalid();
    assertIsolationPath(profile, profile.paths.projects, 'projects');
    const bytes = typeof input === 'string' ? Buffer.from(input) : Buffer.isBuffer(input) ? Buffer.from(input) : invalid();
    if (bytes.length > 4 * 1024 * 1024) invalid();
    const plan = JSON.parse(bytes.toString('utf8')); validate(plan);
    for (const root of options.sourceRoots) await ordinary(root, true);
    const dependencies = [...plan.sources, ...(plan.transitions.shader ? [plan.transitions.shader] : [])];
    for (const source of dependencies) {
      await ordinary(source.path, false);
      if (!options.sourceRoots.some(root => inside(root, source.path))) invalid();
      const handle = await open(source.path, 'r'); handles.push(handle);
      if (await digest(handle) !== source.sha256) invalid();
    }
    // Validate complete native structure before any native project is created.
    nativeOps(plan, plan.sources.map((/** @type {any} */ source, /** @type {number} */ i) => 'assets/source-' + i + path.extname(source.path)), plan.subtitles.cues.length ? 'captions/fission.vtt' : null);
    const blockingCapabilities = blockers(plan);
    project = await createProject(options.name ?? 'Internal Fission Draft');
    assertIsolationPath(profile, project.path, 'projects');
    const landed = await bringIn(project.path, 'assets', dependencies.map(source => source.path), 'copy');
    for (let i = 0; i < dependencies.length; i++) {
      await ordinary(dependencies[i].path, false);
      if (await digest(handles[i]) !== dependencies[i].sha256) invalid();
      const copy = await open(path.join(project.path, landed[i]), 'r');
      try { if (await digest(copy) !== dependencies[i].sha256) invalid(); } finally { await copy.close(); }
    }
    let captionSrc = null;
    if (plan.subtitles.cues.length) {
      const end = Math.min(plan.durationSec, plan.alignment.outputDurationSec);
      const cues = plan.subtitles.cues.filter((/** @type {any} */ c) => c.startSec < end).map((/** @type {any} */ c, /** @type {number} */ i) => ({ id: 'c' + (i + 1), start: c.startSec, end: Math.min(c.endSec, end), settings: '', text: cueEscape(c.text) }));
      const vtt = writeVtt({ header: 'WEBVTT', notes: ['NOTE Fission sentence-weighted approximation; not ASR.'], regions: [], styles: [], cues });
      captionSrc = (await importFile(project.path, 'captions/fission.vtt', Readable.from([vtt]))).path;
    }
    const current = await readProjectFilm(project.path);
    await editProjectFilm(project.path, current.rev, nativeOps(plan, landed, captionSrc));
    const reopened = await readProjectFilm(project.path); if (!reopened.doc || reopened.problems.length) invalid();
    const sourcePlanSHA256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(project.path, '.film', 'fission-edit-plan.json'), bytes, { flag: 'wx' });
    await writeFile(path.join(project.path, '.film', 'fission-handoff.json'), JSON.stringify({ sourcePlanSHA256, internalDraft: true, blockingCapabilities, exportReady: false, equivalenceVerified: false, sourceCopies: landed, ...(options.nativeAudioProfile === "fission-v1" ? { nativeAudioProfile: "fission-v1" } : {}), previewEquivalent: false }, null, 2), { flag: 'wx' });
    recordFissionOrigin(project.path);
    return { project, blockingCapabilities, exportReady: false, equivalenceVerified: false };
  } catch {
    if (project) {
      await writeFile(path.join(project.path, '.film', 'fission-import-failure.json'), JSON.stringify({ code: 'FISSION_IMPORT_INVALID', internalDraft: true, exportReady: false, equivalenceVerified: false }), { flag: 'wx' }).catch(() => {});
    }
    throw new ImportError();
  } finally {
    const closed = await Promise.allSettled(handles.map(handle => handle.close()));
    if (closed.some(result => result.status === 'rejected')) throw new ImportError();
  }
}