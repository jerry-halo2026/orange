// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The app's own IPC, in one place.
 *
 * OpenFilm's desktop brings its own channels (chat, agents, skills, the window's tabs, updates) and those keep their
 * registrations where they were. What this product added on top — the account UI's state, and the material draft two
 * tabs share — is registered here, by one call, so `main.mjs` says what it adds in one word and `preload.cjs` can name
 * the very same channels in one list. `main.test.mjs` holds the two lists equal, and holds `main.mjs` from registering
 * any of them anywhere else.
 *
 * The channels:
 *   · desktop:auth-ui-state          → { active, uiGeneration }: whether this page may act, and for which generation
 *   · desktop:material-draft:read    → the shared material draft, read under the page's own generation
 *   · desktop:material-draft:change  → a compare-and-set change; the committed draft is told to every other page
 *   · desktop:material-draft         ← (main → page) the draft another page changed
 *   · desktop:auth                   ← (main → page) the account UI's state, as it changes
 *
 * Nothing here trusts a page: `isAllowed` answers whether the event is a current frame of this window's active UI
 * generation, and the material draft bridge checks the generation and the lease itself (material-draft-ipc.mjs).
 */

/** Every channel of our own IPC, by what it is for: the ones the main process answers, and the ones it says. */
export const ORANGE_IPC = Object.freeze({
  authUiState: 'desktop:auth-ui-state',
  materialDraftRead: 'desktop:material-draft:read',
  materialDraftChange: 'desktop:material-draft:change',
  materialDraftChanged: 'desktop:material-draft',
  auth: 'desktop:auth',
});

/** The channels the main process answers (registered below, one handler each). */
export const ORANGE_IPC_HANDLED = Object.freeze([ORANGE_IPC.authUiState, ORANGE_IPC.materialDraftRead, ORANGE_IPC.materialDraftChange]);

/** The channels the main process says, and a page listens to. */
export const ORANGE_IPC_RECEIVED = Object.freeze([ORANGE_IPC.materialDraftChanged, ORANGE_IPC.auth]);

/** Every channel above as one list: the preload's own list has to say exactly these. */
export const ORANGE_IPC_CHANNELS = Object.freeze([...ORANGE_IPC_HANDLED, ...ORANGE_IPC_RECEIVED]);

/**
 * Register our own channels on the window's ipcMain.
 *
 * @param {object} options
 * @param {{ handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void }} options.ipcMain
 *   Electron's ipcMain, or a stand-in that records what was registered.
 * @param {(event: unknown) => boolean} options.isAllowed
 *   whether this event is a current page of this window, in the account generation this app is at.
 * @param {() => { active: boolean, uiGeneration: number }} options.authUiState
 *   the account UI as it is now: whether an account is active, and which UI generation its pages belong to.
 * @param {{ read: (event: unknown, input: unknown) => unknown, change: (event: unknown, input: unknown) => unknown }} options.materialDraft
 *   the bridge over the shared material draft (material-draft-ipc.mjs).
 * @returns {typeof ORANGE_IPC} the channels now registered, for a test to hold the preload's list equal to.
 */
export function registerOrangeIpc({ ipcMain, isAllowed, authUiState, materialDraft }) {
  if (typeof ipcMain?.handle !== 'function') throw new TypeError('registerOrangeIpc needs an ipcMain with handle()');
  if (typeof isAllowed !== 'function' || typeof authUiState !== 'function') throw new TypeError('registerOrangeIpc needs isAllowed and authUiState');
  if (typeof materialDraft?.read !== 'function' || typeof materialDraft?.change !== 'function') throw new TypeError('registerOrangeIpc needs the material draft bridge');

  /* Asked before a page is signed in (the login page asks it too), so a page that is not current hears "not active"
     rather than an error: the same answer this channel gave before it moved here. */
  ipcMain.handle(ORANGE_IPC.authUiState, (event) => (isAllowed(event) ? authUiState() : { active: false, uiGeneration: -1 }));
  ipcMain.handle(ORANGE_IPC.materialDraftRead, (event, input) => materialDraft.read(event, input));
  ipcMain.handle(ORANGE_IPC.materialDraftChange, (event, input) => materialDraft.change(event, input));
  return ORANGE_IPC;
}
