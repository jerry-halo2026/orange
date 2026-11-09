// @ts-check
/** Native Fission export qualification. This grants no identity, license or business admission. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FILM_FILE, clipKind, clipSpan, clipFade, readFilmFile } from './film-doc.mjs';
import { studioHomeDir } from './locations.mjs';

export class FissionExportError extends Error {
  /** @param {string[]} [capabilities] */
  constructor(capabilities = ['fission-provenance-invalid']) {
    super('Fission export is not ready: ' + capabilities.join(', '));
    this.code = 'FISSION_EXPORT_BLOCKED'; this.status = 409; this.blockingCapabilities = capabilities;
  }
}
const hash = (/** @type {Buffer|string} */ bytes) => createHash('sha256').update(bytes).digest('hex');
/** Read the existing native .film/id exactly as native projects.mjs does; never mint an identifier.
 * @param {string} root @returns {string|null} */
function nativeProjectId(root) {
  try {
    ordinaryDirectory(join(root,'.film'));
    const file=join(root,'.film','id'),stat=lstatSync(file,{throwIfNoEntry:false});
    if(!stat||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)return null;
    const id=readFileSync(file,'utf8').trim();return /^[\w-]{6,40}$/.test(id)?id:null;
  }catch{return null;}
}
const legacyOriginFile=(/** @type {string} */ root)=>{let physical=resolve(root);try{physical=realpathSync(physical);}catch{}return join(studioHomeDir(),'fission-origins',hash(physical)+'.json');};
const nativeOriginFile=(/** @type {string} */ root)=>{const id=nativeProjectId(root);return id?join(studioHomeDir(),'fission-origins',hash('native:'+id)+'.json'):null;};
// Old unreleased development receipts remain read-only; newly imported projects
// use the original stable native ID so a native rename does not lose provenance.
const originFile=(/** @type {string} */ root)=>{const native=nativeOriginFile(root);return native&&existsSync(native)?native:legacyOriginFile(root);};
const inside = (/** @type {string} */ root, /** @type {string} */ file) => { const rel = relative(root, file); return rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
/** Ordinary non-link, single-link files only; caller never follows a substituted asset or receipt. @param {string} file */
function ordinary(file) {
  for (let at = resolve(file); ; at = dirname(at)) {
    const s = lstatSync(at);
    if (s.isSymbolicLink() || (at === resolve(file) ? !s.isFile() || s.nlink !== 1 : !s.isDirectory())) throw new FissionExportError();
    if (at === dirname(at)) break;
  }
  if (realpathSync(file) !== resolve(file)) throw new FissionExportError();
  return readFileSync(file);
}
/** Refuse substituted private ancestors before mkdir or write. @param {string} dir */
function ordinaryDirectory(dir) {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new FissionExportError();
    if (at === dirname(at)) break;
  }
}
/** Persist an origin outside the editable project, so deleting every sidecar cannot silently turn it into a non-Fission export.
 * Trusted original importer only, never an HTTP/client export option. @param {string} root */
export function recordFissionOrigin(root) {
  const receipt = ordinary(join(root, '.film', 'fission-handoff.json'));
  const projectId=nativeProjectId(root),file=nativeOriginFile(root);if(!projectId||!file)throw new FissionExportError(); ordinaryDirectory(dirname(file)); mkdirSync(dirname(file), { recursive: true }); ordinaryDirectory(dirname(file));
  writeFileSync(file, JSON.stringify({ projectId, root: resolve(root), receiptSHA256: hash(receipt) }), { flag: 'wx' });
}

/** A contiguous current native partition of an original importer-generated role.
 * This recognizes a pure split without making another mutable timeline.
 * @param {any[]} clips @param {string} file @param {number} sourceDuration @param {number} target @param {boolean} loop */
function unchangedPrefix(clips, file, sourceDuration, target, loop) {
  if (!clips.length) return false;
  let cursor = 0; const volume = clips[0].volume;
  for (const c of [...clips].sort((a,b) => a.at-b.at)) {
    const expected = loop ? cursor % sourceDuration : cursor;
    if (c.file !== file || Math.abs(c.at-cursor) > .001 || Math.abs(c.from-expected) > .001 || c.speed !== 1 || c.fade || c.volume !== volume) return false;
    cursor += c.to-c.from;
  }
  return Math.abs(cursor-target) <= .001;
}
/** Current native edit/closure, not a stale revision or a replacement for the artist's Ops.
 * @param {string} root @param {Record<string, any>} [ask]
 * @returns {null | {kind:'fission-v1',voice:string,music:string|null,sources:Record<string,{path:string,durationSec:number,kind?:string}>,fullVoiceSec:number,nativeDurationSec:number,preserveSourceTail:boolean,roles:Record<string,'voice'|'music'>}}
 */
export function qualifyFissionRender(root, ask = {}) {
  root = resolve(root);
  const receiptPath = join(root,'.film','fission-handoff.json'), planPath = join(root,'.film','fission-edit-plan.json'), origin = originFile(root), filmPath = join(root,FILM_FILE);
  const filmBytes = existsSync(filmPath) ? readFileSync(filmPath,'utf8') : '';
  if (!(existsSync(origin) || existsSync(receiptPath) || existsSync(planPath) || filmBytes.includes('data-fission-role'))) return null;
  try {
    ordinary(filmPath);
    const receiptBytes = ordinary(receiptPath), receipt = JSON.parse(receiptBytes.toString('utf8')), saved = JSON.parse(ordinary(origin).toString('utf8'));
    if ((saved.projectId ? saved.projectId !== nativeProjectId(root) : saved.root !== root) || saved.receiptSHA256 !== hash(receiptBytes)) throw new FissionExportError();
    const planBytes = ordinary(planPath), p = JSON.parse(planBytes.toString('utf8'));
    if (hash(planBytes) !== receipt.sourcePlanSHA256 || p.schemaVersion !== 1) throw new FissionExportError();
    const blockers = [];
    if (receipt.nativeAudioProfile !== 'fission-v1') blockers.push('fission-postmix-loudnorm');
    if (p.transitions?.outcome === 'applied') blockers.push('fission-glsl-transition');
    if (p.transitions?.outcome === 'fallback-no-transition') blockers.push('fission-glsl-transition-fallback');
    if (p.subtitles?.outcome !== 'disabled') blockers.push('fission-ass-style');
    if (p.visuals?.some((/** @type {any} */ v) => v.hflip)) blockers.push('fission-hflip-equivalence');
    if (ask.kind && ask.kind !== 'video') blockers.push('fission-nle-postmix-or-export-kind');
    if (ask.clip || ask.range || ask.ranges || ask.subtitles || ask.burnSubtitles || ask.loudness != null || ask.audio === false || ask.silent) blockers.push('fission-derived-audio-context');
    if (ask.codec && ask.codec !== 'h264') blockers.push('fission-codec-equivalence');
    const film = readFilmFile(filmBytes);
    if (!film.doc || film.problems.length || !film.value || !Array.isArray(p.sources) || !Array.isArray(receipt.sourceCopies) || receipt.sourceCopies.length < p.sources.length) throw new FissionExportError();
    if (/<link\b[^>]*\bhref\s*=/i.test(filmBytes) || [...filmBytes.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].some(match => /url\s*\(|@import/i.test(match[1]))) blockers.push('fission-style-resource-rights');
    const used = new Set(film.value.tracks.flatMap(track => track.clips).map(c => c.src));
    /** @type {Record<string,{path:string,durationSec:number,kind?:string}>} */ const sources = {};
    for (let i=0; i<p.sources.length; i++) {
      const source=p.sources[i],src=receipt.sourceCopies[i]; if(typeof src!=='string')throw new FissionExportError();const file=resolve(root,src);
      if(!inside(root,file)||(used.has(src)&&hash(ordinary(file))!==source.sha256))throw new FissionExportError();
      sources[src]={path:file,durationSec:source.durationSec,kind:source.kind};
    }
    const voice=receipt.sourceCopies[p.audio.voice.source],music=p.audio.music?receipt.sourceCopies[p.audio.music.source]:null;
    /** @type {Record<string,'voice'|'music'>} */ const roles={}; /** @type {any[]} */ const audible=[];
    let duration=.001;
    for(const [ti,track] of film.value.tracks.entries()) {
      if(track.captions)blockers.push('fission-native-caption-pending');
      for(const [ci,clip] of track.clips.entries()) {
        const source=sources[clip.src],kind=clipKind(clip.src);
        if(!source){blockers.push('fission-source-rights-increment-required');continue;}
        if(!['video','still','sound'].includes(kind??'')||source.kind!==kind){blockers.push('fission-native-effect-layout');continue;}
        if(/url\s*\(|@import/i.test(clip.style??'')||clip.overrides?.some(o=>o.at!==undefined)){blockers.push('fission-style-resource-rights');continue;}
        const span=clipSpan(clip,source.durationSec),at=clip.at??0;
        if(!track.hidden)duration=Math.max(duration,at+span.length);
        if(kind!=='sound'&&kind!=='video')continue;
        const role=clip.attrs?.['data-fission-role']==='music'?'music':clip.attrs?.['data-fission-role']==='voice'?'voice':clip.src===music&&clip.src!==voice?'music':'voice';
        const id=clip.id??film.doc.tracks[ti]?.clips[ci]?.id;if(id)roles[id]=role;
        const volume=track.hidden||track.muted?0:clip.volume??1;if(volume<=0)continue;
        const skip=Math.max(0,-at),from=span.from+skip*span.speed;if(span.to<=from)continue;
        audible.push({file:source.path,at:Math.max(0,at),from,to:span.to,speed:span.speed,volume,role,fade:clipFade(clip)});
      }
    }
    const target=Math.min(p.durationSec,p.alignment.outputDurationSec),voiceEnd=Math.min(target,sources[voice].durationSec);
    const voiceClips=audible.filter(c=>c.role==='voice'),musicClips=audible.filter(c=>c.role==='music');
    const preserveSourceTail=Math.abs(duration-target)<=.001
      &&unchangedPrefix(voiceClips,sources[voice].path,sources[voice].durationSec,voiceEnd,false)
      &&(music?unchangedPrefix(musicClips,sources[music].path,sources[music].durationSec,target,true):!musicClips.length);
    if(blockers.length)throw new FissionExportError([...new Set(blockers)]);
    return {kind:'fission-v1',voice,music,sources,fullVoiceSec:p.sources[p.audio.voice.source].durationSec,nativeDurationSec:duration,preserveSourceTail,roles};
  }catch(error){if(error instanceof FissionExportError)throw error;throw new FissionExportError();}
}
/** Bind original native audio clip ids to actual current source/time/volume, not to a second timeline.
 * @param {any[]} clips @param {NonNullable<ReturnType<typeof qualifyFissionRender>>} profile */
export function fissionAudioClips(clips, profile) {
  const bound=clips.map(clip=>{
    const source=Object.entries(profile.sources).find(([,s])=>s.path===resolve(clip.file));
    if(!source)throw new FissionExportError(['fission-source-rights-increment-required']);
    const role=profile.roles?.[clip.clip]??(source[0]===profile.music&&source[0]!==profile.voice?'music':'voice');
    return {...clip,role};
  });
  // Keep the original Fission look-ahead only for the unchanged imported audible
  // prefix (a native split is allowed). Actual edited timing/rates/fades/mutes
  // instead use the current native buses. Never overwrite the original receipt.
  if(profile.preserveSourceTail===false)return bound;
  const voices=bound.filter(c=>c.role==='voice'),music=bound.filter(c=>c.role==='music');
  if(!voices.length)return bound;
  const full=[{...voices[0],at:0,from:0,to:profile.fullVoiceSec,analysisTo:profile.fullVoiceSec,fade:undefined}];
  if(music.length)full.push({...music[0],at:0,from:0,to:profile.fullVoiceSec,analysisTo:profile.fullVoiceSec,loopSource:true,fade:undefined});
  return full;
}
