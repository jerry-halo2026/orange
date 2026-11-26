// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/* The CLI row in Settings → Diagnostics (macOS): the app writes the `orangefilm` shim but nothing puts its folder on
   PATH, so a terminal says "command not found". One button points a symlink at it from a folder a terminal already
   searches (cli-install.mjs); a folder that needs an administrator is never offered. */
import React from 'react';
import { studioHost } from '@/lib/host';
import { useT } from '@/i18n';

type Status = Awaited<ReturnType<NonNullable<NonNullable<typeof studioHost>['cli']>['status']>>;

export function CliToolRow() {
  const t = useT();
  const [status, setStatus] = React.useState<Status | undefined>(undefined);
  const [saying, setSaying] = React.useState<string | null>(null);
  const cli = studioHost?.cli;
  const read = React.useCallback(() => {
    if (!cli) return;
    void cli.status().then((next) => setStatus(next ?? null), () => setStatus(null));
  }, [cli]);
  React.useEffect(() => { read(); }, [read]);
  if (!cli) return null;
  const onPath = Boolean(status?.onPath);
  const install = () => {
    setSaying(t('settings.cli.installing'));
    void cli.install().then((result) => {
      setSaying(result?.ok
        ? t('settings.cli.installed').replace('{path}', result.path ?? '')
        : t('settings.cli.failed').replace('{code}', result?.code ?? ''));
      read();
    }, () => setSaying(t('settings.cli.failed').replace('{code}', 'ipc')));
  };
  return <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
    <span className="min-w-0">
      <span className="font-medium">{t('settings.cli.title')}</span>
      <span className="ml-2 text-[var(--text-muted)]">
        {onPath ? t('settings.cli.onPath').replace('{path}', status?.onPath ?? '') : t('settings.cli.notOnPath')}
      </span>
      {saying ? <span className="ml-2 text-[var(--text-muted)]">{saying}</span> : null}
    </span>
    {onPath ? null : <button type="button" className="h-7 shrink-0 rounded-[8px] border border-[var(--border)] px-2" onClick={install}>
      {t('settings.cli.install')}
    </button>}
  </div>;
}
