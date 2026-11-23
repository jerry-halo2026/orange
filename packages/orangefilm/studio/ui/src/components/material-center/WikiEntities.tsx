// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import React from 'react';
import {groupEntities, type Arbitration, type WikiCache, type WikiEntity, type WikiFailureKind} from '@/lib/material-center/wiki';
import {wikiFailureCopy, type WikiCopy} from '@/lib/material-center/wiki-copy';

export type WikiEntitiesProps = {
  readonly cache: WikiCache;
  readonly copy: WikiCopy;
  /** A source is a material: opening it goes back to the list focused on that video. */
  readonly onOpenMaterial?: (videoId: string) => void;
};

type Load = {state: 'loading'} | {state: 'ok'; entities: readonly WikiEntity[]} | {state: 'error'; kind: WikiFailureKind};

/**
 * Entity pages, grouped by kind (products, people, hooks, selling points…), with a detail view that shows the body, the
 * source material, and — when the entity is disputed — the three decisions a person can make.
 */
export function WikiEntities({cache, copy, onOpenMaterial}: WikiEntitiesProps) {
  const [load, setLoad] = React.useState<Load>(() => {
    const known = cache.peekEntities();
    return known ? {state: 'ok', entities: known} : {state: 'loading'};
  });
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [arbitrating, setArbitrating] = React.useState<string | null>(null);
  const [lately, setLately] = React.useState<WikiEntity | null>(null);
  React.useEffect(() => {
    let live = true;
    void cache.entities().then(entities => { if (live) setLoad({state: 'ok', entities}); }, (error: {kind?: WikiFailureKind}) => {
      if (live) setLoad({state: 'error', kind: error?.kind ?? 'failed'});
    });
    return () => { live = false; };
  }, [cache]);
  const replace = (entity: WikiEntity) => {
    setLately(entity);
    setLoad(previous => (previous.state === 'ok'
      ? {state: 'ok', entities: previous.entities.map(row => (row.entityId === entity.entityId ? entity : row))}
      : previous));
  };
  const arbitrate = (entity: WikiEntity, choice: Arbitration) => {
    if (arbitrating) return;
    setArbitrating(entity.entityId);
    void cache.arbitrate(entity.entityId, choice).then(entity2 => {
      setArbitrating(null);
      replace(entity2);
    }, () => { setArbitrating(null); });
  };

  if (load.state === 'loading') return <section data-wiki="entities" data-state="loading" className="text-[12px]">{copy.loading}</section>;
  if (load.state === 'error') return <section data-wiki="entities" data-state="error" data-failure={load.kind} role="alert" className="text-[12px]">{wikiFailureCopy(copy, load.kind)}</section>;
  if (load.entities.length === 0) return <section data-wiki="entities" data-state="empty" className="text-[12px] text-[var(--text-muted)]">{copy.entitiesEmpty}</section>;

  const open = load.entities.find(entity => entity.entityId === openId) ?? null;
  if (open) {
    const current = lately && lately.entityId === open.entityId ? lately : open;
    return <section data-wiki="entity" data-kind={current.kind} className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-3 text-[12px]">
      <header className="flex flex-wrap items-center gap-2">
        <button type="button" data-action="wiki-entity-back" onClick={() => setOpenId(null)} className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] hover:bg-[var(--bg-hover)]">{copy.back}</button>
        <strong>{current.title}</strong>
        <span className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5">{copy.kinds[current.kind]}</span>
        <span data-entity-status={current.status} className="text-[var(--text-muted)]">{copy.status[current.status === 'active' ? 'trusted' : current.status === 'retired' ? 'candidate' : 'disputed']}</span>
      </header>
      <div data-entity-body className="whitespace-pre-wrap">{current.bodyMd}</div>
      {current.sources.length > 0 && <div data-entity-sources className="flex flex-wrap gap-1">
        <span className="text-[var(--text-muted)]">{copy.sources}：</span>
        {current.sources.map(source => <button key={source} type="button" data-source={source} onClick={() => onOpenMaterial?.(source)} className="underline">{source}</button>)}
      </div>}
      {current.status === 'disputed' && <div data-entity-disputed className="flex flex-wrap items-center gap-2 rounded border border-[var(--border)] p-2">
        <span>{copy.disputed}</span>
        <button type="button" data-action="arbitrate-a" disabled={arbitrating !== null} onClick={() => arbitrate(current, 'a')} className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] disabled:opacity-40">{copy.adoptA}</button>
        <button type="button" data-action="arbitrate-b" disabled={arbitrating !== null} onClick={() => arbitrate(current, 'b')} className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] disabled:opacity-40">{copy.adoptB}</button>
        <button type="button" data-action="arbitrate-keep" disabled={arbitrating !== null} onClick={() => arbitrate(current, 'keep')} className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] disabled:opacity-40">{copy.keepConflict}</button>
        {arbitrating === current.entityId && <span className="text-[var(--text-muted)]">{copy.arbitrating}</span>}
      </div>}
    </section>;
  }

  return <section data-wiki="entities" data-state="ok" className="flex flex-col gap-2 text-[12px]">
    {groupEntities(load.entities).map(group => <div key={group.kind} data-entity-group={group.kind}>
      <h4 className="mb-1 text-[11px] text-[var(--text-muted)]">{copy.kinds[group.kind]}</h4>
      <ul className="flex flex-col gap-1">
        {group.entities.map(entity => <li key={entity.entityId}>
          <button type="button" data-entity={entity.entityId} onClick={() => setOpenId(entity.entityId)} className="flex w-full items-center gap-2 rounded border border-[var(--border)] px-2 py-1 text-left hover:bg-[var(--bg-hover)]">
            <span className="flex-1">{entity.title}</span>
            {entity.status === 'disputed' && <span data-entity-disputed-mark className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5">{copy.disputed}</span>}
            <span className="text-[var(--text-muted)]">{Math.round(entity.confidence * 100)}%</span>
          </button>
        </li>)}
      </ul>
    </div>)}
  </section>;
}
