// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { createLocalFissionRoutes } from './fission-local-routes.mjs';

test('native batch API uses picker-owned selections and only serves indexed outputs to the active account', async () => {
  const evidence = {}, calls = [], jobId = '11111111-1111-4111-8111-111111111111';
  let active = true;
  const auth = { assertActive: () => { if (!active) throw Error('expired'); return evidence; } };
  const service = {
    select: async (owner, role) => { calls.push(['select', owner, role]); return { selectionId: 'chosen', role, name: 'fixture' }; },
    start: async (owner, value) => { calls.push(['start', owner, value]); return { jobId, status: 'running', outputs: [] }; },
    find: async () => ({ jobId, status: 'running', outputs: [] }),
    list: async () => ({ jobs: [{ jobId, status: 'running', outputs: [] }] }),
    status: async () => ({ jobId, status: 'completed', outputs: [{ index: 0 }] }),
    cancel: async () => ({ jobId, status: 'cancelled' }),
    openOutput: async (owner, ref) => { calls.push(['open', owner, ref]); return { size: 5, start: 1, end: 3, stream: Readable.from([Buffer.from('bcd')]) }; },
  };
  const draft = { status: async () => ({ status: 'not-started' }), importSelected: async ref => { calls.push(['draft', ref]); return { status: 'ready', project: { id: 'native-id' } }; } };
  const route = createLocalFissionRoutes({ service, draft, auth });
  const server = createServer((req, res) => void route(req, res, new URL(req.url, 'http://127.0.0.1').pathname.slice(5).split('/'))
    .catch(e => { res.writeHead(e.status ?? 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: e.extra?.code })); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/fission-local`;
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  try {
    assert.equal((await post('/select', { role: 'video', path: 'C:\\private' })).status, 400);
    assert.equal(calls.length, 0, 'page cannot nominate a local path');
    assert.equal((await post('/select', { role: 'video' })).status, 200);
    assert.equal(calls[0][1], evidence);
    assert.equal((await post('/jobs', { selections: {}, job: {}, requestId: jobId })).status, 202);
    assert.equal((await fetch(base + '/requests/' + jobId)).status, 200);
    assert.equal((await fetch(base + '/jobs')).status, 200);
    const video = await fetch(base + '/jobs/' + jobId + '/outputs/0/video', { headers: { range: 'bytes=1-3' } });
    assert.equal(video.status, 206); assert.equal(video.headers.get('content-range'), 'bytes 1-3/5'); assert.equal(await video.text(), 'bcd');
    assert.equal((await post('/jobs/' + jobId + '/outputs/0/draft', { path: 'C:\\private' })).status, 400);
    assert.equal((await (await fetch(base + '/jobs/' + jobId + '/outputs/0/draft')).json()).status, 'not-started');
    assert.equal((await post('/jobs/' + jobId + '/outputs/0/draft', {})).status, 200);
    active = false;
    assert.equal((await fetch(base + '/jobs/' + jobId)).status, 403);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
