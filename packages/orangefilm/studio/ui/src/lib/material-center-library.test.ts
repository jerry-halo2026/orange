// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The one material library, held without a DOM: the cloud entry model, the sort, the cover gate and the chain a
 * download runs.
 *
 * Two rules this file now holds the *absence* of, because that is where they live:
 *  - **no local entry exists**: the open project's `assets/` and the Saved library have no builder here any more, so no
 *    list, no 合集 and no card can draw one (a name that arrives looking like a project path stays a supplier row);
 *  - **material is what is material**: a subtitle (`.vtt/.srt/.ass`) is a 字幕轨's input and never a card, and any
 *    other text file is not handled at all (`media.ts`).
 *
 * The counter-proofs live here too: a card that is not in view asks for no cover, the first screen asks for one page,
 * and a 501 from the material service leaves the catalogue saying exactly that.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Facets, MaterialPage, WireItem} from './material-center/contract.ts';
import {DEFAULT_FILTERS, narrowCards} from './material-center/filters.ts';
import type {MaterialCard} from './material-center/model.ts';
import {createMaterialCenterController} from './material-center/controller.ts';
import type {MaterialsClient} from './material-center/client.ts';
import * as library from './material-center/library.ts';
import {
  authorFrom, authorValue, cloudEntry, filteredEmptyOf, cloudReasonOf, draftSelected, libraryFolderOf, libraryView,
  sortEntries, takeMaterial, type LibraryEntry, type LibraryState,
} from './material-center/library.ts';
import {isIgnoredName, isMaterialName, isSubtitleName, mediaKindOfName} from './material-center/media.ts';
import {createCoverGate, observeOnce} from './material-center/cover.ts';
import {copyFor} from './material-center/copy.ts';
import {cloudMaterialDraft} from './material-draft.ts';
import {zhCN} from '../i18n/zh-CN.ts';
import {en} from '../i18n/en.ts';

const card = (over: Partial<MaterialCard> = {}): MaterialCard => ({
  videoId: 'v1', title: '素材 v1', coverUrl: null, downloadCount: null, collectCount: null, accountName: null,
  accountKey: null, createTime: null, createdAtMs: null, durationSeconds: null, fileSizeBytes: null,
  oneLevelVideoType: null, twoLevelVideoType: null, videoLabels: [], videoState: null, videoType: 1, ...over,
});

const page = (over: Partial<MaterialPage> = {}): MaterialPage => ({
  authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', pageNo: 1, pageSize: 2,
  items: [item('v1'), item('v2')], total: null, providerTotal: 178391, totalIsProviderTotal: true,
  filtered: {inspected: 2, dropped: 0}, grants: false, ...over,
});

const item = (id: string): WireItem => ({
  videoId: {value: id, sourceType: 'string', source: id},
  observation: {name: '素材 ' + id, accountName: '作者甲', coverUrl: '/api/materials/cover/' + id, duration: {sourceType: 'number', source: '12'}, fileSize: {sourceType: 'number', source: '2048'}, downloadCount: {sourceType: 'number', source: '3'}, createTime: '2026-11-05 10:00:00'},
});

const facets: Facets = {
  authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', videoType: 1,
  oneLevel: [{id: 11, name: '口播', level: 1, children: [{id: 21, name: '美妆', parentTypeId: 11, level: 2}]}],
  twoLevel: [{id: 21, name: '美妆', parentTypeId: 11, level: 2}], states: [{id: 1, name: '在售', frontColor: '#fff', backgroundColor: '#333'}],
  publicLabels: [{id: 5, name: '转化'}], labelTotal: null,
};

function recordingClient(answers: {list?: () => Promise<MaterialPage>} = {}) {
  const calls: string[] = [];
  const client: MaterialsClient = {
    routes: ['/list', '/facets', '/labels'],
    async list() { calls.push('list'); return answers.list ? answers.list() : page(); },
    async facets() { calls.push('facets'); return facets; },
    async labels() { calls.push('labels'); return {authorization: {layer: 'self', reason: 's'}, providerScope: 's', pageNo: 1, pageSize: 1, labels: [], total: null}; },
  };
  return {client, calls, lists: () => calls.filter(call => call === 'list').length};
}

const stateOf = (over: Partial<LibraryState> & {filters?: Partial<typeof DEFAULT_FILTERS>} = {}): LibraryState => ({
  cards: [], loading: false, failure: null, hasMore: false, pageNo: 1,
  ...over,
  filters: {...DEFAULT_FILTERS, ...(over.filters ?? {})},
});

const ids = (entries: readonly LibraryEntry[]) => entries.map(entry => entry.id);

test('a supplier row becomes the entry, its fields kept as they came', () => {
  const cloud = cloudEntry(card({coverUrl: '/api/materials/cover/abc', durationSeconds: 12, fileSizeBytes: 2048, downloadCount: '3', collectCount: '4', accountName: '作者甲', createdAtMs: Date.UTC(2026, 10, 5), videoType: 1, oneLevelVideoType: {id: 11, name: '口播'}, twoLevelVideoType: {id: 21, name: '美妆'}, videoLabels: [{id: 5, name: '转化'}], videoState: {id: 1, name: '在售', frontColor: '#fff', backgroundColor: '#333'}}));
  assert.equal(cloud.source, 'cloud');
  assert.equal(cloud.id, 'cloud:v1');
  assert.equal(cloud.name, '素材 v1');
  assert.equal(cloud.cover, '/api/materials/cover/abc', 'the cover is the url the server gave, untouched');
  assert.equal(cloud.typeLabel, '素材');
  assert.deepEqual(cloud.badges.map(badge => [badge.kind, badge.text]), [['one-level', '口播'], ['two-level', '美妆'], ['label', '转化']]);
  assert.equal(cloud.state?.name, '在售');
  assert.equal(cloud.pendingDownload, true, 'a cloud row is metadata until it is downloaded');
  assert.equal(cloud.localPath, null, 'no entry names a project path');
  assert.equal(cloud.savedPath, null, 'nor a Saved path');
  assert.equal(cloud.localKind, null, 'nor a file kind');
  assert.deepEqual(cloud.draft, cloudMaterialDraft('v1', '素材 v1'));
});

test('the builders that made an entry of a project or Saved file are gone: the source cannot produce one', () => {
  for (const name of ['localEntry', 'localEntries', 'libraryEntry', 'libraryEntries', 'localEntryMatches', 'localGroupOf', 'localKindOf']) {
    assert.equal(name in library, false, name + ' no longer exists: a caller cannot list the project or Saved as material');
  }
  /* What is left is the supplier's side, plus the one path helper the download sentence still needs. */
  for (const name of ['cloudEntry', 'cloudEntries', 'libraryView', 'sortEntries', 'takeMaterial']) {
    assert.equal(typeof (library as unknown as Record<string, unknown>)[name], 'function', name + ' is still here');
  }
  assert.equal(libraryFolderOf('saved/云素材/a.mp4'), '云素材');
  assert.equal(libraryFolderOf('saved/a.mp4'), '');
});

test('every entry is a cloud one, and no entry carries a project path or a Saved path', () => {
  /* These rows come from the supplier, not from a listing: the centre has no listing to read any more (the test above
     holds that). What they can never be is an entry of the project or of Saved — no source field, no path, no kind. */
  const rows = [
    card({videoId: 'p1', title: 'assets/组一/old.mp4'}),
    card({videoId: 'p2', title: 'film.html'}),
    card({videoId: 'p3', title: 'saved/云素材/old.mp4'}),
    card({videoId: 'p4', title: 'assets/notes.txt'}),
    card({videoId: 'p5', title: 'timeline.json'}),
    card({videoId: 'p6', title: '20261106-柠檬宝藏茶200g罐-外包装 (46)'}),
  ];
  const view = libraryView(stateOf({cards: rows}));
  assert.deepEqual(ids(view.entries), ['cloud:p1', 'cloud:p3', 'cloud:p6'],
    'the three videos are supplier rows; the page and the two text files are not material at all');
  assert.equal(view.entries.every(entry => entry.source === 'cloud'), true, 'and every entry is a cloud one');
  assert.equal(view.localCount, 0, 'the project is the drawer\'s 导入 tab, never a count of this list');
  assert.equal(view.libraryCount, 0, 'Saved is the drawer\'s 收藏 tab');
  assert.equal(view.entries.some(entry => entry.localPath !== null || entry.savedPath !== null || entry.localKind !== null), false,
    'no local path, Saved path or file kind reaches the page');
  assert.equal(view.entries.some(entry => entry.id.startsWith('local:') || entry.id.startsWith('library:')), false,
    'nor does an id that names one');
});

test('the list holds material: a video and a picture are, a subtitle and a text file are not', () => {
  /* ① The cloud list (the steward's) carries no `.vtt` — or `.srt`, `.ass`, `.txt` — row. */
  const mixed = [
    card({videoId: 'v1', title: '20261106-柠檬宝藏茶200g罐-外包装 (46)'}),
    card({videoId: 'v2', title: '20261106-柠檬宝藏茶200g罐-汤色 (8).mp4'}),
    card({videoId: 'v3', title: '外包装特写.png'}),
    card({videoId: 'v4', title: '20261106-柠檬宝藏茶200g罐-汤色 (8).vtt'}),
    card({videoId: 'v5', title: '原文字幕.srt'}),
    card({videoId: 'v6', title: '样式.ass'}),
    card({videoId: 'v7', title: '素材清单.txt'}),
    card({videoId: 'v8', title: '12.13_柠檬红茶1-冰心'}),
  ];
  const view = libraryView(stateOf({cards: mixed}));
  assert.deepEqual(ids(view.entries), ['cloud:v1', 'cloud:v2', 'cloud:v3', 'cloud:v8'],
    'the supplier\'s own names, the video, the picture and the dotted date are material; the subtitles and the text are not');
  assert.equal(view.entries.some(entry => entry.name.endsWith('.vtt')), false, 'no .vtt is in the cloud list');
  assert.equal(view.cloudCount, 4, 'and the count is the material, not the page');

  /* The classes themselves, so a later edit cannot quietly widen one. */
  assert.equal(mediaKindOfName('a.webm'), 'video');
  assert.equal(mediaKindOfName('a.avi'), 'video');
  assert.equal(mediaKindOfName('a.JPEG'), 'image');
  assert.equal(mediaKindOfName('a.vtt'), 'subtitle');
  assert.equal(mediaKindOfName('a.srt'), 'subtitle');
  assert.equal(mediaKindOfName('a.ass'), 'subtitle');
  assert.equal(mediaKindOfName('a.txt'), 'text');
  assert.equal(mediaKindOfName('20261106-柠檬宝藏茶200g罐-外包装 (46)'), 'unstated', 'no extension is the supplier\'s own naming');
  assert.equal(mediaKindOfName('12.13_柠檬红茶1-冰心'), 'unstated', 'a dot inside a name is not an extension');
  assert.equal(isMaterialName('20261106-柠檬宝藏茶200g罐-外包装 (46)'), true, 'so 78 874 rows are not emptied out');
  assert.equal(isSubtitleName('字幕.vtt'), true);
  assert.equal(isIgnoredName('备注.txt'), true);
  assert.equal(isMaterialName('备注.txt'), false);
});

test('a subtitle that lands is not added to the material list, and the sentence says where it went', () => {
  /* ② The row is a subtitle: it is not a card, before or after it landed. */
  const subtitle = card({videoId: 'v1', title: '20261106-柠檬宝藏茶200g罐-汤色 (8).vtt'});
  const view = libraryView(stateOf({cards: [subtitle, card({videoId: 'v2', title: '外包装 (3).mp4'})]}));
  assert.deepEqual(ids(view.entries), ['cloud:v2'], 'the subtitle is not a material entry');

  /* And the sentence the landing shows is in both tables, once each. */
  assert.equal(isSubtitleName(subtitle.title), true, 'the download handler branches on this');
  assert.equal(typeof zhCN.materials.subtitleAdded, 'string');
  assert.equal(typeof en.materials.subtitleAdded, 'string');
  assert.match(zhCN.materials.subtitleAdded, /字幕轨/, 'zh: it names the track it went to');
  assert.match(en.materials.subtitleAdded, /caption track/i, 'en: the same sentence');
  assert.equal(zhCN.materials.subtitleAdded === en.materials.subtitleAdded, false, 'two languages, not one string twice');
});

test('the list is the cloud catalogue: one source, no switch, and no read behind a view change', async () => {
  const recorder = recordingClient();
  const controller = createMaterialCenterController({client: recorder.client, pageSize: 2});
  await controller.refresh();
  const before = recorder.calls.length;

  const view = libraryView(controller.getState());
  assert.deepEqual(ids(view.entries), ['cloud:v1', 'cloud:v2'], 'the supplier rows are the list');
  assert.deepEqual([...view.entries.map(entry => entry.source)], ['cloud', 'cloud']);
  assert.equal(view.cloudCount, 2);
  assert.equal(view.pager, true, 'the supplier pager belongs to the supplier page');

  /* The source is a constant of the filter state now, not one of four choices: nothing can switch away from it. */
  assert.equal(DEFAULT_FILTERS.source, 'cloud', 'the centre is the cloud catalogue, always');

  /* A page-local change is a view change, not a read. */
  controller.setFilters({sort: 'downloads'});
  assert.equal(recorder.calls.length, before, 're-ordering the page in hand asks the supplier nothing');
  controller.destroy();
});

test('a material service that is not connected empties the catalogue, it does not fall back to the project', async () => {
  const recorder = recordingClient({list: async () => {
    throw Object.assign(new Error('未接通'), {status: 501, code: 'material-service-unavailable'});
  }});
  const controller = createMaterialCenterController({client: recorder.client});
  await controller.refresh();
  const state = controller.getState();
  const view = libraryView(state);
  assert.equal(state.status, 'error');
  assert.equal(view.cloud.state, 'unavailable');
  assert.equal(view.cloud.reason, 'service');
  assert.equal(view.entries.length, 0, 'the project files are not a stand-in for a catalogue that did not answer');
  assert.equal(view.empty, 'cloud-unavailable');
  assert.equal(cloudReasonOf({status: 403, code: 'authentication-required'}), 'auth');
  assert.equal(cloudReasonOf({status: 502, code: 'provider-response-unconfirmed'}), 'provider');
  assert.equal(cloudReasonOf(null), null);
  controller.destroy();
});

test('covers: nothing is asked for a card that is not in view, and each card asks once', () => {
  const asked: string[] = [];
  const gates = Array.from({length: 10}, () => createCoverGate(url => asked.push(url)));
  assert.equal(asked.length, 0, 'ten cards below the fold: zero cover requests');
  assert.deepEqual(gates.map(gate => gate.requests()), Array(10).fill(0));

  const url = '/api/materials/cover/abc';
  assert.equal(observeOnce([{isIntersecting: false}], gates[3]!, url), false);
  assert.equal(asked.length, 0, 'an observation that is not intersecting asks for nothing');
  assert.equal(observeOnce([{isIntersecting: true}], gates[3]!, url), true);
  assert.deepEqual(asked, [url], 'the url is the server\'s, used verbatim');
  assert.equal(observeOnce([{isIntersecting: true}], gates[3]!, url), false);
  assert.equal(gates[3]!.requests(), 1, 'a card already shown asks once, not once per observation');
  assert.equal(createCoverGate(() => {}).enter(null), false, 'no cover url, no request');
});

test('the first screen reads one page and never the next until the person flips it', async () => {
  const recorder = recordingClient();
  const controller = createMaterialCenterController({client: recorder.client, pageSize: 2});
  await controller.refresh();
  assert.equal(recorder.lists(), 1);
  assert.equal(controller.getState().hasMore, true, 'a full page says there is more behind it');
  const view = libraryView(controller.getState());
  assert.equal(view.pager, true);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(recorder.lists(), 1, 'no prefetch of page 2, no matter what the pager says');
  controller.setPage(2);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(recorder.lists(), 2);
  controller.destroy();
});

test('filters narrow the one list: the page-local ones cost no request, the supplier ones cost one read', async () => {
  const recorder = recordingClient();
  const controller = createMaterialCenterController({client: recorder.client, pageSize: 2});
  await controller.refresh();
  const before = recorder.calls.length;

  /* The running time is not a supplier parameter: it narrows the page in hand. */
  controller.setFilters({duration: 'under1m'});
  assert.deepEqual(ids(libraryView(controller.getState()).entries), ['cloud:v1', 'cloud:v2'], 'a band the rows are in keeps them');
  controller.setFilters({duration: 'over20m'});
  assert.equal(libraryView(controller.getState()).entries.length, 0, 'a band nobody is in narrows the page in hand to nothing');
  assert.equal(libraryView(controller.getState()).empty, 'no-cloud');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(recorder.calls.length, before, 'page-local filtering is a page-side narrowing');

  const listsBefore = recorder.lists();
  controller.setFilters({duration: 'any', stateId: 1, search: '素材'});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(recorder.lists(), listsBefore + 1, 'only the supplier parameter costs a list read');
  assert.equal(controller.getState().pageNo, 1, 'a new supplier filter starts from page one');
  controller.destroy();
});

test('the author control writes one space at a time: a supplier scope or a local project', () => {
  const cloud = authorFrom('cloud:account:ak_1');
  assert.deepEqual(cloud, {author: {accountKey: 'ak_1'}, localProject: null});
  assert.deepEqual(authorFrom('cloud:company'), {author: 'company', localProject: null});
  assert.deepEqual(authorFrom('local:p1'), {localProject: 'p1'});
  assert.equal(authorValue({...DEFAULT_FILTERS}), 'cloud:company', 'the default scope is the company view: material is company-wide');
  assert.equal(authorValue({...DEFAULT_FILTERS, localProject: 'p1'}), 'local:p1');
  assert.equal(authorValue({...DEFAULT_FILTERS, author: {accountKey: 'ak_1'}}), 'cloud:account:ak_1');
});

test('the batch draft is the one selection model the page has', () => {
  const cloud = cloudEntry(card({videoId: 'v1'}));
  assert.equal(draftSelected([], cloud), false);
  assert.equal(draftSelected([cloud.draft!], cloud), true);
  assert.equal(draftSelected([cloudMaterialDraft('v2', '素材 v2')], cloud), false, 'another material is another item');
});

test('a cloud material becomes a saved one through the host handler, then one local re-read', async () => {
  const cardRow = card({videoId: 'v9'});
  const calls: string[] = [];
  const noHandler = await takeMaterial(cardRow, {});
  assert.deepEqual(noHandler, {status: 'unavailable', relisted: false}, 'no handler: no request, and the button says so');

  const used = await takeMaterial(cardRow, {use: async row => { calls.push('use:' + row.videoId); }, relist: async () => { calls.push('relist'); }});
  assert.deepEqual(used, {status: 'used', relisted: true, result: undefined});
  assert.deepEqual(calls, ['use:v9', 'relist'], 'one handler call, then one local re-read: no other channel');

  let relisted = 0;
  await assert.rejects(
    () => takeMaterial(cardRow, {use: async () => { throw Object.assign(new Error('supplier refused'), {code: 'authorization-denied', status: 403}); }, relist: async () => { relisted += 1; }}),
    /supplier refused/,
    'a failed take keeps the handler\'s own error: the caller has to say which failure it was',
  );
  assert.equal(relisted, 0, 'a failed take does not claim to have landed anything');
});

test('the library sorts one list: newest, downloads, collects, name', () => {
  const entries = [cloudEntry(card({videoId: 'c', title: 'C', createdAtMs: Date.UTC(2026, 10, 1), downloadCount: '0'})), cloudEntry(card({videoId: 'a', title: 'B', createdAtMs: Date.UTC(2026, 10, 9), downloadCount: '1'})), cloudEntry(card({videoId: 'b', title: 'A', createdAtMs: Date.UTC(2026, 10, 10), downloadCount: '9'}))];
  assert.deepEqual(ids(sortEntries(entries, 'newest')).slice(0, 2), ['cloud:b', 'cloud:a']);
  assert.deepEqual(ids(sortEntries(entries, 'downloads')).slice(0, 2), ['cloud:b', 'cloud:a']);
  assert.equal(sortEntries(entries, 'name')[0]!.name, 'A');
  assert.equal(sortEntries(entries, 'newest').length, entries.length, 'sorting one list loses nothing');
});

test('greyed cloud dimensions are a view fact, not a broken library', () => {
  const withFacets = {...DEFAULT_FILTERS, oneLevelId: 11, stateId: 1, labelIds: [5]};
  const narrowed = narrowCards([card({oneLevelVideoType: {id: 11, name: '口播'}, videoState: {id: 1, name: '在售', frontColor: null, backgroundColor: null}, videoLabels: [{id: 5, name: '转化'}], createdAtMs: 5}), card({videoId: 'v2', oneLevelVideoType: {id: 12, name: '剧情'}})], withFacets, null);
  assert.deepEqual(narrowed.map(row => row.videoId), ['v1']);

  const view = libraryView(stateOf({cards: [card()]}));
  assert.equal(view.entries.length, 1, 'the page draws the catalogue: one row here, and the project is not added to it');
  assert.equal(view.entries[0]!.source, 'cloud');
  const copy = copyFor('zh-CN');
  assert.match(copy.cloudOffline, /未接通/);
  assert.match(copy.dimensionCloudOnly, /云端/);
});

test('a 200 whose every row was dropped is "filtered", never an outage and never a sign-in', () => {
  const copy = copyFor('zh-CN');
  const droppedAll = {...stateOf(), page: {items: [], filtered: {inspected: 2, dropped: 2}}};
  assert.deepEqual(filteredEmptyOf(droppedAll), {inspected: 2, dropped: 2});
  const view = libraryView(droppedAll);
  assert.deepEqual(view.filteredEmpty, {inspected: 2, dropped: 2});
  assert.equal(view.cloud.state, 'ok', 'a 200 is not "unavailable": the failure sentence is never reached');
  assert.equal(view.empty, 'no-cloud', 'an emptied page is an empty catalogue, not an outage');

  /* The sentences that branch shows never say "sign in" or "no permission". */
  for (const sentence of [copy.filteredEmpty(2), copy.switchToCompany]) {
    assert.equal(/登录|查看权限/.test(sentence), false, sentence);
  }
  assert.match(copy.filteredEmpty(2), /丢弃 2/);
  assert.equal(copy.switchToCompany, '切换到公司视图');

  /* Nothing dropped: that is the ordinary empty state, not a filter note. */
  assert.equal(filteredEmptyOf({...droppedAll, page: {items: [], filtered: {inspected: 2, dropped: 0}}}), null);
  /* Rows survived (even if narrowed away later): the page was not emptied by the authorization layer. */
  assert.equal(filteredEmptyOf({...droppedAll, page: {items: [{}], filtered: {inspected: 2, dropped: 1}}}), null);
});
