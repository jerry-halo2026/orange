// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** Original native home and project presentation; project instances remain mounted across Home. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { listen, studioConnection } from './api';
import { useT } from './i18n';
import { ProjectView } from './components/ProjectView';
import { Launcher } from './components/Launcher';
import { StandaloneWorkspace } from './components/StandaloneWorkspace';
import { useMaterialDraft } from './lib/use-material-draft';
import { studioHost } from './lib/host';
import { WhatsNew } from './components/WhatsNew';
import { sourcesApi } from './lib/project-sources';
import { homePresentation, homeEntryForProject, type HomeEntryRequest } from './lib/projects-page';

/**
 * `to` with this page's key in its address (the server puts it there): the address bar is what a person copies, and
 * with the key a copied address opens Studio in any browser on this machine, or in an agent's preview.
 */
const keepKey = (to: string) => {
  const key = new URLSearchParams(location.search).get('key');
  if (!key) return to;
  const at = new URL(to, location.origin);
  at.searchParams.set('key', key);
  return at.pathname + at.search;
};

const projectIn = (path: string) => /^\/projects\/([\w-]+)/.exec(path)?.[1] ?? null;
/** the app's tabs, when Studio is a tab of an app's window */
const tabs = studioHost?.tabs ?? null;

export function App({authGeneration}:{authGeneration?:number} = {}) {
  const [path, setPath] = useState(location.pathname);
  const [keptProject, setKeptProject] = useState<string | null>(() => projectIn(location.pathname));
  const [homeOpen, setHomeOpen] = useState(!projectIn(location.pathname));
  const [workspace, setWorkspace] = useState<'fission'|'catalog'|null>(null);
  const materialDraft = useMaterialDraft(authGeneration);
  const [entryRequest, setEntryRequest] = useState<HomeEntryRequest | null>(null);
  const go = (to: string, replace = false) => {
    setWorkspace(null);
    if (to !== location.pathname) (replace ? history.replaceState : history.pushState).call(history, null, '', keepKey(to));
    setPath(to);
    setEntryRequest(null);
    const next = projectIn(to); if(next)setKeptProject(next);setHomeOpen(!next);
  };

  /* the examples and skills, read as Studio opens: a gallery opened later shows them at once */
  useEffect(() => { sourcesApi.preload(); }, []);

  useEffect(() => {
    const onPop = () => {setWorkspace(null);setEntryRequest(null);const next=projectIn(location.pathname);setPath(location.pathname);if(next)setKeptProject(next);setHomeOpen(!next);};
    window.addEventListener('popstate', onPop);
    /* `orangefilm open` while this page is open: show the project it opened (with tabs, the app says which tab does) */
    const stop = listen('events', (event) => {
      if (event.type !== 'open') return;
      setHomeOpen(false);
      if (tabs) tabs.openRequest(event.to); else go(event.to);
    }, { watch: true });
    return () => { window.removeEventListener('popstate', onPop); stop(); };
  }, []);

  /** Original project/tab actions: no home sentinel or cross-tab tool command. */
  const open = (projectId: string) => { if(!projectId)return;setEntryRequest(null);setHomeOpen(false);if(tabs)tabs.open(projectId);else go('/projects/'+projectId); };
  const leave = () => { if(tabs)tabs.report({gone:true});else{setKeptProject(null);go('/',true);} };
  const id=keptProject;
  const presentation=homePresentation(id,homeOpen || !projectIn(path));
  const resume=()=>{if(id){setWorkspace(null);setHomeOpen(false);if(!projectIn(path))go('/projects/'+id);}};
 const enter=(entry:'fission'|'catalog')=>{setHomeOpen(true);setWorkspace(entry);};
  
  return <>
    {presentation.mounted && <div hidden={!presentation.foreground} inert={!presentation.foreground} aria-hidden={!presentation.foreground}>
      <ProjectView key={id!} projectId={id!} onProject={open} onLeave={leave} foreground={presentation.foreground} onResume={resume} onHome={()=>go('/')} homeEntry={homeEntryForProject(id,entryRequest)}
        authGeneration={authGeneration} batchDraft={materialDraft.items} batchDraftReady={materialDraft.ready} batchDraftReason={materialDraft.reason}
        onBatchDraftOperation={materialDraft.change} onBatchDraftRetry={materialDraft.retry} onOpenFission={()=>{setHomeOpen(true);setWorkspace('fission');}} />
    </div>}
    {presentation.home && !workspace && <Launcher onOpen={open} onCurrentRemoved={leave} currentProjectId={id ?? ''} onResume={id?resume:undefined} onEntry={enter} />}
    <div hidden={!(presentation.home && workspace==='fission')} inert={!(presentation.home && workspace==='fission')}>
      <StandaloneWorkspace active={presentation.home && workspace==='fission'} authGeneration={authGeneration} kind="fission" onHome={()=>setWorkspace(null)} onResume={id?resume:undefined} onMaterials={()=>setWorkspace('catalog')} onFission={()=>setWorkspace('fission')} onOpenProject={(projectId)=>{setWorkspace(null);open(projectId);}} draft={materialDraft.items} draftReady={materialDraft.ready} draftReason={materialDraft.reason} onDraftOperation={materialDraft.change} onDraftRetry={materialDraft.retry}/>
    </div>
    {presentation.home && workspace==='catalog' && <StandaloneWorkspace authGeneration={authGeneration} kind="materials" onHome={()=>setWorkspace(null)} onResume={id?resume:undefined} onMaterials={()=>setWorkspace('catalog')} onFission={()=>setWorkspace('fission')} onOpenProject={open} draft={materialDraft.items} draftReady={materialDraft.ready} draftReason={materialDraft.reason} onDraftOperation={materialDraft.change} onDraftRetry={materialDraft.retry}/>}
    <ConnectionNotice /><WhatsNew />
  </>;
}

/**
 * Studio answers, but not this browser: it was opened at Studio's address without the key (pasted, typed, an agent's
 * browser given the bare address). Nothing to wait for: the page is covered and says which address lets it in.
 */
function LockedNotice() {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const COMMAND = 'orangefilm open';
  return (
    <div role="alert" className="fixed inset-0 z-[10050] flex items-center justify-center bg-[var(--bg-app)] p-6">
      <div className="w-full max-w-[460px] rounded-2xl border border-[var(--border)] bg-[var(--bg-raised)] p-6 shadow-[var(--shadow-lg)]">
        <p className="text-[16px] font-semibold text-[var(--text)]">{t('connection.lockedTitle')}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">{t('connection.lockedBody')}</p>
        <p className="mt-3 rounded-lg bg-[var(--bg-field)] px-3 py-2 font-mono text-[12px] text-[var(--text-muted)]">{`${location.origin}/open?key=…`}</p>
        {studioHost ? null : (
          <div className="mt-4 flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]">
            <span>{t('connection.lockedHow')}</span>
            <button
              type="button"
              onClick={() => { void navigator.clipboard?.writeText(COMMAND).then(() => setCopied(true), () => {}); }}
              className="rounded-md bg-[var(--bg-field)] px-2 py-0.5 font-mono text-[12px] text-[var(--text)] ring-1 ring-inset ring-[var(--border)] hover:bg-[var(--bg-hover)]"
            >
              {copied ? t('connection.copied') : COMMAND}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Studio stopped (an update, a crash, the computer slept): a bar across the top while it is away, so nothing seems to
 * hang for no reason. Reconnecting is tried all along; once it has been away a while the page is covered (an export or
 * an edit made now would go nowhere) and the bar says how to start it again: this page reconnects by itself.
 */
function ConnectionNotice() {
  const t = useT();
  const state = useSyncExternalStore(studioConnection.subscribe, studioConnection.get);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (state === 'up') setCopied(false); }, [state]);
  if (state === 'up') return null;
  if (state === 'locked') return <LockedNotice />;
  const gone = state === 'gone';
  const COMMAND = 'orangefilm open';
  return (
    <>
      {gone ? <div aria-hidden className="fixed inset-0 z-[10049] bg-black/40 backdrop-blur-[1.5px]" /> : null}
      <div role="alert" className={`fixed inset-x-0 top-0 z-[10050] flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-[13px] font-medium text-white shadow-lg ${gone ? 'bg-[#b42318]' : 'bg-[#b54708]'}`}>
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full bg-white ${gone ? '' : 'animate-pulse'}`} />
        <span>{t(gone ? (studioHost ? 'connection.goneApp' : 'connection.gone') : 'connection.lost')}</span>
        {gone && !studioHost ? (
          <button
            type="button"
            onClick={() => { void navigator.clipboard?.writeText(COMMAND).then(() => setCopied(true), () => {}); }}
            className="rounded-md bg-white/15 px-2 py-0.5 font-mono text-[12.5px] ring-1 ring-inset ring-white/30 hover:bg-white/25"
          >
            {copied ? t('connection.copied') : COMMAND}
          </button>
        ) : null}
      </div>
    </>
  );
}
