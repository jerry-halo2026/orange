// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The four covers a product/label folder card shows: asked once per folder when its card comes into view, by the first
 * four material ids the folder already holds, through the page's own list client (launch key + contract). Cached per id
 * list; a failed read leaves the cells empty rather than retrying forever.
 */
import type { MaterialList, MaterialEntry } from './product-materials';

const cache = new Map<string, string[]>();
const waiting = new Map<string, Promise<string[]>>();

export function cachedCovers(key: string): readonly string[] | null {
  return cache.get(key) ?? null;
}

export async function loadCovers(list: MaterialList, key: string, videoIds: readonly string[], entries?: readonly MaterialEntry[]): Promise<readonly string[]> {
  const hit = cache.get(key);
  if (hit) return hit;
  const ids = [...new Set(videoIds)].slice(0, 4);
  if (!ids.length) { cache.set(key, []); return []; }
  const running = waiting.get(key);
  if (running) return running;
  const job = (async () => {
    try {
      const urls: string[] = [];
      const groups = new Map<number, string[]>();
      if (entries?.length) {
        for (const entry of entries.slice(0, 8)) {
          const rows = groups.get(entry.videoType) ?? [];
          rows.push(entry.videoId);
          groups.set(entry.videoType, rows);
        }
      } else {
        for (const videoType of [0, 1, 2, 3, 4]) groups.set(videoType, ids);
      }
      for (const [videoType, groupIds] of groups) {
        if (urls.length >= 4) break;
        const page = await list({ scope: 'company', pageNo: 1, pageSize: 4, videoType, videoIds: groupIds.slice(0, 4).join(',') });
        for (const item of page.items) {
          const url = (item as { observation?: { coverUrl?: unknown } })?.observation?.coverUrl;
          if (typeof url === 'string' && url && !urls.includes(url)) urls.push(url);
        }
      }
      cache.set(key, urls.slice(0, 4));
      return urls.slice(0, 4);
    } catch {
      cache.set(key, []);
      return [];
    } finally {
      waiting.delete(key);
    }
  })();
  waiting.set(key, job);
  return job;
}
