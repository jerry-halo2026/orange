// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * A real smoke run against this machine's LM Studio (port 1235, qwen2.5-vl-7b-instruct, and the
 * nomic embedding model), with the frames coming from a real jpeg in the repository instead of ffmpeg
 * (ffmpeg is not on this box's PATH). It exists to print genuine timings — the cold warm-up and the
 * warm frames apart — and it is not part of `node --test`: run it with
 *
 *   node packages/orangefilm/src/analyze-smoke.mjs [<image.jpg>]
 */
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAnalysis } from './analyze-runner.mjs';

const image = process.argv[2] ?? join(import.meta.dirname, '..', 'examples-index', 'openfilm-intro', 'look.jpg');
const jpeg = readFileSync(image);
const frames = async () => [0, 1, 2].map((at) => ({ at, jpeg, mime: 'image/jpeg' }));

const run = await runAnalysis({
    media: { url: `file://${image.replaceAll('\\', '/')}` },
    meta: { name: '本机烟雾测试', category1: '测试', labels: ['smoke'] },
    workspace: mkdtempSync(join(tmpdir(), 'analyze-smoke-')),
    frames,
    // describe/embed keep their real defaults: LM Studio on 1235
    ocr: async () => { throw Object.assign(new Error('OCR is not installed'), { code: 'not-configured' }); },
    transcribe: async () => { throw Object.assign(new Error('speech is not installed'), { code: 'not-configured' }); },
    judge: async () => { throw Object.assign(new Error('no decision key'), { code: 'not-configured' }); },
});
console.log(JSON.stringify({ ok: run.ok, timings: run.timings, states: run.summary?.states, oneLine: run.summary?.oneLine, vectorLength: run.embedding?.vector?.length }, null, 2));
