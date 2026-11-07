import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as server from './server.mjs';
const profile = { root: 'synthetic' };
function capability(name) { assert.equal(typeof server[name], 'function', `missing ${name}`); return server[name]; }
test('isolated bootstrap invokes no automatic remote providers, examples or Discover', async () => { let calls = 0; await capability('bootstrapStudioResources')(profile, { examples: async () => calls++, providers: async () => calls++, discover: async () => calls++ }, true); assert.equal(calls, 0); });
test('unprofiled bootstrap still refreshes all original resources', async () => { let calls = 0; await capability('bootstrapStudioResources')(null, { examples: async () => calls++, providers: async () => calls++, discover: async () => calls++ }, true); assert.equal(calls, 3); });
for (const [method, path] of [['GET', 'examples'], ['GET', 'providers'], ['POST', 'skills/catalog'], ['POST', 'library/fetch'], ['POST', 'projects/fetch'], ['POST', 'examples/id/folder'], ['GET', 'examples/id/canvas'], ['GET', 'examples/id/files/film.html']]) {
    test(`isolated ${method} /api/${path} refuses before remote handler`, async () => { let calls = 0; await assert.rejects(() => capability('isolationResourceCall')(profile, server.studioApiParts(new URL('/api/' + path, 'http://127.0.0.1').pathname), method, async () => { calls++; return 'remote'; }), e => e.status === 503 && e.extra?.code === 'isolation-capability-unavailable'); assert.equal(calls, 0); });
}
test('local skills and Library catalog stay available instead of fake empty success', async () => { for (const path of ['skills', 'library', 'library/voices'])
    assert.equal(await capability('isolationResourceCall')(profile, path.split('/'), 'GET', async () => 'real-local-data'), 'real-local-data'); });
test('isolated Library cache miss never calls automatic fetch', async () => { let fetched = 0; const file = capability('studioLibraryFile'); await assert.rejects(() => file(profile, 'missing', { local: () => null, remote: async () => { fetched++; return 'remote'; } }), e => e.status === 503); assert.equal(fetched, 0); assert.equal(await file(profile, 'cached', { local: () => '/local/cached', remote: async () => { fetched++; return 'remote'; } }), '/local/cached'); });

const modelOperations = [
  ['GET', 'get'],
  ['POST', 'get'],
  ['POST', 'projects/native-id/subtitles/transcribe'],
  ['POST', 'projects/native-id/subtitles/translate'],
  ['POST', 'projects/native-id/caption-tracks/translate'],
];
for (const [method, path] of modelOperations) {
  test(`isolated ${method} /api/${path} cannot invoke a provider or Agent handler`, async () => {
    let handlerCalls = 0;
    const outcome = await capability('isolationResourceCall')(profile, server.studioApiParts(new URL('/api/' + path, 'http://127.0.0.1').pathname), method, async () => {
      handlerCalls += 1;
      return 'provider-or-agent-called';
    }).then(value => ({ value }), error => ({ error }));
    assert.equal(handlerCalls, 0, 'remote/model handler ran before isolation admission');
    assert.equal(outcome.error?.status, 503);
    assert.equal(outcome.error?.extra?.code, 'isolation-capability-unavailable');
  });
  test(`unprofiled ${method} /api/${path} preserves its original handler`, async () => {
    assert.equal(await capability('isolationResourceCall')(null, server.studioApiParts(new URL('/api/' + path, 'http://127.0.0.1').pathname), method, async () => 'original-handler-result'), 'original-handler-result');
  });
}
for (const [method, path] of [
  ['GET', 'projects/native-id/subtitles'],
  ['PUT', 'projects/native-id/subtitles'],
  ['GET', 'projects/native-id/caption-tracks'],
  ['PUT', 'projects/native-id/caption-tracks'],
]) {
  test(`isolated local caption ${method} /api/${path} remains available`, async () => {
    assert.equal(await capability('isolationResourceCall')(profile, server.studioApiParts(new URL('/api/' + path, 'http://127.0.0.1').pathname), method, async () => 'real-local-caption-result'), 'real-local-caption-result');
  });
}

for (const [rawPath, decodedOperation] of [
  ['/api/projects/native-id/subtitles%2Ftranslate', 'subtitles/translate'],
  ['/api/projects/native-id/subtitles%2Ftranscribe', 'subtitles/transcribe'],
  ['/api/projects/native-id/caption-tracks%2Ftranslate', 'caption-tracks/translate'],
]) {
  test(`isolated raw URL ${rawPath} rejects its effective model operation before handler`, async () => {
    const parts = server.studioApiParts(new URL(rawPath, 'http://127.0.0.1').pathname);
    assert.deepEqual(parts, ['projects', 'native-id', decodedOperation]);
    let handlerCalls = 0;
    const outcome = await capability('isolationResourceCall')(profile, parts, 'POST', async () => {
      handlerCalls += 1;
      return 'model-handler-ran';
    }).then(value => ({ value }), error => ({ error }));
    assert.equal(handlerCalls, 0, 'decoded route reached its model handler before isolation admission');
    assert.equal(outcome.error?.status, 503);
    assert.equal(outcome.error?.extra?.code, 'isolation-capability-unavailable');
  });
  test(`unprofiled raw URL ${rawPath} retains native decoded-separator dispatch`, async () => {
    const parts = server.studioApiParts(new URL(rawPath, 'http://127.0.0.1').pathname);
    assert.equal(await capability('isolationResourceCall')(null, parts, 'POST', async () => 'native-dispatch-result'), 'native-dispatch-result');
  });
}
