#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// A video measured in time, for an agent that sees still pictures: where it cuts, what moves when and at what pace,
// where it holds still, and where its sound hits. And a remake measured against it, frame by frame.
//
//   node measure.mjs study <video> [--out <folder>]
//   node measure.mjs compare <reference> <remake> [--out <folder>] [--fit] [--film <film.html>]
//
// study writes study.md (to read) and study.json (every number) into --out, by default a folder named after the video
// beside it. compare writes compare.md, compare.json and side-by-side pictures (reference left, remake right), by
// default into compare/ beside the reference. --fit compares a remake of another length with its times scaled to the
// reference's. It also says what of the reference is in the remake, and exits 1 when a picture, a sound or a file of it
// is; --film is the remake's film.html when it is not in a folder above the render. Needs ffmpeg and ffprobe on the
// PATH, as OrangeFilm does.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

/* the size every frame is measured at: small enough to be fast and to forgive a pixel's difference */
const AREA = 128 * 72;
const GRID = 8;
const BINS = 32;
/* sound: samples per second, and the window and hop of its spectrum (a hop is about 12 ms, under a frame) */
const RATE = 22050;
const WINDOW = 1024;
const HOP = 256;

const fail = (/** @type {string} */ why) => { console.error(`measure: ${why}`); process.exit(1); };
const round = (/** @type {number} */ n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const fmt = (/** @type {number} */ t) => t.toFixed(3);

// ---------------------------------------------------------------- reading a video

/** What ffprobe says of a file: its picture's size, rate and length, and whether it has sound. @param {string} file */
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' });
  if (r.error) fail(`ffprobe: ${/** @type {NodeJS.ErrnoException} */ (r.error).code === 'ENOENT' ? 'not found on the PATH (it comes with ffmpeg)' : r.error.message}`);
  if (r.status !== 0) fail(`cannot read ${file}: ${r.stderr.trim()}`);
  const info = JSON.parse(r.stdout);
  const video = info.streams.find((/** @type {any} */ s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) fail(`${file} has no picture`);
  const rate = (/** @type {string | undefined} */ q) => {
    const [a, b] = String(q ?? '0/1').split('/').map(Number);
    return b ? a / b : 0;
  };
  let fps = rate(video.avg_frame_rate);
  if (!(fps > 1 && fps < 241)) fps = rate(video.r_frame_rate);
  if (!(fps > 1 && fps < 241)) fps = 30;
  const rotation = Math.abs(Number(video.side_data_list?.find((/** @type {any} */ d) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0)) % 180;
  const [width, height] = rotation === 90 ? [video.height, video.width] : [video.width, video.height];
  const duration = Number(info.format?.duration ?? video.duration ?? 0);
  if (!(duration > 0)) fail(`${file} has no length`);
  const sound = info.streams.some((/** @type {any} */ s) => s.codec_type === 'audio');
  return { width, height, fps: round(fps, 3), duration, sound };
}

/** The size frames of this shape are measured at. @param {number} width @param {number} height */
function analysisSize(width, height) {
  const aspect = width / height;
  const w = Math.max(16, Math.round(Math.sqrt(AREA * aspect) / 2) * 2);
  const h = Math.max(16, Math.round(w / aspect / 2) * 2);
  return { w, h };
}

/**
 * Every frame of a video at `fps`, measured: how much each one differs from the one before, overall (`d`, 0–255) and in
 * each cell of a GRID×GRID (`cells`), and its brightness histogram (`hist`). With `keep`, each frame's grey picture
 * and a 4×-smaller colour one are kept too, for comparing pictures.
 * @param {string} file @param {{ fps: number, w: number, h: number, keep?: boolean }} o
 */
function readFrames(file, { fps, w, h, keep = false }) {
  return new Promise((done, failed) => {
    const size = w * h * 3;
    const proc = spawn('ffmpeg', ['-v', 'error', '-i', file, '-an', '-vf', `fps=${fps},scale=${w}:${h}:flags=area,format=rgb24`, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    /** @type {number[]} */ const d = [];
    /** @type {Float32Array[]} */ const cells = [];
    /** @type {Float32Array[]} */ const hist = [];
    /** @type {Uint8Array[]} */ const grey = [];
    /** @type {Uint8Array[]} */ const colour = [];
    let pending = Buffer.alloc(0);
    /** @type {Uint8Array | null} */ let previous = null;
    let errors = '';
    const cw = w / GRID;
    const ch = h / GRID;
    const frame = (/** @type {Buffer} */ rgb) => {
      const g = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < g.length; i++, j += 3) g[i] = (rgb[j] * 77 + rgb[j + 1] * 150 + rgb[j + 2] * 29) >> 8;
      const hs = new Float32Array(BINS);
      for (let i = 0; i < g.length; i++) hs[(g[i] * BINS) >> 8]++;
      for (let b = 0; b < BINS; b++) hs[b] /= g.length;
      const cs = new Float32Array(GRID * GRID);
      let sum = 0;
      if (previous) {
        for (let y = 0; y < h; y++) {
          const row = Math.min(GRID - 1, Math.floor(y / ch)) * GRID;
          for (let x = 0; x < w; x++) {
            const v = Math.abs(g[y * w + x] - previous[y * w + x]);
            sum += v;
            cs[row + Math.min(GRID - 1, Math.floor(x / cw))] += v;
          }
        }
        const per = (w * h) / (GRID * GRID);
        for (let c = 0; c < cs.length; c++) cs[c] /= per;
      }
      d.push(previous ? sum / (w * h) : 0);
      cells.push(cs);
      hist.push(hs);
      if (keep) {
        grey.push(g);
        const sw = w / 4;
        const sh = h / 4;
        const small = new Uint8Array(Math.floor(sw) * Math.floor(sh) * 3);
        for (let y = 0; y < Math.floor(sh); y++) {
          for (let x = 0; x < Math.floor(sw); x++) {
            for (let k = 0; k < 3; k++) {
              let s = 0;
              for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) s += rgb[((y * 4 + dy) * w + x * 4 + dx) * 3 + k];
              small[(y * Math.floor(sw) + x) * 3 + k] = s >> 4;
            }
          }
        }
        colour.push(small);
      }
      previous = g;
    };
    proc.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= size) {
        frame(pending.subarray(0, size));
        pending = pending.subarray(size);
      }
    });
    proc.stderr.on('data', (chunk) => { errors += chunk; });
    proc.on('error', (e) => failed(new Error(`ffmpeg: ${/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT' ? 'not found on the PATH' : e.message}`)));
    proc.on('close', (code) => {
      if (code !== 0 || !d.length) failed(new Error(`ffmpeg could not read ${file}: ${errors.trim()}`));
      else done({ d, cells, hist, grey, colour, w, h });
    });
  });
}

/** A file's sound, mono at `rate`, or null when it has none. @param {string} file @returns {Promise<Float32Array | null>} */
function readSound(file, rate = RATE) {
  return new Promise((done) => {
    const proc = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    /** @type {Buffer[]} */ const parts = [];
    proc.stdout.on('data', (c) => parts.push(c));
    proc.on('error', () => done(null));
    proc.on('close', (code) => {
      const all = Buffer.concat(parts);
      if (code !== 0 || all.length < 4 * WINDOW) return done(null);
      const copy = new Uint8Array(all.length - (all.length % 4));
      copy.set(all.subarray(0, copy.length));
      done(new Float32Array(copy.buffer));
    });
  });
}

// ---------------------------------------------------------------- what happens in the picture

const median = (/** @type {number[]} */ xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const percentile = (/** @type {number[]} */ xs, /** @type {number} */ p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
};
const histDistance = (/** @type {Float32Array} */ a, /** @type {Float32Array} */ b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / 2;
};

/**
 * The cuts: frames unlike the one before in a way motion does not make (the brightness histogram jumps, or the
 * picture changes far more than in the frames around it). → frame numbers, each the first frame of a new shot.
 * @param {{ d: number[], hist: Float32Array[] }} m
 */
function findCuts({ d, hist }) {
  /** @type {number[]} */ const cuts = [];
  for (let i = 1; i < d.length; i++) {
    const hd = histDistance(hist[i], hist[i - 1]);
    const around = [];
    for (let k = i - 6; k <= i + 6; k++) if (k > 0 && k < d.length && Math.abs(k - i) > 1) around.push(d[k]);
    const local = Math.max(1, median(around));
    const cut = (hd > 0.3 && d[i] > 6) || (d[i] > 10 && d[i] > 4 * local && hd > 0.08);
    if (!cut) continue;
    const last = cuts[cuts.length - 1];
    if (last !== undefined && i - last < 3) { if (d[i] > d[last]) cuts[cuts.length - 1] = i; continue; }
    cuts.push(i);
  }
  return cuts;
}

/** The change below which a frame counts as still: what compression and grain alone make. @param {number[]} d @param {Set<number>} cuts */
function stillFloor(d, cuts) {
  const calm = d.filter((_, i) => i > 0 && !cuts.has(i));
  return Math.max(0.35, percentile(calm, 0.1) * 1.6 + 0.25);
}

/**
 * How the pace of a change goes over its span, from the change of each frame (`pace`):
 * → its shape in ten digits (0–9, its fastest frame 9), and in words.
 * @param {number[]} pace
 */
function describePace(pace) {
  const max = Math.max(...pace, 1e-9);
  const digits = Array.from({ length: Math.min(10, pace.length) }, (_, k) => {
    const n = Math.min(10, pace.length);
    const a = Math.floor((k * pace.length) / n);
    const b = Math.max(a + 1, Math.floor(((k + 1) * pace.length) / n));
    const v = pace.slice(a, b).reduce((s, x) => s + x, 0) / (b - a);
    return Math.round((v / max) * 9);
  }).join('');
  if (pace.length <= 2) return { digits, words: 'at once', half: 0.5, spread: 0 };
  const total = pace.reduce((s, x) => s + x, 0);
  let acc = 0;
  let half = 0;
  for (let i = 0; i < pace.length; i++) { acc += pace[i]; if (acc >= total / 2) { half = (i + 0.5) / pace.length; break; } }
  const mean = total / pace.length;
  const spread = Math.sqrt(pace.reduce((s, x) => s + (x - mean) ** 2, 0) / pace.length) / (mean || 1);
  /* pulses: peaks over 0.6 of the fastest, each pair parted by a dip under 0.6 of the smaller, on a smoothed pace */
  const smooth = pace.map((x, i) => ((pace[i - 1] ?? x) + 2 * x + (pace[i + 1] ?? x)) / 4);
  const top = Math.max(...smooth);
  let peaks = 0;
  let last = -1;
  let dip = Infinity;
  for (let i = 0; i < smooth.length; i++) {
    dip = Math.min(dip, smooth[i]);
    const isPeak = smooth[i] >= (smooth[i - 1] ?? 0) && smooth[i] >= (smooth[i + 1] ?? 0) && smooth[i] > 0.6 * top;
    if (!isPeak) continue;
    if (last < 0 || dip < 0.6 * Math.min(smooth[i], smooth[last])) { peaks++; last = i; dip = Infinity; }
    else if (smooth[i] > smooth[last]) last = i;
  }
  let words;
  if (peaks >= 3) words = `${peaks} pulses`;
  else if (spread < 0.25) words = 'steady pace';
  else if (half < 0.4) words = 'fast start, slow settle';
  else if (half > 0.6) words = 'slow start, fast finish';
  else words = 'slow start and settle';
  return { digits, words, half: round(half, 2), spread: round(spread, 2) };
}

/**
 * Everything that happens in the picture: its cuts, its shots, and in each shot the stretches where it holds still and
 * the changes between them, each with where in the frame it happens and its pace.
 * @param {{ d: number[], cells: Float32Array[], hist: Float32Array[] }} m @param {{ fps: number, width: number, height: number }} v
 */
function analyse(m, { fps, width, height }) {
  const n = m.d.length;
  const cuts = findCuts(m);
  const cutSet = new Set(cuts);
  /* a frame changes when the frame does as a whole, or any one cell of it does: a few letters typed count */
  const floor = stillFloor(m.d, cutSet);
  const peak = m.cells.map((c) => Math.max(...c));
  const cellFloor = Math.max(1.2, stillFloor(peak, cutSet) * 2);
  const active = m.d.map((x, i) => i > 0 && !cutSet.has(i) && (x > floor || peak[i] > cellFloor));
  /* close gaps of a frame or two inside a change */
  for (let i = 1; i < n - 1; i++) {
    if (active[i] || cutSet.has(i)) continue;
    let j = i;
    while (j < n && !active[j] && !cutSet.has(j) && j - i < 2) j++;
    if (j < n && active[j] && active[i - 1] && j - i <= 2) for (let k = i; k < j; k++) active[k] = true;
  }
  const bounds = [0, ...cuts, n];
  const shots = [];
  /** @type {any[]} */ const changes = [];
  /** @type {any[]} */ const holds = [];
  for (let s = 0; s < bounds.length - 1; s++) {
    const a = bounds[s];
    const b = bounds[s + 1];
    const shot = { from: round(a / fps), to: round(b / fps), firstFrame: a, holds: /** @type {any[]} */ ([]), changes: /** @type {any[]} */ ([]) };
    let i = a + 1;
    let stillFrom = a;
    while (i < b) {
      if (!active[i]) { i++; continue; }
      let j = i;
      while (j + 1 < b && active[j + 1]) j++;
      if (j - i + 1 >= 1) {
        if (i - 1 - stillFrom >= Math.max(3, Math.round(fps * 0.2))) shot.holds.push(hold(stillFrom, i - 1));
        const change = describeChange(m, i, j, { fps, width, height, a, b });
        if (change) shot.changes.push(change);
        stillFrom = j;
      }
      i = j + 1;
    }
    if (b - 1 - stillFrom >= Math.max(3, Math.round(fps * 0.2))) shot.holds.push(hold(stillFrom, b - 1));
    shots.push(shot);
    changes.push(...shot.changes);
    holds.push(...shot.holds);
  }
  function hold(/** @type {number} */ x, /** @type {number} */ y) {
    return { from: round(x / fps), to: round(y / fps), look: round(Math.round((x + y) / 2) / fps) };
  }
  return { fps, frames: n, floor: round(floor, 2), cellFloor: round(cellFloor, 2), cuts: cuts.map((i) => ({ at: round(i / fps), frame: i })), shots, changes, holds, active };
}

/**
 * One change: frames i to j change, so the picture of frame i − 1 becomes that of frame j.
 * @param {{ d: number[], cells: Float32Array[], hist: Float32Array[] }} m @param {number} i @param {number} j
 * @param {{ fps: number, width: number, height: number, a: number, b: number }} o
 */
function describeChange(m, i, j, { fps, width, height }) {
  const sums = new Float32Array(GRID * GRID);
  for (let k = i; k <= j; k++) for (let c = 0; c < sums.length; c++) sums[c] += m.cells[k][c];
  const top = Math.max(...sums);
  let x0 = GRID, y0 = GRID, x1 = -1, y1 = -1, count = 0;
  for (let c = 0; c < sums.length; c++) {
    if (sums[c] < 0.2 * top) continue;
    count++;
    const x = c % GRID;
    const y = Math.floor(c / GRID);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  /* its pace: the change of the cells it happens in, frame by frame */
  const pace = [];
  for (let k = i; k <= j; k++) {
    let v = 0, on = 0;
    for (let c = 0; c < sums.length; c++) if (sums[c] >= 0.2 * top) { v += m.cells[k][c]; on++; }
    pace.push(on ? v / on : 0);
  }
  const { digits, words } = describePace(pace);
  const whole = count >= GRID * GRID * 0.7;
  const before = m.hist[Math.max(0, i - 1)];
  const after = m.hist[j];
  const long = (j - i + 1) / fps > 3;
  const kind = whole && long ? 'continuous' : whole && histDistance(before, after) > 0.25 ? 'whole picture' : 'change';
  return {
    from: round((i - 1) / fps),
    to: round(j / fps),
    frames: [i - 1, j],
    region: {
      x: Math.round((x0 / GRID) * width), y: Math.round((y0 / GRID) * height),
      w: Math.round(((x1 - x0 + 1) / GRID) * width), h: Math.round(((y1 - y0 + 1) / GRID) * height),
      cells: [...sums].map((v) => v >= 0.2 * top),
    },
    pace: digits,
    shape: words,
    kind,
  };
}

/** Where in the frame a region is, in a few words. @param {{ x: number, y: number, w: number, h: number }} r @param {number} width @param {number} height */
function place(r, width, height) {
  if (r.w >= width * 0.85 && r.h >= height * 0.85) return 'whole frame';
  const cx = (r.x + r.w / 2) / width;
  const cy = (r.y + r.h / 2) / height;
  const across = cx < 0.36 ? 'left' : cx > 0.64 ? 'right' : 'centre';
  const down = cy < 0.36 ? 'top' : cy > 0.64 ? 'bottom' : 'middle';
  return across === 'centre' && down === 'middle' ? 'centre' : `${down} ${across}`;
}

// ---------------------------------------------------------------- what happens in the sound

/** In-place radix-2 FFT. @param {Float64Array} re @param {Float64Array} im */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * The sound's hits (onsets: where new sound starts, from the rise of its spectrum), its quiet stretches, and its
 * tempo and beats when it has a steady one.
 * @param {Float32Array} samples
 */
function listen(samples) {
  const hann = Float64Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW));
  const frames = Math.floor((samples.length - WINDOW) / HOP) + 1;
  const flux = new Float64Array(frames);
  const level = new Float64Array(frames);
  let previous = new Float64Array(WINDOW / 2);
  const re = new Float64Array(WINDOW);
  const im = new Float64Array(WINDOW);
  for (let f = 0; f < frames; f++) {
    let power = 0;
    for (let i = 0; i < WINDOW; i++) {
      const s = samples[f * HOP + i];
      re[i] = s * hann[i];
      im[i] = 0;
      power += s * s;
    }
    level[f] = 10 * Math.log10(power / WINDOW + 1e-12);
    fft(re, im);
    const mag = new Float64Array(WINDOW / 2);
    let rise = 0;
    for (let k = 0; k < WINDOW / 2; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      if (f > 0) rise += Math.max(0, mag[k] - previous[k]);
    }
    flux[f] = rise;
    previous = mag;
  }
  const hopTime = HOP / RATE;
  const top = Math.max(...flux, 1e-9);
  /* a hit: the rise is the largest around it and well over what is usual near it */
  /** @type {Array<{ at: number, strength: number }>} */ const hits = [];
  for (let f = 1; f < frames - 1; f++) {
    let biggest = true;
    for (let k = Math.max(0, f - 4); k <= Math.min(frames - 1, f + 4); k++) if (flux[k] > flux[f]) { biggest = false; break; }
    if (!biggest) continue;
    const near = [];
    for (let k = Math.max(0, f - 40); k <= Math.min(frames - 1, f + 10); k++) near.push(flux[k]);
    if (flux[f] < median(near) * 1.5 + 0.08 * top || level[f] < -60) continue;
    const last = hits[hits.length - 1];
    if (last && f * hopTime - last.at < 0.06) continue;
    hits.push({ at: round(f * hopTime + WINDOW / RATE / 4), strength: round(flux[f] / top, 2) });
  }
  /* quiet: 0.3 s or more under -50 dBFS */
  /** @type {Array<{ from: number, to: number }>} */ const quiet = [];
  let q = -1;
  for (let f = 0; f <= frames; f++) {
    const silent = f < frames && level[f] < -50;
    if (silent && q < 0) q = f;
    if (!silent && q >= 0) {
      if ((f - q) * hopTime >= 0.3) quiet.push({ from: round(q * hopTime), to: round(f * hopTime) });
      q = -1;
    }
  }
  /* tempo: the beat period whose repeats line up the rises best, 60 to 180 a minute, nearer 120 preferred */
  const mean = flux.reduce((s, x) => s + x, 0) / frames;
  const centred = Float64Array.from(flux, (x) => x - mean);
  const lagOf = (/** @type {number} */ bpm) => Math.round(60 / bpm / hopTime);
  let best = 0, bestScore = -Infinity, zero = 0;
  for (let i = 0; i < frames; i++) zero += centred[i] * centred[i];
  /** @type {Map<number, number>} */ const ac = new Map();
  for (let lag = lagOf(180); lag <= lagOf(60); lag++) {
    let s = 0;
    for (let i = 0; i + lag < frames; i++) s += centred[i] * centred[i + lag];
    s /= frames - lag;
    ac.set(lag, s);
    const bpm = 60 / (lag * hopTime);
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    if (s * prior > bestScore) { bestScore = s * prior; best = lag; }
  }
  const clarity = zero > 0 ? (/** @type {number} */ (ac.get(best)) * frames) / zero : 0;
  /** @type {{ bpm: number, clarity: number, beats: number[] } | null} */ let tempo = null;
  if (best && clarity > 0.12 && frames * hopTime > 4) {
    let phase = 0, phaseScore = -Infinity;
    for (let p = 0; p < best; p++) {
      let s = 0;
      for (let i = p; i < frames; i += best) s += flux[i];
      if (s > phaseScore) { phaseScore = s; phase = p; }
    }
    const beats = [];
    for (let i = phase; i < frames; i += best) beats.push(round(i * hopTime + WINDOW / RATE / 4));
    tempo = { bpm: round(60 / (best * hopTime), 1), clarity: round(clarity, 2), beats };
  }
  return { hits, quiet, tempo };
}

// ---------------------------------------------------------------- study

/** @param {string} file @param {string} [out] */
async function study(file, out) {
  const video = probe(file);
  const size = analysisSize(video.width, video.height);
  const m = /** @type {any} */ (await readFrames(file, { fps: video.fps, ...size }));
  const pic = analyse(m, video);
  const samples = video.sound ? await readSound(file) : null;
  const sound = samples ? listen(samples) : null;
  const folder = resolve(out ?? join(dirname(file), basename(file, extname(file))));
  mkdirSync(folder, { recursive: true });
  const { active, ...picture } = pic;
  const json = {
    file: resolve(file),
    width: video.width, height: video.height, fps: video.fps, duration: round(video.duration), frames: pic.frames,
    picture: { ...picture, changes: undefined, holds: undefined, shots: pic.shots.map((s) => ({ ...s, changes: s.changes.map(({ region: { cells, ...r }, ...c }) => ({ ...c, region: r })) })) },
    sound,
  };
  writeFileSync(join(folder, 'study.json'), `${JSON.stringify(json, null, 1)}\n`);
  const lines = [
    `# ${basename(file)}`,
    '',
    `${video.width}×${video.height}, ${video.fps} fps, ${fmt(video.duration)} s (${pic.frames} frames), ${video.sound ? 'with sound' : 'no sound'}.`,
    'Times are seconds from the start, frame n at n ÷ fps. A change "from a to b" turns the picture at a into the picture at b.',
    'Pace: how much the picture changes each frame across a change, in ten steps (9 is its fastest).',
    '',
    `## Cuts (${pic.cuts.length})`,
    '',
    pic.cuts.length ? pic.cuts.map((c) => `${fmt(c.at)} (frame ${c.frame})`).join(' · ') : 'None: one shot.',
    '',
  ];
  pic.shots.forEach((shot, k) => {
    lines.push(`## Shot ${k + 1}: ${fmt(shot.from)}–${fmt(shot.to)}`, '');
    const events = [
      ...shot.holds.map((h) => ({ at: h.from, line: `- holds ${fmt(h.from)}–${fmt(h.to)} (look at ${fmt(h.look)})` })),
      ...shot.changes.map((c) => ({
        at: c.from,
        line: `- ${c.kind === 'change' ? 'changes' : c.kind === 'continuous' ? 'moves throughout' : 'the whole picture changes'} ${fmt(c.from)}–${fmt(c.to)}`
          + `, ${place(c.region, video.width, video.height)} (x ${c.region.x}–${c.region.x + c.region.w}, y ${c.region.y}–${c.region.y + c.region.h})`
          + `, pace ${c.pace}, ${c.shape}`,
      })),
    ].sort((a, b) => a.at - b.at);
    lines.push(...(events.length ? events.map((e) => e.line) : ['- nothing measured inside it']), '');
  });
  lines.push('## Sound', '');
  if (!sound) lines.push(video.sound ? 'Could not be read.' : 'None.');
  else {
    if (sound.tempo) lines.push(`A steady beat: ${sound.tempo.bpm} a minute (clarity ${sound.tempo.clarity}), the first at ${fmt(sound.tempo.beats[0])}, then every ${fmt(60 / sound.tempo.bpm)} s.`);
    else lines.push('No steady beat.');
    const strong = sound.hits.filter((h) => h.strength >= 0.5);
    lines.push('', `Hits: ${sound.hits.length}, every one in study.json. The strongest (strength 0.5 to 1): ${strong.map((h) => `${fmt(h.at)} (${h.strength})`).join(' · ') || 'none'}`);
    if (sound.quiet.length) lines.push('', `Quiet: ${sound.quiet.map((q) => `${fmt(q.from)}–${fmt(q.to)}`).join(' · ')}`);
  }
  lines.push('');
  writeFileSync(join(folder, 'study.md'), lines.join('\n'));
  console.log(`${pic.cuts.length} cuts, ${pic.changes.length} changes, ${pic.holds.length} holds${sound ? `, ${sound.hits.length} sound hits${sound.tempo ? `, ${sound.tempo.bpm} bpm` : ''}` : ''}`);
  console.log(`→ ${relative(process.cwd(), join(folder, 'study.md')) || join(folder, 'study.md')}`);
}

// ---------------------------------------------------------------- compare

/** How alike two grey pictures are: SSIM over 8×8 blocks, 1 the same. @param {Uint8Array} a @param {Uint8Array} b @param {number} w @param {number} h */
function ssim(a, b, w, h) {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let total = 0, blocks = 0;
  for (let by = 0; by + 8 <= h; by += 4) {
    for (let bx = 0; bx + 8 <= w; bx += 4) {
      let ma = 0, mb = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const i = (by + y) * w + bx + x; ma += a[i]; mb += b[i]; }
      ma /= 64; mb /= 64;
      let va = 0, vb = 0, cov = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const i = (by + y) * w + bx + x;
        va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; cov += (a[i] - ma) * (b[i] - mb);
      }
      va /= 63; vb /= 63; cov /= 63;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      blocks++;
    }
  }
  return blocks ? total / blocks : 1;
}

/** How alike two colour pictures are: 1 less their mean difference. @param {Uint8Array} a @param {Uint8Array} b */
const colourMatch = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return 1 - s / a.length / 255;
};

/* a palette's bins: 12 hues × 2 saturations × 3 brightnesses for colours, and 4 brightnesses for greys */
const BINS_COLOUR = 72;
/** A colour picture's palette: the share of its pixels in each bin, by hue, saturation and brightness. @param {Uint8Array} rgb */
function palette(rgb) {
  const bins = new Float64Array(BINS_COLOUR + 4);
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i] / 255, g = rgb[i + 1] / 255, b = rgb[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const sat = max ? d / max : 0;
    if (sat < 0.06 || d < 0.03) { bins[BINS_COLOUR + Math.min(3, Math.floor(max * 4))]++; continue; }
    let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
    bins[(Math.floor(hue / 30) * 2 + (sat < 0.35 ? 0 : 1)) * 3 + Math.min(2, Math.floor(max * 3))]++;
  }
  const n = rgb.length / 3;
  for (let q = 0; q < bins.length; q++) bins[q] /= n;
  return bins;
}

/** A grey picture's layout: where it is light and dark, as a 16 × 9 grid of mean brightness. @param {Uint8Array} g @param {number} w @param {number} h */
function layout(g, w, h) {
  const out = new Float64Array(16 * 9);
  const count = new Float64Array(16 * 9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = Math.min(8, Math.floor((y * 9) / h)) * 16 + Math.min(15, Math.floor((x * 16) / w));
      out[c] += g[y * w + x];
      count[c]++;
    }
  }
  for (let c = 0; c < out.length; c++) out[c] /= count[c] || 1;
  return [...out];
}

/** Pearson correlation of two series of the same length. @param {number[]} a @param {number[]} b */
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = a.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const mb = b.slice(0, n).reduce((s, x) => s + x, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
  return va && vb ? cov / Math.sqrt(va * vb) : 0;
}

/**
 * Each reference time matched to the nearest remake time within `within` seconds, each remake time used once.
 * @param {number[]} ref @param {number[]} remake @param {number} within
 */
function match(ref, remake, within) {
  const used = new Set();
  const pairs = [];
  const missing = [];
  for (const t of ref) {
    let best = -1;
    for (let i = 0; i < remake.length; i++) {
      if (used.has(i) || Math.abs(remake[i] - t) > within) continue;
      if (best < 0 || Math.abs(remake[i] - t) < Math.abs(remake[best] - t)) best = i;
    }
    if (best < 0) missing.push(t);
    else { used.add(best); pairs.push({ ref: t, remake: remake[best], off: remake[best] - t }); }
  }
  const extra = remake.filter((_, i) => !used.has(i));
  return { pairs, missing, extra };
}

/** A side-by-side picture, the reference at `a` on the left and the remake at `b` on the right. */
function sideBySide(/** @type {string} */ refFile, /** @type {number} */ a, /** @type {string} */ remakeFile, /** @type {number} */ b, /** @type {string} */ out, /** @type {{ width: number, height: number }} */ v) {
  const long = 640;
  const pw = v.width >= v.height ? long : Math.round((long * v.width) / v.height / 2) * 2;
  const ph = v.width >= v.height ? Math.round((long * v.height) / v.width / 2) * 2 : long;
  const fit = `scale=${pw}:${ph}:force_original_aspect_ratio=decrease,pad=${pw}:${ph}:-1:-1:color=gray`;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(a), '-i', refFile, '-ss', String(b), '-i', remakeFile,
    '-filter_complex', `[0:v]${fit}[a];[1:v]${fit}[b];[a][b]hstack=inputs=2`, '-frames:v', '1', out], { encoding: 'utf8' });
  return r.status === 0;
}

// ---------------------------------------------------------------- the reference in the remake

/* frames are hashed squeezed to this square, whatever their shape */
const SIDE = 256;
/* a frame of the reference: hashes this close (of 63 bits), then high-passed pixels this alike, on a frame with this much detail */
const HASH_NEAR = 12;
const PIXEL_ALIKE = 0.8;
const DETAIL = 6;
/* its sound, at 16 kHz with a 32 ms window every 10 ms: this many landmarks at one offset within LEAK_SPAN seconds */
const LEAK_RATE = 16000;
const LEAK_WINDOW = 512;
const LEAK_HOP = 160;
const LEAK_BINS = LEAK_WINDOW / 2 + 1;
const LANDMARKS = 12;
const LEAK_SPAN = 3;
/* a run of its words worth naming, in characters (CJK) or words */
const RUN_CJK = 12;
const RUN_WORDS = 8;

/**
 * @typedef {{ x: number, y: number, w: number, h: number }} Crop
 * @typedef {{ t: number, hash: Uint32Array, small: Uint8Array, cropHash?: Uint32Array, cropSmall?: Uint8Array }} Print
 * @typedef {{ t: number, end: number, text: string }} Word
 */

/** Box-averages `crop` of a size × size grey picture into out × out. @param {Uint8Array} src @param {number} size @param {Crop} crop @param {number} out */
function shrink(src, size, crop, out) {
  const dst = new Uint8Array(out * out);
  const x0 = crop.x * size, y0 = crop.y * size, cw = (crop.w * size) / out, ch = (crop.h * size) / out;
  for (let oy = 0; oy < out; oy++) {
    const ya = Math.floor(y0 + oy * ch), yb = Math.max(ya + 1, Math.floor(y0 + (oy + 1) * ch));
    for (let ox = 0; ox < out; ox++) {
      const xa = Math.floor(x0 + ox * cw), xb = Math.max(xa + 1, Math.floor(x0 + (ox + 1) * cw));
      let sum = 0;
      for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) sum += src[y * size + x];
      dst[oy * out + ox] = Math.round(sum / ((yb - ya) * (xb - xa)));
    }
  }
  return dst;
}

const COS = Array.from({ length: 8 }, (_, k) => Float64Array.from({ length: 32 }, (_, n) => Math.cos((Math.PI * (2 * n + 1) * k) / 64)));

/** A 63-bit perceptual hash (the lowest 8 × 8 DCT terms against their median, DC left out) of a 32 × 32 picture. @param {Uint8Array} px */
function phash(px) {
  const rows = new Float64Array(32 * 8);
  for (let y = 0; y < 32; y++) {
    for (let k = 0; k < 8; k++) {
      let s = 0;
      for (let x = 0; x < 32; x++) s += px[y * 32 + x] * COS[k][x];
      rows[y * 8 + k] = s;
    }
  }
  const terms = new Float64Array(64);
  for (let ky = 0; ky < 8; ky++) {
    for (let kx = 0; kx < 8; kx++) {
      let s = 0;
      for (let y = 0; y < 32; y++) s += COS[ky][y] * rows[y * 8 + kx];
      terms[ky * 8 + kx] = s;
    }
  }
  const middle = [...terms.subarray(1)].sort((a, b) => a - b)[31];
  const hash = new Uint32Array(2);
  for (let i = 1; i < 64; i++) if (terms[i] > middle) hash[i >> 5] |= 1 << (i & 31);
  return hash;
}

const bits = (/** @type {number} */ v) => { v -= (v >>> 1) & 0x55555555; v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
const distance = (/** @type {Uint32Array} */ a, /** @type {Uint32Array} */ b) => bits(a[0] ^ b[0]) + bits(a[1] ^ b[1]);

/**
 * Every frame's hash and 48 × 48 grey copy; `crop` adds those of that part, to find one video shown inside the other.
 * @param {string} file @param {number} fps @param {Crop} [crop] @returns {Promise<Print[]>}
 */
function readPrints(file, fps, crop) {
  return new Promise((done, failed) => {
    const size = SIDE * SIDE;
    const whole = { x: 0, y: 0, w: 1, h: 1 };
    /** @type {Print[]} */ const prints = [];
    const take = (/** @type {Uint8Array} */ g) => {
      /** @type {Print} */
      const print = { t: prints.length / fps, hash: phash(shrink(g, SIDE, whole, 32)), small: shrink(g, SIDE, whole, 48) };
      if (crop) { print.cropHash = phash(shrink(g, SIDE, crop, 32)); print.cropSmall = shrink(g, SIDE, crop, 48); }
      prints.push(print);
    };
    const proc = spawn('ffmpeg', ['-v', 'error', '-i', file, '-an', '-vf', `fps=${fps},scale=${SIDE}:${SIDE}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = Buffer.alloc(0);
    let errors = '';
    proc.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let at = 0;
      for (; at + size <= pending.length; at += size) take(pending.subarray(at, at + size));
      pending = pending.subarray(at);
    });
    proc.stderr.on('data', (chunk) => { errors += chunk; });
    proc.on('error', (e) => failed(new Error(`ffmpeg: ${e.message}`)));
    proc.on('close', (code) => (code === 0 ? done(prints) : failed(new Error(`ffmpeg could not read ${file}: ${errors.trim()}`))));
  });
}

/** A 48 × 48 grey picture less its 3 × 3 blur, and how much detail that leaves. @param {Uint8Array} px */
function highPass(px) {
  const out = new Float32Array(48 * 48);
  let energy = 0;
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= 48 || xx < 0 || xx >= 48) continue;
          sum += px[yy * 48 + xx];
          n++;
        }
      }
      const v = px[y * 48 + x] - sum / n;
      out[y * 48 + x] = v;
      energy += v * v;
    }
  }
  return { px: out, detail: energy / out.length };
}

const alike = (/** @type {Float32Array} */ a, /** @type {Float32Array} */ b) => {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
};

/** Times within `gap` of each other as spans: where they are in the reference, how many, their best score. */
function spans(/** @type {{ t: number, refT: number, score: number }[]} */ hits, /** @type {number} */ gap) {
  /** @type {{ from: number, to: number, refFrom: number, count: number, score: number }[]} */
  const out = [];
  for (const h of hits.sort((a, b) => a.t - b.t)) {
    const last = out[out.length - 1];
    if (last && h.t - last.to <= gap) { last.to = h.t; last.count++; last.score = Math.max(last.score, h.score); }
    else out.push({ from: h.t, to: h.t, refFrom: h.refT, count: 1, score: h.score });
  }
  return out;
}

/** The remake's frames that are frames of the reference, whole or cropped either way, as spans. @param {Print[]} ref @param {Print[]} remake */
function leakedPictures(ref, remake) {
  const cache = new Map();
  const hp = (/** @type {Uint8Array} */ px) => { let v = cache.get(px); if (!v) cache.set(px, (v = highPass(px))); return v; };
  const hits = [];
  for (const f of remake) {
    let best = { score: 0, refT: 0 };
    for (const [hash, small, refHash, refSmall] of /** @type {any[]} */ ([[f.hash, f.small, 'hash', 'small'], [f.hash, f.small, 'cropHash', 'cropSmall'], [f.cropHash, f.cropSmall, 'hash', 'small']])) {
      if (!hash) continue;
      const mine = hp(small);
      if (mine.detail < DETAIL) continue;
      for (const r of /** @type {any[]} */ (ref)) {
        if (!r[refHash] || distance(hash, r[refHash]) > HASH_NEAR) continue;
        const theirs = hp(r[refSmall]);
        if (theirs.detail < DETAIL) continue;
        const score = alike(mine.px, theirs.px);
        if (score > best.score) best = { score, refT: r.t };
      }
    }
    if (best.score >= PIXEL_ALIKE) hits.push({ t: f.t, refT: best.refT, score: best.score });
  }
  return spans(hits, 0.25);
}

/** Log magnitudes of a sound, one row per step. @param {Float32Array | null} samples */
function spectrum(samples) {
  const steps = samples && samples.length >= LEAK_WINDOW ? Math.floor((samples.length - LEAK_WINDOW) / LEAK_HOP) + 1 : 0;
  const mags = new Float32Array(steps * LEAK_BINS);
  const hann = Float64Array.from({ length: LEAK_WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / LEAK_WINDOW));
  const re = new Float64Array(LEAK_WINDOW), im = new Float64Array(LEAK_WINDOW);
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < LEAK_WINDOW; i++) { re[i] = /** @type {Float32Array} */ (samples)[s * LEAK_HOP + i] * hann[i]; im[i] = 0; }
    fft(re, im);
    for (let f = 0; f < LEAK_BINS; f++) mags[s * LEAK_BINS + f] = Math.log1p((100 * Math.hypot(re[f], im[f])) / (LEAK_WINDOW / 2));
  }
  return { steps, mags };
}

/** Spectral landmarks: pairs of peaks, as key → the steps where they start. @param {{ steps: number, mags: Float32Array }} s */
function landmarks({ steps, mags }) {
  /** @type {{ s: number, f: number, v: number }[][]} */
  const byStep = [];
  for (let s = 0; s < steps; s++) {
    const row = mags.subarray(s * LEAK_BINS, (s + 1) * LEAK_BINS);
    const mean = row.reduce((a, b) => a + b, 0) / LEAK_BINS;
    const local = [];
    for (let f = 6; f < 200; f++) {
      if (row[f] < mean + 0.5) continue;
      let peak = true;
      for (let g = f - 3; g <= f + 3; g++) if (g !== f && row[g] >= row[f]) peak = false;
      if (peak) local.push({ s, f, v: row[f] });
    }
    byStep.push(local.sort((a, b) => b.v - a.v).slice(0, 5));
  }
  const kept = [];
  for (let s = 0; s < steps; s++) {
    for (const p of byStep[s]) {
      let best = true;
      for (let r = Math.max(0, s - 4); r <= Math.min(steps - 1, s + 4) && best; r++) {
        for (const q of byStep[r]) if (q !== p && Math.abs(q.f - p.f) <= 3 && q.v > p.v) { best = false; break; }
      }
      if (best) kept.push(p);
    }
  }
  /** @type {Map<number, number[]>} */
  const keys = new Map();
  for (let i = 0; i < kept.length; i++) {
    let made = 0;
    for (let j = i + 1; j < kept.length && made < 5; j++) {
      const dt = kept[j].s - kept[i].s;
      if (dt > 48) break;
      if (dt < 2 || Math.abs(kept[j].f - kept[i].f) > 32) continue;
      const key = (kept[i].f << 14) | (kept[j].f << 6) | dt;
      const list = keys.get(key);
      if (list) list.push(kept[i].s); else keys.set(key, [kept[i].s]);
      made++;
    }
  }
  return keys;
}

/** The stretches of the remake whose sound is the reference's: many landmarks at one offset. @param {Map<number, number[]>} ref @param {Map<number, number[]>} remake */
function leakedSound(ref, remake) {
  const stepTime = (/** @type {number} */ s) => (s * LEAK_HOP + LEAK_WINDOW / 2) / LEAK_RATE;
  /** @type {Map<number, number[]>} */
  const byOffset = new Map();
  for (const [key, steps] of remake) {
    const theirs = ref.get(key);
    if (!theirs) continue;
    for (const s of steps) {
      for (const r of theirs) {
        const list = byOffset.get(r - s);
        if (list) list.push(s); else byOffset.set(r - s, [s]);
      }
    }
  }
  const span = (LEAK_SPAN * LEAK_RATE) / LEAK_HOP;
  const hits = [];
  for (const [off, steps] of byOffset) {
    const near = [...new Set([...steps, ...(byOffset.get(off - 1) ?? []), ...(byOffset.get(off + 1) ?? [])])].sort((a, b) => a - b);
    if (near.length < LANDMARKS) continue;
    const inside = new Uint8Array(near.length);
    for (let i = 0, j = 0; j < near.length; j++) {
      while (near[j] - near[i] > span) i++;
      if (j - i + 1 >= LANDMARKS) inside.fill(1, i, j + 1);
    }
    near.forEach((s, k) => { if (inside[k]) hits.push({ t: stepTime(s), refT: stepTime(s + off), score: 1 }); });
  }
  return spans(hits, LEAK_SPAN).map((s) => ({ ...s, to: s.to + LEAK_WINDOW / LEAK_RATE }));
}

/** `00:00:01.250` or `00:01.250` → seconds. @param {string} stamp */
const seconds = (stamp) => {
  const parts = stamp.trim().split(':').map(Number);
  return parts.length < 2 || parts.some((n) => !Number.isFinite(n)) ? NaN : parts.reduce((acc, n) => acc * 60 + n, 0);
};

/** The words a WebVTT times: a cue's timestamp tags start its words; a cue without them is one. @param {string} body */
function vttWords(body) {
  /** @type {Word[]} */
  const words = [];
  for (const block of body.replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/)) {
    const rows = block.split('\n');
    const timing = rows.findIndex((r) => r.includes('-->'));
    if (timing < 0 || /^(NOTE|STYLE|REGION)\b/.test(rows[0] ?? '')) continue;
    const [a, b] = rows[timing].split('-->');
    const start = seconds(a), end = seconds(b.trim().split(/\s+/)[0] ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    /** @type {Word[]} */
    const cue = [];
    let at = start, fresh = true;
    for (const [, tag, chunk] of rows.slice(timing + 1).join(' ').matchAll(/<([^>]*)>|([^<]+)/g)) {
      if (tag !== undefined) {
        const s = seconds(tag);
        if (Number.isFinite(s)) { at = s; fresh = true; }
        continue;
      }
      const text = chunk.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
      if (!text.trim()) continue;
      if (fresh || !cue.length) cue.push({ t: at, end, text: text.trim() });
      else cue[cue.length - 1].text += text;
      fresh = false;
    }
    cue.forEach((w, i) => { w.end = i + 1 < cue.length ? cue[i + 1].t : Math.max(end, w.t); w.text = w.text.replace(/\s+/g, ' ').trim(); });
    words.push(...cue);
  }
  return words.sort((x, y) => x.t - y.t);
}

/** A media file's transcript: the WebVTT beside it with the same name. @param {string} file */
const transcriptOf = (file) => file.slice(0, file.length - extname(file).length) + '.vtt';

/** film.html's clips: element, file (relative to film.html), in and out points, place, speed, shown, heard. @param {string} html */
function clips(html) {
  const body = readFileSync(html, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  /* attributes; a quoted value may hold a ">" (the person's overrides) */
  const attrs = String.raw`((?:[^>"']|"[^"]*"|'[^']*')*)`;
  const has = (/** @type {string} */ text, /** @type {string} */ name) => new RegExp(`(?:^|\\s)${name}(?=[\\s=>]|$)`).test(text);
  const out = [];
  for (const [, track, inner] of body.matchAll(new RegExp(String.raw`<section\b${attrs}>([\s\S]*?)<\/section>`, 'g'))) {
    for (const [, tag, own] of inner.matchAll(new RegExp(String.raw`<(iframe|video|img|audio)\b${attrs}>`, 'g'))) {
      const attr = (/** @type {string} */ name) => {
        const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`).exec(own);
        return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
      };
      const src = attr('src');
      if (!src) continue;
      const [path, fragment = ''] = src.split('#');
      const t = /t=([\d.]*)(?:,([\d.]+))?/.exec(fragment);
      let file = path.replace(/&amp;/g, '&');
      try { file = decodeURI(file); } catch { /* an escape that is not one: the path as written */ }
      out.push({
        tag, path: file, from: Number(t?.[1] || 0), to: t?.[2] ? Number(t[2]) : Infinity,
        at: Number(attr('at') ?? 0), speed: Number(attr('speed') ?? 1),
        shown: !has(track, 'hidden') && !has(own, 'hidden'),
        heard: !has(track, 'hidden') && !has(track, 'muted') && !has(own, 'muted') && Number(attr('volume') ?? 1) > 0,
      });
    }
  }
  return out;
}

/** The remake's words: its clips' transcripts, placed where the clips play. @param {string} html */
function filmWords(html) {
  /** @type {Word[]} */
  const words = [];
  for (const c of clips(html)) {
    if (!c.heard || (c.tag !== 'audio' && c.tag !== 'video')) continue;
    const vtt = join(dirname(html), transcriptOf(c.path));
    if (!existsSync(vtt)) continue;
    for (const w of vttWords(readFileSync(vtt, 'utf8'))) {
      if (w.t < c.from || w.t >= c.to) continue;
      words.push({ text: w.text, t: c.at + (w.t - c.from) / c.speed, end: c.at + (Math.min(w.end, c.to) - c.from) / c.speed });
    }
  }
  return words.sort((a, b) => a.t - b.t);
}

/** film.html for a render: the folder it is in or any above it, else the working folder. @param {string} video */
function findFilm(video) {
  for (let dir = dirname(resolve(video)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'film.html'))) return join(dir, 'film.html');
    if (dirname(dir) === dir) break;
  }
  return existsSync('film.html') ? resolve('film.html') : null;
}

/** Clips in film.html that are the reference: under references/, the same bytes, or a page that names references/. @param {string} html @param {string} reference */
function leakedFiles(html, reference) {
  const dir = dirname(html);
  const size = statSync(reference).size;
  const digest = (/** @type {string} */ f) => createHash('sha1').update(readFileSync(f)).digest('hex');
  let refDigest = '';
  const found = [];
  for (const c of clips(html)) {
    const file = resolve(dir, c.path);
    const rel = relative(dir, file).replace(/\\/g, '/');
    if (rel.startsWith('references/') || file === resolve(reference)) { found.push(rel); continue; }
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    if (c.tag === 'iframe') {
      if (/["'(/]references\//.test(readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, ''))) found.push(rel);
      continue;
    }
    if (statSync(file).size !== size) continue;
    refDigest ||= digest(reference);
    if (digest(file) === refDigest) found.push(rel);
  }
  return [...new Set(found)];
}

/** The tokens words are compared by: each CJK character, each other word, lowercased, no punctuation. @param {Word[]} words */
function tokens(words) {
  const out = [];
  for (const w of words) {
    for (const m of w.text.toLowerCase().matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+/gu)) {
      out.push({ text: m[0], t: w.t, cjk: m[0].length === 1 && /[^\p{Script=Latin}\p{N}]/u.test(m[0]) });
    }
  }
  return out;
}

/** How much of the remake's wording is the reference's: its shared 6-token runs, and the longest run. @param {Word[]} ref @param {Word[]} remake */
function sharedWords(ref, remake) {
  const a = tokens(ref), b = tokens(remake);
  const grams = (/** @type {{ text: string }[]} */ list) => list.slice(0, Math.max(0, list.length - 5)).map((_, i) => list.slice(i, i + 6).map((x) => x.text).join(' '));
  const refGrams = new Set(grams(a));
  const mine = grams(b);
  const shared = mine.filter((g) => refGrams.has(g)).length;
  let best = { length: 0, i: 0, j: 0 };
  let prev = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const row = new Uint32Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1].text !== b[j - 1].text) continue;
      row[j] = prev[j - 1] + 1;
      if (row[j] > best.length) best = { length: row[j], i: i - row[j], j: j - row[j] };
    }
    prev = row;
  }
  const run = b.slice(best.j, best.j + best.length);
  const cjk = run.filter((x) => x.cjk).length > run.length / 2;
  return {
    share: round(mine.length ? shared / mine.length : 0, 2), run: run.map((x) => x.text).join(cjk ? '' : ' '), length: best.length, cjk,
    at: round(run[0]?.t ?? 0), refAt: round(a[best.i]?.t ?? 0), long: best.length >= (cjk ? RUN_CJK : RUN_WORDS),
  };
}

/**
 * What of the reference is in the remake: its frames (re-encoded, cropped to fill or fitted with bars), its sound, a
 * clip pointing into references/, and runs of its words. A frame that alike where only pages play is told apart: a
 * copy drawn frame for frame, not the reference's footage.
 * @param {string} refFile @param {string} remakeFile @param {{ width: number, height: number, fps: number, sound: boolean }} ref
 * @param {{ width: number, height: number, sound: boolean }} mine @param {string} [film]
 */
async function findLeaks(refFile, remakeFile, ref, mine, film) {
  const ratio = (mine.width / mine.height) / (ref.width / ref.height);
  /* the reference cropped to fill the remake's frame, and the part of the remake a whole reference with bars would take */
  const fill = Math.abs(ratio - 1) < 0.03 ? undefined : ratio < 1 ? { x: (1 - ratio) / 2, y: 0, w: ratio, h: 1 } : { x: 0, y: (1 - 1 / ratio) / 2, w: 1, h: 1 / ratio };
  const fit = !fill ? undefined : ratio < 1 ? { x: 0, y: (1 - ratio) / 2, w: 1, h: ratio } : { x: (1 - 1 / ratio) / 2, y: 0, w: 1 / ratio, h: 1 };
  const html = film ? resolve(film) : findFilm(remakeFile);
  if (html && !existsSync(html)) throw new Error(`${html}: no such file`);
  const [refPrints, minePrints] = await Promise.all([readPrints(refFile, ref.fps, fill), readPrints(remakeFile, ref.fps, fit)]);
  const footage = html ? clips(html).filter((c) => c.shown && (c.tag === 'video' || c.tag === 'img')) : [];
  const playsAt = (/** @type {{ from: number, to: number }} */ p) => footage.some((c) => c.at <= p.to + 0.1 && c.at + (c.to - c.from) / c.speed >= p.from - 0.1);
  const seen = leakedPictures(refPrints, minePrints);
  const pictures = seen.filter((p) => !html || playsAt(p));
  const drawn = seen.filter((p) => html && !playsAt(p));
  let sound = /** @type {ReturnType<typeof leakedSound>} */ ([]);
  if (ref.sound && mine.sound) {
    const [a, b] = await Promise.all([readSound(refFile, LEAK_RATE), readSound(remakeFile, LEAK_RATE)]);
    sound = leakedSound(landmarks(spectrum(a)), landmarks(spectrum(b)));
  }
  const refVtt = transcriptOf(refFile), mineVtt = transcriptOf(remakeFile);
  const refWords = existsSync(refVtt) ? vttWords(readFileSync(refVtt, 'utf8')) : null;
  let mineWords = existsSync(mineVtt) ? vttWords(readFileSync(mineVtt, 'utf8')) : html ? filmWords(html) : null;
  if (mineWords && !mineWords.length) mineWords = null;
  const span = (/** @type {{ from: number, to: number, refFrom: number, count: number, score: number }} */ s) => ({ from: round(s.from), to: round(s.to), refFrom: round(s.refFrom), count: s.count, score: round(s.score, 2) });
  return {
    film: html, frames: minePrints.length,
    pictures: pictures.map(span), drawn: drawn.map(span), sound: sound.map(span), files: html ? leakedFiles(html, refFile) : [],
    words: refWords && mineWords ? sharedWords(refWords, mineWords) : null,
    wordsMissing: !refWords ? refVtt : !mineWords ? mineVtt : null,
  };
}

/** @param {string} refFile @param {string} remakeFile @param {{ out?: string, fit?: boolean, film?: string }} o */
async function compare(refFile, remakeFile, { out, fit = false, film }) {
  const ref = probe(refFile);
  const mine = probe(remakeFile);
  const size = analysisSize(ref.width, ref.height);
  const [a, b] = /** @type {any[]} */ (await Promise.all([
    readFrames(refFile, { fps: ref.fps, ...size, keep: true }),
    readFrames(remakeFile, { fps: ref.fps, ...size, keep: true }),
  ]));
  const pa = analyse(a, ref);
  const pb = analyse(b, { ...mine, fps: ref.fps, width: ref.width, height: ref.height });
  const scale = fit ? mine.duration / ref.duration : 1;
  /** a reference time as the remake's */
  const toRemake = (/** @type {number} */ t) => t * scale;
  const frame = 1 / ref.fps;
  const folder = resolve(out ?? join(dirname(refFile), 'compare'));
  mkdirSync(folder, { recursive: true });

  /* timing: cuts, the starts and settles of changes, and sound hits */
  const starts = (/** @type {any} */ p) => p.changes.filter((/** @type {any} */ c) => c.kind !== 'continuous').map((/** @type {any} */ c) => c.from);
  const ends = (/** @type {any} */ p) => p.changes.filter((/** @type {any} */ c) => c.kind !== 'continuous').map((/** @type {any} */ c) => c.to);
  const back = (/** @type {number[]} */ ts) => ts.map((t) => t / scale);
  const cuts = match(pa.cuts.map((/** @type {any} */ c) => c.at), back(pb.cuts.map((/** @type {any} */ c) => c.at)), 0.25);
  const moveStarts = match(starts(pa), back(starts(pb)), 0.3);
  const moveEnds = match(ends(pa), back(ends(pb)), 0.3);
  const [sa, sb] = ref.sound && mine.sound ? await Promise.all([readSound(refFile), readSound(remakeFile)]) : [null, null];
  const hits = sa && sb ? match(listen(sa).hits.filter((h) => h.strength >= 0.2).map((h) => h.at), back(listen(sb).hits.filter((h) => h.strength >= 0.2).map((h) => h.at)), 0.15) : null;

  /* rhythm: whether the two change at the same moments */
  const curve = (/** @type {number[]} */ d) => d.map((x, i) => Math.log1p((d[i - 1] ?? x) / 3 + x / 3 + (d[i + 1] ?? x) / 3));
  const ca = curve(a.d);
  const cbRaw = curve(b.d);
  const cb = ca.map((_, i) => cbRaw[Math.min(cbRaw.length - 1, Math.round(i * scale))] ?? 0);
  const rhythm = correlation(ca, cb);

  /* motion: each change of the reference, paired with the remake's change that overlaps it most near the same time;
     their pace and length compared over the reference's part of the frame */
  const motion = [];
  const tolerance = Math.round(0.3 * ref.fps);
  const sum = (/** @type {number[]} */ xs) => xs.reduce((s, x) => s + x, 0);
  for (const c of pa.changes) {
    if (c.kind === 'continuous') continue;
    const [i, j] = c.frames;
    const cells = c.region.cells;
    const paceIn = (/** @type {any} */ m, /** @type {number} */ x, /** @type {number} */ y) => {
      const out = [];
      for (let k = Math.max(1, x + 1); k <= Math.min(m.d.length - 1, y); k++) {
        let s = 0, n = 0;
        for (let q = 0; q < cells.length; q++) if (cells[q]) { s += m.cells[k][q]; n++; }
        out.push(n ? s / n : 0);
      }
      return out;
    };
    const refPace = paceIn(a, i, j);
    const ri = Math.round(i * scale);
    const rj = Math.max(ri + 1, Math.round(j * scale));
    /** @type {any} */ let partner = null;
    let overlapBest = -Infinity;
    for (const r of pb.changes) {
      const [x, y] = r.frames;
      if (y < ri - tolerance || x > rj + tolerance) continue;
      const shared = r.region.cells.filter((/** @type {boolean} */ on, /** @type {number} */ q) => on && cells[q]).length;
      if (!shared) continue;
      /* the nearest in both its start and its settle; then the one sharing more of the frame */
      const score = -(Math.abs(x - ri) + Math.abs(y - rj)) + shared / 64;
      if (partner === null || score > overlapBest) { overlapBest = score; partner = r; }
    }
    const theirs = describePace(refPace);
    const length = round(c.to - c.from);
    let issue = null;
    /** @type {any} */ let ours = null;
    let theirLength = null;
    if (!partner) {
      const around = paceIn(b, Math.max(0, ri - tolerance), rj + tolerance);
      issue = sum(around) < 0.15 * sum(refPace) ? 'still in the remake' : 'the remake changes here, but not as one change';
    } else {
      ours = describePace(paceIn(b, partner.frames[0], partner.frames[1]));
      theirLength = round((partner.to - partner.from) / scale);
      const notes = [];
      if (Math.abs(theirLength - length) > Math.max(2 / ref.fps, 0.25 * length)) notes.push(`takes ${fmt(theirLength)} s, the reference ${fmt(length)} s`);
      const eased = (/** @type {any} */ p) => p.spread >= 0.25;
      if (theirs.words !== 'at once' && ours.words !== 'at once' && (Math.abs(theirs.half - ours.half) > 0.15 || eased(theirs) !== eased(ours))) {
        notes.push(`pace ${ours.digits} (${ours.words}), the reference ${theirs.digits} (${theirs.words})`);
      }
      if (notes.length) issue = notes.join('; ');
    }
    motion.push({ from: c.from, to: c.to, where: place(c.region, ref.width, ref.height), reference: { ...theirs, length }, remake: ours && { ...ours, length: theirLength }, issue });
  }

  /* pictures: frame by frame at the same times */
  const n = a.grey.length;
  const perFrame = [];
  for (let i = 0; i < n; i++) {
    const k = Math.min(b.grey.length - 1, Math.round(i * scale));
    perFrame.push({ i, ssim: ssim(a.grey[i], b.grey[k], a.w, a.h), colour: colourMatch(a.colour[i], b.colour[k]) });
  }
  const mean = (/** @type {number[]} */ xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  /* each shot's look whatever is in it: its palette (the share of colours both have) and its layout (where it is
     light and dark), over the shot's frames together; they hold when the content changes and the look does not */
  const shots = pa.shots.map((/** @type {any} */ s) => {
    const last = Math.min(n, Math.max(s.firstFrame + 1, Math.round(s.to * ref.fps)));
    const fs = perFrame.slice(s.firstFrame, last);
    const pa2 = new Float64Array(BINS_COLOUR + 4), pb2 = new Float64Array(BINS_COLOUR + 4);
    const la = new Array(144).fill(0), lb = new Array(144).fill(0);
    for (let i = s.firstFrame; i < last; i++) {
      const k = Math.min(b.grey.length - 1, Math.round(i * scale));
      palette(a.colour[i]).forEach((v, q) => { pa2[q] += v; });
      palette(b.colour[k]).forEach((v, q) => { pb2[q] += v; });
      layout(a.grey[i], a.w, a.h).forEach((v, q) => { la[q] += v; });
      layout(b.grey[k], b.w, b.h).forEach((v, q) => { lb[q] += v; });
    }
    const frames = last - s.firstFrame;
    let shared = 0;
    for (let q = 0; q < pa2.length; q++) shared += Math.min(pa2[q], pb2[q]) / frames;
    return {
      from: s.from, to: s.to, ssim: round(mean(fs.map((f) => f.ssim))), colour: round(mean(fs.map((f) => f.colour))),
      palette: round(shared, 2), layout: round(correlation(la, lb), 2),
    };
  });
  /* the least alike moments, half a second apart at least */
  const worst = [];
  for (const f of [...perFrame].sort((x, y) => x.ssim - y.ssim)) {
    if (worst.length >= 6) break;
    if (worst.some((w) => Math.abs(w.i - f.i) < ref.fps / 2)) continue;
    worst.push(f);
  }

  /* side-by-side pictures: the least alike moments, and the reference's changes the remake misses or paces otherwise */
  /** @type {Map<number, string>} */ const pictures = new Map();
  const picture = (/** @type {number} */ t) => {
    const key = round(t);
    if (pictures.has(key)) return pictures.get(key);
    const name = `${fmt(key)}.png`;
    if (sideBySide(refFile, key, remakeFile, toRemake(key), join(folder, name), ref)) pictures.set(key, name);
    return pictures.get(key);
  };
  const worstShown = worst.map((f) => ({ at: round(f.i / ref.fps), ssim: round(f.ssim), colour: round(f.colour), picture: picture(f.i / ref.fps) }));
  const issues = motion.filter((m) => m.issue).slice(0, 8).map((m) => ({ ...m, picture: picture((m.from + m.to) / 2) }));
  const missedCuts = cuts.missing.slice(0, 4).map((t) => ({ at: t, picture: picture(t + frame / 2) }));

  const leaks = await findLeaks(refFile, remakeFile, ref, mine, film);
  const leaked = leaks.pictures.length + leaks.sound.length + leaks.files.length > 0;

  const frames = (/** @type {number} */ s) => Math.abs(s) * ref.fps;
  const within = (/** @type {{ pairs: Array<{ off: number }> }} */ m, /** @type {number} */ k) => m.pairs.filter((p) => frames(p.off) <= k + 0.01).length;
  const summary = (/** @type {{ pairs: Array<{ off: number }>, missing: number[], extra: number[] }} */ m, /** @type {number} */ total, /** @type {number} */ k) => {
    const offs = m.pairs.map((p) => frames(p.off));
    return { total, within: within(m, k), frames: k, matched: m.pairs.length, mean: round(mean(offs), 1), worst: round(Math.max(0, ...offs), 1), missing: m.missing.map((t) => round(t)), extra: m.extra.map((t) => round(t)) };
  };
  const json = {
    reference: resolve(refFile), remake: resolve(remakeFile),
    lengths: [round(ref.duration), round(mine.duration)], scale: round(scale, 4), fps: ref.fps,
    timing: {
      cuts: summary(cuts, pa.cuts.length, 1),
      starts: summary(moveStarts, starts(pa).length, 2),
      settles: summary(moveEnds, ends(pa).length, 2),
      hits: hits && summary(hits, hits.pairs.length + hits.missing.length, 2),
      rhythm: round(rhythm, 2),
    },
    motion,
    pictures: {
      ssim: round(mean(perFrame.map((f) => f.ssim))), colour: round(mean(perFrame.map((f) => f.colour))),
      palette: round(mean(shots.map((x) => x.palette)), 2), layout: round(mean(shots.map((x) => x.layout)), 2), shots, worst: worstShown,
    },
    leaks,
  };
  writeFileSync(join(folder, 'compare.json'), `${JSON.stringify(json, null, 1)}\n`);

  const t = json.timing;
  const line = (/** @type {string} */ name, /** @type {any} */ s) => {
    if (!s || !s.total) return `- ${name}: none in the reference`;
    let text = `- ${name}: ${s.within} of ${s.total} within ${s.frames} frame${s.frames > 1 ? 's' : ''}${s.matched ? ` (mean ${s.mean}, worst ${s.worst})` : ''}`;
    if (s.missing.length) text += `; none near ${s.missing.slice(0, 8).map(fmt).join(', ')}${s.missing.length > 8 ? ` and ${s.missing.length - 8} more` : ''}`;
    if (s.extra.length) text += `; ${s.extra.length} the reference does not have${s.extra.length <= 6 ? ` (${s.extra.map(fmt).join(', ')})` : ''}`;
    return text;
  };
  const lines = [
    `# ${basename(remakeFile)} against ${basename(refFile)}`,
    '',
    `Lengths ${fmt(ref.duration)} and ${fmt(mine.duration)} s; ${scale === 1 ? 'compared at the same times' : `the remake's times scaled by ${round(scale, 4)} to the reference's`}, at ${ref.fps} fps.`,
    'Offsets are in frames; times are the reference\'s. Pictures: reference on the left, remake on the right.',
    '',
    '## Timing',
    '',
    line('Cuts', t.cuts),
    line('Changes start', t.starts),
    line('Changes settle', t.settles),
    ...(t.hits ? [line('Sound hits', t.hits)] : []),
    `- Rhythm: ${t.rhythm} (1 when both change at the same moments, as much)`,
    '',
    '## Motion',
    '',
    `${motion.filter((m) => !m.issue).length} of ${motion.length} changes of the reference happen in the remake at the same pace.`,
    ...issues.map((m) => `- ${fmt(m.from)}–${fmt(m.to)}, ${m.where}: ${m.issue}${m.picture ? ` (${m.picture})` : ''}`),
    ...(missedCuts.length ? ['', ...missedCuts.map((c) => `- cut at ${fmt(c.at)} missing${c.picture ? ` (${c.picture})` : ''}`)] : []),
    '',
    '## Pictures',
    '',
    `The look, shot by shot, whatever is in it: palette ${json.pictures.palette} (the share of colours both have), layout ${json.pictures.layout} (where both are light and dark, 1 alike). They hold when only the content changed.`,
    `Frame by frame: SSIM ${json.pictures.ssim}, colour ${json.pictures.colour} (1 is the same; these fall as the content changes, and matter for a frame-for-frame copy).`,
    '',
    ...shots.map((s, k) => `- shot ${k + 1} ${fmt(s.from)}–${fmt(s.to)}: palette ${s.palette}, layout ${s.layout}; SSIM ${s.ssim}, colour ${s.colour}`),
    '',
    `Least alike: ${worstShown.map((w) => `${fmt(w.at)} (${w.ssim}${w.picture ? `, ${w.picture}` : ''})`).join(' · ')}`,
    '',
  ];
  lines.push('## The reference in the remake', '');
  if (leaked) lines.push('None of this goes in unless the person said it may:', '');
  else lines.push(`No picture, sound or file of the reference (${leaks.frames} frames checked, ${leaks.film ? 'film.html read' : 'no film.html found'}).`, '');
  for (const f of leaks.files) lines.push(`- file: film.html plays ${f}`);
  for (const p of leaks.pictures) lines.push(`- picture: ${fmt(p.from)}–${fmt(p.to)} shows the reference's frames from ${fmt(p.refFrom)} (pixels ${p.score} alike)`);
  for (const s of leaks.sound) lines.push(`- sound: ${fmt(s.from)}–${fmt(s.to)} plays the reference's sound from ${fmt(s.refFrom)} (${s.count} landmarks)`);
  for (const p of leaks.drawn) lines.push(`- drawn: ${fmt(p.from)}–${fmt(p.to)} is as alike as its frames from ${fmt(p.refFrom)}, with only pages playing: a copy drawn frame for frame`);
  if (leaks.words) {
    const said = leaks.words.length ? `longest shared run ${leaks.words.length} ${leaks.words.cjk ? 'characters' : 'words'} at ${fmt(leaks.words.at)}, 「${leaks.words.run}」` : 'no shared run';
    lines.push(`- words: ${Math.round(leaks.words.share * 100)}% of the remake's 6-token runs are the reference's; ${said}${leaks.words.long || leaks.words.share > 0.2 ? '. Only right when the person asked for the same words' : ''}`);
  } else {
    lines.push(`- words: not measured, no ${leaks.wordsMissing} (orangefilm get asr)`);
  }
  lines.push('');
  writeFileSync(join(folder, 'compare.md'), lines.join('\n'));
  console.log(`cuts ${t.cuts.within}/${t.cuts.total}, starts ${t.starts.within}/${t.starts.total}, rhythm ${t.rhythm}, palette ${json.pictures.palette}, layout ${json.pictures.layout}, SSIM ${json.pictures.ssim}`);
  if (leaked) console.log(`THE REFERENCE IS IN THE REMAKE: ${leaks.files.length} file, ${leaks.pictures.length} picture, ${leaks.sound.length} sound; see its section`);
  console.log(`→ ${relative(process.cwd(), join(folder, 'compare.md')) || join(folder, 'compare.md')}`);
  if (leaked) process.exitCode = 1;
}

// ---------------------------------------------------------------- command

const args = process.argv.slice(2);
const flag = (/** @type {string} */ name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const fitAt = args.indexOf('--fit');
const fitIt = fitAt >= 0;
if (fitIt) args.splice(fitAt, 1);
const out = flag('--out');
const film = flag('--film');
const [command, ...files] = args;
try {
  if (command === 'study' && files.length === 1) await study(files[0], out);
  else if (command === 'compare' && files.length === 2) await compare(files[0], files[1], { out, fit: fitIt, film });
  else fail('node measure.mjs study <video> [--out <folder>]\n       node measure.mjs compare <reference> <remake> [--out <folder>] [--fit] [--film <film.html>]');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
