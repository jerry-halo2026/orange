// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * `planset.json` → N 条变体（每条一份 plan 的种子）。
 *
 * # 为什么不是纯笛卡尔
 *
 * 5 根轴 × 每根 10 个 = 十万组合，而目标是 100 条。纯笛卡尔会产出"同一说法 + 同一素材、只换了 BGM"的
 * 近似重复 —— 组合空间够大，但选得不好。平台判重是六层指纹（文件/视觉/时序/音频/深度/跨模态），
 * 所以变体的差异必须落在**能破坏多层的轴**上，按这个顺序分层采样：
 *
 *   ① take（文案 ⊗ 音色）—— 破坏音频层的 ASR 文本，最强
 *   ② 素材与镜头位    —— 破坏视觉层与时序层
 *   ③ BGM            —— 只破坏音频层的一部分，最后才轮到它
 *
 * # 确定性
 *
 * 选样用 `md5(seed + index)` 的稳定散列，不用真随机：同一份 planset 两次展开**结果完全相同**，
 * 出问题能复现，也能跟平台数据对上。
 */
import { createHash } from 'node:crypto';

const hash = (/** @type {string} */ text, /** @type {string} */ salt = '') =>
  createHash('md5').update(`${salt}\u0000${text}`).digest('hex');

/** 稳定排序：按 md5 排，输入顺序变了结果也不变。 */
const byHash = (/** @type {string} */ salt) => (/** @type {any} */ a, /** @type {any} */ b) =>
  hash(String(a.id), salt).localeCompare(hash(String(b.id), salt));

/**
 * 展开一份 planset。
 *
 * @param {{ id?: string, seed?: string, copy: { id: string, lines: string[] }[],
 *   voices?: { id: string, provider?: string, voice?: string }[],
 *   pools?: { id: string, fills: string[], items?: string[], kind?: 'shot' | 'broll' }[],
 *   bgm?: { pool?: string[] } | null,
 *   expand?: number, spec?: Record<string, unknown>,
 *   dedupe?: { material?: { acrossPlans?: 'no-repeat' | 'reuse', withinPlan?: 'no-repeat', fallbackMaxReuse?: number },
 *     bgm?: { adjacentDifferent?: boolean }, take?: { maxPlansPerTake?: number } } }} planset
 * @returns {{ id: string, seed: string, variants: { id: string, copyId: string, voiceId: string,
 *   voice: Record<string, string> | null, lines: string[], media: Record<string, string>, bgm: string | null,
 *   seed: string }[], report: { wanted: number, made: number, takes: number, shortages: string[],
 *   materialUsage: Record<string, number> } }}
 */
export function expandPlans(planset) {
  const id = String(planset?.id ?? 'planset');
  const seed = String(planset?.seed ?? id);
  const expand = Math.max(1, Math.trunc(Number(planset?.expand ?? 1)));
  const copy = Array.isArray(planset?.copy) ? planset.copy.filter((entry) => Array.isArray(entry?.lines) && entry.lines.length) : [];
  if (!copy.length) throw new Error('planset.copy 至少要有一条文案');
  const voices = Array.isArray(planset?.voices) && planset.voices.length ? planset.voices : [{ id: 'default' }];
  const pools = Array.isArray(planset?.pools) ? planset.pools : [];
  const bgmPool = Array.isArray(planset?.bgm?.pool) ? planset.bgm.pool.filter(Boolean) : [];
  const dedupe = planset?.dedupe ?? {};
  const acrossPlans = dedupe?.material?.acrossPlans ?? 'no-repeat';
  const fallbackMaxReuse = Math.max(1, Math.trunc(Number(dedupe?.material?.fallbackMaxReuse ?? 3)));
  const maxPlansPerTake = Math.max(1, Math.trunc(Number(dedupe?.take?.maxPlansPerTake ?? expand)));
  const adjacentDifferent = dedupe?.bgm?.adjacentDifferent !== false;

  /* ① takes：文案 ⊗ 音色，按 hash 稳定排序，避免"输入顺序决定前 100 条长什么样" */
  /** @type {{ id: string, copyId: string, voiceId: string, voice: any, lines: string[] }[]} */
  const takes = [];
  for (const copyEntry of [...copy].sort(byHash(`${seed}:copy`))) {
    for (const voice of [...voices].sort(byHash(`${seed}:voice`))) {
      takes.push({
        id: `${copyEntry.id}__${voice.id}`,
        copyId: String(copyEntry.id),
        voiceId: String(voice.id),
        voice: voice.provider || voice.voice ? { provider: String(voice.provider ?? ''), voice: String(voice.voice ?? '') } : null,
        lines: copyEntry.lines.map((line) => String(line)),
      });
    }
  }

  /* ② 池子游标：跨条不重复；用尽后按 fallbackMaxReuse 放宽，并记 shortage */
  /** @type {Map<string, { items: string[], cursor: number }>} */
  const cursors = new Map();
  for (const pool of [...pools].sort(byHash(`${seed}:pool`))) {
    cursors.set(String(pool.id), { items: Array.isArray(pool.items) ? pool.items.map(String) : [], cursor: 0 });
  }
  /** @type {Record<string, number>} */
  const materialUsage = {};
  /** @type {string[]} */
  const shortages = [];

  /** @type {any[]} */
  const variants = [];
  for (let index = 0; index < expand; index += 1) {
    /* take 轮转：每个 take 最多 maxPlansPerTake 条；用完就把它的次序往后推（仍然确定性） */
    const takeIndex = index % takes.length;
    const take = takes[takeIndex];

    /** @type {Record<string, string>} */
    const media = {};
    let missing = false;
    for (const pool of [...pools].sort(byHash(`${seed}:pool`))) {
      const cursor = cursors.get(String(pool.id));
      if (!cursor || !cursor.items.length) {
        if (currentFill(pool)) shortages.push(`池 ${pool.id} 没有素材，${currentFill(pool)} 位填不满`);
        continue;
      }
      for (const slot of pool.fills ?? []) {
        const used = materialUsage[cursor.items[cursor.cursor % cursor.items.length]] ?? 0;
        const item = cursor.items[cursor.cursor % cursor.items.length];
        if (acrossPlans === 'no-repeat' && used >= fallbackMaxReuse) {
          shortages.push(`池 ${pool.id} 的素材已用满 ${fallbackMaxReuse} 次，第 ${index + 1} 条会重复`);
        }
        media[String(slot)] = item;
        materialUsage[item] = used + 1;
        cursor.cursor += 1;
        if (cursor.cursor > cursor.items.length && acrossPlans === 'no-repeat') {
          shortages.push(`池 ${pool.id} 只有 ${cursor.items.length} 条，第 ${index + 1} 条开始重复使用`);
        }
      }
    }
    if (!Object.keys(media).length && pools.length) missing = true;

    /* ③ BGM 最后轮转；相邻不同 */
    let bgm = null;
    if (bgmPool.length) {
      const previous = variants.length ? variants[variants.length - 1].bgm : null;
      const candidate = bgmPool[index % bgmPool.length];
      bgm = adjacentDifferent && bgmPool.length > 1 && candidate === previous
        ? bgmPool[(index + 1) % bgmPool.length]
        : candidate;
    }

    /* ④ 去重：说法与素材两个循环长度相同时（例：4 种说法 × 4 条素材池），第 5 条会与第 1 条
       完全一样 —— 实跑撞出来过。这里用"确定性偏移"错开它：换素材起点、再不行换 BGM，
       都不行就如实记 shortage（说明组合不够，要加文案或加素材）。 */
    const signatureOf = (/** @type {Record<string, string>} */ mediaIds, /** @type {string | null} */ bgmId) =>
      hash(`${take.lines.join('|')}#${Object.entries(mediaIds).sort().map(([slot, item]) => `${slot}=${item}`).join(',')}#${bgmId ?? ''}`);
    if (!missing && Object.keys(media).length) {
      let attempt = 0;
      const tried = new Set(variants.map((variant) => variant.signature));
      while (tried.has(signatureOf(media, bgm)) && attempt < 24) {
        attempt += 1;
        const offset = Math.max(1, attempt);
        for (const pool of [...pools].sort(byHash(`${seed}:pool`))) {
          const cursor = cursors.get(String(pool.id));
          if (!cursor || !cursor.items.length) continue;
          const start = cursor.cursor + offset;
          for (const [slotIndex, slot] of (pool.fills ?? []).entries()) {
            media[String(slot)] = cursor.items[(start + slotIndex) % cursor.items.length];
          }
        }
        if (attempt % 3 === 0 && bgmPool.length > 1) bgm = bgmPool[attempt % bgmPool.length];
      }
      if (tried.has(signatureOf(media, bgm))) {
        shortages.push(`第 ${index + 1} 条凑不出新组合（说法与素材池都绕回了）—— 加一条文案或扩素材池`);
      }
    }

    variants.push({
      id: `${id}-${String(index + 1).padStart(3, '0')}`,
      copyId: take.copyId,
      voiceId: take.voiceId,
      voice: take.voice,
      lines: take.lines,
      media,
      signature: signatureOf(media, bgm),
      bgm,
      seed: hash(`${seed}:${index}`).slice(0, 12),
      ...(missing ? { incomplete: true } : {}),
    });
    if (index >= takes.length * maxPlansPerTake - 1 && takes.length * maxPlansPerTake < expand) {
      shortages.push(`take 只够 ${takes.length * maxPlansPerTake} 条（${takes.length} 种说法 × 每条最多 ${maxPlansPerTake}），` +
        `要 ${expand} 条请加文案或调大 maxPlansPerTake`);
      break;
    }
  }

  return {
    id,
    seed,
    variants,
    report: {
      wanted: expand,
      made: variants.length,
      takes: takes.length,
      shortages: [...new Set(shortages)],
      materialUsage,
    },
  };
}

/** 一个池第一个要填的位（只用于错误信息，不参与逻辑）。 @param {any} pool */
function currentFill(pool) {
  return Array.isArray(pool?.fills) && pool.fills.length ? String(pool.fills[0]) : '(未声明位)';
}

/**
 * 一条变体 → `createPlanFromBrief` 的入参（替身：素材候选就是这条分到的素材）。
 * @param {{ id: string, lines: string[], media: Record<string, string>, voice: any, bgm: string | null }} variant
 * @param {{ candidates: { id: string, durationSec: number, kind?: 'shot' | 'broll', score?: number }[],
 *   spec?: Record<string, unknown> }} material
 * @returns {{ id: string, lines: (string | { text: string, mediaId: string })[], candidates: any[],
 *   spec: Record<string, unknown>, compliance: 'publish' }}
 * `compliance` is the literal `publish` a variant is always built at, so it stays a literal in the type.
 */
export function variantToBrief(variant, { candidates, spec = {} }) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  /* 按句子顺序取位：S1…Sn；分不到位的句子留给排片器（它会报 no-candidate-long-enough） */
  const slots = Object.entries(variant.media).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
  /* 每个位对应一句：把 mediaId 挂到那一句上，排片器就会照它来（而不是自己重新挑） */
  const lines = variant.lines.map((text, index) => {
    const slot = slots[index]?.[1];
    return slot && byId.has(slot) ? { text, mediaId: slot } : text;
  });
  return {
    id: variant.id,
    lines,
    candidates,
    spec,
    compliance: 'publish',
  };
}
