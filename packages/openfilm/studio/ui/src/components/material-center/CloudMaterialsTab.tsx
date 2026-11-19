// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The cloud-steward tab: the third tab of the material pane, beside 导入 and 收藏 — a tab of the pane, never a panel
 * floating over it.
 *
 * The tab is now only the library: its search and filters, its two views (videos / 合集), its cards and its one
 * download handler. What it does not own any more is the claim: the cloud-steward account is claimed and released in
 * **Settings → 云管家**, which is where a setting belongs, and the tab's top keeps nothing but the search and the
 * filters. Until an account is claimed the material area is a guide card that leads there — the cloud list is not read
 * at all before a claim, as before.
 */
import React from 'react';
import { useLanguage, useT } from '@/i18n';
import { copyFor } from '@/lib/material-center/copy';
import { bindingReadCopy, sharedBindingStore, type MaterialBindingClient } from '@/lib/material-center/binding';

export type CloudMaterialsTabProps = {
  /** A new session is a new claim: read it again. */
  readonly authGeneration?: number;
  /** Injected by a test; defaults to the one binding store this window shares with Settings. */
  readonly bindingClient?: MaterialBindingClient;
  /** Opens Settings on 云管家: the guide card's one action. */
  readonly onOpenSettings?: () => void;
  /** The host's one library, with its search, its filters and its two views. */
  readonly renderLibrary: () => React.ReactNode;
};

export function CloudMaterialsTab({ authGeneration, bindingClient, onOpenSettings, renderLibrary }: CloudMaterialsTabProps) {
  const t = useT();
  const language = useLanguage();
  const copy = React.useMemo(() => copyFor(language), [language]);
  const store = React.useMemo(() => sharedBindingStore(bindingClient), [bindingClient]);
  const binding = React.useSyncExternalStore(store.subscribe, store.getState, store.getState);
  /* One read per session (and per new session): the claim is never asked for from a render. */
  React.useEffect(() => {
    void store.read();
  }, [store, authGeneration]);

  if (!binding.known) {
    return <p role="status" data-state="binding-loading" className="px-3 py-2 text-[12px] text-[var(--text-muted)]">{t('materials.binding.loading')}</p>;
  }

  /* Unbound: the guide card alone — it leads to Settings, where the account is claimed. */
  if (!binding.value) {
    return <section data-state="unbound" aria-label={t('materials.binding.title')} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div data-card="binding-guide" className="rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-3">
        <h3 className="text-[13px] font-semibold">{t('materials.binding.title')}</h3>
        <p className="mt-1 text-[12px] text-[var(--text-muted)]">{t('materials.binding.unboundBody')}</p>
        {binding.loadFailure && <p role="status" data-note="binding-read" className="mt-1 text-[12px] text-[var(--text-muted)]">{bindingReadCopy(copy, binding.loadFailure)}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" data-action="open-settings" onClick={() => onOpenSettings?.()} className="rounded border border-[var(--border)] px-2 py-1 text-[12px] hover:bg-[var(--bg-hover)]">{t('materials.binding.openSettings')}</button>
          <span data-note="binding-where" className="text-[11px] text-[var(--text-muted)]">{t('materials.binding.where')}</span>
        </div>
      </div>
    </section>;
  }

  /* Bound: the one library, with its search, its filters and its two views. */
  return <section data-state="bound" aria-label={t('materials.binding.boundTitle')} className="flex min-h-0 flex-1 flex-col gap-2 p-2">
    <div data-cloud-library="" className="min-h-0 flex-1 overflow-y-auto">{renderLibrary()}</div>
  </section>;
}
