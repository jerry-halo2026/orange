// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import type { Str } from './fields';
import type { StepId, StepState } from './wizard';

export type StepMeta = { id: StepId; title: string; state: StepState };

const stateWord = (state: StepState, L: Str) => state === 'ok' ? L('已完成','Ready')
  : state === 'locked' ? L('先完成上一步','After the step before') : L('待补全','Incomplete');

/**
 * The three-step rail. A step that is done or open is reachable at any time — clicking it goes back to it, with the
 * keyboard, and its number, title and state are read by screen readers. A step that waits for the one before it stays
 * a button on purpose: it can be pressed, and it answers why it will not move (a dead control that says nothing is
 * what this rail replaces).
 */
export function StepNav({ steps, current, onSelect, L }: {
  steps: StepMeta[]; current: StepId; onSelect: (step: StepId) => void; L: Str;
}) {
  return <nav aria-label={L('混剪步骤','Batch steps')} className="flex flex-wrap items-center gap-2">
    {steps.map((step, index) => {
      const selected = step.id === current;
      const locked = step.state === 'locked';
      return <button key={step.id} type="button" data-step={step.id} data-step-state={step.state} aria-current={selected ? 'step' : undefined}
        aria-disabled={locked || undefined} onClick={() => onSelect(step.id)}
        className={`flex items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1 text-sm ${selected ? 'border-[var(--text)] font-semibold' : 'border-[var(--border)] hover:bg-[var(--bg-hover)]'} ${locked ? 'text-[var(--text-muted)]' : ''}`}>
        <span aria-hidden className="flex h-5 w-5 items-center justify-center rounded-full border border-current text-xs">{index + 1}</span>
        <span>{step.title}</span>
        <span className="text-xs text-[var(--text-muted)]">{stateWord(step.state, L)}</span>
      </button>;
    })}
  </nav>;
}
