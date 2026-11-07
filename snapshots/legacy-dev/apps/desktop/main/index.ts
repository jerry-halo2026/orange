import { isTrustedShellUrl } from './shell-trust.ts';
import { createStudioController, studioBounds, studioRequestAllowed } from './studio-host.ts';
import { installStudioIpc } from './studio-ipc.ts';
import experienceRuntime from 'virtual:orange-studio-experience';
import { installAuthIpc } from './auth-ipc.ts';
import { randomUUID } from 'node:crypto';
import { close, constants, fstatSync, mkdtempSync, mkdirSync, write } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hrtime } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeStartupFrame, projectStartupFailure, type K07Record } from '@orange/contracts';
import { startStudioFixture, startStudioExperience } from '@orange/film-adapter/node';
import { app, BrowserWindow, session, WebContentsView, type OnBeforeRequestListenerDetails, type WebFrameMain } from 'electron';

declare const __ORANGE_BUILD_COMMIT__: string;
declare const __ORANGE_BUILD_VERSION__: string;
declare const __ORANGE_STUDIO_RECEIPT_SHA256__: string;

const verificationFd = 3;
const deliveryBudgetMs = 750;

function writeFrame(frame: string): Promise<boolean> {
  const bytes = Buffer.from(frame, 'utf8');
  return new Promise((resolve) => {
    const send = (offset: number) => {
      try {
        write(verificationFd, bytes, offset, bytes.length - offset, null, (error, length) => {
          if (error || length <= 0) resolve(false);
          else if (offset + length < bytes.length) send(offset + length);
          else resolve(true);
        });
      } catch {
        resolve(false);
      }
    };
    send(0);
  });
}

function closeVerificationPipe(): Promise<void> {
  return new Promise((resolve) => {
    try { close(verificationFd, () => resolve()); } catch { resolve(); }
  });
}

type StartupFailureStage = 'startup' | 'loadFile';

function openStartupDiagnostic() {
  if (!process.argv.includes('--orange-diagnostics-fd3')) return;
  const start = hrtime.bigint();
  try {
    // Windows exposes the inherited pipe's S_IFIFO mode, even though Node's
    // Stats.isFIFO() reports false on that platform.
    if ((fstatSync(verificationFd).mode & constants.S_IFMT) !== constants.S_IFIFO) return;
  } catch {
    return;
  }
  const traceId = randomUUID().replaceAll('-', '');
  const common = {
    schemaVersion: 1,
    component: 'desktop.main',
    traceId,
    environment: 'local',
    appVersion: __ORANGE_BUILD_VERSION__,
    buildCommit: __ORANGE_BUILD_COMMIT__,
  } as const;
  const identity = () => ({ timestamp: new Date().toISOString(), eventId: randomUUID() });
  const begin = encodeStartupFrame({
    ...common, ...identity(), eventName: 'desktop.shell.start.begin', severity: 'info',
  } satisfies K07Record);
  const delivery = begin.ok ? writeFrame(begin.value) : Promise.resolve(false);
  let finished = false;

  return {
    async finish(failure?: { stage: StartupFailureStage; cause: unknown }) {
      if (finished) return;
      finished = true;
      const durationMs = Number((hrtime.bigint() - start) / 1_000_000n);
      const base = { ...common, ...identity(), eventName: 'desktop.shell.start.finish', durationMs } as const;
      const projected = failure && projectStartupFailure(failure.stage, failure.cause);
      const record = failure
        ? projected && projected.ok
          ? { ...base, severity: 'error', outcome: 'failed', errorCode: projected.value.errorCode } as const
          : undefined
        : { ...base, severity: 'info', outcome: 'ok' } as const;
      const finish = record && encodeStartupFrame(record);
      const completed = delivery.then(async (started) => {
        if (started && finish && finish.ok) await writeFrame(finish.value);
        await closeVerificationPipe();
      });
      // No synchronous pipe write can block Electron startup. A failed handoff
      // remains missing evidence, without stderr fallback.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([completed, new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, deliveryBudgetMs);
        })]);
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

function bundleFile(path: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), path);
}

export function createMainWindow(userDataPath: string): BrowserWindow {
  if (app.getPath('userData') !== userDataPath || app.getPath('sessionData') !== userDataPath) {
    throw new Error('Desktop and browser storage must share the startup profile');
  }

  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      preload: bundleFile('../preload/index.cjs'),
    },
  });

  const { webContents } = window;
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-frame-navigate', (event) => event.preventDefault());
  webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  webContents.session.setPermissionCheckHandler(() => false);
  return window;
}

function loadLocalRenderer(window: BrowserWindow, renderer: string): Promise<void> {
  const original = process.emitWarning;
  // Use one URL for the actual Electron request and its exact warning scope.
  // loadFile uses a separate path-to-URL conversion on Windows.
  const rendererUrl = pathToFileURL(renderer).href;
  const prefix = 'Failed to load URL: ' + rendererUrl + ' with error: ';
  const scopedWarning = (...args: unknown[]) => {
    // Electron 45 also emits a warning containing this local URL independently
    // of the rejection. Only replace this known warning with the fixed K07
    // result from the local page load rejection; forward all other diagnostics.
    if (args[1] === 'electron' && typeof args[0] === 'string' && args[0].startsWith(prefix)) return;
    Reflect.apply(original, process, args);
  };
  const restore = () => {
    if (process.emitWarning === scopedWarning) process.emitWarning = original;
  };
  process.emitWarning = scopedWarning;
  try {
    return window.loadURL(rendererUrl).finally(restore);
  } catch (cause) {
    restore();
    throw cause;
  }
}

type StudioFixture = {
  view: WebContentsView;
  origins: readonly [string, string];
  showProjects: () => void;
  close: () => Promise<void>;
};

function studioSmokeControl(window: BrowserWindow) {
  let opening = false;
  let active: StudioFixture | undefined;
  return {
    async open(trustedReceiptSha256: string): Promise<StudioFixture> {
      if (opening || active || window.isDestroyed()) throw Error('Studio fixture already open or shell closed');
      opening = true;
      try {
        active = await mountStudioFixture(window, trustedReceiptSha256, () => { active = undefined; });
        return active;
      } finally {
        opening = false;
      }
    },
  };
}

async function mountStudioFixture(window: BrowserWindow, trustedReceiptSha256: string, onClosed: () => void): Promise<StudioFixture> {
  let closeOnError: (() => Promise<void>) | undefined;
  const transport = await startStudioFixture(bundleFile('../studio'), trustedReceiptSha256, () => {
    void closeOnError?.();
  });
  try {
    if (window.isDestroyed()) throw Error();
    const partition = session.fromPartition('orange-studio-fixture-' + randomUUID(), { cache: false });
    const view = new WebContentsView({
      webPreferences: {
        session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, webviewTag: false, devTools: false,
      },
    });
    const contents = view.webContents;
    let bootstrap = true;
    let closing: Promise<void> | undefined;
    const resize = () => {
      const { width, height } = window.getContentBounds();
      view.setBounds({ x: 0, y: 0, width, height });
    };
    function close(): Promise<void> {
      if (closing) return closing;
      bootstrap = false;
      // Revoke synchronously before disconnecting native handlers or closing the view.
      const stopped = transport.close();
      closing = stopped.finally(onClosed);
      window.off('resize', resize);
      window.off('closed', close);
      app.off('before-quit', close);
      partition.webRequest.onBeforeRequest(null);
      partition.webRequest.onBeforeSendHeaders(null);
      partition.setPermissionCheckHandler(null);
      partition.setPermissionRequestHandler(null);
      partition.setDevicePermissionHandler(null);
      partition.setDisplayMediaRequestHandler(null);
      if (!window.isDestroyed()) window.contentView.removeChildView(view);
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
      return closing;
    }
    closeOnError = close;
    const same = (a: WebFrameMain | undefined | null, b: WebFrameMain) =>
      a?.processId === b.processId && a.routingId === b.routingId;
    const allowed = (request: Pick<OnBeforeRequestListenerDetails, 'url' | 'method' | 'webContentsId' |
      'resourceType' | 'initiatorOrigin' | 'frame'>) => {
      if (closing || contents.isDestroyed() || request.webContentsId !== contents.id) return false;
      const route = transport.route(request.url, request.method);
      const type = request.resourceType;
      const frame = request.frame;
      const main = contents.mainFrame;
      if (route === 'document') {
        // Only this native loadURL is armed; renderer navigations cannot supply
        // an absent initiator or get another initial request authorized.
        return bootstrap && type === 'mainFrame' && request.initiatorOrigin === undefined &&
          (!frame || same(frame, main));
      }
      if (request.initiatorOrigin !== transport.studioOrigin) return false;
      if (route === 'preview') return type === 'subFrame' && (same(frame, main) || same(frame?.parent, main));
      if (!same(frame, main)) return false;
      return (route === 'asset' && (type === 'script' || type === 'stylesheet' || type === 'font')) ||
        (route === 'api' && type === 'xhr') || (route === 'ws' && type === 'webSocket');
    };

    partition.setPermissionCheckHandler(() => false);
    partition.setPermissionRequestHandler((_webContents, _permission, respond) => respond(false));
    partition.setDevicePermissionHandler(() => false);
    partition.setDisplayMediaRequestHandler((_request, respond) => respond({}));
    partition.webRequest.onBeforeRequest((request, respond) => respond({ cancel: !allowed(request) }));
    partition.webRequest.onBeforeSendHeaders((request, respond) => {
      const permit = allowed(request);
      if (permit && request.resourceType === 'mainFrame') bootstrap = false;
      respond({ cancel: !permit, requestHeaders: transport.requestHeaders(request.requestHeaders, permit) });
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame || transport.route(event.url, 'GET') !== 'preview') event.preventDefault();
    });
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.once('render-process-gone', close);
    contents.once('destroyed', close);
    contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (code !== -3 && (isMainFrame || transport.route(url, 'GET') === 'preview')) void close();
    });
    app.once('before-quit', close);
    window.once('closed', close);
    window.on('resize', resize);
    window.contentView.addChildView(view);
    resize();
    await contents.loadURL(transport.studioOrigin + '/');
    if (closing || contents.isDestroyed()) throw Error();
    return { view, origins: [transport.studioOrigin, transport.previewOrigin], showProjects: transport.showProjects, close };
  } catch {
    await (closeOnError ? closeOnError() : transport.close());
    throw Error('Studio fixture view failed');
  }
}

async function mountStudioExperience(window: BrowserWindow, isAuthorized: () => boolean, onFailure: () => void, onInvalidate: (revoke: () => void) => void) {
  if (!isAuthorized() || window.isDestroyed() || !studioBounds(window.getContentBounds())) throw Error();
  let closeOnFailure: (() => Promise<void>) | undefined;
  let failed = false;
  onInvalidate(() => { failed = true; void closeOnFailure?.(); });
  const fail = () => {
    failed = true;
    onFailure();
    void closeOnFailure?.();
  };
  const transport = await startStudioExperience(bundleFile('../studio'), __ORANGE_STUDIO_RECEIPT_SHA256__,
    () => !failed && isAuthorized() && !window.isDestroyed(), fail, experienceRuntime);
  try {
    if (failed || !isAuthorized() || window.isDestroyed() || !studioBounds(window.getContentBounds())) throw Error();
    const partition = session.fromPartition('orange-studio-' + randomUUID(), { cache: false });
    const view = new WebContentsView({ webPreferences: {
      session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, webviewTag: false, devTools: false,
    } });
    const contents = view.webContents;
    let bootstrap = true;
    let stopped = false;
    let closing: Promise<void> | undefined;
    const resize = () => {
      if (stopped) return;
      const bounds = !window.isDestroyed() && studioBounds(window.getContentBounds());
      if (!bounds) { fail(); return; }
      view.setBounds(bounds);
    };
    function close(): Promise<void> {
      if (stopped) return closing ?? Promise.resolve();
      stopped = true;
      bootstrap = false;
      // Mark inactive and revoke transport before view removal or any await.
      closing = transport.close().catch(() => {});
      window.off('resize', resize);
      window.off('closed', fail);
      app.off('before-quit', fail);
      partition.webRequest.onBeforeRequest(null);
      partition.webRequest.onBeforeSendHeaders(null);
      partition.setPermissionCheckHandler(null);
      partition.setPermissionRequestHandler(null);
      partition.setDevicePermissionHandler(null);
      partition.setDisplayMediaRequestHandler(null);
      if (!window.isDestroyed()) window.contentView.removeChildView(view);
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
      return closing;
    }
    closeOnFailure = close;
    const allowed = (request: Pick<OnBeforeRequestListenerDetails, 'url' | 'method' | 'webContentsId' |
      'resourceType' | 'initiatorOrigin' | 'frame'>) => {
      if (stopped || failed || contents.isDestroyed() || window.isDestroyed() || !isAuthorized()) return false;
      return studioRequestAllowed(request, { transport, main: contents.mainFrame, webContentsId: contents.id, bootstrap, authorized: true });
    };
    partition.setPermissionCheckHandler(() => false);
    partition.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    partition.setDevicePermissionHandler(() => false);
    partition.setDisplayMediaRequestHandler((_request, respond) => respond({}));
    partition.webRequest.onBeforeRequest((request, respond) => respond({ cancel: !allowed(request) }));
    partition.webRequest.onBeforeSendHeaders((request, respond) => {
      const permit = allowed(request);
      if (permit && request.resourceType === 'mainFrame') bootstrap = false;
      respond({ cancel: !permit, requestHeaders: transport.requestHeaders(request.requestHeaders, permit) });
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-frame-navigate', event => {
      if (event.isMainFrame || transport.route(event.url, 'GET') !== 'preview') { event.preventDefault(); fail(); }
    });
    contents.on('will-redirect', event => { event.preventDefault(); fail(); });
    contents.on('will-attach-webview', event => { event.preventDefault(); fail(); });
    contents.once('render-process-gone', fail);
    contents.once('destroyed', () => { if (!stopped) fail(); });
    contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (code !== -3 && (isMainFrame || transport.route(url, 'GET') === 'preview')) fail();
    });
    app.once('before-quit', fail);
    window.once('closed', fail);
    window.on('resize', resize);
    window.contentView.addChildView(view);
    resize();
    if (stopped || !isAuthorized()) throw Error();
    await contents.loadURL(transport.studioOrigin + '/projects/local-experience');
    if (stopped || failed || contents.isDestroyed() || !isAuthorized()) throw Error();
    return { close };
  } catch {
    await (closeOnFailure ? closeOnFailure() : transport.close());
    throw Error('Studio view failed');
  }
}
// Native test bootstrap only: no argv, environment, renderer, URL or IPC can
// register this process-local function. An ordinary shell never calls it.
const studioSmokeKey = Symbol.for('orange.desktop.studio-smoke');
const nativeGlobal = globalThis as typeof globalThis & {
  [studioSmokeKey]?: (control: ReturnType<typeof studioSmokeControl>) => void;
};
const nativeSmoke = typeof nativeGlobal[studioSmokeKey] === 'function' ? nativeGlobal[studioSmokeKey] : undefined;
delete nativeGlobal[studioSmokeKey];

async function startShell() {
  const diagnostic = openStartupDiagnostic();
  let stage: StartupFailureStage = 'startup';
  let started = false;
  let window: BrowserWindow | undefined;
  try {
    const renderer = bundleFile('../renderer/index.html');

    // All paths are prepared inside the controlled boundary and before ready.
    const profile = mkdtempSync(join(tmpdir(), 'orange-shell-'));
    const crashDumps = join(profile, 'crash-dumps');
    mkdirSync(crashDumps);
    app.setPath('userData', profile);
    app.setPath('sessionData', profile);
    app.setPath('crashDumps', crashDumps);
    app.setAppLogsPath(join(profile, 'logs'));

    app.on('window-all-closed', () => { if (started) app.quit(); });
    await app.whenReady();
    window = createMainWindow(profile);
    const auth = installAuthIpc(window, renderer);
    const studio = createStudioController(auth, (authorized, failed, onInvalidate) => mountStudioExperience(window!, authorized, failed, onInvalidate));
    installStudioIpc(window, renderer, studio);
    const shellContents = window.webContents;
    const trustedShellUrl = pathToFileURL(renderer).href;
    let shellTrusted = true;
    let shellBootstrapping = true;
    // A live BrowserWindow does not imply a live trusted shell renderer.
    // Dispose both capabilities synchronously, including a still-awaiting mount.
    const revokeShellTrust = () => {
      if (!shellTrusted) return;
      shellTrusted = false;
      auth.dispose();
      void studio.dispose();
      cleanupShellTrust();
    };
    const denyShellNavigation = (event: { preventDefault(): void }) => {
      event.preventDefault();
      revokeShellTrust();
    };
    const checkShellNavigation = (_event: unknown, url: string) => {
      // Only our first native load may create this document. A later full
      // navigation cannot retain capability merely by reusing a trusted URL.
      if (shellBootstrapping && url === trustedShellUrl) { shellBootstrapping = false; return; }
      revokeShellTrust();
    };
    const checkShellInPageNavigation = (_event: unknown, url: string, isMainFrame: boolean) => {
      if (isMainFrame && !isTrustedShellUrl(url, trustedShellUrl)) revokeShellTrust();
    };
    const cleanupShellTrust = () => {
      shellContents.off('render-process-gone', revokeShellTrust);
      shellContents.off('destroyed', revokeShellTrust);
      shellContents.off('will-frame-navigate', denyShellNavigation);
      shellContents.off('will-redirect', denyShellNavigation);
      shellContents.off('did-navigate', checkShellNavigation);
      shellContents.off('did-navigate-in-page', checkShellInPageNavigation);
      window!.off('closed', cleanupShellTrust);
    };
    shellContents.once('render-process-gone', revokeShellTrust);
    shellContents.once('destroyed', revokeShellTrust);
    shellContents.on('will-frame-navigate', denyShellNavigation);
    shellContents.on('will-redirect', denyShellNavigation);
    shellContents.on('did-navigate', checkShellNavigation);
    shellContents.on('did-navigate-in-page', checkShellInPageNavigation);
    window.once('closed', cleanupShellTrust);
    const loaded = loadLocalRenderer(window, renderer);
    stage = 'loadFile';
    await loaded;
    shellBootstrapping = false;
    stage = 'startup';
    if (window.isDestroyed()) throw new Error('Desktop window closed before startup finished');
    if (nativeSmoke) nativeSmoke(studioSmokeControl(window));
    else {
      window.show();
      if (window.isDestroyed() || !window.isVisible()) throw new Error('Desktop window did not become visible');
    }
    started = true;
  } catch (cause) {
    if (window?.isDestroyed()) stage = 'startup';
    await diagnostic?.finish({ stage, cause });
    app.exit(1);
    return;
  }
  await diagnostic?.finish();
}

void startShell().catch(() => app.exit(1));
