// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Resolution against time, measured: the same 8 s testsrc2 clip, one frame at each long edge, described
 * by this machine's LM Studio (qwen2.5-vl-7b-instruct, port 1235). Run with
 *
 *   node packages/openfilm/src/analyze-resolution-bench.mjs [D:/path/to/ffmpeg.exe]
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegFrames, lmStudioDescriber } from './analyze-runner.mjs';

const ffmpeg = process.argv[2] ?? 'ffmpeg';
const clip = join(tmpdir(), 'analyze-resolution-bench.mp4');
const made = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=1280x720:duration=8', '-pix_fmt', 'yuv420p', clip], { encoding: 'utf8' });
if (made.status !== 0) {
    console.error('could not make the fixture clip:', String(made.stderr).split('\n').slice(-3).join('\n'));
    process.exit(1);
}

const describe = lmStudioDescriber();
const rows = [];
for (const longEdge of [1280, 768, 512]) {
    const answer = await ffmpegFrames({ media: { path: clip }, maxFrames: 1, longEdge, quality: 85 });
    const frame = answer.frames[0];
    const bytesAt = frame.jpeg.length;
    // one warm-up per edge, so the first (cold) frame is not counted as a warm one
    await describe({ jpeg: frame.jpeg, warmup: true, prompt: 'Warm up. Answer with one word.' });
    const started = Date.now();
    const said = await describe({ jpeg: frame.jpeg, at: 0 });
    const ms = Date.now() - started;
    rows.push({ longEdge, bytes: bytesAt, describeMs: ms, text: said.text.slice(0, 40) });
    console.log(`${longEdge}: ${bytesAt} bytes, describe ${ms} ms`);
}
writeFileSync(join(tmpdir(), 'analyze-resolution-bench.json'), JSON.stringify(rows, null, 2) + '\n');
console.log(JSON.stringify(rows, null, 2));
