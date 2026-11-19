// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * One 子合集's materials: the rows that carry this group's name prefix, read page by page.
 *
 * The group is not a filter over the page the list happened to load — that is what left it empty while the index said
 * 23 条. It is one `/list` call per page with `name=` set to `<日期>-<产品>-<分组>` (`group-page.ts`), so the wall is the
 * group's own materials, the covers are those rows' `coverUrl` (the index keeps no cover), and the total under the
 * heading is the supplier's total for that prefix.
 *
 * 加载更多 is one press, one page, appended: it disappears the moment the loaded rows reach the total and a line says
 * 已全部加载 N 条 instead — a button that cannot do anything is not drawn. A group with nothing under its prefix says
 * 该分组暂无素材, and a failed read says its own code, never "已加载 0 条".
 */
import React from 'react';
import {failureCopy, type MaterialCopy} from '@/lib/material-center/copy';
import {groupLoadMore, type GroupPageReader} from '@/lib/material-center/group-page';
import {cloudEntries, type LibraryEntry} from '@/lib/material-center/library';

export type GroupMaterialsProps = {
  readonly copy: MaterialCopy;
  /** `<日期>-<产品>-<分组>`: every material of this group starts with it. */
  readonly prefix: string;
  /** The reader the page owns (one per page, so a second group is a second prefix, not a second reader). */
  readonly page: GroupPageReader;
  /** The one card wall, built by the page, so a group's card has the page's actions (download, select, detail). */
  readonly renderEntries: (entries: readonly LibraryEntry[]) => React.ReactNode;
};

const useGroupPage = (page: GroupPageReader) =>
  React.useSyncExternalStore(page.subscribe, page.getState, page.getState);

export function GroupMaterials({copy, prefix, page, renderEntries}: GroupMaterialsProps) {
  const state = useGroupPage(page);
  /* Opening the group is the mount, not the render: one request for page 1, and none at all for a group already read. */
  React.useEffect(() => {
    void page.open(prefix);
  }, [page, prefix]);
  const entries = React.useMemo(() => cloudEntries(state.cards), [state.cards]);
  const empty = !state.loading && state.failure === null && state.loaded === 0;
  /* The total/loaded line is about rows that exist: before the first page (and after a failed one) it is not drawn, so
     "已加载 0 条" is never what a person reads. */
  const showNote = state.loaded > 0 || (state.total !== null && state.total > 0);

  return <div data-group-page="" data-group-prefix={prefix} className="flex flex-col gap-1">
    {showNote && <p data-note="group-page" data-group-total={state.total ?? ''} data-group-loaded={state.loaded}
      className="text-[11px] text-[var(--text-muted)]">{copy.groupPage(state.total, state.loaded)}</p>}

    {state.loading && state.loaded === 0 && <p role="status" data-state="group-loading" className="text-[12px] text-[var(--text-muted)]">{copy.loading}</p>}

    {state.failure && <p role="alert" data-state="group-failed" data-code={state.failure.code}
      className="flex flex-wrap items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-panel)] px-2 py-1 text-[12px]">
      <span>{failureCopy(copy, state.failure)}</span>
      <span data-code-text={state.failure.code} className="text-[11px] text-[var(--text-muted)]">{state.failure.code}</span>
      <button type="button" data-action="retry-group" onClick={() => void page.retry()}
        className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] hover:bg-[var(--bg-hover)]">{copy.retry}</button>
    </p>}

    {empty && <p role="status" data-state="group-empty" className="text-[12px] text-[var(--text-muted)]">{copy.groupEmpty}</p>}

    {entries.length > 0 && renderEntries(entries)}

    {groupLoadMore(state) && <div className="flex items-center gap-2 pt-1 text-[12px]">
      <button type="button" data-action="load-more" disabled={state.loading} onClick={() => void page.more()}
        className="rounded border border-[var(--border)] px-3 py-1 hover:bg-[var(--bg-hover)] disabled:opacity-40">
        {state.loading ? copy.loading : copy.groupLoadMore}
      </button>
    </div>}

    {state.prefix !== null && state.failure === null && state.loaded > 0 && state.exhausted
      && <p role="status" data-note="group-all" className="text-[11px] text-[var(--text-muted)]">{copy.groupLoadedAll(state.loaded)}</p>}
  </div>;
}
