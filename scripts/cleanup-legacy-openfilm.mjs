#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.

/**
 * Remove what the retired OpenFilm client left on this machine.
 *
 * Nothing is guessed: every path is listed first, classified, sized, and skipped unless the
 * matching opt-in flag is given. Dry run is the default.
 *
 *   node scripts/cleanup-legacy-openfilm.mjs                     # show what would go
 *   node scripts/cleanup-legacy-openfilm.mjs --apply             # installs + config + cache
 *   node scripts/cleanup-legacy-openfilm.mjs --apply --include-library
 *   node scripts/cleanup-legacy-openfilm.mjs --apply --include-credentials --include-library
 *
 * Never touches anything whose resolved path contains "orange" (OrangeFilm, ~/.orangefilm,
 * %APPDATA%\orangefilm, com.orange.studio) — the new client shares those names.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const INCLUDE_LIBRARY = args.has('--include-library');
const INCLUDE_CREDENTIALS = args.has('--include-credentials');
const JSON_OUT = args.has('--json');

const home = homedir();
const env = process.env;
const platform = process.platform;

/** @typedef {'install'|'config'|'cache'|'library'|'credentials'} Tier */

/** @type {Array<{path: string, tier: Tier, what: string}>} */
const targets = [];

function add(path, tier, what) {
  if (!path) return;
  targets.push({ path: resolve(path), tier, what });
}

if (platform === 'win32') {
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming');
  add(join(local, 'Programs', 'OpenFilm'), 'install', '旧版 Windows 安装目录');
  add(join(local, 'openfilm-updater'), 'install', '旧版增量更新缓存');
  add(join(roaming, 'openfilm'), 'config', '旧版 Electron userData');
  add(join(roaming, 'OpenFilm'), 'config', '旧版 Electron userData（大小写别名）');
  add(join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OpenFilm.lnk'), 'install', '开始菜单快捷方式');
  add(join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OpenFilm'), 'install', '开始菜单文件夹');
} else if (platform === 'darwin') {
  add('/Applications/OpenFilm.app', 'install', '旧版 macOS 应用');
  add(join(home, 'Library', 'Application Support', 'OpenFilm'), 'config', '旧版 Application Support');
  add(join(home, 'Library', 'Application Support', 'openfilm'), 'config', '旧版 Application Support（小写）');
  add(join(home, 'Library', 'Caches', 'openfilm'), 'cache', '旧版缓存');
  add(join(home, 'Library', 'Caches', 'OpenFilm'), 'cache', '旧版缓存（大小写别名）');
  add(join(home, 'Library', 'Preferences', 'dev.openfilm.desktop.plist'), 'config', '旧版偏好设置');
  add(join(home, 'Library', 'Preferences', 'dev.openfilm.desktop.helper.plist'), 'config', '旧版偏好设置（helper）');
  add(join(home, 'Library', 'Saved Application State', 'dev.openfilm.desktop.savedState'), 'config', '旧版窗口状态');
  add(join(home, 'Library', 'Logs', 'OpenFilm'), 'config', '旧版日志');
  add(join(home, 'Library', 'HTTPStorages', 'dev.openfilm.desktop'), 'cache', '旧版 HTTP 缓存');
}

const legacyHome = join(home, '.openfilm');
const legacyHomeCfg = ['prefs.json', 'studio.json', 'update.json', 'run.json', 'cloud-steward.json', '.openfilm-control.json'];
for (const name of legacyHomeCfg) add(join(legacyHome, name), 'config', `旧主目录配置 ${name}`);
add(join(legacyHome, 'logs'), 'config', '旧主目录日志');
add(join(legacyHome, 'cache'), 'cache', '旧主目录缓存');
add(join(legacyHome, 'material-cache'), 'cache', '旧素材缓存');
add(join(legacyHome, 'runtime'), 'install', '旧运行时');
add(join(legacyHome, 'services'), 'install', '旧服务根');
add(join(legacyHome, 'fission-jobs'), 'config', '旧 fission 任务');
add(join(legacyHome, 'skill-catalog'), 'cache', '旧技能目录索引');
add(join(legacyHome, 'key'), 'credentials', '账号密钥');
add(join(legacyHome, 'orange-accounts'), 'credentials', '账号会话');
add(join(legacyHome, 'library'), 'library', '素材库（用户数据）');
add(join(legacyHome, 'materials'), 'library', '素材索引与缓存（用户数据）');
add(join(legacyHome, 'skills'), 'library', '旧技能目录（用户数据）');
add(join(legacyHome, 'skills-installed'), 'library', '旧已安装技能（用户数据）');

function isProtected(path) {
  return path.toLowerCase().includes('orange');
}

function sizeOf(path) {
  let total = 0;
  let entries = 0;
  const walk = (p) => {
    let st;
    try {
      st = statSync(p, { throwIfNoEntry: false });
    } catch {
      return;
    }
    if (!st) return;
    if (st.isDirectory()) {
      let kids = [];
      try {
        kids = readdirSync(p);
      } catch {
        return;
      }
      for (const kid of kids) walk(join(p, kid));
    } else {
      total += st.size;
      entries += 1;
    }
  };
  walk(path);
  return { bytes: total, files: entries };
}

function registryKeys() {
  if (platform !== 'win32') return [];
  const roots = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const found = [];
  for (const root of roots) {
    let out = '';
    try {
      out = execFileSync('reg', ['query', root, '/s', '/f', 'OpenFilm', '/d'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      continue;
    }
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^(HKEY_[^\\]+\\[^\r\n]*Uninstall\\[^\\\r\n]+)$/);
      if (m) found.push(m[1]);
    }
  }
  return [...new Set(found)];
}

const allowTier = (tier) => {
  if (tier === 'install' || tier === 'config' || tier === 'cache') return true;
  if (tier === 'library') return INCLUDE_LIBRARY;
  if (tier === 'credentials') return INCLUDE_CREDENTIALS;
  return false;
};

const report = [];
const seen = new Set();
for (const target of targets) {
  if (isProtected(target.path)) continue;
  if (!existsSync(target.path)) continue;
  const identity = target.path.toLowerCase();
  if (seen.has(identity)) continue;
  seen.add(identity);
  const { bytes, files } = sizeOf(target.path);
  report.push({ ...target, bytes, files, selected: allowTier(target.tier) });
}

/** The old home shell goes only when nothing is left inside that we deliberately kept. */
function pruneEmptyLegacyHome() {
  if (!existsSync(legacyHome)) return;
  let rest = [];
  try {
    rest = readdirSync(legacyHome);
  } catch {
    return;
  }
  if (rest.length > 0) {
    if (!JSON_OUT) console.log(`保留 ${legacyHome}：还有 ${rest.length} 项（${rest.slice(0, 6).join(', ')}）`);
    return;
  }
  try {
    rmSync(legacyHome, { recursive: true, force: true });
    if (!JSON_OUT) console.log(`删除 ${legacyHome}：已空`);
  } catch (error) {
    console.error(`失败 ${legacyHome}: ${error.message}`);
  }
}

const reg = registryKeys().filter((key) => !key.toLowerCase().includes('orange'));

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ apply: APPLY, targets: report, registry: reg }, null, 2)}\n`);
} else {
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  console.log(`旧 OpenFilm 残留 (${platform})${APPLY ? '' : ' — 预览，未删除'}\n`);
  for (const item of report) {
    console.log(`${item.selected ? '删除' : '跳过'}  ${item.tier.padEnd(11)} ${mb(item.bytes).padStart(10)}  ${item.path}`);
    console.log(`      ${item.what}`);
  }
  if (reg.length) {
    console.log('\n注册表卸载项');
    for (const key of reg) console.log(`删除  ${key}`);
  }
  const totalSelected = report.filter((i) => i.selected).reduce((n, i) => n + i.bytes, 0);
  console.log(`\n将删除 ${report.filter((i) => i.selected).length} 项，共 ${mb(totalSelected)}。`);
  console.log(`全部删完后若 ${legacyHome} 已空，一并移除。`);
  if (!INCLUDE_LIBRARY) console.log('素材库/用户技能保留；加 --include-library 一并删除。');
  if (!INCLUDE_CREDENTIALS) console.log('账号密钥保留；加 --include-credentials 一并删除。');
  if (!APPLY) console.log('加 --apply 执行删除。');
}

if (APPLY) {
  for (const item of report) {
    if (!item.selected) continue;
    try {
      rmSync(item.path, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      console.error(`失败 ${item.path}: ${error.message}`);
    }
  }
  for (const key of reg) {
    try {
      execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
    } catch (error) {
      console.error(`失败 ${key}: ${error.message}`);
    }
  }
  pruneEmptyLegacyHome();
  if (!JSON_OUT) console.log('\n完成。');
}
