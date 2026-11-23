// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import React from 'react';
import { useLanguage } from '@/i18n';
import { button, panel, label, hint, NumberField, EmptyNumberField, ChoiceField, ToggleField, Disclosure, FieldErrors } from './fission/fields';
import { StepNav } from './fission/StepNav';
import { SceneGroupCard } from './fission/SceneGroupCard';
import { PresetPicker } from './fission/PresetPicker';
import { SummaryBar } from './fission/SummaryBar';
import { applyPreset, applyPresetToGroups, initialOptions, issueText, issues, issuesFor, plan, presetIds, reorder, roles, stepStates } from './fission/wizard';
import type { Group, Issue, Options, PresetId, Role, StepId } from './fission/wizard';

type Selection = { selectionId:string; role:Role; name:string; groups:{name:string;count:number}[] };
type Output = {index:number;state:string;title?:string;durationSec?:number};
type Batch = {jobId:string;status:'preparing'|'running'|'completed'|'failed'|'cancelled'|'needs-reconciliation';outputs:Output[];error?:string;logs?:string[]};
type DraftReady = {status:'ready';projectId:string;blockingCapabilities:string[];exportReady:boolean;equivalenceVerified:boolean};
type DraftState = {status:'checking'|'creating'|'not-started'|'needs-reconciliation'} | DraftReady;

const emptySelection = ():Record<Role,Selection|null>=>({video:null,audio:null,bgm:null,intro:null,outro:null});
const safeId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(v);
const record=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
class FissionRequestError extends Error {
  constructor(message:string,readonly code:string,readonly status:number){super(message);}
}

/** This endpoint accepts only server-created selection identifiers, never a path from the page. */
async function request(path:string, init:RequestInit & {json?:unknown}={}):Promise<unknown>{
  const {json,...rest}=init;
  const response=await fetch(`/api/fission-local/${path}`,{...rest,headers:json===undefined?rest.headers:{'content-type':'application/json',...rest.headers},body:json===undefined?rest.body:JSON.stringify(json)});
  const body:unknown=await response.json().catch(()=>null);
  if(!response.ok)throw new FissionRequestError(record(body)&&typeof body.error==='string'?body.error.slice(0,240):`HTTP ${response.status}`,record(body)&&typeof body.code==='string'?body.code:'',response.status);
  return body;
}

function readSelection(value:unknown,role:Role):Selection|null {
  if(value===null)return null;
  if(!record(value)||value.role!==role||!safeId(value.selectionId)||typeof value.name!=='string'||!value.name||value.name.length>256||/[\\/\x00-\x1f]/.test(value.name)||!Array.isArray(value.groups))throw Error('Invalid folder selection');
  const groups=value.groups.map(group=>{
    if(!record(group)||typeof group.name!=='string'||!group.name||group.name.length>128||/[\\/\x00-\x1f]/.test(group.name)||!Number.isSafeInteger(group.count)||(group.count as number)<0)throw Error('Invalid scene group');
    return {name:group.name,count:group.count as number};
  });
  return {selectionId:value.selectionId,role,name:value.name,groups};
}
function readBatch(value:unknown):Batch {
  if(!record(value)||!safeId(value.jobId)||!['preparing','running','completed','failed','cancelled','needs-reconciliation'].includes(String(value.status))||!Array.isArray(value.outputs))throw Error('Invalid batch status');
  const outputs=value.outputs.map(o=>{
    if(!record(o)||!Number.isSafeInteger(o.index)||(o.index as number)<0||typeof o.state!=='string'||o.state.length>64)throw Error('Invalid output');
    return {index:o.index as number,state:o.state,...(typeof o.title==='string'?{title:o.title.slice(0,200)}:{}),...(typeof o.durationSec==='number'&&Number.isFinite(o.durationSec)?{durationSec:o.durationSec}:{})};
  });
  if(new Set(outputs.map(o=>o.index)).size!==outputs.length)throw Error('Duplicate output');
  const logs=Array.isArray(value.logs)?value.logs.filter((v):v is string=>typeof v==='string').slice(-40).map(v=>v.slice(0,240)):[];
  return {jobId:value.jobId,status:value.status as Batch['status'],outputs,logs,...(typeof value.error==='string'?{error:value.error.slice(0,240)}:{})};
}
function readDraft(value:unknown):DraftState {
  if(!record(value))throw Error('Invalid draft status');
  if(value.status==='not-started'||value.status==='needs-reconciliation')return {status:value.status};
  if(value.status!=='ready'||!record(value.project)||!safeId(value.project.id)||!Array.isArray(value.blockingCapabilities)||value.blockingCapabilities.length>100||value.blockingCapabilities.some(v=>typeof v!=='string'||v.length>128)||typeof value.exportReady!=='boolean'||typeof value.equivalenceVerified!=='boolean')throw Error('Invalid draft status');
  return {status:'ready',projectId:value.project.id,blockingCapabilities:value.blockingCapabilities as string[],exportReady:value.exportReady,equivalenceVerified:value.equivalenceVerified};
}

/**
 * Original Fission job controls on the native Studio page, as a three-step wizard:
 * ① materials (folders + scene-group cards) → ② rules (presets, the full surface behind 自定义)
 * → ③ export (count, length, concurrency, audio, the estimate). Fission remains the only engine, and
 * the submitted job keeps the existing field names: the wizard layers the presentation only.
 */
let fissionUnavailable = false;

export function FissionWorkbench({viewActive=true,authGeneration,onOpenProject}:{viewActive?:boolean;authGeneration?:number;onOpenProject?:(id:string)=>void}) {
  const zh=useLanguage()==='zh-CN', L=(cn:string,en:string)=>zh?cn:en;
  const errorText=(code:string)=>{
    const messages:Record<string,[string,string]>={
      'fission-scene-groups-disabled':['请至少启用一个场景组。','Enable at least one scene group.'],
      'fission-transition-range':['转场时长须在 0–2 秒之间。','Transition duration must be between 0 and 2 seconds.'],
      'fission-subtitle-text-required':['已开启字幕，但配音文件缺少匹配文案。','Subtitles are enabled, but the voice audio has no matching script.'],
      'fission-subtitle-not-applied':['字幕未能生成，请检查素材后重试。','Subtitles could not be generated. Check the materials and try again.'],
      'fission-folder-empty':['所选文件夹没有可用素材，请选择包含对应素材的文件夹。','The selected folder has no usable media. Choose a folder containing the required files.'],
      'fission-job-invalid':['任务参数无效，请检查素材选择和输出设置。','The batch settings are invalid. Check your selections and output settings.'],
      'fission-source-invalid':['素材无法安全读取，请重新选择文件夹并检查素材。','The media could not be read safely. Choose the folder again and check its files.'],
      'fission-source-changed':['素材在处理时发生变化，请重新选择并重试。','The media changed during processing. Select it again and retry.'],
      'fission-worker-failed':['混剪执行失败，请检查素材和任务状态后重试。','The batch failed. Check the media and batch status before retrying.'],
      'fission-configuration-invalid':['本地混剪运行环境不可用，请检查 Fission 和媒体工具配置。','The local batch runtime is unavailable. Check the Fission and media tool configuration.'],
      'fission-range-invalid':['无法读取该成片，请刷新任务状态后重试。','The video could not be read. Refresh the batch status and retry.'],
      'authentication-required':['登录已失效，请重新登录。','Your sign-in has expired. Please sign in again.'],
    };
    const found=messages[code];return found?L(found[0],found[1]):L('操作未完成，请检查任务状态后重试。','The operation could not be completed. Check the batch status and try again.');
  };
  const explain=(error:unknown)=>error instanceof FissionRequestError?errorText(error.code):errorText('');
  const pendingKey=Number.isSafeInteger(authGeneration)&&Number(authGeneration)>=0?`orange-fission-pending-${authGeneration}`:null;
  const [selections,setSelections]=React.useState(emptySelection);
  const [groups,setGroups]=React.useState<Group[]>([]);
  const [options,setOptionsState]=React.useState(initialOptions);
  const [preset,setPreset]=React.useState<PresetId>('voice-mix');
  const [step,setStep]=React.useState<StepId>('materials');
  /* Why the rail or the footer would not move: one line, said where the person pressed. */
  const [stepHint,setStepHint]=React.useState('');
  /* The sticky summary's measured height; the steps below start and land below it, never behind it. */
  const [summaryHeight,setSummaryHeight]=React.useState(0);
  const summaryRef=React.useRef<HTMLDivElement>(null);
  const [advancedOpen,setAdvancedOpen]=React.useState(false);
  const [moreOpen,setMoreOpen]=React.useState(false);
  const [dragging,setDragging]=React.useState<number|null>(null);
  const [batch,setBatch]=React.useState<Batch|null>(null);
  const [jobs,setJobs]=React.useState<Batch[]>([]);
  const [service,setService]=React.useState<'loading'|'ready'|'unavailable'>('loading');
  const [serviceError,setServiceError]=React.useState('');
  const [serviceAttempt,setServiceAttempt]=React.useState(0);
  const [message,setMessage]=React.useState('');
  const [messageStep,setMessageStep]=React.useState<StepId>('export');
  const [pollMessage,setPollMessage]=React.useState('');
  const [pollAttempt,setPollAttempt]=React.useState(0);
  const [selecting,setSelecting]=React.useState<Role|null>(null);
  const [starting,setStarting]=React.useState(false);
  /* 云管家批量：向导本地路径只认文件夹；云端素材走 recipe 路由（项目 + 云引用 → 下载 → 引擎）。 */
  const [cloudOpen,setCloudOpen]=React.useState(false);
  const [cloudQuery,setCloudQuery]=React.useState('');
  const [cloudRows,setCloudRows]=React.useState<Array<{videoId:string;name:string}>>([]);
  const [cloudPicked,setCloudPicked]=React.useState<string[]>([]);
  const [cloudLines,setCloudLines]=React.useState('');
  const [cloudProjects,setCloudProjects]=React.useState<Array<{id:string;name:string}>>([]);
  const [cloudProject,setCloudProject]=React.useState('');
  const [cloudBusy,setCloudBusy]=React.useState(false);
  const [cloudSaid,setCloudSaid]=React.useState('');
  const [cloudSearching,setCloudSearching]=React.useState(false);
  const [pendingRequestId,setPendingRequestId]=React.useState<string|null>(()=>{try{const value=pendingKey?sessionStorage.getItem(pendingKey):null;return value&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)?value:null;}catch{return null;}});
  const [cancellingId,setCancellingId]=React.useState<string|null>(null);
  const [drafts,setDrafts]=React.useState<Record<string,DraftState>>({});
  const [draftPending,setDraftPending]=React.useState<string|null>(null);
  const selectingRef=React.useRef(false),startRef=React.useRef(false),draftRef=React.useRef(new Set<string>()),cancelRef=React.useRef(new Set<string>());
  const draftChecks=React.useRef(new Map<string,AbortController>());
  const pendingRequest=React.useRef<{requestId:string;selections:Record<string,string|null>;job:Record<string,unknown>}|null>(null);
  const sectionRefs={materials:React.useRef<HTMLDivElement>(null),rules:React.useRef<HTMLDivElement>(null),export:React.useRef<HTMLDivElement>(null)};
  const active=batch?.status==='preparing'||batch?.status==='running';
  const noEnabledGroups=groups.length>0&&!groups.some(group=>group.Enabled);
  const keepTerminal=(current:Batch|null,next:Batch)=>current?.jobId===next.jobId&&['completed','failed','cancelled','needs-reconciliation'].includes(current.status)&&['preparing','running'].includes(next.status)?current:next;
  const currentId=React.useRef<string|null>(null);currentId.current=batch?.jobId??null;
  const recoveryBlocked=jobs.some(j=>j.status==='needs-reconciliation');
  /* The summary is sticky, so its height is the one number the steps need: each step carries it as `scrollMarginTop`,
     which is what makes a step that is jumped to land under the bar instead of under it. */
  React.useEffect(()=>{
    const node=summaryRef.current;if(!node)return undefined;
    const measure=()=>setSummaryHeight(Math.round(node.getBoundingClientRect().height));
    measure();
    if(typeof ResizeObserver==='undefined')return undefined;
    const observer=new ResizeObserver(measure);observer.observe(node);
    return()=>observer.disconnect();
  },[]);
  React.useEffect(()=>{
    const controller=new AbortController();setService('loading');setServiceError('');
    /* 已确认运行时未配置（503 fission-local-unavailable）：不再每次挂载都打一次 503。 */
    if (fissionUnavailable) { setService('unavailable'); return () => controller.abort(); }
    void request('jobs',{signal:controller.signal}).then(value=>{
      if(!Array.isArray(value))throw Error('Invalid batch list');
      const found=value.map(readBatch);if(new Set(found.map(j=>j.jobId)).size!==found.length)throw Error('Duplicate batch');
      if(controller.signal.aborted)return;
      setJobs(found);setBatch(current=>current??found.find(j=>j.status==='preparing'||j.status==='running')??found[0]??null);setService('ready');
    }).catch(error=>{if(!controller.signal.aborted){if(error instanceof FissionRequestError&&(error.status===503||error.code==='fission-local-unavailable'))fissionUnavailable=true;setServiceError(error instanceof FissionRequestError&&error.code==='authentication-required'?errorText(error.code):'');setService('unavailable');}});
    return()=>controller.abort();
  },[serviceAttempt]);
  /** Any hand edit leaves the preset: the wizard says 自定义 from then on. */
  const set=<K extends keyof Options>(key:K,value:Options[K])=>{setOptionsState(previous=>({...previous,[key]:value}));setPreset('custom');};
  const say=(text:string,at:StepId)=>{setMessage(text);setMessageStep(at);};
  const found=issues(options,groups,{hasVideo:Boolean(selections.video)});
  const planned=plan(options);
  const stepTitles:Record<StepId,[string,string]>={materials:['选择素材','Materials'],rules:['规则','Rules'],export:['导出','Export']};
  const goStep=(id:StepId)=>{setStep(id);const node=sectionRefs[id].current;node?.scrollIntoView({block:'start',behavior:'smooth'});node?.focus();};
  const issueLines=(list:Issue[])=>list.map(issue=>L(issueText[issue.code][0],issueText[issue.code][1]));
  const openCloud=async()=>{
    setCloudOpen(true);setCloudSaid('');
    try{
      /* Studio 没有“列出工程”的 HTTP 路由：先问一次，拿不到就建一个批量专用工程（出片要一个工程来落盘）。 */
      const listed=await fetch('/api/projects',{cache:'no-store'}).then(async r=>(r.ok?await r.json():null)).catch(()=>null);
      let list=Array.isArray(listed?.projects)?listed.projects:(Array.isArray(listed)?listed:[]);
      if(!list.length){
        const made=await fetch('/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:`云管家批量 ${new Date().toISOString().slice(0,10)}`})}).then(r=>r.json());
        const project=made?.project??made;
        if(project?.id)list=[project];
      }
      const options=list.map((p:any)=>({id:String(p.id),name:String(p.name??p.id)}));
      setCloudProjects(options);setCloudProject(current=>current||options[0]?.id||'');
      if(!options.length)setCloudSaid(L('没有可用工程，且新建失败。','No project available and creating one failed.'));
    }catch{setCloudSaid(L('读取工程失败。','Could not read projects.'));}
  };
  const searchCloud=async()=>{
    setCloudSearching(true);setCloudSaid('');
    try{
      const url=new URL('/api/materials/list',window.location.origin);
      url.searchParams.set('scope','company');url.searchParams.set('pageSize','24');url.searchParams.set('pageNo','1');
      if(cloudQuery.trim())url.searchParams.set('name',cloudQuery.trim());
      const answer=await fetch(url,{cache:'no-store'}).then(r=>r.json());
      const items=Array.isArray(answer?.items)?answer.items:[];
      setCloudRows(items.map((item:any)=>{
        const id=typeof item?.id==='object'?item.id?.value:item?.id ?? item?.videoId;
        return {videoId:String(id??''),name:String(item?.name??item?.title??item?.fileName??item?.videoName??id??'')};
      }).filter((row:any)=>row.videoId));
    }catch{setCloudSaid(L('素材查询失败。','Material search failed.'));}
    finally{setCloudSearching(false);}
  };
  const runCloud=async()=>{
    if(!cloudPicked.length||!cloudLines.trim()||!cloudProject||cloudBusy)return;
    setCloudBusy(true);setCloudSaid('');
    try{
      const mac=/Mac/i.test(navigator.userAgent);
      const recipe={
        schema:'orange/mix-recipe/1',
        groups:[{name:(cloudQuery.trim()||L('云管家素材','Cloud materials')).slice(0,60),refs:cloudPicked.map(videoId=>({kind:'cloud',videoId})),rule:'random'}],
        script:{provider:'minimax',voice:'female-shaonv',lines:cloudLines.split('\n').map(line=>line.trim()).filter(Boolean)},
        params:{count:options.Count,audioUses:Math.max(1,options.AudioUses||options.Count),aspect:'9:16',subtitle:true,
          subtitleFontFamily:mac?'Noto Sans CJK SC':'Microsoft YaHei',...(options.TargetDurationSec?{targetSec:options.TargetDurationSec}:{})},
        bgm:[],
      };
      const answer=await fetch('/api/fission-render/recipe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:cloudProject,recipe,voices:[],run:true})}).then(async r=>({status:r.status,body:await r.json().catch(()=>null)}));
      const body:any=answer.body;
      if(answer.status===200&&body?.ok)setCloudSaid(L(`批次 ${body.batchId}：出片 ${body.render?.report?.succeeded??'?'} 条（${body.render?.report?.stopReason??''}）`,`Batch ${body.batchId}: ${body.render?.report?.succeeded??'?'} video(s)`));
      else setCloudSaid(`${body?.code??answer.status}${body?.problems?.length?': '+body.problems.slice(0,2).join('; '):''}`);
    }catch(error){setCloudSaid(error instanceof Error?error.message:String(error));}
    finally{setCloudBusy(false);}
  };
  const pick=async(role:Role)=>{
    if(selectingRef.current||service!=='ready')return;
    selectingRef.current=true;setSelecting(role);setMessage('');
    try{
      const result=readSelection(await request('select',{method:'POST',json:{role}}),role);
      if(!result)return; // User cancelled: keep the previous selection.
      setSelections(current=>({...current,[role]:result}));
      if(role==='video')setGroups(applyPresetToGroups(preset,result.groups.map(group=>({Name:group.name,Enabled:true,TakePerOutput:0,Rule:'Random',Speed:1,UseThenDelete:false,AllowReuse:false} as Group))));
    }catch(error){setMessage(L('选择目录失败：','Could not select folder: ')+explain(error));setMessageStep('materials');}
    finally{selectingRef.current=false;setSelecting(null);}
  };
  const patchGroup=(index:number,patch:Partial<Group>)=>{setGroups(current=>current.map((group,at)=>at===index?{...group,...patch}:group));setPreset('custom');};
  const moveGroup=(from:number,to:number)=>setGroups(current=>reorder(current,from,to));
  const choosePreset=(id:PresetId)=>{setPreset(id);setOptionsState(current=>applyPreset(id,current));setGroups(current=>applyPresetToGroups(id,current));setAdvancedOpen(id==='custom');setMessage('');};
  const start=async()=>{
    if(startRef.current||active||service!=='ready'||recoveryBlocked||(pendingRequestId&&!pendingRequest.current)||(!selections.video&&!pendingRequest.current))return;
    if(noEnabledGroups){say(L('请至少启用一个场景组。','Enable at least one scene group.'),'materials');return;}
    if(found.length){say(L('请检查参数范围：转场时长为 0–2 秒，图片和随机时长须大于 0 且最大值不能小于最小值。','Check the settings: transition must be 0–2 seconds; image and random durations must be positive and ordered.'),found[0].step);return;}
    startRef.current=true;setStarting(true);setMessage('');
    try{
      if(!pendingRequest.current){
        const chosen=Object.fromEntries(roles.map(role=>[role,selections[role]?.selectionId??null]));
        const job={...options,SceneGroups:groups.length?groups:null,...(!selections.audio?{GeneratedAudioCount:Math.max(options.Count,1),GeneratedAudioDurationSec:options.TargetDurationSec??12}:{})};
        if(!pendingKey)throw Error('Desktop session is unavailable');
        const candidate={requestId:crypto.randomUUID(),selections:chosen,job};
        sessionStorage.setItem(pendingKey,candidate.requestId);
        pendingRequest.current=candidate;setPendingRequestId(candidate.requestId);
      }
      const next=readBatch(await request('jobs',{method:'POST',json:pendingRequest.current}));
      setBatch(next);setJobs(current=>[next,...current.filter(j=>j.jobId!==next.jobId)]);pendingRequest.current=null;setPendingRequestId(null);if(pendingKey)try{sessionStorage.removeItem(pendingKey);}catch{}
    }catch(error){
      const rejected=error instanceof FissionRequestError&&error.status===400&&['fission-scene-groups-disabled','fission-transition-range','fission-job-invalid'].includes(error.code);
      if(rejected){pendingRequest.current=null;setPendingRequestId(null);if(pendingKey)try{sessionStorage.removeItem(pendingKey);}catch{}say(explain(error),error.code==='fission-scene-groups-disabled'?'materials':error.code==='fission-transition-range'?'rules':'export');}
      else say(L('任务未确认，请检查状态后再试：','Batch was not confirmed; check its status before retrying: ')+explain(error),'export');
    }
    finally{startRef.current=false;setStarting(false);}
  };
  React.useEffect(()=>{
    if(!batch||!active||!viewActive){setPollMessage('');return;}
    const controller=new AbortController(),id=batch.jobId;
    let timer:number|undefined,failures=0;
    const schedule=(delay:number)=>{timer=window.setTimeout(()=>void poll(),delay);};
    const poll=async()=>{
      try{
        const next=readBatch(await request(`jobs/${encodeURIComponent(id)}`,{signal:controller.signal}));
        if(next.jobId!==id)throw Error('Invalid batch identity');
        if(controller.signal.aborted||currentId.current!==id)return;
        failures=0;setPollMessage('');
        setBatch(current=>current?.jobId===id?keepTerminal(current,next):current);
        setJobs(current=>current.map(j=>j.jobId===id?keepTerminal(j,next):j));
        if(next.status==='preparing'||next.status==='running')schedule(1200);
      }catch{
        if(controller.signal.aborted||currentId.current!==id)return;
        failures+=1;
        if(failures>=5){setPollMessage(L('自动查询已暂停，请点击刷新状态。','Automatic status checks paused. Select Refresh status.'));return;}
        setPollMessage(L('任务状态暂不可用，正在重试。','Batch status is unavailable; retrying.'));
        schedule(Math.min(1200*2**failures,9600));
      }
    };
    setPollMessage('');schedule(1200);
    return()=>{controller.abort();if(timer!==undefined)window.clearTimeout(timer);};
  },[batch?.jobId,active,zh,pollAttempt,viewActive]);
  const reconcile=async()=>{
    const requestId=pendingRequest.current?.requestId??pendingRequestId;if(!requestId||startRef.current)return;
    startRef.current=true;setStarting(true);setMessage('');
    try{const next=readBatch(await request(`requests/${encodeURIComponent(requestId)}`));setBatch(next);setJobs(current=>[next,...current.filter(j=>j.jobId!==next.jobId)]);pendingRequest.current=null;setPendingRequestId(null);if(pendingKey)try{sessionStorage.removeItem(pendingKey);}catch{}}
    catch{setMessage(pendingRequest.current?L('任务状态尚未确认，可用同一请求重试。','The batch is not yet confirmed. You may retry the same request.'):L('任务状态尚未确认，请稍后再次查询。','The batch is not yet confirmed. Check again later.'));}
    finally{startRef.current=false;setStarting(false);}
  };
  const cancel=async()=>{
    if(!batch||!active||cancelRef.current.has(batch.jobId))return;
    const id=batch.jobId;cancelRef.current.add(id);setCancellingId(id);setMessage('');
    try{const next=readBatch(await request(`jobs/${encodeURIComponent(id)}/cancel`,{method:'POST',json:{}}));if(next.jobId!==id)throw Error('Invalid batch identity');setBatch(current=>current?.jobId===id?keepTerminal(current,next):current);setJobs(current=>current.map(j=>j.jobId===id?keepTerminal(j,next):j));}
    catch{if(currentId.current===id)setMessage(L('停止结果未确认，请刷新状态。','Cancellation was not confirmed; refresh its status.'));}
    finally{cancelRef.current.delete(id);setCancellingId(current=>current===id?null:current);}
  };
  const refresh=async()=>{
    if(!batch)return;const id=batch.jobId;
    try{const next=readBatch(await request(`jobs/${encodeURIComponent(id)}`));if(next.jobId!==id)throw Error('Invalid batch identity');setBatch(current=>current?.jobId===id?keepTerminal(current,next):current);setJobs(current=>current.map(j=>j.jobId===id?keepTerminal(j,next):j));if(currentId.current===id){setMessage('');setPollMessage('');setPollAttempt(n=>n+1);}}
    catch{setMessage(L('任务状态暂不可用，请稍后重试。','Batch status is unavailable; try again later.'));}
  };
  const draftKey=(jobId:string,index:number)=>`${jobId}:${index}`;
  const draftRoute=(jobId:string,index:number)=>`jobs/${encodeURIComponent(jobId)}/outputs/${index}/draft`;
  const checkDraft=async(jobId:string,index:number)=>{
    const key=draftKey(jobId,index);if(draftRef.current.has(key))return;
    const controller=new AbortController();draftChecks.current.set(key,controller);
    draftRef.current.add(key);setDrafts(current=>({...current,[key]:{status:'checking'}}));
    try{const status=readDraft(await request(draftRoute(jobId,index),{signal:controller.signal}));if(!controller.signal.aborted)setDrafts(current=>({...current,[key]:status}));}
    catch{if(!controller.signal.aborted)setDrafts(current=>({...current,[key]:{status:'needs-reconciliation'}}));}
    finally{draftChecks.current.delete(key);draftRef.current.delete(key);if(controller.signal.aborted)setDrafts(current=>{const next={...current};delete next[key];return next;});}
  };
  React.useEffect(()=>()=>{for(const controller of draftChecks.current.values())controller.abort();},[]);
  const completedIndices=batch?.outputs.filter(output=>output.state==='completed').map(output=>output.index).join(',')??'';
  React.useEffect(()=>{
    if(!batch||!completedIndices)return;
    const id=batch.jobId;
    for(const item of completedIndices.split(',')){const index=Number(item),key=draftKey(id,index);if(!drafts[key])void checkDraft(id,index);}
  },[batch?.jobId,completedIndices,drafts]);
  const makeDraft=async(index:number)=>{
    if(!batch)return;
    const id=batch.jobId,key=draftKey(id,index),current=drafts[key];
    if(current?.status==='ready'){onOpenProject?.(current.projectId);return;}
    if(current?.status!=='not-started'||draftRef.current.has(key))return;
    draftRef.current.add(key);setDraftPending(key);setDrafts(previous=>({...previous,[key]:{status:'creating'}}));setMessage('');
    try{
      const result=readDraft(await request(draftRoute(id,index),{method:'POST',json:{}}));
      if(result.status!=='ready')throw Error('Draft result not confirmed');
      setDrafts(previous=>({...previous,[key]:result}));
    }catch{setDrafts(previous=>({...previous,[key]:{status:'needs-reconciliation'}}));setMessage(L('草稿结果未确认，请先查询状态，避免重复创建。','Draft creation is unconfirmed. Check its status before retrying.'));}
    finally{draftRef.current.delete(key);setDraftPending(previous=>previous===key?null:previous);}
  };
  const labels:Record<Role,string>={video:L('视频素材','Videos'),audio:L('配音','Voice audio'),bgm:L('背景音乐','Background music'),intro:L('片头','Intro'),outro:L('片尾','Outro')};
  const statusLabel:Record<Batch['status'],string>={preparing:L('准备中','Preparing'),running:L('执行中','Running'),completed:L('已完成','Completed'),failed:L('失败','Failed'),cancelled:L('已停止','Cancelled'),'needs-reconciliation':L('待核对','Needs reconciliation')};
  const selectedRoles=roles.filter(role=>selections[role]);
  const enabledGroups=groups.filter(group=>group.Enabled).length;
  const groupIssue=(name:string)=>found.find(issue=>issue.group===name);
  /* The gate is the data's, never the click's: ① is done only once at least one material is chosen and its own fields
     are clean; ② and ③ stay shut while ① is open. Nothing is "ready" merely because it has no complaints of its own. */
  const gated=stepStates(options,groups,{hasVideo:Boolean(selections.video),selectedMaterials:selectedRoles.length});
  const stepState=(id:StepId)=>gated.states[id];
  const stepBlocked=L('先选择至少 1 个素材','Choose at least one folder first');
  /* One screen per step: the step that is not showing stays mounted (its fields keep their values, its errors keep
     their place) but is drawn behind the one that is, and shut for the pointer and the keyboard while it is locked. */
  const stepFace=(id:StepId)=>`${panel} ${step===id?'border-[var(--text)]':'pointer-events-none absolute inset-0 overflow-hidden opacity-0'}`;
  const stepShut=(id:StepId)=>step!==id&&stepState(id)==='locked';
  const stepTitle=L(...stepTitles[step]);
  /** The rail and the footer share one door: a shut step says why it will not move and the wizard stays where it is. */
  const requestStep=(id:StepId)=>{if(stepState(id)==='locked'){setStepHint(stepBlocked);return;}setStepHint('');goStep(id);};
  const fieldIssues=(id:StepId)=>issueLines(issuesFor(found,id).filter(issue=>issue.group===undefined));
  const selectedFrame=`${options.OutWidth}x${options.OutHeight}`;
  const invalidField=(code:string)=>found.some(issue=>issue.code===code)||undefined;
  /** The batch's own failure lands in the step that owns the setting, not in a distant strip. */
  const alertAt=(id:StepId)=>message&&messageStep===id?<p role="alert" className="mt-2 text-sm text-[var(--text-muted)]">{message}</p>:null;
  const groupIssueText=(name:string)=>{const issue=groupIssue(name);return issue?L(issueText[issue.code][0],issueText[issue.code][1]):null;};
  return <div className="mx-auto mb-5 max-w-[1400px] space-y-4">
    {service==='loading'&&<p role="status" className="text-sm">{L('正在检查本地混剪服务…','Checking the local batch service…')}</p>}
    {service==='unavailable'&&<p role="alert" className="text-sm">{serviceError||L('本地混剪服务未配置或当前不可用。','The local batch service is not configured or unavailable.')} <button type="button" className="underline" onClick={()=>setServiceAttempt(n=>n+1)}>{L('重试','Retry')}</button></p>}
    {recoveryBlocked&&<p role="alert" className="text-sm">{L('上次任务状态未确认，请先核对已有成片；为避免重复出片，暂不能启动新任务。','A previous batch needs reconciliation. Check its outputs before starting another batch.')}</p>}
    {/* The summary is sticky and measured: the steps below begin under it and are jumped to under it, never behind it. */}
    <div ref={summaryRef} data-summary-bar="" className="bg-[var(--bg-app)] pb-1">
      <SummaryBar L={L} options={options} plan={planned} preset={preset} selectedRoles={selectedRoles} groupCount={groups.length} enabledGroups={enabledGroups} stepTitle={stepTitle}/>
    </div>
    <StepNav L={L} current={step} onSelect={requestStep} steps={[
      {id:'materials',title:L('选择素材','Materials'),state:stepState('materials')},
      {id:'rules',title:L('规则','Rules'),state:stepState('rules')},
      {id:'export',title:L('导出','Export'),state:stepState('export')},
    ]}/>
    {stepHint&&<p role="status" data-note="step-locked" className="text-xs text-[var(--text-muted)]">{stepHint}</p>}
    <fieldset disabled={service!=='ready'||Boolean(pendingRequestId)||Boolean(active)||starting} className="space-y-4 disabled:opacity-80">
      <div className="relative">
      <div ref={sectionRefs.materials} tabIndex={-1} role="group" aria-labelledby="fission-step-materials" data-step="materials" data-step-state={stepState('materials')} data-step-active={step==='materials'?'true':'false'} inert={stepShut('materials')||undefined} onFocusCapture={()=>{if(step!=='materials')setStep('materials');}} style={{scrollMarginTop:summaryHeight+12}} className={stepFace('materials')}>
        <h2 id="fission-step-materials" className="font-semibold">{L('① 选择素材','① Materials')}</h2>
        <p className={`mt-1 ${hint}`}>{L('选择本地目录；视频目录下的数字子文件夹按场景组处理。选择已有配音目录后按配音出片；未选择时使用测试音调，无配音。文案生成与 TTS 尚未接通。','Select local folders; numbered subfolders under the video folder are scene groups. An existing voice folder drives the batch; otherwise a test tone is used with no voice. Script generation and TTS are not connected yet.')}</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">{roles.map(role=><div key={role} className="flex min-w-0 items-center gap-2 rounded border border-[var(--border)] p-2 text-sm"><span className="w-24 shrink-0">{labels[role]}</span><span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">{selections[role]?.name??L('未选择','Not selected')}</span><button type="button" className={button} disabled={Boolean(selecting)||active||starting} onClick={()=>void pick(role)}>{selecting===role?L('选择中…','Selecting…'):L('选择文件夹','Choose folder')}</button>{role==='video'&&<button type="button" className={button} disabled={Boolean(selecting)||active||starting} onClick={()=>void openCloud()}>{L('云管家素材','Cloud materials')}</button>}{role!=='video'&&selections[role]&&<button type="button" className={button} disabled={active||starting} onClick={()=>setSelections(current=>({...current,[role]:null}))}>{L('清除','Clear')}</button>}</div>)}</div>
        {groups.length>0&&<div className="mt-4">
          <p className={hint}>{L('每组一张卡；拖住卡片刻或使用箭头调整顺序，顺序即引擎取用场景组的顺序。','One card per group. Drag a card or use its arrows to reorder; that order is the one the engine draws groups in.')}</p>
          <ul aria-label={L('场景组','Scene groups')} className="mt-2 grid gap-2 xl:grid-cols-2">{groups.map((group,index)=><SceneGroupCard key={group.Name} group={group} index={index} total={groups.length} count={selections.video?.groups.find(item=>item.name===group.Name)?.count} L={L} disabled={service!=='ready'||Boolean(pendingRequestId)||Boolean(active)||starting} dragging={dragging===index} issue={groupIssueText(group.Name)} onPatch={patchGroup} onMove={moveGroup} onDragStart={setDragging} onDrop={index=>{if(dragging!==null)moveGroup(dragging,index);setDragging(null);}} onDragEnd={()=>setDragging(null)}/>)}</ul>
        </div>}
        {selections.video&&groups.length===0&&<p className="mt-3 text-xs text-[var(--text-muted)]">{L('目录没有场景子文件夹，将使用目录中的素材。','No scene subfolders; using files in this folder.')}</p>}
        <FieldErrors id="fission-errors-materials" items={fieldIssues('materials')}/>
        {alertAt('materials')}
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {gated.states.rules==='locked'&&<p role="status" data-note="next-blocked" className="mr-auto text-xs text-[var(--text-muted)]">{stepBlocked}</p>}
          <button type="button" data-action="step-next" className={button} disabled={gated.states.rules==='locked'} onClick={()=>requestStep('rules')}>{L('下一步：规则','Next: rules')}</button>
        </div>
      </div>
      <div ref={sectionRefs.rules} tabIndex={-1} role="group" aria-labelledby="fission-step-rules" data-step="rules" data-step-state={stepState('rules')} data-step-active={step==='rules'?'true':'false'} inert={stepShut('rules')||undefined} onFocusCapture={()=>{if(step!=='rules')setStep('rules');}} style={{scrollMarginTop:summaryHeight+12}} className={stepFace('rules')}>
        <h2 id="fission-step-rules" className="font-semibold">{L('② 规则','② Rules')}</h2>
        <p className={`mt-1 ${hint}`}>{L('先选预设：预设会写入一整套已知参数；选“自定义”才展开全部参数。','Start from a preset: it writes one known set of parameters. 自定义 is the state that exposes every parameter.')}</p>
        <div className="mt-3"><PresetPicker preset={preset} ids={presetIds} onPick={choosePreset} L={L} disabled={service!=='ready'||Boolean(pendingRequestId)||Boolean(active)||starting}/></div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <ChoiceField name={L('分割模式','Split mode')} value={options.SplitMode} items={[['Scene',L('镜头','Scene')],['AveragePieces',L('平均份数','Equal pieces')],['BySeconds',L('按秒','Seconds')],['RandomRange',L('随机区间','Random range')],['None',L('不分割','None')]]} onChange={value=>set('SplitMode',value)}/>
          <ChoiceField name={L('转场','Transition')} value={options.TransitionName} items={[['fade',L('淡入淡出','Fade')],['random',L('随机','Random')]]} onChange={value=>set('TransitionName',value)}/>
          <NumberField name={L('转场时长（0–2 秒，0 为关闭）','Transition seconds, 0–2; 0 disables')} value={options.TransitionSec} min={0} max={2} step="0.05" ariaInvalid={invalidField('transition-range')} onChange={value=>set('TransitionSec',value)}/>
        </div>
        <Disclosure id="fission-advanced-rules" title={L('进阶规则','Advanced rules')} note={preset==='custom'?L('已展开全部参数','Every parameter is open'):L('预设已配置，可展开微调','The preset set these; open to fine-tune')} open={advancedOpen} onToggle={setAdvancedOpen} L={L}>
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField name={L('镜头阈值','Scene threshold')} value={options.SceneThreshold} min={0.01} max={0.99} step="0.01" ariaInvalid={invalidField('split-threshold-range')} onChange={value=>set('SceneThreshold',value)}/>
            <NumberField name={L('平均份数','Pieces')} value={options.AvgPieces} min={1} ariaInvalid={invalidField('pieces-range')} onChange={value=>set('AvgPieces',value)}/>
            <NumberField name={L('分割秒数','Seconds per piece')} value={options.BySeconds} min={0.1} step="0.1" ariaInvalid={invalidField('pieces-seconds-range')} onChange={value=>set('BySeconds',value)}/>
            <NumberField name={L('随机最短秒数','Random minimum')} value={options.RandomMinSec} min={0.1} step="0.1" ariaInvalid={invalidField('random-duration-range')} onChange={value=>set('RandomMinSec',value)}/>
            <NumberField name={L('随机最长秒数','Random maximum')} value={options.RandomMaxSec} min={0.1} step="0.1" ariaInvalid={invalidField('random-duration-range')} onChange={value=>set('RandomMaxSec',value)}/>
            <label className={label}>{L('对齐策略','Alignment strategy')}<select className="w-full rounded border border-[var(--border)] bg-[var(--bg-app)] px-2 py-1.5 text-sm" value={options.Align} onChange={event=>set('Align',Number(event.target.value))}>{Array.from({length:8},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}</select></label>
          </div>
          <div className="mt-3 flex flex-wrap gap-4"><ToggleField name={L('允许重复抽取视频','Allow video reuse')} checked={options.AllowVideoReuse} onChange={checked=>set('AllowVideoReuse',checked)}/><ToggleField name={L('随机左右翻转','Random horizontal flip')} checked={options.RandomHFlip} onChange={checked=>set('RandomHFlip',checked)}/></div>
        </Disclosure>
        <Disclosure id="fission-more-rules" title={L('更多参数','More parameters')} note={L('图片时长与字幕','Image length and subtitles')} open={moreOpen} onToggle={setMoreOpen} L={L}>
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField name={L('图片最短时长','Image minimum seconds')} value={options.ImageDurMinSec} min={0.1} step="0.5" ariaInvalid={invalidField('image-duration-range')} onChange={value=>set('ImageDurMinSec',value)}/>
            <NumberField name={L('图片最长时长','Image maximum seconds')} value={options.ImageDurMaxSec} min={0.1} step="0.5" ariaInvalid={invalidField('image-duration-range')} onChange={value=>set('ImageDurMaxSec',value)}/>
            <NumberField name={L('字号','Font size')} value={options.SubtitleFontSize} min={20} max={160} ariaInvalid={invalidField('subtitle-font-range')} onChange={value=>set('SubtitleFontSize',value)}/>
            <ChoiceField name={L('样式','Style')} value={options.SubtitleStyle} items={[['white-outline',L('白字黑边','White outline')],['yellow-outline',L('黄字黑边','Yellow outline')],['white-box',L('白字底盒','White box')],['center-bold',L('居中加粗','Center bold')]]} onChange={value=>set('SubtitleStyle',value)}/>
            <ChoiceField name={L('位置','Position')} value={options.SubtitlePos} items={[['bottom',L('底部','Bottom')],['middle',L('居中','Middle')],['top',L('顶部','Top')]]} onChange={value=>set('SubtitlePos',value)}/>
          </div>
          <div className="mt-3"><ToggleField name={L('烧录配音文案字幕','Burn in voice script subtitles')} checked={options.SubtitleEnabled} onChange={checked=>set('SubtitleEnabled',checked)}/></div>
        </Disclosure>
        <FieldErrors id="fission-errors-rules" items={fieldIssues('rules')}/>
        {alertAt('rules')}
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {gated.states.export==='locked'&&<p role="status" data-note="next-blocked" className="mr-auto text-xs text-[var(--text-muted)]">{stepBlocked}</p>}
          <button type="button" data-action="step-back" className={button} onClick={()=>requestStep('materials')}>{L('上一步：素材','Back: materials')}</button>
          <button type="button" data-action="step-next" className={button} disabled={gated.states.export==='locked'} onClick={()=>requestStep('export')}>{L('下一步：导出','Next: export')}</button>
        </div>
      </div>
      <div ref={sectionRefs.export} tabIndex={-1} role="group" aria-labelledby="fission-step-export" data-step="export" data-step-state={stepState('export')} data-step-active={step==='export'?'true':'false'} inert={stepShut('export')||undefined} onFocusCapture={()=>{if(step!=='export')setStep('export');}} style={{scrollMarginTop:summaryHeight+12}} className={stepFace('export')}>
        <h2 id="fission-step-export" className="font-semibold">{L('③ 导出','③ Export')}</h2>
        <p className={`mt-1 ${hint}`}>{L('成片保存在当前任务的工作目录；下面的预计产出随参数实时变化。','Videos are saved in this batch workspace; the estimate below follows the settings as you type.')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <NumberField name={L('生成数量','Count')} value={options.Count} min={0} max={10000} ariaInvalid={invalidField('count-range')} onChange={value=>set('Count',value)}/>
          <EmptyNumberField name={L('目标时长（秒，留空跟随配音）','Duration in seconds; empty follows voice')} value={options.TargetDurationSec} min={0} onChange={value=>set('TargetDurationSec',value)}/>
          <NumberField name={L('并发数','Concurrency')} value={options.Threads} min={1} max={64} ariaInvalid={invalidField('threads-range')} onChange={value=>set('Threads',value)}/>
          <NumberField name={L('每条配音使用次数','Outputs per voice')} value={options.AudioUses} min={0} ariaInvalid={invalidField('audio-uses-range')} onChange={value=>set('AudioUses',value)}/>
          <NumberField name={L('配音音量','Voice volume')} value={options.VoiceVolume} min={0} max={2} step="0.05" ariaInvalid={invalidField('volume-range')} onChange={value=>set('VoiceVolume',value)}/>
          <NumberField name={L('背景音量','Background volume')} value={options.BgmVolume} min={0} max={2} step="0.05" ariaInvalid={invalidField('volume-range')} onChange={value=>set('BgmVolume',value)}/>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className={label}>{L('画面尺寸','Frame size')}<select className="w-full rounded border border-[var(--border)] bg-[var(--bg-app)] px-2 py-1.5 text-sm" value={selectedFrame} onChange={event=>{const [width,height]=event.target.value.split('x').map(Number);setOptionsState(old=>({...old,OutWidth:width,OutHeight:height}));setPreset('custom');}}>{['1080x1920','720x1280','1280x720','1920x1080'].map(value=><option key={value} value={value}>{value.replace('x',' × ')}</option>)}</select></label>
          <ChoiceField name={L('命名','Naming')} value={options.Naming} items={[['AudioFileName',L('按配音文件','Voice file')],['Sequence',L('数字序号','Sequence')],['RandomTitle',L('随机标题','Random title')]]} onChange={value=>set('Naming',value)}/>
          <NumberField name={L('帧率','Frame rate')} value={options.OutFps} min={1} max={120} ariaInvalid={invalidField('fps-range')} onChange={value=>set('OutFps',value)}/>
        </div>
        <div role="status" className="mt-3 rounded border border-[var(--border)] p-3 text-sm">
          <p className="font-medium">{L('预计成片 ','Estimated videos ')}{planned.outputs} {L('条','videos')} · {L('目标时长','target')} {planned.perOutputSec} {L('秒','s')}</p>
          <p className={hint}>{L('估算耗时 ','Estimated time ')}{planned.seconds>=60?`${Math.floor(planned.seconds/60)} ${L('分','min')} `:''}{planned.seconds%60} {L('秒','s')} · {L('并发','concurrency')} ×{options.Threads}</p>
          <p className={hint}>{L(`配音池可支撑 ${planned.capacity} 条；未选择配音目录时按生成数量估算。`,`The voice pool covers ${planned.capacity} videos; without a voice folder the count is used.`)}</p>
        </div>
        <FieldErrors id="fission-errors-export" items={fieldIssues('export')}/>
        {alertAt('export')}
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2"><button type="button" data-action="step-back" className={button} onClick={()=>requestStep('rules')}>{L('上一步：规则','Back: rules')}</button></div>
      </div>
      </div>
      {(options.RandomHFlip||options.TransitionSec>0||options.SubtitleEnabled)&&<div role="status" className="rounded border border-[var(--border)] p-3 text-sm text-[var(--text-muted)]">
        {L('当前启用了翻转、转场或字幕；这些效果在可编辑草稿中的还原和导出尚未验证。','Flip, transitions or subtitles are enabled; their draft reconstruction and export have not yet been verified.')}
        <button type="button" className={`${button} ml-3`} onClick={()=>{setOptionsState(old=>({...old,RandomHFlip:false,TransitionSec:0,SubtitleEnabled:false}));setPreset('custom');}}>{L('关闭这些效果以便续编','Disable these effects for editing')}</button>
      </div>}
    </fieldset>
    <section className={panel}>
      <h2 className="font-semibold">{L('执行与成片','Task and results')}</h2>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className={button} disabled={service!=='ready'||recoveryBlocked||noEnabledGroups||Boolean(pendingRequestId&&!pendingRequest.current)||!selections.video||starting||active||draftPending!==null} onClick={()=>void start()}>{starting?L('正在启动…','Starting…'):pendingRequestId?L('重试同一请求','Retry same request'):L('开始批量出片','Start batch')}</button>
        {pendingRequestId&&<button type="button" className={button} disabled={starting||service!=='ready'} onClick={()=>void reconcile()}>{L('查询任务','Find batch')}</button>}
        <button type="button" className={button} disabled={!active||Boolean(batch&&cancellingId===batch.jobId)} onClick={()=>void cancel()}>{L('停止','Stop')}</button>
        {batch&&<><button type="button" className={button} onClick={()=>void refresh()}>{L('刷新状态','Refresh status')}</button><span role="status" className="text-sm">{L('状态：','Status: ')}{statusLabel[batch.status]}</span></>}
      </div>
      {jobs.length>1&&<label className={label}>{L('已有任务','Existing batches')}<select className="w-full rounded border border-[var(--border)] bg-[var(--bg-app)] px-2 py-1.5 text-sm" value={batch?.jobId??''} disabled={starting||Boolean(pendingRequestId)||draftPending!==null} onChange={event=>{const next=jobs.find(j=>j.jobId===event.target.value);if(next){setBatch(next);setMessage('');}}}>{jobs.map((j,i)=><option key={j.jobId} value={j.jobId}>{L('任务','Batch')} {i+1} · {statusLabel[j.status]}</option>)}</select></label>}
      {pollMessage&&<p role="status" className="mt-2 text-sm text-[var(--text-muted)]">{pollMessage}</p>}
      {batch?.error&&<p role="alert" className="mt-2 text-sm">{errorText(batch.error)}</p>}
      {Boolean(batch?.logs?.length)&&<ol aria-label={L('执行日志','Execution log')} className="mt-3 max-h-36 space-y-1 overflow-auto rounded bg-[var(--bg-app)] p-2 text-xs text-[var(--text-muted)]">{batch?.logs?.map((line,index)=><li key={index}>{line}</li>)}</ol>}
      {batch&&<ul className="mt-3 grid gap-3 md:grid-cols-2">{batch.outputs.map(output=>{
        const key=draftKey(batch.jobId,output.index),state=drafts[key];
        return <li key={output.index} className="rounded border border-[var(--border)] p-3">
          <p className="text-sm">{output.title||`${L('成片','Output')} ${output.index+1}`} · {output.state==='completed'?L('已完成','Completed'):output.state}</p>
          {output.state==='completed'&&<>
            <video className="mt-2 max-h-56 w-full bg-black" controls preload="none" src={`/api/fission-local/jobs/${encodeURIComponent(batch.jobId)}/outputs/${output.index}/video`}/>
            {state?.status==='ready'&&<div role="status" className="mt-2 text-xs text-[var(--text-muted)]">
              {!state.exportReady&&<p>{L('草稿导出能力尚未确认。','Draft export readiness is not yet confirmed.')}</p>}
              {!state.equivalenceVerified&&<p>{L('与原成片的效果一致性尚未确认。','Equivalence with the rendered video is not yet confirmed.')}</p>}
              {state.blockingCapabilities.length>0&&<p>{L('待处理能力：','Capabilities requiring attention: ')}{state.blockingCapabilities.join('、')}</p>}
            </div>}
            {state?.status==='needs-reconciliation'
              ? <><p role="status" className="mt-2 text-xs">{L('草稿状态未确认，请先查询。','Draft status is unconfirmed. Check it first.')}</p><button type="button" className={`${button} mt-2`} onClick={()=>void checkDraft(batch.jobId,output.index)}>{L('查询草稿状态','Check draft status')}</button></>
              : <button type="button" className={`${button} mt-2`} disabled={!state||state.status==='checking'||state.status==='creating'} onClick={()=>void makeDraft(output.index)}>{!state||state.status==='checking'?L('检查草稿状态…','Checking draft status…'):state.status==='creating'?L('正在创建…','Creating…'):state.status==='ready'?L('打开草稿','Open draft'):L('生成可编辑草稿','Create editable draft')}</button>}
          </>}
        </li>;
      })}</ul>}
      {cloudOpen&&<div role="dialog" aria-label={L('云管家批量','Cloud batch')} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="max-h-[86vh] w-full max-w-2xl overflow-auto rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-4">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{L('云管家素材批量出片','Cloud materials batch')}</h3>
            <span className="flex-1" />
            <button type="button" className={button} onClick={()=>setCloudOpen(false)}>{L('关闭','Close')}</button>
          </div>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{L('按关键词查云端素材（公司视图），勾选后配口播文案，走 recipe 路由出片。','Search the company catalogue, pick videos, write lines, then render through the recipe route.')}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input value={cloudQuery} onChange={event=>setCloudQuery(event.target.value)} placeholder={L('关键词，如 乌龙茶','Keyword, e.g. oolong')} className="w-56 rounded border border-[var(--border)] bg-[var(--bg-app)] px-2 py-1.5 text-sm" />
            <button type="button" className={button} disabled={cloudSearching} onClick={()=>void searchCloud()}>{cloudSearching?L('查询中…','Searching…'):L('查询','Search')}</button>
            <span className="text-xs text-[var(--text-muted)]">{L('已选','Picked')} {cloudPicked.length}</span>
          </div>
          <ul className="mt-3 max-h-56 overflow-auto rounded border border-[var(--border)] p-2">
            {cloudRows.map(row=><li key={row.videoId} className="flex items-center gap-2 py-1 text-sm">
              <input type="checkbox" checked={cloudPicked.includes(row.videoId)} onChange={event=>setCloudPicked(current=>event.target.checked?[...current,row.videoId]:current.filter(id=>id!==row.videoId))} />
              <span className="truncate">{row.name||row.videoId}</span>
              <span className="text-xs text-[var(--text-muted)]">{row.videoId}</span>
            </li>)}
            {!cloudRows.length&&<li className="py-2 text-xs text-[var(--text-muted)]">{L('还没有结果，输入关键词查询。','No results yet; search by keyword.')}</li>}
          </ul>
          <label className="mt-3 block text-sm">{L('工程','Project')}
            <select className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-app)] px-2 py-1.5 text-sm" value={cloudProject} onChange={event=>setCloudProject(event.target.value)}>
              {cloudProjects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label className="mt-3 block text-sm">{L('口播文案（一行一条）','Lines (one per output)')}
            <textarea value={cloudLines} onChange={event=>setCloudLines(event.target.value)} rows={3} className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg-app)] px-2 py-1.5 text-sm" />
          </label>
          <div className="mt-3 flex items-center gap-2">
            <button type="button" className={button} disabled={cloudBusy||!cloudPicked.length||!cloudLines.trim()||!cloudProject} onClick={()=>void runCloud()}>{cloudBusy?L('出片中…','Rendering…'):L('开始出片','Render')}</button>
            {cloudSaid&&<span role="status" className="text-sm">{cloudSaid}</span>}
          </div>
        </div>
      </div>}
    </section>
  </div>;
}
