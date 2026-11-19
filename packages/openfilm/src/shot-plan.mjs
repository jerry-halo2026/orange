// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 排片：把"要说什么、说多久"配上"用哪条素材、从第几秒裁到第几秒、要不要变速"。
 *
 * # 为什么要有这一层
 *
 * 素材时长各不相同（我们语料 p50 33 s、p95 72 s），而一个镜头通常只有 2–5 s；空镜头又不能配口播。
 * 如果先挑素材再配音，画面和声音必然对不上。所以**时间以音频为准**：
 *
 *   文案按句切 → TTS 出真实时长 → 每句配一个镜头（裁到句子长度）→ 句间留空镜做缝。
 *
 * 这一层的输出是纯数据（谁渲染都照它执行）：Studio 写时间线、Fission 渲染、agent 自查都用同一份计划。
 *
 * # 三条规则
 *
 * 1. **一句一镜**：句子多长，镜头就多长（素材被裁，而不是把句子拉长）；
 * 2. **素材不够长才让步**：先找 `duration >= 需要` 的；找不到允许 1.0 → 0.9 的轻微慢放（超过 10% 观众看得出来），
 *    再找不到就报 `no-candidate-long-enough`，绝不偷偷把句子截断；
 * 3. **同一素材不重复用**：池子用尽才复用，并记 `reused` —— 一个 15 秒片子里出现两遍同一个镜头很显眼。
 *
 * 空镜（`kind: 'breath'`）单独处理：优先用标成空镜的素材，只填缝，不配口播。
 */

/** 默认参数：都偏保守，宁可片子长一点，也不要"画面与声音打架"。 */
export const PLAN_DEFAULTS = Object.freeze({
  /** 一个镜头最短多久：短于这个就是碎镜，观众会晕。 */
  minShotSec: 1.2,
  /** 一个镜头最长多久：超过就说明该多切一刀。 */
  maxShotSec: 8,
  /** 允许的最慢放：1.0 = 原速，0.9 = 慢 11%。再慢就不像口播混剪了。 */
  slowestSpeed: 0.9,
  /** 句子与镜头之间的余量：给转场留一口气。 */
  marginSec: 0.15,
  /** 长素材从哪儿起裁：按比例避开开头（开头常有场记板/黑场）。 */
  headFrac: 0.15,
});

const round = (/** @type {number} */ value, digits = 3) => Number(value.toFixed(digits));
const clamp = (/** @type {number} */ value, /** @type {number} */ low, /** @type {number} */ high) => Math.min(high, Math.max(low, value));

/**
 * @typedef {{ id: string, durationSec: number, kind?: 'shot' | 'broll', score?: number }} Candidate
 * @typedef {{ id: string, text?: string, durationSec: number, kind?: 'speech' | 'breath',
 *   mediaId?: string }} Segment
 * `mediaId` on a segment is the material a planset expansion already assigned to that line.
 * @typedef {{ segmentId: string, mediaId: string, startSec: number, endSec: number, speed: number, shownSec: number }} Shot
 */

/**
 * 一段台词配一个镜头。
 * @param {Segment} segment @param {Candidate[]} pool @param {typeof PLAN_DEFAULTS & { usedIds?: Set<string> }} options
 * @returns {{ shot: Shot | null, problem: string | null }}
 */
function planSpeech(segment, pool, options) {
  const need = segment.durationSec + options.marginSec;
  /* 计划里指定了这一位用哪条素材（planset 展开出来的就是这种）：**尊重它**，别让排序重新挑一遍 ——
     否则 12 条变体会因为候选时长相近而全挑同一条，展开等于没展开。撑不住才回落到池子并记问题。 */
  const fixed = segment.mediaId ? pool.filter((candidate) => candidate.id === segment.mediaId) : [];
  const candidatePool = fixed.length ? fixed : pool;
  const usable = candidatePool.filter((candidate) => {
    const shown = candidate.durationSec / (options.slowestSpeed);
    return candidate.durationSec >= need || (candidate.durationSec < need && shown >= need);
  });
  if (!usable.length) {
    if (fixed.length) {
      /* 指定的这条太短：交给调用方重排，而不是偷偷换成别的素材 */
      return { shot: null, problem: `${segment.id}: assigned-material-too-short ${segment.mediaId}` };
    }
    return { shot: null, problem: `${segment.id}: no-candidate-long-enough` };
  }

  /* 优先：够长、没用过、分数高的；够长里挑“刚好够用”的（省素材，也避免大材小用裁掉一多半） */
  const sorted = [...usable].sort((a, b) => {
    const fits = (/** @type {Candidate} */ candidate) => (candidate.durationSec >= need ? 0 : 1);
    return fits(a) - fits(b)
      || (options.usedIds?.has(a.id) ? 1 : 0) - (options.usedIds?.has(b.id) ? 1 : 0)
      || a.durationSec - b.durationSec
      || (b.score ?? 0) - (a.score ?? 0);
  });
  const pick = sorted[0];
  const reused = options.usedIds?.has(pick.id) === true;
  options.usedIds?.add(pick.id);

  /* 变速：够长就是 1.0；不够就慢放到刚好填满（不低于 slowestSpeed） */
  const speed = pick.durationSec >= need ? 1 : round(Math.max(options.slowestSpeed, pick.durationSec / need), 2);
  const shownSec = round(Math.min(need, pick.durationSec / speed), 3);
  const room = pick.durationSec - shownSec * speed;
  const start = round(clamp(pick.durationSec * options.headFrac, 0, Math.max(0, room)), 3);
  const end = round(start + shownSec * speed, 3);
  return {
    shot: { segmentId: segment.id, mediaId: pick.id, startSec: start, endSec: end, speed, shownSec },
    problem: reused ? `${segment.id}: reused-material ${pick.id}` : (pick.durationSec >= need ? null : `${segment.id}: slowed-to ${speed}`),
  };
}

/**
 * 排一条片子。
 *
 * @param {{ segments: Segment[], candidates: Candidate[], targetSec?: number, options?: Partial<typeof PLAN_DEFAULTS> }} request
 * @returns {{ shots: Shot[], problems: string[], summary: { totalSec: number, shotCount: number, speechSec: number,
 *   breathSec: number, slowed: number, reused: number, targetSec: number | null, deviationSec: number | null } }}
 */
export function planShots({ segments, candidates, targetSec = 0, options = {} }) {
  const settings = { ...PLAN_DEFAULTS, ...options };
  /** @type {Shot[]} */
  const shots = [];
  /** @type {string[]} */
  const problems = [];
  const usedIds = new Set();

  for (const segment of segments) {
    if (!(segment.durationSec > 0)) { problems.push(`${segment.id}: no-duration`); continue; }
    const isBreath = segment.kind === 'breath';
    /* 空镜优先用标成空镜的素材；口播优先用非空镜 —— 空镜配口播是"对不上"的典型来源。
       但**指定了素材就别筛掉它**：planset 展开时每个位已经定好是哪条，筛掉等于没指定。 */
    const assigned = segment.mediaId ? candidates.filter((candidate) => candidate.id === segment.mediaId) : [];
    const preferred = candidates.filter((candidate) => (isBreath ? candidate.kind === 'broll' : candidate.kind !== 'broll'));
    const pool = assigned.length ? assigned : (preferred.length ? preferred : candidates);
    const { shot, problem } = planSpeech(segment, pool, { ...settings, usedIds });
    if (problem) problems.push(problem);
    if (!shot) continue;
    if (shot.shownSec < settings.minShotSec) problems.push(`${segment.id}: shot-too-short ${shot.shownSec}s`);
    if (shot.shownSec > settings.maxShotSec) problems.push(`${segment.id}: shot-too-long ${shot.shownSec}s（该多切一刀）`);
    shots.push(shot);
  }

  const totalSec = round(shots.reduce((sum, shot) => sum + shot.shownSec, 0), 3);
  const speechSec = round(shots.filter((shot) => segments.find((s) => s.id === shot.segmentId)?.kind !== 'breath')
    .reduce((sum, shot) => sum + shot.shownSec, 0), 3);
  const deviationSec = targetSec > 0 ? round(totalSec - targetSec, 3) : null;
  if (targetSec > 0 && Math.abs(deviationSec ?? 0) > 0.5) problems.push(`total ${totalSec}s, target ${targetSec}s`);

  return {
    shots,
    problems,
    summary: {
      totalSec,
      shotCount: shots.length,
      speechSec,
      breathSec: round(totalSec - speechSec, 3),
      slowed: shots.filter((shot) => shot.speed < 1).length,
      reused: new Set(shots.map((shot) => shot.mediaId)).size !== shots.length
        ? shots.length - new Set(shots.map((shot) => shot.mediaId)).size : 0,
      targetSec: targetSec > 0 ? targetSec : null,
      deviationSec,
    },
  };
}

/**
 * 按字数估一句口播有多长（真值是 TTS 出来的音频时长，这里只用于"还没配音时的预排"）。
 * 中文口播约 4–5 字/秒：默认 4.5，标点再加一点停顿。
 * @param {string} text @param {{ charsPerSecond?: number }} [options]
 */
export function estimateSpeechSec(text, { charsPerSecond = 4.5 } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return 0;
  const chars = [...clean.replace(/\s+/g, '')].length;
  const pauses = (clean.match(/[，。！？、；：,.!?;:]/g) ?? []).length * 0.18;
  return round(chars / charsPerSecond + pauses, 2);
}
