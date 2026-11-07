import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  readlinkSync, readSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { compileFunction } from 'node:vm';
import { cli, contained, exactSha, fold, git, nulFields, parseArgs, repositoryPath, requireThat, text } from './check-admission.mjs';

const renderer = 'apps/desktop/renderer/';
const authApp = renderer + 'App.tsx';
const authImport = '../auth-contract.ts';
const authContract = 'apps/desktop/auth-contract.ts';
const studioContract = 'apps/desktop/studio-contract.ts';
const studioImport = '../studio-contract.ts';
export const studioRuntimeSourcePins = Object.freeze([
  ['packages/openfilm/src/film-doc.mjs', 56775, '9ff98a77df6be45bace50bccca960571260a4d9a193a7bcb5e06a9261bec64e0', true, true, true],
  ['packages/openfilm/studio/server/ops.mjs', 21887, 'accc40f54ee1ab79cb8559c1c777894902f42c411240eb40a6d6615e26f212ef', true, true, false],
  ['packages/openfilm/src/timeline.mjs', 70480, '6a38ea00b06fea92139e59a913357ccef431ca308e672273eb4f467c8e9f7385', false, false, true],
  ['packages/openfilm/src/overrides.mjs', 4117, '8fab39a5f4f9696e9070a206f45d9241f54167ea2d9f47c0bcc9975333664832', false, false, true],
  ['packages/openfilm/studio/server/bridge.js', 12296, '816d37b38f6d290fcee5cb9ce64a02a347c2d6521979b3ec535ea5fc85f5824b', false, false, true],
].map(([path, bytes, sha256, ui, nativePure, browser]) => Object.freeze({ path, bytes, sha256, ui, nativePure, browser })));
const studioContractDigest = '469f15b8a46c75f66de2ea9f63bef157cde82b5fad7aa0e9b793705e1c3b6fdb';
const bridgeBlobDigest = '181c274fb0a7a5ea4c5a1f7f1336ddf4f8f54edf2cd4844916ddc234e5e16cc8';
const authStylesheet = renderer + 'startup.css';
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
    return {
      provenance: pinnedParser,
      specifiers: (name, source) => astSpecifiers(ts, name, source),
      studioSpecifiers: (name, source) => astSpecifiers(ts, name, source, true),
    };
  } catch {
    requireThat(false, 'IMPORT_PARSER_UNTRUSTED');
  }
}

const studioUi = 'packages/openfilm/studio/ui/src';
const studioApp = studioUi + '/App.tsx';
const studioProbe = renderer + 'features/creation/StudioProbe.tsx';
const studioAdapterSha = '7977c3e4efa73279aa5ea33a4dbc83b776932e43d0e826da5e987f7e3991eab9';
function astSpecifiers(ts, filename, source, studio = false) {
  const extension = path.posix.extname(filename).toLowerCase();
  const kind = extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.jsx' ? ts.ScriptKind.JSX
    : /\.[cm]?js$/.test(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, kind);
  if (ast.parseDiagnostics.length) return null;
  const names = [];
  const directRequireTargets = new WeakSet();
  const assignmentPatterns = new WeakSet();
  function add(expression, wholeTypeOnly = false, studioValueOnly = false) {
    const node = unwrap(expression);
    const name = node && ts.isStringLiteral(node) ? node.text : undefined;
    names.push({ name, authTypeOnly: wholeTypeOnly && name === authImport
      && node.getText(ast).slice(1, -1) === authImport,
      studioValueOnly: studioValueOnly && name === studioImport && node.getText(ast).slice(1, -1) === studioImport });
  }
  function exactStudioValue(node) {
    const clause = node.importClause;
    const binding = clause?.namedBindings;
    if (node.attributes || !clause || clause.isTypeOnly || clause.name || !binding || !ts.isNamedImports(binding)) return false;
    const values = new Set(['isStudioState', 'studioShellInset']);
    const types = new Set(['DesktopStudioBridge', 'StudioState']);
    const seen = new Set();
    let runtime = false;
    for (const element of binding.elements) {
      if (element.propertyName || !ts.isIdentifier(element.name) || seen.has(element.name.text)
        || !(element.isTypeOnly ? types : values).has(element.name.text)) return false;
      seen.add(element.name.text);
      if (!element.isTypeOnly) runtime = true;
    }
    return runtime;
  }
  let unsupported = false;
  let studioGlobs = 0;
  const studioAdapter = studio && filename === adapter;
  function exactStudioGlob(node) {
    const property = node.parent;
    const call = property?.parent;
    const access = call?.parent;
    if (!(property && ts.isPropertyAccessExpression(property) && property.expression === node
      && property.name.text === 'glob' && !property.questionDotToken
      && call && ts.isCallExpression(call) && call.expression === property && !call.questionDotToken
      && call.arguments.length === 2 && call.typeArguments?.length === 1
      && access && ts.isElementAccessExpression(access) && access.expression === call && !access.questionDotToken)) return false;
    const [pattern, options] = call.arguments;
    const literal = (value, name) => value && ts.isStringLiteral(value) && value.text === name;
    const onlyPath = '/source/' + studioApp;
    return literal(pattern, onlyPath) && literal(access.argumentExpression, onlyPath)
      && ts.isObjectLiteralExpression(options) && options.properties.length === 3
      && options.properties.every((entry, index) => ts.isPropertyAssignment(entry)
        && ts.isIdentifier(entry.name) && entry.name.text === ['eager', 'import', 'exhaustive'][index]
        && (index === 1 ? literal(entry.initializer, 'App') : entry.initializer.kind === ts.SyntaxKind.TrueKeyword));
  }
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
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier, node.importClause?.isTypeOnly === true && !node.attributes, exactStudioValue(node));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        if (studio) unsupported = true;
        add(node.arguments[0]);
      } else if (ts.isIdentifier(callee) && callee.text === 'require') {
        if (studio) unsupported = true;
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
      if (studioAdapter && exactStudioGlob(node)) studioGlobs++;
      else unsupported = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return unsupported || studioAdapter && studioGlobs !== 1 ? null : names;
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

function exactAuthNamespace(tree, contractPath = authContract) {
  const pinned = new Map();
  let prefix = '';
  for (const part of repositoryPath(contractPath)) {
    prefix = prefix ? prefix + '/' + part : part;
    pinned.set(fold(prefix), prefix);
  }
  for (const name of tree.keys()) {
    let current = '';
    for (const part of name.split('/')) {
      current = current ? current + '/' + part : part;
      const expected = pinned.get(fold(current));
      if (expected && expected !== current) return false;
    }
  }
  return true;
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
      let acceptedAuthType = false;
      let acceptedStudioValue = false;
      for (const edge of names ?? []) {
        const name = parser ? edge.name : edge;
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
          if (!acceptedAuthType && parser && edge.authTypeOnly && file === authApp && target === authContract) {
            const contract = tree.get(authContract);
            if (contract?.mode === '100644' && exactAuthNamespace(tree)
              && graphHash(git(root, 'cat-file', 'blob', contract.oid)) === bridgeBlobDigest) {
              acceptedAuthType = true;
              continue; // The fixed whole-declaration type import cannot add a runtime module.
            }
          }
          const contract = tree.get(studioContract);
          if (!acceptedStudioValue && parser && edge.studioValueOnly && file === authApp && target === studioContract
            && contract?.mode === '100644' && exactAuthNamespace(tree, studioContract)
            && graphHash(git(root, 'cat-file', 'blob', contract.oid)) === studioContractDigest) {
            acceptedStudioValue = true; // This is a runtime edge: inspect it and include it in the actual graph below.
          } else {
            reject(file, 'IMPORT_BOUNDARY');
            continue;
          }
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
const startupRendererProfileDigest = '3eb5101fe2a5deeb03df4c7c7f69399f990eec9263d045bdd494ac7805ae8c20';
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
function fixedGraphProfile(root, tree, reviewed, auth) {
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
  const approvedRenderer = auth ? [...rendererEntries, authStylesheet] : rendererEntries;
  requireThat(!auth || exactAuthNamespace(tree), 'GRAPH_PROFILE_UNAVAILABLE');
  for (const name of tree.keys()) {
    const lower = fold(name);
    requireThat(!lower.startsWith(renderer) || approvedRenderer.includes(name), 'GRAPH_PROFILE_UNAVAILABLE');
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
  const selected = ['package.json', 'tsconfig.base.json', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json',
    ...approvedRenderer, ...(auth ? [authContract] : [])];
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
function pinnedGraphJson(filename, hashes, code) {
  requireThat(lstatSync(filename).size < 1024 * 1024, code);
  const bytes = readFileSync(filename);
  const sha256 = graphHash(bytes);
  requireThat((Array.isArray(hashes) ? hashes : [hashes]).includes(sha256), code);
  return { value: JSON.parse(text(bytes)), sha256 };
}
function pinnedGraphManifest(filename, kind) {
  const pin = graphPins[kind];
  const { value: manifest } = pinnedGraphJson(filename, pin.sha256, 'GRAPH_MANIFEST_UNTRUSTED');
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
  const reviewedPin = reviewedPath ? pinnedGraphJson(reviewedPath, [reviewedProfileSha256, startupRendererProfileDigest],
    'GRAPH_PROFILE_UNTRUSTED') : undefined;
  const reviewed = reviewedPin?.value;
  const auth = reviewedPin?.sha256 === startupRendererProfileDigest;
  if (reviewed) {
    requireThat(reviewed.type === (auth ? 'reviewed_auth_renderer_profile' : 'reviewed_equivalent_renderer_profile')
      && reviewed.viteToolManifestSha256 === graphPins.vite.sha256
      && reviewed.rendererDepManifestSha256 === graphPins.renderer.sha256, 'GRAPH_PROFILE_UNTRUSTED');
  }
  const profile = fixedGraphProfile(root, tree, reviewed, auth);
  const workspace = mkdtempSync(path.join(scratch, 'orange-vite-run-'));
  try {
    for (const [name, bytes] of profile.inputs) putGraphFile(path.join(workspace, 'input'), name, bytes);
    copyPinnedPackages(source, path.join(workspace, 'tool', 'node_modules'), tool);
    copyPinnedPackages(source, path.join(workspace, 'input', 'node_modules'), dependencies);
    const system = process.env.SystemRoot ?? process.env.WINDIR;
    requireThat(system && path.isAbsolute(system), 'GRAPH_RUNTIME_UNAVAILABLE');
    // The child program and argv are fixed here; paths/receipts from the candidate are never code.
    const program = 'import { compileRendererGraph } from ' + JSON.stringify(pathToFileURL(worker).href) + ';'
      + 'try { console.log(JSON.stringify(await compileRendererGraph(process.argv[1], ' + JSON.stringify(auth) + '))); }'
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
      ...(reviewed && { profileSha256: reviewedPin.sha256 }),
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
function allowedGraphModule(name, auth) {
  const [directory, pkg] = name.split('/');
  return name === polyfill || rendererEntries.includes(name) || auth && name === authStylesheet
    || directory === 'node_modules' && browserPackages.has(pkg);
}
const prohibitedGraphImport = (source) => isBuiltin(source) || source.startsWith('node:') || /^electron(?:\/|$)/i.test(source);
export function verifyRendererGraph(root, { modules, chunks }, auth = false) {
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
  requireThat([...names.values()].every((name) => allowedGraphModule(name, auth)), 'GRAPH_OUTSIDE_MIRROR');
  const requiredEntries = auth ? [...rendererEntries, authStylesheet] : rendererEntries;
  requireThat(requiredEntries.every((entry) => [...names.values()].includes(entry)), 'GRAPH_ENTRY_MISSING');
  const stable = modules.map((module) => [
    names.get(module.id), module.imports.map((id) => names.get(id)).sort(), module.dynamicImports.map((id) => names.get(id)).sort(),
  ]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return {
    modules: modules.length, chunks: chunks.length, reactRoots,
    edges: modules.reduce((n, node) => n + node.imports.length + node.dynamicImports.length, 0),
    graphSha256: graphHash(JSON.stringify(stable)),
  };
}
export async function compileRendererGraph(workspace, auth = false) {
  const root = path.join(workspace, 'input');
  const entry = path.join(workspace, 'tool', 'node_modules', 'vite', 'dist', 'node', 'index.js');
  const { build } = await import(pathToFileURL(entry).href);
  const modules = [];
  const chunks = [];
  let stylesheets = 0;
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
            requireThat(allowedGraphModule(graphModulePath(id, root), auth), 'GRAPH_OUTSIDE_MIRROR');
          } catch (error) {
            fail(error.gateCode ?? 'GRAPH_UNKNOWN_MODULE');
          }
        },
        generateBundle(_options, bundle) {
          for (const item of Object.values(bundle)) {
            if (item.type === 'chunk') chunks.push({ fileName: item.fileName, imports: item.imports, dynamicImports: item.dynamicImports });
            else if (auth && item.fileName !== 'index.html') {
              if (item.type !== 'asset' || !/^assets\/index-[A-Za-z0-9_-]+\.css$/.test(item.fileName)
                || /@import\b|url\s*\(/i.test(typeof item.source === 'string' ? item.source : text(item.source))) {
                fail('GRAPH_EXTERNAL_ASSET');
              }
              stylesheets++;
            }
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
  requireThat(!auth || stylesheets === 1, 'GRAPH_EXTERNAL_ASSET');
  return { ...verifyRendererGraph(root, { modules, chunks }, auth), ...(auth && { stylesheets }) };
}

// The draft's label is not authority. A Studio assignment must independently
// name these exact pins; only this fixed recipe and subject may use them.
const legacyStudioHead = 'f7113a99246d0fde220c9da35cd5bc01c0815382';
const legacyStudioRendererPins = Object.freeze({
  profileSha256: 'da14717975ad2d34e2fc3acf518b90d9ce6968c1f2e0a8ec68a96b08f22b5fdc',
  packageManifestSha256: '08a1d2e28b6990c3ecedceebf14f643ad7b890edc17238b7e86872e8060c6d5e',
});
export const studioRendererPins = Object.freeze({
  profileSha256: 'fda9dfb5f3a2c644adea7c312b905f4c45be5835f9f28fe1331efdd825dc1867',
  packageManifestSha256: '08a1d2e28b6990c3ecedceebf14f643ad7b890edc17238b7e86872e8060c6d5e',
});
const studioLockSha = '310ba40fbad44925b503b8d850798f691b416b6427c08c7e18cf7a388c759f90';
const studioNodeSha = '339d0cc21986591011956d40da90547f88162aa3702022959216998d370d276c';
const studioAuthFiles = [...rendererEntries, authStylesheet, authContract, studioContract];
const studioContextFiles = ['.gitmodules', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json',
  'apps/desktop/tsconfig.json', 'apps/desktop/package.json', 'apps/desktop/vite.config.ts', 'packages/film-adapter/package.json'];
const studioFlags = ['--trusted-renderer-profile', '--trusted-renderer-manifest', '--trusted-node-modules', '--graph-scratch'];
const studioProfileError = 'STUDIO_C1_PROFILE_UNTRUSTED';
const studioPathError = 'STUDIO_C1_PATH_UNSAFE';
const studioPackageError = 'STUDIO_C1_PACKAGE_MISMATCH';
const studioSourceError = 'STUDIO_C1_SOURCE_MISMATCH';
const studioBuildError = 'STUDIO_C1_BUILD_FAILED';
const studioGraphError = 'STUDIO_C1_GRAPH_MISMATCH';
const studioArtifactError = 'STUDIO_C1_ARTIFACT_MISMATCH';
const studioRuntimeError = 'STUDIO_C1_RUNTIME_UNAVAILABLE';
const digestPattern = /^[a-f0-9]{64}$/;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function studioRendererRequested(flags) {
  return studioFlags.some((flag) => flags[flag]);
}

function studioFileBytes(file, size, sha256, code, nlink = 1) {
  try {
    const before = lstatSync(file);
    requireThat(before.isFile() && !before.isSymbolicLink() && (nlink === null || before.nlink === nlink)
      && before.size === size && realpathSync.native(file) === file, code);
    const same = (stat) => stat.isFile()
      && ['dev', 'ino', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every((key) => stat[key] === before[key]);
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      requireThat(same(fstatSync(fd)), code);
      const bytes = Buffer.alloc(size + 1);
      let at = 0;
      while (at < bytes.length) {
        const count = readSync(fd, bytes, at, bytes.length - at, at);
        if (!count) break;
        at += count;
      }
      const content = bytes.subarray(0, at);
      requireThat(at === size && same(fstatSync(fd)) && same(lstatSync(file)) && graphHash(content) === sha256, code);
      return content;
    } finally {
      closeSync(fd);
    }
  } catch {
    requireThat(false, code);
  }
}

function studioPinnedJson(file, size, digest, code) {
  try {
    return JSON.parse(text(studioFileBytes(file, size, digest, code)));
  } catch {
    requireThat(false, code);
  }
}
function studioRelative(value, code) {
  try {
    requireThat(/^[a-zA-Z0-9@._+/-]+$/.test(value), code);
    repositoryPath(value);
    return value;
  } catch {
    requireThat(false, code);
  }
}
function uniqueStudioPaths(rows, code) {
  const paths = rows.map((row) => studioRelative(row.path, code));
  requireThat(new Set(paths.map(fold)).size === paths.length, code);
}
function studioSizedSha(row) {
  return Number.isSafeInteger(row.bytes) && row.bytes > 0 && digestPattern.test(row.sha256);
}
export function checkStudioProfile(profile, ordinary = false) {
  const code = studioProfileError;
  requireThat(keysAre(profile, ['schemaVersion', 'kind', 'status', 'admitted', 'subject', 'parserSha256', 'sourceLockSha256',
    'packageManifestSha256', 'inputs', 'fixedUpstream', 'builds', 'studioAssetReferences', ...(ordinary ? ['runtimeSource'] : [])])
    && profile.schemaVersion === 1 && profile.kind === 'studio-c1-dual-exact-profile-draft'
    && profile.status === 'unapproved-proof-inputs' && profile.admitted === false
    && keysAre(profile.subject, ['head', 'tree']) && exactSha(profile.subject.head) && exactSha(profile.subject.tree)
    && profile.parserSha256 === pinnedParser.sha256 && profile.sourceLockSha256 === studioLockSha
    && profile.packageManifestSha256 === studioRendererPins.packageManifestSha256, code);
  requireThat(Array.isArray(profile.inputs) && profile.inputs.length === (ordinary ? 17 : 16)
    && profile.inputs.every((row) => keysAre(row, ['path', 'mode', 'oid', 'bytes', 'sha256', 'buildInput'])
      && row.mode === '100644' && exactSha(row.oid) && studioSizedSha(row) && row.bytes <= 128 * 1024), code);
  const projection = [...studioAuthFiles, studioProbe, adapter];
  uniqueStudioPaths(profile.inputs, code);
  requireThat(profile.inputs.every((row) => (row.buildInput === true && projection.includes(row.path))
    || (row.buildInput === false && studioContextFiles.includes(row.path)))
    && profile.inputs.find(({ path }) => path === 'pnpm-lock.yaml')?.sha256 === studioLockSha, code);
  if (ordinary) {
    requireThat(keysAre(profile.runtimeSource, ['sourcePin', 'files'])
      && profile.runtimeSource.sourcePin === '2e18a4bdf54647b2ece3c0975a6f9573720c7821'
      && Array.isArray(profile.runtimeSource.files) && profile.runtimeSource.files.length === 5
      && profile.runtimeSource.files.every((row, i) => keysAre(row, ['path', 'oid', 'bytes', 'sha256', 'ui', 'nativePure', 'browser'])
        && exactSha(row.oid) && Object.entries(studioRuntimeSourcePins[i]).every(([key, value]) => row[key] === value)), code);
  }
  const upstream = profile.fixedUpstream;
  requireThat(keysAre(upstream, ['path', 'mode', 'head', 'tree', 'closure']) && upstream.path === 'vendor/openfilm'
    && upstream.mode === '160000' && exactSha(upstream.head) && exactSha(upstream.tree)
    && Array.isArray(upstream.closure) && upstream.closure.length === 235
    && upstream.closure.filter(({ active }) => active).length === 233
    && upstream.closure.every((row) => keysAre(row, ['path', 'oid', 'bytes', 'sha256', 'active'])
      && row.path.startsWith('packages/openfilm/') && exactSha(row.oid) && studioSizedSha(row)
      && typeof row.active === 'boolean' && row.bytes <= 1024 * 1024), code);
  uniqueStudioPaths(upstream.closure, code);
  requireThat(Array.isArray(profile.builds) && profile.builds.length === 2
    && Array.isArray(profile.studioAssetReferences) && profile.studioAssetReferences.length === 8, code);
  for (const [index, build] of profile.builds.entries()) {
    requireThat(keysAre(build, ['track', 'graphSha256', 'modules', 'chunkModules', 'artifacts', ...(ordinary ? ['edgeSha256'] : [])])
      && build.track === ['auth', 'studio'][index] && digestPattern.test(build.graphSha256)
      && build.modules === (ordinary ? [16, 1797] : [15, 1797])[index]
      && build.chunkModules === (ordinary ? [17, 423] : [16, 423])[index]
      && (!ordinary || digestPattern.test(build.edgeSha256))
      && Array.isArray(build.artifacts) && build.artifacts.length === [3, 10][index]
      && build.artifacts.every((row) => keysAre(row, ['name', 'bytes', 'sha256']) && studioSizedSha(row)), code);
    uniqueStudioPaths(build.artifacts.map(({ name }) => ({ path: name })), code);
  }
}

function checkStudioPackages(manifest) {
  const code = studioProfileError;
  requireThat(keysAre(manifest, ['schemaVersion', 'kind', 'sourceLockSha256', 'packages', 'links', 'direct', 'totals'])
    && manifest.schemaVersion === 1 && manifest.kind === 'studio-c1-offline-package-content'
    && manifest.sourceLockSha256 === studioLockSha && manifest.packages.length === 39 && manifest.links.length === 52
    && isDeepStrictEqual(manifest.totals, { packages: 39, links: 52, files: 4451, bytes: 96129218 }), code);
  const packages = new Set();
  const ids = new Set();
  let files = 0, bytes = 0;
  for (const pkg of manifest.packages) {
    requireThat(keysAre(pkg, ['id', 'physical', 'files']) && !ids.has(pkg.id)
      && pkg.physical.startsWith('node_modules/.pnpm/') && !packages.has(fold(pkg.physical))
      && Array.isArray(pkg.files) && pkg.files.length > 0
      && pkg.files.every((row) => keysAre(row, ['path', 'bytes', 'sha256']) && Number.isSafeInteger(row.bytes)
        && row.bytes >= 0 && row.bytes <= 32 * 1024 * 1024 && digestPattern.test(row.sha256)), code);
    packages.add(fold(studioRelative(pkg.physical, code)));
    ids.add(pkg.id);
    uniqueStudioPaths(pkg.files, code);
    files += pkg.files.length;
    bytes += pkg.files.reduce((sum, row) => sum + row.bytes, 0);
  }
  uniqueStudioPaths(manifest.links, code);
  requireThat(files === manifest.totals.files && bytes === manifest.totals.bytes
    && manifest.links.every((row) => keysAre(row, ['path', 'target']) && packages.has(fold(studioRelative(row.target, code))))
    && Array.isArray(manifest.direct) && manifest.direct.length === 7
    && manifest.direct.every((direct) => manifest.links.some((row) => row.path === direct)), code);
}

function ensureStudioScratch(scratch) {
  try {
    ensureNoAncestorModules(scratch);
    const config = /^(?:package\.json|[jt]sconfig(?:[.-].*)?\.json|(?:postcss|vite|tailwind)\.config\..*|\.postcssrc(?:\..*)?|\.npmrc|pnpm-workspace\.yaml)$/i;
    for (let dir = scratch; ; dir = path.dirname(dir)) {
      requireThat(!readdirSync(dir).some((entry) => config.test(entry)), studioPathError);
      if (dir === path.dirname(dir)) break;
    }
  } catch {
    requireThat(false, studioPathError);
  }
}
export function loadStudioRendererInputs(flags, protectedRoots, subject, approval) {
  requireThat(studioFlags.every((flag) => flags[flag]) && flags['--trusted-typescript'] && !flags['--trusted-vite-manifest'],
    'STUDIO_DUAL_GRAPH_REQUIRED');
  const pins = subject.head === legacyStudioHead ? legacyStudioRendererPins : studioRendererPins;
  requireThat(keysAre(approval, ['base', 'head', 'tree', ...Object.keys(pins)]), 'STUDIO_C1_APPROVAL_REQUIRED');
  requireThat(approval.base === subject.base && approval.head === subject.head && approval.tree === subject.tree,
    'STUDIO_C1_SUBJECT_MISMATCH');
  requireThat(Object.entries(pins).every(([key, value]) => approval[key] === value), 'STUDIO_C1_APPROVAL_REQUIRED');
  const scratch = canonicalGraphPath(flags['--graph-scratch'], true, studioPathError);
  const donor = canonicalGraphPath(flags['--trusted-node-modules'], true, studioPathError);
  const profilePath = canonicalGraphPath(flags['--trusted-renderer-profile'], false, studioPathError);
  const manifestPath = canonicalGraphPath(flags['--trusted-renderer-manifest'], false, studioPathError);
  const parserPath = canonicalGraphPath(flags['--trusted-typescript'], false, studioPathError);
  const isExternal = (item) => [scratch, donor, ...protectedRoots].every((dir) => !contained(dir, item));
  requireThat(isExternal(profilePath) && isExternal(manifestPath)
    && protectedRoots.every((dir) => !contained(dir, scratch) && !contained(scratch, dir)
      && !contained(dir, donor) && !contained(donor, dir))
    && !contained(scratch, parserPath) && !contained(donor, parserPath)
    && !contained(scratch, donor) && !contained(donor, scratch), studioPathError);
  ensureStudioScratch(scratch);
  const profile = studioPinnedJson(profilePath, pins === studioRendererPins ? 59588 : 57970, pins.profileSha256, studioProfileError);
  checkStudioProfile(profile, pins === studioRendererPins);
  requireThat(profile.subject.head === subject.head && profile.subject.tree === subject.tree
    && profile.fixedUpstream.head === subject.sourceHead && profile.fixedUpstream.tree === subject.sourceTree,
  'STUDIO_C1_SUBJECT_MISMATCH');
  const manifest = studioPinnedJson(manifestPath, 590782, studioRendererPins.packageManifestSha256, studioProfileError);
  checkStudioPackages(manifest);
  return { scratch, donor, profile, manifest, profilePath, manifestPath, parserPath, subject, pins };
}

function studioAllowedStatic(file, edge, orange, upstream) {
  const name = edge.name;
  if (!name || isBuiltin(name) || /^node:|^electron(?:\/|$)/i.test(name)) return false;
  if (file === studioProbe) return ['@orange/film-adapter/renderer', 'react-dom/client'].includes(name);
  if (file === adapter) return name === 'react' || name === '@orange-studio-upstream/globals.css' && upstream.has(studioUi + '/globals.css');
  const relative = name.startsWith('./') || name.startsWith('../');
  if (orange.has(file)) {
    if (!relative) return browserModules.has(name);
    const target = resolveLocal(file, name, orange);
    return studioAuthFiles.includes(target) && (target === authContract
      ? file === authApp && edge.authTypeOnly && graphHash(orange.get(authContract)) === bridgeBlobDigest
      : target === studioContract
        ? file === authApp && edge.studioValueOnly && exactAuthNamespace(orange, studioContract)
          && graphHash(orange.get(studioContract)) === studioContractDigest
        : true);
  }
  if (name.startsWith('@/')) {
    const pseudo = studioUi + '/entry.ts';
    return upstream.has(resolveLocal(pseudo, './' + name.slice(2), upstream));
  }
  if (relative) return upstream.has(resolveLocal(file, name, upstream));
  return ['react', 'react-dom', 'lucide-react'].includes(name);
}

export function verifyStudioRendererStatic(parser, orange, upstream) {
  requireThat(parser?.provenance.sha256 === pinnedParser.sha256 && graphHash(orange.get(adapter)) === studioAdapterSha, studioSourceError);
  const facts = [];
  for (const [file, bytes] of [...orange, ...upstream]) {
    if (!sourceFile.test(file) || file === authContract) continue;
    const edges = studioAuthFiles.includes(file) ? parser.specifiers(file, text(bytes)) : parser.studioSpecifiers(file, text(bytes));
    if (file === studioContract) requireThat(graphHash(bytes) === studioContractDigest
      && exactAuthNamespace(orange, studioContract) && edges?.length === 0, 'STUDIO_C1_STATIC_BOUNDARY');
    requireThat(edges && edges.filter((edge) => edge.name === studioImport).length <= 1
      && edges.every((edge) => studioAllowedStatic(file, edge, orange, upstream)), 'STUDIO_C1_STATIC_BOUNDARY');
    facts.push([file, edges.map((edge) => edge.name).sort()]);
  }
  facts.sort(([a], [b]) => compare(a, b));
  return { files: facts.length, sha256: graphHash(JSON.stringify(facts)), parserSha256: pinnedParser.sha256 };
}

function studioLinkTarget(link, target, code) {
  try {
    const declared = readlinkSync(link).replace(/^\\\\\?\\/, '');
    requireThat(lstatSync(link).isSymbolicLink() && realpathSync.native(link) === target
      && path.resolve(path.dirname(link), declared) === target, code);
  } catch {
    requireThat(false, code);
  }
}
export function stageStudioPackages(donor, mirror, manifest) {
  const files = new Map();
  for (const pkg of manifest.packages) {
    for (const row of pkg.files) files.set(pkg.physical + '/' + row.path, row);
  }
  const links = new Map(manifest.links.map((row) => [row.path, row.target]));
  const directories = new Set(['']);
  for (const relative of [...files.keys(), ...links.keys()]) {
    for (let dir = path.posix.dirname(relative); dir !== '.'; dir = path.posix.dirname(dir)) directories.add(dir);
  }
  function walk(directory, prefix) {
    requireThat(realpathSync.native(directory) === directory && lstatSync(directory).isDirectory(), studioPackageError);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) {
        requireThat(directories.has(relative), studioPackageError);
        walk(path.join(directory, entry.name), relative + '/');
      } else {
        requireThat(entry.isSymbolicLink() ? links.has(relative) : entry.isFile() && files.has(relative), studioPackageError);
      }
    }
  }
  try {
    walk(donor, '');
    for (const [relative, row] of files) {
      const bytes = studioFileBytes(path.join(donor, relative), row.bytes, row.sha256, studioPackageError);
      putGraphFile(mirror, relative, bytes);
      studioFileBytes(path.join(mirror, relative), row.bytes, row.sha256, studioPackageError);
    }
    for (const [relative, destination] of links) {
      studioLinkTarget(path.join(donor, relative), path.join(donor, destination), studioPackageError);
      const link = path.join(mirror, relative);
      const target = path.join(mirror, destination);
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(target, link, 'junction');
      studioLinkTarget(link, target, studioPackageError);
    }
  } catch {
    requireThat(false, studioPackageError);
  }
}

const studioHtml = [
  '<!doctype html>', '<html lang="zh-CN">', '<head>', '<meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>橙子创作中心 · Studio</title>', '</head>', '<body>', '<div id="studio-root"></div>',
  '<script type="module">import "@orange-studio-entry";</script>', '</body>', '</html>', '',
].join('\n');

export function verifyStudioRendererResult(output, expected) {
  requireThat(keysAre(output, ['builds', 'studioAssetReferences']) && Array.isArray(output.builds) && output.builds.length === 2, studioGraphError);
  for (const [index, actual] of output.builds.entries()) {
    const { track, graphSha256, modules, chunkModules, artifacts } = expected.builds[index];
    requireThat(keysAre(actual, ['track', 'graphSha256', 'edgeSha256', 'modules', 'chunkModules', 'artifacts', 'reactRoots'])
      && actual.track === track && actual.graphSha256 === graphSha256 && digestPattern.test(actual.edgeSha256)
      && (!expected.runtimeSource || actual.edgeSha256 === expected.builds[index].edgeSha256)
      && actual.modules === modules && actual.chunkModules === chunkModules
      && isDeepStrictEqual(actual.reactRoots, { react: 1, 'react-dom': 1 }), studioGraphError);
    requireThat(isDeepStrictEqual(actual.artifacts, artifacts), studioArtifactError);
  }
  requireThat(isDeepStrictEqual(output.studioAssetReferences, expected.studioAssetReferences), studioArtifactError);
  return output;
}

export function runStudioRendererGraph(inputs, orange, upstream, staticProof) {
  const { scratch, donor, profile, manifest } = inputs;
  requireThat(process.platform === 'win32' && process.arch === 'x64' && process.version === 'v24.22.1', studioRuntimeError);
  const executable = realpathSync.native(process.execPath);
  studioFileBytes(executable, 93_713_712, studioNodeSha, studioRuntimeError, null);
  // Same physical Windows anchor as the legacy trusted tool check. The
  // caller's SystemRoot/WINDIR/PATH never choose DLL or executable roots.
  const system32 = canonicalGraphPath('C:/Windows/System32', true, studioRuntimeError);
  const windows = path.dirname(system32);
  ensureStudioScratch(scratch);
  const workspace = mkdtempSync(path.join(scratch, 'orange-studio-c1-'));
  try {
    const authRoot = path.join(workspace, 'auth');
    const studioRoot = path.join(workspace, 'studio', 'page');
    for (const name of studioAuthFiles.filter(name => name !== studioContract || orange.has(name))) putGraphFile(authRoot, name.slice('apps/desktop/'.length), orange.get(name));
    putGraphFile(studioRoot, 'probe.tsx', orange.get(studioProbe));
    putGraphFile(studioRoot, 'adapter.tsx', orange.get(adapter));
    putGraphFile(studioRoot, 'index.html', studioHtml);
    for (const [name, bytes] of upstream) putGraphFile(studioRoot, 'source/' + name, bytes);
    const mirror = path.join(workspace, 'deps');
    stageStudioPackages(donor, mirror, manifest);
    putGraphFile(workspace, 'input.json', JSON.stringify({
      activeSources: profile.fixedUpstream.closure.filter(({ active }) => active).map(({ path }) => path),
      packages: manifest.packages.map(({ id, physical, files }) => ({ id, physical, files: files.map(({ path }) => path) })),
      links: manifest.links,
    }));
    const isolated = path.join(workspace, 'home');
    mkdirSync(isolated);
    const worker = realpathSync.native(fileURLToPath(import.meta.url));
    const program = 'import { compileStudioRendererGraph } from ' + JSON.stringify(pathToFileURL(worker).href) + ';'
      + 'try { console.log(JSON.stringify(await compileStudioRendererGraph(process.argv[1]))); }'
      + 'catch (e) { console.log(JSON.stringify({code: e.gateCode ?? "STUDIO_C1_BUILD_FAILED"})); process.exitCode = 1; }';
    const child = spawnSync(executable, ['--no-global-search-paths', '--input-type=module', '-e', program, workspace], {
      cwd: workspace, windowsHide: true, encoding: 'utf8', timeout: 120_000, maxBuffer: 128 * 1024,
      env: { SystemRoot: windows, WINDIR: windows, PATH: system32,
        USERPROFILE: isolated, HOME: isolated, APPDATA: isolated, LOCALAPPDATA: isolated, TEMP: isolated, TMP: isolated },
    });
    requireThat(!child.error && child.signal === null && child.stdout, studioBuildError);
    let output;
    try { output = JSON.parse(child.stdout); } catch { requireThat(false, studioBuildError); }
    requireThat(child.status === 0, [studioGraphError, studioArtifactError].includes(output.code) ? output.code : studioBuildError);
    verifyStudioRendererResult(output, profile);
    const { base, head, tree } = inputs.subject;
    return {
      mode: 'studio-c1-dual-renderer', base, head, tree,
      source: { commit: profile.fixedUpstream.head, tree: profile.fixedUpstream.tree, objects: upstream.size,
        closureSha256: graphHash(JSON.stringify(profile.fixedUpstream.closure)) },
      inputSha256: graphHash(JSON.stringify(profile.inputs)), staticProof,
      lockSha256: studioLockSha, ...(inputs.pins ?? (profile.runtimeSource ? studioRendererPins : legacyStudioRendererPins)),
      ...(profile.runtimeSource && { ordinaryStudio: true, runtimeSource: profile.runtimeSource }), nodeSha256: studioNodeSha, system32, vite: '8.3.6', tailwind: '4.3.3',
      artifactSha256: graphHash(JSON.stringify(output.builds.map(({ track, artifacts }) => [track, artifacts]))),
      ...output,
    };
  } finally {
    const physical = realpathSync.native(workspace);
    requireThat(physical === workspace && path.dirname(physical) === scratch
      && path.basename(physical).startsWith('orange-studio-c1-'), studioPathError);
    rmSync(physical, { recursive: true });
  }
}

// Fixed child recipe. Only the runner-created fresh mirror is consumed here.
export async function compileStudioRendererGraph(workspace) {
  const win = (value) => value.replaceAll('\\', '/');
  const join = (...parts) => win(path.join(...parts));
  const input = JSON.parse(text(readFileSync(path.join(workspace, 'input.json'))));
  const capsule = join(workspace, 'deps');
  const links = new Map(input.links.map(({ path: name, target }) => [name, target]));
  const packages = new Map(input.packages.map(({ physical, id, files }) =>
    [join(capsule, physical), { id, files: new Set(files) }]));
  const pkg = (name) => {
    const target = links.get('apps/desktop/node_modules/' + name);
    requireThat(target && packages.has(join(capsule, target)), studioPackageError);
    return join(capsule, target);
  };
  const authRoot = join(workspace, 'auth', 'renderer');
  const studioRoot = join(workspace, 'studio', 'page');
  const ui = join(studioRoot, 'source', studioUi);
  const react = pkg('react');
  const dom = pkg('react-dom');
  const lucide = pkg('lucide-react');
  const vite = pkg('vite');
  const tailwind = pkg('tailwindcss');
  const tailwindPlugin = pkg('@tailwindcss/vite');
  const fonts = pkg('@fontsource-variable/inter');
  const schedulerTarget = links.get(path.posix.dirname(links.get('apps/desktop/node_modules/react-dom')) + '/scheduler');
  const scheduler = schedulerTarget && join(capsule, schedulerTarget);
  requireThat(packages.has(scheduler), studioPackageError);
  const packageJson = (directory) => JSON.parse(text(readFileSync(join(directory, 'package.json'))));
  requireThat(packageJson(vite).version === '8.3.6' && packageJson(tailwindPlugin).version === '4.3.3'
    && packageJson(tailwind).version === '4.3.3', studioPackageError);
  const { build } = await import(pathToFileURL(join(vite, 'dist/node/index.js')).href);
  const tailwindExport = packageJson(tailwindPlugin).exports['.'].default;
  const tailwindEntry = typeof tailwindExport === 'string' ? tailwindExport : tailwindExport.default;
  requireThat(tailwindEntry.startsWith('./')
    && packages.get(tailwindPlugin).files.has(tailwindEntry.slice(2)), studioPackageError);
  const tw = (await import(pathToFileURL(join(tailwindPlugin, tailwindEntry)).href)).default;
  const alias = (find, replacement) => ({ find, replacement });
  const commonAliases = [alias('react', react), alias('react-dom', dom), alias('scheduler', scheduler)];
  const activeSources = new Set(input.activeSources);
  let studioAssetReferences;
  const results = [];
  for (const track of ['auth', 'studio']) {
    const studio = track === 'studio';
    const root = studio ? studioRoot : authRoot;
    const browserRoots = [react, dom, scheduler, ...(studio ? [lucide] : [])];
    const approvedEntries = new Set(studio
      ? ['index.html', 'index.html?html-proxy&index=0.js', 'probe.tsx', 'adapter.tsx',
        ...input.activeSources.map((name) => 'source/' + name)]
      : ['index.html', 'main.tsx', 'App.tsx', 'startup.css']);
    function moduleName(raw) {
      if (!studio && win(raw) === join(path.dirname(root), 'studio-contract.ts')) return 'src/studio-contract.ts';
      if (!studio && raw === polyfill) return 'vite-internal/modulepreload-polyfill.js';
      const id = win(raw);
      if (id.startsWith(root + '/')) {
        const relative = id.slice(root.length + 1);
        if (approvedEntries.has(relative)) return 'src/' + relative;
      }
      for (const prefix of browserRoots) {
        if (id.startsWith(prefix + '/')) {
          const relative = id.slice(prefix.length + 1);
          const record = packages.get(prefix);
          if (record.files.has(relative)) return 'npm/' + record.id + '/' + relative;
        }
      }
      requireThat(false, studioGraphError);
    }
    const plugins = studio ? [{
      name: 'orange-c1-closed-styles', enforce: 'pre',
      transform(code, id) {
        if (win(id) !== join(ui, 'globals.css')) return;
        const original = "@import 'tailwindcss';";
        requireThat(code.startsWith(original), studioGraphError);
        return code.replace(original, "@import 'tailwindcss' source(none);\n@source \".\";");
      },
    }, tw()] : [];
    let graph;
    let failure;
    const check = (condition, code) => {
      if (!condition) failure = code;
      requireThat(condition, code);
    };
    const moduleNameChecked = (id) => {
      try { return moduleName(id); } catch { check(false, studioGraphError); }
    };
    const observer = {
      name: 'orange-c1-observer-' + track, enforce: 'pre',
      configResolved(config) {
        check(!config.configFile && !config.envDir && !config.publicDir && win(config.root) === root
          && isDeepStrictEqual(config.env, { BASE_URL: './', MODE: 'production', DEV: false, PROD: true }), studioGraphError);
      },
      resolveId(source, importer) {
        if (importer) check(!prohibitedGraphImport(source) && !/^\/\//.test(source)
          && (!/^[a-z][a-z\d+.-]*:/i.test(source) || path.isAbsolute(source)), studioGraphError);
      },
      load(id) { moduleNameChecked(id); },
      generateBundle(_options, bundle) {
        const chunks = Object.values(bundle).filter(({ type }) => type === 'chunk');
        check(chunks.length === 1 && chunks[0].isEntry && chunks[0].imports.length === 0
          && chunks[0].dynamicImports.length === 0, studioGraphError);
        const ids = [...this.getModuleIds()];
        const names = new Map(ids.map((id) => [id, moduleNameChecked(id)]));
        check(new Set(names.values()).size === ids.length, studioGraphError);
        const normalized = [...names.values()].sort(compare);
        const closure = normalized.filter((id) => id.startsWith('src/source/')).map((id) => id.slice('src/source/'.length));
        check(!studio || closure.length === activeSources.size && closure.every((name) => activeSources.has(name)), studioGraphError);
        const roots = Object.fromEntries(['react', 'react-dom'].map((name) => [name,
          new Set(normalized.filter((id) => id.startsWith('npm/' + name + '@')).map((id) => id.split('/')[1])).size]));
        check(roots.react === 1 && roots['react-dom'] === 1 && [
          'npm/react@19.3.1/cjs/react.production.js',
          'npm/react@19.3.1/cjs/react-jsx-runtime.production.js',
          'npm/react-dom@19.3.1/cjs/react-dom-client.production.js',
        ].every((id) => normalized.includes(id)), studioGraphError);
        const edges = ids.map((id) => {
          const info = this.getModuleInfo(id);
          check(info && !info.isExternal && [...info.importedIds, ...info.dynamicallyImportedIds].every((edge) => names.has(edge)), studioGraphError);
          return [names.get(id), info.importedIds.map((edge) => names.get(edge)).sort(compare),
            info.dynamicallyImportedIds.map((edge) => names.get(edge)).sort(compare)];
        }).sort(([a], [b]) => compare(a, b));
        graph = { graphSha256: graphHash(JSON.stringify(normalized)), edgeSha256: graphHash(JSON.stringify(edges)),
          modules: ids.length, chunkModules: Object.keys(chunks[0].modules).length, reactRoots: roots };
      },
    };
    let result;
    try {
      result = await build({
        configFile: false, envDir: false, publicDir: false, root, base: './', mode: 'production', logLevel: 'silent',
        cacheDir: join(workspace, 'cache', track), css: { postcss: { plugins: [] } },
        oxc: { jsx: { runtime: 'automatic' } },
        resolve: {
          tsconfigPaths: false, alias: studio ? [
            alias('@orange-studio-entry', join(root, 'probe.tsx')),
            alias('@orange/film-adapter/renderer', join(root, 'adapter.tsx')),
            alias('@orange-studio-upstream', ui), alias(/^@\//, ui + '/'),
            alias('tailwindcss', join(tailwind, 'index.css')), alias('@fontsource-variable/inter', join(fonts, 'index.css')),
            alias('react', react), alias('react-dom', dom), alias('lucide-react', lucide), alias('scheduler', scheduler),
          ] : commonAliases,
        },
        plugins: [...plugins, observer],
        build: {
          write: false, outDir: join(workspace, 'output', track),
          ...(studio && {
            target: 'es2022', modulePreload: false, assetsInlineLimit: 0,
            rolldownOptions: { input: join(root, 'index.html'), output: { entryFileNames: 'assets/studio-[hash].js' } },
          }),
        },
      });
    } catch {
      requireThat(false, failure ?? studioBuildError);
    }
    // Inspect returned final bytes, after all plugin hooks, not generateBundle's
    // earlier object nor a product-supplied artifact receipt.
    const rolls = Array.isArray(result) ? result : [result];
    requireThat(graph && rolls.length === 1 && Array.isArray(rolls[0].output), studioGraphError);
    const artifacts = [];
    const emitted = rolls[0].output;
    requireThat(emitted.length === (studio ? 10 : 3), studioArtifactError);
    const fontsEmitted = [];
    let stylesheets = 0, htmls = 0, scripts = 0;
    for (const item of emitted) {
      const name = item.fileName;
      const bytes = Buffer.from(item.type === 'chunk' ? item.code : item.source);
      if (item.type === 'chunk') {
        requireThat(item.isEntry && !item.imports.length && !item.dynamicImports.length
          && (studio ? /^assets\/studio-[A-Za-z0-9_-]+\.js$/ : /^assets\/index-[A-Za-z0-9_-]+\.js$/).test(name), studioGraphError);
        scripts++;
      } else if (name === 'index.html') {
        htmls++;
      } else if (/^assets\/index-[A-Za-z0-9_-]+\.css$/.test(name)) {
        stylesheets++;
        const css = text(bytes);
        requireThat(!/@import\b/i.test(css), studioArtifactError);
        const references = [...css.matchAll(/url\((?:"([^"]*)"|'([^']*)'|([^\s)]+))\)/g)].map((match) =>
          match[1] ?? match[2] ?? match[3]);
        requireThat(studio ? references.length === 8 : references.length === 0 && !/url\s*\(/i.test(css), studioArtifactError);
        if (studio) studioAssetReferences = references.map((url) => url.startsWith('data:image/svg+xml,')
          ? 'inline:' + graphHash(url) : url);
      } else {
        requireThat(studio && /^assets\/inter-[A-Za-z0-9_-]+\.woff2$/.test(name)
          && bytes.subarray(0, 4).equals(Buffer.from('wOF2')), studioArtifactError);
        fontsEmitted.push('./' + path.posix.basename(name));
      }
      artifacts.push({ name, bytes: bytes.length, sha256: graphHash(bytes) });
    }
    requireThat(stylesheets === 1 && htmls === 1 && scripts === 1 && (!studio || fontsEmitted.length === 7
      && studioAssetReferences.filter((url) => url.startsWith('inline:')).length === 1
      && fontsEmitted.every((font) => studioAssetReferences.includes(font))), studioArtifactError);
    results.push({ track, ...graph, artifacts: artifacts.sort((a, b) => compare(a.name, b.name)) });
  }
  return { builds: results, studioAssetReferences };
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
