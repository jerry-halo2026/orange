// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * A product/label's materials by id: the supplier's `/list` takes a comma list, so a folder opens its own rows.
 * The fetch lives here, not in a card component (components never make requests).
 */
import { cardsOf, type MaterialCard } from './model';
import type { MaterialPage } from './contract';

const CHUNK = 50;
const PAGE = 100;

export type MaterialList = (query: Readonly<Record<string, string | number>>, signal?: AbortSignal) => Promise<MaterialPage>;

export type MaterialEntry = {readonly videoId: string; readonly videoType: number};

export async function loadProductCards(list: MaterialList, videoIds: readonly string[], options: {videoType?: number; scope?: unknown; entries?: readonly MaterialEntry[]} = {}): Promise<MaterialCard[]> {
  const cards = new Map<string, MaterialCard>();
  /* 有 entries 就按类型分组，一类一次请求；老索引没有类型时才逐类试探。 */
  const groups = new Map<number, string[]>();
  if (options.entries?.length) {
    for (const entry of options.entries) {
      const rows = groups.get(entry.videoType) ?? [];
      rows.push(entry.videoId);
      groups.set(entry.videoType, rows);
    }
  } else {
    for (const videoType of options.videoType === undefined ? [0, 1, 2, 3, 4] : [options.videoType]) groups.set(videoType, [...new Set(videoIds)]);
  }
  for (const [videoType, ids] of groups) {
    for (let at = 0; at < ids.length; at += CHUNK) {
      const page = await list({ scope: options.scope === 'own' ? 'own' : 'company', pageNo: 1, pageSize: PAGE, videoType, videoIds: ids.slice(at, at + CHUNK).join(',') });
      for (const card of cardsOf(page)) cards.set(card.videoId, card);
    }
  }
  return [...cards.values()].sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
}
