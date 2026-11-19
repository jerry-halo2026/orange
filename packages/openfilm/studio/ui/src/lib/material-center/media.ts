// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * What a name says it is — and what the material centre is allowed to hold.
 *
 * The rules the operator set, and why each one is a rule:
 *  - **a video or a picture is material** (`mp4/mov/mkv/webm/avi`, `png/jpg/jpeg/webp`): that is what a card, a batch
 *    and a 合集 hold;
 *  - **a subtitle is not material** (`.vtt/.srt/.ass`): it is the input of a 字幕轨. A person importing one gets a
 *    subtitle track, not a card among the pictures;
 *  - **any other text is not handled at all** (`.txt` and its neighbours): it is neither material nor a subtitle, so it
 *    is dropped rather than drawn with no way to use it.
 *
 * A name with **no extension, or one nobody here knows, is material**: the supplier's own names are
 * `20261106-柠檬宝藏茶200g罐-外包装 (46)`, and their class is the supplier's `videoType`, not a suffix. Reading a suffix
 * that is not there as "not material" would empty the whole account, which is the failure this module must not have.
 */

export const VIDEO_EXTENSIONS = Object.freeze(['mp4', 'mov', 'mkv', 'webm', 'avi']);
export const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp']);
export const SUBTITLE_EXTENSIONS = Object.freeze(['vtt', 'srt', 'ass']);
/** Text that is neither material nor a subtitle: not handled, so never listed. */
export const TEXT_EXTENSIONS = Object.freeze([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yml', 'yaml', 'html', 'htm', 'rtf', 'ini', 'cfg', 'conf',
]);

/** What one name is. `unstated` is "no extension, or none of ours" — the supplier's own names, and a material. */
export type MediaKind = 'video' | 'image' | 'subtitle' | 'text' | 'unstated';

/**
 * The extension of a name or a path (`saved/云素材/a.MP4` → `mp4`), or `''`. A dot inside a name is not an extension:
 * `12.13_柠檬红茶1-冰心` and `陈莉莉_1.22柠檬红茶_3` carry no suffix, and must not be read as one.
 */
export function mediaExtension(name: string): string {
  const base = (name ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  const match = /\.([a-z0-9]{1,8})$/i.exec(base);
  return match ? match[1]!.toLowerCase() : '';
}

export function mediaKindOfName(name: string): MediaKind {
  const extension = mediaExtension(name);
  if (!extension) return 'unstated';
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(extension)) return 'video';
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return 'image';
  if ((SUBTITLE_EXTENSIONS as readonly string[]).includes(extension)) return 'subtitle';
  if ((TEXT_EXTENSIONS as readonly string[]).includes(extension)) return 'text';
  return 'unstated';
}

/** Whether this name may stand in the material centre and in the 合集 tree: a video, a picture, or the supplier's own. */
export function isMaterialName(name: string): boolean {
  const kind = mediaKindOfName(name);
  return kind === 'video' || kind === 'image' || kind === 'unstated';
}

/** Whether this name is a subtitle track's input: it goes to 字幕轨, never to the material list. */
export function isSubtitleName(name: string): boolean {
  return mediaKindOfName(name) === 'subtitle';
}

/** Whether this name is text neither the material list nor the subtitle tracks handle. */
export function isIgnoredName(name: string): boolean {
  return mediaKindOfName(name) === 'text';
}
