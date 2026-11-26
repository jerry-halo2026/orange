// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * The person's own keys for media services, which service makes each kind of media and with which model
 * (Settings → Services).
 *
 * Kept in ~/.orangefilm/providers.json, readable by this user only (0600, in a 0700 folder), written whole and atomically:
 *   { "keys": { "<provider id>": "<key>" }, "use": { "<verb>": "<provider id>" }, "model": { "<verb>": "<model id>" },
 *     "custom": [ the person's own services (custom-services.mjs), each with its key ],
 *     "accounts": { "<provider id>": "<email>" } (who a provider signed in to, sign-in.mjs, is connected as) }
 * A keyless provider connected without a key keeps '' as its key. A kind of media with no model (or one its provider no
 * longer has) is made with the provider's first. Listing voices goes with voice-over: same provider, same model.
 *
 * The file is shared with every OrangeFilm on this computer (`npx orangefilm`, the app), which may be older or newer than
 * this one: what this one does not know of it (a newer one's field) is written back as it was, never dropped.
 *
 * A key in the environment (the provider's variable, e.g. ELEVENLABS_API_KEY) wins over the file: it is how people
 * already keep keys, and Studio cannot remove it. Keys leave this process only towards their own service; the editor
 * page sees where a key comes from and its last four characters, never the key.
 */
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { renameSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { studioHome } from './projects.mjs';
import { replaceFile } from './atomic.mjs';
import { ordinaryControlPath } from './project-control-guard.mjs';
import { keptServices } from './custom-services.mjs';

/** @typedef {import('./providers/contract.mjs').Provider} Provider */
/**
 * `off`: the providers disconnected while the environment has a key for them (that key is not used). `custom`: the
 * person's own services. `libraryOff`: the library is searched by its words alone, not by meaning at OrangeFilm's
 * service (src/library-semantic.mjs).
 * @typedef {{ keys: Record<string, string>, use: Record<string, string>, model: Record<string, string>, off: string[],
 *   custom: import('./custom-services.mjs').CustomService[], accounts: Record<string, string>, libraryOff: boolean }} ProviderSettings
 */

/** @typedef {{file:string,check:()=>void}} AccountProviderScope */
/** @type {AsyncLocalStorage<AccountProviderScope>} */
const accountProviders=new AsyncLocalStorage();
/**
 * The one file an account's Services may live in: the original `providers.json`, or — for an installed
 * Studio's per-account store (services-store.mjs) — `<id>.json` inside Studio's own `services` folder.
 * Anything else is refused before the file is touched.
 * @param {string} file
 */
function accountFileAllowed(file) {
  const name = basename(file);
  if (name === 'providers.json') return true;
  return /^[A-Za-z0-9_-]{1,128}\.json$/.test(name) && basename(dirname(file)) === 'services';
}

/** Bind only a trusted, checked account file to the current native request.
 * @template T @param {string} file @param {()=>void} check @param {()=>T} work @returns {T}
 */
export function withAccountProviderSettings(file,check,work) {
  if(typeof file!=='string'||!isAbsolute(file)||!accountFileAllowed(file)||typeof check!=='function'||typeof work!=='function')throw new Error('account-provider-context-invalid');
  check();const safe=ordinaryControlPath(file);check();
  return accountProviders.run({file:safe,check},work);
}
/** @param {string} file @param {AccountProviderScope|undefined} scope */
function guardAccountFile(file,scope=accountProviders.getStore()) {
  if(!scope)return;
  scope.check();
  const equal=process.platform==='win32'?resolve(file).toLowerCase()===scope.file.toLowerCase():resolve(file)===scope.file;
  if(!equal)throw new Error('account-provider-context-invalid');
  ordinaryControlPath(file);scope.check();
}

/** Where the keys and choices are kept: ~/.orangefilm/providers.json. */
export const providersFile = () => accountProviders.getStore()?.file ?? join(studioHome(), 'providers.json');

/** Other names a provider's key goes by in the wild (Google's own tools read either). */
const ALSO = /** @type {Record<string, string[]>} */ ({ GEMINI_API_KEY: ['GOOGLE_API_KEY'], ORANGE_API_KEY: ['ORANGE_API_KEY'] });

const plain = (/** @type {unknown} */ v) => v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {};
const strings = (/** @type {unknown} */ v) => /** @type {Record<string, string>} */ (Object.fromEntries(Object.entries(plain(v)).filter(([, s]) => typeof s === 'string')));

/** The saved keys and choices (empty only when this account's file does not exist). */
export async function readSettings(file = providersFile()) {
  const scope=accountProviders.getStore(),check=()=>guardAccountFile(file,scope);
  try {
    check();const info=await stat(file);check();
    /* Preserve original permission repair only in the original non-isolated mode. */
    if(!scope&&(info.mode & 0o077))await chmod(file,0o600);
    check();const text=await readFile(file,'utf8');check();
    const raw=plain(JSON.parse(text));
    const use=Object.fromEntries(Object.entries(strings(raw.use)).filter(([,id])=>id!=='auto'));
    const off=Array.isArray(raw.off)?raw.off.filter(id=>typeof id==='string'):[];
    return /** @type {ProviderSettings} */ ({keys:strings(raw.keys),use,model:strings(raw.model),off,custom:keptServices(raw.custom),accounts:strings(raw.accounts),libraryOff:raw.libraryOff===true});
  } catch(error) {
    check();
    if(scope&&/** @type {NodeJS.ErrnoException} */(error)?.code!=='ENOENT')throw error;
    /* orangeflim: a new install searches the library by its words alone. Meaning-search asks orangefilm.dev to rank
       what was typed, which our build does not do by default (offline first, and nothing of the person's leaves the
       machine), and it ranks the library's own things by names it already knows — a thing added to this library since
       is not in it, so it would sort below everything the service knows. The person turns it on in Settings. */
    return /** @type {ProviderSettings} */ ({keys:{},use:{},model:{},off:[],custom:[],accounts:{},libraryOff:false});
  }
}

/**
 * The kind of media a verb is chosen with: voices are found by what speaks them, web pages read by what searches.
 * @param {string} verb
 */
export const kindOf = (verb) => (verb === 'voice' ? 'tts' : verb === 'web-fetch' ? 'web-search' : verb);

/**
 * The model `provider` makes `verb` with: the person's choice while the provider has it, else its first. Voices are
 * found with voice-over's. undefined: the provider names no models for it.
 * @param {ProviderSettings} settings @param {Provider} provider @param {string} verb
 */
export function modelFor(settings, provider, verb) {
  const kind = kindOf(verb);
  const models = provider.models?.[/** @type {import('./providers/contract.mjs').Verb} */ (kind)] ?? [];
  return (models.find((m) => m.id === settings.model[kind]) ?? models[0])?.id;
}

/** @type {Promise<unknown>} one change at a time, each on the file as the last one left it */
let changing = Promise.resolve();

/** Replace an account file while checking its session at every atomic commit attempt.
 * @param {string} from @param {string} to @param {()=>void} check
 * @param {{ rename?: (from:string,to:string)=>void, wait?: (ms:number)=>Promise<void>, windows?: boolean }} [options]
 */
export async function replaceAccountSettings(from,to,check,{rename=renameSync,wait=ms=>new Promise(done=>setTimeout(done,ms)),windows=process.platform==='win32'}={}) {
  for(let attempt=0;;attempt++) {
    check();
    try { rename(from,to); return; }
    catch(error) {
      const code=/** @type {NodeJS.ErrnoException} */(error).code??'';
      if(!windows||!['EPERM','EBUSY','EACCES'].includes(code)||attempt>=8)throw error;
      await wait(20*2**attempt);
    }
  }
}
/** Change one account's settings; an invalidated session cannot start or finish a successful write. */
export function changeSettings(/** @type {(s: ProviderSettings) => void} */ edit, file = providersFile()) {
  const scope=accountProviders.getStore(),check=()=>guardAccountFile(file,scope);
  const next=changing.catch(()=>{}).then(async()=>{
    check();const settings=await readSettings(file);check();edit(settings);check();
    /** @type {Record<string, unknown>} */
    let kept={};
    try{const raw=await readFile(file,'utf8');check();kept=plain(JSON.parse(raw));}
    catch(error){check();if(scope&&/** @type {NodeJS.ErrnoException} */(error)?.code!=='ENOENT')throw error;}
    check();await mkdir(dirname(file),{recursive:true,mode:0o700});check();
    const tmp=file+'.'+randomBytes(6).toString('hex')+'.tmp';
    if(scope)ordinaryControlPath(tmp);
    try{
      check();await writeFile(tmp,JSON.stringify({...kept,...settings},null,2)+'\n',{mode:0o600,flag:'wx'});check();
      // The final account check and commit are one synchronous turn. Logout and
      // account switching cannot interleave after the check but before rename.
      // Once renamed the write is committed, even if the caller disconnects.
      if(scope)await replaceAccountSettings(tmp,file,check);else await replaceFile(tmp,file);
      return settings;
    }catch(error){try{ordinaryControlPath(tmp);await rm(tmp,{force:true});}catch{}throw error;}
  });
  changing=next;return next;
}

/**
 * A provider's key and where it comes from: the one pasted in Studio (the person's choice), else the environment's
 * unless the person disconnected it there. A `keyless` provider connected without a key (kept as '') has the key ''.
 * null: not connected.
 * @param {Provider} provider @param {ProviderSettings} settings
 * @returns {{ key: string, source: 'env' | 'file', env: string } | null}
 */
export function providerKey(provider, settings, env = process.env) {
  /* one that takes no key (Local services): connected while it can run */
  if (provider.ready) return provider.ready() ? { key: '', source: 'file', env: '' } : null;
  const kept = settings.keys[provider.id];
  if (kept) return { key: kept, source: 'file', env: provider.env };
  if (settings.off?.includes(provider.id)) return null;
  return envKey(provider, env) ?? (provider.keyless && kept === '' ? { key: '', source: 'file', env: provider.env } : null);
}

/** The environment's key for a provider, connected or not, or null. @param {Provider} provider */
export function envKey(provider, env = process.env) {
  for (const name of [provider.env, ...(ALSO[provider.env] ?? [])]) {
    const key = env[name]?.trim();
    if (key) return { key, source: /** @type {const} */ ('env'), env: name };
  }
  return null;
}

/** A pasted key as it is kept: trimmed, one line, of a plausible length. Throws a sentence the page can show. */
export function cleanKey(/** @type {unknown} */ value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key.length < 8 || key.length > 512 || /[\s\u0000-\u001f\u007f]/.test(key)) throw new Error('That does not look like an API key: paste the whole key, on its own.');
  return key;
}

