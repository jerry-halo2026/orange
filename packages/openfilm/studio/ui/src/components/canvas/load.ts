// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/* One optional warm-up and the lazy view share the same import. A failed warm-up can be tried on opening. */
let loading: Promise<typeof import('./CanvasView')> | undefined;
export function loadCanvas() {
  return loading ??= import('./CanvasView').catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
}
