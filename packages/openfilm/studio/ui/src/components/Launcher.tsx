// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** Original Studio home. Project data/CRUD remain in the original ProjectsLibrary. */
import React from 'react';
import { Clapperboard, FolderOpen, Settings2, Workflow } from 'lucide-react';
import { BrandLogo, brandName } from './BrandLogo';
import { ProjectsPopover } from './ProjectsLibrary';
import { SettingsModal } from './settings/SettingsModal';
import { useSettings } from './settings/use-settings';
import { useT } from '@/i18n';
import { studioHost } from '@/lib/host';
import type { HomeEntry } from '@/lib/projects-page';

export function Launcher({onOpen,currentProjectId='',onResume,onCurrentRemoved,onEntry}:{onOpen:(id:string)=>void;currentProjectId?:string;onResume?:()=>void;onCurrentRemoved?:()=>void;onEntry?:(entry:HomeEntry)=>void}) {
 const t=useT(),[settings,setSettings]=useSettings();
 const [choice,setChoice]=React.useState<HomeEntry>('studio');
 const projects=React.useRef<HTMLDivElement>(null);
 React.useEffect(()=>studioHost?.tabs?.onPick(()=>projects.current?.focus()),[]);
 const choose=(entry:HomeEntry)=>{setChoice(entry);if(entry!=='studio'&&onEntry)onEntry(entry);else{projects.current?.scrollIntoView({block:'nearest'});projects.current?.focus();}};
 return <div className="workspace-shell flex flex-col bg-[var(--bg-app)]">
  <header data-titlebar className="flex h-8 shrink-0 items-center gap-2 px-[6px]">
   <div aria-hidden style={{width:'var(--titlebar-logo-x)'}} />
   <button type="button" aria-label={t('homeCards.home')} onClick={()=>{projects.current?.focus();}} className="flex h-[26px] items-center gap-2 rounded px-1.5 text-[var(--text)]"><BrandLogo size={15}/><span className="text-[12px] font-semibold">{brandName}</span></button>
   <div className="flex-1" />
   {onResume&&<button type="button" onClick={onResume} className="rounded px-2 py-1 text-[12px] text-[var(--text-muted)]">{t('homeCards.resume')}</button>}
   <button type="button" aria-label={t('homeCards.settings')} onClick={()=>setSettings('general')} className="flex h-[26px] items-center gap-1 rounded px-2 text-[12px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><Settings2 size={15}/>{t('homeCards.settings')}</button>
  </header>
  <main className="flex min-h-0 flex-1 flex-col overflow-auto px-4 pb-4 sm:px-8">
   <section aria-label={t('homeCards.features')} className="mx-auto w-full max-w-[1300px] shrink-0 py-6">
    <h1 className="text-[24px] font-semibold text-[var(--text)]">{t('homeCards.title')}</h1>
    <div className="mt-4 grid gap-3 sm:grid-cols-3">
     {([{id:'fission',Icon:Workflow,title:'homeCards.fission',body:'homeCards.fissionBody'},{id:'studio',Icon:Clapperboard,title:'homeCards.studio',body:'homeCards.studioBody'},{id:'catalog',Icon:FolderOpen,title:'homeCards.catalog',body:'homeCards.catalogBody'}] as const).map(({id,Icon,title,body})=><button key={id} type="button" onClick={()=>choose(id)} className="rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-5 text-left transition hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--text-muted)]"><Icon size={24} className="text-[var(--text-muted)]"/><h2 className="mt-3 text-[17px] font-semibold text-[var(--text)]">{t(title)}</h2><p className="mt-2 text-[13px] leading-relaxed text-[var(--text-muted)]">{t(body)}</p></button>)}
    </div>
    {!currentProjectId&&<p role="status" className="mt-3 text-[13px] text-[var(--text-muted)]">{t('homeCards.choose')} {t(choice==='studio'?'homeCards.studioGuide':choice==='fission'?'homeEntry.nextFission':'homeEntry.nextCatalog')}</p>}
   </section>
   <section ref={projects} tabIndex={-1} aria-label={t('project.projects')} className="mx-auto flex min-h-[360px] w-full max-w-[1300px] flex-1 flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] outline-none">
    <ProjectsPopover open embedded currentProjectId={currentProjectId} onOpen={onOpen} onCurrentRemoved={onCurrentRemoved??(()=>{})} onClose={onResume}/>
   </section>
  </main>
  <SettingsModal open={settings!==null} section={settings??undefined} onClose={()=>setSettings(null)}/>
 </div>;
}
