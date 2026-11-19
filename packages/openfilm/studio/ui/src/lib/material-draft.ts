// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** UI selection is an intent only. It never represents a verified grant or an immutable material version. */
export type MaterialRole = 'video' | 'voice' | 'bgm' | 'intro' | 'outro';
export type MaterialDraftReference =
  | { source:'local'; projectId:string; path:string; title:string; mediaKind:string; role:MaterialRole; group:string }
  | { source:'cloud'; videoId:string; title:string; role:MaterialRole; group:string };

export function materialDraftKey(item:MaterialDraftReference):string {
  return item.source==='local' ? JSON.stringify(['local',item.projectId,item.path]) : JSON.stringify(['cloud',item.videoId]);
}
export function toggleMaterialDraft(items:readonly MaterialDraftReference[],item:MaterialDraftReference):MaterialDraftReference[] {
  const key=materialDraftKey(item);
  return items.some(row=>materialDraftKey(row)===key) ? items.filter(row=>materialDraftKey(row)!==key) : [...items,item];
}
export function materialGroupFromPath(path:string):string {
  const parts=path.split('/');
  return parts[0]==='assets'&&parts.length>2 ? parts[1]! : '';
}


export function localMaterialDraft(projectId:string,path:string,mediaKind:string):MaterialDraftReference|null {
  if(!['video','image','audio'].includes(mediaKind))return null;
  if(!projectId||projectId.length>512||/[\\/\x00-\x1f\x7f]/.test(projectId))return null;
  if(path.length>2048)return null;
  const segments=path.split('/');
  if(segments[0]!=='assets'||segments.length<2||segments.some(part=>!part||part==='.'||part==='..'||/[\\\x00-\x1f\x7f]/.test(part)))return null;
  const title=segments.at(-1)!.slice(0,200),folder=materialGroupFromPath(path);
  return {source:'local',projectId,path,title,mediaKind,role:mediaKind==='audio'?'voice':'video',group:folder.length<=128?folder:''};
}
export function cloudMaterialDraft(videoId:string,title:string):MaterialDraftReference|null {
  if(!videoId||videoId.length>512||/[:/\\\x00-\x1f\x7f]/.test(videoId))return null;
  const safeTitle=title.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,200)||videoId.slice(0,200);
  return {source:'cloud',videoId,title:safeTitle,role:'video',group:''};
}


/** Clear transient selection on logout/revocation or an attested newer account generation; ignore older events. */
export function materialDraftSession(current:number|null,event:{kind:string;uiGeneration?:number}):{generation:number|null;clear:boolean} {
  const next=Number.isSafeInteger(event.uiGeneration)&&(event.uiGeneration??-1)>=0?event.uiGeneration!:null;
  if(current!==null&&next!==null&&next<current)return {generation:current,clear:false};
  const clear=event.kind==='signed-out'||event.kind==='revoked'||(event.kind==='active'&&current!==null&&next!==null&&next>current);
  return {generation:next??current,clear};
}


export type MaterialDraftOperation =
  | {type:'add';item:MaterialDraftReference}
  | {type:'remove';key:string}
  | {type:'setRole';key:string;role:MaterialRole}
  | {type:'setGroup';key:string;group:string}
  | {type:'clear'};

const roles=new Set<MaterialRole>(['video','voice','bgm','intro','outro']);
const text=(value:unknown,max:number,allowEmpty=false):value is string =>
  typeof value==='string'&&value.length<=max&&(allowEmpty||value.length>0)&&!/[\x00-\x1f\x7f]/.test(value);
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function isMaterialDraftReference(value:unknown):value is MaterialDraftReference {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const item=value as Record<string,unknown>;
  if(!text(item.title,200)||!text(item.group,128,true)||/[\\/]/.test(item.group)||item.group==='.'||item.group==='..'||!roles.has(item.role as MaterialRole))return false;
  if(item.source==='local')return exact(item,['source','projectId','path','title','mediaKind','role','group'])&&typeof item.projectId==='string'&&typeof item.path==='string'&&typeof item.mediaKind==='string'&&localMaterialDraft(item.projectId,item.path,item.mediaKind)!==null;
  return item.source==='cloud'&&exact(item,['source','videoId','title','role','group'])&&typeof item.videoId==='string'&&cloudMaterialDraft(item.videoId,item.title)!==null;
}
