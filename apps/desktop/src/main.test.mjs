// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * W2-B: the app's own IPC converges on one entry, and the window's name comes from brand.json.
 *
 * What is asserted here is the part that would rot silently: a channel registered in one place and spoken in another,
 * a page reaching a channel nothing registered, and a title that drifts from the brand's own file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ORANGE_IPC, ORANGE_IPC_CHANNELS, ORANGE_IPC_HANDLED, ORANGE_IPC_RECEIVED, registerOrangeIpc } from './orange-ipc.mjs';
import { FALLBACK_WINDOW_TITLE, brandCandidates, brandWindowTitle, readBrand } from './brand.mjs';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const brand = () => JSON.parse(read('../../../brand.json'));

test('main registers our own channels through one entry, and none of them anywhere else', () => {
  const main = read('./main.mjs');
  assert.equal((main.match(/registerOrangeIpc\(/g) ?? []).length, 1, 'one registration entry, called once');
  assert.match(main, /import \{ registerOrangeIpc \} from '\.\/orange-ipc\.mjs';/);
  for (const channel of ORANGE_IPC_CHANNELS) {
    assert.equal(main.includes(`ipcMain.handle('${channel}'`), false, `${channel} is not registered in main.mjs`);
    assert.equal(main.includes(`ipcMain.on('${channel}'`), false, `${channel} is not listened to in main.mjs`);
  }
  /* the registrations OrangeFilm came with stay where they were */
  for (const upstream of ['registerChatIpc(', 'registerLocalAgentIpc(', 'registerSkillsIpc(']) assert.ok(main.includes(upstream), upstream);
});

test('the preload names exactly the channels the one entry says, and nothing else', () => {
  const preload = read('./preload.cjs');
  const list = preload.match(/const ORANGE_CHANNELS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(list, 'the preload names our channels in one list');
  const named = [...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...named].sort(), [...ORANGE_IPC_CHANNELS].sort(), 'the preload list and registerOrangeIpc say the same channels');
  assert.equal(new Set(named).size, named.length, 'a channel is named once');
  /* our channels go through the list, never straight to ipcRenderer */
  for (const channel of ORANGE_IPC_CHANNELS) {
    assert.equal(preload.includes(`ipcRenderer.invoke('${channel}'`), false, `${channel} is invoked through the list`);
  }
});

test('every channel the preload speaks is one the entry registered, and the answers come back', async () => {
  const handles = new Map();
  const subscribed = [];
  const events = [];
  registerOrangeIpc({
    ipcMain: { handle: (channel, fn) => handles.set(channel, fn) },
    isAllowed: (event) => event === 'current-page',
    authUiState: () => ({ active: true, uiGeneration: 4 }),
    materialDraft: {
      read: (event, input) => { events.push(['read', event, input]); return { items: [], revision: 0, lease: 'fixture' }; },
      change: (event, input) => { events.push(['change', event, input]); return { revision: 1, items: [] }; },
    },
  });
  assert.deepEqual([...handles.keys()].sort(), [...ORANGE_IPC_HANDLED].sort(), 'the handlers are the channels the preload invokes');
  for (const channel of ORANGE_IPC_RECEIVED) assert.equal(handles.has(channel), false, `${channel} is said by the main process, not answered`);

  let native;
  vm.runInNewContext(read('./preload.cjs'), {
    process: { platform: process.platform },
    require: () => ({
      contextBridge: { exposeInMainWorld: (_key, value) => { native = value; } },
      ipcRenderer: {
        invoke: (channel, opts) => {
          const handle = handles.get(channel);
          if (!handle) throw new Error('no handler for ' + channel);
          return handle('current-page', opts);
        },
        on: (channel) => subscribed.push(channel),
        removeListener: () => {},
      },
    }),
  });

  assert.deepEqual(await native.authUiState(), { active: true, uiGeneration: 4 }, 'the account UI answers the page');
  assert.deepEqual(await native.materialDraft.read({ generation: 4 }), { items: [], revision: 0, lease: 'fixture' });
  assert.deepEqual(await native.materialDraft.change({ generation: 4 }), { revision: 1, items: [] });
  assert.deepEqual(events, [['read', 'current-page', { generation: 4 }], ['change', 'current-page', { generation: 4 }]]);
  /* a page left behind by a sign-out hears "not active", not an error, and the draft's own bridge refuses it */
  const behind = handles.get(ORANGE_IPC.authUiState);
  assert.deepEqual(behind('stale-page'), { active: false, uiGeneration: -1 });
  native.materialDraft.onChange(() => {});
  native.onAuth(() => {});
  assert.deepEqual([...subscribed].sort(), [...ORANGE_IPC_RECEIVED].sort(), 'the channels the main process says are the ones a page listens to');
});

test('the window title and About are brand.json\'s windowTitle, with the name this app had as the fallback', () => {
  const said = brand().windowTitle;
  assert.equal(typeof said, 'string');
  assert.ok(said.trim(), 'brand.json names the window');
  assert.equal(brandWindowTitle(brand()), said.trim());
  assert.equal(brandWindowTitle({}), FALLBACK_WINDOW_TITLE, 'no brand.json keeps the name this window had');
  assert.equal(brandWindowTitle({ windowTitle: '   ' }), FALLBACK_WINDOW_TITLE);
  assert.equal(brandWindowTitle({ windowTitle: 7 }), FALLBACK_WINDOW_TITLE);
  assert.equal(brandWindowTitle(brand(), 'fallback'), said.trim(), 'the file wins over the fallback');

  assert.deepEqual(readBrand({ read: () => JSON.stringify({ windowTitle: 'W' }), candidates: ['brand.json'] }), { windowTitle: 'W' });
  assert.deepEqual(readBrand({ read: () => '\u0000not json', candidates: ['brand.json'] }), {}, 'a file that cannot be read is the fallback');
  assert.deepEqual(readBrand({ read: () => { throw new Error('missing'); }, candidates: ['one', 'two'] }), {}, 'every place looked in, then the fallback');
  assert.deepEqual(readBrand({ read: () => '[]', candidates: ['brand.json'] }), {}, 'a list is not a brand');
  /* the repository's own brand.json is what the default candidates find from this file's folder */
  const [fromSource, ...besideResources] = brandCandidates();
  assert.equal(typeof readBrand({ candidates: [fromSource] }).windowTitle, 'string', 'the first place is the repository root');
  assert.deepEqual(besideResources, [], 'a source checkout has no resources folder to look in');
  assert.deepEqual(brandCandidates('/x/apps/desktop/src', '/x/resources'), [join('/x/apps/desktop/src', '..', '..', '..', 'brand.json'), join('/x/resources', 'brand.json')]);

  const main = read('./main.mjs');
  assert.match(main, /import \{ brandWindowTitle \} from '\.\/brand\.mjs';/);
  assert.match(main, /const DISPLAY_NAME = brandWindowTitle\(\);/);
  assert.match(main, /title: DISPLAY_NAME/, 'the window is titled from the brand');
  assert.match(main, /productName: DISPLAY_NAME/, 'About says the brand');
});
