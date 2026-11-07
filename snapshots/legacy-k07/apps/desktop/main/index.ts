import { randomUUID } from 'node:crypto';
import { close, constants, fstatSync, mkdtempSync, mkdirSync, write } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hrtime } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeStartupFrame, projectStartupFailure, type K07Record } from '@orange/contracts';
import { app, BrowserWindow } from 'electron';

declare const __ORANGE_BUILD_COMMIT__: string;
declare const __ORANGE_BUILD_VERSION__: string;

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
    const loaded = loadLocalRenderer(window, renderer);
    stage = 'loadFile';
    await loaded;
    stage = 'startup';
    if (window.isDestroyed()) throw new Error('Desktop window closed before startup finished');
    window.show();
    if (window.isDestroyed() || !window.isVisible()) throw new Error('Desktop window did not become visible');
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
