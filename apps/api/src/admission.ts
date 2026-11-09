import { createHash } from 'node:crypto';
import { isVerifiedSession, type VerifiedSession } from './supabase.ts';

export class BusinessError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 422) { super(code); this.code = code; this.status = status; }
}
const fail = (code = 'invalid-prepared-plan'): never => { throw new BusinessError(code); };
const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  return value as Record<string, any>;
};
const exact = (value: unknown, names: string[]) => {
  const v = record(value);
  if (Object.keys(v).length !== names.length || names.some(n => !Object.hasOwn(v, n))) fail();
  return v;
};
const text = (v: unknown, max = 512): string => {
  if (typeof v !== 'string' || !v || v.length > max || /[\x00-\x1f]/.test(v)) return fail();
  return v;
};
const number = (v: unknown, min = 0, max = 1e12): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return fail();
  return v === 0 ? 0 : v;
};
const integer = (v: unknown, min = 0, max = 10000) => {
  const n = number(v, min, max); if (!Number.isSafeInteger(n)) fail(); return n;
};
const uuid = (v: unknown) => {
  const s = text(v); if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(s)) return fail(); return s.toLowerCase();
};
const digest = (v: unknown) => { const s = text(v); if (!/^[a-f0-9]{64}$/.test(s)) fail(); return s; };
const bool = (v: unknown): boolean => { if (typeof v !== 'boolean') return fail(); return v; };
const list = (v: unknown, max = 10000): any[] => { if (!Array.isArray(v) || v.length > max) return fail(); return v; };

/** Internal fingerprint bytes, not an IO/Timeline replacement. Seconds remain IEEE754 seconds. */
export function canonicalBytes(value: unknown): Buffer {
  const chunks: Buffer[] = [];
  const length = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); chunks.push(b); };
  const visit = (v: unknown, depth: number) => {
    if (depth > 64) fail('canonical-depth');
    if (v === null) { chunks.push(Buffer.from([0])); return; }
    if (v === false || v === true) { chunks.push(Buffer.from([v ? 2 : 1])); return; }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail('nonfinite-number');
      const b = Buffer.alloc(9); b[0] = 3; b.writeDoubleBE(v === 0 ? 0 : v, 1); chunks.push(b); return;
    }
    if (typeof v === 'string') {
      // Reject lone UTF16 surrogates rather than encode different replacement bytes in another runtime.
      if ([...v].some(c => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; })) fail('invalid-unicode');
      const b = Buffer.from(v, 'utf8'); chunks.push(Buffer.from([4])); length(b.length); chunks.push(b); return;
    }
    if (Array.isArray(v)) { chunks.push(Buffer.from([5])); length(v.length); for (const x of v) visit(x, depth + 1); return; }
    const o = record(v), keys = Object.keys(o).sort();
    // Native job/config field names are ASCII. Do not guess cross-collation object-key ordering.
    if (keys.some(k => !/^[\x20-\x7e]+$/.test(k))) fail('nonascii-field-name');
    chunks.push(Buffer.from([6])); length(keys.length);
    for (const k of keys) { visit(k, depth + 1); visit(o[k], depth + 1); }
  };
  visit(value, 0); return Buffer.concat(chunks);
}
export const requestDigest = (v: unknown) => createHash('sha256').update(canonicalBytes(v)).digest('hex');

export function contentParts(input: unknown): unknown[] {
  const p = exact(input, ['version','projectId','filmRev','job','durationSec','aspect','fps','materials','scenes','audio','captions','transition']);
  if (p.version !== 1) fail('unknown-prepared-version');
  text(p.projectId); if (!/^[a-f0-9]{16}$/.test(text(p.filmRev))) fail('invalid-native-revision');
  const job = record(p.job); canonicalBytes(job); // Original PascalCase FissionJob, not another Job DTO.
  if (typeof job.VideoDir !== 'string' || !job.VideoDir || job.OutFps !== p.fps) fail();
  const duration = number(p.durationSec, Number.MIN_VALUE), fps = integer(p.fps, 1, 240);
  const aspect = list(p.aspect, 2); if (aspect.length !== 2) fail();
  let w = integer(aspect[0], 1, 16384), h = integer(aspect[1], 1, 16384);
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const d = gcd(w, h); w /= d; h /= d;
  if (number(job.OutWidth, 1, 16384) / number(job.OutHeight, 1, 16384) !== w / h) fail();
  const materials = new Map<string, Record<string, any>>();
  for (const raw of list(p.materials)) {
    const m = exact(raw, ['versionId','contentSha256','kind','durationSec']), id = uuid(m.versionId);
    digest(m.contentSha256); if (!['video','still','sound'].includes(m.kind)) fail(); number(m.durationSec, m.kind === 'still' ? 0 : Number.MIN_VALUE); if(m.kind === 'still' && m.durationSec !== 0) fail('invalid-still-intrinsic-duration');
    if (materials.has(id)) fail(); materials.set(id, m);
  }
  const used = new Set<string>();
  const source = (id: unknown, kinds: string[]) => {
    const key = uuid(id), m = materials.get(key); if (!m || !kinds.includes(m.kind)) return fail(); used.add(key); return m;
  };
  const visuals: unknown[] = []; let ordinal = -1, lastEnd = 0;
  for (const raw of list(p.scenes)) {
    const s = exact(raw, ['ordinal','name','clips']), current = integer(s.ordinal);
    text(s.name); if (current <= ordinal) fail('unordered-scenes'); ordinal = current;
    for (const rawClip of list(s.clips)) {
      const c = exact(rawClip, ['versionId','fromSec','toSec','atSec','speed','hflip','framing']);
      const m = source(c.versionId, ['video','still']), from = number(c.fromSec), to = number(c.toSec), at = number(c.atSec), speed = number(c.speed, 0.1, 100);
      if (to <= from || (m.kind === 'still' ? from !== 0 : to > m.durationSec) || at < lastEnd - 1e-9 || at + (to - from) / speed > duration + 1e-9) fail('invalid-effective-seconds');
      if (!['cover-center','contain-center'].includes(c.framing)) fail('unsupported-framing');
      lastEnd = at + (to - from) / speed;
      visuals.push([m.contentSha256, m.kind, from, to, at, speed, bool(c.hflip), c.framing]);
    }
  }
  if (!visuals.length) fail();
  const audio = exact(p.audio, ['voice','music','postmix']);
  const track = (raw: unknown, voice: boolean): unknown[] => {
    const a = exact(raw, ['versionId','fromSec','toSec','volume','loop']), m = source(a.versionId, ['sound']);
    const from = number(a.fromSec), to = number(a.toSec); if (to <= from || to > m.durationSec) fail();
    if (voice && bool(a.loop)) fail();
    return [m.contentSha256, from, to, number(a.volume, 0, 2), bool(a.loop)];
  };
  const voice = track(audio.voice, true), music = audio.music === null ? null : track(audio.music, false);
  const post = exact(audio.postmix, ['kind','integratedLUFS','truePeakDBTP','loudnessRangeLU']);
  if (post.kind !== 'loudnorm' || post.integratedLUFS !== -14 || post.truePeakDBTP !== -1.5 || post.loudnessRangeLU !== 11) fail('unsupported-postmix');
  let captions: unknown = null;
  if (p.captions !== null) {
    const c = exact(p.captions, ['style','cues']); const cues: unknown[] = []; let end = 0;
    for (const raw of list(c.cues)) { const q = exact(raw, ['fromSec','toSec','text']), from = number(q.fromSec), to = number(q.toSec); if (from < end || to <= from || to > duration) fail(); end = to; cues.push([from,to,text(q.text,100000)]); }
    captions = [text(c.style,100000),cues];
  } else if (job.SubtitleEnabled === true) fail('subtitle-not-prepared');
  let transition: unknown = null;
  if (p.transition !== null) {
    const t = exact(p.transition, ['name','durationSec','shaderSha256']); transition = [text(t.name),number(t.durationSec,Number.MIN_VALUE,duration),digest(t.shaderSha256)];
  } else if (typeof job.TransitionSec === 'number' && job.TransitionSec > 0) fail('transition-not-prepared');
  if (used.size !== materials.size) fail('dependency-closure-mismatch');
  return ['orange-content',1,w,h,fps,duration,visuals,voice,music,['loudnorm',-14,-1.5,11],captions,transition];
}
export const contentKey = (p: unknown) => requestDigest(contentParts(p));

type Rpc = (operation: string, args: Record<string, unknown>) => Promise<any>;
type Request = {groupId: string; projectId: string; filmRev: string; job: Record<string, unknown>; idempotencyKey: string};
type Dependencies = {
  rpc: Rpc;
  prepare?: (context: VerifiedSession, request: Readonly<Request>, resolve: (ids: string[]) => Promise<any>) => Promise<unknown>;
  verifyDelivery?: (context: VerifiedSession, claimId: string, report: unknown) => Promise<{evidenceId:string;kind:'video'|'nle';contentKey:string;digest:string}>;
};
const authority = (ctx: unknown) => {
  if (!isVerifiedSession(ctx)) throw new BusinessError('authentication-required', 403);
  const c = ctx as VerifiedSession;
  return {p_actor:c.subjectId,p_session:c.sessionId,p_until:new Date(c.expiresAtMs).toISOString()};
};
function claimReply(value:any,allowDuplicate=false):any {
  try {
    if(allowDuplicate&&value?.status==='duplicate'){exact(value,['status']);return value;}
    const r=exact(value,['claimId','planId','status','contentKey','historyCount','executionReady','frozenPlan']);
    uuid(r.claimId);uuid(r.planId);
    if(!['reserved','running','unknown','cancel-requested','succeeded'].includes(r.status)||![0,1].includes(r.historyCount)||r.executionReady!==false||contentKey(r.frozenPlan)!==r.contentKey)throw 0;
    return r;
  }catch{throw new BusinessError('backend-unconfirmed',503);}
}
export function createAdmission(deps: Dependencies) {
  const resolve = async (ctx: unknown, ids: string[], purpose: 'studio'|'fission'|'export' = 'fission') => {
    const auth=authority(ctx);if(!Array.isArray(ids)||ids.length<1||ids.length>10000)fail('invalid-input');const versions=ids.map(uuid);
    const materials=await deps.rpc('resolve_materials',{...auth,p_ids:versions,p_purpose:purpose});
    if(!Array.isArray(materials)||materials.length!==versions.length||materials.some((m:any,i:number)=>m?.versionId?.toLowerCase()!==versions[i]||!['still','video','sound'].includes(m.kind)||typeof m.durationSec!=='number'||!Number.isFinite(m.durationSec)||(m.kind==='still'?m.durationSec!==0:m.durationSec<=0)))throw new BusinessError('backend-unconfirmed',503);
    return materials;
  };
  const preparedIndexArgs=(ctx:unknown,raw:unknown,index:number)=>{
    const auth=authority(ctx),r=exact(raw,['groupId','projectId','filmRev','job','idempotencyKey','sourceSelection']);
    const request={groupId:uuid(r.groupId),projectId:text(r.projectId),filmRev:text(r.filmRev),job:record(r.job),idempotencyKey:text(r.idempotencyKey,120),sourceSelection:record(r.sourceSelection)};
    if(!/^[a-f0-9]{16}$/.test(request.filmRev))fail('invalid-native-revision');integer(index,0,9999);
    return {request,args:{...auth,p_group:request.groupId,p_key:requestDigest(['orange-fission-index',1,request.idempotencyKey,index]),p_request_hash:requestDigest(request)}};
  };
  return {
    integration: Object.freeze({workerPreparation:deps.prepare?'adapter-configured':'not-connected',deliveryVerifier:deps.verifyDelivery?'adapter-configured':'not-connected',executionReady:false}),
    resolve,
    async preflightPreparedOutput(ctx:unknown,raw:unknown,index:number){
      const {args}=preparedIndexArgs(ctx,raw,index),previous=await deps.rpc('preflight',args);
      if(previous?.status==='prepare-required'&&Object.keys(previous).length===1)return previous;
      return claimReply(previous,true);
    },
    async claimPreparedOutput(ctx:unknown,raw:unknown,index:number,prepared:unknown){
      const {request,args}=preparedIndexArgs(ctx,raw,index),p=record(prepared);contentParts(p);
      if(p.projectId!==request.projectId||p.filmRev!==request.filmRev||requestDigest(p.job)!==requestDigest(request.job))fail('prepared-input-mismatch');
      const previous=await deps.rpc('preflight',args);if(previous?.status!=='prepare-required')return claimReply(previous,true);
      return claimReply(await deps.rpc('freeze_claim',{...args,p_plan:p,p_content_key:contentKey(p)}),true);
    },
    async prepareAndClaim(ctx: unknown, raw: unknown) {
      const auth = authority(ctx), r = exact(raw, ['groupId','projectId','filmRev','job','idempotencyKey']);
      const request: Request = {groupId:uuid(r.groupId),projectId:text(r.projectId),filmRev:text(r.filmRev),job:record(r.job),idempotencyKey:text(r.idempotencyKey,120)};
      if (!/^[a-f0-9]{16}$/.test(request.filmRev)) fail('invalid-native-revision');
      const hash = requestDigest(request), args = {...auth,p_group:request.groupId,p_key:request.idempotencyKey,p_request_hash:hash};
      const previous = await deps.rpc('preflight', args);
      if (previous?.status !== 'prepare-required') return claimReply(previous,true);
      if (!deps.prepare) throw new BusinessError('trusted-preparation-unavailable', 503);
      const prepared = await deps.prepare(ctx as VerifiedSession, Object.freeze(structuredClone(request)), ids=>resolve(ctx,ids));
      const p = record(prepared); contentParts(p);
      if (p.projectId !== request.projectId || p.filmRev !== request.filmRev || requestDigest(p.job) !== requestDigest(request.job)) fail('prepared-input-mismatch');
      return claimReply(await deps.rpc('freeze_claim', {...args,p_plan:p,p_content_key:contentKey(p)}),true);
    },
    status: async (ctx: unknown, claimId: string) => claimReply(await deps.rpc('claim_status', {...authority(ctx),p_claim:uuid(claimId)})),
    start: async (ctx: unknown, claimId: string, nonce: string) => claimReply(await deps.rpc('start_attempt', {...authority(ctx),p_claim:uuid(claimId),p_nonce:uuid(nonce)})),
    cancel: async (ctx: unknown, claimId: string) => claimReply(await deps.rpc('cancel_claim', {...authority(ctx),p_claim:uuid(claimId)})),
    unknown: async (ctx: unknown, claimId: string) => claimReply(await deps.rpc('mark_unknown', {...authority(ctx),p_claim:uuid(claimId)})),
    async delivery(ctx: unknown, claimId: string, received: unknown) {
      const auth = authority(ctx); uuid(claimId);
      if (!deps.verifyDelivery) throw new BusinessError('trusted-delivery-verifier-unavailable',503);
      const e = await deps.verifyDelivery(ctx as VerifiedSession,claimId,received);
      return claimReply(await deps.rpc('record_delivery',{...auth,p_claim:claimId,p_evidence:uuid(e.evidenceId),p_kind:e.kind,p_content_key:digest(e.contentKey),p_digest:digest(e.digest)}));
    },
  };
}
// The following is a pure mapper, not a worker/stager, rights producer, or claim entry point.
type ResolvedMappingMaterial = Readonly<{versionId:string;contentSha256:string;kind:string;durationSec:number}>;
type PrivateStagingAssociation = Readonly<{filePath:string;fileIdentity:string;contentSha256:string;resolvedMeta:ResolvedMappingMaterial}>;
const mappingPending = (code:string):never => {throw new BusinessError(code,422);};
function freezeMapped<T>(value:T):T {
 if(value&&typeof value==='object'){for(const child of Object.values(value))freezeMapped(child);Object.freeze(value);}return value;
}
/** Consume only original PREPARE output facts. The trusted caller must bind the
 * actual job/digest, hold real source capabilities and later run fresh SQL rights.
 * Snapshot headers/associations here are data checks, never proof of a grant.
 */
export async function mapPreparedFissionOutput(nativeSnapshot:unknown, outputIndex:number,
 context:Readonly<{projectId:string;filmRev:string;job:Readonly<Record<string,unknown>>}>, staging:readonly PrivateStagingAssociation[]):Promise<Readonly<Record<string,unknown>>> {
 try {
  const snapshot=exact(nativeSnapshot,['schemaVersion','jobId','jobSha256','workRoot','outRoot','cacheRoot','runtimeSha256','outputs','versions','digest','authorizesBusiness','measuredAssemblyClock']);
  if(snapshot.schemaVersion!==1||snapshot.authorizesBusiness!==false||snapshot.measuredAssemblyClock!==false)mappingPending('native-preparation-invalid');
  digest(snapshot.jobSha256);digest(snapshot.runtimeSha256);digest(snapshot.digest);text(snapshot.jobId);
  for(const key of ['workRoot','outRoot','cacheRoot'])text(snapshot[key]);
  const outputs=list(snapshot.outputs),indices=outputs.map(o=>integer(record(o).index));
  if(!outputs.length||new Set(indices).size!==outputs.length||!Number.isSafeInteger(outputIndex))mappingPending('native-output-index-invalid');
  const matches=outputs.filter(o=>o.index===outputIndex);if(matches.length!==1)mappingPending('native-output-index-invalid');
  const output=exact(matches[0],['index','title','voicePath','musicPath','targetSec','audio','audioItem','selectedVideos','sources','cuts','alignmentIntent','transitionIntent','subtitleIntent','consumeVideoPaths','generatedVoice']);
  const originalContext=exact(context,['projectId','filmRev','job']);text(originalContext.projectId);if(!/^[a-f0-9]{16}$/.test(text(originalContext.filmRev)))mappingPending('native-project-binding-invalid');
  const job=record(originalContext.job),fps=integer(job.OutFps,1,240);integer(job.OutWidth,1,16384);integer(job.OutHeight,1,16384);
  const sources=list(output.sources),cuts=list(output.cuts);if(!sources.length||!cuts.length)mappingPending('native-preparation-invalid');
  const versions=new Map<string,Record<string,any>>();
  for(const raw of list(snapshot.versions,100000)){
   const v=exact(raw,['path','sha256','owned','identity']);text(v.path,32768);digest(v.sha256);bool(v.owned);
   if(!/^[a-f0-9]{8}:[a-f0-9]{16}:[a-f0-9]{16}:[a-f0-9]{16}$/.test(text(v.identity)))mappingPending('native-file-identity-invalid');
   if(versions.has(v.path))mappingPending('native-version-ambiguous');versions.set(v.path,v);
  }
  const version=(file:unknown,sha:unknown)=>{const p=text(file,32768),v=versions.get(p);if(!v||v.sha256!==digest(sha))mappingPending('native-version-unbound');return v!;};
  for(const raw of sources){const s=exact(raw,['path','sha256','kind','durationSec']);if(!['video','still','sound'].includes(s.kind))mappingPending('native-source-kind-invalid');number(s.durationSec,s.kind==='still'?0:Number.MIN_VALUE);if(s.kind==='still'&&s.durationSec!==0)mappingPending('native-still-intrinsic-invalid');version(s.path,s.sha256);}
  const audio=exact(output.audio,['voice','music','loudnorm']),voiceFacts=record(audio.voice),voiceIndex=integer(voiceFacts.source,0,sources.length-1),voiceSource=sources[voiceIndex];
  const voiceItem=exact(output.audioItem,['path','group','durationSec','isImage']);number(voiceItem.durationSec,Number.MIN_VALUE);
  if(voiceSource.kind!=='sound'||voiceItem.path!==output.voicePath||voiceItem.isImage!==false||typeof voiceItem.group!=='string')mappingPending('native-audio-source-mismatch');
  version(output.voicePath,voiceSource.sha256);
  if(audio.music===null){if(output.musicPath!==null)mappingPending('native-audio-source-mismatch');}
  else {const musicFacts=record(audio.music),musicIndex=integer(musicFacts.source,0,sources.length-1);if(output.musicPath!==sources[musicIndex].path)mappingPending('native-audio-source-mismatch');}
  if(output.generatedVoice!==null){
   const generated=exact(output.generatedVoice,['path','proofPath','proofSha256','purpose']);
   if(generated.purpose!=='native-offline-lavfi-voice/v1'||generated.path!==output.voicePath||voiceSource.path!==generated.path
    ||!generated.path.startsWith(snapshot.workRoot+'\\'+snapshot.jobId+'\\voice\\')||!/[\\/]gen_[0-9]{3,}\.mp3$/.test(generated.path)
    ||generated.proofPath!==generated.path+'.prepared-generated.json'||!version(generated.path,voiceSource.sha256).owned
    ||!version(generated.proofPath,generated.proofSha256).owned)mappingPending('native-generated-origin-invalid');
  }
  const visuals=cuts.map(raw=>{
   const cut=exact(raw,['decision','normalization']),v=exact(cut.decision,['source','role','group','startSec','durationSec','speed','hflip']),n=exact(cut.normalization,['source','path','sha256','durationSec','imageHoldSec']);
   const i=integer(v.source,0,sources.length-1);if(!['video','still'].includes(sources[i].kind)||!['intro','main','outro'].includes(v.role)||n.source!==i)mappingPending('native-cut-invalid');text(v.group||v.role);number(v.startSec);number(v.durationSec,Number.MIN_VALUE);number(v.speed,Number.MIN_VALUE);bool(v.hflip);number(n.durationSec,Number.MIN_VALUE);if(!version(n.path,n.sha256).owned)mappingPending('native-cut-invalid');
   if(v.startSec+v.durationSec>n.durationSec+.001)mappingPending('native-cut-invalid');
   if(sources[i].kind==='still'){number(n.imageHoldSec,Number.MIN_VALUE);if(Math.abs(n.imageHoldSec-n.durationSec)>1/fps)mappingPending('native-still-hold-invalid');}else if(n.imageHoldSec!==null)mappingPending('native-cut-invalid');
   return v;
  });
  const alignment=exact(output.alignmentIntent,['action','inputDurationSec','outputDurationSec','tempo','loops']);
  if(!['trim','speed','loop'].includes(alignment.action))mappingPending('native-alignment-unsupported');number(alignment.inputDurationSec,Number.MIN_VALUE);number(alignment.outputDurationSec,Number.MIN_VALUE);number(alignment.tempo,Number.MIN_VALUE);integer(alignment.loops,1,10000);
  if(Math.abs(visuals.reduce((sum,v)=>sum+v.durationSec/v.speed,0)-alignment.inputDurationSec)>1/fps)mappingPending('native-alignment-clock-invalid');
  if(alignment.action==='trim'&&(alignment.tempo!==1||alignment.loops!==1||alignment.outputDurationSec>alignment.inputDurationSec+1/fps)
   ||alignment.action==='speed'&&(alignment.loops!==1||Math.abs(alignment.tempo-alignment.inputDurationSec/alignment.outputDurationSec)>1e-9)
   ||alignment.action==='loop'&&(alignment.tempo!==1||alignment.loops!==Math.ceil(alignment.outputDurationSec/alignment.inputDurationSec)))mappingPending('native-alignment-invalid');
  // Computed fixed local import keeps the original JSDoc helper authoritative;
  // results cross the JS/TS boundary only after explicit runtime checks below.
  const helper=await import(new URL('../../../packages/openfilm/src/fission-timing.mjs',import.meta.url).href);
  if(typeof helper.alignedVisualSpans!=='function')mappingPending('native-timing-unavailable');
  const timing=exact(helper.alignedVisualSpans({durationSec:alignment.outputDurationSec,alignment,visuals,sources}),['target','spans']);
  const duration=number(timing.target,Number.MIN_VALUE);if(duration!==alignment.outputDurationSec)mappingPending('native-timing-invalid');
  if(!Array.isArray(staging))mappingPending('native-staging-unavailable');
  const materialCache=new Map<number,ResolvedMappingMaterial>(),used=new Map<string,ResolvedMappingMaterial>();
  const material=(index:number)=>{
   if(materialCache.has(index))return materialCache.get(index)!;const s=sources[index];if(!s)mappingPending('native-source-index-invalid');const v=version(s.path,s.sha256);
   const found=staging.filter(row=>row.filePath===s.path&&row.fileIdentity===v.identity&&row.contentSha256===s.sha256);if(found.length!==1)mappingPending('native-staging-association-unavailable');
   const m=exact(found[0].resolvedMeta,['versionId','contentSha256','kind','durationSec']);const id=uuid(m.versionId);digest(m.contentSha256);number(m.durationSec,m.kind==='still'?0:Number.MIN_VALUE);
   if(m.contentSha256!==s.sha256||m.kind!==s.kind||m.kind==='still'&&m.durationSec!==0)mappingPending('native-material-version-mismatch');
   const copied={versionId:id,contentSha256:m.contentSha256,kind:m.kind,durationSec:m.durationSec};
   const prior=used.get(id);if(prior&&requestDigest(prior)!==requestDigest(copied))mappingPending('native-material-version-ambiguous');used.set(id,copied);materialCache.set(index,copied);return copied;
  };
  let end=0;const scenes=list(timing.spans).map((raw,ordinal)=>{
   const span=exact(raw,['visualIndex','source','at','length','rate','fromSec','toSec','still','hflip']),cut=visuals[integer(span.visualIndex,0,visuals.length-1)];
   const i=integer(span.source,0,sources.length-1);if(i!==cut.source||bool(span.hflip)!==cut.hflip||bool(span.still)!==(sources[i].kind==='still'))mappingPending('native-timing-invalid');
   const at=number(span.at),length=number(span.length,Number.MIN_VALUE),rate=number(span.rate,Number.MIN_VALUE),from=number(span.fromSec),to=number(span.toSec);
   if(to<=from||at<end-1e-9||at+length>duration+1e-9)mappingPending('native-timing-invalid');end=at+length;const m=material(i);
   if(m.kind!=='still'&&to>m.durationSec)mappingPending('native-source-frame-boundary-pending');
   return {ordinal,name:cut.role+':'+cut.group,clips:[{versionId:m.versionId,fromSec:from,toSec:to,atSec:at,speed:span.still?1:rate,hflip:span.hflip,framing:'contain-center'}]};
  });
  const track=(raw:unknown,voice:boolean)=>{const a=exact(raw,['source','volume','loop']),i=integer(a.source,0,sources.length-1),m=material(i);if(m.kind!=='sound'||voice&&bool(a.loop))mappingPending('native-audio-unsupported');return{versionId:m.versionId,fromSec:0,toSec:m.durationSec,volume:number(a.volume,0,2),loop:bool(a.loop)};};
  const voice=track(audio.voice,true),music=audio.music===null?null:track(audio.music,false),loudnorm=exact(audio.loudnorm,['integratedLUFS','truePeakDBTP','loudnessRangeLU']);
  if(loudnorm.integratedLUFS!==-14||loudnorm.truePeakDBTP!==-1.5||loudnorm.loudnessRangeLU!==11)mappingPending('native-audio-unsupported');
  const subtitle=exact(output.subtitleIntent,['requested','outcome','timingSource','cues','style']);bool(subtitle.requested);if(subtitle.timingSource!=='sentence-weighted-approximation')mappingPending('native-subtitle-unsupported');
  let captions:unknown=null;
  if(subtitle.requested){
   if(subtitle.outcome!=='prepared-intent'||!subtitle.style)mappingPending('native-subtitle-preparation-pending');
   const style=exact(subtitle.style,['preset','position','fontSize','assStyle','fadeInSec','fadeOutSec']);
   if(!['white-outline','yellow-outline','white-box','center-bold'].includes(style.preset)||!['top','middle','bottom'].includes(style.position)||style.fadeInSec!==.12||style.fadeOutSec!==.12)mappingPending('native-subtitle-unsupported');integer(style.fontSize,20,160);text(style.assStyle,100000);
   let last=0;const cues=list(subtitle.cues).map(raw=>{const c=exact(raw,['startSec','endSec','text']),from=number(c.startSec),to=number(c.endSec);if(to<=from||from<last)mappingPending('native-subtitle-unsupported');last=to;return{fromSec:from,toSec:Math.min(to,duration),text:text(c.text,100000)};}).filter(c=>c.fromSec<duration);
   captions={style:JSON.stringify({preset:style.preset,position:style.position,fontSize:style.fontSize,assStyle:style.assStyle,fadeInSec:style.fadeInSec,fadeOutSec:style.fadeOutSec}),cues};
  }else if(subtitle.outcome!=='disabled'||subtitle.style!==null||list(subtitle.cues).length)mappingPending('native-subtitle-unsupported');
  const fx=exact(output.transitionIntent,['requestedName','durationSec','selectedName','shader','outcome','tailPaddingSec']);
  if(fx.outcome!=='prepared-intent'||fx.tailPaddingSec!==.2)mappingPending('native-transition-unsupported');number(fx.durationSec,0,2);
  let transition:unknown=null;
  if(fx.shader!==null){const shader=exact(fx.shader,['path','sha256']);version(shader.path,shader.sha256);transition={name:text(fx.selectedName),durationSec:number(fx.durationSec,Number.MIN_VALUE,duration),shaderSha256:digest(shader.sha256)};}
  else if(fx.durationSec>0||typeof job.TransitionSec==='number'&&job.TransitionSec>0)mappingPending('native-transition-preparation-pending');
  const plan={version:1,projectId:originalContext.projectId,filmRev:originalContext.filmRev,job:structuredClone(job),durationSec:duration,aspect:[job.OutWidth,job.OutHeight],fps,materials:[...used.values()],scenes,audio:{voice,music,postmix:{kind:'loudnorm',integratedLUFS:-14,truePeakDBTP:-1.5,loudnessRangeLU:11}},captions,transition};
  contentParts(plan);return freezeMapped(plan);
 }catch(error){if(error instanceof BusinessError&&error.code.startsWith('native-'))throw error;throw new BusinessError('native-preparation-invalid',422);}
}
