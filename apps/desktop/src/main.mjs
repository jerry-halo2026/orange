// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * OrangeFilm for desktop: one window of tabs, a project in each, Studio on the left and a chat on the right, one page
 * per tab (tabs.mjs). A project is picked in Studio's projects window (the tabs' `+`), and its tab opens; with no tab
 * open, the window's page is the projects (HOME).
 *
 * Studio is the open-source one (the `orangefilm` package), run in a utility process (studio.mjs). It serves the
 * window's page: Studio's editor, built together with the chat beside it (shell/), on Studio's own origin, so the
 * editor works as it does in a browser and the chat is a column of the same page. What happens between them happens
 * in the page (shell/bridge.ts); this process does what only the app can: the window, the agents, files on the disk,
 * ffmpeg, updates (preload.cjs). The window opens straight into the last project.
 */
import { BaseWindow, Menu, WebContentsView, app, clipboard, dialog, ipcMain, nativeTheme, safeStorage, screen, shell } from 'electron';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAVOR, IDENTITY, PRODUCT_NAME } from './flavor.mjs';
import { folderDialogOptions, programDialogOptions } from './folder-dialog.mjs';
import { childEnvironment, lastPathSource, loginShellEnvironment } from './environment.mjs';
import { authEnvironmentReason, materializeAuthEnvironmentFile } from './auth-env-file.mjs';
import { gatherAppReport } from './app-report.mjs';
import { startWindowStudio, windowEditorDirectory } from './studio.mjs';
import { CHAT_MIN, STUDIO_MIN, WINDOW_MIN, placeOnDisplays, readWindowState, writeWindowState } from './window-state.mjs';
import { createPagePresentation, preparePage, revealPage } from './page-presentation.mjs';
import { closeTabOrWindow, keepWindowOnClose, quitAfterStudio } from './window-lifecycle.mjs';
import { appLanguage } from './i18n/language.mjs';
import { applicationMenuTemplate } from './menu.mjs';
import { registerLocalAgentIpc } from './local-agents-ipc.mjs';
import { readPreferences, registerChatIpc } from './chat-ipc.mjs';
import { registerSkillsIpc } from './skills-ipc.mjs';
import { createRoster } from './agent-roster.mjs';
import { checkAgentProgram, closeEverySession, sealAgentAdmission, resumeAgentAdmission, diagnoseAgent, forgetAgentStatus, listAgents, localAgent, openAgentInstaller, openAgentSignIn, setChosenPaths, signOutAgent } from './agents.mjs';
import { agentUsage, forgetAgentUsage } from './agent-usage.mjs';
import { installOpenfilmCommand } from './orangefilm-command.mjs';
import { startUpdates } from './updates.mjs';
import { stepAside } from './update-launch.mjs';
import { ensureFfmpeg, ffmpegDir, ffmpegDownloadable, ffmpegIn, ffmpegOnPath } from './ffmpeg-runtime.mjs';
import { writeFissionConfigFile } from './fission-config.mjs';
import { PATH_SEP } from './environment.mjs';
import { firstWindowsApps } from './windows-apps.mjs';
import { createTabs, projectGone } from './tabs.mjs';
import { restartDelay } from './studio-restart.mjs';
import { prepareDesktopIsolation, isolationEnvironment } from './isolation.mjs';
import { createMaterialDraftStore } from './material-draft-store.mjs';
import { createMaterialDraftBridge } from './material-draft-ipc.mjs';
import { createViewGenerationFence } from './view-generation-fence.mjs';
import { startMaterialService, startStudioBesideMaterials, packagedMaterialRoot, materialBindingsPath, materialStagingPath } from './material-service.mjs';
import { isDevToolsShortcut, toggleDevTools } from './dev-tools.mjs';
import { registerOrangeIpc } from './orange-ipc.mjs';
import { brandWindowTitle } from './brand.mjs';
import { studioHomeDir } from 'orangefilm/locations';

const isolation = prepareDesktopIsolation(app,process.env);
/* macOS 未签名构建：Chromium 自己的 cookie 加密也访问钥匙串（"Chromium Safe Storage"），启动会弹窗并卡住主进程。
   mock keychain 绕开它；确实要用钥匙串时设 ORANGE_KEYCHAIN=1。 */
if (process.platform === 'darwin' && process.env.ORANGE_KEYCHAIN !== '1') {
  app.commandLine.appendSwitch('use-mock-keychain');
}
/* the window's title and the name About says: brand.json's own words (brand.mjs), else the name this app had before */
const DISPLAY_NAME = brandWindowTitle();
if (isolation) Object.assign(process.env,isolationEnvironment(isolation));

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const mac = process.platform === 'darwin';
const windows = process.platform === 'win32';
/** Windows' window buttons over the top bar: the board's color, and the text's */
const overlayColours = (t) => ({ color: t === 'dark' ? '#111114' : '#e9e9eb', symbolColor: t === 'dark' ? '#ebebed' : '#161619', height: 32 });

/* HTML-in-Canvas in Studio's viewer, as in the renderer (the `orangefilm` package's src/host.mjs) */
app.commandLine.appendSwitch('enable-blink-features', 'CanvasDrawElement');
if (mac) {
  /* Flush small Canvas2D batches: blur on hundreds of strokes otherwise queues gigabytes of intermediate
     textures. Keep GPU canvas-to-WebGL uploads fast without changing the rest of Graphite's batching. */
  const features = app.commandLine.getSwitchValue('enable-features');
  app.commandLine.appendSwitch('enable-features', [
    features,
    'Canvas2DAutoFlushParams:max_recorded_op_graphite_kb/4',
  ].filter(Boolean).join(','));
} else {
  app.commandLine.appendSwitch('disable-skia-graphite');
}

/* each flavour its own name, data folder and single-instance lock (flavor.mjs) */
app.setName(PRODUCT_NAME);
if (!isolation) app.setPath('userData', IDENTITY.userData ?? join(app.getPath('appData'), PRODUCT_NAME));
const DATA = app.getPath('userData');
const LOGS = isolation?.paths.logs ?? join(DATA, 'logs');
mkdirSync(LOGS, { recursive: true });
const log = (line) => { try { appendFileSync(join(LOGS, 'studio.log'), line); } catch { /* no log */ } };

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else if (mac && app.isPackaged && stepAside({ dir: DATA, version: app.getVersion(), bundleId: IDENTITY.bundleId, execPath: process.execPath, argv: process.argv })) {
  /* opened while the update quitting started is being installed: running now would stop it, so the new version opens
     when it is done (update-launch.mjs) */
  app.exit(0);
} else {
  app.on('second-instance', () => focusWindow());
  app.whenReady().then(start).catch((error) => {
    console.error(error);
    app.exit(1);
  });
}

/** @type {BaseWindow | null} */
let win = null;
/** @type {ReturnType<typeof createTabs> | null} */
let tabs = null;
/** the page of each tab that has one (a tab left behind long enough has none until it is shown again) */
/** @type {Map<string, WebContentsView>} */
const views = new Map();
const viewGenerationFence = createViewGenerationFence();
let pagePresentation = null;
/** the page in front */
const activeView = () => views.get(pagePresentation?.currentId() ?? tabs?.activeId() ?? HOME) ?? null;
/** something every page is told (the theme, an update, the agents…) */
const broadcast = (channel, value) => { for (const v of views.values()) if (!v.webContents.isDestroyed()) v.webContents.send(channel, value); };
/** the tab whose page this is, or null */
const tabOf = (contents) => { for (const [id, v] of views) if (v.webContents === contents) return id; return null; };
/** a tab behind for this long lets its page go (it comes back when shown), unless an agent works in it or it exports */
const IDLE_PAGE_MS = 5 * 60_000;
/** How long the tabs of projects gone are gathered before they close together (several pages told at once). */
const GONE_TOGETHER_MS = 150;
/** @type {Awaited<ReturnType<typeof startWindowStudio>> | null} */
let studio = null;

/* The read-only material service (`apps/api`): the window's second child, with Studio's lifecycle rules — started
   when the window is up, stopped on quit, and stopped and started again whenever Studio restarts. */
const MATERIAL_CHECKOUT = app.isPackaged ? packagedMaterialRoot(process.resourcesPath) : here('../../../');
/* 凭据的三个来源，按优先级：显式 env（部署方能放任何可写位置）、应用数据目录（安装后用户放一次）、
   开发检出的 .dev（原来唯一的位置——打包后它在只读的 resources 里，等于永远没有）。 */
const MATERIAL_CREDENTIALS = (() => {
  const explicit = String(process.env.ORANGE_MATERIAL_CREDENTIALS ?? '').trim();
  if (explicit) return explicit;
  /* apps/api 的凭据位置有自己的硬规则：路径里必须有 `.dev` 段（credentials.ts assertIgnoredLocation），
     所以安装后的凭据放在 `<userData>/.dev/zhishang/`，与开发检出同一形状。 */
  const candidates = [
    join(DATA, '.dev', 'zhishang', 'credentials.local.json'),
    join(MATERIAL_CHECKOUT, '.dev', 'zhishang', 'credentials.local.json'),
  ];
  return candidates.find((file) => existsSync(file)) ?? candidates[candidates.length - 1];
})();
/* 给用户一个能放凭据的目录：存在即可，权限随 userData。 */
try { mkdirSync(join(DATA, '.dev', 'zhishang'), { recursive: true }); } catch { /* read-only data dir: the picker still reports it */ }
const MATERIAL_BINDINGS = app.isPackaged ? join(DATA, '.dev', 'zhishang', 'bindings.local.json') : materialBindingsPath(MATERIAL_CHECKOUT);
/* 绑定表由 apps/api 以 server 模式写；文件不存在它只会报 bindings absent，own/account 作用域都不可用。
   空表先落一份（0600），绑定才真的能写进去。 */
try {
  if (!existsSync(MATERIAL_BINDINGS)) {
    mkdirSync(dirname(MATERIAL_BINDINGS), { recursive: true });
    writeFileSync(MATERIAL_BINDINGS, `${JSON.stringify({ version: 1, bindings: {}, history: [] }, null, 1)}\n`, { mode: 0o600 });
  }
} catch { /* read-only data dir: apps/api reports it instead */ }
/* 素材索引落在可写的数据目录（安装后 resources 只读）；Studio 的索引路由与后台构建读同一个 env。 */
const MATERIAL_INDEX_DIR = String(process.env.ORANGE_MATERIAL_INDEX_DIR ?? '').trim() || join(DATA, 'material-index');

/**
 * 素材索引的首次构建/过期重建：后台游离进程，失败不影响窗口。
 * 它读 Studio 的 run.json（ORANGE_DEV_HOME 指向 Studio 的 home），落盘到 MATERIAL_INDEX_DIR ——
 * 与 Studio 的索引路由同一个目录。
 */
function startMaterialIndexBootstrap() {
  const script = join(MATERIAL_CHECKOUT, 'packages', 'orangefilm', 'scripts', 'material-index-bootstrap.mjs');
  if (!existsSync(script)) return;
  const home = IDENTITY.studioHome ?? studioHomeDir();
  try {
    const child = spawn(process.execPath, [script, '--detach', '--dir', MATERIAL_INDEX_DIR], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORANGE_MATERIAL_INDEX_DIR: MATERIAL_INDEX_DIR, ORANGE_DEV_HOME: home },
    });
    child.unref();
    log(`material index: started in the background (${MATERIAL_INDEX_DIR})\n`);
  } catch (error) {
    log(`material index: could not start (${error?.message ?? error})\n`);
  }
}
/* Staging holds the bytes the service fetches: writable, disposable, and never inside the archive. A source
   checkout stages in its ignored .dev; an isolated run stays inside its own profile; a packaged app, whose
   checkout is the read-only app.asar.unpacked, stages under the app's data. */
const MATERIAL_STAGING_PATH = isolation?.paths.cache
  ? join(isolation.paths.cache, 'material-staging')
  : app.isPackaged ? join(DATA, 'material-staging') : materialStagingPath(MATERIAL_CHECKOUT);
/** @type {Awaited<ReturnType<typeof startMaterialService>> | null} */
let materials = null;
let materialStop = Promise.resolve();
/** Start it once; a start that could not happen leaves the window working without it, and says why in the log. */
async function startMaterials(origins) {
  if (materials) return materials;
  try {
    materials = await startMaterialService({ checkout: MATERIAL_CHECKOUT, credentials: MATERIAL_CREDENTIALS, bindings: MATERIAL_BINDINGS, staging: MATERIAL_STAGING_PATH, origins, log });
    log(`material service ready at ${materials.origin}\n`);
  } catch (error) {
    materials = null;
    log(`material service did not start: ${error?.reason ?? error?.code ?? 'unknown'}\n`);
  }
  return materials;
}
/** Stop it wherever a stop is due. Safe from every path, and safe twice: the second call joins the first. */
function stopMaterials() {
  const current = materials;
  materials = null;
  if (!current) return materialStop;
  materialStop = materialStop.then(() => current.stop()).catch(() => undefined);
  return materialStop;
}
let state = readWindowState(DATA);
// Historical unbound tabs are preserved on disk, never attributed to the next login.
state = {...state,tabs:null};
let accountStateDir = null;
let desktopAuthActive = false;
let agentRetirement = null;
function retireAgents() {
  sealAgentAdmission(); desktopAuthActive=false;
  if(!agentRetirement) agentRetirement=Promise.all([localAgents?.closeAll(),closeEverySession({seal:true})]);
  return agentRetirement;
}
let authRetirementConfirmed = false;
let authUiGeneration = 0;
const materialDraftStore = createMaterialDraftStore();
let draftSessionOpen = false;
let theme = 'dark';
/** whether Studio has ffmpeg: true, false, { state: 'downloading', progress } or { state: 'failed', message } (null: not known yet) */
let ffmpegFound = null;
/** ffmpeg is being downloaded (ffmpeg-runtime.mjs): Studio's "not found" at its start is not the last word */
let ffmpegFetching = false;
const tellFfmpeg = (state) => { ffmpegFound = state; broadcast('desktop:ffmpeg', state); };
/** @type {ReturnType<typeof startUpdates> | null} */
let updates = null;
let quitting = false;
let quitConfirmed = false;
let cancelWindowClose = () => {};
/** @type {ReturnType<typeof registerLocalAgentIpc> | null} */
let localAgents = null;
/** @type {ReturnType<typeof createRoster> | null} */
let roster = null;

/** the board Studio's panes sit on (its --bg-app), so the window never flashes another color */
const BACKGROUND = { light: '#e9e9eb', dark: '#111114' };

function focusWindow() {
  if (!win) return;
  cancelWindowClose();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Each page fills the window (only the one in front shows). */
function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  for (const v of views.values()) v.setBounds({ x: 0, y: 0, width, height });
}

function saveState(strict = false) {
  strict = strict === true;
  if (!win) { if (strict) throw new Error('Window preservation is unavailable.'); return; }
  const maximized = win.isMaximized() || win.isFullScreen();
  state = { ...state, maximized, bounds: maximized ? state.bounds : win.getNormalBounds(), ...(tabs ? { tabs: tabs.saved() } : {}) };
  if (!accountStateDir) { if (strict) throw new Error('Account state directory is unavailable.'); return; }
  try { writeWindowState(accountStateDir, state); } catch (error) { if (strict) throw error; /* ordinary save remains best effort */ }
}

/** Links out of the page open in the person's browser; the page never navigates away from Studio. */
function guard(contents, allowed) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (allowed(url)) return;
    event.preventDefault();
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/** IPC only from a tab's page, its own main frame. */
const fromShell = (event) => tabOf(event.sender) != null && event.senderFrame === event.sender.mainFrame;
const fromPage = (event) => desktopAuthActive && fromShell(event) && viewGenerationFence.isCurrent(event.sender,authUiGeneration);
const materialDraftBridge = createMaterialDraftBridge({store:materialDraftStore,isAllowed:fromPage,generation:()=>authUiGeneration,broadcast:value=>{if(!desktopAuthActive)return;for(const view of views.values())if(!view.webContents.isDestroyed()&&viewGenerationFence.isCurrent(view.webContents,authUiGeneration))view.webContents.send('desktop:material-draft',value);}});

/** A page for a tab: Studio's editor at its project (or its launcher), on Studio's origin. */
function makeView(tabId) {
  const v = new WebContentsView({
    webPreferences: {
      preload: here('./preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      autoplayPolicy: 'no-user-gesture-required',
      devTools: true,
    },
  });
  v.setBackgroundColor(BACKGROUND[theme]);
  // A newly attached view must not cover the current page with its initial blank frame.
  v.setVisible(false);
  viewGenerationFence.register(v.webContents,authUiGeneration);
  views.set(tabId, v);
  win.contentView.addChildView(v);
  const { width, height } = win.getContentBounds();
  v.setBounds({ x: 0, y: 0, width, height });
  guard(v.webContents, (url) => Boolean(studio) && url.startsWith(`${studio.origin}/`));
  /* the second way to the developer tools in a development build: F12 is the menu's, Alt+CmdOrCtrl+I is read here
     (a menu item carries one accelerator, and this one must not open and close the tools in the same key press) */
  v.webContents.on('before-input-event', (event, input) => {
    if (readPreferences(DATA).devtools === false) return;
    if (!isDevToolsShortcut(input)) return;
    event.preventDefault();
    toggleDevTools(v, v);
  });
  /* what went wrong with the page, for the log (logs/studio.log) */
  v.webContents.on('render-process-gone', (_event, details) => log(`page: renderer gone (${details.reason}, ${details.exitCode})\n`));
  v.webContents.on('did-fail-load', (_event, code, description, url, mainFrame) => { if (mainFrame && code !== -3 && pagePresentation?.wantedId() === tabId) log(`page: ${description} (${code}) loading ${url.replace(/key=[^&]+/, 'key=…')}\n`); });
  v.webContents.on('unresponsive', () => log('page: not responding\n'));
  /* the page gone (a crash): it comes back where it was; the agents' turns go on in this process meanwhile */
  v.webContents.on('render-process-gone', (_event, details) => { if (details.reason !== 'clean-exit' && !quitting) setTimeout(() => { if (!v.webContents.isDestroyed()) v.webContents.reload(); }, 500); });
  return v;
}

/** The page shown when no tab is open: Studio's projects (`/` with tabs). */
const HOME = 'home';
/** Where a tab's page opens: its project (no tab: the projects). */
const pageAddress = (tab, path = null) => `${studio.origin}/open?key=${studio.key}&to=${encodeURIComponent(path ?? (tab ? `/projects/${encodeURIComponent(tab.projectId)}` : '/'))}`;

/** Every page told of the tabs as they are now; kept for next time. */
function tellTabs() {
  if (!tabs) return;
  broadcast('desktop:tabs', tabs.list());
  saveState();
}

function presentation() {
  return pagePresentation ??= createPagePresentation({
    fallback: HOME,
    prepare(id) {
      const v = makeView(id);
      // A never-visible native view produces no frames. Paint it underneath the outgoing page.
      win.contentView.addChildView(v, 0);
      v.setVisible(true);
      v.webContents.setBackgroundThrottling(false);
      const ready = preparePage(v.webContents, pageAddress(id === HOME ? null : tabs?.get(id)))
        .finally(() => {
          if (v.webContents.isDestroyed()) return;
          v.webContents.setBackgroundThrottling(true);
          if (pagePresentation?.currentId() !== id && pagePresentation?.wantedId() !== id) v.setVisible(false);
        });
      return { view: v, ready };
    },
    present(_id, v) {
      if (!win) return;
      revealPage(win.contentView, v, views.values());
      /* the pages now behind it are told: one waiting to be covered (its projects window opening another tab) is done */
      for (const page of views.values()) if (page !== v && !page.webContents.isDestroyed()) page.webContents.send('desktop:tabs:covered');
    },
    discard: destroyView,
    onError: (error) => { if (!quitting) log(`page: could not prepare replacement (${String(error.message).replace(/key=[^&\s)]+/g, 'key=…')})\n`); },
  });
}

/** Keep only the lightweight projects page ready, without focusing it. */
function warmHome() {
  if (!tabs || !win || quitting) return;
  void presentation().warm(HOME);
}

/** A ready page replaces the old frame; a cold page is prepared before it covers it. */
function showPage(id) {
  if (!win || !studio) return Promise.resolve(false);
  return presentation().show(id).then((shown) => { if (shown && id !== HOME) warmHome(); return shown; });
}

/** Bring a tab to the front. */
function showTab(id) {
  if (!tabs || !tabs.activate(id)) return;
  showPage(id);
  tellTabs();
}

/** A project's tab (in front if it is open already). */
function newTab(projectId) {
  if (!tabs || typeof projectId !== 'string' || !projectId) return;
  showTab(tabs.open({ projectId }).id);
}

/** Let a tab's page go: closed, or behind too long (the tab stays). */
function destroyView(id) {
  const v = views.get(id);
  if (!v) return;
  views.delete(id);
  win?.contentView.removeChildView(v);
  if (!v.webContents.isDestroyed()) v.webContents.close();
}

function dropView(id) { if (pagePresentation) pagePresentation.drop(id); else destroyView(id); }

/** Close a tab; one whose agent is still at work, only once the person says so. */
async function closeTab(id) {
  if (!tabs || !win) return;
  const tab = tabs.get(id);
  if (!tab) return;
  if (tab.working) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Close Tab', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'An agent is still working in this project.', detail: 'Closing the tab stops it.',
    });
    if (response !== 0) return;
  }
  const next = tabs.close(id);
  presentation().retire(id);
  if (next) showTab(next.id);
  else { showPage(HOME); tellTabs(); }
}

/**
 * Projects gone (deleted, here or elsewhere; their folders gone): their tabs close without asking, all those told within
 * a moment together, so the front never lands on a tab about to close, and none can be opened again (tabs.mjs
 * `closeProjects`). Each page of such a project says so, and the page that deleted them says which.
 */
const goneProjects = new Set();
let goneTimer = /** @type {NodeJS.Timeout | null} */ (null);
function projectsGone(/** @type {string[]} */ projectIds) {
  for (const id of projectIds) if (typeof id === 'string' && id) goneProjects.add(id);
  if (!goneTimer) goneTimer = setTimeout(closeGoneTabs, GONE_TOGETHER_MS);
}
function closeGoneTabs() {
  goneTimer = null;
  const ids = [...goneProjects];
  goneProjects.clear();
  if (!tabs || !win || !ids.length) return;
  const { closed, front } = tabs.closeProjects(ids);
  if (!closed.length) return;
  for (const id of closed) presentation().retire(id);
  if (front) showTab(front.id);
  else { showPage(HOME); tellTabs(); }
}

/**
 * Studio's "open this project" (`orangefilm open`, File › Open Project…), heard by every page at once: once only. Its
 * tab comes to the front, opened if it is not.
 */
let lastOpen = { to: '', at: 0 };
function openInTabs(to) {
  if (!tabs || typeof to !== 'string') return;
  if (to === lastOpen.to && Date.now() - lastOpen.at < 2000) return;
  lastOpen = { to, at: Date.now() };
  const projectId = /^\/projects\/([\w-]+)/.exec(to)?.[1] ?? null;
  if (projectId) newTab(projectId);
}

/**
 * The tabs open when the window opens: those left last time (none, when the last were closed: the projects), else, the
 * first time, the last project's; none: the projects.
 */
async function openTabs() {
  const listed = (await studioApi('/api/projects').catch(() => ({ projects: [] }))).projects;
  const projects = listed.filter((p) => !projectGone(listed, p.id));
  tabs = createTabs({ saved: state.tabs ?? null });
  /* a tab of a project no longer there is left out, and not kept to open again */
  const known = new Set(projects.map((p) => p.id));
  tabs.closeProjects(tabs.list().map((t) => t.projectId).filter((id) => !known.has(id)));
  if (!tabs.list().length && !state.tabs && projects[0]) tabs.open({ projectId: projects[0].id, title: projects[0].name });
  const front = tabs.activeId();
  if (front) showTab(front);
  else { showPage(HOME); tellTabs(); }
}

/** The projects the chat's agents work in, and wait for an answer in, by Studio's ids (from their folders), on each tab. */
let projectPaths = new Map();
const agentFolders = { working: /** @type {string[]} */ ([]), asking: /** @type {string[]} */ ([]) };
async function tellTabsWorking({ working = agentFolders.working, asking = agentFolders.asking } = {}) {
  Object.assign(agentFolders, { working, asking });
  if (!tabs) return;
  if ([...working, ...asking].some((f) => !projectPaths.has(f))) {
    projectPaths = new Map((await studioApi('/api/projects').catch(() => ({ projects: [] }))).projects.map((p) => [p.path, p.id]));
  }
  const ids = (folders) => folders.map((f) => projectPaths.get(f)).filter(Boolean);
  if (tabs.setAgents(ids(agentFolders.working), ids(agentFolders.asking))) tellTabs();
}

async function studioApi(path, method = 'GET', body = undefined) {
  const res = await fetch(`${studio.origin}${path}`, {
    method,
    headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Studio answered ${res.status}`);
  return res.json();
}

/**
 * A folder picked by the person (null: cancelled): with no options, one to open as a project (any folder: one not yet
 * a project becomes one); with Studio's own words and starting folder, any other (see folder-dialog.mjs).
 */
async function pickFolder(options) {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, folderDialogOptions(options));
  return canceled || !filePaths[0] ? null : filePaths[0];
}

/** File › Open Project…: the folder picked, shown in the window (Studio switches its pages to it). */
async function openProjectFolder() {
  if (!desktopAuthActive) return;
  const folder = await pickFolder();
  if (!folder || !studio) return;
  try {
    await studioApi('/api/open', 'POST', { path: folder, fallback: 0 });
    focusWindow();
  } catch (error) {
    void dialog.showMessageBox(win, { type: 'warning', message: 'This folder can’t be opened as a project.', detail: error.message });
  }
}

/* the own key, sealed with the system's keychain where there is one (Windows DPAPI; macOS Keychain only when asked).
   macOS 未签名构建访问钥匙串会卡住主进程等用户点“允许”，窗口就黑在那里——默认在 macOS 上走 0600 文件式密钥，
   签名之后再用 ORANGE_KEYCHAIN=1 打开钥匙串。 */
const keychainSealing = () => process.platform !== 'darwin' || process.env.ORANGE_KEYCHAIN === '1';
const seal = (text) => (keychainSealing() && safeStorage.isEncryptionAvailable() ? Buffer.concat([Buffer.from('enc:'), safeStorage.encryptString(text)]) : Buffer.from(`raw:${text}`));
const unseal = (data) => {
  const kind = data.subarray(0, 4).toString();
  if (kind !== 'enc:') return data.subarray(4).toString();
  try { return safeStorage.decryptString(data.subarray(4)); } catch { return ''; }
};

/** The page's theme (Studio's), for the window behind it and the system's menus and dialogs. */
function setTheme(next) {
  theme = next === 'dark' ? 'dark' : 'light';
  nativeTheme.themeSource = theme;
  win?.setBackgroundColor(BACKGROUND[theme]);
  for (const v of views.values()) v.setBackgroundColor(BACKGROUND[theme]);
  if (windows) win?.setTitleBarOverlay?.(overlayColours(theme));
}

/** Tell Studio which folders the chat's agents are working in now. */
function tellWorking(/** @type {string[]} */ folders) {
  studio?.child.postMessage({ type: 'working', folders });
  void tellTabsWorking({ working: folders });
}

/** Studio's questions for the person's agent that are being answered, by id: each stops with its controller. */
const asked = new Map();

/**
 * Studio asks the person's agent a question of its own (studio-process.mjs askAgent): the agent the chat last started a
 * conversation with, else the first one ready in Settings → Agents, answers with its own model and no chat. None ready:
 * `code: 'no-agent'`, so Studio says to connect one.
 * @type {import('./studio.mjs').AskHandler}
 */
function answerStudio(message, reply) {
  if (message.type === 'ask-cancel') { asked.get(message.id)?.abort(); return; }
  const ready = (roster?.list() ?? []).filter((a) => a.status === 'ready').map((a) => a.id);
  const last = localAgents?.lastAgent();
  const agent = last && ready.includes(last) ? last : ready[0];
  if (!agent || !localAgents) { reply({ type: 'answer', id: message.id, error: 'No agent is connected.', code: 'no-agent' }); return; }
  const stop = new AbortController();
  asked.set(message.id, stop);
  localAgents.ask(agent, String(message.text ?? ''), stop.signal)
    .then((text) => reply({ type: 'answer', id: message.id, text }))
    .catch((error) => { if (!stop.signal.aborted) reply({ type: 'answer', id: message.id, error: error?.message ?? String(error), ...(error?.code ? { code: String(error.code) } : {}) }); })
    .finally(() => asked.delete(message.id));
}

/** when the running Studio started, and the wait before it did (studio-restart.mjs) */
let startedAt = 0;
let restartWait = 0;

async function runStudio(env) {
  startedAt = Date.now();
  /* a Studio starting again takes a fresh material service with its own origin, so the last one is stopped first */
  await stopMaterials();
  /* Studio serves the window's page as its editor (shell/: its editor with the chat beside it) */
  /* its diagnostic file takes the app's own logs too (Studio's diagnostics.mjs) */
  const studioEnv = { ...env, ORANGE_EDITOR_DIR: windowEditorDirectory({packaged:app.isPackaged,isolated:Boolean(isolation),explicit:process.env.ORANGE_EDITOR_DIR,bundled:here('../shell/dist/')}), ORANGE_APP_LOGS: LOGS };
  const studioOptions = {
    onAsk: answerStudio,
    home: env.ORANGE_HOME,
    port: isolation?.ports.studio ?? IDENTITY.studioPort,
    log,
    onAuth: (next, scope) => {
      if (!next || typeof next.kind !== 'string') return;
      if (next.kind === 'active' && typeof scope === 'string' && /^[0-9a-f]{64}$/.test(scope)) {
        try { if(draftSessionOpen)materialDraftStore.resume(authUiGeneration,scope);else{materialDraftStore.startSession(authUiGeneration,scope);draftSessionOpen=true;} resumeAgentAdmission(); localAgents?.resume(); agentRetirement=null; }
        catch { materialDraftStore.lock();desktopAuthActive=false;broadcast('desktop:auth',{kind:'locked',reason:'preservation-failed',uiGeneration:authUiGeneration}); return; }
        accountStateDir = join(DATA,'orange-accounts',scope);
        state = {...state,tabs:readWindowState(accountStateDir).tabs};
        desktopAuthActive = true;
        broadcast('desktop:auth',{...next,uiGeneration:authUiGeneration});
        /* 索引构建要带着登录后的会话（否则 /api/materials/list 403）：登录成功后再在后台建一次。 */
        startMaterialIndexBootstrap();
        void openTabs();
      } else {
        materialDraftStore.lock();saveState();desktopAuthActive = false;
        broadcast('desktop:auth',{...next,uiGeneration:authUiGeneration});
        if (studio && win) void showPage(HOME);
      }
    },
    onAuthRetire: async () => {
      materialDraftStore.lock();
      // Hold the original window/views until both real Agent receipts and strict save succeed.
      try { await retireAgents(); saveState(true); } catch { return false; }
      desktopAuthActive = false;
      const current=[...views.entries()].filter(([id])=>id!==HOME);
      try {
        await Promise.all(current.map(([id,view])=>new Promise((resolve,reject)=>{
          const contents=view.webContents;
          if(contents.isDestroyed())return resolve(undefined);
          const timer=setTimeout(()=>reject(new Error('Page preservation is unconfirmed.')),5000);
          contents.once('destroyed',()=>{clearTimeout(timer);views.delete(id);resolve(undefined);});
          contents.close({waitForBeforeUnload:true});
        })));
      } catch { return false; }
      tabs=null;accountStateDir=null;
      return true;
    },
    onAuthRetired: () => { materialDraftStore.retire();draftSessionOpen=false;authRetirementConfirmed = true;authUiGeneration += 1; },
    onOpen: (url) => {
      /* Studio would open a browser for an address of its own: the window already shows Studio */
      if (studio && url.startsWith(studio.origin)) focusWindow();
      else if (/^https?:/i.test(url)) void shell.openExternal(url);
    },
    onBrowser: (message) => {
      if (message.type === 'ffmpeg') { if (!ffmpegFetching) tellFfmpeg(message.found); }
      else broadcast('desktop:studio-browser', message);
    },
    onExit: (code) => {
      if (quitting) return;
      desktopAuthActive = false;
      broadcast('desktop:auth',{kind:'locked',reason:authRetirementConfirmed?'preservation-pending':'preservation-failed'});
      if (!authRetirementConfirmed) { sealAgentAdmission(); return; }
      if (authRetirementConfirmed && code === 0) {
        authRetirementConfirmed = false;
        for (const id of [...views.keys()]) destroyView(id);
        pagePresentation=null;
        void runStudio(env).catch(()=>log('Studio could not restart after account retirement.\n'));
        return;
      }
      /* stopping again and again at once: started again later each time (studio-restart.mjs) */
      restartWait = restartDelay(restartWait, Date.now() - startedAt);
      log(`Studio stopped (${code}); starting it again in ${restartWait / 1000} s\n`);
      setTimeout(() => void runStudio(env).catch((error) => log(`Studio did not start again: ${error.message}\n`)), restartWait);
    },
  };
  /* The material service first: Studio builds its material routes from the two variables the service handle gives
     (upstream and shared secret) while it is constructed, so a service started afterwards is one Studio never hears
     about — its three routes answer 501 for that Studio's whole life. */
  studio = await startStudioBesideMaterials({
    env: studioEnv,
    materials: () => startMaterials([]),
    launch: (prepared) => startWindowStudio({ ...studioOptions, env: prepared }),
  });
  /* a Studio started again hears where the agents are working */
  try { writeFileSync(join(DATA, 'run-key.txt'), String(studio.key ?? ''), 'utf8'); } catch { /* the crawler has the env key */ }
  tellWorking(localAgents?.working() ?? []);
  /* 会话若是恢复的，登录回调不一定再走一遍：轮询到 active 再建索引（只建一次，最多等 10 分钟）。 */
  {
    let started = false;
    const attempt = async () => {
      if (started) return;
      try {
        const state = await studioApi('/api/auth/state');
        if (state?.kind === 'active') { started = true; startMaterialIndexBootstrap(); }
      } catch { /* Studio still starting */ }
    };
    const timer = setInterval(() => void attempt(), 5_000);
    setTimeout(() => clearInterval(timer), 10 * 60_000);
    void attempt();
  }
  /* the first time, the tabs; a Studio started again: each page stays where it was */
  if (!tabs) { await openTabs(); return; }
  for (const [id, v] of views) {
    const at = v.webContents.getURL();
    await v.webContents.loadURL(pageAddress(tabs.get(id), at.startsWith('http') ? new URL(at).pathname : null));
  }
}

async function start() {
  /* updates (updates.mjs): Restart waits while an agent's turn runs or Studio exports, either would be lost */
  updates = startUpdates({
    dataDir: DATA,
    productName: DISPLAY_NAME,
    getWindow: () => win,
    onState: (next) => broadcast('desktop:update', next),
    prepareRestart: async () => {
      if (localAgents?.isBusy()) return { ok: false, error: 'agent-busy' };
      /* Studio's quit-when-idle answers 409 while it exports; otherwise the window's Studio stays (studio-process.mjs
         `stays`, 423), and is stopped in beforeInstall. No answer: no Studio, no export to lose. */
      const res = studio && await fetch(`${studio.origin}/api/quit`, {
        method: 'POST', headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' },
        body: JSON.stringify({ whenIdle: true }), signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      return res?.status === 409 ? { ok: false, error: 'exporting' } : { ok: true };
    },
    /* what before-quit would do, done first (`quitting`), so the quit Squirrel starts is not held up or cancelled */
    beforeInstall: async () => {
      for (const v of views.values()) v.webContents.on('will-prevent-unload', (event) => event.preventDefault());
      await quitAfterStudio({preventDefault(){}},{
        quitting:false,markQuitting:()=>{quitting=true;},studio,closeAgents:retireAgents,
        confirmQuit:()=>{quitConfirmed=true;},quit:()=>{},
        onFailure:error=>{quitting=false;desktopAuthActive=false;broadcast('desktop:auth',{kind:'locked',reason:'preservation-failed'});throw error;},
      });
      updates?.close();
    },
  });
  /* an update quitting did not install is installed now, before anything else opens (update-launch.mjs) */
  const launch = updates ? await updates.installAtLaunch({ language: state.language }) : {installing:false,dismiss(){}};
  if (launch.installing) return;
  /* Windows' registered apps, read from now on: the first look at the agents and a conversation reopened at once wait for them */
  if (windows) void firstWindowsApps();

  const shellEnv = await loginShellEnvironment();
  /* Fission in an installed app (src/fission-config.mjs): the package ships its CLI under resources/fission
     (scripts/fission-publish.mjs), but the configuration Studio reads needs absolute paths and the install folder
     is chosen at install time, so it is written here, at startup, into the app's data folder. An explicit
     ORANGE_FISSION_CONFIG_FILE (development, or a machine testing another build) wins and nothing is written; a
     copy of the app with no Fission writes nothing and starts with the feature absent, as before. */
  const fissionConfig = process.env.ORANGE_FISSION_CONFIG_FILE
    ?? writeFissionConfigFile({ resourcesPath: process.resourcesPath, dataDir: DATA });
  /* The Studio signs into the environment this build names — the packaged description, or the local one — written out
     as the three-key file desktop-auth reads; an explicit ORANGE_AUTH_CONFIG_FILE still wins. */
  const authRuntime = await materializeAuthEnvironmentFile({
    dataDir: DATA,
    resourcesDir: app.isPackaged ? process.resourcesPath : undefined,
    requireDescription: app.isPackaged,
  });
  if (authRuntime.error) console.error(`[auth] ${authRuntime.code}: ${authRuntime.message}`);  const env = childEnvironment({
    shell: shellEnv,
    extra: {
      ORANGE_HOME: IDENTITY.studioHome ?? studioHomeDir(),
      /* 素材索引的落点：Studio 的索引路由要读同一份（后台构建见 startMaterialIndexBootstrap）。 */
      ORANGE_MATERIAL_INDEX_DIR: MATERIAL_INDEX_DIR,
      ...(() => {
        const tenant = process.env.ORANGE_MEDIA_TENANT ?? process.env.ORANGE_MEDIA_TENANT
          ?? (process.env.ORANGE_DESKTOP_FLAVOR === 'dev' ? 'tenant-a' : null);
        const key = process.env.ORANGE_MEDIA_TENANT ? 'ORANGE_MEDIA_TENANT' : 'ORANGE_MEDIA_TENANT';
        return tenant ? { [key]: tenant } : {};
      })(),
      ...(process.env.ORANGE_EMBED_MODE ? { ORANGE_EMBED_MODE: process.env.ORANGE_EMBED_MODE } : {}),
      ...(process.env.ORANGE_EMBED_ENDPOINT ? { ORANGE_EMBED_ENDPOINT: process.env.ORANGE_EMBED_ENDPOINT } : {}),
      ...((IDENTITY.library ?? process.env.ORANGE_LIBRARY) ? { ORANGE_LIBRARY: IDENTITY.library ?? process.env.ORANGE_LIBRARY } : {}),
      /* a flavour with a home of its own still shares the person's library (src/locations.mjs) */
      ...(IDENTITY.sharedHome ? { ORANGE_SHARED_HOME: IDENTITY.sharedHome } : {}),
      /* the app names Studio's home, which would put exports inside it (Studio's rule for a home kept apart): the
         Desktop, where `orangefilm` puts them, unless this is a flavour with a home of its own */
      ...(IDENTITY.studioHome || process.env.ORANGE_EXPORTS ? {} : { ORANGE_EXPORTS: app.getPath('desktop') }),
      /* another examples index (a file, to try one), passed through when run from source */
      ...(process.env.ORANGE_EXAMPLES_INDEX ? { ORANGE_EXAMPLES_INDEX: process.env.ORANGE_EXAMPLES_INDEX } : {}),
      /* another OrangeFilm service (a local one, to develop it), passed through when run from source */
      ...(process.env.ORANGE_API_URL ? { ORANGE_API_URL: process.env.ORANGE_API_URL } : {}),
      ...(authRuntime?.file ? { ORANGE_AUTH_CONFIG_FILE: authRuntime.file } : {}),
      /* and, when there is none, why: an installed app whose installer is incomplete says so in the window, instead of
         asking its user to provide a configuration they have no way to provide */
      ...(authRuntime?.error ? { ORANGE_AUTH_ENV_REASON: authEnvironmentReason(authRuntime.code) } : {}),
      ...(fissionConfig ? { ORANGE_FISSION_CONFIG_FILE: fissionConfig } : {}),
    },
  });


  /* what the installer brings (scripts/release.mjs): ffmpeg and ffprobe, first on the PATH of Studio and of the
     agents' `orangefilm` command, and the headless browser Studio and `orangefilm` draw pages in. A build without them
     (from source): no ffmpeg on this computer, the app's own goes first on the PATH and is downloaded once the window
     is up (they find it the moment it lands); the browser, Studio downloads the first time (studio-process.mjs) */
  const runtime = app.isPackaged ? join(process.resourcesPath, 'runtime') : null;
  const ownFfmpeg = runtime && ffmpegIn(join(runtime, 'ffmpeg')) ? join(runtime, 'ffmpeg') : null;
  const needFfmpeg = !isolation && !ownFfmpeg && !ffmpegOnPath(env.PATH) && ffmpegDownloadable();
  const ffmpegHere = ownFfmpeg ?? (needFfmpeg ? ffmpegDir(DATA) : null);
  if (ffmpegHere) env.PATH = [ffmpegHere, env.PATH].join(PATH_SEP);
  const browsers = isolation ? {PLAYWRIGHT_BROWSERS_PATH:env.PLAYWRIGHT_BROWSERS_PATH} : runtime && existsSync(join(runtime, 'ms-playwright')) ? { PLAYWRIGHT_BROWSERS_PATH: join(runtime, 'ms-playwright') } : {};
  Object.assign(env, browsers);

  const display = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1480, display.width);
  const height = Math.min(920, display.height);
  const fallback = { x: display.x + Math.round((display.width - width) / 2), y: display.y + Math.round((display.height - height) / 2), width, height };
  const bounds = placeOnDisplays(state.bounds, screen.getAllDisplays(), fallback);

  win = new BaseWindow({
    ...bounds,
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    show: false,
    title: DISPLAY_NAME,
    backgroundColor: BACKGROUND[theme],
    ...(mac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 10 } } : {}),
    /* Windows: no title bar either; its own buttons drawn over Studio's top bar, at its right, in its colors */
    ...(windows ? { titleBarStyle: 'hidden', titleBarOverlay: overlayColours(theme), autoHideMenuBar: true, icon: here('../build/icon.png') } : {}),
  });
  if (state.maximized) win.maximize();
  launch.dismiss();

  win.on('resize', layout);
  win.on('resized', saveState);
  win.on('moved', saveState);
  win.on('enter-full-screen', () => broadcast('desktop:full-screen', true));
  win.on('leave-full-screen', () => broadcast('desktop:full-screen', false));
  cancelWindowClose = keepWindowOnClose(win, { mac, isQuitting: () => quitting, save: saveState, requestQuit: () => app.quit(), canClose: () => quitConfirmed });
  win.on('closed', () => { win = null; views.clear(); pagePresentation = null; app.quit(); });

  ipcMain.on('desktop:theme', (event, next) => { if (fromPage(event)) setTheme(next); });
  /* the page's language, kept for what the app shows before a page is up (the update installed at launch), and
     the menu bar's (showMenu) */
  let menuLanguage = null;
  ipcMain.on('desktop:language', (event, next) => {
    if (!fromPage(event) || typeof next !== 'string' || next === state.language) return;
    state = { ...state, language: next.slice(0, 20) };
    if (accountStateDir) try { writeWindowState(accountStateDir, state); } catch { /* kept until next time */ }
    showMenu();
  });
  /* our own channels — the account UI's state and the shared material draft — registered by their one entry
     (orange-ipc.mjs); OrangeFilm's own (the chat, the agents, the skills, the tabs) keep the registrations below */
  registerOrangeIpc({
    ipcMain,
    isAllowed: (event) => fromShell(event) && viewGenerationFence.isCurrent(event.sender, authUiGeneration),
    authUiState: () => ({ active: desktopAuthActive, uiGeneration: authUiGeneration }),
    materialDraft: materialDraftBridge,
  });
  ipcMain.handle('desktop:hello', (event) => {
    if (!fromShell(event)) throw new Error('not the window\'s page');
    return { flavor: FLAVOR, version: app.getVersion(), ffmpeg: ffmpegFound, update: updates?.snapshot() ?? null, chatOpen: state.chatOpen, chatWidth: state.chatWidth, chatMin: CHAT_MIN, studioMin: STUDIO_MIN, fullScreen: Boolean(win?.isFullScreen()) };
  });
  /* the chat's column as the person left it (the page sizes it; the window keeps it for next time) */
  ipcMain.on('desktop:layout', (event, next) => {
    if (!fromPage(event) || !next || typeof next !== 'object') return;
    const width = Number(next.chatWidth);
    state = { ...state, chatOpen: next.chatOpen === true, ...(Number.isFinite(width) ? { chatWidth: Math.max(CHAT_MIN, Math.round(width)) } : {}) };
    saveState();
  });
  /* the chat's record of each project (in the project's .film/chat and .film/logs) and the app's own preferences */
  registerChatIpc(ipcMain, {
    trusted: fromPage,
    projects: async () => { const { projects } = await studioApi('/api/projects'); return projects.filter((p) => !projectGone(projects, p.id)).map((p) => p.path); },
    dataDir: DATA,
    reveal: (path) => shell.showItemInFolder(path),
    trash: (path) => shell.trashItem(path),
    tell: (channel, value) => broadcast(channel, value),
    log,
  });
  /* the tabs, drawn by each page in Studio's top bar: asked for, and told of every change (tellTabs) */
  const tabHandle = (channel, fn) => ipcMain.handle(channel, (event, opts) => {
    if (!fromPage(event)) throw new Error('not the window\'s page');
    return fn(tabOf(event.sender), opts ?? {});
  });
  tabHandle('desktop:tabs:list', (self) => ({ self, tabs: tabs?.list() ?? [] }));
  tabHandle('desktop:tabs:new', (_self, { projectId }) => { newTab(projectId); return { ok: true }; });
  tabHandle('desktop:tabs:show', (_self, { id }) => { showTab(String(id)); return { ok: true }; });
  tabHandle('desktop:tabs:close', (self, { id }) => { void closeTab(typeof id === 'string' ? id : self); return { ok: true }; });
  tabHandle('desktop:tabs:move', (_self, { id, index }) => { if (tabs?.move(String(id), Number(index))) tellTabs(); return { ok: true }; });
  /* what a page shows now: its project's title, an export's progress; or its project gone */
  tabHandle('desktop:tabs:report', (self, { title, exporting, gone }) => {
    if (!tabs) return { ok: false };
    /* its project gone (deleted, in this page or another; its folder gone): its tab closes, without asking. Asked of
       Studio first: a tab closed stops its agent, and a project missing only film.html is not gone (tabs.mjs projectGone) */
    if (gone === true) {
      const tab = tabs.get(self);
      if (tab) {
        void studioApi('/api/projects').then(({ projects }) => { if (projectGone(projects, tab.projectId)) projectsGone([tab.projectId]); }, () => {});
      }
      return { ok: true };
    }
    tabs.report(self, { ...(typeof title === 'string' ? { title: title.slice(0, 200) } : {}), ...(exporting !== undefined ? { exporting: typeof exporting === 'number' ? exporting : null } : {}) });
    tellTabs();
    return { ok: true };
  });
  /* projects this page deleted: their tabs close together (projectsGone) */
  tabHandle('desktop:tabs:gone', (_self, { projectIds }) => {
    if (Array.isArray(projectIds)) projectsGone(projectIds.filter((id) => typeof id === 'string'));
    return { ok: true };
  });
  /* another tab's project renamed from this page's tabs: its title, also while that tab has no page to say it */
  tabHandle('desktop:tabs:retitle', (_self, { id, title }) => {
    if (typeof title === 'string' && tabs?.report(String(id), { title: title.slice(0, 200) })) tellTabs();
    return { ok: true };
  });
  /* Studio's "open this project", heard by each page: settled once here */
  tabHandle('desktop:tabs:open', (_self, { to }) => { openInTabs(to); return { ok: true }; });
  /* a tab left behind long enough lets its page go; it comes back when shown */
  setInterval(() => { for (const id of tabs?.idle(IDLE_PAGE_MS) ?? []) dropView(id); }, 60_000).unref?.();

  /* the agents: Studio's home and library go with them, so the `orangefilm` they run finds this window's Studio */
  /* the person's own skills: Skills/ beside this app's projects (~/Movies/OrangeFilm/Skills), as its `orangefilm` finds them */
  /* which official skills are installed and which skills are off: the prefs.json every OrangeFilm here shares (orangefilm/skills usableSkills) */
  const prefsHome = env.ORANGE_SHARED_HOME || env.ORANGE_HOME;
  const mySkills = process.env.ORANGE_SKILLS || (env.ORANGE_LIBRARY ? join(dirname(env.ORANGE_LIBRARY), 'Skills') : (await import('orangefilm/skills')).mySkillsDir());
  localAgents = registerLocalAgentIpc(ipcMain, {
    trusted: event => fromPage(event) && desktopAuthActive,
    log,
    /* Studio refuses to delete a project an agent is working in */
    onWorking: tellWorking,
    /* a tab says when its agent waits for the person's answer */
    onAsking: (folders) => void tellTabsWorking({ asking: folders }),
    onConnectionResult: (id, error) => roster?.recordConnectionResult(id, error),
    /* the `orangefilm` command first (with the app's ffmpeg and browser in it); the app's ffmpeg last, for a computer
       that has none of its own: the person's own ffmpeg and browsers are what the agent's commands use */
    binDir: installOpenfilmCommand(DATA, { ffmpeg: ffmpegHere, env: { ...browsers, ...(isolation ? isolationEnvironment(isolation) : {}) } }),
    fallbackDir: ffmpegHere,
    env: {
      ...(isolation ? isolationEnvironment(isolation) : {}),
      ORANGE_HOME: env.ORANGE_HOME,
      ...(env.ORANGE_LIBRARY ? { ORANGE_LIBRARY: env.ORANGE_LIBRARY } : {}),
      ...(env.ORANGE_SHARED_HOME ? { ORANGE_SHARED_HOME: env.ORANGE_SHARED_HOME } : {}),
    },
    harness: async (id) => roster?.harness(id) ?? null,
    /* Developer mode: an agent whose own record lacks what its model got logs it here (agent-logs.mjs) */
    logDir: () => (readPreferences(DATA).developer ? join(DATA, 'agent-logs') : null),
    /* each session's skills: its maker's, OrangeFilm's, and of the person's own those let in (agent-skills.mjs) */
    skills: { dataDir: DATA, mine: mySkills, prefsHome },
  });
  /* the composer's Skills button */
  registerSkillsIpc(ipcMain, {
    trusted: fromPage,
    projects: async () => { const { projects } = await studioApi('/api/projects'); return projects.filter((p) => !projectGone(projects, p.id)).map((p) => p.path); },
    dataDir: DATA,
    mine: mySkills,
    prefsHome,
    oldMine: join(env.ORANGE_HOME, 'skills'),
    reveal: (path) => { void shell.openPath(path); },
    pickFolder: (words) => pickFolder(words),
    refreshSkills: (agent) => localAgents?.refreshSkills(agent),
    log,
  });
  /* Settings → Agents (in Studio's page) and the chat's agent menu: one roster, both told of every change */
  roster = createRoster({
    dataDir: DATA,
    localAgents: listAgents,
    localAgent,
    openSignIn: (id) => openAgentSignIn(id, { track: true }),
    /* Switch account: its own sign-out, with no window, before its sign-in */
    signOut: signOutAgent,
    /* an agent's official installer, in a terminal window, once the person agreed to it in Settings → Agents */
    openInstaller: openAgentInstaller,
    /* sessions closed on connecting, disconnecting and switching account: the next look at its usage is for whichever
       account is used now */
    closeSessions: (id) => { forgetAgentUsage(id); localAgents?.closeAgent(id); },
    resetAgent: (id) => { forgetAgentStatus(id); forgetAgentUsage(id); localAgents?.refreshSkills(id); },
    seal,
    unseal,
    onChange: (list) => broadcast('desktop:agents', list),
    /* the program the person points at, for an agent not found where it is looked for */
    usePaths: setChosenPaths,
    pickProgram: async (_id, words) => {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, programDialogOptions(words));
      return canceled || !filePaths[0] ? null : filePaths[0];
    },
    checkProgram: checkAgentProgram,
    diagnose: (id) => diagnoseAgent(id, { appVersion: app.getVersion() }),
  });
  const agentHandle = (channel, fn) => ipcMain.handle(channel, (event, opts) => {
    if (!fromPage(event) || !desktopAuthActive) throw new Error('not the active account page');
    return fn(opts ?? {});
  });
  agentHandle('desktop:agents:list', () => { void roster.refresh(); return roster.list(); });
  agentHandle('desktop:agents:refresh', () => roster.recheck());
  agentHandle('desktop:agents:connect', ({ id }) => roster.connect(String(id)));
  agentHandle('desktop:agents:cancel-sign-in', ({ id }) => { roster.cancelSignIn(String(id)); return { ok: true }; });
  agentHandle('desktop:agents:disconnect', ({ id }) => { roster.disconnect(String(id)); return { ok: true }; });
  agentHandle('desktop:agents:switch-account', ({ id }) => roster.switchAccount(String(id)));
  /* what is left of Claude Code's and Codex's plan, on OrangeFilm's sign-in (agent-usage.mjs); null when it can't say */
  agentHandle('desktop:agents:usage', ({ id, fresh }) => agentUsage(String(id), { fresh: fresh === true }));
  agentHandle('desktop:agents:locate', ({ id, words }) => roster.locate(String(id), words));
  agentHandle('desktop:agents:automatic', ({ id }) => roster.useAutomatic(String(id)));
  agentHandle('desktop:agents:install', ({ id }) => roster.install(String(id)));
  agentHandle('desktop:agents:diagnose', ({ id }) => roster.diagnose(String(id)));
  agentHandle('desktop:agents:setup', async ({ id }) => {
    if (id !== 'claude') return { ok: false, error: 'No desktop setup for this agent.' };
    try { await shell.openExternal('claude://'); return { ok: true }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  });
  /* the app's part of Studio's diagnostic report (app-report.mjs): the agents as found now, each one's --version */
  const appReport = () => gatherAppReport({ list: () => roster.refresh(), check: checkAgentProgram }, {
    version: app.getVersion(), flavor: FLAVOR, packaged: app.isPackaged, channel: updates?.snapshot()?.channel ?? null,
    electron: process.versions.electron, pathSource: lastPathSource(),
  });
  agentHandle('desktop:agents:report', appReport);
  /* the chat's "Copy diagnostic report" by a turn that failed: what Studio's report has (`orangefilm doctor`, with the
     last week's problems) and the app's agents, on the clipboard (the chat's page may not be let write it) */
  agentHandle('desktop:diagnostics:copy', async () => {
    const [computer, own] = await Promise.all([
      studioApi('/api/doctor').then((r) => String(r.text ?? ''), () => ''),
      appReport().catch(() => ''),
    ]);
    const text = [computer, own].filter(Boolean).join('\n\n────────\n\n');
    if (!text) return { ok: false };
    clipboard.writeText(text);
    return { ok: true };
  });
  agentHandle('desktop:agents:shown', ({ id, shown }) => { roster.setShown(String(id), shown === true); return { ok: true }; });
  agentHandle('desktop:agents:own-model', ({ config }) => roster.saveOwnModel(config));
  agentHandle('desktop:agents:own-model-remove', ({ id }) => { roster.removeOwnModel(String(id)); return { ok: true }; });
  ipcMain.handle('desktop:reveal', (event, path) => { if (fromPage(event) && typeof path === 'string' && path) shell.showItemInFolder(path); });
  ipcMain.handle('desktop:pick-folder', (event, options) => (fromPage(event) ? pickFolder(options) : null));
  /* a picture of part of the window (the viewer, for a reference in the chat): what the person sees, as JPEG */
  ipcMain.handle('desktop:capture', async (event, rect) => {
    if (!fromPage(event) || !rect || typeof rect !== 'object') return null;
    const box = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    if (!Object.values(box).every((n) => Number.isFinite(n)) || box.width < 2 || box.height < 2 || box.width > 8000 || box.height > 8000) return null;
    const image = await event.sender.capturePage(box).catch(() => null);
    return image && !image.isEmpty() ? image.toJPEG(88).toString('base64') : null;
  });

  ipcMain.handle('desktop:update-restart', (event) => (fromPage(event) ? updates?.restart() : { ok: false }));
  /* Settings → About: the state now, and a check that answers with the state it ends in (no dialog) */
  ipcMain.handle('desktop:update-state', (event) => (fromPage(event) ? updates?.snapshot() ?? null : null));
  ipcMain.handle('desktop:update-check', (event) => (fromPage(event) ? updates?.check() ?? null : null));

  /* the menu bar speaks the page's language (the system's until the page says), built again when it changes */
  function showMenu() {
    const language = appLanguage(state.language, app.getPreferredSystemLanguages());
    if (language === menuLanguage) return;
    menuLanguage = language;
    Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate({
      language,
      productName: DISPLAY_NAME,
      packaged: app.isPackaged,
      toggleChat: () => activeView()?.webContents.send('desktop:toggle-chat'),
      openProject: () => void openProjectFolder(),
      openSettings: () => { focusWindow(); activeView()?.webContents.send('desktop:open-settings'); },
      reload: () => activeView()?.webContents.reload(),
      devTools: () => { if (readPreferences(DATA).devtools !== false) toggleDevTools(activeView(), views.get(HOME)); },
      tabs: {
        /* the projects window, in the page in front, to pick the project a new tab shows */
        open: () => activeView()?.webContents.send('desktop:tabs:pick') ?? views.get(HOME)?.webContents.focus(),
        close: () => closeTabOrWindow(win, { mac, activeId: tabs?.activeId(), closeTab }),
        reopen: () => { const tab = tabs?.reopen(); if (tab) showTab(tab.id); },
        step: (by) => {
          const list = tabs?.list() ?? [];
          const i = list.findIndex((t) => t.active);
          if (list.length > 1) showTab(list[(i + by + list.length) % list.length].id);
        },
        pick: (n) => { const list = tabs?.list() ?? []; const tab = n === 9 ? list.at(-1) : list[n - 1]; if (tab) showTab(tab.id); },
      },
      updates: updates.packaged ? {
        check: () => updates.manualCheck(menuLanguage),
        beta: updates.channel() === 'beta',
        setBeta: (on) => updates.setChannel(on ? 'beta' : 'stable'),
      } : null,
    })));
  }
  showMenu();

  win.show();
  if (needFfmpeg) {
    ffmpegFetching = true;
    let shownAt = 0;
    tellFfmpeg({ state: 'downloading', progress: 0 });
    void ensureFfmpeg(DATA, {
      onProgress: (progress) => { if (Date.now() - shownAt > 500) { shownAt = Date.now(); tellFfmpeg({ state: 'downloading', progress }); } },
    }).then(() => tellFfmpeg(true), (error) => { log(`ffmpeg did not download: ${error.message}\n`); tellFfmpeg({ state: 'failed', message: error.message }); })
      .finally(() => { ffmpegFetching = false; });
  }
  try {
    await runStudio(env);
  } catch (error) {
    log(`Studio did not start: ${error.stack ?? error}\n`);
    const v = makeView('failed');
    v.setVisible(true);
    void v.webContents.loadFile(here('./failed.html'), { query: { message: String(error.message ?? error), ...(error?.code === 'ISOLATED_RUN_EXISTS' ? { code: 'ISOLATED_RUN_EXISTS' } : {}) } });
  }
}

/* a terminal's Ctrl-C, or the launcher passing one on: quit the way the menu does, so Studio writes its history */
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
/* a main process that is going down for any other reason: the child must not outlive it (stop is not awaited here) */
process.on('exit', () => { try { materials?.kill(); } catch { /* already gone */ } });
app.on('activate', () => focusWindow());
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if(quitConfirmed)return;
  /* quits first, joins later: the quit path below is what decides when the app actually leaves */
  void stopMaterials();
  quitAfterStudio(event, {
    quitting, markQuitting: () => { quitting = true; }, studio,
    /* and the ones opened only to ask (signed in? its options?), which belong to no chat */
    closeAgents: retireAgents, quit: () => app.quit(),
    confirmQuit: () => { quitConfirmed=true; },
    onFailure: () => { quitting=false;desktopAuthActive=false;broadcast('desktop:auth',{kind:'locked',reason:'preservation-failed'}); },
  });
});
