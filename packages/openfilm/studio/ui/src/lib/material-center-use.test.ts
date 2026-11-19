// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The last link of the library: a click on a cloud card's use/download button really takes the material into the open
 * project's `assets/`, and says why when it cannot.
 *
 * Held here without a DOM or a network: a counting fetch stands in for `POST /api/materials/raw`, the listing is a
 * plain array, and every counter-proof (one request per click, none for a hover, no re-read after a refusal) is an
 * assertion rather than a hope.
 */
import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {Facets, MaterialPage, WireItem} from './material-center/contract.ts';
import type {MaterialsClient} from './material-center/client.ts';
import {createMaterialCenterController} from './material-center/controller.ts';
import {copyFor, downloadNotice, takeFailureCopy, useFailureCopy} from './material-center/copy.ts';
import {libraryView, projectTakeGate, takeMaterial, takeSavedIntoProject} from './material-center/library.ts';
import type {MaterialCard} from './material-center/model.ts';
import {deniedDownloads} from './material-center/denied.ts';
import {createMaterialUse, createSpendNotice, RAW_USE_ROUTE, useFailureKind, useFailureKindOf} from './material-center/use-material.ts';

const zh = copyFor('zh-CN');
/* The refusal set is the session's: a test that meets a 403 must not colour the next one. */
beforeEach(() => deniedDownloads.clear());
const LANDED = 'saved/云素材/下载-1.mp4';
const okBody = {landed: LANDED, reused: false, sha256: 'a'.repeat(64), bytes: 2048};

type Step = {status?: number; body?: unknown; reject?: Error};

/** A fetch that records the call and answers from a list of steps (the last one repeats). */
function recordingFetch(steps: Step[] = [{}]) {
  const calls: {url: string; init: RequestInit | undefined}[] = [];
  let index = 0;
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({url, init});
    const step = steps[Math.min(index, steps.length - 1)] ?? {};
    index += 1;
    if (step.reject) throw step.reject;
    return new Response(JSON.stringify(step.body ?? okBody), {status: step.status ?? 200, headers: {'content-type': 'application/json'}});
  };
  return {fetcher, calls, bodyOf: (at = 0) => JSON.parse(String(calls[at]?.init?.body ?? '{}'))};
}

const item = (id: string, observation: Record<string, unknown> = {}): WireItem => ({
  videoId: {value: id, sourceType: 'string', source: id},
  observation: {name: '素材 ' + id, accountName: '作者甲', videoType: {sourceType: 'number', source: '2'}, ...observation},
});

const page = (items: WireItem[]): MaterialPage => ({
  authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', pageNo: 1, pageSize: 20,
  items, total: null, providerTotal: null, totalIsProviderTotal: true, filtered: {inspected: items.length, dropped: 0}, grants: false,
});

const facets: Facets = {
  authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', videoType: 1,
  oneLevel: [], twoLevel: [], states: [], publicLabels: [], labelTotal: null,
};

const listingClient = (items: WireItem[]): MaterialsClient => ({
  routes: ['/list', '/facets', '/labels'],
  async list() { return page(items); },
  async facets() { return facets; },
  async labels() { return {authorization: {layer: 'self', reason: 's'}, providerScope: 's', pageNo: 1, pageSize: 1, labels: [], total: null}; },
});

const localFile = (path: string, mtime = Date.UTC(2026, 10, 1)) => ({path, kind: 'video', size: 1024, mtime});

const card = (over: Partial<MaterialCard> = {}): MaterialCard => ({
  videoId: 'v1', title: '素材 v1', coverUrl: null, downloadCount: null, collectCount: null, accountName: null,
  accountKey: null, createTime: null, createdAtMs: null, durationSeconds: null, fileSizeBytes: null,
  oneLevelVideoType: null, twoLevelVideoType: null, videoLabels: [], videoState: null, videoType: 1, ...over,
});

test('the raw route is called once, with the card\'s id and its supplier class', async () => {
  const recorder = recordingFetch();
  const use = createMaterialUse({fetch: recorder.fetcher});
  const result = await use(card({videoId: 'v1', videoType: 2}));
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0]!.url, RAW_USE_ROUTE);
  assert.equal(recorder.calls[0]!.init?.method, 'POST');
  assert.deepEqual(recorder.bodyOf(), {videoId: 'v1', videoType: 2}, 'the class travels with the id: the upstream finds the grant by it');
  assert.equal((recorder.calls[0]!.init?.headers as Record<string, string>)['content-type'], 'application/json');
  assert.equal(recorder.calls[0]!.init?.credentials, 'same-origin', 'the Studio session cookie is the authorization');
  assert.deepEqual(result, {landed: LANDED, reused: false, sha256: 'a'.repeat(64), bytes: 2048}, 'the landing is the saved/ path (§9), not a project one');

  const noClass = recordingFetch();
  await createMaterialUse({fetch: noClass.fetcher})(card({videoId: 'v2', videoType: null}));
  assert.deepEqual(noClass.bodyOf(), {videoId: 'v2'}, 'a card without a class sends none: the route\'s default is 1');
});

test('a download the library already had is `reused`: it is a success and nothing was downloaded again', async () => {
  const recorder = recordingFetch([{status: 200, body: {...okBody, reused: true}}]);
  const result = await createMaterialUse({fetch: recorder.fetcher})(card());
  assert.equal(result.reused, true);
  assert.equal(downloadNotice(zh, result.reused), zh.useAlreadyInLibrary, 'the page says "already in the library", not "downloaded"');
  assert.notEqual(downloadNotice(zh, true), downloadNotice(zh, false));
  assert.equal(downloadNotice(zh, false), zh.useLandedInLibrary);
  assert.equal(recorder.calls.length, 1, 'a reused answer is still one request — and no supplier download was spent');
});

test('an older server that answers a list of project paths still reads as a landing', async () => {
  const recorder = recordingFetch([{status: 200, body: {landed: [{path: 'assets/a.mp4'}, {path: 'assets/b.mp4'}], sha256: 'b'.repeat(64), bytes: 4096}}]);
  const result = await createMaterialUse({fetch: recorder.fetcher})(card());
  assert.deepEqual(result, {landed: 'assets/a.mp4', reused: false, sha256: 'b'.repeat(64), bytes: 4096});
});

test('every failure the route can name is classified, and the sentence follows the class', async () => {
  const cases: Array<[number, string, string, string]> = [
    [401, 'internal-error', 'auth', zh.authRequired],
    [401, 'authentication-required', 'auth', zh.authRequired],
    [501, 'material-service-unavailable', 'unavailable', zh.useUnavailable],
    [403, 'authorization-denied', 'forbidden', zh.useForbidden],
    [403, 'raw-host-not-allowed', 'forbidden', zh.useStorageBlocked],
    [403, 'authentication-required', 'auth', zh.authRequired],
    [504, 'material-upstream-timeout', 'timeout', zh.useTimeout],
    [413, 'raw-too-large', 'unsupported', zh.useUnsupported],
    [422, 'raw-type-not-allowed', 'unsupported', zh.useUnsupported],
    [404, 'project-not-found', 'unavailable', zh.useNeedsNoProject],
    [500, 'staging-write-failed', 'failed', zh.useFailed],
    [405, 'method-not-allowed', 'failed', zh.useFailed],
  ];
  for (const [status, code, kind, sentence] of cases) {
    deniedDownloads.clear();
    const recorder = recordingFetch([{status, body: {code, message: 'synthetic ' + code}}]);
    const use = createMaterialUse({fetch: recorder.fetcher});
    await assert.rejects(() => use(card()), (error: {code?: string; status?: number; kind?: string}) => {
      assert.equal(error.status, status, code);
      assert.equal(error.code, code);
      assert.equal(error.kind, kind, code + ' is a ' + kind);
      assert.equal(useFailureKind(error), kind);
      return true;
    });
    assert.equal(useFailureCopy(zh, kind as never, code), kind === 'failed' ? sentence + '（' + code + '）' : sentence, code);
  }
  assert.equal(useFailureKindOf(504, 'material-upstream-timeout'), 'timeout');
  assert.equal(useFailureKindOf(500, 'staging-write-failed'), 'failed');
});

test('a service that is not reachable, or an answer that is not a landing, is a failure with its own class', async () => {
  const down = recordingFetch([{reject: Object.assign(new Error('ECONNREFUSED'), {code: 'ECONNREFUSED'})}]);
  await assert.rejects(() => createMaterialUse({fetch: down.fetcher})(card()), (error: {kind?: string}) => error.kind === 'unavailable');
  assert.equal(useFailureCopy(zh, 'unavailable'), zh.useUnavailable);

  for (const body of [{}, {landed: ''}, {landed: 'x'}, {landed: 'saved/../x.mp4'}, {landed: []}, {landed: [{}]}, {landed: [{path: ''}]}]) {
    const recorder = recordingFetch([{status: 200, body}]);
    await assert.rejects(() => createMaterialUse({fetch: recorder.fetcher})(card()), (error: {kind?: string; code?: string}) => error.kind === 'failed');
  }
  const slow = recordingFetch([{reject: Object.assign(new Error('aborted'), {name: 'AbortError'})}]);
  await assert.rejects(() => createMaterialUse({fetch: slow.fetcher, timeoutMs: 5})(card()), (error: {kind?: string}) => error.kind === 'timeout');
});

test('one click: one route call, one library re-read, and the material lands in Saved', async () => {
  const recorder = recordingFetch();
  const use = createMaterialUse({fetch: recorder.fetcher});
  const library = [localFile('saved/云素材/old.mp4')];
  let relisted = 0;
  const relist = async () => {
    relisted += 1;
    /* what the server just landed in Saved, as its listing would read it */
    library.push(localFile(okBody.landed, Date.UTC(2026, 10, 9)));
  };
  const controller = createMaterialCenterController({
    client: listingClient([item('v1'), item('v2')]),
    onUse: async row => {
      const outcome = await takeMaterial(row, {use, relist});
      return {notice: downloadNotice(zh, (outcome.result as {reused: boolean}).reused)};
    },
  });
  await controller.refresh();
  assert.equal(controller.getState().cards.length, 2);

  await controller.use('v1');
  assert.equal(recorder.calls.length, 1, 'one click is one request');
  assert.equal(relisted, 1, 'and one library re-read');
  assert.equal(controller.getState().useNotice, zh.useLandedInLibrary, 'a fresh download says where it went');
  assert.equal(controller.getState().useError, null);

  /* The catalogue is the one list this page draws: the download shows up in the Saved listing the 收藏 tab reads, and
     never as a row of the cloud page. */
  const view = libraryView(controller.getState());
  assert.deepEqual(view.entries.map(entry => entry.id), ['cloud:v1', 'cloud:v2'], 'the supplier page is still the page');
  assert.equal(view.entries.some(entry => entry.source !== 'cloud'), false, 'neither the project nor Saved is merged into the catalogue');
  assert.equal(library.some(file => file.path === LANDED), true, 'the downloaded material is in the Saved listing the drawer reads');
  assert.ok(view.entries.some(entry => entry.id === 'cloud:v1'), 'the supplier row stays, marked as not downloaded');
  controller.destroy();
});

test('two clicks at once: one request, and the button is held while it is out', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    await gate;
    return new Response(JSON.stringify(okBody), {status: 200, headers: {'content-type': 'application/json'}});
  };
  let relisted = 0;
  const controller = createMaterialCenterController({
    client: listingClient([item('v1')]),
    onUse: async row => { await takeMaterial(row, {use: createMaterialUse({fetch: fetcher}), relist: async () => { relisted += 1; }}); },
  });
  await controller.refresh();
  const first = controller.use('v1');
  const second = controller.use('v1');
  await second;
  assert.equal(calls, 1, 'the second click while the first is unanswered is not a second download');
  assert.equal(controller.getState().usePending, 'v1', 'the card shows progress, and its button is disabled meanwhile');
  release();
  await first;
  assert.equal(calls, 1);
  assert.equal(relisted, 1);
  assert.equal(controller.getState().usePending, null);
  controller.destroy();
});

test('a refusal is said, classified, and never re-reads the listing', async () => {
  for (const [status, code, kind, sentence] of [
    [403, 'authorization-denied', 'forbidden', zh.useForbidden],
    [504, 'material-upstream-timeout', 'timeout', zh.useTimeout],
    [413, 'raw-too-large', 'unsupported', zh.useUnsupported],
    [500, 'staging-write-failed', 'failed', zh.useFailed],
  ] as const) {
    deniedDownloads.clear();
    const recorder = recordingFetch([{status, body: {code}}]);
    let relisted = 0;
    const controller = createMaterialCenterController({
      client: listingClient([item('v1')]),
      onUse: async row => { await takeMaterial(row, {use: createMaterialUse({fetch: recorder.fetcher}), relist: async () => { relisted += 1; }}); },
    });
    await controller.refresh();
    await controller.use('v1');
    const state = controller.getState();
    assert.equal(state.usePending, null);
    assert.equal(state.useNotice, null, 'a failure is not announced as a success');
    assert.equal(state.useError?.kind, kind);
    assert.equal(state.useError?.code, code);
    assert.equal(state.lastUse, 'v1', 'the retry button knows what to repeat');
    assert.equal(relisted, 0, 'a refusal lands nothing, so the local listing is not read again');
    assert.equal(useFailureCopy(zh, state.useError?.kind, state.useError?.code), kind === 'failed' ? sentence + '（' + code + '）' : sentence);
    controller.destroy();
  }
});

test('retry is the person\'s own action: one more request, then the material is in the library', async () => {
  const recorder = recordingFetch([{status: 500, body: {code: 'staging-write-failed'}}, {}]);
  const library = [localFile('saved/云素材/old.mp4')];
  let relisted = 0;
  const controller = createMaterialCenterController({
    client: listingClient([item('v1')]),
    onUse: async row => {
      const outcome = await takeMaterial(row, {
        use: createMaterialUse({fetch: recorder.fetcher}),
        relist: async () => { relisted += 1; library.push(localFile(okBody.landed)); },
      });
      return {notice: downloadNotice(zh, (outcome.result as {reused: boolean}).reused)};
    },
  });
  await controller.refresh();
  await controller.use('v1');
  assert.equal(controller.getState().useError?.kind, 'failed');
  const retry = controller.getState().lastUse!;
  await controller.use(retry);
  assert.equal(recorder.calls.length, 2, 'the retry is one more request, not a repeat of the first');
  assert.equal(relisted, 1);
  assert.equal(controller.getState().useError, null);
  assert.equal(controller.getState().useNotice, zh.useLandedInLibrary);
  assert.equal(libraryView(controller.getState()).entries.some(entry => entry.source !== 'cloud'), false, 'the retry lands in Saved, not in the cloud page');
  assert.equal(library.some(file => file.path === LANDED), true, 'and the Saved listing the 收藏 tab reads has it');
  controller.destroy();
});

test('looking at a card is still free: a hover asks for no download at all', async () => {
  const recorder = recordingFetch();
  const controller = createMaterialCenterController({
    client: listingClient([item('v1')]),
    onUse: async row => { await createMaterialUse({fetch: recorder.fetcher})(row); },
  });
  await controller.refresh();
  controller.hover('v1');
  controller.hover(null);
  controller.hover('v1');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(recorder.calls.length, 0, 'a hover never reaches the download route');
  controller.destroy();
});

test('the sentence about a real download is said once per session, not every time', () => {
  const store = new Map<string, string>();
  const storage = {getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }};
  const first = createSpendNotice(storage);
  assert.equal(first.shouldShow(), true, 'before the first download the person is told what it costs');
  first.dismiss();
  assert.equal(first.shouldShow(), false);
  assert.equal(createSpendNotice(storage).shouldShow(), false, 'a new page in the same session does not repeat the dialog');
  assert.equal(createSpendNotice({getItem: () => null, setItem: () => {}}).shouldShow(), true, 'a fresh session says it again');
  assert.equal(createSpendNotice(null).shouldShow(), true, 'with no storage the sentence is shown rather than silently dropped');
});

test('a download names no project, and a server that still asks for one is a version mismatch, not a failure', async () => {
  /* Even with a project open and a listing that belongs to it, the body carries no project: the action lands in the
     library, so the list the person sees can never be another project's than the one the server happened to open. */
  /* A project is open and a listing of its own files is at hand; the body still names no project. The centre builds no
     entry from a project's files any more (`library.ts` has no local builder left), which is the stronger form of the
     same rule: there is no list of them to be the wrong one. */
  const listing = ['assets/组一/old.mp4'];
  assert.equal(listing[0]!.startsWith('assets/'), true, 'the test is about a download made with a project known');

  const recorder = recordingFetch();
  const use = createMaterialUse({fetch: recorder.fetcher});
  await use(card({videoId: 'v1', videoType: 2}));
  const body = recorder.bodyOf();
  assert.deepEqual(Object.keys(body).sort(), ['videoId', 'videoType'], 'the id and its class, nothing about a project');
  assert.equal('projectId' in body, false, 'no projectId while a project is open');
  await use(card({videoId: 'v2', videoType: null}));
  assert.deepEqual(Object.keys(recorder.bodyOf(1)), ['videoId'], 'and none without one either');

  const source = readFileSync(new URL('./material-center/use-material.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('projectId'), false, 'the module has no way to name a project at all');

  /* A 404 project-not-found is a server on the older contract: say so, instead of a bare "failed". */
  const mismatch = recordingFetch([{status: 404, body: {code: 'project-not-found'}}]);
  await assert.rejects(() => createMaterialUse({fetch: mismatch.fetcher})(card()), (error: {kind?: string; code?: string}) => {
    assert.equal(error.kind, 'unavailable', 'not the unknown class');
    assert.equal(error.code, 'project-not-found');
    return true;
  });
  assert.equal(useFailureCopy(zh, 'unavailable', 'project-not-found'), zh.useNeedsNoProject);
  assert.notEqual(zh.useNeedsNoProject, zh.useFailed);
  assert.match(zh.useNeedsNoProject, /工程/);
  assert.equal(useFailureCopy(zh, 'unavailable', 'material-service-unavailable'), zh.useUnavailable, 'a service that is down keeps its own sentence');
});

test('adding to the project is refused without one, and one call with one', async () => {
  const refused = projectTakeGate({projectId: null});
  assert.equal(refused.enabled, false);
  assert.equal(refused.reason, 'no-project');
  let calls = 0;
  const outcome = await takeSavedIntoProject(LANDED, {gate: refused, take: async () => { calls += 1; }});
  assert.deepEqual(outcome, {status: 'refused', reason: 'no-project'});
  assert.equal(calls, 0, 'a disabled action makes no request at all');
  assert.equal(takeFailureCopy(zh, 'failed', 'take-failed'), zh.takeFailed + '（take-failed）');

  const open = projectTakeGate({projectId: 'p1'});
  assert.deepEqual(open, {enabled: true, reason: null});
  const taken = await takeSavedIntoProject(LANDED, {gate: open, take: async path => { calls += 1; assert.equal(path, LANDED); }});
  assert.deepEqual(taken, {status: 'taken'});
  assert.equal(calls, 1, 'one click, one native take');
});

test('a signed-out or not-connected library greys the project action, with its own reason', () => {
  assert.deepEqual(projectTakeGate({projectId: 'p1', signedOut: true}), {enabled: false, reason: 'signed-out'});
  assert.deepEqual(projectTakeGate({projectId: 'p1', serviceDown: true}), {enabled: false, reason: 'service'});
  assert.equal(projectTakeGate({projectId: null, signedOut: true}).reason, 'no-project', 'no project is the first thing to fix');
});

test('a failed add-to-project is classified and says so in the project\'s own words', async () => {
  const cases: Array<[number, string, string, string]> = [
    [401, 'internal-error', 'auth', zh.authRequired],
    [401, 'authentication-required', 'auth', zh.authRequired],
    [503, 'material-service-unavailable', 'unavailable', zh.takeUnavailable],
    [403, 'authorization-denied', 'forbidden', zh.takeForbidden],
    [403, 'authentication-required', 'auth', zh.authRequired],
    [504, 'material-upstream-timeout', 'timeout', zh.takeTimeout],
    [409, 'not-a-file', 'failed', zh.takeFailed],
  ];
  for (const [status, code, kind, sentence] of cases) {
    const error = Object.assign(new Error(code), {status, body: {code}});
    assert.equal(useFailureKind(error), kind);
    assert.equal(takeFailureCopy(zh, kind as never, code), kind === 'failed' ? sentence + '（' + code + '）' : sentence);
  }
});

test('a 401 says "sign in" at the download and at the add-to-project point, never internal-error', () => {
  const expired = Object.assign(new Error('studio answered 401'), {status: 401, body: {code: 'internal-error'}});
  assert.equal(useFailureKind(expired), 'auth');
  assert.equal(useFailureCopy(zh, useFailureKind(expired), 'internal-error'), zh.authRequired);
  assert.equal(takeFailureCopy(zh, useFailureKind(expired), 'internal-error'), zh.authRequired);
  for (const sentence of [zh.authRequired]) {
    assert.notEqual(sentence, zh.useFailed);
    assert.notEqual(sentence, zh.takeFailed);
    assert.equal(sentence.includes('internal-error'), false);
  }
  /* A status with no code at all still reads as "sign in". */
  assert.equal(useFailureKind({status: 401}), 'auth');
  assert.equal(useFailureKindOf(401, ''), 'auth');
  assert.equal(useFailureKindOf(403, 'authentication-required'), 'auth', 'the code wins over a plain 403 at this point too');
});
