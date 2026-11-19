// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import type { Str } from './fields';
import { presetLabels } from './PresetPicker';
import type { Options, Plan, PresetId, Role } from './wizard';

export function formatDuration(seconds: number, L: Str): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60), rest = total % 60;
  return minutes ? L(`${minutes} 分 ${rest} 秒`, `${minutes} min ${rest} s`) : L(`${rest} 秒`, `${rest} s`);
}

/**
 * The summary at the top of the wizard: what is configured and roughly what it will produce. It is `sticky` at the very
 * top and the wizard measures its height, so each step carries that height as `scroll-margin-top` and a step that is
 * jumped to lands under the summary instead of behind it. Deliberately name-free — it counts what is chosen instead of
 * repeating folder names, so the summary and the folder rows never say the same thing twice.
 *
 * Two readings of one record: the full one, and — under 1200px, where the drawer and a narrow window live — a folded
 * summary line that keeps the step, the materials and the estimate and drops the rest.
 */
export function SummaryBar({ L, options, plan: planned, preset, selectedRoles, groupCount, enabledGroups, stepTitle }: {
  L: Str; options: Options; plan: Plan; preset: PresetId;
  selectedRoles: Role[]; groupCount: number; enabledGroups: number; stepTitle: string;
}) {
  const count = options.Count === 0 ? L('不限（按配音池）','No cap (voice pool)') : L(`${options.Count} 条`,`${options.Count} videos`);
  const target = options.TargetDurationSec === null ? L('跟随配音','Follows voice') : L(`${options.TargetDurationSec} 秒`,`${options.TargetDurationSec} s`);
  const audio = `${L('每条配音','Per voice')} ×${options.AudioUses} · ${L('配音','voice')} ${options.VoiceVolume} · ${L('背景','BGM')} ${options.BgmVolume}`;
  const materials = `${selectedRoles.length}/${5} · ${L('场景组','Groups')} ${enabledGroups}/${groupCount}`;
  return <section aria-label={L('配置摘要与预计产出','Summary and estimate')} className="sticky top-0 z-10 rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-3 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <dl data-summary="full" className="flex min-w-0 flex-wrap gap-x-5 gap-y-1 text-xs max-[1200px]:hidden">
        <div className="flex gap-1"><dt className="text-[var(--text-muted)]">{L('当前步骤','Step')}</dt><dd className="font-medium">{stepTitle}</dd></div>
        <div className="flex gap-1"><dt className="text-[var(--text-muted)]">{L('预设','Preset')}</dt><dd className="font-medium">{L(...presetLabels[preset])}</dd></div>
        <div className="flex gap-1"><dt className="text-[var(--text-muted)]">{L('素材','Materials')}</dt><dd className="font-medium">{materials}</dd></div>
        <div className="flex gap-1"><dt className="text-[var(--text-muted)]">{L('数量','Count')}</dt><dd className="font-medium">{count}</dd></div>
        <div className="flex gap-1"><dt className="text-[var(--text-muted)]">{L('目标时长','Target')}</dt><dd className="font-medium">{target}</dd></div>
        <div className="flex gap-1"><dt className="text-[var(--text-muted)]">{L('并发','Concurrency')}</dt><dd className="font-medium">{options.Threads}</dd></div>
        <div className="flex gap-1"><dt className="text-[var(--text-muted)]">{L('音频','Audio')}</dt><dd className="font-medium">{audio}</dd></div>
      </dl>
      {/* The folded reading: one line, the three things a narrow window still needs to see. */}
      <dl data-summary="folded" className="hidden min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-xs max-[1200px]:flex">
        <div className="flex min-w-0 gap-1"><dt className="text-[var(--text-muted)]">{L('步骤','Step')}</dt><dd className="truncate font-medium">{stepTitle}</dd></div>
        <div className="flex shrink-0 gap-1"><dt className="text-[var(--text-muted)]">{L('素材','Materials')}</dt><dd className="font-medium">{materials}</dd></div>
        <div className="flex shrink-0 gap-1"><dt className="text-[var(--text-muted)]">{L('数量','Count')}</dt><dd className="font-medium">{count}</dd></div>
      </dl>
      <div className="text-right">
        <p role="status" className="text-sm font-semibold">{L('预计产出 ','Estimate ')}{planned.outputs} {L('条成片','videos')}</p>
        <p className="text-xs text-[var(--text-muted)]">{L('估算耗时 ','About ')}{formatDuration(planned.seconds, L)} · {planned.perOutputSec} {L('秒/条','s each')} · x{options.Threads}</p>
        <p className="text-[11px] text-[var(--text-muted)] max-[1200px]:hidden">{L('估算含编码余量，实际取决于素材与机器。','Estimate includes encoding slack; the real time depends on media and machine.')}</p>
      </div>
    </div>
  </section>;
}
