// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMaterialsClient } from '../lib/material-center/client.ts';

const DIR = new URL('./material-center/', import.meta.url);
const asPath = (name: string | Buffer) => String(name).split('\\').join('/');
const files = () => readdirSync(fileURLToPath(DIR), {recursive: true})
  .filter(name => /\.tsx?$/.test(String(name)))
  .map(name => ({name: asPath(name), source: readFileSync(new URL(asPath(name), DIR), 'utf8')}));

/** A fetch that records what was asked for and answers with a body the client accepts. */
function recordingFetch(body: unknown = {}) {
  const calls: {url: string; init: RequestInit | undefined}[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({url, init});
    return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json; charset=utf-8'}});
  };
  return {calls, fetcher};
}

const pageBody = {
  authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', pageNo: 1, pageSize: 20,
  items: [{videoId: {value: 'a', sourceType: 'string', source: 'a'}, observation: {name: 'A', coverUrl: '/api/materials/cover/1.jpg'}}],
  total: {sourceType: 'number', source: '178391'}, providerTotal: 178391, totalIsProviderTotal: true,
  filtered: {inspected: 20, dropped: 19}, grants: false,
};

test('the card components have no way to make a request at all', () => {
  for (const {name, source} of files()) {
    assert(!/\bfetch\s*\(/.test(source), name + ' must not fetch');
    assert(!/XMLHttpRequest|navigator\.sendBeacon/.test(source), name + ' must not reach the network by hand');
    assert(!/new Image\s*\(|new Audio\s*\(|createElement\(['"]video/.test(source), name + ' must not load a media element');
    assert(!/videoUrl|query\/raw|\/raw\b|\/download\b|isInner/.test(source), name + ' must not name a source file or a raw route');
    assert(!/@\/lib\/material-center\/client/.test(source), name + ' must not even hold the read-only client');
  }
});

test('hover is wired to a state setter, and use/download to the button, and to nothing else', () => {
  const card = readFileSync(new URL('MaterialCard.tsx', DIR), 'utf8');
  const row = readFileSync(new URL('MaterialListRow.tsx', DIR), 'utf8');
  const view = readFileSync(new URL('MaterialCenterPage.tsx', DIR), 'utf8');
  for (const [name, source] of [['MaterialCard', card], ['MaterialListRow', row]] as const) {
    assert.match(source, /onPointerEnter=\{\(\) => onHover\(entry\.id\)\}/, name + ' asks its parent about the hover and nothing more');
    assert.match(source, /onPointerLeave=\{\(\) => onHover\(null\)\}/, name + ' clears the hover the same way');
    assert.match(source, /data-action="use"[\s\S]{0,240}onClick=\{\(\) => onUse\(entry\.id\)\}/, name + ': the use handler sits on the use button alone');
    const useButtons = source.match(/onUse\(entry\.id\)/g) ?? [];
    assert.equal(useButtons.length, 1, name + ' has exactly one call site for the costed action');
  }
  assert.match(view, /controller\.hover\(/, 'the page routes hover to the controller');
  assert.match(view, /controller\.use\(entry\.card\.videoId\)/, 'the page routes use/download to the controller');
  const hovers = view.match(/onHover[:=]/g) ?? [];
  assert.equal(hovers.length, 1, 'one merged list: the same callbacks go to the card and to the row through one props object');
});

test('one card component renders all three sources, and the entry says which it is', () => {
  const card = readFileSync(new URL('MaterialCard.tsx', DIR), 'utf8');
  const row = readFileSync(new URL('MaterialListRow.tsx', DIR), 'utf8');
  for (const [name, source] of [['MaterialCard', card], ['MaterialListRow', row]] as const) {
    assert.match(source, /data-source=\{entry\.source\}/, name + ' marks which source the entry came from');
    assert(!/card\.videoId|card\.coverUrl|card\.accountName/.test(source), name + ' must not read a supplier row of its own: both sources go through the entry');
    assert.match(source, /entry\.source === 'cloud' \? copy\.cloudNotDownloaded : entry\.source === 'library' \? copy\.sourceLibrary : copy\.projectEntry/, name + ': a cloud entry says it is not downloaded yet, a library one says so, a project one says it is the project');
  }
  const view = readFileSync(new URL('MaterialCenterPage.tsx', DIR), 'utf8');
  assert.equal((view.match(/<MaterialCardView/g) ?? []).length, 1, 'the page has one card render site');
  assert.equal((view.match(/<MaterialListRow/g) ?? []).length, 1, 'the page has one row render site');
  assert.match(view, /view\.entries\.map\(entry =>/, 'both panes render the merged list, never a per-source list');
});

test('a cover is only requested once its card is in view, and the url is the server\'s', () => {
  const cover = readFileSync(new URL('LazyCover.tsx', DIR), 'utf8');
  assert.match(cover, /IntersectionObserver/, 'the cover waits for an observation');
  assert.match(cover, /isIntersecting/, 'only an intersecting card opens its cover');
  assert.match(cover, /createCoverGate\(/, 'one gate per card: it asks at most once');
  assert.match(cover, /if \(!src \|\| shown\) return undefined;/, 'nothing is asked before the card was seen');
  /* The address is the Studio origin's cover route (the cached one), and the supplier's url is its parameter. */
  assert.match(cover, /coverRequestUrl/, 'the cover is asked for through the server route, not at the supplier');
  assert.match(cover, /readCover\(requested/, 'the route is read for its status, so a 204 is "no cover" and not a broken image');
  assert.match(cover, /state === 'shown' && answer\.href/, 'a picture is drawn only when the route answered with one');
  assert.match(cover, /data-cover=\{mark\}/, 'which state a card is in is observable');
  assert.match(cover, /'none'/, 'a 204 is `none`: the placeholder, and no failure');
  assert.match(cover, /'failed'/, 'a route that refused is `failed`, and falls back to the same placeholder');
  assert(!/https?:\/\//.test(cover), 'the cover url is never built here');
  const request = readFileSync(new URL('../lib/material-center/cover.ts', import.meta.url), 'utf8');
  assert.match(request, /export function coverRequestUrl/, 'the one place a cover address is made');
  assert.match(request, /\$\{COVER_ROUTE\}\?url=\$\{encodeURIComponent\(url\)\}/, 'and it is the route plus the supplier url, encoded');
  assert.match(request, /COVER_ROUTE = '\/api\/materials\/cover'/, 'the route is a same-origin path');
  assert.match(request, /answer\.status === 204/, 'the status is read before `ok`: a 204 is an empty answer, not an image');
  assert(!/https?:\/\//.test(request), 'no supplier host is written here either');
  const card = readFileSync(new URL('MaterialCard.tsx', DIR), 'utf8');
  const row = readFileSync(new URL('MaterialListRow.tsx', DIR), 'utf8');
  for (const [name, source] of [['MaterialCard', card], ['MaterialListRow', row]] as const) {
    assert.match(source, /<LazyCover src=\{entry\.cover\}/, name + ' hands the entry cover to the lazy cover, unchanged');
    assert(!/<img src=\{entry\.cover\}/.test(source), name + ' must not put a cover on an img itself');
  }
  for (const {name, source} of files()) {
    assert(!/https?:\/\/|cdn\.|cover\/<|prefetch|warm/i.test(source), name + ' must not build a CDN/cover address or prewarm a cover');
  }
});

test('the centre is one page of one catalogue: no tabs, and no second list', () => {
  const center = readFileSync(new URL('./MaterialCenter.tsx', import.meta.url), 'utf8');
  assert(!/switchSelectionTab/.test(center), 'the two-tab switch is gone');
  assert(!/setTab\b|role="tab"|aria-selected=\{tab/.test(center), 'there is no tab state left');
  assert.equal((center.match(/<MaterialCenterPage/g) ?? []).length, 1, 'one page renders the one library');
  assert.equal(/localEntries=|libraryEntries=|takeGate=|onInsertLocal=/.test(center), false,
    'no local half is handed in: the project and Saved are the drawer\'s tabs, not a source of this page');
  assert.match(center, /takeMaterial\(card/, 'the host handler is the chain that makes a cloud entry land in the project');
});

test('both hosts wire the one real download handler, and the raw route lives in one module only', () => {
  for (const host of ['MediaPool.tsx', 'StandaloneWorkspace.tsx']) {
    const source = readFileSync(new URL('./' + host, import.meta.url), 'utf8');
    assert.match(source, /import \{ createMaterialUse \} from '@\/lib\/material-center\/use-material'/, host + ' makes its handler from the one module');
    assert.match(source, /const useMaterial\s*=\s*createMaterialUse\(\)/, host + ' builds one handler, not one per render');
    assert.match(source, /onUseMaterial[=:]\{?useMaterial\}?/, host + ' hands it to the library: a click really downloads');
  }
  const center = readFileSync(new URL('./MaterialCenter.tsx', import.meta.url), 'utf8');
  assert.match(center, /takeMaterial\(card,\{use:onUseMaterial,relist/, 'the library takes the material, then re-reads the local listing');
  const libDir = new URL('../lib/material-center/', import.meta.url);
  const naming = readdirSync(fileURLToPath(libDir)).filter(name => /\.ts$/.test(name) && readFileSync(new URL(name, libDir), 'utf8').includes('/api/materials/raw'));
  assert.deepEqual(naming, ['use-material.ts'], 'exactly one module names the raw route');
  const page = readFileSync(new URL('./material-center/MaterialCenterPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /data-action="retry-use"/, 'a failed download offers the retry button');
  assert.equal(/data-note="spend"/.test(page), false, 'the one-time spend row is gone: the download button says what it costs');
  assert.equal(/showSpendNotice/.test(page), false, 'and so is the state that only existed to draw it');
});

test('the filter bar is the search and whose material: the source is not a choice, and nothing local is offered', () => {
  const page = readFileSync(new URL('./material-center/MaterialCenterPage.tsx', import.meta.url), 'utf8');
  const kept = [...page.matchAll(/data-filter="([a-zA-Z]+)"/g)].map(match => match[1]);
  assert.deepEqual(kept, ['search', 'author'], 'two controls: the search box and the author, on one line');
  for (const removed of ['source', 'videoType', 'category', 'twoLevel', 'state', 'duration', 'sort']) {
    assert.equal(page.includes('data-filter="' + removed + '"'), false, 'the ' + removed + ' field is deleted, contract attribute and all');
  }
  assert.equal(/data-label=|data-local-kind|data-action="clear-filters"|data-note="cloud-dimensions"/.test(page), false, 'the public-label block went with the panel');
  assert.equal(/takeGate|onTakeSaved|onInsertLocal|data-action="retry-take"/.test(page), false,
    'add-to-project and add-to-timeline were the other sources\' actions: the page has only the cloud one');
  const center = readFileSync(new URL('./MaterialCenter.tsx', import.meta.url), 'utf8');
  assert.match(center, /api\.savedFiles\(\)/, 'the Saved listing is still read again after a download (native saved/files)');
  assert.match(center, /api\.takeSaved\(selectedProject,path\)/, 'and the download is taken into the project through the native takeSaved path');
  assert.match(center, /downloadNotice\(copy,reused,/, 'the answer says whether the library already had it, and where the download landed');
  assert.match(center, /landDownloadInProject\(/, 'and the download is taken into the open project, so the drawer\'s 导入 list shows it');
});

test('the read-only client knows three routes: list, facets, labels — no file, no download, no raw', async () => {
  const {fetcher, calls} = recordingFetch(pageBody);
  const client = createMaterialsClient({fetch: fetcher});
  assert.deepEqual([...client.routes], ['/list', '/facets', '/labels']);
  const page = await client.list({pageNo: 1, pageSize: 20, videoType: 1, scope: 'own'});
  assert.equal(page.items.length, 1);
  assert.equal(page.filtered.dropped, 19);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^\/api\/materials\/list\?/);
  assert.equal(calls[0].init?.method, 'GET');
  assert(!/raw|download|\/video|\.mp4|\.m3u8/i.test(calls[0].url), 'the only url a page load builds is the list route');
  assert.equal((calls[0].init?.headers as Record<string, string>).accept, 'application/json');
});

test('a parameter the contract does not list is refused before any socket, so a raw query cannot be smuggled', async () => {
  const {fetcher, calls} = recordingFetch(pageBody);
  const client = createMaterialsClient({fetch: fetcher});
  await assert.rejects(() => client.list({pageNo: 1, pageSize: 20, videoType: 1, scope: 'own', isInner: 0} as never), /isInner/);
  await assert.rejects(() => client.list({pageNo: 1, pageSize: 20, videoType: 1, scope: 'own', url: 'x'} as never), /url/);
  await assert.rejects(() => client.facets({pageNo: 1} as never), /pageNo/);
  await assert.rejects(() => client.list({pageNo: 1, pageSize: 101, videoType: 1, scope: 'own'}), /1-100/);
  await assert.rejects(() => client.list({pageNo: 1, pageSize: 20, videoType: 9, scope: 'own'}), /0-4/);
  assert.equal(calls.length, 0, 'a refused query costs no request at all');
});

test('an answer that will not hold is not a page: the client refuses rather than showing half of it', async () => {
  const wrongTotal = createMaterialsClient({fetch: recordingFetch({...pageBody, totalIsProviderTotal: false}).fetcher});
  await assert.rejects(() => wrongTotal.list({pageNo: 1, pageSize: 20, videoType: 1, scope: 'own'}),
    (error: {code?: string}) => error.code === 'provider-response-unconfirmed');
  const dudFacets = createMaterialsClient({fetch: recordingFetch({
    authorization: {layer: 'self', reason: 'own-account-key'}, providerScope: 's', videoType: 1,
    oneLevel: [{id: 11, name: '口播', level: 1, children: []}], twoLevel: [{id: 21, name: '美妆', parentTypeId: 11, level: 2}],
    states: [], publicLabels: [], labelTotal: null,
  }).fetcher});
  await assert.rejects(() => dudFacets.facets({videoType: 1, scope: 'own'}),
    (error: {code?: string}) => error.code === 'provider-response-unconfirmed',
    'a flattened list that disagrees with the children is not "no subcategories"');
});

test('the library can claim the cloud-steward account its "mine" view needs, and stays shut until it does', () => {
  const page = readFileSync(new URL('./material-center/MaterialCenterPage.tsx', import.meta.url), 'utf8');
  /* The claim is a setting now (Settings → 云管家): the material page keeps only the rule it enforces. */
  const settings = readFileSync(new URL('./settings/CloudStewardSection.tsx', import.meta.url), 'utf8');
  assert.match(settings, /data-note="binding"/, 'an unbound account says so, in Settings');
  assert.match(settings, /data-action="binding-submit"/, 'with the one form that claims it');
  assert.match(settings, /data-dialog="binding"/, 'the claim is a small form in the section, not a reload');
  assert.match(settings, /data-field="binding-account"/, 'the account is typed in: no /api/materials/accounts is invented');
  assert.equal(settings.includes('/api/materials/accounts'), false, 'no accounts endpoint is called');
  assert.match(page, /disabled=\{!ownAvailable\}/, '"my materials" is disabled until a claim exists');
  assert.match(page, /copy\.ownNeedsBinding/, 'and says why it is disabled');
  assert.match(settings, /data-action="unbind"/, 'a claimed account can be released');
  assert.equal(/data-note="binding"|data-action="bind"|data-dialog="binding"/.test(page), false, 'the material page itself claims nothing');
  assert.match(page, /controller\.setFilters\(\{author: 'company'\}\)/, 'an unbound page starts on the company view, so scope=own is never read');
  const center = readFileSync(new URL('./MaterialCenter.tsx', import.meta.url), 'utf8');
  assert.match(center, /createMaterialBinding\(\)/, 'the claim comes from the one binding client');
  assert.match(center, /bindingRefreshPlan\(/, 'a claim or release refreshes the list once');
  assert.match(center, /binding=\{binding\.value\}/, 'the page is handed the claim');
});

test('a 200 emptied by the authorization layer says "filtered", with a way back to the company view', () => {
  const page = readFileSync(new URL('./material-center/MaterialCenterPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /data-note="filtered-empty"/, 'the filtered-empty branch exists');
  assert.match(page, /data-action="switch-company"/, 'and offers the way out to the company view');
  assert.match(page, /copy\.switchToCompany/, 'with its own words');
  assert.match(page, /controller\.setFilters\(\{author: 'company'\}\)/, 'that button asks the company view, nothing else');
  assert.equal((page.match(/failureCopy\(/g) ?? []).length, 1, 'failureCopy is called once — for a real failure only');
  const branchStart = page.indexOf('view.filteredEmpty &&');
  const branch = page.slice(branchStart, page.indexOf(': <>', branchStart));
  assert.equal(/[^a-zA-Z]failureCopy\(|[^a-zA-Z]authRequired|copy\.unauthorized/.test(branch), false, 'the filtered-empty branch cannot say "sign in" or "no permission"');
  const tab = readFileSync(new URL('./material-center/CloudMaterialsTab.tsx', import.meta.url), 'utf8');
  assert.match(tab, /data-state=\{binding\.value \? 'bound' : 'unbound'\}/, 'the tab states whether a claim exists');
  assert.equal(tab.includes('binding-guide'), false, 'the old guide card is gone: only the library is drawn');
  assert.equal(page.includes('copy.authRequired'), false, 'the page itself never answers a 200 with a sign-in sentence');
});
test('the retry button retries, and a warming Studio session is not shown as a failure', () => {
  const page = readFileSync(new URL('./material-center/MaterialCenterPage.tsx', import.meta.url), 'utf8');
  assert.equal((page.match(/controller\.retry\(\)/g) ?? []).length, 1, 'the cloud notice is the one retry left (the title row is gone)');
  assert.equal(page.includes('onClick={() => void controller.refresh()}'), false, 'no button refreshes a list that may not be what failed');
  assert.match(page, /data-note="studio-retrying"/, 'a guard-shaped 401 retrying says so');
  assert.match(page, /copy\.studioSessionRetrying/, 'with its own words');
  assert.match(page, /view\.cloud\.state === 'unavailable' && !studioRetrying/, 'no failure sentence while the session is being retried');
  const center = readFileSync(new URL('./MaterialCenter.tsx', import.meta.url), 'utf8');
  assert.match(center, /createMaterialsClient\(\{onSessionRetry:setStudioWarming\}\)/, 'the client reports its retry to the page');
  const client = readFileSync(new URL('../lib/material-center/client.ts', import.meta.url), 'utf8');
  assert.match(client, /credentials: 'same-origin'/, 'every material read sends the Studio session');
  assert.equal(client.includes("credentials: 'omit'"), false, 'omit was the 401 bug');
});
test('the cloud steward is the material pane\'s third tab, not a panel floating over it', () => {
  const pool = readFileSync(new URL('./MediaPool.tsx', import.meta.url), 'utf8');
  assert.match(pool, /scope\?: 'project' \| 'saved' \| 'cloud'/, 'the pane offers three scopes');
  assert.match(pool, /const tabs=!inDrawer&&onScope\?\(/, 'one tab bar, drawn by the pane itself');
  assert.match(pool, /\{\(\['project','saved','cloud'\] as const\)\.map\(/, '导入 · 收藏 · 云管家, in that order');
  assert.equal((pool.match(/data-scope-tab=\{next\}/g) ?? []).length, 1, 'one render site for the three tabs');
  assert.match(pool, /<CloudMaterialsTab authGeneration=\{authGeneration\}/, 'the third tab is the tab component, in the pane');
  assert.match(pool, /data-action="open-catalog"[\s\S]{0,80}setCatalogOpen\(true\)/, 'the import pane\'s entry is untouched');
  assert.equal(/data-action="open-cloud-steward"/.test(pool), false, 'the overlay entry is gone');
  assert.equal(/onOpenCloudSteward|cloudStewardOpen|hostsCloudSteward/.test(pool), false, 'and so is the callback that opened it');

  const view = readFileSync(new URL('./ProjectView.tsx', import.meta.url), 'utf8');
  assert.equal(/cloud-steward/.test(view), false, 'ProjectView no longer mounts an overlay');
  assert.equal(/<CloudStewardPanel|stewardOpen/.test(view), false, 'nor keeps any panel state');
  assert.match(view, /type MediaScope = 'project' \| 'saved' \| 'cloud'/, 'the host keeps which tab is showing, it does not draw it');
  assert.equal((view.match(/onScope=\{switchMedia\}/g) ?? []).length, 2, 'both media-pane mounts are handed the scope');

  const tab = readFileSync(new URL('./material-center/CloudMaterialsTab.tsx', import.meta.url), 'utf8');
  assert.match(tab, /data-state=\{binding\.value \? 'bound' : 'unbound'\}/, 'the tab says whether the account is claimed');
  assert.equal(tab.includes('binding-guide'), false, 'no guide card: the library is always the tab');
  assert.equal(tab.includes('data-action="open-settings"'), false, 'and no settings button inside the tab');
  assert.equal(tab.includes('data-state="bound"'), false, 'the old bound/unbound split is gone');
  const collections = readFileSync(new URL('./material-center/CollectionsView.tsx', import.meta.url), 'utf8');
  assert.match(collections, /data-collections=""/, 'the 合集');
  assert.match(tab, /renderLibrary\(\)/, 'and the one library, with no 合集 of its own');
  assert.equal(/fetch\s*\(|createMaterialsClient/.test(tab), false, 'no data layer of its own');

  const center = readFileSync(new URL('./MaterialCenter.tsx', import.meta.url), 'utf8');
  assert.match(center, /cloudTab\?:boolean/, 'the library knows the cloud tab');
  assert.match(center, /showFilters=\{cloudTab \|\| !group\}/, 'its search and filters stay on screen there');
  assert.equal(/initialFilters:\{source:/.test(center), false, 'the catalogue is the only source, so no caller has to name one');
  const filtersFile = readFileSync(new URL('../lib/material-center/filters.ts', import.meta.url), 'utf8');
  assert.match(filtersFile, /readonly source: MaterialSource;/, 'the source is a type with one value, not a choice of four');
  assert.match(filtersFile, /export type MaterialSource = 'cloud';/, 'and that value is the cloud');
});

test('the filtered-empty notice always offers the company view, whoever else is listed', () => {
  const page = readFileSync(new URL('./material-center/MaterialCenterPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /\{view\.filteredEmpty\n\s*\? <p role="status" data-state="empty" data-note="filtered-empty"/, 'the branch keys on filteredEmpty alone');
  assert.equal(/view\.filteredEmpty && view\.entries\.length/.test(page), false, 'it does not wait for an empty merged list');
  assert.match(page, /data-action="switch-company"/, 'the button is in that branch');
  const copy = readFileSync(new URL('../lib/material-center/copy.ts', import.meta.url), 'utf8');
  assert.match(copy, /authorCompany: '公司素材（全部）'/, 'the company option says what it is');
  assert.match(copy, /authorOwn: '我的素材（我上传的）'/, 'and so does "mine"');
  const filters = readFileSync(new URL('../lib/material-center/filters.ts', import.meta.url), 'utf8');
  assert.match(filters, /author: 'company' as ScopeChoice/, 'the value itself is unchanged (it lives in filters, not in the label)');
});
test('the tab offers company or my material, with the claim rule the library already has', () => {
  const page = readFileSync(new URL('./material-center/MaterialCenterPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /data-filter="author"/, 'the scope is one filter, in the library\'s own filter bar');
  assert.match(page, /value="cloud:company"/, 'the company side');
  assert.match(page, /value="cloud:own"/, 'the mine side');
  assert.match(page, /copy\.authorCompany/, 'the same words as the library');
  assert.match(page, /copy\.authorOwn/);
  assert.match(page, /disabled=\{!ownAvailable\}/, '"mine" is not offered before a claim exists');
  assert.match(page, /title=\{ownAvailable \? undefined : copy\.ownNeedsBinding\}/, 'and says why, in the library\'s own words');
  const tab = readFileSync(new URL('./material-center/CloudMaterialsTab.tsx', import.meta.url), 'utf8');
  assert.equal(/board-scope|createGroupBoard/.test(tab), false, 'the tab keeps no 合集 board of its own any more');
  const center = readFileSync(new URL('./MaterialCenter.tsx', import.meta.url), 'utf8');
  assert.match(center, /author:group\.scope \?\? 'company'/, 'a 合集 that carries a scope asks the list for it');
  assert.match(center, /groupIds:\[group\.twoLevelId\]/, 'and for that group');
});