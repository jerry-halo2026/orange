// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import React from 'react';
import { ChoiceField, NumberField, ToggleField, hint, smallButton } from './fields';
import type { Str } from './fields';
import type { Group } from './wizard';

/**
 * One scene group as a card. The four rule fields stay on the card's face (启用 / 顺序 / 每条抽取 /
 * 变速 / 允许复用); the rest of the record sits behind 高级, closed by default. Cards can be dragged
 * into a new order and moved with the arrow buttons, so reordering never depends on a pointer.
 */
export function SceneGroupCard({ group, index, total, count, L, disabled, dragging, issue, onPatch, onMove, onDragStart, onDrop, onDragEnd }: {
  group: Group; index: number; total: number; count: number | undefined; L: Str; disabled?: boolean;
  dragging: boolean; issue: string | null;
  onPatch: (index: number, patch: Partial<Group>) => void;
  onMove: (from: number, to: number) => void;
  onDragStart: (index: number) => void; onDrop: (index: number) => void; onDragEnd: () => void;
}) {
  const [advanced, setAdvanced] = React.useState(false);
  const advancedId = `fission-group-advanced-${index}`;
  return <li
    aria-label={`${L('场景组 ','Scene group ')}${group.Name}`}
    draggable={!disabled}
    onDragStart={event => { event.dataTransfer.setData('text/plain', String(index)); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; onDragStart(index); }}
    onDragOver={event => { if (!disabled) event.preventDefault(); }}
    onDrop={event => { event.preventDefault(); onDrop(index); }}
    onDragEnd={onDragEnd}
    className={`rounded border border-[var(--border)] bg-[var(--bg-app)] p-3 ${dragging ? 'opacity-60' : ''} ${group.Enabled ? '' : 'border-dashed'}`}>
    <div className="flex flex-wrap items-center gap-2">
      <span aria-hidden className="cursor-grab select-none text-[var(--text-muted)]">⠿</span>
      <ToggleField ariaLabel={L('启用 ','Use ') + group.Name} name={L('启用','Use')} checked={group.Enabled} disabled={disabled} onChange={checked => onPatch(index, { Enabled: checked })}/>
      <span className="text-sm font-medium">{group.Name}</span>
      <span className={hint}>{count ?? 0} {L('条素材','items')}</span>
      <span className="ml-auto flex items-center gap-1">
        <button type="button" className={smallButton} aria-label={L('上移 ','Move up ') + group.Name} disabled={disabled || index === 0} onClick={() => onMove(index, index - 1)} aria-keyshortcuts="Alt+ArrowUp">↑</button>
        <button type="button" className={smallButton} aria-label={L('下移 ','Move down ') + group.Name} disabled={disabled || index === total - 1} onClick={() => onMove(index, index + 1)} aria-keyshortcuts="Alt+ArrowDown">↓</button>
      </span>
    </div>
    <div className="mt-2 grid gap-2 sm:grid-cols-3">
      <ChoiceField name={L('顺序','Order')} value={group.Rule} disabled={disabled} onChange={value => onPatch(index, { Rule: value as Group['Rule'] })} items={[['Random', L('随机','Random')], ['Sequential', L('顺序','Sequential')]]}/>
      <NumberField name={L('每条抽取','Take per output')} value={group.TakePerOutput} min={0} disabled={disabled} onChange={value => onPatch(index, { TakePerOutput: value })}/>
      <NumberField name={L('变速','Speed')} value={group.Speed} min={0.5} max={4} step="0.1" disabled={disabled} onChange={value => onPatch(index, { Speed: value })}/>
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-4">
      <ToggleField ariaLabel={L('允许复用 ','Allow reuse ') + group.Name} name={L('允许复用','Allow reuse')} checked={group.AllowReuse} disabled={disabled} onChange={checked => onPatch(index, { AllowReuse: checked })}/>
      <button type="button" className={smallButton} aria-expanded={advanced} aria-controls={advancedId} onClick={() => setAdvanced(!advanced)}>{L('高级','Advanced')} · {advanced ? L('收起','Hide') : L('展开','Show')}</button>
    </div>
    <div id={advancedId} hidden={!advanced} className="mt-2 border-t border-[var(--border)] pt-2">
      <ToggleField ariaLabel={L('用过即删 ','Use then delete ') + group.Name} name={L('用过即删（确认后入缓存，后续批次不再选取）','Use then delete (used media joins the cache and later batches skip it)')} checked={group.UseThenDelete} disabled={disabled} onChange={checked => onPatch(index, { UseThenDelete: checked })}/>
    </div>
    {issue && <p role="alert" className="mt-2 text-xs">{issue}</p>}
  </li>;
}
