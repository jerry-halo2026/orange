import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction } from 'node:vm';
import { cli, contained, exactSha, fold, git, nulFields, parseArgs, repositoryPath, requireThat, text } from './check-admission.mjs';

const renderer = 'apps/desktop/renderer/';
const vendor = 'vendor/openfilm/';
const adapter = 'packages/film-adapter/src/renderer.tsx';
const protectedDirectories = [renderer.slice(0, -1), vendor.slice(0, -1), 'packages/film-adapter'];
const sourceFile = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const browserModules = new Set(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client']);
const loaderReceivers = new Set(['module', 'globalThis', 'global', 'window', 'self']);
const pinnedParser = Object.freeze({
  engine: 'typescript',
  version: '5.9.3',
  sha256: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
});

export function loadImportParser(root, filename) {
  if (filename === undefined) return undefined;
  try {
    requireThat(path.isAbsolute(filename) && (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(filename)),
      'IMPORT_PARSER_UNTRUSTED');
    const requested = path.resolve(filename);
    const file = realpathSync.native(requested);
    requireThat(file === requested && !contained(root, file), 'IMPORT_PARSER_UNTRUSTED');
    const stat = lstatSync(file);
    requireThat(stat.isFile() && stat.size === 9_112_572, 'IMPORT_PARSER_UNTRUSTED');
    const bytes = readFileSync(file);
    requireThat(createHash('sha256').update(bytes).digest('hex') === pinnedParser.sha256, 'IMPORT_PARSER_UNTRUSTED');
    // Execute only the exact vetted bytes, without a second path lookup or candidate package resolution.
    const builtin = createRequire(import.meta.url);
    const requireBuiltin = (name) => {
      requireThat(isBuiltin(name), 'IMPORT_PARSER_UNTRUSTED');
      return builtin(name.startsWith('node:') ? name : 'node:' + name);
    };
    const module = { exports: {} };
    const load = compileFunction(text(bytes), ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file });
    load(module.exports, requireBuiltin, module, file, path.dirname(file));
    const ts = module.exports;
    const required = [
      'createSourceFile', 'isAssignmentTarget', 'isAssignmentExpression', 'isAssignmentPattern',
      'getElementsOfBindingOrAssignmentPattern', 'getTargetOfBindingOrAssignmentElement',
    ];
    requireThat(ts.version === pinnedParser.version && required.every((name) => typeof ts[name] === 'function'),
      'IMPORT_PARSER_UNTRUSTED');
    return { provenance: pinnedParser, specifiers: (name, source) => astSpecifiers(ts, name, source) };
  } catch {
    requireThat(false, 'IMPORT_PARSER_UNTRUSTED');
  }
}

function astSpecifiers(ts, filename, source) {
  const extension = path.posix.extname(filename).toLowerCase();
  const kind = extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.jsx' ? ts.ScriptKind.JSX
    : /\.[cm]?js$/.test(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, kind);
  if (ast.parseDiagnostics.length) return null;
  const names = [];
  const directRequireTargets = new WeakSet();
  const assignmentPatterns = new WeakSet();
  function add(expression) {
    const node = unwrap(expression);
    names.push(node && ts.isStringLiteral(node) ? node.text : undefined);
  }
  let unsupported = false;
  function transparent(node) {
    return node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
      || ts.isSatisfiesExpression(node));
  }
  function unwrap(node) {
    while (transparent(node)) node = node.expression;
    return node;
  }
  function outermost(node) {
    while (transparent(node.parent) && node.parent.expression === node) node = node.parent;
    return node;
  }
  function stringKey(expression) {
    const node = unwrap(expression);
    if (!node) return undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = stringKey(node.left);
      const right = stringKey(node.right);
      if (left !== undefined && right !== undefined) return left + right;
    }
    return undefined;
  }
  function propertyKey(name) {
    if (ts.isIdentifier(name)) return name.text;
    return stringKey(ts.isComputedPropertyName(name) ? name.expression : name);
  }
  function checkLoaderKey(key, receiver) {
    const root = unwrap(receiver);
    if (key === 'require' || key === undefined && root && ts.isIdentifier(root) && loaderReceivers.has(root.text)) add();
  }
  function markAssignmentPatterns(pattern) {
    const target = unwrap(pattern);
    if (!target || !ts.isAssignmentPattern(target) || assignmentPatterns.has(target)) return;
    assignmentPatterns.add(target);
    // Follow only the compiler's targets; a default value's object literal is not a target.
    for (const element of ts.getElementsOfBindingOrAssignmentPattern(target)) {
      markAssignmentPatterns(ts.getTargetOfBindingOrAssignmentElement(element));
    }
  }
  function visit(node) {
    const parent = node.parent;
    const owner = parent?.parent;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        add(node.arguments[0]);
      } else if (ts.isIdentifier(callee) && callee.text === 'require') {
        directRequireTargets.add(callee);
        add(node.arguments[0]);
      }
    } else if (ts.isIdentifier(node) && node.text === 'require') {
      // A require reference not consumed as a direct call is not a known module edge.
      const bindingKey = owner && ts.isObjectBindingPattern(owner) && ts.isBindingElement(parent) && !parent.dotDotDotToken
        && (parent.propertyName ?? parent.name) === node;
      // Destructuring assignment keys are handled as targets, not ordinary property reads.
      const propertyName = parent && ts.isPropertyAssignment(parent) && parent.name === node;
      if (!directRequireTargets.has(node) && !bindingKey && !propertyName) add();
    } else if (ts.isElementAccessExpression(node)) {
      checkLoaderKey(stringKey(node.argumentExpression), node.expression);
    } else if (ts.isBindingElement(node) && parent && ts.isObjectBindingPattern(parent) && !node.dotDotDotToken) {
      const key = node.propertyName ?? node.name;
      checkLoaderKey(propertyKey(key), owner?.initializer);
    } else if (ts.isAssignmentPattern(node) && ts.isAssignmentTarget(outermost(node))) {
      markAssignmentPatterns(node);
    } else if (ts.isPropertyAssignment(node) && assignmentPatterns.has(parent)) {
      const target = outermost(parent);
      const source = target.parent;
      // Preserve the direct known-receiver check without inferring nested or iterated values.
      const receiver = source && ts.isAssignmentExpression(source, true) && source.left === target ? source.right : undefined;
      checkLoaderKey(propertyKey(node.name), receiver);
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      unsupported = true; // Vite-specific import.meta resolution is not part of this source preflight.
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return unsupported ? null : names;
}

export function readTree(root, head) {
  const tree = new Map();
  for (const field of nulFields(git(root, 'ls-tree', '-r', '-z', head))) {
    const match = /^(\d{6}) (?:blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(field);
    requireThat(match, 'GIT_OUTPUT_INVALID');
    const [, mode, oid, name] = match;
    repositoryPath(name);
    requireThat(!tree.has(name), 'GIT_OUTPUT_INVALID');
    tree.set(name, { mode, oid });
  }
  return tree;
}
function sourceTokens(source) {
  // Bounded preflight lexer, not a JavaScript parser or a Vite dependency graph.
  // Never evaluate candidate text. A full parser/build graph is a separate required check.
  const tokens = [];
  const scan = /\/\/[^\r\n\u2028\u2029]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|[a-zA-Z_$][a-zA-Z0-9_$]*|[^\s]/g;
  for (const [token] of source.matchAll(scan)) {
    if (token.startsWith('//') || token.startsWith('/*')) continue;
    // JSX/TS angle syntax, slash operators/regex, templates, escaped identifiers
    // and incomplete quoted tokens require the separate trusted parser/build graph.
    if (['<', '/', '\\', "'", '"', "`"].includes(token)) return null;
    tokens.push(token);
  }
  return tokens;
}
function literal(token) {
  if (!token || !/^['"]/.test(token) || token.length < 2) return undefined;
  const raw = token.slice(1, -1);
  // All expected module identifiers are simple strings. Reject other escapes rather than guessing.
  const decoded = raw.replace(/\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/g, (_, ...parts) => {
    const point = Number.parseInt(parts[0] ?? parts[1] ?? parts[2], 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : '\\';
  });
  return /[\\\x00-\x1f\x7f]/.test(decoded) ? undefined : decoded;
}
function specifiers(source) {
  const tokens = sourceTokens(source);
  if (!tokens) return null;
  const imports = [];
  for (let i = 0; i < tokens.length; i++) {
    const current = tokens[i];
    const next = tokens[i + 1];
    if (current === 'import' && next === '.') return null;
    if (current === 'require' || current === 'import' && next === '(') {
      imports.push(next === '(' && [')', ','].includes(tokens[i + 3]) ? literal(tokens[i + 2]) : undefined);
    } else if (current === 'import' && next !== '.') {
      if (/^['"]/.test(next ?? '')) {
        imports.push(literal(next));
      } else {
        for (let j = i + 1; j < tokens.length && ![';', 'import', 'export'].includes(tokens[j]); j++) {
          if (tokens[j] === 'from') {
            imports.push(literal(tokens[j + 1]));
            break;
          }
        }
      }
    } else if (current === 'export' && ['{', '*', 'type'].includes(next)) {
      let braces = 0;
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j] === '{') braces++;
        if (tokens[j] === '}') braces--;
        if (!braces && tokens[j] === 'from') {
          imports.push(literal(tokens[j + 1]));
          break;
        }
        if (!braces && [';', 'export', 'import', '='].includes(tokens[j])) break;
      }
    }
  }
  return imports;
}
function resolveLocal(file, specifier, tree) {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  if (target === '..' || target.startsWith('../')) return undefined;
  const jsStem = target.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  return [target, ...extensions.map((ext) => target + ext),
    ...extensions.map((ext) => target + '/index' + ext),
    ...(jsStem === target ? [] : extensions.map((ext) => jsStem + ext)),
  ].find((name) => tree.has(name));
}

export function checkImports(root, tree, parser) {
  const violations = [];
  const edges = new Map();
  const stack = new Set();
  const inspected = new Set();
  const reject = (file, code) => violations.push({ file, code });
  function walk(file, browser) {
    const cacheKey = file + '\0' + browser;
    if (stack.has(cacheKey)) return reject(file, 'IMPORT_CYCLE');
    if (inspected.has(cacheKey)) return;
    stack.add(cacheKey);
    const entry = tree.get(file);
    if (!entry || !['100644', '100755'].includes(entry.mode)) {
      reject(file, 'IMPORT_UNRESOLVED');
    } else {
      if (!edges.has(file)) {
        const source = text(git(root, 'cat-file', 'blob', entry.oid));
        edges.set(file, parser ? parser.specifiers(file, source) : specifiers(source));
      }
      const names = edges.get(file);
      if (!names) reject(file, 'IMPORT_SYNTAX_UNSUPPORTED');
      for (const name of names ?? []) {
        if (!name) { reject(file, 'IMPORT_UNRESOLVED'); continue; }
        const inVendor = file.startsWith(vendor);
        if (browser && (isBuiltin(name) || name.startsWith('node:') || /^electron(?:\/|$)/.test(name))) {
          reject(file, 'IMPORT_PRIVILEGED');
          continue;
        }
        // Windows can resolve package-scope aliases; never fold the allowed entry below.
        if (inVendor && fold(name).startsWith('@orange/')) {
          reject(file, 'IMPORT_VENDOR_REVERSE');
          continue;
        }
        const relative = name.startsWith('./') || name.startsWith('../');
        const adapterExport = name === '@orange/film-adapter/renderer';
        if (!relative && !adapterExport) {
          if (browser && !browserModules.has(name)) reject(file, 'IMPORT_UNRESOLVED');
          continue;
        }
        const target = adapterExport ? adapter : resolveLocal(file, name, tree);
        if (!target || !tree.has(target)) { reject(file, 'IMPORT_UNRESOLVED'); continue; }
        if (inVendor && !target.startsWith(vendor)) {
          reject(file, 'IMPORT_VENDOR_REVERSE');
          continue;
        }
        if (browser && !target.startsWith(renderer) && target !== adapter
          && !(target.startsWith(vendor) && (file === adapter || inVendor))) {
          reject(file, 'IMPORT_BOUNDARY');
          continue;
        }
        if (sourceFile.test(target)) walk(target, browser);
        else if (!target.endsWith('.css') && !target.endsWith('.json')) reject(file, 'IMPORT_UNRESOLVED');
      }
    }
    stack.delete(cacheKey);
    inspected.add(cacheKey);
  }
  for (const [file, entry] of tree) {
    const canonical = fold(file);
    if ((canonical === adapter && file !== adapter) || protectedDirectories.some((directory) =>
      (canonical === directory || canonical.startsWith(directory + '/'))
      && file !== directory && !file.startsWith(directory + '/'))) {
      reject(file, 'IMPORT_PATH_ALIAS');
      continue;
    }
    if (entry.mode === '160000' && (file === 'vendor/openfilm' || file.startsWith(vendor))) reject(file, 'IMPORT_UNRESOLVED');
    if (!sourceFile.test(file)) continue;
    if (file.startsWith(renderer) || file === adapter) walk(file, true);
    if (file.startsWith(vendor)) walk(file, false);
  }
  return violations;
}

const requiredGraphFlags = [
  '--trusted-vite-manifest', '--trusted-renderer-manifest', '--trusted-node-modules', '--graph-scratch',
];
export const rendererGraphFlags = [...requiredGraphFlags, '--trusted-renderer-profile'];
const reviewedProfileSha256 = '383b1b1f94eefbc3d8c2c21e35e4bca57d227edd2eb5a4180b7a9574337782dc';
const graphPins = {
  vite: { sha256: '50c18efaeb531b7464d9d3e012a38ca9f14bd0a852f217cab09b3767651d2210', packages: 17, files: 399 },
  renderer: { sha256: '2c9780e58f4d9ebab03103055e4728d8955922406dd7d8dedb92fa635311f3c1', packages: 3, files: 85 },
};
const sourceLock = '74851cd23286ee92e796ebfc84d748ae06d68cee87edce051f3c42e59f64a08e';
const profileRoots = new Map([
  [sourceLock, '64f0cf812e6bce4d8435f075a8866cda266a42c144afd48bac316bf7145291b3'],
  ['661d5ae66caed613baf1d9620d2e2257177caa59db9537b9acddeb2a37e50a45', 'effe3d0c244edb7d135e5e01bfe65ceb23c32e98ec430c3d66a7dc7b7de6df62'],
]);
const profileConfig = new Map([
  ['pnpm-workspace.yaml', '60ce4d1dbf137701a4683d171391c51662700c2f3e32a7caab8b2efc22540e65'],
  ['tsconfig.base.json', 'b6cb3136bcaff912b34bd64132cebde7bf340185455069dd232f71776f7f68a0'],
  ['apps/desktop/tsconfig.json', '408ccc51633344c48d962024616d82c0b679da89347e6306b0ac875e8b3d7d2e'],
  ['apps/desktop/package.json', '1409db9c53cfea7959784e9f8b8674394294b0bf1ac499cd12b3f22c27a93005'],
  ['apps/desktop/vite.config.ts', 'c21cabeab64fdc2ef4c2105c092cbada4f90d3ede1b82a9a7e4708ff7d3c5675'],
]);
const rendererEntries = ['index.html', 'main.tsx', 'App.tsx'].map((name) => renderer + name);
const browserPackages = new Set(['react', 'react-dom', 'scheduler']);
const graphHash = (value) => createHash('sha256').update(value).digest('hex');
function fixedGraphProfile(root, tree, reviewed) {
  function blob(file) {
    const entry = tree.get(file);
    requireThat(entry?.mode === '100644', 'GRAPH_PROFILE_UNAVAILABLE');
    return git(root, 'cat-file', 'blob', entry.oid);
  }
  const lock = graphHash(blob('pnpm-lock.yaml'));
  if (reviewed) {
    for (const { path: name, sha256 } of reviewed.exactFiles) {
      requireThat(graphHash(blob(name)) === sha256, 'GRAPH_PROFILE_UNAVAILABLE');
    }
  } else {
    requireThat(profileRoots.get(lock) === graphHash(blob('package.json')), 'GRAPH_PROFILE_UNAVAILABLE');
    for (const [name, expected] of profileConfig) {
      requireThat(graphHash(blob(name)) === expected, 'GRAPH_PROFILE_UNAVAILABLE');
    }
  }
  requireThat(tree.get(rendererEntries[0])?.oid === '689e8e350f782e75f39a23426e957596ca83e6ab', 'GRAPH_PROFILE_UNAVAILABLE');
  for (const name of tree.keys()) {
    const lower = fold(name);
    requireThat(!lower.startsWith(renderer) || rendererEntries.includes(name), 'GRAPH_PROFILE_UNAVAILABLE');
    // Reject possible configuration outside the fixed renderer settings, not just config execution.
    const parts = lower.split('/');
    const basename = parts.at(-1);
    const ancestor = ['', 'apps', 'apps/desktop'].includes(parts.slice(0, -1).join('/'));
    requireThat(!parts.includes('node_modules') && !parts.includes('vendor'), 'GRAPH_PROFILE_UNAVAILABLE');
    if (ancestor && (/^(?:\.env(?:\.|$)|(?:\.postcssrc|postcss\.config)(?:\.|$)|\.npmrc$|(?:\.?pnpmfile)(?:\.|$)|(?:vite\.config|[jt]sconfig)(?:\.|$))/.test(basename)
      || basename === 'package.json' && name !== 'package.json')) {
      requireThat(profileConfig.has(name), 'GRAPH_PROFILE_UNAVAILABLE');
    }
  }
  const selected = ['package.json', 'tsconfig.base.json', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json', ...rendererEntries];
  return { lock, inputs: selected.map((name) => [name, blob(name)]) };
}
function canonicalGraphPath(filename, directory, code) {
  try {
    requireThat(/^[a-z]:[\\/]/i.test(filename) && path.isAbsolute(filename), code);
    const full = path.resolve(filename);
    const stat = lstatSync(full);
    requireThat(realpathSync.native(full) === full && (directory ? stat.isDirectory() : stat.isFile()), code);
    return full;
  } catch {
    requireThat(false, code);
  }
}
function pinnedGraphJson(filename, sha256, code) {
  requireThat(lstatSync(filename).size < 1024 * 1024, code);
  const bytes = readFileSync(filename);
  requireThat(graphHash(bytes) === sha256, code);
  return JSON.parse(text(bytes));
}
function pinnedGraphManifest(filename, kind) {
  const pin = graphPins[kind];
  const manifest = pinnedGraphJson(filename, pin.sha256, 'GRAPH_MANIFEST_UNTRUSTED');
  requireThat(manifest.sourceLockSha256 === sourceLock && manifest.packages.length === pin.packages
    && manifest.packages.reduce((n, pkg) => n + pkg.files.length, 0) === pin.files, 'GRAPH_MANIFEST_UNTRUSTED');
  return manifest;
}
function putGraphFile(root, name, bytes) {
  const target = path.join(root, ...repositoryPath(name));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: 'wx' });
}
function copyPinnedPackages(source, target, manifest) {
  const known = new Set();
  for (const pkg of manifest.packages) {
    requireThat(!known.has(fold(pkg.name)), 'GRAPH_MANIFEST_UNTRUSTED');
    known.add(fold(pkg.name));
    for (const entry of pkg.files) {
      const file = path.join(source, ...repositoryPath(pkg.physicalRootFromNodeModules), ...repositoryPath(entry.path));
      canonicalGraphPath(file, false, 'GRAPH_PACKAGE_MISMATCH');
      requireThat(lstatSync(file).size === entry.bytes, 'GRAPH_PACKAGE_MISMATCH');
      const bytes = readFileSync(file);
      requireThat(bytes.length === entry.bytes && graphHash(bytes) === entry.sha256, 'GRAPH_PACKAGE_MISMATCH');
      putGraphFile(target, pkg.name + '/' + entry.path, bytes);
    }
  }
}
function ensureNoAncestorModules(scratch) {
  for (let dir = scratch; ; dir = path.dirname(dir)) {
    for (const entry of ['node_modules', '.git']) {
      try {
        lstatSync(path.join(dir, entry));
        requireThat(false, 'GRAPH_PATH_UNSAFE');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (path.dirname(dir) === dir) break;
  }
}
export function runRendererGraph(root, tree, flags) {
  requireThat(requiredGraphFlags.every((flag) => flags[flag]), 'GRAPH_CONFIG_INVALID');
  requireThat(process.platform === 'win32' && process.arch === 'x64' && process.version === 'v24.22.1', 'GRAPH_RUNTIME_UNAVAILABLE');
  const worker = realpathSync.native(fileURLToPath(import.meta.url));
  const scratch = canonicalGraphPath(flags['--graph-scratch'], true, 'GRAPH_PATH_UNSAFE');
  const source = canonicalGraphPath(flags['--trusted-node-modules'], true, 'GRAPH_PATH_UNSAFE');
  const toolManifest = canonicalGraphPath(flags['--trusted-vite-manifest'], false, 'GRAPH_PATH_UNSAFE');
  const rendererManifest = canonicalGraphPath(flags['--trusted-renderer-manifest'], false, 'GRAPH_PATH_UNSAFE');
  const reviewedPath = flags['--trusted-renderer-profile']
    ? canonicalGraphPath(flags['--trusted-renderer-profile'], false, 'GRAPH_PATH_UNSAFE') : undefined;
  requireThat([worker, scratch, source, toolManifest, rendererManifest, reviewedPath].filter(Boolean).every((name) => !contained(root, name))
    && !contained(scratch, root), 'GRAPH_PATH_UNSAFE');
  ensureNoAncestorModules(scratch);
  const tool = pinnedGraphManifest(toolManifest, 'vite');
  const dependencies = pinnedGraphManifest(rendererManifest, 'renderer');
  const reviewed = reviewedPath ? pinnedGraphJson(reviewedPath, reviewedProfileSha256, 'GRAPH_PROFILE_UNTRUSTED') : undefined;
  if (reviewed) {
    requireThat(reviewed.type === 'reviewed_equivalent_renderer_profile'
      && reviewed.viteToolManifestSha256 === graphPins.vite.sha256
      && reviewed.rendererDepManifestSha256 === graphPins.renderer.sha256, 'GRAPH_PROFILE_UNTRUSTED');
  }
  const profile = fixedGraphProfile(root, tree, reviewed);
  const workspace = mkdtempSync(path.join(scratch, 'orange-vite-run-'));
  try {
    for (const [name, bytes] of profile.inputs) putGraphFile(path.join(workspace, 'input'), name, bytes);
    copyPinnedPackages(source, path.join(workspace, 'tool', 'node_modules'), tool);
    copyPinnedPackages(source, path.join(workspace, 'input', 'node_modules'), dependencies);
    const system = process.env.SystemRoot ?? process.env.WINDIR;
    requireThat(system && path.isAbsolute(system), 'GRAPH_RUNTIME_UNAVAILABLE');
    // The child program and argv are fixed here; paths/receipts from the candidate are never code.
    const program = 'import { compileRendererGraph } from ' + JSON.stringify(pathToFileURL(worker).href) + ';'
      + 'try { console.log(JSON.stringify(await compileRendererGraph(process.argv[1]))); }'
      + 'catch (e) { console.log(JSON.stringify({code: e.gateCode ?? "GRAPH_BUILD_FAILED"})); process.exitCode = 1; }';
    const child = spawnSync(process.execPath, ['--no-global-search-paths', '--input-type=module', '-e', program, workspace], {
      cwd: workspace, windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
      env: { SystemRoot: system, WINDIR: system, PATH: path.join(system, 'System32'), USERPROFILE: workspace, TEMP: workspace, TMP: workspace },
    });
    requireThat(!child.error && child.signal === null && child.stdout, 'GRAPH_RUNTIME_FAILED');
    const output = JSON.parse(child.stdout);
    if (child.status !== 0) requireThat(false, /^GRAPH_[A-Z_]+$/.test(output.code ?? '') ? output.code : 'GRAPH_BUILD_FAILED');
    requireThat(output.modules > 0 && output.edges > 0 && output.chunks > 0, 'GRAPH_RUNTIME_FAILED');
    return {
      ...output, lockSha256: profile.lock, vite: '8.3.6', toolchainSha256: graphPins.vite.sha256, rendererSha256: graphPins.renderer.sha256,
      ...(reviewed && { profileSha256: reviewedProfileSha256 }),
    };
  } finally {
    const physical = realpathSync.native(workspace);
    requireThat(physical === workspace && path.dirname(physical) === scratch
      && path.basename(physical).startsWith('orange-vite-run-'), 'GRAPH_PATH_UNSAFE');
    rmSync(physical, { recursive: true });
  }
}

const polyfill = '\0vite/modulepreload-polyfill.js';
function graphModulePath(id, root) {
  if (id === polyfill) return id;
  requireThat(path.isAbsolute(id) && !id.includes('?') && !id.includes('\0'), 'GRAPH_UNKNOWN_MODULE');
  let physical;
  try { physical = realpathSync.native(id); } catch { requireThat(false, 'GRAPH_UNKNOWN_MODULE'); }
  requireThat(contained(root, physical), 'GRAPH_OUTSIDE_MIRROR');
  return path.relative(root, physical).replaceAll('\\', '/');
}
function allowedGraphModule(name) {
  const [directory, pkg] = name.split('/');
  return name === polyfill || rendererEntries.includes(name) || directory === 'node_modules' && browserPackages.has(pkg);
}
const prohibitedGraphImport = (source) => isBuiltin(source) || source.startsWith('node:') || /^electron(?:\/|$)/i.test(source);
export function verifyRendererGraph(root, { modules, chunks }) {
  const moduleIds = new Set(modules.map(({ id }) => id));
  const chunkIds = new Set(chunks.map(({ fileName }) => fileName));
  requireThat(chunks.length > 0 && chunkIds.size === chunks.length
    && chunks.every((chunk) => [...chunk.imports, ...chunk.dynamicImports].every((id) => chunkIds.has(id))), 'GRAPH_EXTERNAL_EDGE');
  requireThat(moduleIds.size === modules.length && modules.every((module) => module.externalFlag !== true
    && [...module.imports, ...module.dynamicImports].every((id) => moduleIds.has(id))), 'GRAPH_CLOSURE_OPEN');
  const roots = { react: new Set(), 'react-dom': new Set() };
  const names = new Map(modules.map(({ id }) => [id, graphModulePath(id, root)]));
  for (const name of names.values()) {
    const parts = name.split('/');
    const index = parts.lastIndexOf('node_modules');
    if (index >= 0 && Object.hasOwn(roots, parts[index + 1])) {
      roots[parts[index + 1]].add(parts.slice(0, index + 2).join('/'));
    }
  }
  const reactRoots = Object.fromEntries(Object.entries(roots).map(([name, paths]) => [name, paths.size]));
  requireThat(reactRoots.react === 1 && reactRoots['react-dom'] === 1, 'GRAPH_REACT_ROOTS');
  requireThat([...names.values()].every(allowedGraphModule), 'GRAPH_OUTSIDE_MIRROR');
  requireThat(rendererEntries.every((entry) => [...names.values()].includes(entry)), 'GRAPH_ENTRY_MISSING');
  const stable = modules.map((module) => [
    names.get(module.id), module.imports.map((id) => names.get(id)).sort(), module.dynamicImports.map((id) => names.get(id)).sort(),
  ]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return {
    modules: modules.length, chunks: chunks.length, reactRoots,
    edges: modules.reduce((n, node) => n + node.imports.length + node.dynamicImports.length, 0),
    graphSha256: graphHash(JSON.stringify(stable)),
  };
}
export async function compileRendererGraph(workspace) {
  const root = path.join(workspace, 'input');
  const entry = path.join(workspace, 'tool', 'node_modules', 'vite', 'dist', 'node', 'index.js');
  const { build } = await import(pathToFileURL(entry).href);
  const modules = [];
  const chunks = [];
  let violation;
  const fail = (code) => { violation = code; requireThat(false, code); };
  try {
    await build({
      configFile: false, envDir: false, publicDir: false, logLevel: 'silent',
      root: path.join(root, renderer), mode: 'renderer', base: './',
      cacheDir: path.join(workspace, 'cache'), css: { postcss: { plugins: [] } },
      build: { write: false, outDir: path.join(workspace, 'out'), emptyOutDir: false },
      plugins: [{
        name: 'orange-protected-renderer-graph', enforce: 'pre',
        resolveId(source, importer) {
          if (importer && prohibitedGraphImport(source)) fail('GRAPH_PRIVILEGED_IMPORT');
          if (importer && (/^\/\//.test(source) || /^[a-z][a-z\d+.-]*:/i.test(source) && !path.isAbsolute(source))) fail('GRAPH_EXTERNAL_EDGE');
          if (importer && path.isAbsolute(importer) && (source.startsWith('.') || path.isAbsolute(source))
            && !contained(root, path.resolve(path.dirname(importer), source))) fail('GRAPH_OUTSIDE_MIRROR');
        },
        load(id) {
          try {
            requireThat(allowedGraphModule(graphModulePath(id, root)), 'GRAPH_OUTSIDE_MIRROR');
          } catch (error) {
            fail(error.gateCode ?? 'GRAPH_UNKNOWN_MODULE');
          }
        },
        generateBundle(_options, bundle) {
          for (const item of Object.values(bundle)) {
            if (item.type === 'chunk') chunks.push({ fileName: item.fileName, imports: item.imports, dynamicImports: item.dynamicImports });
          }
          for (const id of this.getModuleIds()) {
            const info = this.getModuleInfo(id);
            if (info) modules.push({ id, imports: info.importedIds, dynamicImports: info.dynamicallyImportedIds, externalFlag: info.isExternal });
          }
        },
      }],
    });
  } catch (error) {
    requireThat(!violation, violation);
    throw error;
  }
  return verifyRendererGraph(root, { modules, chunks });
}

cli(import.meta.url, (args, report) => {
  const flags = parseArgs(args, ['--head'], ['--trusted-typescript']);
  const head = flags['--head'];
  requireThat(exactSha(head), 'BAD_ARGUMENTS');
  report.head = head;
  const root = realpathSync.native(text(git(process.cwd(), 'rev-parse', '--show-toplevel')).trimEnd());
  requireThat(text(git(root, 'cat-file', '-t', head)).trim() === 'commit', 'BAD_ARGUMENTS');
  const parser = loadImportParser(root, flags['--trusted-typescript']);
  if (parser) report.importParser = parser.provenance;
  report.violations = checkImports(root, readTree(root, head), parser);
  report.code = report.violations.length ? 'IMPORT_PREFLIGHT_FAILED' : 'IMPORT_PREFLIGHT_PASSED';
});
