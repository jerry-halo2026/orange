/**
 * Run the app from this repository: `pnpm --filter @openfilm/desktop start`.
 *
 * It is the `dev` flavour (src/flavor.mjs): on macOS a renamed copy of Electron.app with its own name, bundle id and
 * data folder, so it never shares a Dock icon, a lock or a Studio with an installed OpenFilm. The window's page
 * (shell/) is built first (`--no-build` skips it). Electron gets a clean environment: run from inside Claude Code or Codex, this
 * process carries their variables, which the app's agents would inherit (src/environment.mjs). Arguments after the
 * script go to Electron as they are (e.g. --remote-debugging-port=9333).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launcherEnvironment, loginShellEnvironment } from '../src/environment.mjs';
import { FLAVORS } from '../src/flavor.mjs';
import { readIsolationProfile, isolationEnvironment, prepareIsolationDirectories } from '../src/isolation.mjs';
export async function startDevelopment({ source = process.env, argv = process.argv.slice(2), adapters = {} } = {}) {
    const profile = readIsolationProfile(source);
    const env = { ...source, OPENFILM_DESKTOP_FLAVOR: 'dev', ...(profile ? isolationEnvironment(profile) : {}) };
    if (profile)
        prepareIsolationDirectories(profile, adapters.mkdir ?? mkdirSync);
    const control = adapters.control ?? process;
    const identity = FLAVORS.dev;
    const require = createRequire(import.meta.url);
    const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const args = argv.filter((a) => a !== '--no-build');
    if (!argv.includes('--no-build')) {
        if (adapters.build)
            adapters.build(env);
        else {
            const vite = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
            execFileSync(process.execPath, [vite, 'build', '--config', 'shell/vite.config.ts', '--logLevel', 'warn'], { cwd: desktop, stdio: 'inherit', env });
        }
    }
    const electron = adapters.electron ? adapters.electron() : require('electron');
    let executable = electron;
    if (adapters.runtime)
        executable = await adapters.runtime(electron);
    else if (process.platform === 'darwin') {
        const version = require('electron/package.json').version;
        const productVersion = require('../package.json').version;
        /* .dev/ is git-ignored */
        const runtime = profile ? join(profile.paths.cache, 'electron', `${version}-openfilm-dev-v2-${productVersion}`) : join(desktop, '.dev', 'runtime', `${version}-openfilm-dev-v2-${productVersion}`);
        const bundle = join(runtime, `${identity.productName}.app`);
        const marker = join(runtime, 'ready');
        /* the executable keeps Electron's own name: Electron decides `app.isPackaged` from it. The name people see comes
           from CFBundleName and app.setName. */
        executable = join(bundle, 'Contents/MacOS/Electron');
        if (!existsSync(marker)) {
            mkdirSync(runtime, { recursive: true });
            const source = resolve(electron, '../../..');
            if (!existsSync(bundle))
                execFileSync('/bin/cp', ['-cR', source, bundle]);
            const plist = join(bundle, 'Contents/Info.plist');
            const set = (key, value) => execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
            set('CFBundleName', identity.productName);
            set('CFBundleDisplayName', identity.productName);
            set('CFBundleShortVersionString', productVersion);
            set('CFBundleVersion', productVersion);
            set('CFBundleIdentifier', identity.bundleId);
            set('CFBundleIconFile', 'openfilm.icns');
            copyFileSync(join(desktop, 'build/icon-dev.icns'), join(bundle, 'Contents/Resources/openfilm.icns'));
            /* a local ad-hoc signature covers the changed bundle */
            execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'ignore' });
            execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', bundle]);
            writeFileSync(marker, version);
        }
    }
    const { PATH } = await (adapters.login ?? loginShellEnvironment)();
    const child = (adapters.spawn ?? spawn)(executable, [desktop, ...args], { stdio: 'inherit', env: launcherEnvironment(env, PATH) });
    /* Ctrl-C already reaches Electron (same foreground group); a SIGINT to this process alone is passed on later, once
       the app has had time to stop Studio on its own */
    control.on('SIGINT', () => { setTimeout(() => { if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM'); }, 12000).unref(); });
    control.on('SIGTERM', () => child.kill('SIGTERM'));
    child.on('error', (error) => { console.error(error); control.exitCode = 1; });
    child.on('exit', (code, signal) => { control.exitCode = code ?? (signal ? 1 : 0); });
    return child;
}
if (import.meta.main)
    await startDevelopment();
