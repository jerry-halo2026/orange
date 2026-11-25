// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentHints, doctor, formatReport, logTrouble, softwareRenderer, tidy } from './doctor.mjs';

test('a path under the home folder reads ~', () => {
  assert.equal(tidy('/Volumes/Home/someone/.orangefilm', '/Volumes/Home/someone'), '~/.orangefilm');
  assert.equal(tidy('/opt/homebrew/bin/node', '/Volumes/Home/someone'), '/opt/homebrew/bin/node');
});

test('the agent that ran it is told by its variables\' names, never their values', () => {
  const { agents, names } = agentHints({ CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'secret', PATH: '/bin', CODEX_SANDBOX: 'seatbelt' });
  assert.deepEqual(agents, ['Claude Code', 'Codex']);
  assert.deepEqual(names, ['CLAUDECODE', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_SANDBOX']);
  assert.ok(!JSON.stringify({ agents, names }).includes('secret'));
  assert.deepEqual(agentHints({ PATH: '/bin', TERM_PROGRAM: 'vscode' }).agents, []);
});

test('the log\'s errors: the last few, a repeated one once with its count', () => {
  const log = ['started', 'Error: spawn EBADF', 'Error: spawn EBADF', 'Error: spawn EBADF', 'ok', 'uncaught: boom', 'x'.repeat(400) + ' failed'].join('\n');
  const lines = logTrouble(log);
  assert.deepEqual(lines.slice(0, 2), ['Error: spawn EBADF (×3)', 'uncaught: boom']);
  assert.ok(lines[2].length <= 300 && lines[2].endsWith('…'));
  assert.equal(logTrouble(log, 1).length, 1);
});

test('a WebGL drawn in software is told apart from a graphics chip', () => {
  assert.equal(softwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), true);
  assert.equal(softwareRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'), false);
  assert.equal(softwareRenderer(null), false);
});

test('the report lists each check, then what to fix', () => {
  const text = formatReport([{ label: 'Node', text: 'v22.18.0' }, { label: 'ffmpeg', text: 'not found on the PATH', problem: 'install ffmpeg' }]);
  assert.match(text, /✓ Node {4}v22\.18\.0/);
  assert.match(text, /✗ ffmpeg {2}not found on the PATH/);
  assert.match(text, /To fix:\n {2}ffmpeg: install ffmpeg/);
  assert.match(formatReport([{ label: 'Node', text: 'v22' }]), /Nothing to fix\./);
});

test('doctor: the report says how much the projects\' .film folders hold', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orangefilm-doctor-usage-'));
  const projects = join(home, 'Projects');
  mkdirSync(join(projects, 'Alpha', '.film', 'cache'), { recursive: true });
  writeFileSync(join(projects, 'Alpha', 'film.html'), '{"stage":{"w":1920,"h":1080},"tracks":[]}');
  writeFileSync(join(projects, 'Alpha', '.film', 'cache', 'frame.bin'), Buffer.alloc(1_500_000));
  mkdirSync(join(projects, 'Beta', '.film'), { recursive: true });
  writeFileSync(join(projects, 'Beta', 'film.html'), '{"stage":{"w":1920,"h":1080},"tracks":[]}');
  writeFileSync(join(projects, 'Beta', '.film', 'id'), 'beta');
  const before = { home: process.env.ORANGE_HOME, library: process.env.ORANGE_LIBRARY };
  process.env.ORANGE_HOME = join(home, '.orangefilm');
  process.env.ORANGE_LIBRARY = projects;
  try {
    const report = await doctor({ studio: { origin: 'http://127.0.0.1:4848', version: '0.2.7' }, browser: false, network: false, home });
    assert.match(report.text, /Film files +1\.5 MB in 2 projects' \.film folders/);
    assert.ok(!report.text.includes(home), 'no full home path, and no project names');
  } finally {
    for (const [name, value] of [['ORANGE_HOME', before.home], ['ORANGE_LIBRARY', before.library]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor: the log\'s errors hide keys and email addresses, as the report promises', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orangefilm-doctor-log-'));
  const data = join(home, '.orangefilm');
  mkdirSync(join(data, 'logs'), { recursive: true });
  writeFileSync(join(data, 'logs', 'studio.log'),
    'Error: request failed with Authorization: Bearer abcdefgh12345678 and sk-proj-ABCDEFGHIJKLMNOP from alice@example.com\n');
  const before = { home: process.env.ORANGE_HOME, library: process.env.ORANGE_LIBRARY };
  process.env.ORANGE_HOME = data;
  process.env.ORANGE_LIBRARY = join(home, 'Projects');
  try {
    const { text } = await doctor({ studio: { origin: 'http://127.0.0.1:4848', version: '0.3.0' }, browser: false, network: false, home });
    assert.match(text, /\(hidden\)/);
    assert.match(text, /\(key hidden\)/);
    assert.match(text, /\(email\)/);
    assert.ok(!text.includes('abcdefgh12345678'), 'no bearer token');
    assert.ok(!text.includes('sk-proj-'), 'no key');
    assert.ok(!text.includes('alice@example.com'), 'no email address');
    assert.ok(!text.includes(home), 'no full home path');
  } finally {
    for (const [name, value] of [['ORANGE_HOME', before.home], ['ORANGE_LIBRARY', before.library]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor: the folders and the log, paths under home as ~', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orangefilm-doctor-'));
  const data = join(home, '.orangefilm');
  mkdirSync(join(data, 'logs'), { recursive: true });
  writeFileSync(join(data, 'logs', 'studio.log'), `2026-10-18T00:00:00Z Error: could not read ${join(home, 'film', 'film.html')}\n`);
  const before = { home: process.env.ORANGE_HOME, library: process.env.ORANGE_LIBRARY };
  process.env.ORANGE_HOME = data;
  process.env.ORANGE_LIBRARY = join(home, 'Projects');
  try {
    const report = await doctor({ env: { CODEX_SANDBOX: 'seatbelt' }, studio: { origin: 'http://127.0.0.1:4848', version: '0.1.7' }, browser: false, network: false, home });
    assert.match(report.text, /Run by +Codex \(CODEX_SANDBOX\)/);
    assert.match(report.text, /Studio +0\.1\.7 at http:\/\/127\.0\.0\.1:4848/);
    /* what ffmpeg does on the graphics chip here, or that it does it on the processor */
    if (/ffmpeg +\d/.test(report.text)) assert.match(report.text, /Hardware +ffmpeg encodes (with [^;]+|on the processor); decodes (with \S+|on the processor)\n/);
    assert.match(report.text, /Data +~[/\\]\.orangefilm/);
    assert.match(report.text, /Projects +~[/\\]Projects \(not made yet\)/);
    assert.match(report.text, /Last errors in ~.*studio\.log:\n {2}.*could not read ~[/\\]film/);
    assert.ok(!report.text.includes(home), 'no full home path');
    assert.ok(!report.text.includes('seatbelt'), 'no variable values');
  } finally {
    for (const [name, value] of [['ORANGE_HOME', before.home], ['ORANGE_LIBRARY', before.library]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

/* The materials answer and the npm probe both used to say more than they knew (2026-11-25): an app without a session
   was reported as "not signed in" although the person had bound the steward, and a 404 for this product's unpublished
   npm name was reported as "the network is down" although the registry answered. */
const reply = (status, body = null) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

async function doctorWith(replies, { registry } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'orangefilm-doctor-net-'));
  const before = { home: process.env.ORANGE_HOME, library: process.env.ORANGE_LIBRARY };
  process.env.ORANGE_HOME = join(home, '.orangefilm');
  process.env.ORANGE_LIBRARY = join(home, 'Projects');
  const asked = [];
  const fetch = async (url) => {
    asked.push(String(url));
    if (String(url).includes('/api/materials/binding')) return replies.binding;
    if (String(url).includes('registry.npmjs.org')) {
      if (registry === 'throw') throw new Error('offline');
      return reply(registry ?? 200);
    }
    return reply(404);
  };
  try {
    const report = await doctor({ studio: { origin: 'http://127.0.0.1:4848', version: '0.3.0', app: true, key: 'k' }, browser: false, network: true, home, fetch });
    return { report, asked };
  } finally {
    for (const [name, value] of [['ORANGE_HOME', before.home], ['ORANGE_LIBRARY', before.library]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test('doctor: without a session the binding is said to be unreadable, not unbound', async () => {
  const { report } = await doctorWith({ binding: reply(403, { code: 'authentication-required' }) });
  assert.match(report.text, /Materials +no session yet/);
  assert.ok(!report.text.includes('not signed in'), 'a bound steward is not called "not signed in"');
  assert.ok(!/bind the cloud steward account in Settings/.test(report.text), 'and the person is not told to bind it again');
});

test('doctor: the steward as bound, and a readable answer without one as unbound', async () => {
  const bound = await doctorWith({ binding: reply(200, { binding: { account: 'zhangqinyuan', status: 'claimed' } }) });
  assert.match(bound.report.text, /Materials +cloud steward bound: zhangqinyuan/);
  const empty = await doctorWith({ binding: reply(200, { binding: null }) });
  assert.match(empty.report.text, /Materials +not bound/);
});

test('doctor: the registry answering 404 for this product\'s name is still reachable', async () => {
  const { report, asked } = await doctorWith({ binding: reply(200, { binding: null }) }, { registry: 404 });
  assert.match(report.text, /Network +npm reachable/);
  assert.ok(asked.some((url) => url === 'https://registry.npmjs.org/'), 'the registry root is what is asked, not our name');
  assert.ok(!asked.some((url) => url.startsWith('https://registry.npmjs.org/orangefilm')), 'a name that is not published is never the probe');
});

test('doctor: only a registry that does not answer is unreachable', async () => {
  const { report } = await doctorWith({ binding: reply(200, { binding: null }) }, { registry: 'throw' });
  assert.match(report.text, /Network +npm not reachable/);
});