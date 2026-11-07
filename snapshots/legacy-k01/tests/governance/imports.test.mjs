import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readTree, runRendererGraph, verifyRendererGraph } from '../../tools/ci/check-imports.mjs';

const gate = fileURLToPath(new URL('../../tools/ci/check-imports.mjs', import.meta.url));
function run(files, compiler) {
  const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'orange-imports-test-'));
  const cwd = path.join(root, 'repo');
  function git(...args) {
    return execFileSync('git', [
      '-c', 'user.name=Gate Test Fixture', '-c', 'user.email=gate-test@example.invalid',
      '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', '-C', cwd, ...args,
    ], { encoding: 'utf8', windowsHide: true }).trim();
  }
  try {
    mkdirSync(cwd);
    git('init', '-q');
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(cwd, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    git('add', '--', ...Object.keys(files));
    git('commit', '-qm', 'imports fixture');
    const configured = typeof compiler === 'function' ? compiler(root, cwd, git) : compiler;
    const args = configured === undefined ? [] : ['--trusted-typescript', configured];
    const result = spawnSync(process.execPath, [gate, '--head', git('rev-parse', 'HEAD'), ...args],
      { cwd, encoding: 'utf8', windowsHide: true });
    assert.ok(result.stdout, 'imports gate must report a decision: ' + result.stderr);
    return { status: result.status, report: JSON.parse(result.stdout), executed: existsSync(path.join(root, 'executed')) };
  } finally {
    assert.equal(realpathSync.native(root), root);
    rmSync(root, { recursive: true, force: true });
  }
}
const app = 'apps/desktop/renderer/App.tsx';
const vendor = 'vendor/openfilm/entry.ts';
const adapter = 'packages/film-adapter/src/renderer.tsx';

test('checks resolved module and output closure and physical React singletons', () => {
  const scratch = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'orange-graph-check-test-'));
  const root = path.join(scratch, 'mirror');
  function module(name, directory = root) {
    const id = path.join(directory, name);
    mkdirSync(path.dirname(id), { recursive: true });
    writeFileSync(id, '');
    return { id, imports: [], dynamicImports: [] }; // No isExternal flag: closure must still be proven.
  }
  try {
    const modules = [
      module('apps/desktop/renderer/index.html'), module('apps/desktop/renderer/main.tsx'),
      module(app), module('node_modules/react/index.js'), module('node_modules/react-dom/index.js'),
    ];
    const chunks = [{ fileName: 'main.js', imports: [], dynamicImports: [] }];
    modules[0].imports.push(modules[1].id);
    assert.deepEqual(verifyRendererGraph(root, { modules, chunks }).reactRoots, { react: 1, 'react-dom': 1 });
    assert.throws(() => verifyRendererGraph(root, {
      modules, chunks: [{ ...chunks[0], dynamicImports: ['external.js'] }],
    }), { gateCode: 'GRAPH_EXTERNAL_EDGE' });
    assert.throws(() => verifyRendererGraph(root, {
      modules: [...modules, { ...module('node_modules/scheduler/extra.js'), imports: ['missing-node'] }], chunks,
    }), { gateCode: 'GRAPH_CLOSURE_OPEN' });
    assert.throws(() => verifyRendererGraph(root, {
      modules: [...modules, module('outside.js', scratch)], chunks,
    }), { gateCode: 'GRAPH_OUTSIDE_MIRROR' });
    assert.throws(() => verifyRendererGraph(root, {
      modules: [...modules, module('apps/desktop/renderer/private/node_modules/react/index.js')], chunks,
    }), { gateCode: 'GRAPH_REACT_ROOTS' });
  } finally {
    assert.equal(realpathSync.native(scratch), scratch);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('renderer may consume React and local renderer code without executing it', () => {
  const result = run({
    [app]: "import React from 'react'; import './Local'; const url = 'https://example.invalid'; throw Error('not executed');",
    'apps/desktop/renderer/Local.ts': 'export const value = 1;',
  });
  assert.equal(result.status, 0);
  assert.equal(result.report.code, 'IMPORT_PREFLIGHT_PASSED');
});

test('blocks direct, dynamic, escaped and transitive renderer access to privileged modules', () => {
  for (const [files, code] of [
    [{ [app]: "export { readFile } from 'node:fs';" }, 'IMPORT_PRIVILEGED'],
    [{ [app]: "const m = import(/* no escape */ 'electron');" }, 'IMPORT_PRIVILEGED'],
    [{ [app]: "import { readFile } from 'n\\u006fde:fs';" }, 'IMPORT_PRIVILEGED'],
    [{ [app]: "const m = import(name);" }, 'IMPORT_UNRESOLVED'],
    [{ [app]: "import '../preload/index';", 'apps/desktop/preload/index.ts': 'export const a = 1;' }, 'IMPORT_BOUNDARY'],
  ]) {
    const result = run(files);
    assert.equal(result.status, 1);
    assert.ok(result.report.violations.some((violation) => violation.code === code));
  }
});

test('blocks vendor reverse dependencies and cycles', () => {
  const result = run({
    [vendor]: "import '../../packages/film-adapter/src/renderer'; import './side';",
    'vendor/openfilm/side.ts': "import './entry';",
    [adapter]: 'export const adapter = 1;',
  });
  assert.equal(result.status, 1);
  assert.ok(result.report.violations.some(({ code }) => code === 'IMPORT_VENDOR_REVERSE'));
  assert.ok(result.report.violations.some(({ code }) => code === 'IMPORT_CYCLE'));
});

test('blocks vendor reverse dependencies through Windows package-scope aliases', () => {
  for (const name of ['@orange/film-adapter', '@Orange/film-adapter', '@ORANGE/film-adapter/renderer']) {
    const result = run({ [vendor]: "import '" + name + "';" });
    assert.equal(result.status, 1, name);
    assert.ok(result.report.violations.some(({ code }) => code === 'IMPORT_VENDOR_REVERSE'), name);
  }
});

test('requires the exact allowed renderer package entry, not a case alias', () => {
  const files = { [adapter]: 'export const adapter = 1;' };
  assert.equal(run({ ...files, [app]: "import '@orange/film-adapter/renderer';" }).status, 0);
  const result = run({ ...files, [app]: "import '@Orange/film-adapter/renderer';" });
  assert.equal(result.status, 1);
  assert.ok(result.report.violations.some(({ code }) => code === 'IMPORT_UNRESOLVED'));
});

test('only the dedicated adapter renderer entry may cross the vendor boundary', () => {
  const result = run({
    [app]: "import '../../../vendor/openfilm/entry';",
    [vendor]: 'export const value = 1;',
  });
  assert.equal(result.status, 1);
  assert.ok(result.report.violations.some(({ code }) => code === 'IMPORT_BOUNDARY'));
});

test('fails closed on Windows aliases of protected directory names', () => {
  const result = run({ 'apps/desktop/Renderer/Entry.ts': "import 'node:fs';" });
  assert.equal(result.status, 1);
  assert.ok(result.report.violations.some(({ code }) => code === 'IMPORT_PATH_ALIAS'));
});

test('fails closed on unsupported JSX and escaped identifiers instead of missing privileged imports', () => {
  for (const source of [
    "const x = <span>https://{import('node:fs')}</span>;",
    "const fs = requ\\u0069re('node:fs');",
  ]) {
    const result = run({ [app]: source });
    assert.equal(result.status, 1);
    assert.ok(result.report.violations.some(({ code }) => code === 'IMPORT_SYNTAX_UNSUPPORTED'));
  }
});

test('a JS Unicode line terminator does not extend a line comment past an import', () => {
  const result = run({ [app]: "// comment\u2028import 'node:fs';" });
  assert.equal(result.status, 1);
  assert.ok(result.report.violations.some(({ code }) => code === 'IMPORT_PRIVILEGED'));
});

test('an explicitly selected unavailable or wrong-digest parser never executes or falls back', () => {
  const sources = { [app]: "import React from 'react';" };
  for (const makeCompiler of [
    (root) => path.join(root, 'missing.js'),
    (root) => {
      const file = path.join(root, 'fake.js');
      const payload = "require('node:fs').writeFileSync('../executed', 'bad parser');";
      writeFileSync(file, payload.padEnd(9_112_572)); // Same length as the pinned artifact, wrong digest.
      return file;
    },
  ]) {
    const result = run(sources, makeCompiler);
    assert.equal(result.executed, false);
    assert.equal(result.status, 1);
    assert.equal(result.report.code, 'IMPORT_PARSER_UNTRUSTED');
  }
});

const compiler = process.env.ORANGE_TEST_TRUSTED_TYPESCRIPT;
const authRoot = process.env.ORANGE_TEST_AUTH_GRAPH_SOURCE;
const graphCandidateOid = '1fc7f7675f426714bbe49c519269c4d9782f99ce';
const legacyGraphOid = 'd1759a63e8dc9405daf9cc0caa288fefca4a453a';
const authPath = 'apps/desktop/auth-contract.ts';
const authType = "import type { AuthState } from '../auth-contract.ts';";
const authBlob = () => execFileSync('git', ['--no-replace-objects', '--no-optional-locks',
  '-c', 'safe.directory=' + authRoot.replaceAll('\\', '/'), '-C', authRoot, 'cat-file', 'blob', graphCandidateOid + ':' + authPath],
{ windowsHide: true });

test('Auth G1 permits only the canonical pinned whole-declaration type import', {
  skip: !(compiler && authRoot) && 'requires the approved parser and local immutable Auth blobs',
}, () => {
  const bytes = authBlob();
  assert.equal(run({ [app]: authType, [authPath]: bytes }, compiler).status, 0);
  for (const [file, source, contract] of [
    [app, "import { AuthState } from '../auth-contract.ts';", bytes],
    [app, "import { type AuthState } from '../auth-contract.ts';", bytes],
    [app, "import { type AuthState, runtime } from '../auth-contract.ts';", bytes],
    [app, "export type { AuthState } from '../auth-contract.ts';", bytes],
    [app, "type A = import('../auth-contract.ts').AuthState;", bytes],
    [app, "void import('../auth-contract.ts');", bytes],
    [app, "const A = require('../auth-contract.ts');", bytes],
    [app, authType.replace('../auth-contract.ts', '.././auth-contract.ts'), bytes],
    [app, authType.replace('auth-contract', '\\u0061uth-contract'), bytes],
    [app, authType + authType, bytes],
    [app, authType, Buffer.concat([bytes, Buffer.from('\n')])],
    ['apps/desktop/renderer/other.tsx', authType, bytes],
  ]) assert.equal(run({ [file]: source, [authPath]: contract }, compiler).status, 1, source);
  assert.equal(run({ [app]: authType, [authPath]: bytes }).status, 1, 'lexical parser gets no exception');
  assert.equal(run({ [app]: authType, [authPath]: bytes }, (_scratch, _cwd, git) => {
    const alias = 'apps/Desktop/other.ts';
    git('-c', 'core.ignorecase=false', 'update-index', '--add', '--cacheinfo',
      '100644,' + git('rev-parse', 'HEAD:' + authPath) + ',' + alias);
    git('commit', '-qm', 'auth ancestor alias fixture');
    assert.ok(git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').includes(alias));
    return compiler;
  }).status, 1);
});

const authGraph = process.env.ORANGE_TEST_AUTH_GRAPH_PROFILE;
const legacyGraph = process.env.ORANGE_TEST_GRAPH_PROFILE;
const graphToolchain = process.env.ORANGE_TEST_GRAPH_TOOLCHAIN;
const graphRenderer = process.env.ORANGE_TEST_GRAPH_RENDERER;
const graphModules = process.env.ORANGE_TEST_AUTH_GRAPH_NODE_MODULES;
test('Auth G1 live Vite admits only the exact separate stylesheet profile and preserves legacy', {
  skip: !(authRoot && authGraph && legacyGraph && graphToolchain && graphRenderer && graphModules)
    && 'requires approved local Vite, dependency and renderer profile artifacts',
}, (t) => {
  const scratch = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'orange-auth-graph-test-'));
  const flags = { '--trusted-vite-manifest': graphToolchain, '--trusted-renderer-manifest': graphRenderer,
    '--trusted-node-modules': graphModules, '--graph-scratch': scratch, '--trusted-renderer-profile': legacyGraph };
  try {
    const legacy = readTree(authRoot, legacyGraphOid);
    const actual = readTree(authRoot, graphCandidateOid);
    const old = runRendererGraph(authRoot, legacy, flags);
    assert.deepEqual(old.reactRoots, { react: 1, 'react-dom': 1 });
    t.diagnostic('legacy live graph: ' + JSON.stringify(old));
    assert.throws(() => runRendererGraph(authRoot, actual, flags), { gateCode: 'GRAPH_PROFILE_UNAVAILABLE' });
    t.diagnostic('Auth with exact old profile: GRAPH_PROFILE_UNAVAILABLE');
    flags['--trusted-renderer-profile'] = authGraph;
    const built = runRendererGraph(authRoot, actual, flags);
    assert.deepEqual(built.reactRoots, { react: 1, 'react-dom': 1 });
    assert.equal(built.stylesheets, 1);
    assert.notEqual(built.profileSha256, old.profileSha256);
    t.diagnostic('Auth live graph: ' + JSON.stringify(built));
    const css = 'apps/desktop/renderer/startup.css';
    for (const name of ['apps/desktop/renderer/extra.css', 'apps/desktop/renderer/extra.tsx', 'apps/Desktop/other.ts']) {
      assert.throws(() => runRendererGraph(authRoot, new Map([...actual, [name, actual.get(css)]]), flags),
        { gateCode: 'GRAPH_PROFILE_UNAVAILABLE' });
    }
    assert.throws(() => runRendererGraph(authRoot, new Map([...actual, [css, actual.get(app)]]), flags),
      { gateCode: 'GRAPH_PROFILE_UNAVAILABLE' });
    const mutated = path.join(scratch, 'changed-profile.json');
    writeFileSync(mutated, Buffer.concat([readFileSync(authGraph), Buffer.from('\n')]));
    assert.throws(() => runRendererGraph(authRoot, actual, { ...flags, '--trusted-renderer-profile': mutated }),
      { gateCode: 'GRAPH_PROFILE_UNTRUSTED' });
  } finally {
    assert.equal(realpathSync.native(scratch), scratch);
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('pinned TypeScript preflight', { skip: !compiler && 'A-only run: no explicit offline compiler fixture' }, () => {
  test('parses JSX without executing source or claiming product admission', () => {
    const result = run({
      [app]: "import React from 'react'; export const View = () => <span>https://safe.invalid</span>; throw Error('not executed');",
    }, compiler);
    assert.equal(result.status, 0);
    assert.equal(result.report.admitted, false);
    assert.deepEqual(result.report.importParser, {
      engine: 'typescript', version: '5.9.3',
      sha256: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675',
    });
  });

  test('rejects privileged static, dynamic and escaped calls inside parsed JSX', () => {
    for (const source of [
      "import 'n\\u006fde:fs'; export const view = <div />;",
      "const view = <span>https://{import('node:fs')}</span>;",
      "const view = <div>{requ\\u0069re('electron')}</div>;",
    ]) {
      const result = run({ [app]: source }, compiler);
      assert.equal(result.status, 1, source);
      assert.ok(result.report.violations?.some(({ code }) => code === 'IMPORT_PRIVILEGED'), source);
    }
  });

  test('rejects unknown expressions and malformed JSX instead of falling back', () => {
    for (const [source, reason] of [
      ["const view = <span>{import('node:' + name)}</span>;", 'IMPORT_UNRESOLVED'],
      ["const view = <span>{module['require']('node:fs')}</span>;", 'IMPORT_UNRESOLVED'],
      ["const view = <span>{import.meta.glob('./*')}</span>;", 'IMPORT_SYNTAX_UNSUPPORTED'],
      ["const view = <span>", 'IMPORT_SYNTAX_UNSUPPORTED'],
    ]) {
      const result = run({ [app]: source }, compiler);
      assert.equal(result.status, 1, source);
      assert.ok(result.report.violations?.some(({ code }) => code === reason), source);
    }
  });


  for (const [label, source] of [
    ['template property access', "export const view = <span>{globalThis[`require`]('node:fs')}</span>;"],
    ['parenthesized string concatenation', "export const view = <span>{globalThis[('requ' + 'ire')]('node:fs')}</span>;"],
    ['string-key destructuring', "const { 'require': load } = globalThis; export const view = <span>{load('node:fs')}</span>;"],
    ['escaped string-key destructuring', "const { 'requ\\u0069re': load } = globalThis; export const view = <span>{load('node:fs')}</span>;"],
    ['computed string-key destructuring', "const { ['require']: load } = globalThis; export const view = <span>{load('node:fs')}</span>;"],
    ['computed template-key destructuring', "const { [`require`]: load } = globalThis; export const view = <span>{load('node:fs')}</span>;"],
    ['computed assignment destructuring', "let load; ({ [('requ' + 'ire')]: load } = globalThis); export const view = <span>{load('node:fs')}</span>;"],
    ['nested assignment destructuring', "let load; ({ entries: [{ ['require']: load }] } = wrapper); export const view = <span>{load('node:fs')}</span>;"],
    ['unknown module loader key', "const key = getKey(); export const view = <span>{module[key]('node:fs')}</span>;"],
    ['unknown loader binding key', "const key = getKey(); const { [key]: load } = globalThis; export const view = <span>{load('node:fs')}</span>;"],
  ]) {
    test('rejects indirect require via ' + label, () => {
      const result = run({ [app]: source }, compiler);
      assert.equal(result.status, 1, source);
      assert.ok(result.report.violations?.some(({ code }) => code === 'IMPORT_UNRESOLVED'), source);
    });
  }

  test('does not interpret data strings and ordinary object declarations as loader access', () => {
    const result = run({
      [app]: "const examples = { ['require']: 'node:fs', label: 'require' }; export const view = <span>{examples.label}</span>;",
    }, compiler);
    assert.equal(result.status, 0);
    assert.deepEqual(result.report.violations, []);
  });


  for (const [label, file, source, reason] of [
    ['as receiver', app, "export const view = <span>{(globalThis as any)[getKey()]('node:fs')}</span>;", 'IMPORT_UNRESOLVED'],
    ['angle assertion receiver', 'apps/desktop/renderer/loader.ts', "export const view = (<any>module)[getKey()]('node:fs');", 'IMPORT_UNRESOLVED'],
    ['non-null receiver', app, "export const view = <span>{module![getKey()]('node:fs')}</span>;", 'IMPORT_UNRESOLVED'],
    ['satisfies receiver', app, "export const view = <span>{(globalThis satisfies typeof globalThis)[getKey()]('node:fs')}</span>;", 'IMPORT_UNRESOLVED'],
    ['nested wrapped key', app, "export const view = <span>{loader[((('requ' as string) + ('ire' satisfies string))!)]('node:fs')}</span>;", 'IMPORT_UNRESOLVED'],
    ['wrapped direct require', app, "export const view = <span>{((require as any)!)('node:fs' as string)}</span>;", 'IMPORT_PRIVILEGED'],
    ['wrapped direct dynamic argument', app, "export const view = <span>{(require!)(name as string)}</span>;", 'IMPORT_UNRESOLVED'],
    ['shorthand reference', app, "const data = { require }; export const view = <span>safe</span>;", 'IMPORT_UNRESOLVED'],
    ['explicit property value reference', app, "const data = { require: require }; export const view = <span>safe</span>;", 'IMPORT_UNRESOLVED'],
    ['identifier-key assignment pattern', app, "let load; ({ require: load } = globalThis); export const view = <span>{load('node:fs')}</span>;", 'IMPORT_UNRESOLVED'],
  ]) {
    test('AST-role: rejects ' + label, () => {
      const result = run({ [file]: source }, compiler);
      assert.equal(result.status, 1, source);
      assert.ok(result.report.violations?.some(({ code }) => code === reason), source);
    });
  }

  test('AST-role: accepts the same permitted module through transparent syntax', () => {
    const result = run({ [app]: "export const view = <span>{((require as any)!)('react' as const)}</span>;" }, compiler);
    assert.equal(result.status, 0);
    assert.deepEqual(result.report.violations, []);
  });

  test('AST-role: accepts a non-computed identifier property declaration as data', () => {
    const result = run({ [app]: "const examples = { require: 'node:fs' }; export const view = <span>safe</span>;" }, compiler);
    assert.equal(result.status, 0);
    assert.deepEqual(result.report.violations, []);
  });


  for (const [label, source] of [
    ['for-of', "let load; for ({ require: load } of [globalThis]) { load('node:fs'); } export const view = <span>example</span>;"],
    ['for-in', "let load; for ({ 'require': load } in keys) { load('node:fs'); } export const view = <span>example</span>;"],
    ['nested for-of', "let load; for ([{ [('requ' + 'ire')]: load }] of entries) { load('node:fs'); } export const view = <span>example</span>;"],
    ['wrapped outer assignment pattern', "let load; ({ outer: { require: load } } as any) = source; export const view = <span>example</span>;"],
    ['wrapped for-of pattern', "let load; for (({ require: load } as any) of entries) { load('node:fs'); } export const view = <span>example</span>;"],
    ['unknown key on a known assignment receiver', "let load; ({ [key]: load } = (module as any)); export const view = <span>example</span>;"],
  ]) {
    test('assignment-role: rejects loader extraction in ' + label, () => {
      const result = run({ [app]: source }, compiler);
      assert.equal(result.status, 1, source);
      assert.ok(result.report.violations?.some(({ code }) => code === 'IMPORT_UNRESOLVED'), source);
    });
  }

  test('assignment-role: ordinary object literals and default right sides remain data', () => {
    const result = run({
      [app]: "let value; ({ item: value = { require: 'node:fs' } } = source); const data = { require: 'node:fs' }; export const view = <span>example</span>;",
    }, compiler);
    assert.equal(result.status, 0);
    assert.deepEqual(result.report.violations, []);
  });

  test('rejects even pinned compiler bytes if supplied from inside the candidate tree', () => {
    const result = run({ [app]: "import React from 'react';" }, (_, cwd) => {
      const file = path.join(cwd, 'typescript.js');
      copyFileSync(compiler, file);
      return file;
    });
    assert.equal(result.status, 1);
    assert.equal(result.report.code, 'IMPORT_PARSER_UNTRUSTED');
  });
});
