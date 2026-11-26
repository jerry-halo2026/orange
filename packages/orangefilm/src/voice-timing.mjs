// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 让"口播多长"从估算变成实测：调 TTS 拿到音频文件，再用 ffprobe 量它到底几秒，写回 plan。
 *
 * # 为什么这一步决定成败
 *
 * 排片（`shot-plan`）与校验（`validatePlan`）都以 `segments[i].audioSec` 为准。这个数字如果只是按字数估的
 * （4.5 字/秒），整条片子会整体漂 0.5–1.5 秒 —— 表现就是"最后一句话被切掉"或"结尾多出一段空画面"。
 * 所以真正出片前必须实测；估算是"预排"用的，plan 里会标 `estimated: true`，校验器对它报黄。
 *
 * # 复用现有的东西
 *
 * - TTS：`providers/*.mjs` 的 `tts` verb（qwen / minimax / elevenlabs / doubao，用户自带 key）；
 * - 测量：`scripts/audio-measure.mjs` 的 ffprobe 逻辑（这里内联一个最小版本，避免循环依赖）；
 * - ffmpeg：app 自带（`ffmpeg-runtime.mjs`），`ffprobe` 与它同目录。
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 用 ffprobe 量一个音频文件的时长（秒）。失败返回 null —— 调用方据此保留估算值，并留下 warn。
 * @param {string} file @param {{ ffprobe?: string, timeoutMs?: number }} [options]
 * @returns {Promise<number | null>}
 */
export function probeDurationSec(file, { ffprobe = 'ffprobe', timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { windowsHide: true, timeout: timeoutMs }, (error, stdout) => {
        if (error) { resolve(null); return; }
        const value = Number(String(stdout).trim());
        resolve(Number.isFinite(value) && value > 0 ? Number(value.toFixed(3)) : null);
      });
  });
}

/**
 * 为每个口播段配音并实测时长，写回 plan（原地改并返回新对象）。
 *
 * `speak(text, voice)` 是注入的 TTS：返回 `{ file }`（已落盘的音频路径）或 `{ bytes, mime }`（由这里落盘）。
 * 注入而不是在这里 import provider，是为了：a) 单测不依赖网络；b) Studio 与 CLI 各自决定用哪个 provider。
 *
 * 段与段之间按 `spec.breathSec` 插呼吸段（已经有的不重复插）。
 *
 * @param {any} plan
 * @param {{ speak: (text: string, voice?: any) => Promise<{ file?: string, bytes?: Uint8Array, mime?: string, provider?: string, name?: string }>,
 *   voiceDir: string, ffprobe?: string, probe?: (file: string) => Promise<number | null> }} options
 * @returns {Promise<{ plan: any, measured: string[], failed: { id: string, reason: string }[] }>}
 */
export async function measurePlanVoices(plan, { speak, voiceDir, ffprobe = 'ffprobe', probe = probeDurationSec }) {
  mkdirSync(voiceDir, { recursive: true });
  /** @type {string[]} */
  const measured = [];
  /** @type {{ id: string, reason: string }[]} */
  const failed = [];

  for (const segment of plan.segments) {
    if (segment.kind !== 'speech' || !segment.text) continue;
    /** @type {string} */
    let file = segment.voice?.file ?? '';
    try {
      if (!file) {
        const answer = await speak(segment.text, segment.voice ?? undefined);
        if (answer?.file) {
          file = answer.file;
        } else if (answer?.bytes?.length) {
          const extension = /wav/i.test(answer.mime ?? '') ? '.wav' : '.mp3';
          file = join(voiceDir, `${segment.id}${extension}`);
          writeFileSync(file, answer.bytes);
        }
        if (!file) throw new Error('TTS 没有给出音频文件');
      }
      const seconds = await probe(file, { ...(ffprobe ? { ffprobe } : {}) });
      if (seconds === null) throw new Error('ffprobe 量不出时长');
      segment.voice = { ...(segment.voice ?? {}), file };
      segment.audioSec = seconds;
      segment.estimated = false;
      measured.push(segment.id);
    } catch (error) {
      /* 一个段落配音失败不该让整条计划作废：保留估算值并标出来，校验器会报黄 */
      failed.push({ id: segment.id, reason: String(error?.message ?? error) });
    }
  }

  /* 句间呼吸：只在两个口播段之间插，且不重复插 */
  const breathSec = Number(plan.spec?.breathSec ?? 0.2);
  if (breathSec > 0) {
    /** @type {any[]} */
    const withBreaths = [];
    for (const [index, segment] of plan.segments.entries()) {
      withBreaths.push(segment);
      const next = plan.segments[index + 1];
      if (segment.kind === 'speech' && next && next.kind === 'speech' && !segment.gapAfter) {
        withBreaths.push({ id: `G${index + 1}`, kind: 'breath', text: '', audioSec: breathSec, estimated: false, voice: null });
      }
    }
    plan.segments = withBreaths;
  }

  return { plan, measured, failed };
}

/**
 * 把实测时长带进镜头：镜头不够长就拉长到句子 + 余量（画面多留 0.15s 比句子被切掉好），
 * 但不超过素材本身能提供的长度 —— 做不到就留给排片器重排（返回的 `needsReplan` 里列出段 id）。
 *
 * @param {any} plan @param {{ marginSec?: number }} [options]
 * @returns {{ plan: any, needsReplan: string[] }}
 */
export function stretchShotsToAudio(plan, { marginSec = 0.15 } = {}) {
  /** @type {string[]} */
  const needsReplan = [];
  for (const segment of plan.segments) {
    if (segment.kind !== 'speech') continue;
    const shot = plan.shots.find((entry) => entry.segmentId === segment.id);
    if (!shot) { needsReplan.push(segment.id); continue; }
    const want = Number((segment.audioSec + marginSec).toFixed(3));
    if (shot.shownSec + 1e-6 >= want) {
      /* 已经有富余：不动（镜头的余量是留给换气的） */
      shot.shownSec = Number(shot.shownSec.toFixed(3));
      continue;
    }
    const available = (shot.endSec - shot.startSec) / shot.speed;
    if (available + 1e-6 >= want) {
      shot.shownSec = want;
      shot.endSec = Number((shot.startSec + want * shot.speed).toFixed(3));
    } else {
      needsReplan.push(segment.id);
    }
  }
  return { plan, needsReplan };
}
