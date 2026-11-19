// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The Fission wizard's pure model: steps, presets, the output plan and the field checks.
 *
 * Everything here is data and arithmetic — no React, no fetch — so the wizard's behaviour can be
 * tested by `node --test` without a browser. The field names stay exactly the ones the batch
 * endpoint accepts (`Count`, `Threads`, `SceneGroups`, …): the wizard layers the presentation, it
 * never renames the job contract or the scene-group record the engine reads.
 */

export type Role = 'video' | 'audio' | 'bgm' | 'intro' | 'outro';

/** One scene group, in the record shape `fission-local` and the Fission engine already accept. */
export type Group = {
  Name: string;
  Enabled: boolean;
  TakePerOutput: number;
  Rule: 'Random' | 'Sequential';
  Speed: number;
  UseThenDelete: boolean;
  AllowReuse: boolean;
};

/** The batch options, field for field: the wizard shows them in layers, it never drops one. */
export type Options = {
  Count: number; Threads: number; TargetDurationSec: number | null; AudioUses: number; VoiceVolume: number; BgmVolume: number;
  OutWidth: number; OutHeight: number; OutFps: number; Naming: string; ImageDurMinSec: number; ImageDurMaxSec: number;
  SplitMode: string; SceneThreshold: number; AvgPieces: number; BySeconds: number; RandomMinSec: number; RandomMaxSec: number;
  Align: number; AllowVideoReuse: boolean; RandomHFlip: boolean; TransitionName: string; TransitionSec: number;
  SubtitleEnabled: boolean; SubtitleStyle: string; SubtitlePos: string; SubtitleFontSize: number;
};

export const roles: Role[] = ['video', 'audio', 'bgm', 'intro', 'outro'];

export const initialOptions: Options = {
  Count: 3, Threads: 2, TargetDurationSec: 12, AudioUses: 1, VoiceVolume: 1, BgmVolume: 0.35,
  OutWidth: 1080, OutHeight: 1920, OutFps: 30, Naming: 'AudioFileName', ImageDurMinSec: 2, ImageDurMaxSec: 4,
  SplitMode: 'Scene', SceneThreshold: 0.3, AvgPieces: 4, BySeconds: 3, RandomMinSec: 2, RandomMaxSec: 4, Align: 1,
  AllowVideoReuse: false, RandomHFlip: true, TransitionName: 'fade', TransitionSec: 0, SubtitleEnabled: false,
  SubtitleStyle: 'white-outline', SubtitlePos: 'bottom', SubtitleFontSize: 64,
};

export const stepIds = ['materials', 'rules', 'export'] as const;
export type StepId = (typeof stepIds)[number];

export type PresetId = 'voice-mix' | 'product-show' | 'fast-cut' | 'custom';
export const presetIds: PresetId[] = ['voice-mix', 'product-show', 'fast-cut', 'custom'];
type NamedPreset = Exclude<PresetId, 'custom'>;
const namedPresets: NamedPreset[] = ['voice-mix', 'product-show', 'fast-cut'];

const full = (patch: Partial<Options>): Options => ({ ...initialOptions, ...patch });

/**
 * A preset writes a complete, known option set. `custom` writes nothing and exposes everything:
 * that is the only boundary between a preset and the full parameter surface.
 */
export const presetOptions: Record<NamedPreset, Options> = {
  // 口播混剪 / voice mix: the native defaults — split on scene changes, follow the voice length.
  'voice-mix': full({}),
  // 产品展示 / product showcase: landscape, whole shots, steady order.
  'product-show': full({
    Count: 4, Threads: 2, TargetDurationSec: 15, OutWidth: 1920, OutHeight: 1080, Naming: 'RandomTitle',
    SplitMode: 'AveragePieces', AvgPieces: 3, SceneThreshold: 0.35, RandomMinSec: 2, RandomMaxSec: 4, Align: 2,
    ImageDurMinSec: 3, ImageDurMaxSec: 5, AllowVideoReuse: false, RandomHFlip: false,
    TransitionName: 'fade', TransitionSec: 0.4, BgmVolume: 0.25, AudioUses: 1,
  }),
  // 快节奏 / fast cut: short pieces, quick transitions, reuse allowed.
  'fast-cut': full({
    Count: 6, Threads: 4, TargetDurationSec: 8, Naming: 'Sequence', SplitMode: 'BySeconds', BySeconds: 1.2,
    SceneThreshold: 0.4, AvgPieces: 4, RandomMinSec: 1, RandomMaxSec: 2, Align: 1,
    ImageDurMinSec: 0.8, ImageDurMaxSec: 1.5, AllowVideoReuse: true, RandomHFlip: true,
    TransitionName: 'random', TransitionSec: 0.15, AudioUses: 1,
  }),
};

type GroupTuning = Pick<Group, 'Rule' | 'Speed' | 'TakePerOutput' | 'AllowReuse'>;

/** The scene-group defaults a preset asks for; a card edit flips the wizard to `custom`. */
export const presetGroups: Record<NamedPreset, GroupTuning> = {
  'voice-mix': { Rule: 'Random', Speed: 1, TakePerOutput: 0, AllowReuse: false },
  'product-show': { Rule: 'Sequential', Speed: 1, TakePerOutput: 1, AllowReuse: false },
  'fast-cut': { Rule: 'Random', Speed: 1.15, TakePerOutput: 2, AllowReuse: true },
};

export function applyPreset(preset: PresetId, current: Options): Options {
  return preset === 'custom' ? current : { ...presetOptions[preset] };
}

/** `UseThenDelete` is deliberately left alone: a preset never changes what deleting used media means. */
export function applyPresetToGroups(preset: PresetId, groups: Group[]): Group[] {
  if (preset === 'custom') return groups;
  const tuning = presetGroups[preset];
  return groups.map(group => ({ ...group, ...tuning }));
}

export function detectPreset(options: Options): PresetId {
  for (const id of namedPresets) {
    const expected = presetOptions[id], keys = Object.keys(expected) as (keyof Options)[];
    if (keys.every(key => options[key] === expected[key])) return id;
  }
  return 'custom';
}

/**
 * Rough wall-clock planning, deliberately simple and stated as an estimate in the UI:
 * one output encodes in `perOutputSec × 0.42` plus a fixed probe/split overhead, spread over the
 * batch concurrency. Capacity follows the engine: voices × max(AudioUses, 1), capped by Count.
 */
export const DEFAULT_TARGET_SEC = 12;
const ENCODE_FACTOR = 0.42;
const OUTPUT_OVERHEAD_SEC = 3.5;

export type Plan = { outputs: number; seconds: number; perOutputSec: number; capacity: number };

export function plan(options: Options, voices: number | null = null): Plan {
  const count = Number.isFinite(options.Count) ? Math.max(0, Math.trunc(options.Count)) : 0;
  const audioUses = Number.isFinite(options.AudioUses) ? Math.max(0, Math.trunc(options.AudioUses)) : 0;
  // Without a readable voice folder the batch synthesises one voice per requested output.
  const voiceCount = voices !== null && Number.isFinite(voices) && voices >= 0 ? Math.trunc(voices) : Math.max(count, 1);
  const capacity = voiceCount * Math.max(audioUses, 1);
  const outputs = count === 0 ? capacity : audioUses === 0 ? count : Math.min(count, capacity);
  const target = options.TargetDurationSec !== null && Number.isFinite(options.TargetDurationSec) && options.TargetDurationSec > 0
    ? options.TargetDurationSec
    : DEFAULT_TARGET_SEC;
  const threads = Number.isFinite(options.Threads) && options.Threads >= 1 ? Math.trunc(options.Threads) : 1;
  const seconds = Math.ceil((outputs * (target * ENCODE_FACTOR + OUTPUT_OVERHEAD_SEC)) / threads);
  return { outputs, seconds, perOutputSec: target, capacity };
}

export type IssueCode =
  | 'video-missing' | 'groups-none-enabled'
  | 'count-range' | 'threads-range' | 'duration-range' | 'audio-uses-range' | 'volume-range' | 'fps-range'
  | 'image-duration-range' | 'split-threshold-range' | 'pieces-range' | 'pieces-seconds-range'
  | 'random-duration-range' | 'align-range' | 'transition-range' | 'subtitle-font-range'
  | 'group-take-range' | 'group-speed-range';

export type Issue = { step: StepId; code: IssueCode; group?: string };

/** Where each code is reported, and in the existing wording of the workbench. */
export const issueText: Record<IssueCode, [string, string]> = {
  'video-missing': ['请先选择视频素材文件夹。', 'Choose a video folder first.'],
  'groups-none-enabled': ['请至少启用一个场景组。', 'Enable at least one scene group.'],
  'count-range': ['生成数量须为 0–10000 的整数。', 'Count must be a whole number from 0 to 10000.'],
  'threads-range': ['并发数须为 1–64 的整数。', 'Concurrency must be a whole number from 1 to 64.'],
  'duration-range': ['目标时长须大于 0；留空则跟随配音。', 'Target duration must be positive, or empty to follow the voice.'],
  'audio-uses-range': ['每条配音使用次数须为不小于 0 的整数。', 'Outputs per voice must be a whole number, 0 or more.'],
  'volume-range': ['音量须在 0–2 之间。', 'Volume must be between 0 and 2.'],
  'fps-range': ['帧率须为 1–120 的整数。', 'Frame rate must be a whole number from 1 to 120.'],
  'image-duration-range': ['图片时长须大于 0，且最长不小于最短。', 'Image durations must be positive, longest not shorter than shortest.'],
  'split-threshold-range': ['镜头阈值须在 0.01–0.99 之间。', 'Scene threshold must be between 0.01 and 0.99.'],
  'pieces-range': ['平均份数须为不小于 1 的整数。', 'Pieces must be a whole number, 1 or more.'],
  'pieces-seconds-range': ['分割秒数须大于 0。', 'Seconds per piece must be positive.'],
  'random-duration-range': ['随机区间须大于 0，且最长不小于最短。', 'The random range must be positive, longest not shorter than shortest.'],
  'align-range': ['对齐策略须为 1–8 的整数。', 'Alignment must be a whole number from 1 to 8.'],
  'transition-range': ['转场时长限制在 0 到 2 秒之间。', 'Transition is limited to 0 to 2 seconds.'],
  'subtitle-font-range': ['字幕字号须为 20–160 的整数。', 'Subtitle size must be a whole number from 20 to 160.'],
  'group-take-range': ['每条抽取须为不小于 0 的整数。', 'Take per output must be a whole number, 0 or more.'],
  'group-speed-range': ['变速须在 0.5–4 之间。', 'Speed must be between 0.5 and 4.'],
};

export const issueStep: Record<IssueCode, StepId> = {
  'video-missing': 'materials', 'groups-none-enabled': 'materials',
  'group-take-range': 'materials', 'group-speed-range': 'materials',
  'transition-range': 'rules', 'split-threshold-range': 'rules', 'pieces-range': 'rules', 'pieces-seconds-range': 'rules',
  'random-duration-range': 'rules', 'align-range': 'rules', 'image-duration-range': 'rules', 'subtitle-font-range': 'rules',
  'count-range': 'export', 'threads-range': 'export', 'duration-range': 'export', 'audio-uses-range': 'export',
  'volume-range': 'export', 'fps-range': 'export',
};

const within = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
const whole = (value: number) => Number.isInteger(value);

/**
 * The same ranges the batch endpoint and the wizard's own start check enforce, reported per step so
 * a problem is shown where the field is. Driven by (options, groups) so it can be tested directly.
 */
export function issues(options: Options, groups: Group[], state: { hasVideo?: boolean } = {}): Issue[] {
  const found: Issue[] = [];
  const add = (code: IssueCode, group?: string) => found.push({ step: issueStep[code], code, ...(group === undefined ? {} : { group }) });
  if (state.hasVideo === false) add('video-missing');
  if (groups.length > 0 && !groups.some(group => group.Enabled)) add('groups-none-enabled');
  for (const group of groups) {
    if (!whole(group.TakePerOutput) || group.TakePerOutput < 0) add('group-take-range', group.Name);
    if (!within(group.Speed, 0.5, 4)) add('group-speed-range', group.Name);
  }
  if (options.TargetDurationSec !== null && !within(options.TargetDurationSec, Number.MIN_VALUE, Number.MAX_VALUE)) add('duration-range');
  if (!whole(options.Count) || !within(options.Count, 0, 10000)) add('count-range');
  if (!whole(options.Threads) || !within(options.Threads, 1, 64)) add('threads-range');
  if (!whole(options.AudioUses) || options.AudioUses < 0) add('audio-uses-range');
  if (!within(options.VoiceVolume, 0, 2) || !within(options.BgmVolume, 0, 2)) add('volume-range');
  if (!whole(options.OutFps) || !within(options.OutFps, 1, 120)) add('fps-range');
  if (!within(options.ImageDurMinSec, Number.MIN_VALUE, Number.MAX_VALUE) || !within(options.ImageDurMaxSec, options.ImageDurMinSec, Number.MAX_VALUE)) add('image-duration-range');
  if (!within(options.SceneThreshold, 0.01, 0.99)) add('split-threshold-range');
  if (!whole(options.AvgPieces) || options.AvgPieces < 1) add('pieces-range');
  if (!within(options.BySeconds, Number.MIN_VALUE, Number.MAX_VALUE)) add('pieces-seconds-range');
  if (!within(options.RandomMinSec, Number.MIN_VALUE, Number.MAX_VALUE) || !within(options.RandomMaxSec, options.RandomMinSec, Number.MAX_VALUE)) add('random-duration-range');
  if (!whole(options.Align) || !within(options.Align, 1, 8)) add('align-range');
  if (!within(options.TransitionSec, 0, 2)) add('transition-range');
  if (!whole(options.SubtitleFontSize) || !within(options.SubtitleFontSize, 20, 160)) add('subtitle-font-range');
  return found;
}

/** One issue of a kind per step (and per scene group): repeated field-level hits collapse to one line. */
export function issuesFor(found: Issue[], step: StepId): Issue[] {
  const seen = new Set<string>();
  return found.filter(issue => {
    const key = `${issue.code}\u0000${issue.group ?? ''}`;
    if (issue.step !== step || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** How a step is drawn: done, still missing something, or shut until the step before it is done. */
export type StepState = 'ok' | 'todo' | 'locked';

export type StepGates = { states: Record<StepId, StepState>; materialsDone: boolean };

/**
 * The wizard's gate, read from the data and never from the click: step ① is done only once at least one material is
 * chosen and its own fields are clean, and ② and ③ stay shut while ① is open. A step is not "ready" because nothing
 * complained about it — it is ready because the step before it is done and its own fields are clean.
 */
export function stepStates(
  options: Options, groups: Group[], state: { hasVideo?: boolean; selectedMaterials?: number } = {},
): StepGates {
  const chosen = state.selectedMaterials ?? (state.hasVideo === false ? 0 : 1);
  const found = issues(options, groups, { hasVideo: state.hasVideo });
  const materialsDone = chosen >= 1 && issuesFor(found, 'materials').length === 0;
  const afterMaterials = (step: StepId): StepState =>
    !materialsDone ? 'locked' : issuesFor(found, step).length === 0 ? 'ok' : 'todo';
  return {
    states: { materials: materialsDone ? 'ok' : 'todo', rules: afterMaterials('rules'), export: afterMaterials('export') },
    materialsDone,
  };
}

export function reorder<T>(items: T[], from: number, to: number): T[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
