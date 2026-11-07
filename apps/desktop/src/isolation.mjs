/** Native development startup adapter. Importing it performs no writes/spawns. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertIsolationPath, isolationEnvironment, readIsolationProfile } from 'openfilm/development-isolation';
export { readIsolationProfile, isolationEnvironment };
export function prepareIsolationDirectories(profile, mkdir = mkdirSync) {
    const p = profile.paths;
    const dirs = [...Object.values(p), join(p.cache, 'session'), join(p.cache, 'browsers'),
        join(p.userData, 'appdata'), join(p.cache, 'appdata'), join(p.home, 'config'), join(p.home, 'data'),
        join(p.skills, 'installed'), join(p.temp, 'trash')];
    for (const dir of dirs)
        assertIsolationPath(profile, dir);
    for (const dir of dirs)
        mkdir(dir, { recursive: true });
}
export function prepareDesktopIsolation(app, source = process.env, { mkdir = mkdirSync } = {}) {
    const profile = readIsolationProfile(source, { packaged: app.isPackaged });
    if (!profile)
        return null;
    if (app.isReady())
        throw new Error('Isolation paths must be set before Electron is ready.');
    prepareIsolationDirectories(profile, mkdir);
    for (const [key, value] of Object.entries({ home: profile.paths.home, appData: join(profile.paths.userData, 'appdata'), userData: profile.paths.userData, sessionData: join(profile.paths.cache, 'session'), temp: profile.paths.temp, downloads: profile.paths.downloads, crashDumps: profile.paths.crash })) {
        // setPath requires the directory to exist on Electron.
        assertIsolationPath(profile, value);
        mkdir(value, { recursive: true });
        app.setPath(key, value);
    }
    app.setAppLogsPath(profile.paths.logs);
    app.commandLine.appendSwitch('disk-cache-dir', profile.paths.cache);
    return profile;
}
