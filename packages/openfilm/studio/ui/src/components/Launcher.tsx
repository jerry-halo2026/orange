// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** Original Studio home. Project data/CRUD remain in the original ProjectsLibrary. */
import React from 'react';
import { Settings2 } from 'lucide-react';
import { BrandLogo, brandName } from './BrandLogo';
import { ProjectsPopover } from './ProjectsLibrary';
import { SettingsModal } from './settings/SettingsModal';
import { useSettings } from './settings/use-settings';
import { useT } from '@/i18n';
import { studioHost } from '@/lib/host';

export function Launcher({onOpen,currentProjectId='',onResume,onCurrentRemoved,onEntry}:{onOpen:(id:string)=>void;currentProjectId?:string;onResume?:()=>void;onCurrentRemoved?:()=>void;onEntry?:(entry:'fission'|'catalog')=>void}) {
 const t=useT(),[settings,setSettings]=useSettings();
 const projects=React.useRef<HTMLDivElement>(null);
 React.useEffect(()=>studioHost?.tabs?.onPick(()=>projects.current?.focus()),[]);
 return <div className="workspace-shell flex flex-col bg-[var(--bg-app)]">
  <header data-titlebar className="flex h-8 shrink-0 items-center gap-2 px-[6px]">
   <div aria-hidden style={{width:'var(--titlebar-logo-x)'}} />
   <button type="button" aria-label={t('homeCards.home')} onClick={()=>{projects.current?.focus();}} className="flex h-[26px] items-center gap-2 rounded px-1.5 text-[var(--text)]"><BrandLogo size={15} bare /><span className="text-[12px] font-semibold">{brandName}</span></button>
   <div className="flex-1" />
   {onEntry&&<>
    <button type="button" onClick={()=>onEntry('fission')} className="flex h-[26px] items-center gap-1 rounded px-2 text-[12px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">{t('homeCards.fission')}</button>
    <button type="button" onClick={()=>onEntry('catalog')} className="flex h-[26px] items-center gap-1 rounded px-2 text-[12px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">{t('homeCards.catalog')}</button>
   </>}
   {onResume&&<button type="button" onClick={onResume} className="rounded px-2 py-1 text-[12px] text-[var(--text-muted)]">{t('homeCards.resume')}</button>}
   <button type="button" aria-label={t('homeCards.settings')} onClick={()=>setSettings('general')} className="flex h-[26px] items-center gap-1 rounded px-2 text-[12px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><Settings2 size={15}/>{t('homeCards.settings')}</button>
  </header>
  <main className="flex min-h-0 flex-1 flex-col overflow-auto px-4 pb-4 sm:px-8">
   <section ref={projects} tabIndex={-1} aria-label={t('project.projects')} className="mx-auto mt-4 flex min-h-[360px] w-full max-w-[1300px] flex-1 flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] outline-none">
    <ProjectsPopover open embedded currentProjectId={currentProjectId} onOpen={onOpen} onCurrentRemoved={onCurrentRemoved??(()=>{})} onClose={onResume}/>
   </section>
  </main>
  <SettingsModal open={settings!==null} section={settings??undefined} onClose={()=>setSettings(null)}/>
 </div>;
}
