// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { useEffect, useMemo, useState } from 'react';
import { BrandLogo, brandName } from './BrandLogo';
import { SettingsModal } from './settings/SettingsModal';
import { useSettings } from './settings/use-settings';
import { MaterialCenter } from './MaterialCenter';
import { type MaterialDraftOperation, type MaterialDraftReference } from '@/lib/material-draft';
import { useLanguage, useT } from '@/i18n';
import { queryAccountCatalog } from '@/lib/catalog-query-unavailable';
import { createMaterialUse } from '@/lib/material-center/use-material';
import { FissionWorkbench } from './FissionWorkbench';
import { BatchRenderPage } from './batch/BatchRenderPage';
import { createRenderBatchApi, loadRenderState } from './batch/batch-api';

type Kind='fission'|'materials';
type DraftAction=(operation:MaterialDraftOperation)=>Promise<boolean>;

/** The host's use/download handler: one real download per click, through the Studio's own raw route. */
const useMaterial=createMaterialUse();

export function StandaloneWorkspace({kind,onHome,onResume,onMaterials,onFission,onOpenProject,draft,draftReady,draftReason,onDraftOperation,onDraftRetry,authGeneration,active=true}:{
  kind:Kind;onHome:()=>void;onResume?:()=>void;onMaterials:()=>void;onFission:()=>void;
  onOpenProject?:(id:string)=>void;
  draft:MaterialDraftReference[];draftReady:boolean;draftReason:'unavailable'|'conflict'|null;onDraftOperation:DraftAction;onDraftRetry:()=>Promise<boolean>;authGeneration?:number;active?:boolean;
}) {
  const t=useT(),[settings,setSettings]=useSettings(active);
  return <div className="workspace-shell flex min-h-0 flex-col bg-[var(--bg-app)] text-[var(--text)]">
    <header data-titlebar className="flex h-8 shrink-0 items-center gap-3 border-b border-[var(--border)] px-2">
      <button type="button" onClick={onHome} aria-label={t('homeCards.home')} className="flex items-center gap-2 rounded px-1.5 py-1 text-[12px] font-semibold hover:bg-[var(--bg-hover)]">
        <BrandLogo size={15}/><span>{brandName}</span>
      </button>
      <span className="text-[12px] text-[var(--text-muted)]">/</span><span className="text-[12px] font-medium">{t(kind==='fission'?'homeCards.fission':'homeCards.catalog')}</span>
      <div className="flex-1"/>
      {onResume&&<button type="button" onClick={onResume} className="rounded px-2 py-1 text-[12px] hover:bg-[var(--bg-hover)]">{t('homeCards.resume')}</button>}
      <button type="button" onClick={()=>setSettings('general')} className="rounded px-2 py-1 text-[12px] hover:bg-[var(--bg-hover)]">{t('homeCards.settings')}</button>
    </header>
    <main className="min-h-0 flex-1 overflow-auto p-5">
      {kind==='fission'
        ? <FissionWorkspace active={active} authGeneration={authGeneration} onOpenProject={onOpenProject} onMaterials={onMaterials}/>
        : <MaterialCenter queryCloud={queryAccountCatalog} authGeneration={authGeneration} onUseMaterial={useMaterial} draft={draft} draftReady={draftReady} draftReason={draftReason} onDraftOperation={onDraftOperation} onDraftRetry={onDraftRetry} onOpenFission={onFission}/>}
    </main>
    <SettingsModal open={active&&settings!==null} section={settings??undefined} onClose={()=>setSettings(null)}/>
  </div>;
}

/**
 * 批量出片：列表即预览。首屏问一次 `/api/fission-render/state` 拿到计划与最近批次；
 * 问不到就当空列表（页面自己会说"还没有计划"），不在这里编数据。
 */
function BatchSection({ active, onOpenProject }: { active: boolean; onOpenProject?: (id: string) => void }) {
  const [entries, setEntries] = useState<{ planId: string; copyPreview?: string; totalSec?: number; shotCount?: number; blocking?: number; canFilm?: boolean; voiceId?: string; bgm?: string | null }[]>([]);
  const api = useMemo(() => createRenderBatchApi(), []);
  useEffect(() => {
    if (!active) return;
    void loadRenderState().then((state) => setEntries(state.entries)).catch(() => setEntries([]));
  }, [active]);
  return <BatchRenderPage entries={entries} api={api} onOpenPlan={onOpenProject} />;
}

function FissionWorkspace({active,authGeneration,onOpenProject,onMaterials}:{active:boolean;authGeneration?:number;onOpenProject?:(id:string)=>void;onMaterials:()=>void}) {
  const t=useT(),zh=useLanguage()==='zh-CN';
  return <div className="mx-auto max-w-[1400px] space-y-5">
    <div><h1 className="text-[24px] font-semibold">{t('homeCards.fission')}</h1><p className="mt-1 text-[13px] text-[var(--text-muted)]">{t('workspace.fissionPurpose')}</p></div>
    <BatchSection active={active} onOpenProject={onOpenProject}/>
    <details className="rounded-xl border border-[var(--border)] bg-[var(--bg-panel)]">
      <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium">{zh ? '高级设置（原来的向导）' : 'Advanced (the old wizard)'}</summary>
      <div className="px-4 pb-4"><FissionWorkbench viewActive={active} authGeneration={authGeneration} onOpenProject={onOpenProject}/></div>
    </details>
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-5 lg:col-span-2">
        <h2 className="font-semibold">{t('homeCards.catalog')}</h2>
        <p className="mt-2 text-sm text-[var(--text-muted)]">{zh?'素材中心的待选素材暂不能用于当前混剪，请在上方重新选择本地文件夹。':'Material center selections are not yet used by this batch. Choose local folders above.'}</p>
        <button type="button" onClick={onMaterials} className="mt-4 rounded border border-[var(--border)] px-3 py-2 text-[13px] hover:bg-[var(--bg-hover)]">{t('workspace.openMaterials')}</button>
      </section>
    </div>
  </div>;
}
