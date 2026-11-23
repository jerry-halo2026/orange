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
import { useT } from '@/i18n';
import { sharedBindingStore, type MaterialBindingClient } from '@/lib/material-center/binding';

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

export function CloudMaterialsTab({ authGeneration, bindingClient, renderLibrary }: CloudMaterialsTabProps) {
  const t = useT();
  const store = React.useMemo(() => sharedBindingStore(bindingClient), [bindingClient]);
  const binding = React.useSyncExternalStore(store.subscribe, store.getState, store.getState);
  /* One read per session (and per new session): the claim is never asked for from a render. */
  React.useEffect(() => {
    void store.read();
  }, [store, authGeneration]);

  if (!binding.known) {
    return <p role="status" data-state="binding-loading" className="px-3 py-2 text-[12px] text-[var(--text-muted)]">{t('materials.binding.loading')}</p>;
  }

  /* 云管家标签只放素材库：绑定提示已移入「设置 → 通用」，这里不再占位。 */
  return <section data-state={binding.value ? 'bound' : 'unbound'} aria-label={t('materials.binding.boundTitle')} className="flex min-h-0 flex-1 flex-col gap-2 p-2">
    <div data-cloud-library="" className="min-h-0 flex-1 overflow-y-auto">{renderLibrary()}</div>
  </section>;
}
