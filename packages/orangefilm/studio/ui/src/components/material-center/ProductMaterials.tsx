// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * A product's (or one of its labels') materials, read by `videoIds`: the supplier's `/list` takes a comma list, so a
 * product folder opens its own rows instead of guessing a name prefix. Cards come back as the page's own entries, so
 * the download / use / detail / drag actions are the page's, not a second implementation.
 */
import React from 'react';
import { cloudEntries, type LibraryEntry } from '@/lib/material-center/library';
import type { MaterialCopy } from '@/lib/material-center/copy';
import type { ScopeChoice, VideoType } from '@/lib/material-center/contract';
import { loadProductCards, type MaterialList } from '@/lib/material-center/product-materials';

export type ProductMaterialsProps = {
  readonly copy: MaterialCopy;
  readonly videoIds: readonly string[];
  readonly renderEntries: (entries: readonly LibraryEntry[]) => React.ReactNode;
  readonly list: MaterialList;
  readonly entries?: readonly import('@/lib/material-center/index-tree').IndexMaterialEntry[];
  readonly videoType?: VideoType;
  readonly scope?: ScopeChoice;
};

export function ProductMaterials({ copy, videoIds, renderEntries, list, entries, videoType = 1, scope = 'company' }: ProductMaterialsProps) {
  const [materialEntries, setEntries] = React.useState<readonly LibraryEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const wanted = React.useMemo(() => [...new Set(videoIds)], [videoIds]);
  /* The parent hands these as new arrays/functions on every render; depending on that identity re-ran this effect on
     every render (clear the wall, refetch, re-render: the view blinked forever). The read is keyed on what actually
     names it — the ids — and the rest is read from a ref at call time. */
  const wantedKey = wanted.join(',');
  const latest = React.useRef({ list, entries, wanted });
  latest.current = { list, entries, wanted };

  React.useEffect(() => {
    let alive = true;
    const now = latest.current;
    setEntries([]);
    setFailure(null);
    if (!now.wanted.length) return () => { alive = false; };
    setLoading(true);
    void loadProductCards(now.list, now.wanted, { videoType: now.entries?.length ? videoType : undefined, scope, entries: now.entries }).then(
      cards => { if (alive) setEntries(cloudEntries(cards)); },
      error => { if (alive) setFailure(error instanceof Error ? error.message : String(error)); },
    ).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [wantedKey, videoType, scope]);

  if (loading && !materialEntries.length) return <p role="status" className="text-[12px] text-[var(--text-muted)]">{copy.loading}</p>;
  if (failure) return <p role="alert" className="text-[12px] text-[var(--text-muted)]">{failure}</p>;
  if (!materialEntries.length) return <p role="status" className="text-[12px] text-[var(--text-muted)]">{copy.groupEmpty}</p>;
  return <div data-product-materials={wanted.length} className="flex flex-col gap-2">
    <p data-note="product-materials" className="text-[11px] text-[var(--text-muted)]">{copy.groupPage(materialEntries.length, materialEntries.length)}</p>
    {renderEntries(materialEntries)}
  </div>;
}
