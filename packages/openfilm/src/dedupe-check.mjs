// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 渲染前的自查：这 N 条**在渲染之前**就能判出会不会撞。
 *
 * # 为什么不能等出片后再查
 *
 * 出片后再比 md5/pHash，等于"先花两小时渲染，再发现 20 条是重复的"——纯浪费。
 * 而平台比的东西（文件字节、关键帧、音频指纹、字幕文本）**在计划里就已经决定了**：
 *
 * | 平台层 | 渲染前能判吗 | 拿什么判 |
 * |---|---|---|
 * | ① 文件字节 | 能（必然） | **渲染签名**：素材 + 裁切窗口 + 配音文件 + BGM + 规格，全同 → 必出同样的字节 |
 * | ② 关键帧 pHash | 能（间接） | **帧覆盖**：同一素材 + 重叠的取用区间 → 同一批像素；首帧单独一层（封面） |
 * | ③ 时序节奏 | 能 | 镜头时长序列 |
 * | ④ 音频指纹 / ASR | 能 | 配音**文件本身**（同一文件 = 同一段声音）+ 文本 |
 * | ⑤ 深度 embedding | 能（间接） | 素材集合的语义（同一批素材 → 同一批构图） |
 *
 * 所以自查器只做一件事：**在花时间渲染之前**，把这些层算出来、指出"哪对会撞、撞在哪层"。
 * 出片之后不再复查 —— 那时候要做的是投放，不是修改。
 */
import { createHash } from 'node:crypto';

/**
 * 渲染签名：只要两条计划的签名相同，渲染出来的字节必然相同（同样的输入喂给同一个渲染器）。
 * 这是最硬的判据，也最便宜 —— 不用等出片。
 *
 * @param {{ shots?: { mediaId?: string, startSec?: number, shownSec?: number, speed?: number }[],
 *   voices?: (string | null | undefined)[], bgm?: string | null,
 *   spec?: { width?: number, height?: number, fps?: number } }} plan
 */
export function renderSignature(plan) {
  const shots = (plan.shots ?? []).map((shot) => [
    shot.mediaId ?? '',
    Number((Number(shot.startSec ?? 0)).toFixed(2)),
    Number((Number(shot.shownSec ?? 0)).toFixed(2)),
    Number((Number(shot.speed ?? 1)).toFixed(2)),
  ]);
  const parts = [
    shots.map((fields) => fields.join('@')).join('|'),
    (plan.voices ?? []).map((voice) => String(voice ?? '')).join('|'),
    String(plan.bgm ?? ''),
    `${plan.spec?.width ?? ''}x${plan.spec?.height ?? ''}@${plan.spec?.fps ?? ''}`,
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
}

/** 文本 → 3-gram 集合（中文按字切：同一句话必然同集合）。 */
function grams(/** @type {string} */ text, size = 3) {
  const clean = String(text ?? '').replace(/\s+/g, '');
  const chars = [...clean];
  /** @type {Set<string>} */
  const out = new Set();
  if (chars.length < size) { if (clean) out.add(clean); return out; }
  for (let i = 0; i + size <= chars.length; i += 1) out.add(chars.slice(i, i + size).join(''));
  return out;
}

/** Jaccard 相似度。 */
export function jaccard(/** @type {Set<string>} */ a, /** @type {Set<string>} */ b) {
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** 镜头时长序列的相似度：按位置、容差 0.12s。 */
export function sequenceSimilarity(/** @type {number[]} */ a, /** @type {number[]} */ b) {
  const n = Math.max(a.length, b.length);
  if (!n) return 1;
  let same = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) continue;
    if (Math.abs(x - y) <= 0.12) same += 1;
  }
  return same / n;
}

/**
 * 帧覆盖：把每个镜头拆成"素材 + 0.25s 粒度的取用区间"，两条计划重叠的比例。
 * 重叠高 = 大量相同的像素进入两条片子 → 视觉层与深度层都会撞。
 * @param {{ mediaId?: string, startSec?: number, shownSec?: number, speed?: number }[]} shots
 */
export function frameCells(shots) {
  /** @type {Set<string>} */
  const cells = new Set();
  for (const shot of shots ?? []) {
    const media = shot.mediaId ?? '';
    const speed = Number(shot.speed ?? 1) || 1;
    const start = Number(shot.startSec ?? 0);
    const span = Number(shot.shownSec ?? 0) * speed;
    const firstCell = Math.round(start / 0.25);
    const lastCell = Math.max(firstCell, Math.round((start + span) / 0.25));
    for (let cell = firstCell; cell <= lastCell; cell += 1) cells.add(`${media}#${cell}`);
  }
  return cells;
}

/**
 * 渲染前自查。
 *
 * @param {{ id: string, lines?: string[], shots?: { mediaId?: string, startSec?: number, shownSec?: number, speed?: number }[],
 *   voices?: (string | null | undefined)[], bgm?: string | null,
 *   spec?: { width?: number, height?: number, fps?: number } }[]} plans
 * @param {{ textMax?: number, rhythmMax?: number, framesMax?: number, requireDistinctFirstShot?: boolean }} [thresholds]
 * @returns {{ pairs: number, duplicates: { a: string, b: string, signature: string }[],
 *   risky: { a: string, b: string, layers: Record<string, number>, hits: string[] }[],
 *   signatures: Record<string, string>, verdict: string, canRender: boolean }}
 */
export function planSimilarity(plans, thresholds = {}) {
  const limits = { textMax: 0.55, rhythmMax: 0.8, framesMax: 0.5, requireDistinctFirstShot: true, ...thresholds };
  const prepared = plans.map((plan) => ({
    id: plan.id,
    signature: renderSignature(plan),
    text: grams((plan.lines ?? []).join('')),
    rhythm: (plan.shots ?? []).map((shot) => Number(shot.shownSec ?? 0)),
    frames: frameCells(plan.shots ?? []),
    firstFrame: plan.shots?.[0] ? `${plan.shots[0].mediaId ?? ''}#${Math.round(Number(plan.shots[0].startSec ?? 0) / 0.25)}` : '',
    voice: (plan.voices ?? []).filter(Boolean).sort().join(','),
    bgm: plan.bgm ?? null,
  }));

  /** @type {{ a: string, b: string, signature: string }[]} */
  const duplicates = [];
  /** @type {{ a: string, b: string, layers: Record<string, number>, hits: string[] }[]} */
  const risky = [];
  let pairs = 0;

  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const a = prepared[i];
      const b = prepared[j];
      pairs += 1;
      /* ① 签名相同 = 渲染输入完全一样 = 必然出同一份字节。这是 block 级，不是"建议留意"。 */
      if (a.signature === b.signature) {
        duplicates.push({ a: a.id, b: b.id, signature: a.signature });
        continue;
      }
      const layers = {
        text: Number(jaccard(a.text, b.text).toFixed(3)),
        rhythm: Number(sequenceSimilarity(a.rhythm, b.rhythm).toFixed(3)),
        frames: Number(jaccard(a.frames, b.frames).toFixed(3)),
        voice: a.voice && b.voice && a.voice === b.voice ? 1 : 0,
        bgm: a.bgm && b.bgm && a.bgm === b.bgm ? 1 : 0,
        firstShot: a.firstFrame && a.firstFrame === b.firstFrame ? 1 : 0,
      };
      /** @type {string[]} */
      const hits = [];
      if (layers.text > limits.textMax) hits.push(`文本 ${layers.text}`);
      if (layers.rhythm > limits.rhythmMax) hits.push(`节奏 ${layers.rhythm}`);
      if (layers.frames > limits.framesMax) hits.push(`画面 ${layers.frames}`);
      if (layers.voice === 1) hits.push('配音文件相同');
      if (layers.bgm === 1) hits.push('BGM 相同');
      if (limits.requireDistinctFirstShot && layers.firstShot === 1) hits.push('首帧相同（封面会撞）');
      if (hits.length) risky.push({ a: a.id, b: b.id, layers, hits });
    }
  }

  const canRender = duplicates.length === 0;
  const verdict = duplicates.length
    ? `${duplicates.length} 对**完全一样**（渲染输入相同，会出同一份字节）：${duplicates[0].a} 与 ${duplicates[0].b} —— 先改再渲`
    : risky.length
      ? `${risky.length} 对在平台会比的层上过近：${risky[0].a} 与 ${risky[0].b}（${risky[0].hits.join('、')}）`
      : `${pairs} 对两两比过，没有哪一层过近`;
  return {
    pairs,
    duplicates,
    risky,
    signatures: Object.fromEntries(prepared.map((entry) => [entry.id, entry.signature])),
    verdict,
    canRender,
  };
}
