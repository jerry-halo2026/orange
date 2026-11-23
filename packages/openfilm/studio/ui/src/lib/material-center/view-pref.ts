// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Which of the material centre's two views is on: the dense card wall of every material (`videos`), or the
 * 批次 → 合集 → 子合集 tree (`collections`).
 *
 * 合集 is what the pane opens on: the account is organised in batches and 子合集, and a wall of 78 874 single videos is
 * not a place to start looking. The 视频 wall stays one press away, on the toggle.
 *
 * Kept on this machine (the same place the preview's switches live) so a person who works in 合集 finds 合集 the next
 * time the pane opens, and a person who switched to 视频 finds 视频. Written by the toggle alone; read at first
 * render. Storage is injected, so a test needs no browser.
 */
import {useSyncExternalStore} from 'react';

export type MaterialViewMode = 'videos' | 'collections' | 'products';

export const MATERIAL_VIEW_KEY = 'openfilm.materialView';

/** The two modes, in the order the toggle offers them. */
export const MATERIAL_VIEW_MODES = Object.freeze(['videos', 'collections', 'products'] as const);

type StorageLike = {getItem(key: string): string | null; setItem(key: string, value: string): void};

export const DEFAULT_MATERIAL_VIEW: MaterialViewMode = 'collections';

function storageOf(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The mode `raw` names, or `null` for anything else (a stored value from a future build does not decide a view). */
export function parseViewMode(raw: unknown): MaterialViewMode | null {
  return raw === 'videos' || raw === 'collections' || raw === 'products' ? raw : null;
}

export function readViewMode(storage: StorageLike | null = storageOf()): MaterialViewMode {
  if (!storage) return memory;
  try {
    return parseViewMode(storage.getItem(MATERIAL_VIEW_KEY)) ?? memory;
  } catch {
    return memory;
  }
}

export function writeViewMode(mode: MaterialViewMode, storage: StorageLike | null = storageOf()): void {
  memory = mode;
  if (storage) {
    try { storage.setItem(MATERIAL_VIEW_KEY, mode); } catch { /* not stored: this session remembers it */ }
  }
  for (const listener of listeners) listener();
}

/* Without storage the choice lasts this session; the store keeps every reader in step either way. */
let memory: MaterialViewMode = DEFAULT_MATERIAL_VIEW;
const listeners = new Set<() => void>();

export function subscribeViewMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The toggle's state wherever it is drawn: the stored mode, updated by every write. */
export function useMaterialViewMode(): MaterialViewMode {
  return useSyncExternalStore(subscribeViewMode, () => readViewMode(), () => DEFAULT_MATERIAL_VIEW);
}
