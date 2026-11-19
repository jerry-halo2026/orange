// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Per-subject material bindings, loaded from the ignored local file named by `MATERIALS_BINDINGS`.
 *
 * The service never invents a binding: a subject that is not in this file has no `self` account and
 * no grants, so `own` and `account:<key>` are refused instead of falling back to the company view.
 *
 * File shape (version 1), deliberately small:
 *
 *     { "version": 1,
 *       "bindings": { "<subjectId uuid>": { "selfAccountKey": "…",
 *                                           "grantedAccountKeys": ["…", "…"] } } }
 *
 * Security properties are the same as the credential file: absolute path inside an ignored `.dev`
 * tree, regular file, single link, no symlink anywhere on the path, at most 64 KiB, a UTF-8 BOM is
 * tolerated, unknown keys are refused rather than ignored, and no value ever reaches a log line.
 */
import {createHash} from 'node:crypto';
import {open, lstat, realpath} from 'node:fs/promises';
import {dirname, isAbsolute, normalize, resolve, sep} from 'node:path';
import {fail} from './errors.ts';

export type SubjectBinding=Readonly<{
  selfAccountKey:string;
  grantedAccountKeys:readonly string[];
  /** Claim metadata. Present only for a binding claimed through the service (server mode). */
  account?:string;
  teamId?:number;
  groupId?:number;
  boundAt?:string;
  status?:'claimed';
}>;
export type BindingTable=ReadonlyMap<string,SubjectBinding>;
export type BindingHistoryEntry=Readonly<Record<string,unknown>>;
export type BindingDocument=Readonly<{bindings:BindingTable;history:readonly BindingHistoryEntry[]}>;

const MAX_FILE_BYTES=64*1024;
const REQUIRED_TOP='bindings,version';
const OPTIONAL_TOP:readonly string[]=Object.freeze(['history']);
const REQUIRED_ENTRY='grantedAccountKeys,selfAccountKey';
const OPTIONAL_ENTRY:readonly string[]=Object.freeze(['account','boundAt','groupId','status','teamId']);
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const ACCOUNT_KEY=/^[\x21-\x7e]{1,512}$/;
const unreadable=():never=>fail('bindings-unreadable');
const invalid=():never=>fail('bindings-invalid');
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;

/** The file must live in an ignored `.dev` tree; a relocated copy is refused before it is opened. */
export function assertIgnoredJson(file:string):string {
  if(!isAbsolute(file))return unreadable();
  const normalized=normalize(file);
  if(normalized===normalize(dirname(normalized)))return unreadable();
  const segments=normalized.split(sep);
  if(!segments.includes('.dev'))return unreadable();
  if(!/\.local\.json$/.test(segments[segments.length-1]??''))return unreadable();
  return normalized;
}

/**
 * Parse the document. Entries may carry the claim metadata the service writes; anything else is
 * refused rather than ignored, so a typo cannot silently produce a binding nobody meant to write.
 */
export function parseDocument(raw:unknown):BindingDocument {
  if(!plain(raw))return invalid();
  const top=Object.keys(raw);
  if(top.some(key=>key!=='bindings'&&key!=='version'&&!OPTIONAL_TOP.includes(key)))return invalid();
  if(!top.includes('bindings')||!top.includes('version'))return invalid();
  if(raw.version!==1)return invalid();
  if(!plain(raw.bindings))return invalid();
  const history:BindingHistoryEntry[]=[];
  if(raw.history!==undefined){
    if(!Array.isArray(raw.history))return invalid();
    for(const entry of raw.history){
      if(!plain(entry))return invalid();
      history.push(Object.freeze({...entry}));
    }
  }
  const table=new Map<string,SubjectBinding>();
  for(const [subjectId,entry] of Object.entries(raw.bindings)){
    if(!UUID.test(subjectId))return invalid();
    if(!plain(entry))return invalid();
    const keysOfEntry=Object.keys(entry);
    if(keysOfEntry.some(key=>!REQUIRED_ENTRY.split(',').includes(key)&&!OPTIONAL_ENTRY.includes(key)))return invalid();
    if(REQUIRED_ENTRY.split(',').some(key=>!keysOfEntry.includes(key)))return invalid();
    const self=entry.selfAccountKey;
    if(typeof self!=='string'||!ACCOUNT_KEY.test(self))return invalid();
    const granted=entry.grantedAccountKeys;
    if(!Array.isArray(granted))return invalid();
    const keys:string[]=[];
    for(const candidate of granted){
      if(typeof candidate!=='string'||!ACCOUNT_KEY.test(candidate))return invalid();
      if(!keys.includes(candidate))keys.push(candidate);
    }
    const metadata:Record<string,unknown>={};
    if(entry.account!==undefined){if(typeof entry.account!=='string'||!ACCOUNT_KEY.test(entry.account))return invalid();metadata.account=entry.account;}
    if(entry.teamId!==undefined){if(!Number.isSafeInteger(entry.teamId))return invalid();metadata.teamId=entry.teamId;}
    if(entry.groupId!==undefined){if(!Number.isSafeInteger(entry.groupId))return invalid();metadata.groupId=entry.groupId;}
    if(entry.boundAt!==undefined){if(typeof entry.boundAt!=='string'||!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(entry.boundAt))return invalid();metadata.boundAt=entry.boundAt;}
    if(entry.status!==undefined){if(entry.status!=='claimed')return invalid();metadata.status=entry.status;}
    if(table.has(subjectId))return invalid();
    table.set(subjectId,Object.freeze({selfAccountKey:self,grantedAccountKeys:Object.freeze(keys),...metadata}) as SubjectBinding);
  }
  return Object.freeze({bindings:table,history:Object.freeze(history)});
}

export async function readBindingTable(file:unknown):Promise<BindingTable> {
  return (await readBindingDocument(file)).bindings;
}

export async function readBindingDocument(file:unknown):Promise<BindingDocument> {
  try{
    if(typeof file!=='string')return unreadable();
    const target=assertIgnoredJson(file);
    for(let path=target;;path=dirname(path)){
      const stat=await lstat(path);
      if(stat.isSymbolicLink())return unreadable();
      if(path===target?!(stat.isFile()&&stat.nlink===1&&stat.size>0&&stat.size<=MAX_FILE_BYTES):!stat.isDirectory())return unreadable();
      if(path===dirname(path))break;
    }
    const parent=await realpath(dirname(target));
    const actual=await realpath(target);
    if(actual.toLowerCase()!==resolve(parent,target.slice(target.lastIndexOf(sep)+1)).toLowerCase())return unreadable();
    const handle=await open(target,'r');
    let text:string;
    try{
      const stat=await handle.stat();
      if(!stat.isFile()||stat.nlink!==1||stat.size<=0||stat.size>MAX_FILE_BYTES)return unreadable();
      text=await handle.readFile('utf8');
    }finally{await handle.close();}
    const body=text.charCodeAt(0)===0xfeff?text.slice(1):text;
    let raw:unknown;
    try{raw=JSON.parse(body);}catch{return invalid();}
    return parseDocument(raw);
  }catch(error){
    if(error&&typeof error==='object'&&['bindings-unreadable','bindings-invalid'].includes(String((error as {code?:unknown}).code)))throw error;
    return unreadable();
  }
}

/**
 * The provider binding the transport insists on, derived from the same file entry.
 *
 * The transport needs `{bindingId, revision, accountKey, expiresAtMs}`; the file only carries the
 * account key. **These derived fields are bookkeeping only — they never change who may read
 * what.** `accountKey` is the file's `selfAccountKey` verbatim; the rest is synthesis:
 *
 *  - `bindingId`: a stable UUID derived from (subject, account key), so the same pair always maps to
 *    the same id, across restarts and machines;
 *  - `revision`: always 1, because the file carries no revision notion;
 *  - `expiresAtMs`: computed **once at composition time** from the clock (`now() + ttlMs`), never a
 *    constant, so a restart re-dates it. It must not move within a process: the transport rejects a
 *    binding whose fields change between two reads of the same request (`binding-changed`).
 */
function stableUuid(subjectId:string,accountKey:string):string {
  const digest=createHash('sha256').update(subjectId+'\0'+accountKey,'utf8').digest('hex');
  const variant=((parseInt(digest.slice(16,18),16)&0x3f)|0x80).toString(16).padStart(2,'0');
  return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-${variant}${digest.slice(18,20)}-${digest.slice(20,32)}`;
}

export function providerBindingFor(table:BindingTable|(()=>BindingTable),options:Readonly<{environmentId:string;now?:()=>number;ttlMs?:number;fallbackAccountKey?:string|null}>) {
  // A getter keeps a claimed binding visible to the transport without re-dating expiresAtMs.
  const read:()=>BindingTable=typeof table==='function'?table:()=>table;
  const now=options.now??Date.now;
  const ttlMs=Number.isSafeInteger(options.ttlMs)&&(options.ttlMs as number)>0?options.ttlMs as number:12*3600*1000;
  // Evaluated once, here, so every request in this process sees the same instant.
  const expiresAtMs=now()+ttlMs;
  const fallback=typeof options.fallbackAccountKey==='string'&&ACCOUNT_KEY.test(options.fallbackAccountKey)?options.fallbackAccountKey:null;
  return (context:Readonly<{subjectId:string}>,providerScope:string)=>{
    const binding=read().get(context.subjectId);
    // A subject without an entry can still read the company view, and the transport needs *a*
    // binding to talk to the supplier at all. The company key is the right one for that read: the
    // authorization decision already happened upstream, and own/ccount:* never get here.
    if(!binding){
      if(!fallback)return null;
      return Object.freeze({subjectId:context.subjectId,environmentId:options.environmentId,providerScope,bindingId:stableUuid(context.subjectId,fallback),revision:1,accountKey:fallback,status:'active' as const,expiresAtMs});
    }
    return Object.freeze({
      subjectId:context.subjectId,
      environmentId:options.environmentId,
      providerScope,
      bindingId:stableUuid(context.subjectId,binding.selfAccountKey),
      revision:1,
      accountKey:binding.selfAccountKey,
      status:'active' as const,
      expiresAtMs,
    });
  };
}

/**
 * The access view a subject actually has. `companyAccountKey` stays a parameter because the company
 * view key has no agreed source yet; without it, `scope=company` stays unavailable (`fail closed`)
 * rather than borrowing the subject's own key.
 */
export function accessFor(table:BindingTable,options:Readonly<{companyAccountKey?:string|null}>={}) {
  const company=typeof options.companyAccountKey==='string'&&ACCOUNT_KEY.test(options.companyAccountKey)?options.companyAccountKey:null;
  return (subjectId:string)=>{
    const binding=table.get(subjectId);
    return Object.freeze({
      ...(binding?{selfAccountKey:binding.selfAccountKey}:{}),
      ...(company?{companyAccountKey:company}:{}),
      grants:binding?binding.grantedAccountKeys:Object.freeze([] as string[]),
    });
  };
}
