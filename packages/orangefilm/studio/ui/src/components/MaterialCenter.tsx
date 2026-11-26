// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import React from 'react';
import { api } from '@/api';
import { useLanguage, useT } from '@/i18n';
import { type MaterialDraftOperation, type MaterialDraftReference } from '@/lib/material-draft';
import { createMaterialsClient, type MaterialsClient } from '@/lib/material-center/client';
import { createMaterialCenterController } from '@/lib/material-center/controller';
import { scopeParam } from '@/lib/material-center/contract';
import { copyFor, downloadNotice } from '@/lib/material-center/copy';
import { createWikiCache, createWikiClient, type WikiClient } from '@/lib/material-center/wiki';
import { wikiCopyFor } from '@/lib/material-center/wiki-copy';
import { bindingRefreshPlan, createMaterialBinding, sharedBindingStore, type MaterialBinding } from '@/lib/material-center/binding';
import { deniedDownloads } from '@/lib/material-center/denied';
import { landDownloadInProject, takeMaterial } from '@/lib/material-center/library';
import { createMaterialIndexReader, type IndexLandedSource, type IndexRowsSource, type MaterialIndexState } from '@/lib/material-center/index-tree';
import { landedIndexOf } from '@/lib/material-center/index-landed';
import { readIndexRows } from '@/lib/material-center/index-rows';
import { isSubtitleName } from '@/lib/material-center/media';
import type { MaterialCard } from '@/lib/material-center/model';
import { MaterialCenterPage } from './material-center/MaterialCenterPage';

export interface MaterialCenterProps {
  /** Kept for the callers that still hand one in; the material page reads the read-only routes instead. */
  queryCloud?: unknown;
  draft:readonly MaterialDraftReference[];
  draftReady:boolean;
  draftReason:'unavailable'|'conflict'|null;
  onDraftOperation:(operation:MaterialDraftOperation)=>Promise<boolean>;
  onDraftRetry:()=>Promise<boolean>;
  fixedProjectId?:string;
  authGeneration?:number;
  compact?:boolean;
  onClose?:()=>void;
  onOpenFission?:()=>void;
  onImportLocal?:()=>Promise<void>|void;
  /** Where the read-only material routes are mounted; the service is a separate loopback app, so a host passes this. */
  materialsClient?:MaterialsClient;
  /** Injected in tests (a fake); defaults to the same-origin wiki client. */
  wikiClient?:WikiClient;
  /**
   * The host's use/download handler: the only action that costs a supplier download. It resolves with what landed
   * (POST /api/materials/raw) and may reject with a classified failure the library shows as its own sentence.
   */
  onUseMaterial?:(card:MaterialCard)=>unknown;
  /**
   * A drill-down: show only this supplier group (cloud source only) and hide the filter bar. The group panel owns the
   * breadcrumb and the way back; the library keeps the cards, the download and the add-to-project actions.
   */
  group?:{readonly twoLevelId:number;readonly oneLevelId:number;readonly name:string;readonly scope?:'company'|'own'}|null;
  /** A drill-down answers its group's total (providerTotal), so the group card can say it on the way back. */
  onGroupCount?:(total:number|null)=>void;
  /**
   * The material pane's cloud tab: the same page, but it opens on the cloud catalogue and keeps its filter bar (the
   * search and the author) on screen even while a 合集 narrows the list. Nothing else about the page changes.
   */
  cloudTab?:boolean;
  /** The rows the 批次/合集/子合集 index is built from; injected in a test, defaulted to the read-only page walk. */
  indexRows?:IndexRowsSource;
}

/**
 * The material centre: the supplier's catalogue, read through the read-only routes, with one filter bar, one card and
 * the one costed action a download is. The project's own files and the Saved library are the drawer's 导入 / 收藏 tabs
 * — they are not a source of this page, so nothing here merges them in.
 *
 * The 合集 view's index is built here, from the read-only list, once per mount: the page is handed either a built tree,
 * "still building" or "could not build" — never a fuzzy stand-in.
 */
export function MaterialCenter({draft,draftReady,draftReason,onDraftOperation,onDraftRetry,fixedProjectId,authGeneration,compact=false,materialsClient,onUseMaterial,group=null,onGroupCount,wikiClient,cloudTab=false,indexRows}:MaterialCenterProps) {
  const t=useT();
  const language=useLanguage();
  const copy=React.useMemo(()=>copyFor(language),[language]);
  /* Which project a downloaded file is taken into (contract §9: the download lands in Saved, then `saved/take` puts it
     in that project's assets, which is what the drawer's 导入 list reads). */
  const [selectedProject,setSelectedProject]=React.useState(fixedProjectId??'');
  /* The one cloud-steward account "my materials" is scoped to: claimed in Settings → 云管家, read here from the store
     both places share (so a claim there is visible here at once). */
  const [binding,setBinding]=React.useState<{known:boolean;value:MaterialBinding|null}>({known:false,value:null});
  const [studioRetrying,setStudioWarming]=React.useState(false);
  const studioClient=React.useMemo(()=>materialsClient??createMaterialsClient({onSessionRetry:setStudioWarming}),[materialsClient]);
  const bindingClient=React.useMemo(()=>createMaterialBinding(),[]);
  const bindings=React.useMemo(()=>sharedBindingStore(bindingClient),[bindingClient]);
  React.useEffect(()=>{
    const sync=()=>{const at=bindings.getState();setBinding({known:at.known,value:at.value});};
    sync();
    const unsubscribe=bindings.subscribe(sync);
    void bindings.read();
    return unsubscribe;
  },[bindings,authGeneration]);
  /* A download lands in Saved (§9), so the Saved listing is read again after one: what is on disk is read back, never
     assumed. The rows are the drawer's 收藏 tab's; this page draws the catalogue, so it keeps none of them. */
  const loadSaved=React.useCallback(async()=>{await api.savedFiles();},[]);
  const loadSavedRef=React.useRef(loadSaved);
  loadSavedRef.current=loadSaved;
  /* The same page the standalone workspace shows: one controller, one read-only client, no second material library.
     A download lands in Saved (§9) and is then taken into the open project through the native take route — otherwise
     the file sits in Saved and the drawer's 导入 list (which reads only the project) never shows it. */
  const useHandler=React.useMemo(()=>onUseMaterial?async(card:MaterialCard)=>{
    const outcome=await takeMaterial(card,{use:onUseMaterial,relist:()=>loadSavedRef.current()});
    const result=(outcome.result??null) as {reused?:unknown;landed?:unknown}|null;
    const reused=result?.reused===true;
    const landing=await landDownloadInProject(typeof result?.landed==='string'?result.landed:null,{
      projectId:selectedProject||null,
      take:selectedProject?async(path:string)=>api.takeSaved(selectedProject,path):null,
      claim:selectedProject?async()=>{
        const ownership=await api.savedOwnership();
        const ref=ownership.refs.find((record)=>!record.current)?.ref;
        if(!ref)return false;
        if(!window.confirm('这个素材库属于另一个账号。把当前账号加入这个素材库后重试？'))return false;
        await api.claimSaved(ref);
        return true;
      }:null,
    });
    /* A subtitle is a 字幕轨's input, not material: it is in the track now, and it is not a card in any material list. */
    if(isSubtitleName(card.title))return {notice:t('materials.subtitleAdded')};
    return {notice:downloadNotice(copy,reused,landing.status==='taken'?{path:landing.path}:null)};
  }:undefined,[onUseMaterial,copy,selectedProject,t]);
  const wiki=React.useMemo(()=>createWikiCache(wikiClient??createWikiClient()),[wikiClient]);
  /* The catalogue is the only source, so there is no source to hand in: a drill-down adds its group, and nothing else
     narrows the read. */
  const controller=React.useMemo(()=>createMaterialCenterController({
    client:studioClient,
    ...(useHandler?{onUse:useHandler}:{}),
    ...(group?{initialFilters:{author:group.scope ?? 'company', twoLevelId:group.twoLevelId, groupIds:[group.twoLevelId]}}:{}),
  }),[studioClient,useHandler,group?.twoLevelId,group?.scope]);
  React.useEffect(()=>()=>controller.destroy(),[controller]);
  /* The index the 合集 view reads, in two steps and in this order:
     1. the index the builder landed on this computer (`GET /api/materials/index`): the whole account, already built;
     2. only when that route is missing or unusable (404 `index-missing`, 500 `index-unreadable`, not served here): the
        budgeted 8 × 100 page walk. The view prints which one it drew, and how many rows that one read.
     A source that fails both ways is said as such — neither step fills in with a guess. */
  const indexSource=React.useMemo<IndexRowsSource>(()=>indexRows??(()=>readIndexRows((pageNo,pageSize)=>studioClient.list({
    pageNo,pageSize,videoType:controller.getState().filters.videoType,scope:scopeParam('company'),
  }))),[indexRows,studioClient,controller]);
  const landedSource=React.useMemo<IndexLandedSource|null>(()=>{
    if(indexRows)return null;
    const read=studioClient.index;
    if(typeof read!=='function')return null;
    return async()=>landedIndexOf(await read.call(studioClient));
  },[indexRows,studioClient]);
  const indexReader=React.useMemo(()=>createMaterialIndexReader({rows:indexSource,landed:landedSource}),[indexSource,landedSource]);
  const indexState:MaterialIndexState=React.useSyncExternalStore(indexReader.subscribe,indexReader.getState,indexReader.getState);
  React.useEffect(()=>{void indexReader.load();return()=>indexReader.destroy();},[indexReader]);
  /* A refusal belongs to the identity that met it: a new session (auth generation) starts with a clean set. Only a
     change clears it — mounting a second surface must not forget what the first one learned. */
  const generationSeen=React.useRef(authGeneration);
  React.useEffect(()=>{
    if(generationSeen.current===authGeneration)return;
    generationSeen.current=authGeneration;
    deniedDownloads.clear();
  },[authGeneration]);
  /* A claim or a release made in Settings changes what "mine" can see: one plan, one refresh at most, no second read. */
  const bindingSeen=React.useRef<MaterialBinding|null>(null);
  React.useEffect(()=>{
    const before=bindingSeen.current;
    bindingSeen.current=binding.value;
    if(!binding.known||before===binding.value)return;
    const plan=bindingRefreshPlan(before,binding.value,controller.getState().filters.author);
    if(plan==='force-company')controller.setFilters({author:'company'});
    else if(plan==='refresh')void controller.refresh();
  },[binding,bindings,controller]);
  /* The page fetches on its own mount; a new authorization generation is the one thing that must reload it here. */
  const firstAuth=React.useRef(true);
  React.useEffect(()=>{
    if(firstAuth.current){firstAuth.current=false;return;}
    void controller.refresh();
  },[controller,authGeneration]);
  /* The project a download is taken into: the open one, else the first the host lists. */
  React.useEffect(()=>{
    if(fixedProjectId){setSelectedProject(fixedProjectId);return undefined;}
    const abort=new AbortController();
    void api.projects(abort.signal).then(all=>{
      const available=all.filter(project=>!project.missing);
      setSelectedProject(current=>available.some(project=>project.id===current)?current:available[0]?.id??'');
    },()=>{setSelectedProject('');});
    return()=>abort.abort();
  },[fixedProjectId]);
  return <section className={'flex min-h-0 flex-col gap-3 '+(compact?'h-full overflow-y-auto p-3':'space-y-1')} aria-label={t('homeCards.catalog')}>
    {(!draftReady||draftReason==='conflict')&&<p role="status" className="text-[12px] text-[var(--text-muted)]">{t(draftReason==='conflict'?'workspace.draftConflict':'workspace.draftUnavailable')} {!draftReady&&authGeneration!==undefined&&Boolean((window as unknown as {orangefilmNative?:{materialDraft?:unknown}}).orangefilmNative?.materialDraft)&&<button type="button" onClick={()=>void onDraftRetry()} className="underline">{t('workspace.draftRetry')}</button>}</p>}
    <MaterialCenterPage
      controller={controller}
      copy={copy}
      compact={compact}
      dense={cloudTab}
      hideToggle={cloudTab}
      index={indexState}
      list={studioClient.list}
      wiki={wiki}
      wikiCopy={wikiCopyFor(language)}
      onGroupCount={onGroupCount}
      showFilters={cloudTab || !group}
      studioRetrying={studioRetrying}
      binding={binding.value}
      bindingKnown={binding.known}
      draft={draft}
      draftReady={draftReady}
      onDraftOperation={onDraftOperation}
    />
  </section>;
}
