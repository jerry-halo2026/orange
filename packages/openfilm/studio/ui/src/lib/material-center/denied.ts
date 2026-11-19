// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

﻿/**
 * The downloads this session is not allowed to make.
 *
 * The supplier does not say who may take what, so nothing is greyed out in advance: a 403 (or its `authorization-denied`
 * / `raw-host-not-allowed` codes) on one card marks that one video, and its button is dead from then on. Refusals are
 * about the identity, not the moment, so asking again would only spend another request on the same answer — but a
 * network error, a timeout or a 5xx says nothing about permission and stays retryable.
 *
 * One set per page: the pane, the drawer's panel and every drill-down share it, so a refusal seen in one place is not
 * met again in another.
 */
export type DeniedDownloads = {
  /** A rerender tick: bumped on every change, for `useSyncExternalStore`. */
  version: number;
  has(videoId: string): boolean;
  /** The code that refused it: uthorization-denied and aw-host-not-allowed read differently. */
  codeOf(videoId: string): string | null;
  add(videoId: string, code?: string): void;
  /** Forget every refusal (a new identity, or a test). */
  clear(): void;
  subscribe(listener: () => void): () => void;
  ids(): readonly string[];
};

export function createDeniedDownloads(): DeniedDownloads {
  const denied = new Map<string, string>();
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  return {
    version: 0,
    has: videoId => denied.has(videoId),
    codeOf: videoId => denied.get(videoId) ?? null,
    add(videoId, code = 'authorization-denied') {
      if (denied.has(videoId)) return;
      denied.set(videoId, code);
      this.version += 1;
      changed();
    },
    clear() {
      if (!denied.size) return;
      denied.clear();
      this.version += 1;
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    ids: () => [...denied.keys()],
  };
}

/** The page's set: every material surface in one session reads and writes this one. */
export const deniedDownloads = createDeniedDownloads();
