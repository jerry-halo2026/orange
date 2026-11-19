// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * A clip whose file is still coming: what the timeline draws on it while it is, and how it stops saying it.
 *
 * Dropping a 素材 on a track used to write a clip and leave it there, and the clip sat with a grey cover until the file's
 * pictures were shot — indistinguishable from a clip that will never play. So the drop is a state on the clip itself:
 *
 *   downloading → the cover the material already had (a supplier cover, else nothing yet), a turning ring and
 *                 「正在下载」 over the picture band;
 *   ready       → the file is here: its own first frame / thumbnails take the band, and the words stop. The state is kept
 *                 for {@link DOWNLOAD_READY_MS} so a run (or a person blinking) can see it became ready; then it goes and
 *                 the clip is an ordinary clip;
 *   failed      → a red line with a short reason, kept for {@link DOWNLOAD_FAILED_MS}: never an endless spinner.
 *
 * Keyed by the clip's `src`, because that is what the timeline has when it draws a block. A placeholder drawn where the
 * clip will land may have a stand-in `src` of its own (the material id before a file exists): `settleDownload` moves the
 * ready state from the stand-in onto the real src in one step, so the placeholder disappearing and the real clip
 * appearing never shows a gap.
 *
 * A session store, like `denied.ts`: no network, no storage, no React. Timers only remove an entry.
 */
export type ClipDownloadState = 'downloading' | 'ready' | 'failed';

export type ClipDownload = {
  readonly state: ClipDownloadState;
  /** The picture already known for this clip (a material's supplier cover); absent when there is none yet. */
  readonly cover?: string;
  /** Why a failed download failed, in the shortest words that are still true (`无权下载`, `下载超时`). */
  readonly reason?: string;
};

/** How long "it landed" stays on the clip. Long enough to be seen, short enough not to be part of the clip. */
export const DOWNLOAD_READY_MS = 2500;
/** How long a failure stays on the clip: it is the only place the reason is, so it is read before it goes. */
export const DOWNLOAD_FAILED_MS = 8000;

type Timer = ReturnType<typeof setTimeout>;

let entries: ReadonlyMap<string, ClipDownload> = new Map();
const listeners = new Set<() => void>();
const timers = new Map<string, Timer>();

const publish = (next: ReadonlyMap<string, ClipDownload>): void => {
  entries = next;
  for (const listener of listeners) listener();
};

const stopTimer = (src: string): void => {
  const timer = timers.get(src);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(src);
};

/** Remove one entry (a state that has said what it had to say). */
const drop = (src: string): void => {
  stopTimer(src);
  if (!entries.has(src)) return;
  const next = new Map(entries);
  next.delete(src);
  publish(next);
};

const put = (src: string, entry: ClipDownload): void => {
  stopTimer(src);
  const next = new Map(entries);
  next.set(src, entry);
  publish(next);
};

/** A state that is not a download in flight goes by itself: a clip never keeps a badge it no longer needs. */
const forgetLater = (src: string, ms: number): void => {
  const timer = setTimeout(() => {
    timers.delete(src);
    drop(src);
  }, ms);
  /* a Node timer would hold a test process open at the end of a run; a browser timer has no such call */
  (timer as unknown as {unref?: () => void}).unref?.();
  timers.set(src, timer);
};

/** A drop that has to fetch its file: the clip is downloading from this moment. */
export function beginDownload(src: string, options: {readonly cover?: string | null} = {}): void {
  if (!src) return;
  const cover = options.cover;
  put(src, {state: 'downloading', ...(typeof cover === 'string' && cover ? {cover} : {})});
}

/**
 * The file arrived. `to` is the src the clip really has once written: when it differs from `from` (a stand-in placed at
 * drop time), the stand-in stops saying anything and the real clip says it landed — in one change, so nothing on screen
 * shows a moment where neither does.
 */
export function settleDownload(from: string, to: string = from): void {
  if (!to) return;
  stopTimer(from);
  stopTimer(to);
  const next = new Map(entries);
  if (from) next.delete(from);
  next.set(to, {state: 'ready'});
  publish(next);
  forgetLater(to, DOWNLOAD_READY_MS);
}

/** The fetch failed: the clip says why, then goes back to being an ordinary (unplayable) clip. */
export function failDownload(src: string, reason: string): void {
  if (!src) return;
  put(src, {state: 'failed', ...(reason ? {reason} : {})});
  forgetLater(src, DOWNLOAD_FAILED_MS);
}

/** What the clip with this src is doing, if anything. */
export function downloadOf(src: string | null | undefined): ClipDownload | undefined {
  return src ? entries.get(src) : undefined;
}

/** Every clip that is downloading, has just landed, or failed — as one object, for `useSyncExternalStore`. */
export function downloadsOf(): ReadonlyMap<string, ClipDownload> {
  return entries;
}

export function subscribeDownloads(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forget every entry (a test's own start; a reloaded page starts empty anyway). */
export function resetDownloads(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  publish(new Map());
}
