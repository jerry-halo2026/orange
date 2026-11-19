// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The binding store: the mapping from *our* user to a cloud-steward account.
 *
 * This is a mapping, not a permission. The cloud token is company-level and carries no user
 * identity (contract §9.2/§10), so identity has to come from an `account_key`; a claim records which
 * one belongs to which subject. Authorization still happens in `authorization.ts` on every read.
 *
 * Modes:
 *  - `server` (default): the service owns the file named by `MATERIALS_BINDINGS` and writes claims
 *    into it. Writes are atomic (temp file with `wx` + `rename`), mode 0600, and serialized inside
 *    the process so two claims cannot interleave.
 *  - `local`: read-only, for development. Claims and releases are refused instead of silently
 *    writing.
 *
 * A released or replaced binding is never deleted from the record: it moves to `history`, so the
 * trail of who was bound to what survives.
 */
import {randomBytes} from 'node:crypto';
import {writeFile, rename, rm} from 'node:fs/promises';
import {fail} from './errors.ts';
import type {BindingDocument, BindingHistoryEntry, BindingTable, SubjectBinding} from './bindings.ts';

export type BindingMode='server'|'local';
export type ClaimInput=Readonly<{account:string;accountKey:string;teamId?:number;groupId?:number}>;
export type PublicBinding=Readonly<{
  account:string|null;
  accountKey:string;
  teamId:number|null;
  groupId:number|null;
  boundAt:string|null;
  status:'claimed';
}>;

export type BindingService=Readonly<{
  mode:BindingMode;
  table():BindingTable;
  history():readonly BindingHistoryEntry[];
  read(subjectId:string):PublicBinding|null;
  claim(subjectId:string,input:ClaimInput):Promise<PublicBinding>;
  release(subjectId:string):Promise<boolean>;
}>;

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

const publicOf=(binding:SubjectBinding):PublicBinding=>Object.freeze({
  account:binding.account??null,
  accountKey:binding.selfAccountKey,
  teamId:typeof binding.teamId==='number'?binding.teamId:null,
  groupId:typeof binding.groupId==='number'?binding.groupId:null,
  boundAt:binding.boundAt??null,
  status:'claimed' as const,
});

export function createBindingService(options:Readonly<{
  mode:BindingMode;
  /** `null` means there is no file to write: claims are refused instead of living in memory only. */
  file:string|null;
  initial?:BindingDocument;
  now?:()=>number;
}>):BindingService {
  const now=options.now??Date.now;
  const iso=()=>new Date(now()).toISOString();
  const table=new Map<string,SubjectBinding>(options.initial?.bindings??[]);
  const history:BindingHistoryEntry[]=[...(options.initial?.history??[])];
  let queue:Promise<unknown>=Promise.resolve();

  /** Serialize writes: each one waits for the previous, so two claims cannot interleave. */
  const serialize=<T>(work:()=>Promise<T>):Promise<T>=>{
    const next=queue.then(work,work);
    queue=next.catch(()=>undefined);
    return next;
  };

  async function persist():Promise<void>{
    const file=options.file;
    if(!file)return fail('binding-store-unavailable',503);
    const document={
      version:1 as const,
      bindings:Object.fromEntries([...table.entries()].map(([subjectId,binding])=>[subjectId,{
        account:binding.account,
        boundAt:binding.boundAt,
        grantedAccountKeys:binding.grantedAccountKeys,
        groupId:binding.groupId,
        selfAccountKey:binding.selfAccountKey,
        status:binding.status,
        teamId:binding.teamId,
      }])),
      ...(history.length?{history}:{}),
    };
    const bytes=JSON.stringify(document,null,2);
    const temporary=file+'.tmp-'+randomBytes(4).toString('hex');
    try{
      // `wx` + 0600, then rename: a reader sees either the old file or the whole new one.
      await writeFile(temporary,bytes,{flag:'wx',mode:0o600});
      await rename(temporary,file);
    }catch{
      await rm(temporary,{force:true}).catch(()=>{});
      return fail('binding-store-write-failed',500);
    }
  }

  const writable=()=>{
    if(options.mode!=='server')return fail('binding-store-readonly',409);
    if(!options.file)return fail('binding-store-unavailable',503);
  };

  return Object.freeze({
    mode:options.mode,
    table:()=>new Map(table) as BindingTable,
    history:()=>Object.freeze([...history]),
    read(subjectId:string){
      if(!UUID.test(subjectId))return null;
      const binding=table.get(subjectId);
      return binding?publicOf(binding):null;
    },
    async claim(subjectId:string,input:ClaimInput):Promise<PublicBinding>{
      writable();
      if(!UUID.test(subjectId))return fail('invalid-query',422);
      if(typeof input?.accountKey!=='string'||!input.accountKey.length)return fail('invalid-query',422);
      return serialize(async()=>{
        const previous=table.get(subjectId);
        const claimedAt=iso();
        if(previous&&previous.selfAccountKey!==input.accountKey){
          history.push(Object.freeze({
            account:previous.account??null,
            accountKey:previous.selfAccountKey,
            boundAt:previous.boundAt??null,
            reason:'rebound',
            releasedAt:claimedAt,
            subjectId,
          }));
        }
        const binding:SubjectBinding=Object.freeze({
          selfAccountKey:input.accountKey,
          grantedAccountKeys:previous?.grantedAccountKeys??Object.freeze([] as string[]),
          account:input.account,
          ...(typeof input.teamId==='number'?{teamId:input.teamId}:{}),
          ...(typeof input.groupId==='number'?{groupId:input.groupId}:{}),
          boundAt:claimedAt,
          status:'claimed' as const,
        });
        table.set(subjectId,binding);
        try{await persist();}
        catch(error){ // keep memory and disk in step
          if(previous)table.set(subjectId,previous);else table.delete(subjectId);
          throw error;
        }
        return publicOf(binding);
      });
    },
    async release(subjectId:string):Promise<boolean>{
      writable();
      if(!UUID.test(subjectId))return fail('invalid-query',422);
      return serialize(async()=>{
        const previous=table.get(subjectId);
        if(!previous)return false;
        history.push(Object.freeze({
          account:previous.account??null,
          accountKey:previous.selfAccountKey,
          boundAt:previous.boundAt??null,
          reason:'released',
          releasedAt:iso(),
          subjectId,
        }));
        table.delete(subjectId);
        try{await persist();}
        catch(error){table.set(subjectId,previous);throw error;}
        return true;
      });
    },
  });
}
