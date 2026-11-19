// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The developer tools, in a development build only.
 *
 * `main.mjs` keeps every way in behind `app.isPackaged`: the window's `webPreferences.devTools`, the View menu's
 * item, and the key binding below. A packaged build never reaches these helpers.
 *
 * Two keys ask for them: **F12** (what the menu item advertises) and **Alt+CmdOrCtrl+I** (what it advertised
 * before, still worth keeping in the fingers of anyone who used it). The menu can only carry one accelerator, so
 * F12 is written into the menu and the second key is read from the page's own input events.
 */

/** The key that opens the tools on a page that has none open — the front page, or the home page when no tab is. */
export function devToolsView(active, home) {
  return active ?? home ?? null;
}

/**
 * Open or close the tools on the page in front; when there is none, on the home page (a window with no tab open
 * still has one). New windows are never made for this, and `false` means the window has no page at all.
 * @param {{webContents?: {toggleDevTools: () => void}} | null} active
 * @param {{webContents?: {toggleDevTools: () => void}} | null} home
 * @returns {boolean}
 */
export function toggleDevTools(active, home) {
  const view = devToolsView(active, home);
  if (!view?.webContents || typeof view.webContents.toggleDevTools !== 'function') return false;
  view.webContents.toggleDevTools();
  return true;
}

/**
 * Whether an Electron `before-input-event` input asks for the developer tools: F12 alone, or Alt with Cmd/Ctrl
 * and I (either the letter's `key` or its `code`; a non-US layout still sends `KeyI`).
 * @param {{type?: string, key?: string, code?: string, control?: boolean, meta?: boolean, alt?: boolean, shift?: boolean}} input
 * @returns {boolean}
 */
export function isDevToolsShortcut(input) {
  if (!input || input.type !== 'keyDown') return false;
  const control = input.control === true;
  const meta = input.meta === true;
  const alt = input.alt === true;
  const shift = input.shift === true;
  const key = String(input.key ?? '').toLowerCase();
  const code = String(input.code ?? '').toLowerCase();
  if (key === 'f12' || code === 'f12') return !control && !meta && !alt && !shift;
  const letter = key === 'i' || code === 'keyi';
  return letter && alt && (control || meta) && !shift;
}
