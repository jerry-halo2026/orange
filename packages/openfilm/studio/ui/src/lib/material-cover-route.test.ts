// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The cover address: one supplier `coverUrl` in, the Studio origin's cached cover route out.
 *
 * The page asks its own origin (`GET /api/materials/cover?url=…`) and never a supplier host: the server keeps that
 * image on this computer, so the second look at a card costs nothing. The encoding is the whole contract — a supplier
 * url carries `:`, `?`, `&` and `%`, and every one of them must survive as one parameter value.
 *
 * The other half is what the route's **status** means (`readCover`): 204 is "this url has no image" (a supplier host
 * the server cannot reach, which the card draws as its placeholder, not as a failure), any other refusal is a failure,
 * and only an ok answer with bytes is a picture. It is read with `fetch` for exactly that reason: an `<img>` cannot
 * see a status, so a 204 would arrive as a broken image and paint the console red for every card of a dead node.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {COVER_ROUTE, coverRequestUrl, readCover} from './material-center/cover.ts';

/** The real shape of a supplier cover: an https url on the CDN, with a port and a query of its own. */
const REAL = 'https://szy-hlcxy-sucaiwang.sucaicloud.com:9001/sucaiwang/sucaiwang/255/31950/128b4271-81ed-442a-8b50-1dc4bfd18808.png?v=2&x=1';

test('the route is this origin\'s, and the supplier url travels as its one parameter', () => {
  assert.equal(COVER_ROUTE, '/api/materials/cover');
  const asked = coverRequestUrl(REAL);
  assert.ok(asked.startsWith('/api/materials/cover?url='), 'the address is the server route');
  assert.equal(asked.split('?url=').length, 2, 'one parameter, named url');
  const parsed = new URL(asked, 'http://studio.invalid');
  assert.equal(parsed.pathname, COVER_ROUTE);
  assert.equal(parsed.searchParams.getAll('url').length, 1, 'the url is one value, never split by its own &');
  assert.equal(parsed.searchParams.get('url'), REAL, 'and it is the supplier url, byte for byte');
  assert.equal(parsed.search, '?url=' + encodeURIComponent(REAL), 'nothing else is added to the query');
});

test('a url that already carries % escapes survives the parameter unchanged', () => {
  const encoded = 'https://cdn.sucaicloud.com/a%20b%2Fc.png?token=%26x';
  const asked = coverRequestUrl(encoded);
  assert.equal(new URL(asked, 'http://studio.invalid').searchParams.get('url'), encoded,
    'one decode on the server gives back exactly what the supplier said');
  assert.ok(asked.includes('%25'), 'each % is escaped once for the wire, so one decode restores it');
});

test('the page builds no supplier address of its own', async () => {
  /* The one function that makes a cover address returns a path, never a host: it cannot be talked into a CDN. */
  assert.ok(!/^https?:/i.test(coverRequestUrl('https://evil.test/x.png')), 'the answer is a same-origin path');
  assert.ok(coverRequestUrl('//evil.test/x.png').startsWith('/api/materials/cover?url='), 'a protocol-relative url stays a parameter');
  assert.equal(new URL(coverRequestUrl('//evil.test/x.png'), 'http://studio.invalid').searchParams.get('url'), '//evil.test/x.png',
    'the page passes it on; whether that host may be fetched is the server\'s rule');
});

/** The route answered this, and every call it took is recorded. */
async function withRoute(answer: () => Promise<Response>, run: (asked: string[]) => Promise<void>) {
  const real = globalThis.fetch;
  /** @type {string[]} */
  const asked = [];
  globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
    asked.push(String(request));
    assert.equal(init?.credentials, 'same-origin', 'the cover read is this origin\'s, with its session');
    return answer();
  }) as typeof fetch;
  try { await run(asked); } finally { globalThis.fetch = real; }
}

test('a 204 is "no cover" — the placeholder, no failure, and nothing asked twice', async () => {
  await withRoute(async () => new Response(null, {status: 204}), async asked => {
    const read = await readCover(coverRequestUrl(REAL));
    assert.deepEqual(read, {state: 'none'}, '204 is none, never failed');
    assert.deepEqual(asked, [coverRequestUrl(REAL)], 'one read of the route, and no retry');
  });
});

test('an ok answer with bytes is a picture, and a refusal is a failure', async () => {
  await withRoute(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {status: 200, headers: {'content-type': 'image/png'}}),
    async () => {
      const read = await readCover(coverRequestUrl(REAL), {toHref: () => 'blob:cover'});
      assert.deepEqual(read, {state: 'shown', href: 'blob:cover'}, 'the bytes are drawn from this origin');
    });
  for (const status of [400, 403, 502]) {
    await withRoute(async () => new Response(JSON.stringify({code: 'material-cover-host-refused'}), {status}),
      async () => assert.deepEqual(await readCover(coverRequestUrl(REAL)), {state: 'failed'}, status + ' is a failure, not "no cover"'));
  }
  /* The network itself failing at this end changes no reading: it is a failure, and the server already remembers it. */
  await withRoute(async () => { throw new TypeError('fetch failed'); },
    async () => assert.deepEqual(await readCover(coverRequestUrl(REAL)), {state: 'failed'}));
  /* An empty body is not a cover either. */
  await withRoute(async () => new Response(new Uint8Array(0), {status: 200}), async () => {
    assert.deepEqual(await readCover(coverRequestUrl(REAL)), {state: 'failed'}, 'no bytes, no picture');
  });
});
