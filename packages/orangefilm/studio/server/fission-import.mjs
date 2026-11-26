// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { recordFissionOrigin } from '../../src/fission-render.mjs';
import { assertSourceAccess, sourceAccessError } from '../../src/media-links.mjs';
import { writeAtomic } from './atomic.mjs';
import { alignedVisualSpans } from '../../src/fission-timing.mjs';
// @ts-check
/** Internal isolated drafts only. No HTTP route, authorization or export grant. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, readFile, realpath, writeFile } from 'node:fs/promises';
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

/** 容器包尾预算：仅在确有包尾时生效，且不超过半个秒（包尾是“至多几帧”的产物）。 */
const MAX_TAIL_PADDING_SEC = 0.5;
export const tailPaddingBudget = (plan) => {
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : NaN);
  const padding = num(plan?.transitions?.tailPaddingSec);
  const output = num(plan?.alignment?.outputDurationSec);
  const fps = num(plan?.fps);
  const duration = num(plan?.durationSec);
  const packetTail = plan?.alignment?.action === 'trim' && Number.isFinite(output) && Number.isFinite(fps) && fps > 0 &&
    Number.isFinite(duration) && duration > output + 1 / fps;
  return packetTail && Number.isFinite(padding) && padding > 0 ? Math.min(padding, MAX_TAIL_PADDING_SEC) : 0;
};
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
const unresolvedHandles=new Set();
const list = (/** @type {any} */ value) => { if (!Array.isArray(value) || value.length > 10_000) invalid(); };
/** @param {any} p */
function validate(p) {
  object(p, ['schemaVersion', 'jobId', 'outputIndex', 'stage', 'fps', 'durationSec', 'sources', 'visuals', 'alignment', 'audio', 'transitions', 'subtitles', 'exportReady', 'equivalenceVerified', 'blockingCapabilities']);
  if (p.schemaVersion !== 1) invalid(); text(p.jobId); if (!p.jobId) invalid();
  number(p.outputIndex); if (!Number.isSafeInteger(p.outputIndex)) invalid();
  object(p.stage, ['w', 'h']);
  for (const n of [p.stage.w, p.stage.h, p.fps]) if (!Number.isSafeInteger(n) || n <= 0 || n > 16384) invalid();
  positive(p.durationSec); list(p.sources); list(p.visuals); if (!p.sources.length || !p.visuals.length) invalid();
  const tailBudget = tailPaddingBudget(p);
  const rawTailPadding = Number(p.transitions?.tailPaddingSec);

  for (const source of p.sources) {
    object(source, ['path', 'sha256', 'kind', 'durationSec']); text(source.path); sha(source.sha256); if(source.kind==='still')number(source.durationSec);else positive(source.durationSec);
    if (!['video', 'still', 'sound'].includes(source.kind) || clipKind(source.path) !== source.kind) invalid();
  }
  const sourceIndex = (/** @type {any} */ i, /** @type {string[]} */ kinds) => {
    if (!Number.isSafeInteger(i) || i < 0 || !p.sources[i] || !kinds.includes(p.sources[i].kind)) invalid();
  };
  for (const [visualIndex, v] of p.visuals.entries()) {
    object(v, ['source', 'role', 'group', 'startSec', 'durationSec', 'speed', 'hflip']);
    sourceIndex(v.source, ['video', 'still']);
    if (!['intro', 'main', 'outro'].includes(v.role)) invalid(); text(v.group); number(v.startSec); positive(v.durationSec); positive(v.speed); bool(v.hflip);
    const tailAllowance = 1 / p.fps + (visualIndex === p.visuals.length - 1 ? tailBudget : 0);
    if (p.sources[v.source].kind==='still' ? v.startSec!==0 : v.startSec + v.durationSec > p.sources[v.source].durationSec + tailAllowance) invalid();
  }
  object(p.alignment, ['action', 'inputDurationSec', 'outputDurationSec', 'tempo', 'loops']);
  if (!['trim', 'speed', 'loop'].includes(p.alignment.action)) invalid();
  positive(p.alignment.inputDurationSec); positive(p.alignment.outputDurationSec); positive(p.alignment.tempo);
  if (!Number.isSafeInteger(p.alignment.loops) || p.alignment.loops < 1 || p.alignment.loops > 10000) invalid();
  const aligned = p.alignment;
  if (aligned.action === 'trim' && (aligned.tempo !== 1 || aligned.loops !== 1 || aligned.outputDurationSec > aligned.inputDurationSec + 1 / p.fps)) invalid();
  if (aligned.action === 'speed' && (aligned.loops !== 1 || Math.abs(aligned.tempo - aligned.inputDurationSec / aligned.outputDurationSec) > 1e-9)) invalid();
  if (aligned.action === 'loop' && (aligned.tempo !== 1 || aligned.loops !== Math.ceil(aligned.outputDurationSec / aligned.inputDurationSec))) invalid();
  object(p.audio, ['voice', 'music', 'loudnorm']);
  const audio = (/** @type {any} */ a) => { object(a, ['source', 'volume', 'loop']); sourceIndex(a.source, ['sound']); number(a.volume); bool(a.loop); };
  audio(p.audio.voice); if (p.audio.voice.loop !== false) invalid(); if (p.audio.music !== null) audio(p.audio.music);
  object(p.audio.loudnorm, ['integratedLUFS', 'truePeakDBTP', 'loudnessRangeLU']);
  if (p.audio.loudnorm.integratedLUFS !== -14 || p.audio.loudnorm.truePeakDBTP !== -1.5 || p.audio.loudnorm.loudnessRangeLU !== 11) invalid();
  object(p.transitions, ['requestedName', 'durationSec', 'selectedName', 'shader', 'outcome', 'tailPaddingSec']);
  if (!Number.isFinite(rawTailPadding) || rawTailPadding < 0 || rawTailPadding > MAX_TAIL_PADDING_SEC) invalid();
  text(p.transitions.requestedName); number(p.transitions.durationSec); number(p.transitions.tailPaddingSec);
  // Fission's stream-copy trim can retain a packet tail beyond its requested
  // alignment. The producer records the probed final duration and a bounded
  // tail budget; keep only tails that the original assembled footage can hold.
  if (p.durationSec > aligned.outputDurationSec + 1 / p.fps &&
      (aligned.action !== 'trim' || p.transitions.tailPaddingSec > 0.2 || p.durationSec > aligned.outputDurationSec + p.transitions.tailPaddingSec + 1 / p.fps || p.durationSec > aligned.inputDurationSec + 1 / p.fps)) invalid();
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
const execFileAsync = promisify(execFile);
/** Use the video stream clock, not the often longer container duration. */
async function videoStreamDuration(file, ffprobePath) {
  try {
    if (typeof ffprobePath !== 'string' || !path.isAbsolute(ffprobePath)) invalid();
    const { stdout } = await execFileAsync(ffprobePath, ['-v','error','-select_streams','v:0','-show_entries','stream=duration,duration_ts,time_base','-of','json',file], { windowsHide:true, timeout:10000, maxBuffer:1024*1024 });
    const stream=JSON.parse(stdout)?.streams?.[0],match=typeof stream?.time_base==='string'?/^(\d+)\/(\d+)$/.exec(stream.time_base):null;
    const ticks=Number(stream?.duration_ts),numerator=match?Number(match[1]):0,denominator=match?Number(match[2]):0;
    // Prefer the original integer stream clock; the decimal fallback remains
    // available for formats which do not expose duration_ts/time_base.
    const value=Number.isSafeInteger(ticks)&&ticks>0&&Number.isSafeInteger(numerator)&&numerator>0&&Number.isSafeInteger(denominator)&&denominator>0
      ? ticks*numerator/denominator : Number(stream?.duration);
    if (!Number.isFinite(value) || !(value > 0)) invalid();
    return value;
  } catch { return invalid(); }
}
/** @param {import('node:fs/promises').FileHandle} handle */
async function digest(handle) {
  const hash = createHash('sha256');
  for await (const bytes of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(bytes);
  return hash.digest('hex');
}
/** @param {any} plan */
function blockers(plan) {
  const values = ['fission-postmix-loudnorm', 'media-equivalence-unverified'];
  if (plan.durationSec > plan.alignment.outputDurationSec + 1 / plan.fps) values.push('fission-trim-tail-equivalence-unverified');
  if (plan.transitions.outcome === 'applied') values.push('fission-glsl-transition');
  if (plan.subtitles.outcome === 'applied') values.push('fission-ass-style', 'sentence-weighted-approximation');
  if (plan.subtitles.outcome === 'missing-text') values.push('fission-subtitle-text-missing');
  if (plan.visuals.some((/** @type {any} */ v) => v.hflip)) values.push('fission-hflip-equivalence');
  const sum = plan.visuals.reduce((/** @type {number} */ n, /** @type {any} */ v) => n + v.durationSec / v.speed, 0);
  if (Math.abs(sum - plan.alignment.inputDurationSec) > 1 / plan.fps) values.push('fission-alignment-duration-drift');
  return values;
}

/** Translate immutable decisions into original native Ops, not another timeline. @param {any} p @param {string[]} paths @param {string | null} captionSrc @param {Map<number,number>} [streamDurations] @param {Set<number>} [clamped] */
function nativeOps(p, paths, captionSrc, streamDurations = new Map(), clamped = new Set()) {
  /** @type {import('./ops.mjs').Op[]} */
  const ops = [{ op: 'stage', w: p.stage.w, h: p.stage.h }];
  /** @type {string[]} */
  const taken = []; let sequence = 0, count = 0;
  const hasPacketTail = p.alignment.action === 'trim' && p.durationSec > p.alignment.outputDurationSec + 1 / p.fps;
  const opTailBudget = tailPaddingBudget(p);
  const timing = hasPacketTail ? { ...p, alignment: { ...p.alignment, outputDurationSec: p.durationSec } } : p;
  const { target, spans } = alignedVisualSpans(timing);
  if (hasPacketTail && (!spans.length || target - (spans.at(-1).at + spans.at(-1).length) > 1 / p.fps + opTailBudget)) invalid();
  for (const span of spans) {
    const { source, at, rate, fromSec, still, hflip } = span;
    let { toSec } = span;
    const stream = streamDurations.get(source);
    if (!still && stream !== undefined && toSec > stream + 0.000001) {
      // Container packet tails can be a frame longer than the decodable video
      // stream; never create an invalid native clip or hide a larger mismatch.
      // The native MP4 muxer uses a millisecond movie clock. Its rounded
      // container duration can differ by up to half a millisecond from the
      // output-frame clock; convert that single-frame budget to source time.
      const roundedFrameBudget=rate*(1/p.fps+Math.min(0.0005,1/(4*p.fps)))+0.000001;
      if (toSec - stream > roundedFrameBudget || stream <= fromSec) invalid();
      toSec = stream; clamped.add(source);
    }
    const id = clipIdFor('fission-v-' + ++sequence + path.extname(paths[source]), taken); taken.push(id);
    const clip = { id, src: paths[source], at, time: [fromSec, toSec],
      ...(still ? {} : { speed: rate, volume: 0 }),
      ...(hflip ? { style: 'animation: fission_flip_' + sequence + ' 0.001s linear both' } : {}) };
    if (hflip) ops.push({ op: 'keyframes', set: { ['fission_flip_' + sequence]: '0% { scale: -1 1 } 100% { scale: -1 1 }' } });
    ops.push({ op: 'insert', clip, at, ...(count++ ? { track: 0 } : { newTrack: 0 }) });
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
 * @param {{ name?: string, sourceRoots: string[], approvedBaseRoot?: string, internalDraft: boolean, nativeAudioProfile?: "fission-v1", ffprobePath?: string }} options
 */
export async function importFissionEditPlan(input, options) {
  /** @type {import('node:fs/promises').FileHandle[]} */
  const handles = [];
  /** @type {Awaited<ReturnType<typeof createProject>> | null} */
  let project = null;
  let permit=null;
  const close=async fd=>{try{if(permit)await permit.closed(fd);else await fd.close();}catch(cause){unresolvedHandles.add(fd);throw Object.assign(sourceAccessError('source-preservation-failed',503),{cause});}};
  try {
    if (!options || !Array.isArray(options.sourceRoots) || !options.sourceRoots.length) invalid();
    const profile = readIsolationProfile(),isolated=options.internalDraft===true;
    if(isolated){if(!profile||profile.baseRoot!==options.approvedBaseRoot)invalid();assertIsolationPath(profile,profile.paths.projects,'projects');}
    const bytes = typeof input === 'string' ? Buffer.from(input) : Buffer.isBuffer(input) ? Buffer.from(input) : invalid();
    if (bytes.length > 4 * 1024 * 1024) invalid();
    const plan = JSON.parse(bytes.toString('utf8')); validate(plan);
    for (const root of options.sourceRoots) await ordinary(root, true);
    if(!isolated){for(const source of plan.sources){const ticket=assertSourceAccess(source.path,'fission-import');if(!ticket?.fissionImport||typeof ticket.recheck!=='function'||permit&&permit!==ticket.fissionImport)invalid();permit=ticket.fissionImport;ticket.recheck();}if(!permit||typeof permit.validateCreated!=='function'||typeof permit.opened!=='function'||typeof permit.closed!=='function')invalid();permit.check();}
    const dependencies = [...plan.sources, ...(plan.transitions.shader ? [plan.transitions.shader] : [])];
    for (const source of dependencies) {
      await ordinary(source.path, false);
      if (!options.sourceRoots.some(root => inside(root, source.path))) invalid();
      const handle = await open(source.path, 'r'); handles.push(handle);permit?.opened(handle);
      if (await digest(handle) !== source.sha256) invalid();
    }
    // For a recorded packet tail, a container's duration can exceed its video
    // stream. Qualify its real decodable boundary before creating a project.
    const streamDurations = new Map();
    if (plan.alignment.action === 'trim' && plan.durationSec > plan.alignment.outputDurationSec + 1 / plan.fps) {
      for (const [i,source] of plan.sources.entries()) if (source.kind === 'video') {
        streamDurations.set(i, await videoStreamDuration(source.path, options.ffprobePath));
        await ordinary(source.path, false);
        if (await digest(handles[i]) !== source.sha256) invalid();
      }
    }
    // Validate complete native structure before any native project is created.
    const clamped = new Set();
    nativeOps(plan, plan.sources.map((/** @type {any} */ source, /** @type {number} */ i) => 'assets/source-' + i + path.extname(source.path)), plan.subtitles.cues.length ? 'captions/fission.vtt' : null, streamDurations, clamped);
    const blockingCapabilities = blockers(plan);
    if (clamped.size) blockingCapabilities.push('fission-video-stream-tail-truncated');
    project = await createProject(options.name ?? 'Internal Fission Draft');
    if(profile)assertIsolationPath(profile,project.path,'projects');if(permit){permit.validateCreated(project);permit.check();}
    const landed = await bringIn(project.path, 'assets', dependencies.map(source => source.path), 'copy');
    for (let i = 0; i < dependencies.length; i++) {
      await ordinary(dependencies[i].path, false);
      if (await digest(handles[i]) !== dependencies[i].sha256) invalid();
      const copy = await open(path.join(project.path, landed[i]), 'r');permit?.opened(copy);
      try { if (await digest(copy) !== dependencies[i].sha256) invalid(); } finally { await close(copy); }
    }
    let captionSrc = null;
    if (plan.subtitles.cues.length) {
      const end = Math.min(plan.durationSec, plan.alignment.outputDurationSec);
      const cues = plan.subtitles.cues.filter((/** @type {any} */ c) => c.startSec < end).map((/** @type {any} */ c, /** @type {number} */ i) => ({ id: 'c' + (i + 1), start: c.startSec, end: Math.min(c.endSec, end), settings: '', text: cueEscape(c.text) }));
      const vtt = writeVtt({ header: 'WEBVTT', notes: ['NOTE Fission sentence-weighted approximation; not ASR.'], regions: [], styles: [], cues });
      captionSrc = (await importFile(project.path, 'captions/fission.vtt', Readable.from([vtt]))).path;
    }
    const current = await readProjectFilm(project.path);
    await editProjectFilm(project.path, current.rev, nativeOps(plan, landed, captionSrc, streamDurations));
    const reopened = await readProjectFilm(project.path); if (!reopened.doc || reopened.problems.length) invalid();
    const sourcePlanSHA256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(project.path, '.film', 'fission-edit-plan.json'), bytes, { flag: 'wx' });
    const pending=permit?JSON.parse(await readFile(path.join(project.path,'.film','fission-handoff.json'),'utf8')).business:null;
    const metadataBytes=JSON.stringify({ sourcePlanSHA256, internalDraft: isolated, blockingCapabilities, exportReady: false, equivalenceVerified: false, sourceCopies: landed, ...(options.nativeAudioProfile === "fission-v1" ? { nativeAudioProfile: "fission-v1" } : {}), previewEquivalent: false,...(pending?{business:pending}:{}) }, null, 2);
    if(permit)await writeAtomic(path.join(project.path,'.film','fission-handoff.json'),metadataBytes);else await writeFile(path.join(project.path,'.film','fission-handoff.json'),metadataBytes,{flag:'wx'});
    recordFissionOrigin(project.path);
    return { project, blockingCapabilities, exportReady: false, equivalenceVerified: false };
  } catch(error) {
    if(error?.code==='source-preservation-failed')throw error;
    if (project) {
      await writeFile(path.join(project.path, '.film', 'fission-import-failure.json'), JSON.stringify({ code: 'FISSION_IMPORT_INVALID', internalDraft: true, exportReady: false, equivalenceVerified: false }), { flag: 'wx' }).catch(() => {});
    }
    throw Object.assign(new ImportError(),{cause:error});
  } finally {
    const closed = await Promise.allSettled(handles.map(handle => close(handle)));
    if (closed.some(result => result.status === 'rejected')) throw sourceAccessError('source-preservation-failed',503);
  }
}
