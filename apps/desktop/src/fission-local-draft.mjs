// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import {createHash} from 'node:crypto';
import {lstat,open,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const fail=(code='local-draft-unavailable')=>{throw Object.assign(new Error(code),{code,status:503});};
const id=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const ownerKey=e=>digest(JSON.stringify([e.environmentId,e.subjectId]));
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const resultId=v=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\\/\x00-\x1f\x7f]/.test(v);
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
async function ordinary(p,directory){
 if(typeof p!=='string'||!path.isAbsolute(p)||path.normalize(p)!==p||p===path.parse(p).root)fail();
 for(let at=p;;at=path.dirname(at)){
  const s=await lstat(at);if(s.isSymbolicLink()||(at===p&&!directory&&(!s.isFile()||s.nlink!==1))||((at!==p||directory)&&!s.isDirectory()))fail();
  if(path.dirname(at)===at)break;
 }
 if(!same(await realpath(p),p))fail();
}
async function nativeImporter(){
 const entry=pathToFileURL(createRequire(import.meta.url).resolve('openfilm/studio'));
 return (await import(new URL('./fission-import.mjs',entry))).importFissionEditPlan;
}

/**
 * Creates a native Studio draft only for a selected completed local batch result.
 * getDraftSource is a trusted worker lookup; the caller supplies no filesystem paths.
 * Pending/unknown receipts are never retried automatically after a crash.
 */
export function createLocalFissionDraftService({assertSession,runNative,getDraftSource,findProject,approvedBaseRoot,ffprobePath,importPlan=nativeImporter}){
 if(![assertSession,runNative,getDraftSource,findProject,importPlan].every(f=>typeof f==='function')||typeof approvedBaseRoot!=='string'||!path.isAbsolute(approvedBaseRoot))fail();
 if(ffprobePath!==undefined&&(typeof ffprobePath!=='string'||!path.isAbsolute(ffprobePath)))fail();
 const assertSame=(expected,signal)=>{
  if(signal?.aborted)fail('local-draft-cancelled');
  let current;try{current=assertSession();}catch{fail('authentication-required');}
  if(current!==expected)fail('authentication-required');
 };
 return Object.freeze({
  /** Read only: never creates a receipt, project, or retry. */
  async status(raw,signal){
   if(!plain(raw)||Object.keys(raw).sort().join(',')!=='index,jobId'||!id(raw.jobId)||!Number.isSafeInteger(raw.index)||raw.index<0||raw.index>9999)fail('local-draft-invalid');
   const ref=Object.freeze({jobId:raw.jobId.toLowerCase(),index:raw.index});
   const session=assertSession();if(!plain(session)||typeof session.environmentId!=='string'||typeof session.subjectId!=='string'||!session.environmentId||!session.subjectId)fail('authentication-required');
   return runNative(async()=>{
    assertSame(session,signal);
    const source=await getDraftSource(session,ref);assertSame(session,signal);
    if(!plain(source)||typeof source.planPath!=='string'||typeof source.recordRoot!=='string'||!Array.isArray(source.sourceRoots)||!source.sourceRoots.length||source.sourceRoots.some(r=>typeof r!=='string'))fail();
    await ordinary(source.recordRoot,true);await ordinary(source.planPath,false);assertSame(session,signal);
    const bytes=await readFile(source.planPath);if(bytes.length>4*1024*1024)fail();const sha=digest(bytes);assertSame(session,signal);
    const recordFile=path.join(source.recordRoot,`.orange-draft-${ref.index}.json`);let stat;
    try{stat=await lstat(recordFile);}catch(error){if(error?.code==='ENOENT'){assertSame(session,signal);return {status:'not-started'};}fail();}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>16384)return {status:'needs-reconciliation'};
    let prior;try{await ordinary(recordFile,false);prior=JSON.parse(await readFile(recordFile,'utf8'));}catch{return {status:'needs-reconciliation'};}
    assertSame(session,signal);
    if(!plain(prior)||prior.version!==1||prior.owner!==ownerKey(session)||prior.jobId!==ref.jobId||prior.index!==ref.index||prior.planSha256!==sha||prior.status!=='ready'||!resultId(prior.projectId)||!Array.isArray(prior.blockingCapabilities)||prior.blockingCapabilities.some(x=>typeof x!=='string'))return {status:'needs-reconciliation'};
    const found=await findProject(prior.projectId);assertSame(session,signal);
    if(!found||found.id!==prior.projectId)return {status:'needs-reconciliation'};
    return {status:'ready',project:{id:prior.projectId},blockingCapabilities:prior.blockingCapabilities,exportReady:false,equivalenceVerified:false};
   });
  },
  async importSelected(raw,signal){
   if(!plain(raw)||Object.keys(raw).sort().join(',')!=='index,jobId'||!id(raw.jobId)||!Number.isSafeInteger(raw.index)||raw.index<0||raw.index>9999)fail('local-draft-invalid');
   const ref=Object.freeze({jobId:raw.jobId.toLowerCase(),index:raw.index});
   const session=assertSession();if(!plain(session)||typeof session.environmentId!=='string'||typeof session.subjectId!=='string'||!session.environmentId||!session.subjectId)fail('authentication-required');
   return runNative(async()=>{
    assertSame(session,signal);
    const source=await getDraftSource(session,ref);assertSame(session,signal);
    if(!plain(source)||typeof source.planPath!=='string'||typeof source.recordRoot!=='string'||!Array.isArray(source.sourceRoots)||!source.sourceRoots.length||source.sourceRoots.some(r=>typeof r!=='string'))fail();
    await ordinary(source.recordRoot,true);await ordinary(source.planPath,false);assertSame(session,signal);
    const bytes=await readFile(source.planPath);if(bytes.length>4*1024*1024)fail();const sha=digest(bytes);assertSame(session,signal);
    const recordFile=path.join(source.recordRoot,`.orange-draft-${ref.index}.json`),owner=ownerKey(session);
    const initial={version:1,owner,jobId:ref.jobId,index:ref.index,planSha256:sha,status:'pending',projectId:null,blockingCapabilities:[]};
    let handle;
    try{handle=await open(recordFile,'wx',0o600);}catch(error){
     if(error?.code!=='EEXIST')fail();
     let prior;try{await ordinary(recordFile,false);const b=await readFile(recordFile);if(b.length>16384)fail();prior=JSON.parse(b);}catch{ return {status:'needs-reconciliation'}; }
     assertSame(session,signal);
     if(!plain(prior)||prior.version!==1||prior.owner!==owner||prior.jobId!==ref.jobId||prior.index!==ref.index||prior.planSha256!==sha||prior.status!=='ready'||!resultId(prior.projectId)||!Array.isArray(prior.blockingCapabilities)||prior.blockingCapabilities.some(x=>typeof x!=='string'))return {status:'needs-reconciliation'};
     const found=await findProject(prior.projectId);assertSame(session,signal);
     if(!found||found.id!==prior.projectId)return {status:'needs-reconciliation'};
     return {status:'ready',project:{id:prior.projectId},blockingCapabilities:prior.blockingCapabilities,exportReady:false,equivalenceVerified:false};
    }
    try{await handle.writeFile(JSON.stringify(initial)+'\n');await handle.sync();}finally{await handle.close();}
    assertSame(session,signal);
    const importer=await importPlan();assertSame(session,signal);
    const made=await importer(bytes,{name:'Fission 草稿',sourceRoots:source.sourceRoots,approvedBaseRoot,internalDraft:true,nativeAudioProfile:'fission-v1',...(ffprobePath?{ffprobePath}:{})});
    assertSame(session,signal);
    if(!made||!resultId(made.project?.id)||!Array.isArray(made.blockingCapabilities)||made.blockingCapabilities.some(x=>typeof x!=='string'))fail();
    await ordinary(source.planPath,false);if(digest(await readFile(source.planPath))!==sha)fail('local-draft-source-changed');
    assertSame(session,signal);
    // Only the process that created the pending record may replace it. A failed
    // replace leaves pending/unknown rather than creating another draft on retry.
    const temp=recordFile+'.'+process.pid+'.tmp';let out;
    try{out=await open(temp,'wx',0o600);await out.writeFile(JSON.stringify({...initial,status:'ready',projectId:made.project.id,blockingCapabilities:made.blockingCapabilities})+'\n');await out.sync();await out.close();out=null;assertSame(session,signal);const {rename}=await import('node:fs/promises');await rename(temp,recordFile);}
    finally{if(out)await out.close();}
    assertSame(session,signal);
    return {status:'ready',project:{id:made.project.id},blockingCapabilities:made.blockingCapabilities,exportReady:false,equivalenceVerified:false};
   });
  },
 });
}
