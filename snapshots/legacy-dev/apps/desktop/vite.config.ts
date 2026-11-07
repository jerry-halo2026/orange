import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, version as viteVersion } from 'vite';
import type { Plugin, ResolvedConfig, UserConfig } from 'vite';

const fromDesktop = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const studioPin = '2e18a4bdf54647b2ece3c0975a6f9573720c7821';
const studioLedgerHash = 'ceeec16d948e301de54a8a06e2d1faa050291777833b49cd9b7edfbbc077d9d6';
const studioAppPath = 'packages/openfilm/studio/ui/src/App.tsx';
const studioCssPath = 'packages/openfilm/studio/ui/src/globals.css';
const studioNonModules = new Set([
  'packages/openfilm/src/film-doc.d.mts',
  'packages/openfilm/studio/ui/src/i18n/words.ts',
]);
const slash = (path: string) => path.replaceAll('\\', '/');
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function studioFail(message: string): never {
  throw new Error('Studio build: ' + message);
}

function requireStudioPath(path: string, kind: 'directory' | 'file', label: string) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) ||
    slash(realpathSync(path)) !== slash(resolve(path))) {
    studioFail('missing or linked ' + kind + ': ' + label);
  }
}

// Read only the fixed Git closure, never the vendor checkout or an operator-selected path.
function verifiedStudioSource() {
  const ledgerPath = fromDesktop('../../docs/evidence/film-upstream.md');
  requireStudioPath(ledgerPath, 'file', 'fixed source ledger');
  const document = readFileSync(ledgerPath, 'utf8').replaceAll('\r\n', '\n');
  const ledger = /^<!-- studio-source ([0-9a-f]{40}) -->\n\x60{3}text\n([\s\S]+?)\n\x60{3}$/m.exec(document);
  if (!ledger || ledger[1] !== studioPin || sha256(ledger[2] + '\n') !== studioLedgerHash) {
    studioFail('fixed source pin or file ledger mismatch');
  }
  const files = new Map<string, string>();
  const dirs = new Map<string, Set<string>>([['.', new Set()]]);
  for (const row of ledger[2].split('\n')) {
    const entry = /^([0-9a-f]{64})  (packages\/openfilm\/(?:[\w.-]+\/)*[\w.-]+)$/.exec(row);
    if (!entry || entry[2].split('/').some(p => p === '.' || p === '..') || files.has(entry[2])) {
      studioFail('invalid source ledger row');
    }
    const [, digest, name] = entry;
    files.set(name, digest);
    for (let at = name; at !== '.'; at = posix.dirname(at)) {
      const parent = posix.dirname(at);
      if (!dirs.has(parent)) dirs.set(parent, new Set());
      dirs.get(parent)!.add(posix.basename(at));
    }
  }
  if (files.size !== 235 || !files.has(studioAppPath) || !files.has(studioCssPath)) {
    studioFail('fixed source ledger is incomplete');
  }
  const local = fromDesktop('../../.orange-local/');
  const source = join(local, 'studio-src-' + studioPin.slice(0, 7));
  requireStudioPath(local, 'directory', '.orange-local');
  // Check parents before children so a linked parent cannot redirect traversal.
  for (const name of [...dirs.keys()].sort((a, b) => a.length - b.length)) {
    const dir = join(source, name);
    requireStudioPath(dir, 'directory', 'pinned source ' + name);
    const expected = dirs.get(name)!;
    const found = readdirSync(dir);
    if (found.length !== expected.size || found.some(item => !expected.has(item))) {
      studioFail('pinned source file set mismatch in ' + name);
    }
  }
  const verified = new Map<string, Buffer>();
  for (const [name, digest] of files) {
    const path = join(source, name);
    requireStudioPath(path, 'file', 'pinned source ' + name);
    const bytes = readFileSync(path);
    if (sha256(bytes) !== digest) studioFail('pinned source byte mismatch: ' + name);
    verified.set(name, bytes);
  }
  return { local, verified };
}

function studioDependencies() {
  function packageRoot(name: string, expected: string, manifest: string) {
    const path = realpathSync(manifest);
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { name: string; version: string };
    if (pkg.name !== name || pkg.version !== expected) {
      studioFail('expected ' + name + '@' + expected + ', got ' + pkg.name + '@' + pkg.version);
    }
    return { name, version: expected, path: slash(dirname(path)) };
  }
  function desktopPackage(name: string, version: string) {
    const manifest = fromDesktop('./node_modules/' + name + '/package.json');
    if (!existsSync(manifest)) studioFail('missing installed ' + name + '@' + version + '; run the frozen workspace install');
    return packageRoot(name, version, manifest);
  }
  const react = desktopPackage('react', '19.3.1');
  const dom = desktopPackage('react-dom', '19.3.1');
  const lucide = desktopPackage('lucide-react', '0.469.0');
  const vite = desktopPackage('vite', '8.3.6');
  const tailwind = desktopPackage('tailwindcss', '4.3.3');
  const twVite = desktopPackage('@tailwindcss/vite', '4.3.3');
  const inter = desktopPackage('@fontsource-variable/inter', '5.3.0');
  const adapter = desktopPackage('@orange/film-adapter', '0.0.0');
  if (adapter.path !== slash(fromDesktop('../../packages/film-adapter'))) {
    studioFail('adapter workspace link does not resolve to the approved local package');
  }
  const fromPackage = (pkg: { path: string }) => createRequire(join(pkg.path, 'package.json'));
  for (const owner of [dom, lucide, adapter]) {
    for (const file of ['package.json', 'jsx-runtime.js', 'jsx-dev-runtime.js']) {
      const request = file.replace(/\.js$/, '');
      if (slash(realpathSync(fromPackage(owner).resolve('react/' + request))) !== react.path + '/' + file) {
        studioFail('multiple physical React or JSX runtimes (' + owner.name + ')');
      }
    }
  }
  if (viteVersion !== vite.version ||
    slash(realpathSync(fromPackage(twVite).resolve('vite/package.json'))) !== vite.path + '/package.json') {
    studioFail('Vite runtime or Tailwind Vite peer does not match the fixed Vite 8.3.6 instance');
  }
  const scheduler = packageRoot('scheduler', '0.28.0', fromPackage(dom).resolve('scheduler/package.json'));
  return { browserPackages: [react, dom, lucide, scheduler], adapter, tailwind, inter, twVite, vite };
}

const studioEntryFileNames = 'assets/studio-[hash].js';
const studioFontSubsets = ['cyrillic-ext', 'cyrillic', 'greek-ext', 'greek', 'latin-ext', 'latin', 'vietnamese'];
const studioEntryAsset = /^studio-[\w-]+\.js$/;
const studioCssAsset = /^index-[\w-]+\.css$/;
const studioFontAssets = studioFontSubsets.map(subset =>
  new RegExp('^inter-' + subset + '-wght-normal-[\\w-]+\\.woff2$'));
const studioAssetPatterns = [studioEntryAsset, studioCssAsset, ...studioFontAssets];
const studioReceipt = 'studio-build.json';

function studioOutputFiles(output: string) {
  // Check each parent before reading or descending, including the immediate desktop dist.
  for (const dir of [dirname(output), output]) {
    if (!lstatSync(dir, { throwIfNoEntry: false })) return [];
    requireStudioPath(dir, 'directory', 'Studio output');
  }

  const files: string[] = [];
  for (const name of readdirSync(output)) {
    const file = join(output, name);
    if (name === 'index.html' || name === studioReceipt) {
      requireStudioPath(file, 'file', 'Studio output ' + name);
      files.push(name);
    } else if (name === 'assets') {
      requireStudioPath(file, 'directory', 'Studio output assets');
      const seen = new Set<number>();
      for (const asset of readdirSync(file)) {
        const slot = studioAssetPatterns.findIndex(pattern => pattern.test(asset));
        if (slot < 0 || seen.has(slot)) studioFail('unexpected Studio output entry: assets/' + asset);
        seen.add(slot);
        requireStudioPath(join(file, asset), 'file', 'Studio output assets/' + asset);
        files.push('assets/' + asset);
      }
    } else {
      studioFail('unexpected Studio output entry: ' + name);
    }
  }
  return files.sort();
}

function verifyPreviousStudioOutput(output: string) {
  const files = studioOutputFiles(output);
  if (files.length === 0) return;
  if (!files.includes(studioReceipt) || files.length !== studioAssetPatterns.length + 2) {
    studioFail('unexpected Studio output entry set: previous build receipt or artifact missing');
  }
  const previous = JSON.parse(readFileSync(join(output, studioReceipt), 'utf8')) as {
    source?: { pin?: string; ledgerSha256?: string };
    artifacts?: Array<{ name: string; bytes: number; sha256: string }>;
  } | null;
  if (previous?.source?.pin !== studioPin || previous.source.ledgerSha256 !== studioLedgerHash ||
    !Array.isArray(previous.artifacts) || previous.artifacts.length !== files.length - 1) {
    studioFail('unexpected Studio output entry set: invalid previous build receipt');
  }
  const entries = new Map(previous.artifacts.map(item => [item?.name, item]));
  for (const name of files) {
    if (name === studioReceipt) continue;
    const entry = entries.get(name);
    if (!entry) studioFail('unexpected Studio output entry not bound by previous receipt: ' + name);
    const data = readFileSync(join(output, name));
    if (entry.bytes !== data.length || entry.sha256 !== sha256(data)) {
      studioFail('unexpected Studio output entry bytes: ' + name);
    }
  }
}

async function studioConfig(): Promise<UserConfig> {
  const { local, verified } = verifiedStudioSource();
  const { browserPackages, adapter, tailwind, inter, twVite, vite } = studioDependencies();
  const { default: tailwindPlugin } = await import('@tailwindcss/vite');
  const scratch = realpathSync(mkdtempSync(join(local, 'studio-build-')));
  const cleanup = () => {
    // Only the private directory returned by mkdtemp; never the input closure or the Studio output.
    if (!lstatSync(scratch, { throwIfNoEntry: false })) return;
    if (dirname(scratch) !== resolve(local) || !basename(scratch).startsWith('studio-build-') ||
      realpathSync(scratch) !== scratch) {
      studioFail('private build scratch escaped its expected parent');
    }
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    const root = slash(join(scratch, 'page'));
    const snapshot = root + '/source';
    const ui = posix.dirname(snapshot + '/' + studioAppPath);
    const html = root + '/index.html';
    const cssPath = snapshot + '/' + studioCssPath;
    const adapterPath = adapter.path + '/src/renderer.tsx';
    const probe = slash(fromDesktop('./renderer/features/creation/StudioProbe.tsx'));
    const output = fromDesktop('./dist/studio');
    mkdirSync(root);
    writeFileSync(html, [
      '<!doctype html>', '<html lang="zh-CN">', '<head>', '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>橙子创作中心 · Studio</title>', '</head>', '<body>',
      '<div id="studio-root"></div>',
      '<script type="module">import "@orange-studio-entry";</script>', '</body>', '</html>', '',
    ].join('\n'), { flag: 'wx' });
    for (const [name, bytes] of verified) {
      const file = snapshot + '/' + name;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes, { flag: 'wx' });
    }

    const styles: Plugin = {
      name: 'orange-studio-closed-css',
      enforce: 'pre',
      transform(code, id) {
        if (slash(id) !== cssPath) return;
        const original = "@import 'tailwindcss';";
        if (!code.startsWith(original)) studioFail('pinned Tailwind CSS entry changed');
        return code.replace(original, "@import 'tailwindcss' source(none);\n@source \".\";");
      },
    };
    const checkOutputPolicy = (build: ResolvedConfig['build']) => {
      const options = build.rolldownOptions.output;
      if (resolve(root, build.outDir) !== resolve(output) || build.emptyOutDir !== true ||
        build.watch || build.rolldownOptions.watch || build.sourcemap || build.ssr || build.lib ||
        build.assetsDir !== 'assets' || build.rolldownOptions.input !== html ||
        !options || Array.isArray(options) || Object.keys(options).length !== 1 ||
        options.entryFileNames !== studioEntryFileNames) {
        studioFail('attempted to override the fixed Studio production, root, base or output policy');
      }
    };
    const outputGuard: Plugin = {
      name: 'orange-studio-output-path',
      enforce: 'pre',
      configResolved(config) {
        try {
          if (!config.isProduction || config.root !== root || config.base !== './' || config.publicDir ||
            !config.environments.client) {
            studioFail('attempted to override the fixed Studio production, root, base or output policy');
          }
          checkOutputPolicy(config.build);
          checkOutputPolicy(config.environments.client.build);
          if (config.build.write) verifyPreviousStudioOutput(output);
        } catch (error) {
          cleanup();
          throw error;
        }
      },
      renderStart: {
        order: 'pre',
        sequential: true,
        handler(options) {
          const config = this.environment.config;
          checkOutputPolicy(config.build);
          if (this.environment.name !== 'client' || options.file || !options.dir ||
            resolve(root, options.dir) !== resolve(output)) {
            studioFail('attempted to override the fixed Studio production, root, base or output policy');
          }
          // Vite prepares (and can empty) output in its following pre renderStart hook.
          if (config.build.write) verifyPreviousStudioOutput(output);
        },
      },
    };
    const boundary: Plugin = {
      name: 'orange-studio-output-boundary',
      enforce: 'post',
      closeBundle: cleanup,
      generateBundle: {
        order: 'post',
        handler(_options, bundle) {
          const ids = [...this.getModuleIds()].map(slash).sort();
          const sourceModules = ids.filter(id => id.startsWith(snapshot + '/'))
            .map(id => id.slice(snapshot.length + 1));
          if (sourceModules.length !== verified.size - studioNonModules.size ||
            sourceModules.some(id => !verified.has(id) || studioNonModules.has(id)) ||
            !ids.includes(adapterPath) || !ids.includes(probe)) {
            studioFail('module graph does not match the pinned App, CSS and adapter closure (' + sourceModules.length + '/' + (verified.size - studioNonModules.size) + ' pinned modules)');
          }
          for (const id of ids) {
            if (id === html || id.startsWith(html + '?html-proxy&') ||
              id === probe || id === adapterPath || id.startsWith(snapshot + '/') ||
              browserPackages.some(pkg => id.startsWith(pkg.path + '/'))) continue;
            studioFail('unexpected renderer module or external: ' + id);
          }

          const chunks = Object.values(bundle).filter(item => item.type === 'chunk');
          const chunk = chunks[0];
          if (chunks.length !== 1 || !chunk.isEntry ||
            chunk.fileName !== 'assets/' + posix.basename(chunk.fileName) ||
            !studioEntryAsset.test(posix.basename(chunk.fileName)) ||
            chunk.imports.length || chunk.dynamicImports.length ||
            !Object.keys(chunk.modules).map(slash).includes(snapshot + '/' + studioAppPath)) {
            studioFail('Studio output is not a single local entry containing the real App');
          }
          const matches = (pattern: RegExp) => Object.keys(bundle).filter(name =>
            name === 'assets/' + posix.basename(name) && pattern.test(posix.basename(name)));
          const css = matches(studioCssAsset);
          const fontFiles = studioFontAssets.map(matches);
          if (css.length !== 1 || fontFiles.some(matches => matches.length !== 1)) {
            studioFail('expected one local stylesheet and all seven Inter WOFF2 subsets');
          }
          const names = ['index.html', chunk.fileName, css[0], ...fontFiles.flat()].sort();
          if (Object.keys(bundle).length !== names.length) studioFail('unexpected files in the Studio output');

          const textAsset = (name: string) => {
            const item = bundle[name];
            if (item?.type !== 'asset' || typeof item.source !== 'string') studioFail('missing text asset: ' + name);
            return item.source;
          };
          const page = textAsset('index.html');
          const style = textAsset(css[0]);
          const refs = [...page.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]).sort();
          const fontRefs = new Set(fontFiles.flat().map(name => './' + posix.basename(name)));
          const cssRefs = [...style.matchAll(/url\((?:"([^"]*)"|'([^']*)'|([^)\s]+))\)/g)]
            .map(match => match[1] ?? match[2] ?? match[3]);
          if (refs.join('\n') !== ['./' + chunk.fileName, './' + css[0]].sort().join('\n') ||
            !page.includes('<div id="studio-root"></div>') ||
            [...fontRefs].some(name => !cssRefs.includes(name)) ||
            cssRefs.some(url => !fontRefs.has(url) && !url.startsWith('data:image/svg+xml,'))) {
            studioFail('Studio HTML or stylesheet references do not match the local artifact set');
          }
          for (const text of [page, style, chunk.code]) {
            if (text.includes(slash(scratch)) || text.includes(slash(fromDesktop('../../'))) ||
              text.includes('.orange-local') || text.includes('.research')) {
              studioFail('Studio output contains a build-machine input path');
            }
          }
          const runtime = browserPackages.map(pkg => ({
            name: pkg.name, version: pkg.version,
            modules: ids.filter(id => id.startsWith(pkg.path + '/')).length,
          }));
          if (runtime.some(pkg => pkg.modules === 0) ||
            !ids.includes(browserPackages[0].path + '/cjs/react.production.js') ||
            !ids.includes(browserPackages[0].path + '/cjs/react-jsx-runtime.production.js') ||
            !ids.includes(browserPackages[1].path + '/cjs/react-dom-client.production.js')) {
            studioFail('fixed React, JSX or DOM runtime is absent');
          }
          this.emitFile({ type: 'asset', fileName: studioReceipt, source: JSON.stringify({
            source: {
              pin: studioPin, ledgerSha256: studioLedgerHash, files: verified.size,
              modulePaths: sourceModules, nonModules: [...studioNonModules],
            },
            toolchain: { vite: vite.version, tailwind: tailwind.version, tailwindVite: twVite.version },
            runtime, fontPackage: { name: inter.name, version: inter.version },
            artifacts: names.map(name => {
              const item = bundle[name];
              const bytes = item.type === 'asset' ? item.source : item.code;
              return { name, bytes: Buffer.from(bytes).length, sha256: sha256(bytes) };
            }),
          }, null, 2) + '\n' });
        },
      },
      writeBundle: {
        order: 'post',
        handler(_options, bundle) {
          const files = studioOutputFiles(output);
          if (files.join('\n') !== Object.keys(bundle).sort().join('\n')) {
            studioFail('unexpected Studio output entry set after writing');
          }
          for (const file of files) {
            const item = bundle[file];
            const bytes = Buffer.from(item.type === 'asset' ? item.source : item.code);
            if (!bytes.equals(readFileSync(join(output, file)))) {
              studioFail('unexpected Studio output entry bytes after writing: ' + file);
            }
          }
        },
      },
    };

    return {
      root,
      base: './',
      publicDir: false,
      envDir: false,
      css: { postcss: { plugins: [] } },
      oxc: { jsx: { runtime: 'automatic' } },
      resolve: {
        alias: [
          { find: '@orange-studio-entry', replacement: probe },
          { find: '@orange-studio-upstream', replacement: ui },
          { find: /^@\//, replacement: ui + '/' },
          { find: 'tailwindcss', replacement: tailwind.path + '/index.css' },
          { find: '@fontsource-variable/inter', replacement: inter.path + '/index.css' },
          ...browserPackages.map(pkg => ({ find: pkg.name, replacement: pkg.path })),
        ],
      },
      plugins: [outputGuard, styles, tailwindPlugin(), boundary],
      build: {
        target: 'es2022',
        outDir: output,
        emptyOutDir: true,
        modulePreload: false,
        assetsInlineLimit: 0,
        rolldownOptions: { input: html, output: { entryFileNames: studioEntryFileNames } },
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// Native experience inputs are a separate five-blob closure: do not widen the
// independently sealed 235-file Studio UI source graph.
export function studioExperienceBinding() {
  const gitDirectory = 'D:/dev/orange/.research/upstream/openfilm';
  const entries = [
    ['packages/openfilm/src/film-doc.mjs', 56775, '9ff98a77df6be45bace50bccca960571260a4d9a193a7bcb5e06a9261bec64e0'],
    ['packages/openfilm/studio/server/ops.mjs', 21887, 'accc40f54ee1ab79cb8559c1c777894902f42c411240eb40a6d6615e26f212ef'],
    ['packages/openfilm/src/timeline.mjs', 70480, '6a38ea00b06fea92139e59a913357ccef431ca308e672273eb4f467c8e9f7385'],
    ['packages/openfilm/src/overrides.mjs', 4117, '8fab39a5f4f9696e9070a206f45d9241f54167ea2d9f47c0bcc9975333664832'],
    ['packages/openfilm/studio/server/bridge.js', 12296, '816d37b38f6d290fcee5cb9ce64a02a347c2d6521979b3ec535ea5fc85f5824b'],
  ] as const;
  const snapshots = entries.map(([path, bytes, digest]) => {
    const data = execFileSync('git', ['-C', gitDirectory, 'show', studioPin + ':' + path], {
      timeout: 5_000, windowsHide: true, maxBuffer: 262_144,
    });
    if (data.length !== bytes || sha256(data) !== digest) studioFail('experience source bytes: ' + path);
    return data.toString('utf8');
  });
  const files = entries.map(([path, bytes, sha256]) => ({ path, bytes, sha256 }));
  const ledger = { sourcePin: studioPin, files };
  const root = '\0orange-experience:';
  const binding = root + 'binding';
  const ops = root + 'ops';
  const doc = root + 'film-doc';
  const plugin: Plugin = {
    name: 'orange-studio-experience-binding', enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'virtual:orange-studio-experience' && !importer?.startsWith(root)) return binding;
      if (importer === binding && source === 'orange-experience:film-doc') return doc;
      if (importer === binding && source === 'orange-experience:ops') return ops;
      if (importer === ops && source === '../../src/film-doc.mjs') return doc;
      if (importer?.startsWith(root)) studioFail('unexpected pure import: ' + source);
    },
    load(id) {
      if (id === doc) return snapshots[0];
      if (id === ops) return snapshots[1];
      if (id !== binding) return;
      return [
        'import {readFilm,filmHtml} from "orange-experience:film-doc";',
        'import {applyOps} from "orange-experience:ops";',
        'export default Object.freeze({sourcePin:' + JSON.stringify(studioPin) + ',',
        'browser:Object.freeze(' + JSON.stringify({ timelineMjs: snapshots[2], filmDocMjs: snapshots[0], overridesMjs: snapshots[3], bridgeJs: snapshots[4] }) + '),',
        'pure:Object.freeze({readFilm,filmHtml,applyOps})});',
      ].join('\n');
    },
  };
  return { plugin, ledger };
}
export default defineConfig(async ({ command, mode }): Promise<UserConfig> => {
  if (mode === 'studio') {
    if (command !== 'build') studioFail('Studio mode only supports an isolated build');
    return studioConfig();
  }
  if (mode === 'main' || mode === 'preload') {
    const isMain = mode === 'main';
    const experience = isMain ? studioExperienceBinding() : undefined;
    let studioReceiptSha256: string | undefined;
    if (isMain) {
      const output = fromDesktop('./dist/studio');
      requireStudioPath(join(output, studioReceipt), 'file', 'build-owned Studio receipt');
      verifyPreviousStudioOutput(output);
      studioReceiptSha256 = sha256(readFileSync(join(output, studioReceipt)));
    }
    const identity = isMain ? {
      appVersion: (JSON.parse(readFileSync(fromDesktop('./package.json'), 'utf8')) as { version: string }).version,
      buildCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fromDesktop('./'), encoding: 'utf8', timeout: 5_000, windowsHide: true,
      }).trim(),
    } : undefined;
    if (identity && (!/^[0-9a-f]{40}$/.test(identity.buildCommit) ||
      !/^(0|[1-9][0-9]{0,8})(\.(0|[1-9][0-9]{0,8})){2}$/.test(identity.appVersion))) {
      throw new Error('Invalid desktop build identity');
    }
    return {
      define: identity ? {
        __ORANGE_STUDIO_RECEIPT_SHA256__: JSON.stringify(studioReceiptSha256),
        __ORANGE_BUILD_VERSION__: JSON.stringify(identity.appVersion),
        __ORANGE_BUILD_COMMIT__: JSON.stringify(identity.buildCommit),
      } : undefined,
      plugins: identity ? [experience!.plugin, {
        name: 'orange-desktop-build-identity',
        generateBundle(_options, bundle) {
          const main = bundle['index.js'];
          if (!main || main.type !== 'chunk') throw new Error('Desktop main bundle is missing');
          const mainSha256 = createHash('sha256').update(main.code).digest('hex');
          this.emitFile({ type: 'asset', fileName: 'experience-build.json', source: JSON.stringify({ ...experience!.ledger, ledgerSha256: sha256(JSON.stringify(experience!.ledger)), studioReceiptSha256, mainSha256 }, null, 2) + '\n' });
          this.emitFile({ type: 'asset', fileName: 'build-identity.json',
            source: JSON.stringify({ ...identity, mainSha256 }) + '\n' });
        },
      }] : undefined,
      build: {
        target: 'node24',
        outDir: fromDesktop(`./dist/${mode}`),
        lib: {
          entry: fromDesktop(`./${mode}/index.ts`),
          formats: [isMain ? 'es' : 'cjs'],
          fileName: () => isMain ? 'index.js' : 'index.cjs',
        },
        rolldownOptions: { external: [/^node:/, 'electron'] },
      },
    };
  }

  return {
    root: fromDesktop('./renderer'),
    base: './',
    build: {
      outDir: fromDesktop('./dist/renderer'),
      // Only this directory is outside the renderer root.
      emptyOutDir: true,
    },
  };
});
