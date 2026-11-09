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
  return {
    integration: Object.freeze({workerPreparation:deps.prepare?'adapter-configured':'not-connected',deliveryVerifier:deps.verifyDelivery?'adapter-configured':'not-connected',executionReady:false}),
    resolve,
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