// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Orange's Studio shell: the one place our Studio-side layer attaches to upstream's editor.
 *
 * Today it is a shell and nothing more — `App` is rendered exactly as upstream renders it, so the views, the routes,
 * the requests and the order they happen in are unchanged. What is ours reaches it through the words: `i18n/index.ts`
 * lays `i18n/orange-words.ts` over every language table, so every `useT()` inside `App` already reads our sentences,
 * in the language the person chose.
 *
 * Why the extra file at all: our next additions (a panel, a route, a view of ours) get one entry to hold instead of
 * another edit inside upstream's `App.tsx`, which is what W1-A is for. Until then this file deliberately has no view
 * logic of its own to get wrong.
 */
import { App } from './App';

/** The same props upstream's entry gives `App`; no prop of ours yet. */
export type OrangeAppProps = { authGeneration?: number };

/** Upstream's app, inside our shell. */
export function OrangeApp({ authGeneration }: OrangeAppProps = {}) {
  return <App authGeneration={authGeneration} />;
}
