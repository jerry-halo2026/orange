// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import React from 'react';
import type {WikiCache, WikiFailureKind, VideoWiki} from '@/lib/material-center/wiki';
import {wikiFailureCopy, type WikiCopy} from '@/lib/material-center/wiki-copy';

export type WikiPanelProps = {
  readonly cache: WikiCache;
  readonly videoId: string;
  readonly copy: WikiCopy;
  /** "Use this clip": the page's existing use action, aimed at the best clip's window. */
  readonly onUseClip?: (clip: {readonly startMs: number; readonly endMs: number}) => void;
  readonly onClose?: () => void;
};

type Load = {state: 'loading'} | {state: 'ok'; wiki: VideoWiki} | {state: 'error'; kind: WikiFailureKind};

const time = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
};

/**
 * One material's wiki, opened on demand: the panel asks the cache when it mounts (first open = one request, a second
 * open is the session's memory) and says nothing about a service that is not wired beyond its own sentence.
 */
export function WikiPanel({cache, videoId, copy, onUseClip, onClose}: WikiPanelProps) {
  const [load, setLoad] = React.useState<Load>(() => {
    const known = cache.peekVideo(videoId);
    return known ? {state: 'ok', wiki: known} : {state: 'loading'};
  });
  React.useEffect(() => {
    let live = true;
    setLoad(previous => previous.state === 'ok' ? previous : {state: 'loading'});
    void cache.video(videoId).then(wiki => { if (live) setLoad({state: 'ok', wiki}); }, (error: {kind?: WikiFailureKind}) => {
      if (live) setLoad({state: 'error', kind: error?.kind ?? 'failed'});
    });
    return () => { live = false; };
  }, [cache, videoId]);
  if (load.state === 'loading') return <section data-wiki="panel" data-state="loading" className="rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-3 text-[12px]">{copy.loading}</section>;
  if (load.state === 'error') return <section data-wiki="panel" data-state="error" data-failure={load.kind} className="rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-3 text-[12px]" role="alert">{wikiFailureCopy(copy, load.kind)}{load.kind === 'not-connected' && onClose && <button type="button" data-action="close-wiki" onClick={onClose} className="ml-2 underline">{copy.close}</button>}</section>;
  const wiki = load.wiki;
  return <section data-wiki="panel" data-state="ok" data-status={wiki.status} className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-3 text-[12px]">
    <header className="flex flex-wrap items-center gap-2">
      <span data-wiki-badge="production" data-production={wiki.production} className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5">{copy.production[wiki.production]}</span>
      <span data-wiki-badge="status" data-status={wiki.status} className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5">{copy.status[wiki.status]}</span>
      <span data-wiki-confidence className="text-[var(--text-muted)]">{copy.confidence} {Math.round(wiki.confidence * 100)}%</span>
      {onClose && <button type="button" data-action="close-wiki" onClick={onClose} className="ml-auto rounded border border-[var(--border)] px-2 py-0.5 text-[11px] hover:bg-[var(--bg-hover)]">{copy.close}</button>}
    </header>
    <p data-wiki-line>{copy.oneLine}：{wiki.oneLine}</p>
    {wiki.scenes.length > 0 && <div data-wiki-scenes>
      <h4 className="mb-1 text-[11px] text-[var(--text-muted)]">{copy.scenes}</h4>
      <ol className="flex flex-col gap-0.5">
        {wiki.scenes.map((scene, index) => <li key={index} data-scene={index} className="flex gap-2"><span className="tabular-nums text-[var(--text-muted)]">{time(scene.startMs)}–{time(scene.endMs)}</span><span>{scene.desc}</span>{scene.shotSize && <span className="text-[var(--text-muted)]">{scene.shotSize}</span>}</li>)}
      </ol>
    </div>}
    {wiki.bestClip && <div data-wiki-best className="flex flex-wrap items-center gap-2">
      <span>{copy.bestClip}：{time(wiki.bestClip.startMs)}–{time(wiki.bestClip.endMs)} · {wiki.bestClip.why}</span>
      {onUseClip && <button type="button" data-action="use-best-clip" onClick={() => onUseClip({startMs: wiki.bestClip!.startMs, endMs: wiki.bestClip!.endMs})} className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] hover:bg-[var(--bg-hover)]">{copy.useClip}</button>}
    </div>}
    {Object.entries(wiki.tags).some(([, values]) => (values ?? []).length > 0) && <div data-wiki-tags className="flex flex-wrap gap-1">
      <span className="text-[var(--text-muted)]">{copy.tags}：</span>
      {Object.values(wiki.tags).flatMap(values => values ?? []).map((tag, index) => <span key={index} className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5">{tag}</span>)}
    </div>}
    {wiki.risks.length > 0 && <div data-wiki-risks className="flex flex-wrap gap-1">
      <span className="text-[var(--text-muted)]">{copy.risks}：</span>
      {wiki.risks.map((risk, index) => <span key={index} data-risk={risk} className="rounded border border-[var(--border)] px-1.5 py-0.5">{risk}</span>)}
    </div>}
  </section>;
}
