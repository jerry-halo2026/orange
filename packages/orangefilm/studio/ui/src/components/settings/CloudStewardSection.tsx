// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Settings → 云管家: the one place the cloud-steward account is claimed or released.
 *
 * It is a setting, not a banner over the material list: the account belongs to this Studio, and the tab that shows the
 * material keeps only its search and its filters. The store is the one the library reads (`sharedBindingStore`), so a
 * claim here is visible there at once — and a release forces "my materials" back to the company view.
 */
import React from 'react';
import { useLanguage } from '@/i18n';
import { copyFor } from '@/lib/material-center/copy';
import {
  bindingFailureCopy, bindingReadCopy, normalizeBindingAccount, sharedBindingStore, type MaterialBindingClient,
} from '@/lib/material-center/binding';

export type CloudStewardSectionProps = {
  /** Injected by a test; defaults to the one binding store this window shares with the material library. */
  readonly bindingClient?: MaterialBindingClient;
};

const button = 'rounded border border-[var(--border)] px-2 py-1 text-[12.5px] transition hover:bg-[var(--bg-hover)] disabled:opacity-40';
const field = 'min-w-[240px] rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1 text-[12.5px]';

export function CloudStewardSection({ bindingClient }: CloudStewardSectionProps) {
  const language = useLanguage();
  const copy = React.useMemo(() => copyFor(language), [language]);
  const store = React.useMemo(() => sharedBindingStore(bindingClient), [bindingClient]);
  const binding = React.useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [account, setAccount] = React.useState('');
  const [invalid, setInvalid] = React.useState(false);
  /* The claim is read once here as it is read once in the library; one store answers both. */
  React.useEffect(() => { void store.read(); }, [store]);

  const claim = (event: React.FormEvent) => {
    event.preventDefault();
    const clean = normalizeBindingAccount(account);
    if (!clean) { setInvalid(true); return; }
    setInvalid(false);
    void store.claim(clean).then(claimed => { if (claimed) setAccount(''); });
  };

  return <section data-section="cloud-steward" className="flex flex-col gap-3 text-[13px]">
    {!binding.known && <p role="status" data-state="binding-loading" className="text-[var(--text-muted)]">{copy.loading}</p>}
    {binding.known && binding.loadFailure && <p role="status" data-note="binding-read" className="text-[var(--text-muted)]">{bindingReadCopy(copy, binding.loadFailure)}</p>}

    {binding.known && !binding.value && <div data-note="binding" className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-3">
      <p className="text-[var(--text-muted)]">{copy.bindingUnbound}</p>
      <form data-dialog="binding" onSubmit={claim} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">{copy.bindingAccountLabel}
          <input data-field="binding-account" value={account} maxLength={200} placeholder={copy.bindingAccountHint}
            onChange={event => setAccount(event.target.value)} className={field} />
        </label>
        <button type="submit" data-action="binding-submit" disabled={binding.busy} className={button}>{binding.busy ? copy.bindingRequesting : copy.bindingSubmit}</button>
        <button type="button" data-action="binding-cancel" onClick={() => { setAccount(''); setInvalid(false); }} className={button}>{copy.bindingCancel}</button>
        {invalid && <span role="alert" data-note="binding-invalid" className="text-[11px] text-[var(--text-muted)]">{copy.bindingInvalidAccount}</span>}
        {binding.actionFailure && <span role="alert" data-note="binding-error" className="text-[11px] text-[var(--text-muted)]">{bindingFailureCopy(copy, binding.actionFailure)}</span>}
      </form>
    </div>}

    {binding.value && <p data-note="binding-claimed" className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-3">
      <span>{copy.bindingClaimed(binding.value.account)}</span>
      <button type="button" data-action="unbind" disabled={binding.busy} onClick={() => void store.release()} className={button}>{binding.busy ? copy.bindingReleasing : copy.bindingRelease}</button>
      {binding.actionFailure && <span role="alert" data-note="binding-error" className="text-[11px] text-[var(--text-muted)]">{bindingFailureCopy(copy, binding.actionFailure)}</span>}
    </p>}
  </section>;
}
