// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * `plan.json` —— 一条片子的**唯一计划物**。Studio 的时间线与 Fission 的 job 都从它派生，
 * 不再有第二套格式（这是"两边渲染结果一致"的前提）。
 *
 * # 为什么需要它
 *
 * 以前 Studio 的时间线是 `film.html`，Fission 的输入是"几个目录 + 一堆参数"。两边各说各的，
 * 所以同一批素材在 Studio 里是一个顺序、在 Fission 里又是另一个顺序，字幕各切一遍，时长各算一遍。
 * 现在中间放一份 plan：**谁渲染都读它**。
 *
 * # 时间以音频为准
 *
 * `segments[i].audioSec` 是 TTS 出来之后用 ffprobe 实测的时长（没测过就是 `estimated: true`）；
 * `shots[i].shownSec` 是这个镜头实际显示多久。校验的第一条就是 `audioSec <= shownSec` ——
 * 画面先跑完就是"对不上"。
 *
 * # 版本
 *
 * `schema: 'orange/plan/1'`。字段只增不删；读旧 plan 时 `normalisePlan` 补默认值。
 */

export const PLAN_SCHEMA = 'orange/plan/1';

/** 规格默认值：15s 竖屏抖音。 */
export function defaultSpec() {
  return {
    targetSec: 15,
    aspect: '9:16',
    width: 1080,
    height: 1920,
    fps: 30,
    minShots: 5,
    minShotSec: 1.2,
    maxShotSec: 8,
    /** 句间换气的目标值；排片时用 marginSec，校验时用这个判断"是否有呼吸" */
    breathSec: 0.2,
  };
}

const number = (/** @type {unknown} */ value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const text = (/** @type {unknown} */ value) => (typeof value === 'string' ? value : '');
const round = (/** @type {number} */ value) => Number(value.toFixed(3));

/**
 * 一条段落的规范形状（台词或呼吸）。
 * @param {any} raw @param {number} index
 */
function normaliseSegment(raw, index) {
  const kind = raw?.kind === 'breath' ? 'breath' : 'speech';
  const audioSec = round(Math.max(0, number(raw?.audioSec)));
  return {
    id: text(raw?.id) || `S${index + 1}`,
    kind,
    text: kind === 'speech' ? text(raw?.text) : '',
    audioSec,
    /* 没测过就是估算（校验器对 estimated 报黄，不报红） */
    estimated: raw?.estimated === true || audioSec === 0,
    voice: raw?.voice && typeof raw.voice === 'object'
      ? { provider: text(raw.voice.provider), voice: text(raw.voice.voice), file: text(raw.voice.file) }
      : null,
  };
}

/**
 * 一个镜头的规范形状。
 * @param {any} raw
 */
function normaliseShot(raw) {
  const speed = number(raw?.speed, 1);
  const startSec = round(Math.max(0, number(raw?.startSec)));
  const endSec = round(Math.max(startSec, number(raw?.endSec)));
  return {
    segmentId: text(raw?.segmentId),
    mediaId: text(raw?.mediaId),
    startSec,
    endSec,
    speed: speed > 0 ? speed : 1,
    shownSec: round(Math.max(0, number(raw?.shownSec, endSec - startSec))),
    kind: raw?.kind === 'broll' ? 'broll' : 'shot',
  };
}

/**
 * 由段落与镜头派生字幕 cue：**一处生成，两处使用**（Studio 写 vtt、Fission 写 ass）。
 * 只有 speech 段有字幕；没有口播的段落不配字幕（那是留白，不是漏字）。
 * @param {{ segments: any[], shots: any[] }} plan
 */
export function cuesFromPlan({ segments, shots }) {
  /** @type {{ startSec: number, endSec: number, text: string }[]} */
  const cues = [];
  let at = 0;
  for (const segment of segments) {
    /* 呼吸段不是镜头：它只是把时间往后推，不产生字幕 */
    if (segment.kind === 'breath') { at = round(at + segment.audioSec); continue; }
    const shot = shots.find((entry) => entry.segmentId === segment.id);
    const span = round(shot?.shownSec ?? segment.audioSec);
    if (segment.text) cues.push({ startSec: round(at), endSec: round(at + span), text: segment.text });
    at = round(at + span);
  }
  return cues;
}

/**
 * 把任何形状的 plan 规范成 `orange/plan/1`。缺的补默认、多的保留（只增不删）、顺序稳定。
 * @param {any} raw @param {{ id?: string }} [options]
 */
export function normalisePlan(raw, { id = '' } = {}) {
  const spec = { ...defaultSpec(), ...(raw?.spec && typeof raw.spec === 'object' ? raw.spec : {}) };
  /** @type {any[]} */
  const segments = Array.isArray(raw?.segments)
    ? raw.segments.map((segment, index) => normaliseSegment(segment, index))
    : [];
  /** @type {any[]} */
  const shots = Array.isArray(raw?.shots) ? raw.shots.map(normaliseShot) : [];
  const plan = {
    schema: PLAN_SCHEMA,
    id: text(raw?.id) || id || 'plan',
    createdAt: text(raw?.createdAt) || new Date().toISOString(),
    spec: {
      targetSec: number(spec.targetSec, 15),
      aspect: text(spec.aspect) || '9:16',
      width: number(spec.width, 1080),
      height: number(spec.height, 1920),
      fps: number(spec.fps, 30),
      minShots: number(spec.minShots, 5),
      minShotSec: number(spec.minShotSec, 1.2),
      maxShotSec: number(spec.maxShotSec, 8),
      breathSec: number(spec.breathSec, 0.2),
    },
    product: {
      name: text(raw?.product?.name),
      scene: text(raw?.product?.scene),
      batch: text(raw?.product?.batch),
    },
    segments,
    shots,
    /* the cue shape is seeded here so `plan.cues` is not inferred `never[]` from the empty array */
    cues: /** @type {{ startSec: number, endSec: number, text: string }[]} */ ([]),
    elements: {
      transitions: Array.isArray(raw?.elements?.transitions) ? raw.elements.transitions : [],
      stickers: Array.isArray(raw?.elements?.stickers) ? raw.elements.stickers : [],
      text: Array.isArray(raw?.elements?.text) ? raw.elements.text : [],
    },
    bgm: raw?.bgm && typeof raw.bgm === 'object'
      ? { id: text(raw.bgm.id), volume: number(raw.bgm.volume, 0.35), startSec: number(raw.bgm.startSec, 0) }
      : null,
    compliance: {
      mode: raw?.compliance?.mode === 'draft' ? 'draft' : 'publish',
      blocking: number(raw?.compliance?.blocking, 0),
      checkedAt: text(raw?.compliance?.checkedAt),
    },
    warnings: Array.isArray(raw?.warnings) ? raw.warnings.map(text).filter(Boolean) : [],
  };
  plan.cues = Array.isArray(raw?.cues) && raw.cues.length
    ? raw.cues.map((cue) => ({ startSec: round(number(cue?.startSec)), endSec: round(number(cue?.endSec)), text: text(cue?.text) }))
    : cuesFromPlan(plan);
  return plan;
}

/**
 * 七条校验（与 playbook 第 8 节一一对应）。`block` 会让出片停住，`warn` 只提醒。
 * @param {any} plan
 * @returns {{ ok: boolean, issues: { level: 'block' | 'warn', code: string, message: string }[],
 *   summary: { totalSec: number, shotCount: number, speechSec: number, breathSec: number, deviationSec: number } }}
 */
export function validatePlan(plan) {
  const p = normalisePlan(plan);
  /** @type {{ level: 'block' | 'warn', code: string, message: string }[]} */
  const issues = [];
  const shots = p.shots;
  /* 呼吸段不是镜头，它只是时间上的间隙：总时长 = 镜头 + 间隙 */
  const gapsSec = round(p.segments.filter((segment) => segment.kind === 'breath').reduce((sum, segment) => sum + segment.audioSec, 0));
  const totalSec = round(shots.reduce((sum, shot) => sum + shot.shownSec, 0) + gapsSec);
  const speechSec = round(p.segments.filter((segment) => segment.kind !== 'breath')
    .reduce((sum, segment) => sum + number(shots.find((shot) => shot.segmentId === segment.id)?.shownSec ?? 0), 0));
  const deviationSec = round(totalSec - p.spec.targetSec);

  /* ① 时长（targetSec = 0 表示还没定目标，预排时不判） */
  if (p.spec.targetSec > 0 && Math.abs(deviationSec) > 0.3) {
    issues.push({ level: 'block', code: 'duration', message: `总时长 ${totalSec}s，目标 ${p.spec.targetSec}s（差 ${deviationSec}s）` });
  }
  /* ② 镜头数 */
  if (shots.length < p.spec.minShots) {
    issues.push({ level: 'block', code: 'shot-count', message: `只有 ${shots.length} 个镜头，要求 ≥${p.spec.minShots}` });
  }
  /* ③ 碎镜 / 长镜 */
  for (const shot of shots) {
    if (shot.shownSec > 0 && shot.shownSec < p.spec.minShotSec) {
      issues.push({ level: 'block', code: 'shot-too-short', message: `${shot.segmentId} 只有 ${shot.shownSec}s（<${p.spec.minShotSec}s）` });
    }
    if (shot.shownSec > p.spec.maxShotSec) {
      issues.push({ level: 'warn', code: 'shot-too-long', message: `${shot.segmentId} 有 ${shot.shownSec}s（>${p.spec.maxShotSec}s，该多切一刀）` });
    }
    if (!shot.mediaId) {
      issues.push({ level: 'block', code: 'shot-no-media', message: `${shot.segmentId} 没有素材` });
    }
  }
  /* ④ 音画对齐：每句不短于镜头（句子没说完画面就切走 = 对不上） */
  for (const segment of p.segments) {
    if (segment.kind === 'breath') continue;
    const shot = shots.find((entry) => entry.segmentId === segment.id);
    if (!shot) {
      issues.push({ level: 'block', code: 'segment-no-shot', message: `${segment.id}「${segment.text}」没有镜头` });
      continue;
    }
    if (segment.audioSec > shot.shownSec + 0.02) {
      issues.push({ level: 'block', code: 'audio-overruns-shot', message: `${segment.id} 口播 ${segment.audioSec}s 长于镜头 ${shot.shownSec}s` });
    }
    if (segment.estimated) {
      issues.push({ level: 'warn', code: 'audio-estimated', message: `${segment.id} 的时长是估算的（还没跑 TTS）` });
    }
  }
  /* ⑤ 空镜只在无台词处 */
  for (const shot of shots) {
    if (shot.kind !== 'broll') continue;
    const segment = p.segments.find((entry) => entry.id === shot.segmentId);
    if (segment && segment.kind !== 'breath') {
      issues.push({ level: 'warn', code: 'broll-under-speech', message: `${shot.segmentId} 是空镜但配了口播` });
    }
  }
  /* ⑥ 字幕与镜头同帧 */
  for (const cue of p.cues) {
    const covering = shots.find((shot) => Math.abs(shot.shownSec - (cue.endSec - cue.startSec)) < 0.05);
    if (!covering) {
      issues.push({ level: 'warn', code: 'cue-mismatch', message: `字幕「${cue.text.slice(0, 8)}…」没有与某个镜头等长` });
    }
  }
  /* ⑦ 合规闸门 */
  if (p.compliance.mode !== 'publish') {
    issues.push({ level: 'warn', code: 'compliance-draft', message: '合规检查还停在 draft，出片前要用 publish 复检' });
  }
  if (p.compliance.blocking > 0) {
    issues.push({ level: 'block', code: 'compliance-blocking', message: `合规有 ${p.compliance.blocking} 处 block` });
  }
  /* 首帧：第 1 个镜头必须是实拍（空镜开场等于 0.4s 内没出人/产品） */
  if (shots[0]?.kind === 'broll') {
    issues.push({ level: 'warn', code: 'first-shot-broll', message: '第一个镜头是空镜，前 0.4s 没有主体' });
  }

  return {
    ok: !issues.some((issue) => issue.level === 'block'),
    issues,
    summary: { totalSec, shotCount: shots.length, speechSec, breathSec: round(totalSec - speechSec), deviationSec },
  };
}
