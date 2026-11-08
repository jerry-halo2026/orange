import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { clipSpan, sourceAt } from '../../src/film-doc.mjs';
import { resolveIsolationProfile, isolationEnvironment } from '../../src/development-isolation.mjs';

// Process startup comes from the admitted controller: no inherited injection,
// credentials, browser launch or shared user home. Setup precedes server imports.
const scratch = process.env.TEMP;
assert.ok(scratch);
for (const key of ['TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) assert.equal(process.env[key], scratch);
const components = resolve(scratch).split(sep);
const own = components.indexOf('.dev');
assert.ok(own >= 0);
assert.equal(components[own + 1], 't07-native-characterization');
assert.equal(components.at(-1), 'scratch');
assert.equal(process.env.NODE_OPTIONS, undefined);
const baseRoot = join(dirname(scratch), 'profiles');
const profile = resolveIsolationProfile({ baseRoot, instanceId: 'root', taskId: 'T07_NATIVE', attemptId: 'reference', ports: { studio: 18483, film: 18484 } }, { approvedBaseRoot: baseRoot });
await mkdir(baseRoot, { recursive: true });
await mkdir(profile.root, { recursive: true });
for (const location of Object.values(profile.paths)) {
  assert.ok(resolve(location).startsWith(resolve(baseRoot) + sep));
  await mkdir(location, { recursive: true });
}
for (const [key, value] of Object.entries(isolationEnvironment(profile))) if (key.startsWith('OPENFILM_')) process.env[key] = value;
const { spokenLines, vttOf, parseVtt } = await import('./transcripts.mjs');
const { clipCues } = await import('./captions.mjs');

function frozen(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); }
  return value;
}
const source = 'assets/audio/vo/interview.wav';
const timedLine = frozen([{ text: 'Alpha beta', startMs: 2500, endMs: 3500, marks: [{ index: 0, startMs: 2500 }, { index: 6, startMs: 3000 }] }]);
const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.800\nAlpha <00:00:01.000>beta\n';
const shortLines = [{ text: 'Alpha beta', startMs: 0, endMs: 1800, marks: [{ index: 0, startMs: 0 }, { index: 6, startMs: 1000 }] }];

test('native reference: trimmed 2x source seconds map to literal film milliseconds', () => {
  const clip = frozen({ id: '采访-甲', src: source, at: 10, time: [2, 6], speed: 2 });
  const span = clipSpan(clip, 8);
  assert.deepEqual(span, { from: 2, to: 6, speed: 2, length: 2 });
  assert.equal(sourceAt(span, 1, clip, 8), 4);
  const cues = clipCues(timedLine, { fromMs: span.from * 1000, startMs: clip.at * 1000, durMs: span.length * 1000, speed: span.speed }, { clip: clip.id, src: clip.src, cut: true });
  assert.deepEqual(cues, [{ startMs: 10250, durMs: 500, text: 'Alpha beta', words: [{ text: 'Alpha', startMs: 10250, durMs: 250 }, { text: 'beta', startMs: 10500, durMs: 250 }], clip: '采访-甲', src: source, line: 2500 }]);
});

test('native reference: same source keeps two original instance ids and offsets without mutation', () => {
  const first = frozen({ id: '第一段_甲', src: source, at: 10, time: [2, 6], speed: 2 });
  const second = frozen({ id: '第二段_β', src: source, at: 20, time: [2, 6], speed: 1 });
  const before = JSON.stringify({ first, second, timedLine });
  const a = clipCues(timedLine, { fromMs: 2000, startMs: 10000, durMs: 2000, speed: 2 }, { clip: first.id, src: first.src, cut: true });
  const b = clipCues(timedLine, { fromMs: 2000, startMs: 20000, durMs: 4000, speed: 1 }, { clip: second.id, src: second.src, cut: true });
  assert.deepEqual(a.map(({ clip, src, startMs, durMs }) => ({ clip, src, startMs, durMs })), [{ clip: '第一段_甲', src: source, startMs: 10250, durMs: 500 }]);
  assert.deepEqual(b.map(({ clip, src, startMs, durMs }) => ({ clip, src, startMs, durMs })), [{ clip: '第二段_β', src: source, startMs: 20500, durMs: 1000 }]);
  assert.equal(JSON.stringify({ first, second, timedLine }), before);
});

test('native reference: distinct inner word ends can lose evidence in the same native display and VTT', () => {
  for (const endSec of [0.2, 0.8, undefined]) {
    const words = frozen([{ token: 'Alpha', startSec: 0, ...(endSec === undefined ? {} : { endSec }) }, { token: 'beta', startSec: 1, endSec: 1.7 }]);
    const before = JSON.stringify(words);
    const lines = spokenLines('Alpha beta', words, 1800);
    assert.deepEqual(lines, shortLines);
    assert.equal(vttOf(lines), vtt);
    const cues = clipCues(lines, { fromMs: 0, startMs: 0, durMs: 1800, speed: 1 }, { clip: '文字_源', src: source, cut: true });
    assert.deepEqual(cues, [{ startMs: 0, durMs: 1800, text: 'Alpha beta', words: [{ text: 'Alpha', startMs: 0, durMs: 1000 }, { text: 'beta', startMs: 1000, durMs: 800 }], clip: '文字_源', src: source, line: 0 }]);
    assert.equal(JSON.stringify(words), before);
  }
});

test('native reference: untimed native display estimates do not provide word marks', () => {
  const lines = spokenLines('Alpha beta', undefined, 1800);
  assert.deepEqual(lines, [{ text: 'Alpha beta', startMs: 0, endMs: 1800 }]);
  assert.equal(Object.hasOwn(lines[0], 'marks'), false);
  const cues = clipCues(lines, { fromMs: 0, startMs: 0, durMs: 1800, speed: 1 }, { cut: true });
  assert.deepEqual(cues, [{ startMs: 0, durMs: 1800, text: 'Alpha beta' }]);
});

test('native reference: a short display trim can omit an explicitly supplied timed word', () => {
  const line = frozen([{ text: 'Alpha', startMs: 0, endMs: 1000, marks: [{ index: 0, startMs: 0 }] }]);
  const before = JSON.stringify(line);
  assert.deepEqual(clipCues(line, { fromMs: 0, startMs: 0, durMs: 100, speed: 1 }, { cut: true }), []);
  assert.equal(JSON.stringify(line), before);
});

test('native reference: native VTT roundtrip keeps start marks and line end but invents no word end', () => {
  const parsed = parseVtt(vtt);
  assert.deepEqual(parsed, { lines: shortLines });
  assert.equal(vttOf(parsed.lines), vtt);
  assert.deepEqual(Object.keys(parsed.lines[0].marks[0]).sort(), ['index', 'startMs']);
  assert.deepEqual(Object.keys(parsed.lines[0].marks[1]).sort(), ['index', 'startMs']);
});
