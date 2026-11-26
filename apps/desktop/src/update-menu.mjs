// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * "Check for Updates…" in the menu: the one place a check answers with a dialog (background checks are silent, and the
 * chat only shows an update once it is ready). The dialogs never show the updater's own errors, only
 * their words for its codes (i18n/update-dialogs.mjs), in the menu's language.
 */
import { UPDATE_DIALOG_WORDS } from './i18n/update-dialogs.mjs';
import { brandProductName } from './brand.mjs';
/* the product's name, from brand.json: what a dialog calls it ({name}) */
const PRODUCT = brandProductName();

/**
 * The check takes the menu's language (one of Studio's, i18n/language.mjs `appLanguage`).
 * @param {{ controller: { check: () => Promise<any>, restart: () => Promise<{ ok: boolean, error?: string }> },
 *           showMessage: (options: Electron.MessageBoxOptions) => Promise<{ response: number }>, focusWindow: () => void,
 *           productName?: string }} options
 */
export function createManualUpdateCheck({ controller, showMessage, focusWindow, productName = PRODUCT }) {
  /** one check, one dialog: the menu clicked again while it is open waits on the same one */
  let pending = null;

  return function manualCheck(language = 'en') {
    pending ??= (async () => {
      const words = UPDATE_DIALOG_WORDS[language] ?? UPDATE_DIALOG_WORDS.en;
      /* a version not known yet leaves no gap ("Downloading OrangeFilm") */
      const fill = (text, values = {}) => Object.entries({ name: productName, ...values })
        .reduce((out, [key, value]) => out.replaceAll(`{${key}}`, value), text).replace(/ {2,}/g, ' ').trim();
      const error = (code) => fill(words.errors[code] ?? words.errors.failed);
      const say = (options) => showMessage({ title: words.title, buttons: [words.ok], defaultId: 0, cancelId: 0, ...options });
      const state = await controller.check();
      const version = state.availableVersion ?? '';
      if (state.status === 'installing') return;
      if (state.status === 'current') {
        await say({ type: 'info', message: fill(words.upToDate), detail: fill(state.channel === 'beta' ? words.betaVersion : words.version, { version: state.version }) });
      } else if (state.status === 'ready') {
        focusWindow();
        const { response } = await say({
          type: 'info', message: fill(words.ready, { version }), detail: words.readyDetail,
          buttons: [words.restart, words.later], defaultId: 0, cancelId: 1,
        });
        if (response !== 0) return;
        const result = await controller.restart();
        if (!result.ok && words.errors[result.error]) await say({ type: 'warning', message: words.notRestarting, detail: error(result.error) });
      } else if (['checking', 'available', 'downloading', 'staging'].includes(state.status)) {
        const progress = state.status === 'downloading' && state.progress ? ` (${Math.round(state.progress)}%)` : '';
        await say({ type: 'info', message: `${fill(words.downloading, { version })}${progress}`, detail: words.downloadingDetail });
      } else {
        await say({ type: 'warning', message: words.failed, detail: fill(words.failedDetail, { error: error(state.error) }) });
      }
    })().finally(() => { pending = null; });
    return pending;
  };
}
