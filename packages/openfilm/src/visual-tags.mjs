// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 静音素材的"画面语义"：抽三帧 → 视觉模型打标 → 变成可检索的文本。
 *
 * # 为什么要这一步
 *
 * 67 156 条素材里，能从文件名认出镜头类型的只有 ~12%（包装 / 原料 / 展示 / 人物 / 空镜），
 * 其余 59 248 条名字是"展示小青柑1""1""片段3"这一类。而这些素材**没有声音**，
 * 修音轨或转写都拿不到任何东西 —— 能拿到的只有画面。
 *
 * 所以：抽三帧（10% / 50% / 90%，避开片头片尾的转场），让视觉模型说清
 * 「主体 / 动作 / 景别 / 光线 / 场景 / 有无人」，把这几个词拼进向量文本。
 *
 * # 为什么三帧而不是一帧
 *
 * 一帧常常是空镜或转场（黑场、快门、手部晃动）；三帧里对齐"中间那一帧"最像这条片子的代表画面，
 * 头尾两帧负责回答"有没有人出现""是不是同一个场景"。三帧也便宜：一条素材一次调用就够。
 */
import { createHash } from 'node:crypto';

/** 打标版本：算法或提示词一变就换它，增量任务按它判断哪些素材还没打过。 */
export const VISUAL_VER = 'frame-tag-1';

/** 要模型回答的字段（顺序固定，便于拼文本与人工核对）。 */
export const TAG_FIELDS = Object.freeze(['subject', 'action', 'shotSize', 'light', 'scene', 'person']);

/**
 * 一条素材该在哪三处抽帧：10% / 50% / 90%，并躲开片头片尾各 0.3s。
 * @param {number} durationSec
 * @returns {{ at: number, role: 'head' | 'middle' | 'tail' }[]}
 */
export function frameTimes(durationSec) {
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const margin = duration > 1.2 ? 0.3 : duration * 0.1;
  const clamp = (/** @type {number} */ value) => Number(Math.min(Math.max(value, margin), Math.max(margin, duration - margin)).toFixed(3));
  return [
    { at: clamp(duration * 0.1), role: 'head' },
    { at: clamp(duration * 0.5), role: 'middle' },
    { at: clamp(duration * 0.9), role: 'tail' },
  ];
}

/**
 * 三帧的标答会被合并成一条素材标签：主体取中间帧（最像代表画面），
 * 人物取三帧的"并集"（有一帧有人就算有人），场景取众数。
 *
 * @param {{ subject?: string, action?: string, shotSize?: string, light?: string, scene?: string, person?: boolean | string }[]} perFrame
 * @returns {{ subject: string, action: string, shotSize: string, light: string, scene: string, person: boolean }}
 */
export function mergeFrameTags(perFrame) {
  const frames = Array.isArray(perFrame) ? perFrame.filter(Boolean) : [];
  const middle = frames[Math.floor(frames.length / 2)] ?? frames[0] ?? {};
  const mode = (/** @type {string} */ key) => {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const frame of frames) {
      const value = String(frame?.[key] ?? '').trim();
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return sorted[0]?.[0] ?? '';
  };
  const hasPerson = frames.some((frame) => frame?.person === true || frame?.person === 'true' || frame?.person === 'yes');
  return {
    subject: String(middle.subject ?? '').trim() || mode('subject'),
    action: String(middle.action ?? '').trim() || mode('action'),
    shotSize: String(middle.shotSize ?? '').trim() || mode('shotSize'),
    light: String(middle.light ?? '').trim() || mode('light'),
    scene: mode('scene'),
    person: hasPerson,
  };
}

/**
 * 标签 → 可检索文本（拼进向量的那一段）。
 * 顺序刻意稳定：同样的标签永远生成同样的字符串，向量才不会因为字段顺序漂移。
 * @param {{ subject?: string, action?: string, shotSize?: string, light?: string, scene?: string, person?: boolean }} tags
 * @param {{ name?: string }} [extra]
 */
export function tagText(tags, extra = {}) {
  const known = ['subject', 'action', 'shotSize', 'light', 'scene'].some((key) => String(tags?.[key] ?? '').trim());
  /* 什么都不知道时不要硬写"无人物"：那会把"没打过标"伪装成"打过标且没人" */
  const person = tags?.person === true ? '有人物' : (known ? '无人物' : '');
  const parts = [tags?.subject, tags?.action, tags?.shotSize, tags?.light, tags?.scene, person]
    .map((value) => String(value ?? '').trim()).filter(Boolean);
  const name = String(extra.name ?? '').trim();
  return [name, ...parts].filter(Boolean).join(' · ');
}

/**
 * 打标结果的稳定摘要：增量任务用它判断"这条素材的标签有没有变过"。
 * @param {{ subject?: string, action?: string, shotSize?: string, light?: string, scene?: string, person?: boolean }} tags
 */
export function tagsDigest(tags) {
  const canonical = TAG_FIELDS.map((field) => `${field}=${String(tags?.[field] ?? (field === 'person' ? false : ''))}`).join('|');
  return createHash('sha256').update(`${VISUAL_VER}\n${canonical}`).digest('hex').slice(0, 16);
}

/**
 * 给视觉模型的那一个问题（中英双语要求它输出紧凑 JSON）。
 * 三帧一起给，让它比较后回答"这一条素材整体是什么"。
 */
export function taggingPrompt() {
  return [
    '你在给短视频素材打标签。下面是一段视频的三帧（10%/50%/90% 处）。',
    '请只输出一个 JSON 对象，字段如下，值用简短中文：',
    '{"subject":"画面里最主要的物体/产品（如 小青柑、茶汤、包装盒、手）",',
    ' "action":"正在发生的动作（如 倒茶、开箱、拿起、静态摆放）",',
    ' "shotSize":"景别（特写/近景/中景/全景/空镜）",',
    ' "light":"光线（自然光/暖光/冷光/背光/高光）",',
    ' "scene":"场景（桌面/工厂/晒场/户外/室内/纯色背景）",',
    ' "person":true 或 false（有没有人物出现）}',
    '不要解释，不要代码块。',
  ].join('\n');
}

/**
 * 解析模型的回答：允许它带 ```json 围栏或前后废话，只把第一个 JSON 对象拎出来。
 * @param {string} text
 * @returns {{ subject: string, action: string, shotSize: string, light: string, scene: string, person: boolean } | null}
 */
export function parseTagAnswer(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return mergeFrameTags([parsed]);
  } catch {
    return null;
  }
}
