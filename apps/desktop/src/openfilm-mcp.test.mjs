// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The MCP server as the agents meet it: a stdio JSON-RPC endpoint that starts cheaply, answers with structure when
 * nothing behind it is configured, refuses writes until this machine says otherwise, and leaves one audit line for
 * every write it does perform.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  AUDIT_FILE, BUDGET_SURFACE, COMPAT_SURFACE, DEFAULT_SURFACE, MATERIAL_TOOL_NAMES, SURFACE_CHANGES, TOOL_BUDGET,
  TOOL_DEFINITIONS, TOOL_SURFACES, WRITE_GATE_FILE, createOpenFilmMcpServer, openfilmMcpServerConfig, readWriteGate,
  serveStdio, surfaceArithmetic, writeFileAtomic,
} from './openfilm-mcp.mjs';
import { MATERIAL_TOOL_CAPS, MATERIAL_TOOL_CAPS_CONTRACT, planMaterialToolSurface } from '../../../packages/openfilm/src/material-tools.mjs';
import { applicationMenuTemplate } from './menu.mjs';

import { filmHtml } from '../../../packages/openfilm/src/film-doc.mjs';

/** A project whose film.html the editor itself wrote, so the fixture cannot drift from the format. */
const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'openfilm-mcp-'));
  writeFileSync(join(root, 'film.html'), filmHtml({ stage: { w: 1920, h: 1080 }, tracks: [{ clips: [{ id: 'a', src: 'assets/a.mp4' }] }] }));
  mkdirSync(join(root, 'assets'), { recursive: true });
  return root;
};
const homeWith = (gate) => {
  const home = mkdtempSync(join(tmpdir(), 'openfilm-mcp-home-'));
  mkdirSync(join(home, '.openfilm-dev'), { recursive: true });
  if (gate) writeFileSync(join(home, '.openfilm-dev', 'mcp-write.json'), JSON.stringify(gate));
  return home;
};
const auditLines = (home) => {
  try {
    return readFileSync(join(home, ...AUDIT_FILE), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
/**
 * An index on disk, in the shape `material-index-build.mjs` lands (`readMaterialIndex` reads exactly this: a JSON
 * object whose `index.batches` is a list). Written here instead of built so a test can make an index that is *bigger*
 * than the caps without a network call and without a 200 000-row fixture.
 */
const writtenIndex = ({ batches = 1, collections = 1, groups = 1, entries = 1 } = {}) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'openfilm-mcp-index-')), 'material-index');
  mkdirSync(dir, { recursive: true });
  const land = [];
  for (let b = 0; b < batches; b += 1) {
    const id = String(20261106 - b);
    const products = [];
    for (let c = 0; c < collections; c += 1) {
      const held = [];
      let count = 0;
      for (let g = 0; g < groups; g += 1) {
        const rows_ = Array.from({ length: entries }, (_, e) => ({ videoId: `${id}-${c}-${g}-${e}`, name: `素材 ${g}-${e}` }));
        held.push({ id: `g${g}`, name: `组${g}`, count: rows_.length, entries: rows_ });
        count += rows_.length;
      }
      products.push({ id: `${id}-合集${c}`, name: `合集${c}`, count, groups: held });
    }
    land.push({ id, name: id, count: products.reduce((sum, product) => sum + product.count, 0), products });
  }
  const videos = batches * collections * groups * entries;
  writeFileSync(join(dir, 'index.json'), JSON.stringify({
    schema: 'orange/material-index-build/1', generatedAt: '2026-11-16T00:00:00.000Z',
    sourceTotal: videos, videos, parsed: videos, unclassified: 0, warnings: [], index: { batches: land },
  }));
  return dir;
};
const call = async (server, name, args) => (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;

test('the handshake and the tool list are what an agent expects, before anything is configured', async () => {
  const server = createOpenFilmMcpServer({ cwd: tmpdir() });
  const hello = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } } });
  assert.equal(hello.result.protocolVersion, '2025-06-18');
  assert.equal(hello.result.serverInfo.name, 'openfilm');
  assert.deepEqual(hello.result.capabilities.tools, { listChanged: false });
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'a notification has no answer');

  const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = listed.result.tools.map((tool) => tool.name);
  /* the default surface is the budgeted five: the search beside the two index tools and the two write verbs */
  assert.deepEqual(names, [...BUDGET_SURFACE]);
  assert.deepEqual(names, ['library.search', 'material.search', 'material.collections', 'material.items', 'plan.create', 'plan.expand', 'plan.apply', 'plan.render', 'caption.write', 'timeline.check', 'dedupe.check', 'materials.take', 'timeline.insert_clip']);
  assert.equal(names.includes('material.batches'), false, 'its slot went to the search');
  for (const tool of listed.result.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
  }
  const unknown = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal(unknown.error.code, -32602);
});

test('nothing behind a tool is an answer, not a crash: no RPC, no material source, no look', async () => {
  /* the compat surface on purpose: these are the four read tools of the seven-name face, and what each says when the
     thing behind it was never configured on this machine */
  const server = createOpenFilmMcpServer({ cwd: project(), surface: 'compat', log: () => {} });
  for (const [name, args] of [['materials.search', { query: 'kitten' }], ['wiki.video', { videoId: 'v1' }], ['wiki.timeline', { videoId: 'v1' }], ['wiki.shot', { videoId: 'v1', index: 0 }], ['openfilm.look', {}]]) {
    const result = await call(server, name, args);
    assert.equal(result.isError ?? false, false, name + ' must not be reported as a failure');
    assert.equal(result.structuredContent.code, 'not-configured', name + ' says what is missing');
    assert.equal(result.structuredContent.ok, false);
  }
  const missing = await call(server, 'materials.search', {});
  assert.equal(missing.structuredContent.code, 'invalid-arguments');
});

test('a write without permission is refused before a byte is read, and leaves no audit line', async () => {
  const root = project();
  const before = readFileSync(join(root, 'film.html'), 'utf8');
  const home = homeWith(null);
  const server = createOpenFilmMcpServer({ cwd: root, home });
  const refused = await call(server, 'timeline.insert_clip', { src: 'assets/a.mp4', at: 1 });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.code, 'write-not-authorized');
  assert.equal(readFileSync(join(root, 'film.html'), 'utf8'), before, 'the file was not touched');
  assert.deepEqual(auditLines(home), [], 'nothing was audited because nothing was written');

  const elsewhere = homeWith({ version: 1, allowWrite: true, projects: [join(tmpdir(), 'some-other-project')] });
  const notListed = await call(createOpenFilmMcpServer({ cwd: root, home: elsewhere }), 'timeline.insert_clip', { src: 'assets/a.mp4', at: 1 });
  assert.equal(notListed.structuredContent.code, 'project-not-allowlisted', 'a project outside the allowlist is not written either');
  assert.equal(readFileSync(join(root, 'film.html'), 'utf8'), before);
});

test('with the project allowlisted the clip is written into film.html, and one audit line says so', async () => {
  const root = project();
  const home = homeWith({ version: 1, allowWrite: true, projects: [root] });
  const server = createOpenFilmMcpServer({ cwd: root, home });
  const written = await call(server, 'timeline.insert_clip', { src: 'assets/a.mp4', at: 2.5, track: 0 });
  assert.equal(written.isError ?? false, false);
  assert.equal(written.structuredContent.ok, true);
  const html = readFileSync(join(root, 'film.html'), 'utf8');
  assert.match(html, /<video[^>]*src="assets\/a\.mp4"[^>]*at="2\.5"/, 'the clip is in the film');
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.tmp')), [], 'no half file is left behind');
  const [line] = auditLines(home);
  assert.ok(line);
  assert.match(line, /\ttimeline\.insert_clip\t/);
  assert.match(line, /clipId=/);
  assert.ok(!line.includes(root + '\\assets') && !line.includes(root + '/assets'), 'the audit line holds no whole media path');
});

test('a write that fails mid-way leaves the film as it was and no temporary file', () => {
  const root = project();
  const file = join(root, 'film.html');
  const before = readFileSync(file, 'utf8');
  assert.throws(() => writeFileAtomic(join(root, 'nope', 'film.html'), 'x'), /ENOENT|no such file/i);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.tmp')), []);
});

test('taking a material puts its file in assets/ and answers the clip tag that uses it', async () => {
  const root = project();
  const home = homeWith({ version: 1, allowWrite: true, projects: [root] });
  const source = join(mkdtempSync(join(tmpdir(), 'openfilm-mcp-src-')), 'clip.mp4');
  writeFileSync(source, 'not really a video');
  const server = createOpenFilmMcpServer({ cwd: root, home, takeMaterial: async () => ({ source, name: 'clip.mp4' }) });
  const taken = await call(server, 'materials.take', { videoId: 'v1' });
  assert.equal(taken.isError ?? false, false);
  assert.equal(taken.structuredContent.path, 'assets/clip.mp4');
  assert.equal(readFileSync(join(root, 'assets', 'clip.mp4'), 'utf8'), 'not really a video');
  assert.match(taken.structuredContent.clipTag, /src="assets\/clip\.mp4"/);
  assert.match(auditLines(home)[0], /clipId=clip\.mp4/);
});

test('the write gate is exactly the file it says: absent, malformed, unallowed and allowed', () => {
  const root = project();
  const absent = readWriteGate({ home: homeWith(null), project: root });
  assert.equal(absent.allowed, false);
  assert.equal(absent.code, 'write-not-authorized');
  assert.ok(absent.file.endsWith(join('.openfilm-dev', 'mcp-write.json')), 'the file is the documented one');

  const home = homeWith(null);
  writeFileSync(join(home, '.openfilm-dev', 'mcp-write.json'), '{ not json');
  assert.equal(readWriteGate({ home, project: root }).allowed, false);

  const allowed = readWriteGate({ home: homeWith({ version: 1, allowWrite: true, projects: [root] }), project: root });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.code, 'write-authorized');

  const child = readWriteGate({ home: homeWith({ version: 1, allowWrite: true, projects: [root] }), project: join(root, 'assets') });
  assert.equal(child.allowed, true, 'a folder inside an allowed project is allowed');
  assert.equal(readWriteGate({ home: homeWith({ version: 1, allowWrite: false, projects: [root] }), project: root }).allowed, false);
  assert.equal(readWriteGate({ home: homeWith({ version: 1, allowWrite: true, projects: ['relative/path'] }), project: root }).allowed, false,
    'a relative allowlist entry allows nothing');
  assert.ok(WRITE_GATE_FILE.join('/').endsWith('.openfilm-dev/mcp-write.json'));
});

test('the agent is told to start the server with an absolute command and Electron as Node', () => {
  const config = openfilmMcpServerConfig({ command: process.execPath, script: '/abs/openfilm-mcp.mjs' });
  assert.equal(config.name, 'openfilm');
  assert.equal(config.command, process.execPath);
  assert.ok(config.command.startsWith('/') || /^[A-Za-z]:\\/.test(config.command), 'the command is an absolute path');
  assert.equal(config.args.at(-1), '/abs/openfilm-mcp.mjs');
  assert.deepEqual(config.env, [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }]);
  assert.throws(() => openfilmMcpServerConfig({ command: 'node', script: '/abs/x.mjs' }), /absolute/);

  const agents = readFileSync(new URL('./agents.mjs', import.meta.url), 'utf8');
  assert.match(agents, /mcpServers: \[openfilmMcpServer\(\)\]/, 'the session is offered the server');
  assert(!/mcpServers: \[\]/.test(agents), 'and no longer an empty list');
  assert.match(agents, /openfilmMcpServer = \(\) => openfilmMcpServerConfig\(\{ command: nodeBinary\(\), script: OPENFILM_MCP_SCRIPT/);
});

test('the stdio transport answers line-delimited JSON-RPC and survives silence', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(String(chunk)));
  const server = createOpenFilmMcpServer({ cwd: tmpdir() });
  const served = serveStdio({ handle: server.handle, input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  input.write('not json\n');
  input.end();
  await new Promise((resolve) => input.on('close', resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  served.close();
  const answers = chunks.join('').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(answers[0].result.serverInfo.name, 'openfilm');
  assert.equal(answers[1].error.code, -32700, 'a line that is not JSON is a parse error, not a crash');
});

test('a packaged build’s menu has nothing to do with this, and the tool list stays a list of plain objects', () => {
  const noop = () => {};
  const packaged = applicationMenuTemplate({
    productName: 'OpenFilm', packaged: true, language: 'en', toggleChat: noop, openProject: noop, reload: noop, devTools: noop,
    openSettings: noop, tabs: { open: noop, close: noop, reopen: noop, step: noop, pick: noop },
  });
  assert.equal(packaged.length > 0, true);
  /* the served surface is five, and the compat pool behind it still carries all seven definitions it ever had */
  assert.equal(BUDGET_SURFACE.length, 13, '检索四槽 + 剪辑七槽 + 取用与插入两槽');
  assert.equal(TOOL_SURFACES[DEFAULT_SURFACE].length, 13);
  assert.equal(TOOL_DEFINITIONS.length, 15, 'TOOL_DEFINITIONS 是池子（含 compat 旧名），不是窗口');
  assert.deepEqual([...TOOL_DEFINITIONS].map((tool) => tool.name), [...new Set(TOOL_DEFINITIONS.map((tool) => tool.name))]);
});

test('the default surface is the five slots, and compat is the whole way back to the seven', async () => {
  assert.equal(DEFAULT_SURFACE, 'materials');
  assert.deepEqual(Object.keys(TOOL_SURFACES), ['materials', 'compat']);

  const server = createOpenFilmMcpServer({ cwd: tmpdir(), log: () => {} });
  assert.equal(server.surface, 'materials', 'nothing has to be asked for');
  assert.equal(server.surfaceNames, TOOL_SURFACES.materials);
  const listed = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = listed.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [...BUDGET_SURFACE]);
  assert.deepEqual(names, ['library.search', 'material.search', 'material.collections', 'material.items', 'plan.create', 'plan.expand', 'plan.apply', 'plan.render', 'caption.write', 'timeline.check', 'dedupe.check', 'materials.take', 'timeline.insert_clip']);
  assert.equal(names.length, TOOL_BUDGET);

  /* an old name is not a quieter back door: unlisted is an error, not a call that works */
  const old = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wiki.video', arguments: { videoId: 'v1' } } });
  assert.equal(old.error.code, -32602);

  const compat = createOpenFilmMcpServer({ cwd: tmpdir(), surface: 'compat', log: () => {} });
  const wayBack = await compat.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const oldNames = wayBack.result.tools.map((tool) => tool.name);
  assert.deepEqual(oldNames, [...COMPAT_SURFACE]);
  assert.deepEqual(oldNames, ['library.search', 'plan.create', 'plan.apply', 'caption.write', 'timeline.check', 'plan.expand', 'dedupe.check', 'plan.render', 'materials.search', 'materials.take', 'wiki.video', 'wiki.timeline', 'wiki.shot', 'timeline.insert_clip', 'openfilm.look']);
  assert.equal(oldNames.length, 15, 'compat 是池子：旧七个 + 元素检索 + 剪辑链七个');
  const fresh = await compat.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'material.search', arguments: { query: '茶' } } });
  assert.equal(fresh.error.code, -32602, 'compat does not list the new names either: a surface is a whole face');
  /* and the name the search replaced is gone from both faces: it is not a compat name, it was a budget one */
  const replaced = await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'material.batches', arguments: {} } });
  assert.equal(replaced.error.code, -32602);

  /* a name that is not a surface falls back to the default — never to an empty list */
  const typo = createOpenFilmMcpServer({ cwd: tmpdir(), surface: 'material', log: () => {} });
  assert.equal(typo.surface, DEFAULT_SURFACE);
  assert.equal((await typo.listedTools()).length, 13);
});

test('an index that was never built is index-missing, not not-configured', async () => {
  const absent = join(mkdtempSync(join(tmpdir(), 'openfilm-mcp-noindex-')), 'material-index');
  const server = createOpenFilmMcpServer({ cwd: tmpdir(), materialIndexDir: absent, log: () => {} });
  for (const [name, args] of [['material.collections', {}], ['material.items', { collection: 'x' }]]) {
    const result = await call(server, name, args);
    assert.equal(result.isError ?? false, false, name + ' is a state, not a failure');
    assert.equal(result.structuredContent.ok, false);
    assert.equal(result.structuredContent.code, 'index-missing', name + ' names the missing index');
    assert.notEqual(result.structuredContent.code, 'not-configured', 'the module is there; the index is not');
    assert.equal(result.structuredContent.dir, absent);
    assert.match(result.structuredContent.message, /material-index-build\.mjs/);
  }

  /* the other code is reserved for the other thing: the module itself not being where the server looks */
  const before = process.env.OPENFILM_EDITOR_MODULES;
  process.env.OPENFILM_EDITOR_MODULES = mkdtempSync(join(tmpdir(), 'openfilm-mcp-nomodule-'));
  try {
    const bare = createOpenFilmMcpServer({ cwd: tmpdir(), log: () => {} });
    const result = await call(bare, 'material.collections', {});
    assert.equal(result.structuredContent.code, 'not-configured', 'no module is a different answer');
  } finally {
    if (before === undefined) delete process.env.OPENFILM_EDITOR_MODULES;
    else process.env.OPENFILM_EDITOR_MODULES = before;
  }
});

test('material.search answers what the search answered, and says not-configured when no tenant is set', async () => {
  /* no `OPENFILM_MEDIA_TENANT` on this machine: a state naming the setting, not an empty library */
  const before = process.env.OPENFILM_MEDIA_TENANT;
  delete process.env.OPENFILM_MEDIA_TENANT;
  try {
    const bare = createOpenFilmMcpServer({ cwd: tmpdir(), log: () => {} });
    const result = await call(bare, 'material.search', { query: '柠檬宝藏茶 外包装' });
    assert.equal(result.isError ?? false, false);
    assert.equal(result.structuredContent.code, 'not-configured');
    assert.match(result.structuredContent.message, /OPENFILM_MEDIA_TENANT/);
    const noQuery = await call(bare, 'material.search', {});
    assert.equal(noQuery.structuredContent.code, 'invalid-arguments');
  } finally {
    if (before === undefined) delete process.env.OPENFILM_MEDIA_TENANT;
    else process.env.OPENFILM_MEDIA_TENANT = before;
  }

  /* the injected seam is what a configured machine answers through — the same shape the route answers */
  /** @type {any[]} */
  const asked = [];
  const server = createOpenFilmMcpServer({
    cwd: tmpdir(),
    log: () => {},
    materialSearch: async (request) => {
      asked.push(request);
      return {
        mode: 'vector', query: request.query, count: 1,
        items: [{
          mediaKey: '129767966', videoId: '129767966', name: '20261106-柠檬宝藏茶200g罐-汤色 (8)', batch: '20261106',
          product: '柠檬宝藏茶200g罐', gname: '汤色', durationMs: 8400, score: 0.62, matchKind: 'vector',
          availability: { local: false },
        }],
      };
    },
  });
  const searched = await call(server, 'material.search', { query: '柠檬宝藏茶', batch: '20261106', group: '汤色', limit: 4 });
  assert.equal(searched.isError ?? false, false);
  assert.deepEqual(asked, [{ query: '柠檬宝藏茶', filters: { batch: '20261106', gname: '汤色' }, limit: 4 }]);
  assert.equal(searched.structuredContent.mode, 'vector');
  assert.equal(searched.structuredContent.count, 1);
  assert.equal(searched.structuredContent.items[0].videoId, '129767966');
  assert.deepEqual(searched.structuredContent.items[0].availability, { local: false });
});

test('a bigger index than the caps is cut at the caps and says truncated, it does not fail', async () => {
  const count = (payload, key) => payload.structuredContent[key].length;

  const many = createOpenFilmMcpServer({ cwd: tmpdir(), materialIndexDir: writtenIndex({ collections: 51 }), log: () => {} });
  const collections = await call(many, 'material.collections', {});
  assert.equal(count(collections, 'collections'), MATERIAL_TOOL_CAPS.collections, '50 of 51 collections');
  assert.equal(collections.structuredContent.truncated, true);

  const deep = writtenIndex({ groups: 201, entries: 2 });
  const server = createOpenFilmMcpServer({ cwd: tmpdir(), materialIndexDir: deep, log: () => {} });
  const grouped = await call(server, 'material.collections', {});
  assert.equal(grouped.structuredContent.collections[0].groups.length, MATERIAL_TOOL_CAPS.groupsPerCollection, '200 of 201 groups');
  const defaultRows = await call(server, 'material.items', { collection: '20261106-合集0' });
  assert.equal(count(defaultRows, 'items'), MATERIAL_TOOL_CAPS.itemsDefault, 'the default row count');
  assert.equal(defaultRows.structuredContent.total, 402);
  assert.equal(defaultRows.structuredContent.truncated, true);
  const asked = await call(server, 'material.items', { collection: '20261106-合集0', limit: 10_000 });
  assert.equal(count(asked, 'items'), MATERIAL_TOOL_CAPS.items, 'the cap, not the 402 the index holds');
  assert.equal(asked.structuredContent.truncated, true);
});

test('the contract, the served surface and both planners do the same arithmetic', async () => {
  const contract = JSON.parse(readFileSync(new URL('../../../docs/contracts/mcp-tools.schema.json', import.meta.url), 'utf8'));
  const tools = contract.properties.tools;
  assert.equal(tools.minItems, 13);
  assert.equal(tools.maxItems, 13);
  const branches = tools.items.oneOf;
  assert.equal(branches.length, 13, 'exactly thirteen alternatives, one per slot');
  const contractNames = branches.map((branch) => branch.properties.name.const);
  assert.deepEqual(contractNames, [...BUDGET_SURFACE], 'the contract lists the surface, in order');
  for (const branch of branches) {
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual(branch.required, ['name', 'caps']);
  }
  assert.deepEqual(branches.map((branch) => branch.properties.caps.const), [
    { rows: 20, defaultRows: 8 },
    { rows: MATERIAL_TOOL_CAPS_CONTRACT.searchRows, defaultRows: MATERIAL_TOOL_CAPS_CONTRACT.searchDefaultRows },
    { collections: MATERIAL_TOOL_CAPS.collections, groupsPerCollection: MATERIAL_TOOL_CAPS.groupsPerCollection },
    { rows: MATERIAL_TOOL_CAPS_CONTRACT.rows, defaultRows: MATERIAL_TOOL_CAPS_CONTRACT.defaultRows },
    { lines: 40, candidates: 60 },
    { plans: 200 },
    { clips: 100 },
    { plans: 200 },
    { cues: 200 },
    { issues: 100 },
    { plans: 200 },
    { rows: 1 },
    { segments: 1 },
  ]);
  assert.deepEqual(
    [MATERIAL_TOOL_CAPS.search, MATERIAL_TOOL_CAPS.searchDefault, MATERIAL_TOOL_CAPS.collections, MATERIAL_TOOL_CAPS.groupsPerCollection, MATERIAL_TOOL_CAPS.items, MATERIAL_TOOL_CAPS.itemsDefault],
    [50, 10, 50, 200, 200, 50],
  );

  /* SURFACE_CHANGES counted: seven names lose five, keep two, and the five-slot surface adds three */
  const math = surfaceArithmetic();
  /* compat 池子现在是 8：旧七个 + 元素检索（2026-11-19 新增的第 6 槽） */
  assert.equal(math.before, 15);
  assert.equal(math.removed.length, 5);
  assert.deepEqual(math.kept, ['library.search', 'plan.create', 'plan.apply', 'caption.write', 'timeline.check', 'plan.expand', 'dedupe.check', 'plan.render', 'materials.take', 'timeline.insert_clip']);
  assert.equal(math.added.length, 3, '素材检索那一批（元素检索与剪辑链是另外的槽）');
  assert.deepEqual(math.added, ['material.search', 'material.collections', 'material.items'], 'the search takes the batches slot');
  assert.deepEqual(math.introduced, ['wiki.read'], 'the merged name is retired in the same decision, so it never lands');
  assert.deepEqual(math.retired, ['wiki.read', 'openfilm.look']);
  assert.deepEqual(math.after, [...BUDGET_SURFACE]);
  assert.equal(math.count, 13);
  /* 8 - 5 + 3 = 6：kept 里的 library.search 与两个写动词各占一槽 */
  assert.deepEqual(math.missing, []);
  assert.equal(math.fits, true);
  assert.equal(math.before - math.removed.length + math.added.length, math.count);
  for (const change of SURFACE_CHANGES) {
    assert.ok(['merged', 'absorbed', 'retired'].includes(change.mode), change.name + ' has a mode');
    assert.equal(BUDGET_SURFACE.includes(change.name), false, change.name + ' is not on the five-slot surface');
    assert.equal(typeof change.why, 'string');
    if (change.mode === 'merged') assert.equal(change.into, 'wiki.read');
  }
  /* the batch tool's slot is accounted for: absorbed into the collections tool, which already lists every batch */
  const replaced = SURFACE_CHANGES.find((change) => change.name === 'material.batches');
  assert.equal(replaced.mode, 'absorbed');
  assert.equal(replaced.into, 'material.collections');
  assert.equal(SURFACE_CHANGES.find((change) => change.name === 'materials.search').into, 'material.search');

  /* planMaterialToolSurface() arrives at the same five from the same seven */
  const plan = planMaterialToolSurface();
  /* 素材面自己的预算还是 5（三个读 + 两个写）；整个窗口现在是 6（多一个元素检索） */
  assert.equal(plan.budget, 5);
  assert.equal(TOOL_BUDGET, 13);
  assert.equal(plan.count, 5);
  assert.equal(plan.fits, true);
  assert.deepEqual(plan.slots, { before: 7, merged: 2, absorbed: 1, retired: 2, added: 3, after: 5, balanced: true });
  /* planMaterialToolSurface() 算的是**素材那三个**（7 → 5），是整个窗口（6，含元素检索）的子集 */
  assert.ok(plan.after.every((name) => BUDGET_SURFACE.includes(name)), '素材面是窗口的子集');
  assert.ok(plan.after.every((name) => contractNames.includes(name)), '素材面在契约里也有位置');
  assert.ok(contractNames.includes('library.search'), '契约里另有元素检索这一槽');
  const keepWiki = planMaterialToolSurface(undefined, { retire: ['openfilm.look'] });
  assert.equal(keepWiki.slots.after, 6);
  assert.equal(keepWiki.slots.balanced, true);
  assert.equal(keepWiki.fits, false);

  /* and what tools/list answers with is that same contract, name for name */
  const server = createOpenFilmMcpServer({ cwd: tmpdir(), log: () => {} });
  assert.deepEqual((await server.listedTools()).map((tool) => tool.name), contractNames);
});
