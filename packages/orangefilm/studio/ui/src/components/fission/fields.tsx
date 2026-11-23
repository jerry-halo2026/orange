// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import React from 'react';

/** `L(zh, en)` as the workbench already passes it around. */
export type Str = (cn: string, en: string) => string;

export const input = 'w-full rounded border border-[var(--border)] bg-[var(--bg-app)] px-2 py-1.5 text-sm';
export const button = 'rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50';
export const smallButton = 'rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50';
export const panel = 'rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-4';
export const label = 'flex min-w-0 flex-col gap-1 text-xs text-[var(--text-muted)]';
export const hint = 'text-xs text-[var(--text-muted)]';

export function NumberField({ name, value, min, max, step = '1', onChange, disabled, ariaInvalid }: {
  name: string; value: number; min?: number; max?: number; step?: string;
  onChange: (value: number) => void; disabled?: boolean; ariaInvalid?: boolean;
}) {
  return <label className={label}>{name}<input className={input} type="number" min={min} max={max} step={step} value={value} disabled={disabled} aria-invalid={ariaInvalid || undefined} onChange={event => onChange(Number(event.target.value))}/></label>;
}

export function EmptyNumberField({ name, value, min, step = '0.1', onChange, disabled }: {
  name: string; value: number | null; min?: number; step?: string;
  onChange: (value: number | null) => void; disabled?: boolean;
}) {
  return <label className={label}>{name}<input className={input} type="number" min={min} step={step} value={value ?? ''} disabled={disabled} onChange={event => onChange(event.target.value ? Number(event.target.value) : null)}/></label>;
}

export function ChoiceField({ name, value, items, onChange, disabled }: {
  name: string; value: string; items: [string, string][];
  onChange: (value: string) => void; disabled?: boolean;
}) {
  return <label className={label}>{name}<select className={input} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{items.map(([option, text]) => <option key={option} value={option}>{text}</option>)}</select></label>;
}

export function ToggleField({ name, checked, onChange, disabled, ariaLabel }: {
  name: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; ariaLabel?: string;
}) {
  return <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={ariaLabel} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)}/>{name}</label>;
}

/** A field error stays next to its field instead of collecting at the bottom of the page. */
export function FieldErrors({ id, items }: { id: string; items: string[] }) {
  if (!items.length) return null;
  return <ul id={id} role="alert" className="mt-2 space-y-1 text-xs text-[var(--text)]">{items.map(item => <li key={item}>{item}</li>)}</ul>;
}

/** A collapsible block: closed by default, its button carries `aria-expanded` for screen readers. */
export function Disclosure({ id, title, note, open, onToggle, children, L }: {
  id: string; title: string; note?: string; open: boolean; onToggle: (open: boolean) => void; children: React.ReactNode; L: Str;
}) {
  return <div className="mt-3 rounded border border-[var(--border)]">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => onToggle(!open)} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-[var(--bg-hover)]">
      <span>{title}{note ? <span className={hint}> · {note}</span> : null}</span>
      <span aria-hidden className="text-[var(--text-muted)]">{open ? L('收起','Hide') : L('展开','Show')}</span>
    </button>
    <div id={id} hidden={!open} className="border-t border-[var(--border)] p-3">{children}</div>
  </div>;
}
