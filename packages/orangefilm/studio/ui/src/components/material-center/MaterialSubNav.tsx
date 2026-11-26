// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 云管家 tab 的左侧子导航：一个可折叠的「素材库」组，组内是 全部 / 合集 / 产品。
 * 只决定看哪一个视图（viewMode），不持数据；选中项由 `aria-pressed` 与 accent 色标出。
 */
import React from 'react';
import { ChevronDown } from 'lucide-react';
import type { MaterialCopy } from '@/lib/material-center/copy';
import type { MaterialViewMode } from '@/lib/material-center/view-pref';

export type MaterialSubNavProps = {
  readonly copy: MaterialCopy;
  readonly active: MaterialViewMode;
  readonly onChange: (mode: MaterialViewMode) => void;
};

const ITEM = 'truncate whitespace-nowrap rounded-md px-2.5 py-1.5 text-left text-[12px] ';
const ON = 'font-semibold text-[var(--accent)]';
const OFF = 'font-medium text-[var(--text)] hover:text-[var(--accent)]';

export function MaterialSubNav({ copy, active, onChange }: MaterialSubNavProps) {
  const [open, setOpen] = React.useState(true);
  return <nav data-material-subnav="" aria-label={copy.subNavTitle} className="flex w-[168px] shrink-0 flex-col gap-0.5 border-r border-[var(--border)] pr-2">
    <button type="button" aria-expanded={open} title={copy.subNavTitle}
      onClick={() => setOpen(value => !value)}
      className="flex h-8 shrink-0 items-center justify-between gap-1 rounded-md bg-[var(--bg-field)] px-2.5 text-left text-[12px] font-semibold hover:bg-[var(--bg-pressed)] text-[var(--accent)]">
      <span className="truncate whitespace-nowrap">{copy.subNavTitle}</span>
      <ChevronDown size={13} className={'shrink-0 transition-transform ' + (open ? 'rotate-180' : '')} />
    </button>
    {open && <div className="flex flex-col pb-1">
      {([['videos', copy.subNavAll], ['collections', copy.subNavCollections], ['products', copy.subNavProducts]] as const).map(([mode, label]) => (
        <button key={mode} type="button" aria-pressed={active === mode} title={label}
          onClick={() => onChange(mode)} className={ITEM + (active === mode ? ON : OFF)}>{label}</button>
      ))}
    </div>}
  </nav>;
}
