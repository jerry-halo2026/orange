// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Chat lives in Studio's original page and follows its theme and language.
 * An account retirement disposes this separate React root before another account sees the column.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { app } from './app-bridge';
import { setLanguage } from './i18n';

export async function mountChat(root: HTMLElement, signal?: AbortSignal): Promise<() => void> {
  const hello = await app.hello();
  if (signal?.aborted) return () => {};
  setLanguage(hello.language);
  const stopLanguage = app.onLanguage(setLanguage);
  const mounted = createRoot(root);
  mounted.render(
    <StrictMode><App initialProject={hello.project} initialSelection={hello.selection} initialFfmpeg={hello.ffmpeg} /></StrictMode>,
  );
  return () => { stopLanguage(); mounted.unmount(); };
}
