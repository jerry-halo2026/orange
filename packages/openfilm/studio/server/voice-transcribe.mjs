// 漏 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner's written permission.

// @ts-check
/**
 * 本地 Whisper 给上传的配音生成字幕时间戳：音频 → 16k 单声道 f32 → local-run asr → 词时间合并成句。
 * 不经过时间线字幕轨，产出直接进 recipe 的 voiceFiles[].cues / text。
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelEntry, modelReady } from '../../src/local-models.mjs';

const RUN = fileURLToPath(new URL('../../src/local-run.mjs', import.meta.url));
const PUNCT = /[。！？!?；;，,、]/;
const MAX_CHARS = 8;
const MAX_SEC = 4.5;

/** @param {string[]} args @param {AbortSignal} [signal] */
function run(args, signal) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [RUN, ...args], {
      signal, maxBuffer: 64 << 20, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }, (error, stdout) => {
      const line = String(stdout).trim().split('\n').at(-1) ?? '';
      try {
        const out = JSON.parse(line);
        if (out?.error) reject(new Error(out.error));
        else resolve(out);
      } catch {
        reject(new Error(signal?.aborted ? 'stopped' : error?.message ?? 'local whisper gave no answer'));
      }
    });
  });
}

/**
 * @param {string} file absolute audio path
 * @param {string} ffmpeg absolute ffmpeg path
 * @returns {Promise<{ text: string, cues: { startSec: number, endSec: number, text: string }[] }>}
 */
export async function transcribeVoice(file, ffmpeg) {
  const dir = await mkdtemp(join(tmpdir(), 'orange-voice-'));
  try {
    const samples = join(dir, 'speech.f32');
    await new Promise((resolve, reject) => {
      execFile(ffmpeg, ['-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', samples], { windowsHide: true }, (error) => {
        if (error) reject(error); else resolve(null);
      });
    });
    const large = modelEntry('whisper-large-v3-turbo');
    const model = large && modelReady(large) ? 'whisper-large-v3-turbo' : 'whisper-small';
    const out = /** @type {{ text?: string, words?: { token: string, start: number, end: number }[] }} */ (await run(['asr', model, samples, 'zh']));
    const words = Array.isArray(out.words) ? out.words.filter((word) => word && word.token && Number.isFinite(word.start) && Number.isFinite(word.end)) : [];
    if (!words.length) return { text: String(out.text ?? '').trim(), cues: [] };
    const cues = [];
    let current = '';
    let start = words[0].start;
    let end = words[0].end;
    const flush = () => {
      const text = current.trim();
      if (text) cues.push({ startSec: Math.max(0, start), endSec: Math.max(start + 0.2, end), text });
      current = '';
    };
    for (const word of words) {
      if (!current) start = word.start;
      current += word.token;
      end = word.end;
      if (PUNCT.test(word.token) || current.length >= MAX_CHARS || end - start >= MAX_SEC) flush();
    }
    flush();
    return { text: words.map((word) => word.token).join('').trim(), cues };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
