// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import type { Str } from './fields';
import type { PresetId } from './wizard';

export const presetLabels: Record<PresetId, [string, string]> = {
  'voice-mix': ['口播混剪', 'Voice mix'],
  'product-show': ['产品展示', 'Product showcase'],
  'fast-cut': ['快节奏', 'Fast cut'],
  custom: ['自定义', 'Custom'],
};

export const presetNotes: Record<PresetId, [string, string]> = {
  'voice-mix': ['按镜头切分，时长跟随配音，按配音文件命名。', 'Split on scene changes, follow the voice length, name outputs after the voice file.'],
  'product-show': ['横屏、整镜头抽取、组内顺序取用。', 'Landscape, whole shots, groups drawn in order.'],
  'fast-cut': ['按秒切碎、快转场、允许复用，偏短视频节奏。', 'Seconds-long pieces, quick transitions, reuse allowed: a short-video rhythm.'],
  custom: ['不套用预设，展开全部参数自行设置。', 'No preset: every parameter is yours to set.'],
};

/**
 * Presets and the full surface behind them. Picking a preset writes a known option set (and the
 * scene-group defaults); editing anything afterwards moves the wizard to 自定义, which is the only
 * place that exposes the whole parameter list.
 */
export function PresetPicker({ preset, onPick, L, disabled, ids }: {
  preset: PresetId; onPick: (preset: PresetId) => void; L: Str; disabled?: boolean; ids: PresetId[];
}) {
  return <div>
    <div role="radiogroup" aria-label={L('预设','Preset')} className="flex flex-wrap gap-2">
      {ids.map(id => <label key={id} className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5 text-sm ${preset === id ? 'border-[var(--text)] font-semibold' : 'border-[var(--border)] hover:bg-[var(--bg-hover)]'}`}>
        <input type="radio" name="fission-preset" value={id} checked={preset === id} disabled={disabled} onChange={() => onPick(id)}/>
        {L(...presetLabels[id])}
      </label>)}
    </div>
    <p className="mt-2 text-xs text-[var(--text-muted)]">{L(...presetNotes[preset])}</p>
  </div>;
}
