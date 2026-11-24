// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The developer tools as a developer actually reaches them: a menu item that says which key it is, on F12, with
 * the older Alt+CmdOrCtrl+I still working from the page's input, and a home-page fallback when no tab is in front.
 *
 * Nothing here is about a packaged build having them: it does not, and these tests say so too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applicationMenuTemplate } from './menu.mjs';
import { MENU_WORDS } from './i18n/menu.mjs';
import { devToolsView, isDevToolsShortcut, toggleDevTools } from './dev-tools.mjs';

const noop = () => {};
const menu = (packaged, language = 'en') => applicationMenuTemplate({
  productName: 'OrangeFilm', packaged, language, toggleChat: noop, openProject: noop, reload: noop, devTools: noop,
  openSettings: noop, tabs: { open: noop, close: noop, reopen: noop, step: noop, pick: noop },
});
/** The View submenu, named in the language the menu was built in. */
const viewItems = (template, language = 'en') => template.find((item) => item.label === (MENU_WORDS[language] ?? MENU_WORDS.en).view).submenu;
const devToolsItem = (template, language = 'en') => viewItems(template, language).find((item) => item.accelerator === 'F12');

test('a development build offers the developer tools on F12 and says the key in the item', () => {
  const item = devToolsItem(menu(false));
  assert.ok(item, 'the View menu carries an F12 item in a development build');
  assert.equal(item.label, 'Developer Tools (F12)');
  assert.equal(item.accelerator, 'F12');
  assert.equal(typeof item.click, 'function');
});

test('the item reads as Chinese in a Chinese interface, with the same key', () => {
  const item = devToolsItem(menu(false, 'zh-CN'), 'zh-CN');
  assert.ok(item);
  assert.equal(item.label, '开发者工具 (F12)');
  assert.equal(item.accelerator, 'F12');
});

test('a packaged build keeps the developer tools item (debugging a black window), and the rest of the View menu', () => {
  const template = menu(true);
  assert.ok(devToolsItem(template), 'the F12 item is there');
  assert.ok(viewItems(template).some((item) => item.role === 'zoomIn'), 'the ordinary View items are still there');
});

test('the menu callback opens the tools on the page in front', () => {
  let opened = 0;
  const template = applicationMenuTemplate({
    productName: 'OrangeFilm', packaged: false, language: 'en', toggleChat: noop, openProject: noop, reload: noop,
    devTools: () => { opened += 1; }, openSettings: noop, tabs: { open: noop, close: noop, reopen: noop, step: noop, pick: noop },
  });
  devToolsItem(template).click();
  assert.equal(opened, 1);
});

test('with no page in front the tools open on the home page, never on a new window', () => {
  const calls = [];
  const page = (name) => ({ name, webContents: { toggleDevTools: () => calls.push(name) } });
  const home = page('home');
  const active = page('active');

  assert.equal(toggleDevTools(active, home), true);
  assert.deepEqual(calls, ['active'], 'the page in front is the one that opens them');

  assert.equal(toggleDevTools(null, home), true);
  assert.deepEqual(calls, ['active', 'home'], 'no tab in front falls back to the home page');

  assert.equal(toggleDevTools(undefined, undefined), false, 'a window with no page at all has nothing to open');
  assert.equal(devToolsView(null, home), home);
  assert.equal(devToolsView(null, null), null);
});

test('F12 and Alt+CmdOrCtrl+I both ask for the tools; nothing else does', () => {
  assert.equal(isDevToolsShortcut({ type: 'keyDown', key: 'F12' }), true);
  assert.equal(isDevToolsShortcut({ type: 'keyDown', key: 'f12', code: 'F12' }), true);
  assert.equal(isDevToolsShortcut({ type: 'keyDown', key: 'i', alt: true, control: true }), true);
  assert.equal(isDevToolsShortcut({ type: 'keyDown', key: 'I', alt: true, meta: true }), true);
  assert.equal(isDevToolsShortcut({ type: 'keyDown', key: 'i', alt: true, meta: true, control: true }), true, 'both modifier spellings at once is still the same chord');
  assert.equal(isDevToolsShortcut({ type: 'keyDown', code: 'KeyI', alt: true, control: true }), true, 'a layout that sends no latin key still sends the code');

  assert.equal(isDevToolsShortcut({ type: 'keyDown', key: 'F12', control: true }), false, 'F12 alone, not with a modifier');
  assert.equal(isDevToolsShortcut({ type: 'keyDown', key: 'i', control: true }), false, 'Ctrl+I is italics, not the tools');
  assert.equal(isDevToolsShortcut({ type: 'keyDown', key: 'i', alt: true }), false, 'Alt+I alone is a menu key');
  assert.equal(isDevToolsShortcut({ type: 'keyDown', key: 'i', alt: true, control: true, shift: true }), false);
  assert.equal(isDevToolsShortcut({ type: 'keyUp', key: 'F12' }), false, 'a key release is not a key press');
  assert.equal(isDevToolsShortcut({ type: 'keyDown', key: 'F11' }), false);
  assert.equal(isDevToolsShortcut(null), false);
});

test('the window keeps the flag, binds both keys in every build, and uses the fallback callback', () => {
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /devTools: true,/, 'the pages keep their developer tools');
  assert.match(main, /devTools: \(\) => toggleDevTools\(activeView\(\), views\.get\(HOME\)\)/, 'the menu callback falls back to home');
  assert.match(main, /v\.webContents\.on\('before-input-event'/, 'the second key is bound');
  assert.match(main, /event\.preventDefault\(\);\s*toggleDevTools\(v, v\);/, 'the page that saw the key opens the tools itself');
});
