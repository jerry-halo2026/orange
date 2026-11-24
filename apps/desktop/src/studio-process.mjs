// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Studio, inside the app: an Electron utility process running the open-source Studio (the `orangefilm` package's
 * `startStudio`), serving the window's page (shell/) as its editor. It is the machine's Studio (`advertise`): an
 * agent's `orangefilm open` finds it and shows its project in the app's window, not in a browser.
 *
 * Talks to the main process over `process.parentPort`:
 *   → { type: 'ready', origin, filmOrigin, key }   listening
 *   → { type: 'failed', code, message }              could not start (code 'EADDRINUSE': the port is taken)
 *   → { type: 'browser', state: 'downloading' | 'ready' | 'failed', message? }   the headless browser pages draw in
 *   → { type: 'ffmpeg', found }                      whether ffmpeg and ffprobe are on the PATH (video pictures, sound, export)
 *   → { type: 'open', url }                          Studio wants something shown in the person's browser
 *   → { type: 'ask', id, text }                      a question for the person's agent's own model (askAgent)
 *   → { type: 'ask-cancel', id }                     that question no longer wanted
 *   ← { type: 'answer', id, text | error, code? }    its answer
 *   ← { type: 'quit' }                               stop (history is written first)
 *   ← { type: 'working', folders }                   the folders the chat's agents are working in now (not deletable)
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { startStudio } from 'orangefilm/studio';
import { launch } from 'orangefilm/host';
import { readIsolationProfile } from './isolation.mjs';
import { assertIsolationPath } from 'orangefilm/development-isolation';
import { createDesktopAuth, migrateOwnerRoots, readDesktopAuthConfiguration } from './desktop-auth.mjs';
import { createLocalFissionDraftService } from './fission-local-draft.mjs';
import { pathToFileURL } from 'node:url';
const isolation = readIsolationProfile(process.env);
// Keep Windows PowerShell's module discovery cache inside the isolated profile
// when the native folder picker starts a PowerShell child.
if (isolation && process.platform === 'win32') process.env.PSModuleAnalysisCachePath=join(isolation.paths.temp,'powershell-module-cache');

const parent = process.parentPort;
const send = (message) => parent.postMessage(message);

let studio = null;
let localFission = null, localFissionDraft = null, localFissionOwner = null;
let localFissionRetirement = Promise.resolve();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    const retirement=await desktopAuth.dispose();
    if(retirement?.confirmed!==true)throw new Error('Desktop preservation is unconfirmed.');
    await studio?.close();process.exit(0);
  }
  catch { send({type:'auth',state:{kind:'locked',reason:'preservation-failed'}});process.exit(1); }
}
/** the folders the chat's agents are working in, as the main process last told */
let working = [];
/** the questions asked of the person's agent, waiting for their answers, by id */
const asking = new Map();
let parentRetirement = null;
parent.on('message', ({ data }) => {
  if (data?.type === 'quit') void stop();
  if (data?.type === 'working' && Array.isArray(data.folders)) working = data.folders.filter((f) => typeof f === 'string');
  if (data?.type === 'answer') asking.get(data.id)?.(data);
  if (data?.type === 'auth-parent-retired' && parentRetirement?.id === data.id) {
    const held=parentRetirement;parentRetirement=null;clearTimeout(held.timer);
    if(data.ok===true)held.resolve();else held.reject(new Error('Parent preservation is unconfirmed.'));
  }
});

const nativeRoot=dirname(createRequire(import.meta.url).resolve('orangefilm/package.json'));
const {libraryRoot:originalLibraryRoot,sharedHome:originalSharedHome,studioHomeDir,migrateProductFolder}=await import(pathToFileURL(join(nativeRoot,'src','locations.mjs')).href);
/* First start after the product's folder was renamed (locations.mjs migrateProductFolder): the projects, Saved and
   Skills under `…/Videos/OrangeFilm` move to `…/Videos/OrangeFilm`, and the owner records (orange-project-owners.json)
   follow them, or every project already made would answer project-access-denied by its old root. Once: the new folder
   being there is what says it is done. */
const movedFolder=migrateProductFolder();
if(movedFolder.status==='moved')for(const home of new Set([studioHomeDir(),originalSharedHome()]))migrateOwnerRoots({home,from:movedFolder.from,to:movedFolder.to});
const desktopAuth=createDesktopAuth({
  configuration:readDesktopAuthConfiguration(process.env),
  /* the main process resolved why there is none, when it did: an installed app whose installer lacks the environment
     must say that, not "provide local configuration" (auth-env-file.mjs `authEnvironmentReason`) */
  configurationReason:process.env.ORANGE_AUTH_ENV_REASON,
  home:studioHomeDir(),sharedHome:originalSharedHome(),projects:originalLibraryRoot(),
  coordinationRoot:join(isolation?.baseRoot ?? studioHomeDir(),'.orange-coordination'),instanceId:randomUUID(),
},{
  fetch:globalThis.fetch,monotonicNow:()=>performance.now(),
  onState:state=>{
    let scope=null;try{if(state.kind==='active')scope=desktopAuth.windowScope();}catch{/* state remains locked */}
    if(state.kind==='active') { try { localFissionOwner=desktopAuth.assertActive(); } catch { localFissionOwner=null; } }
    else if(localFissionOwner && localFission) {
      const owner=localFissionOwner;localFissionOwner=null;
      localFissionRetirement=localFissionRetirement.then(()=>localFission.retire(owner));
      // Retirement is awaited below; attach a handler now so a fast failure cannot become unhandled.
      void localFissionRetirement.catch(()=>{});
    }
    send({type:'auth',state,scope});if(state.kind!=='active')studio?.sealAccess();
  },
  retire:async()=>{
    await localFissionRetirement;
    await new Promise((resolve,reject)=>{
      const id=randomUUID(),timer=setTimeout(()=>{if(parentRetirement?.id===id)parentRetirement=null;reject(new Error('Parent preservation is unconfirmed.'));},60000);
      parentRetirement={id,timer,resolve,reject};send({type:'auth-retire',id});
    });
    await studio?.close();
  },
  // Only the controller can announce completion: its entered operations and
  // actual guard release still follow the Studio.close callback above.
  onRetired:()=>{
    send({type:'auth-retired'});
    setImmediate(()=>process.exit(0));
  },
});
// An explicit configuration is the opt-in, whether an isolated development run or the installed app supplies it
// (main.mjs writes it from the package's own resources: src/fission-config.mjs).
// A missing or invalid configuration leaves only this feature unavailable.
if (process.env.ORANGE_FISSION_CONFIG_FILE) {
  try {
    const base=pathToFileURL(join(nativeRoot,'studio','server','server.mjs'));
    const {createLocalFission,readLocalFissionConfiguration}=await import(new URL('./fission-local.mjs',base));
    const {pickFolder}=await import(new URL('./folder-picker.mjs',base));
    const {projectById}=await import(new URL('./projects.mjs',base));
    const runtime=await readLocalFissionConfiguration(process.env.ORANGE_FISSION_CONFIG_FILE);
    // The original Studio exporter also invokes ffmpeg/ffprobe by name. Use the
    // same explicitly configured local tools for this isolated utility process.
    process.env.PATH=[dirname(runtime.paths.FFmpeg),dirname(runtime.paths.FFprobe),process.env.PATH ?? ''].join(delimiter);
    // The isolated profile's home, or the Studio home an installed app writes to.
    const home=isolation?.paths.home ?? studioHomeDir();
    const workspaceRoot=join(home,'fission-jobs');if(isolation)assertIsolationPath(isolation,workspaceRoot,'home');mkdirSync(workspaceRoot,{recursive:true});if(isolation)assertIsolationPath(isolation,workspaceRoot,'home');
    localFission=createLocalFission({workspaceRoot,runtime,pickFolder:(role,options)=>pickFolder({title:`选择${({video:'视频',audio:'配音',bgm:'背景音乐',intro:'片头',outro:'片尾'})[role] ?? '素材'}文件夹`,at:null,signal:options?.signal}),assertSession:owner=>desktopAuth.assertActive()===owner});
    localFissionDraft=createLocalFissionDraftService({assertSession:()=>desktopAuth.assertActive(),runNative:work=>desktopAuth.runNative(work),getDraftSource:(owner,ref)=>localFission.getDraftSource(owner,ref),findProject:id=>projectById(id),approvedBaseRoot:isolation?.baseRoot ?? studioHomeDir(),ffprobePath:runtime.paths.FFprobe});
  } catch { localFission=null;localFissionDraft=null; }
}
const authClock=setInterval(()=>desktopAuth.getPublicState(),1000);authClock.unref();

/**
 * One question answered by the person's agent's own model (the main process picks the agent and asks it, with no
 * chat): Studio's own work that needs a model, such as translating subtitles.
 * @param {string} text @param {AbortSignal} [signal] @returns {Promise<string>}
 */
function askAgent(text, signal) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const cancel = () => { asking.delete(id); send({ type: 'ask-cancel', id }); reject(signal?.reason ?? new Error('stopped')); };
    asking.set(id, (answer) => {
      asking.delete(id);
      signal?.removeEventListener('abort', cancel);
      if (typeof answer.text === 'string') resolve(answer.text);
      else reject(Object.assign(new Error(String(answer.error ?? 'The agent did not answer.')), answer.code ? { code: answer.code } : {}));
    });
    signal?.addEventListener('abort', cancel, { once: true });
    send({ type: 'ask', id, text });
  });
}

const port = Number(process.env.ORANGE_STUDIO_PORT);
try {
  studio = await startStudio({
    port: Number.isInteger(port) ? port : 0,
    advertise: true,
    isolation: Boolean(isolation),
    openBrowser: (url) => send({ type: 'open', url }),
    /* another app (or `orangefilm open`) asked this Studio to stop: the window still needs it, so it stays and says so */
    stays: true,
    key:randomBytes(24).toString('hex'),
    desktopAuth,
    localFission,
    localFissionDraft,
    working: () => working,
    askAgent,
    /* the window's page, Studio's editor with the chat beside it (shell/), in place of the editor alone */
    ...(process.env.ORANGE_EDITOR_DIR ? { editorDir: process.env.ORANGE_EDITOR_DIR } : {}),
  });
  send({ type: 'ready', origin: studio.origin, filmOrigin: studio.filmOrigin, key: studio.key });
  send({type:'auth',state:desktopAuth.getPublicState(),scope:null});
} catch (e) {
  send({ type: 'failed', code: e?.code ?? null, message: e?.message ?? String(e) });
  process.exit(1);
}

send({ type: 'ffmpeg', found: ['ffmpeg', 'ffprobe'].every((bin) => !spawnSync(bin, ['-version'], { stdio: 'ignore', windowsHide: true }).error) });

/* Isolated development never installs or bootstraps runtime downloads automatically. */
if (isolation) {
  send({type:'browser',state:'failed',message:'Automatic browser setup is unavailable in isolated development; supply an approved local runtime.'});
} else {
/* Studio draws pages' pictures in Playwright's headless browser: download it once, the first time (about 100 MB) */
try {
  await (await launch()).close();
  send({ type: 'browser', state: 'ready' });
} catch (e) {
  if (!/Executable doesn't exist/.test(e?.message ?? '')) send({ type: 'browser', state: 'failed', message: e?.message ?? String(e) });
  else {
    send({ type: 'browser', state: 'downloading' });
    const orangefilm = dirname(createRequire(import.meta.url).resolve('orangefilm/package.json'));
    const cli = join(dirname(createRequire(join(orangefilm, 'package.json')).resolve('playwright-core/package.json')), 'cli.js');
    const child = spawn(process.execPath, [cli, 'install', 'chromium-headless-shell'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true });
    child.once('exit', (code) => send(code === 0 ? { type: 'browser', state: 'ready' } : { type: 'browser', state: 'failed', message: `the download stopped (${code})` }));
    child.once('error', (error) => send({ type: 'browser', state: 'failed', message: error.message }));
  }
}

}
