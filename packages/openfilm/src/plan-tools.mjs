// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 从"用户一句话"到一份可校验的 plan：句子 → 时长估算 → 排片 → cues → 七条校验。
 *
 * 这是 agent 剪片时真正要调的那一层。它**不碰网络**：素材候选由调用方（`material.search`）给，
 * 配音由 `voice-timing` 在下一步做。这样单测能跑、也能在离线时给出可预览的计划。
 *
 * 分工：
 *   material.search / library.search  → 候选（id、时长、分数、场景标签）
 *   createPlanFromBrief               → plan（本文件：排片 + cues）
 *   measurePlanVoices                 → 把估算换成实测（voice-timing.mjs）
 *   validatePlan                      → 七条校验（plan-schema.mjs）
 *   claim-check                       → 合规（draft / publish）
 */

import { normalisePlan, validatePlan } from './plan-schema.mjs';
import { estimateSpeechSec, planShots } from './shot-plan.mjs';
import { checkClaims, sceneTags } from './claim-check.mjs';

/**
 * @typedef {{ id: string, durationSec: number, kind?: 'shot' | 'broll', score?: number, name?: string }} Candidate
 * @typedef {{ text: string, kind?: 'speech' | 'breath', id?: string, mediaId?: string }} BriefLine
 * `mediaId` is the material a planset expansion pinned to that line; a bare string is accepted as a line too.
 */

/**
 * 一句人话：把校验结果说成用户能听懂的一句（Fission 界面与 agent 回报都用它）。
 * @param {ReturnType<typeof validatePlan>} report
 */
export function verdictOf(report) {
  if (report.ok && report.issues.length === 0) {
    return `可以出片：${report.summary.totalSec}s / ${report.summary.shotCount} 个镜头`;
  }
  const blocking = report.issues.filter((issue) => issue.level === 'block');
  if (blocking.length) {
    return `${blocking.length} 处必须改：${blocking.slice(0, 2).map((issue) => issue.message).join('；')}`;
  }
  const warn = report.issues.filter((issue) => issue.level === 'warn');
  return `可以出片，但 ${warn.length} 处要留意：${warn.slice(0, 2).map((issue) => issue.message).join('；')}`;
}

/**
 * 从"一句话需求"生成计划。
 *
 * @param {{ id?: string, product?: { name?: string, scene?: string, batch?: string },
 *   lines: (BriefLine | string)[], candidates: Candidate[],
 *   spec?: Partial<ReturnType<typeof normalisePlan>['spec']>,
 *   compliance?: 'draft' | 'publish' }} request
 * @returns {{ plan: any, report: ReturnType<typeof validatePlan>, claims: { text: string, ok: boolean, blocking: number,
 *   hits: string[], scenes: string[] }[], verdict: string, summary: ReturnType<typeof planShots>['summary'] }}
 */
export function createPlanFromBrief({ id = 'plan', product = {}, lines, candidates, spec = {}, compliance = 'draft' }) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('至少给一句文案');
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('至少给一个素材候选');

  /** @type {any[]} */
  const segments = lines.map((rawLine, index) => {
    /* 允许 ['一句话', …] 这种最省事的写法：字符串就是一句台词 */
    const line = typeof rawLine === 'string' ? { text: rawLine } : rawLine;
    const kind = line.kind === 'breath' ? 'breath' : 'speech';
    const text = kind === 'speech' ? String(line.text ?? '').trim() : '';
    /* 这一句指定用哪条素材（planset 展开的变体带过来的）：带上它，排片器就不会重新挑一条 */
    const mediaId = typeof line.mediaId === 'string' && line.mediaId ? line.mediaId : '';
    return {
      id: line.id ?? (kind === 'breath' ? `B${index + 1}` : `S${index + 1}`),
      kind,
      text,
      ...(mediaId ? { mediaId } : {}),
      audioSec: kind === 'speech' ? estimateSpeechSec(text) : Number(line.text ?? 0) || 0.2,
      estimated: kind === 'speech',
      voice: null,
    };
  });

  /* 排片：句子当段落、候选当池子；呼吸段不进排片（它只是间隙） */
  const speechSegments = segments.filter((segment) => segment.kind === 'speech');
  const { shots, problems, summary } = planShots({
    /* planShots 认 durationSec；plan 的段落用 udioSec 记，这里换名传过去 */
    segments: speechSegments.map((segment) => ({ id: segment.id, durationSec: segment.audioSec, kind: 'speech',
      /* planset 展开时会指定每个位用哪条素材；带上它，排片器就不会重新挑 */
      ...(segment.mediaId ? { mediaId: segment.mediaId } : {}) })),
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      durationSec: Number(candidate.durationSec),
      kind: candidate.kind === 'broll' ? 'broll' : 'shot',
      score: candidate.score ?? 0.5,
    })),
  });

  /* 合规：草稿期只标注，发布期才阻断 */
  const claims = speechSegments.map((segment) => {
    const result = checkClaims(segment.text, { mode: compliance });
    return {
      text: segment.text,
      ok: result.ok,
      blocking: result.blocking,
      hits: result.hits.map((hit) => `${hit.category}（${hit.match}）`),
      scenes: sceneTags(segment.text),
    };
  });
  const blocking = claims.reduce((sum, claim) => sum + claim.blocking, 0);

  const plan = normalisePlan({
    id,
    spec,
    product,
    segments,
    shots: shots.map((shot) => ({ ...shot, kind: candidates.find((candidate) => candidate.id === shot.mediaId)?.kind === 'broll' ? 'broll' : 'shot' })),
    compliance: { mode: compliance, blocking, checkedAt: new Date().toISOString() },
    warnings: problems,
  });
  const report = validatePlan(plan);
  return { plan, report, claims, verdict: verdictOf(report), summary };
}

/**
 * 时长配额分配：目标 15s、口播只有 12.8s，差出来的 2.2s 必须有去处 —— 否则要么"总时长不够"，
 * 要么有人偷偷把某个镜头拉长（那是最难看的做法：一个 3 秒的镜头突然变 5 秒）。
 *
 * 分配顺序（越靠前越自然）：
 *   ① 句间呼吸：每个接缝最多 `maxBreathSec`（默认 0.6s），先补到 `spec.breathSec` 以上；
 *   ② 片尾停留：最后一个镜头之后再留一口气（用同一个镜头的尾帧，不另加素材）；
 *   ③ 还不够：交给调用方（返回 shortage），由人决定"加一句文案"还是"减一个镜头"。
 *
 * @param {any} plan @param {{ maxBreathSec?: number, tailSec?: number }} [options]
 * @returns {{ plan: any, addedSec: number, shortageSec: number, notes: string[] }}
 */
export function paceToTarget(plan, { maxBreathSec = 0.6, tailSec = 1.0 } = {}) {
  const target = Number(plan.spec?.targetSec ?? 0);
  const notes = [];
  if (!(target > 0)) return { plan, addedSec: 0, shortageSec: 0, notes: ['没有目标时长，跳过配额分配'] };

  const shotsSec = plan.shots.reduce((sum, shot) => sum + shot.shownSec, 0);
  const gapsSec = plan.segments.filter((segment) => segment.kind === 'breath').reduce((sum, segment) => sum + segment.audioSec, 0);
  let deficit = Number((target - shotsSec - gapsSec).toFixed(3));
  if (deficit <= 0.01) return { plan, addedSec: 0, shortageSec: 0, notes: ['已经够长'] };

  /* ① 句间呼吸 */
  const speech = plan.segments.filter((segment) => segment.kind === 'speech');
  const seams = Math.max(0, speech.length - 1);
  const wanted = Math.min(maxBreathSec, seams > 0 ? deficit / seams : 0);
  if (seams > 0 && wanted > Number(plan.spec.breathSec ?? 0.2)) {
    for (const segment of plan.segments) {
      if (segment.kind !== 'breath') continue;
      const add = Math.min(maxBreathSec - segment.audioSec, deficit / Math.max(1, plan.segments.filter((s) => s.kind === 'breath').length));
      if (add > 0) { segment.audioSec = Number((segment.audioSec + add).toFixed(3)); deficit = Number((deficit - add).toFixed(3)); }
      if (deficit <= 0.01) break;
    }
    if (deficit <= 0.01) notes.push(`句间呼吸补足 ${(target - shotsSec - gapsSec).toFixed(2)}s`);
  }

  /* ② 片尾停留：最后一个镜头多留一口气（尾帧，不占新素材） */
  if (deficit > 0.01 && plan.shots.length && tailSec > 0) {
    const add = Math.min(tailSec, deficit);
    const last = plan.shots[plan.shots.length - 1];
    last.shownSec = Number((last.shownSec + add).toFixed(3));
    deficit = Number((deficit - add).toFixed(3));
    notes.push(`片尾停留 ${add.toFixed(2)}s`);
  }

  return {
    plan,
    addedSec: Number((target - shotsSec - gapsSec - deficit).toFixed(3)),
    shortageSec: Number(Math.max(0, deficit).toFixed(3)),
    notes,
  };
}