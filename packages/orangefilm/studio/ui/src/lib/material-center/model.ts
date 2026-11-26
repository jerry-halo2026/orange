// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * A supplier row, as one card. Exactly the fields the supplier read confirmed (`videoId` plus the 13 below);
 * nothing that would resolve to a playable or downloadable file is read here.
 */
import {
  VIDEO_TYPES, wireInt, wireNumberLiteral, wireText, type MaterialPage, type OneLevelCategory,
  type TwoLevelCategory, type VideoType, type WireItem, type WireValue,
} from './contract.ts';

/** The 13 confirmed row fields a card may show. `videoUrl` and every other route to the file are not among them. */
export const CARD_FIELDS = Object.freeze([
  'coverUrl', 'downloadCount', 'collectCount', 'accountName', 'accountKey', 'createTime', 'duration',
  'fileSize', 'oneLevelVideoType', 'twoLevelVideoType', 'videoLabels', 'videoState', 'videoType',
] as const);

export type CardCategory = {readonly id: number | null; readonly name: string};
export type CardLabel = {readonly id: number | null; readonly name: string};
export type CardState = {readonly id: number | null; readonly name: string; readonly frontColor: string | null; readonly backgroundColor: string | null};

/** One material, decoded for display. `null` means the supplier sent nothing usable for that field. */
export type MaterialCard = {
  readonly videoId: string;
  /** `name` labels the card; when the supplier sends none the id stands in. Never a path, url or file name. */
  readonly title: string;
  readonly coverUrl: string | null;
  readonly downloadCount: string | null;
  readonly collectCount: string | null;
  readonly accountName: string | null;
  readonly accountKey: string | null;
  readonly createTime: string | null;
  readonly createdAtMs: number | null;
  readonly durationSeconds: number | null;
  readonly fileSizeBytes: number | null;
  readonly oneLevelVideoType: CardCategory | null;
  readonly twoLevelVideoType: CardCategory | null;
  readonly videoLabels: readonly CardLabel[];
  readonly videoState: CardState | null;
  readonly videoType: VideoType | null;
  /** The supplier can serve the original: transcoded, not recycled, with a playable url. */
  readonly downloadable: boolean;
};

/** The supplier's `yyyy-MM-dd HH:mm:ss` (local, as the supplier reports it), as a timestamp; `null` otherwise. */
export function parseCreateTime(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number) as unknown as number[];
  const at = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(at.getTime()) ? null : at.getTime();
}

function objectOf(value: WireValue | undefined): Readonly<Record<string, WireValue>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, WireValue>> & {sourceType?: unknown};
  return record.sourceType === undefined ? record : null;
}

function categoryOf(value: WireValue | undefined): CardCategory | null {
  const row = objectOf(value);
  if (!row) return null;
  const name = wireText(row.name);
  return name ? {id: wireInt(row.id), name} : null;
}

function labelsOf(value: WireValue | undefined): readonly CardLabel[] {
  if (!Array.isArray(value)) return [];
  const rows: CardLabel[] = [];
  for (const item of value) {
    const row = objectOf(item);
    const name = row ? wireText(row.name) : null;
    if (row && name) rows.push({id: wireInt(row.id), name});
  }
  return rows;
}

function stateOf(value: WireValue | undefined): CardState | null {
  const row = objectOf(value);
  if (!row) return null;
  const name = wireText(row.name);
  if (!name) return null;
  return {id: wireInt(row.id), name, frontColor: wireText(row.frontColor), backgroundColor: wireText(row.backgroundColor)};
}

function videoTypeOf(value: WireValue | undefined): VideoType | null {
  const raw = wireInt(value);
  return raw !== null && VIDEO_TYPES.some(type => type.value === raw) ? (raw as VideoType) : null;
}

/** One wire row as a card. A row the supplier sent without an id is not a card and returns `null`. */
export function decodeCard(item: WireItem): MaterialCard | null {
  const videoId = typeof item?.videoId?.value === 'string' ? item.videoId.value : '';
  if (!videoId) return null;
  const row = item.observation ?? {};
  const createTime = wireText(row.createTime);
  const title = wireText(row.name);
  return {
    videoId,
    title: title && title.trim() ? title : '素材 #' + videoId,
    coverUrl: wireText(row.coverUrl),
    downloadCount: wireNumberLiteral(row.downloadCount),
    collectCount: wireNumberLiteral(row.collectCount),
    accountName: wireText(row.accountName),
    accountKey: wireText(row.accountKey),
    createTime,
    createdAtMs: parseCreateTime(createTime),
    durationSeconds: wireInt(row.duration),
    fileSizeBytes: wireInt(row.fileSize),
    oneLevelVideoType: categoryOf(row.oneLevelVideoType),
    twoLevelVideoType: categoryOf(row.twoLevelVideoType),
    videoLabels: labelsOf(row.videoLabels),
    videoState: stateOf(row.videoState),
    videoType: videoTypeOf(row.videoType),
    downloadable: wireInt(row.state) === 2 && !wireText(row.recycleTime) && Boolean(wireText(row.videoUrl)),
  };
}

/** The cards of one page, in the order the page returned them. */
export function cardsOf(page: MaterialPage | null): readonly MaterialCard[] {
  if (!page) return [];
  const cards: MaterialCard[] = [];
  for (const item of page.items) {
    const card = decodeCard(item);
    if (card) cards.push(card);
  }
  return cards;
}

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/** How long ago a material was published, in the card's own words; the absolute date once it is a year old. */
export function relativeTime(at: number | null, now: number): string {
  if (at === null || !Number.isFinite(at)) return '时间未提供';
  const delta = now - at;
  if (delta < 0) return '刚刚';
  if (delta < MINUTE) return '刚刚';
  if (delta < HOUR) return Math.floor(delta / MINUTE) + ' 分钟前';
  if (delta < DAY) return Math.floor(delta / HOUR) + ' 小时前';
  if (delta < 30 * DAY) return Math.floor(delta / DAY) + ' 天前';
  if (delta < 365 * DAY) return Math.floor(delta / (30 * DAY)) + ' 个月前';
  const date = new Date(at);
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

/** `83` → `1:23`, `3723` → `1:02:03`; `null` stays unknown rather than showing a zero. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return '时长未知';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? hours + ':' + pad(minutes) + ':' + pad(rest) : minutes + ':' + pad(rest);
}

/** Bytes as MB with one decimal (the supplier reports bytes), `null` when the row has no size. */
export function formatFileSize(bytes: number | null): string {
  if (bytes === null || bytes < 0) return '大小未知';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** The supplier's own class name for `videoType`, so the badge says what the supplier said. */
export function videoTypeLabel(type: VideoType | null): string {
  return VIDEO_TYPES.find(entry => entry.value === type)?.label ?? '未标注类型';
}

/** The two classification badges of a card, one level each, skipping what the supplier left empty. */
export function categoryBadges(card: MaterialCard): readonly string[] {
  const badges: string[] = [];
  if (card.oneLevelVideoType) badges.push(card.oneLevelVideoType.name);
  if (card.twoLevelVideoType) badges.push(card.twoLevelVideoType.name);
  return badges;
}

/** A card's categories as the classification panel names them (used to keep the panel in step with a row). */
export function classificationOf(card: MaterialCard): {oneLevel: OneLevelCategory['id'] | null; twoLevel: TwoLevelCategory['id'] | null} {
  return {oneLevel: card.oneLevelVideoType?.id ?? null, twoLevel: card.twoLevelVideoType?.id ?? null};
}
