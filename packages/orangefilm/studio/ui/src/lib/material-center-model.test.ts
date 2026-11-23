// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {MaterialPage, WireItem, WireValue} from './material-center/contract.ts';
import {
  CARD_FIELDS, cardsOf, categoryBadges, decodeCard, formatDuration, formatFileSize, parseCreateTime,
  relativeTime, videoTypeLabel,
} from './material-center/model.ts';

const item = (observation: Record<string, WireValue> = {}, id: string | number = '2733913'):WireItem => ({
  videoId: {value: String(id), sourceType: 'number', source: String(id)},
  observation,
});

const full = () => item({
  accountKey: 'ak_abc',
  accountName: '张庆源',
  collectCount: {sourceType: 'number', source: '7'},
  coverUrl: 'https://cdn.example/cover.jpg',
  createTime: '2026-11-01 09:30:00',
  downloadCount: {sourceType: 'number', source: '1234.50'},
  duration: {sourceType: 'number', source: '83'},
  fileSize: {sourceType: 'number', source: '5242880'},
  oneLevelVideoType: {id: {sourceType: 'number', source: '11'}, level: {sourceType: 'number', source: '1'}, name: '口播', videoType: {sourceType: 'number', source: '1'}},
  twoLevelVideoType: {id: {sourceType: 'number', source: '22'}, level: {sourceType: 'number', source: '2'}, name: '美妆', parentTypeId: {sourceType: 'number', source: '11'}},
  videoLabels: [{id: {sourceType: 'number', source: '5'}, name: '高转化'}, {id: {sourceType: 'number', source: '6'}, name: '口播'}],
  videoState: {backgroundColor: '#FF4500', frontColor: '#FFFFFF', id: {sourceType: 'number', source: '201'}, isDefault: {sourceType: 'number', source: '1'}, name: '爆款'},
  videoType: {sourceType: 'number', source: '1'},
  /* present in the wire row, never read by a card: no route to the file is taken from here */
  videoUrl: 'https://supplier.example/raw.mp4',
});

test('a card reads exactly the 13 confirmed fields and keeps their supplier literals unrounded', () => {
  const card = decodeCard(full());
  assert.ok(card);
  assert.deepEqual([...CARD_FIELDS].sort(), ['accountKey', 'accountName', 'collectCount', 'coverUrl', 'createTime', 'downloadCount', 'duration', 'fileSize', 'oneLevelVideoType', 'twoLevelVideoType', 'videoLabels', 'videoState', 'videoType'].sort());
  assert.equal(card.videoId, '2733913');
  assert.equal(card.coverUrl, 'https://cdn.example/cover.jpg');
  assert.equal(card.downloadCount, '1234.50', 'the literal stays a literal: no float rounding on the way to the card');
  assert.equal(card.collectCount, '7');
  assert.equal(card.accountName, '张庆源');
  assert.equal(card.accountKey, 'ak_abc');
  assert.equal(card.createTime, '2026-11-01 09:30:00');
  assert.equal(card.durationSeconds, 83);
  assert.equal(card.fileSizeBytes, 5242880);
  assert.equal(card.oneLevelVideoType?.name, '口播');
  assert.equal(card.twoLevelVideoType?.id, 22);
  assert.deepEqual(card.videoLabels.map(label => label.name), ['高转化', '口播']);
  assert.equal(card.videoState?.name, '爆款');
  assert.equal(card.videoState?.backgroundColor, '#FF4500');
  assert.equal(card.videoType, 1);
});

test('a card never carries the supplier url, and a row without an id is not a card', () => {
  const card = decodeCard(full());
  assert.ok(card);
  assert.deepEqual(Object.keys(card).filter(key => /url/i.test(key)), ['coverUrl'], 'only the cover url is a card field');
  assert.equal(decodeCard(item({}, '')), null);
  assert.equal(decodeCard({videoId: {value: '', sourceType: 'string', source: ''}, observation: {}}), null);
});

test('a row the supplier left empty decodes to unknowns and the id stands in as the title', () => {
  const card = decodeCard(item({}, 'v-9'));
  assert.ok(card);
  assert.equal(card.title, '素材 #v-9');
  assert.equal(card.coverUrl, null);
  assert.equal(card.downloadCount, null);
  assert.equal(card.durationSeconds, null);
  assert.equal(card.oneLevelVideoType, null);
  assert.deepEqual(card.videoLabels, []);
  assert.equal(card.videoState, null);
  assert.equal(card.videoType, null, 'a type outside 0..4 is "unknown", not a made-up class');
  assert.equal(card.createdAtMs, null);
});

test('a supplier name labels the card when it has one', () => {
  const card = decodeCard(item({name: '双十一口播 A'}, 'v-1'));
  assert.ok(card);
  assert.equal(card.title, '双十一口播 A');
});

test('the relative time says what a person says, and the absolute date once it is old', () => {
  const now = new Date(2026, 10, 12, 12, 0, 0).getTime();
  const at = (delta:number) => now - delta;
  assert.equal(relativeTime(at(30_000), now), '刚刚');
  assert.equal(relativeTime(at(5 * 60_000), now), '5 分钟前');
  assert.equal(relativeTime(at(3 * 3_600_000), now), '3 小时前');
  assert.equal(relativeTime(at(4 * 86_400_000), now), '4 天前');
  assert.equal(relativeTime(at(62 * 86_400_000), now), '2 个月前');
  assert.equal(relativeTime(new Date(2024, 0, 5).getTime(), now), '2024-01-05');
  assert.equal(relativeTime(null, now), '时间未提供');
  assert.equal(relativeTime(now + 60_000, now), '刚刚', 'a clock a minute ahead is not "in the future"');
});

test('lengths, sizes and the supplier class read as a person reads them', () => {
  assert.equal(formatDuration(83), '1:23');
  assert.equal(formatDuration(3723), '1:02:03');
  assert.equal(formatDuration(null), '时长未知');
  assert.equal(formatFileSize(900), '900 B');
  assert.equal(formatFileSize(2048), '2.0 KB');
  assert.equal(formatFileSize(5242880), '5.0 MB');
  assert.equal(formatFileSize(null), '大小未知');
  assert.equal(videoTypeLabel(1), '素材');
  assert.equal(videoTypeLabel(null), '未标注类型');
  assert.equal(parseCreateTime('2026-11-01 09:30:00'), new Date(2026, 10, 1, 9, 30, 0).getTime());
  assert.equal(parseCreateTime('not a time'), null);
});

test('the two classification badges are the two levels the row carries, in order', () => {
  const card = decodeCard(full());
  assert.ok(card);
  assert.deepEqual(categoryBadges(card), ['口播', '美妆']);
  assert.deepEqual(categoryBadges(decodeCard(item({}, 'v'))!), []);
});

test('a page becomes cards in the order the page returned them', () => {
  const page = {
    authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', pageNo: 1, pageSize: 2,
    items: [item({name: 'A'}, 'a'), item({}, ''), item({name: 'B'}, 'b')],
    total: null, providerTotal: 178391, totalIsProviderTotal: true, filtered: {inspected: 3, dropped: 1}, grants: false,
  } as MaterialPage;
  assert.deepEqual(cardsOf(page).map(card => card.videoId), ['a', 'b'], 'a row with no id is dropped, not shown as an empty card');
  assert.deepEqual(cardsOf(null), []);
});
