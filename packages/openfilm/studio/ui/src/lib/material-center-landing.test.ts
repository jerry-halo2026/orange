// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The hop that used to be missing: a download landed in Saved and stayed there, while the drawer's 导入 tab lists only
 * the open project's `assets/` — so the material a person had just downloaded was in no list they could use it from.
 *
 * Held here without a DOM: a fetch stands in for `POST /api/materials/raw` (answering what the real route answers, a
 * `saved/云素材/<id>.mov` landing), the take stands in for `POST /api/<project>/saved/take`, and the project listing is
 * a plain array — the same array `api.files(project)` fills for 导入. What is asserted is the hop itself: the take is
 * asked for **the file the download landed**, the list 导入 reads then holds it, and every failure of that hop leaves
 * the download's own result standing instead of turning it into a second failure sentence.
 */
import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {copyFor, downloadNotice} from './material-center/copy.ts';
import {landDownloadInProject, takeMaterial} from './material-center/library.ts';
import {deniedDownloads} from './material-center/denied.ts';
import {createMaterialUse} from './material-center/use-material.ts';
import type {MaterialCard} from './material-center/model.ts';

const zh = copyFor('zh-CN');
beforeEach(() => deniedDownloads.clear());

/** What the Studio's raw route answers for one real download (the bytes of video 34891190). */
const LANDED = 'saved/云素材/34891190.mov';
const BYTES = 4_797_242;
const okBody = {landed: LANDED, reused: false, sha256: 'c'.repeat(64), bytes: BYTES};

const card = (over: Partial<MaterialCard> = {}): MaterialCard => ({
  videoId: '34891190', title: 'Z*包装展示_5', coverUrl: null, downloadCount: null, collectCount: null, accountName: null,
  accountKey: null, createTime: null, createdAtMs: null, durationSeconds: null, fileSizeBytes: null,
  oneLevelVideoType: null, twoLevelVideoType: null, videoLabels: [], videoState: null, videoType: 1, ...over,
});

/** A fetch that records what was sent and answers with the raw route's landing. */
function recordingFetch(body: unknown = okBody) {
  const calls: {url: string; body: Record<string, unknown>}[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>});
    return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
  };
  return {fetcher, calls};
}

/** The `assets/` of a project, as `api.files(project)` lists it — the one source the 导入 tab draws. */
type ProjectFile = {path: string; kind: string; size: number; mtime: number};
const importList = (files: ProjectFile[]) => files;

test('a download that lands in Saved is taken into the open project, and 导入 lists the file', async () => {
  const recorder = recordingFetch();
  const assets: ProjectFile[] = [];
  const at = Date.UTC(2026, 10, 16);
  let savedRelists = 0;
  let projectRelists = 0;

  const use = createMaterialUse({fetch: recorder.fetcher});
  const outcome = await takeMaterial(card(), {use, relist: async () => { savedRelists += 1; }});
  assert.equal(savedRelists, 1, 'the Saved listing is read again after the download');
  assert.equal(recorder.calls[0]!.url, '/api/materials/raw', 'the click asked the Studio origin, not the supplier');

  const result = outcome.result as {landed: string; bytes: number};
  const hop = await landDownloadInProject(result.landed, {
    projectId: 'P08',
    take: async path => {
      assert.equal(path, LANDED, 'the take names the file the download landed, never the supplier id');
      assets.push({path: 'assets/34891190.mov', kind: 'video', size: BYTES, mtime: at});
      return {path: 'assets/34891190.mov'};
    },
    relist: async () => { projectRelists += 1; },
  });
  assert.deepEqual(hop, {status: 'taken', path: 'assets/34891190.mov'});
  assert.equal(projectRelists, 1, 'the project listing is read again, so the drawer needs no reload');

  const imports = importList(assets);
  assert.equal(imports.length, 1, '导入 has the downloaded material as a file of the project');
  assert.equal(imports[0]!.path, 'assets/34891190.mov', 'under assets/, where a usable material lives');
  assert.equal(imports[0]!.size, BYTES, 'with the bytes the download reported');

  const notice = downloadNotice(zh, false, {path: hop.path});
  assert.equal(notice, zh.useLandedInProject(hop.path));
  assert.match(notice, /导入/, 'the sentence names the list the person can now use it from');
  assert.match(notice, /assets\/34891190\.mov/, 'and the place it landed');
  assert.notEqual(notice, zh.useLandedInLibrary, 'it is no longer only a library file');
});

test('a reused library file still takes the hop, so a second click of 下载 is not a dead end', async () => {
  const recorder = recordingFetch({...okBody, reused: true});
  const taken: string[] = [];
  const use = createMaterialUse({fetch: recorder.fetcher});
  const outcome = await takeMaterial(card(), {use, relist: async () => {}});
  const hop = await landDownloadInProject((outcome.result as {landed: string}).landed, {
    projectId: 'P08',
    take: async path => { taken.push(path); return {path: 'assets/34891190.mov'}; },
  });
  assert.equal(hop.status, 'taken');
  assert.deepEqual(taken, [LANDED]);
});

test('no project open: no take at all, and the download keeps its library sentence', async () => {
  let takeCalls = 0;
  const hop = await landDownloadInProject(LANDED, {projectId: null, take: async () => { takeCalls += 1; return {}; }});
  assert.deepEqual(hop, {status: 'refused', path: null, reason: 'no-project'});
  assert.equal(takeCalls, 0, 'a refused gate makes no request, as the button being disabled does');
  assert.equal(downloadNotice(zh, false, null), zh.useLandedInLibrary, 'nothing claims a project that is not open');
});

test('a take that fails leaves the download standing: it is a fallback, not a second failure sentence', async () => {
  const hop = await landDownloadInProject(LANDED, {
    projectId: 'P08',
    take: async () => { throw Object.assign(new Error('locked'), {status: 409, body: {code: 'project-busy'}}); },
    relist: async () => { throw new Error('the listing must not be read after a failed take'); },
  });
  assert.deepEqual(hop, {status: 'failed', path: null, reason: 'take-failed'});
  const notice = downloadNotice(zh, false, hop.status === 'taken' ? {path: hop.path} : null);
  assert.equal(notice, zh.useLandedInLibrary, 'the file really is in the library; only the project copy did not happen');
  assert.equal(zh.takeFailed.includes('本次结果不作数'), true, 'the sentence a person can retry with is still the take one');
});

test('a download whose answer names no saved path takes no hop', async () => {
  let takeCalls = 0;
  for (const answer of [null, undefined, '', 'assets/34891190.mov', 'saved/../x.mov']) {
    const hop = await landDownloadInProject(answer, {projectId: 'P08', take: async () => { takeCalls += 1; return {path: 'assets/x.mov'}; }});
    assert.equal(hop.status, 'unavailable');
    assert.equal(hop.reason, 'no-landing');
  }
  assert.equal(takeCalls, 0, 'only a file that landed under saved/ is taken anywhere');
});
