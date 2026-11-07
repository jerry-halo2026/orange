import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { readStudioAssets, studioTransport } from './node.ts';
import type { StudioExperience, StudioExperienceRoute, StudioExperienceRuntime } from './experience-contract.ts';

const pin = '2e18a4bdf54647b2ece3c0975a6f9573720c7821';

const hash = (text: string) => createHash('sha256').update(text);
const accessHeader = 'x-orange-studio-access';
const projectPath = '/api/projects/local-experience';
const project = Object.freeze({ id: 'local-experience', name: '本地体验工程 · 关闭即丢弃',
  path: '内存体验（非磁盘路径）', missing: false, openedAt: 1 });
const ids = ['card-a', 'card-b'];
const sources = ['card-a.svg', 'card-b.svg'];
const globalEvents = /^\/api\/events\?visible=[01]$/;
const previewPattern = /^\/film\.html\?load=([1-9]\d{0,3})&film-missing=skip(?:&film-dpr=(\d(?:\.\d{1,6})?))?(&film-host=0)?$/;
const scripts = new Map<string, keyof StudioExperienceRuntime['browser']>([
  ['/__film/timeline.mjs', 'timelineMjs'], ['/__film/film-doc.mjs', 'filmDocMjs'],
  ['/__film/overrides.mjs', 'overridesMjs'], ['/__film/bridge.js', 'bridgeJs'],
] as const);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const noBody = (req: IncomingMessage) => !req.headers['transfer-encoding'] &&
  (req.headers['content-length'] === undefined || req.headers['content-length'] === '0');

type SampleFilm = { stage: { w: 640; h: 360 }; tracks: Array<{ clips: Array<{
  src: string; id: string; at?: number; time: [number, number];
}> }> };
// readFilm is a trusted pure function, but its output is still an unknown boundary.
// Restrict its normalized document to this sample, not arbitrary film capabilities.
function checkedFilm(result: unknown): SampleFilm {
  if (!object(result) || !Array.isArray(result.problems) || result.problems.length !== 0 ||
    !object(result.doc)) throw Error();
  const doc = result.doc;
  if (!exactKeys(doc, ['stage', 'tracks']) || !object(doc.stage) || !exactKeys(doc.stage, ['w', 'h']) ||
    doc.stage.w !== 640 || doc.stage.h !== 360 || !Array.isArray(doc.tracks) || doc.tracks.length !== 1) throw Error();
  const track: unknown = doc.tracks[0];
  if (!object(track) || !exactKeys(track, ['clips']) || !Array.isArray(track.clips) || track.clips.length !== 2) throw Error();
  const found = new Set<string>();
  for (const clip of track.clips) {
    if (!object(clip) || !exactKeys(clip, ['src', 'id', 'at', 'time']) || typeof clip.id !== 'string' ||
      !ids.includes(clip.id) || found.has(clip.id) || clip.src !== sources[ids.indexOf(clip.id)] ||
      (clip.at !== undefined && (typeof clip.at !== 'number' || !Number.isFinite(clip.at) || clip.at < 0 || clip.at > 30)) ||
      !Array.isArray(clip.time) || clip.time.length !== 2 || clip.time[0] !== 0 || clip.time[1] !== 3) throw Error();
    found.add(clip.id);
  }
  return doc as SampleFilm;
}
function previewKind(path: string): 'preview' | 'preview-film' | undefined {
  const match = previewPattern.exec(path);
  if (!match || (match[2] && (Number(match[2]) < 0.25 || Number(match[2]) > 4))) return;
  return match[3] ? 'preview-film' : 'preview';
}
function imageName(path: string) {
  return sources.find((name) => path === '/' + name || path === '/' + name + '?v=1');
}
function card(letter: string, background: string) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">' +
    '<rect width="640" height="360" fill="' + background + '"/><circle cx="530" cy="80" r="130" fill="#ff9a46"/>' +
    '<rect x="36" y="36" width="568" height="288" rx="24" fill="none" stroke="#fff0d8" stroke-width="2"/>' +
    '<text x="66" y="230" fill="#fff0d8" font-size="150" font-family="sans-serif">' + letter + '</text>' +
    '<text x="72" y="290" fill="#fff0d8" font-size="24" font-family="sans-serif">LOCAL EXPERIENCE · 不保存</text></svg>';
}
const images = new Map([['card-a.svg', card('A', '#a73419')], ['card-b.svg', card('B', '#173d47')]]);

export async function startStudioExperience(directory: string, buildOwnedReceiptSha256: string,
  nativeIsAuthorized: () => boolean, onFailure: () => void, runtime: StudioExperienceRuntime): Promise<StudioExperience> {
  const { response, header, bindWsInput } = studioTransport;
  const assets = readStudioAssets(directory, buildOwnedReceiptSha256);
  // Deep document-relative URLs need the same finite receipt-owned JS/CSS/font snapshots.
  // Populate exact keys once; never resolve a request path through a prefix or normalization.
  const studioAssets = new Map(assets);
  for (const [path, asset] of assets) {
    if (path.startsWith('/assets/')) studioAssets.set('/projects' + path, asset);
  }
  if (runtime?.sourcePin !== pin || !object(runtime.browser) ||
    !(['timelineMjs', 'filmDocMjs', 'overridesMjs', 'bridgeJs'] as const).every((key) => typeof runtime.browser[key] === 'string' && runtime.browser[key].length > 0) ||
    !object(runtime.pure) || !(['readFilm', 'filmHtml', 'applyOps'] as const).every((key) => typeof runtime.pure[key] === 'function')) {
    throw Error('Studio experience runtime verification failed');
  }
  // Snapshot all caller-owned fields once. The build binding is native, never request driven.
  const browser = Object.freeze({ ...runtime.browser });
  const pure = Object.freeze({ ...runtime.pure });
  const initial = { stage: { w: 640, h: 360 }, tracks: [{ clips: [
    { src: 'card-a.svg', id: 'card-a', at: 0, time: [0, 3] },
    { src: 'card-b.svg', id: 'card-b', at: 3, time: [0, 3] },
  ] }] };
  let value = checkedFilm(pure.readFilm(initial));
  let text = pure.filmHtml(value);
  if (typeof text !== 'string' || text.length === 0) throw Error('Studio experience sample verification failed');
  let state = { value, text, rev: hash(text).digest('hex').slice(0, 16) };
  const token = randomBytes(32);
  let active = true, failed = false;
  let stopped: Promise<void> | undefined;
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  function close(): Promise<void> {
    // Synchronous revocation precedes any asynchronous listener cleanup.
    active = false;
    token.fill(0);
    if (!stopped) {
      stopped = Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done())))).then(() => {});
      for (const socket of sockets) socket.destroy();
    }
    return stopped;
  }
  function fail() {
    void close();
    if (!failed) { failed = true; try { onFailure(); } catch { /* failure callbacks cannot reopen capabilities */ } }
  }
  function authorized() {
    if (!active) return false;
    try { if (nativeIsAuthorized() === true) return true; } catch { /* deny */ }
    fail();
    return false;
  }
  function makeServer(handle: Parameters<typeof createServer>[1]) {
    const server = createServer({ maxHeaderSize: 8192, headersTimeout: 2500, requestTimeout: 3000, keepAliveTimeout: 1500 }, handle);
    servers.push(server);
    server.maxConnections = 32; server.maxHeadersCount = 64;
    server.setTimeout(4000, (socket) => socket.destroy());
    server.on('connection', (socket) => {
      sockets.add(socket); socket.on('error', () => socket.destroy()); socket.once('close', () => sockets.delete(socket));
      if (!active) socket.destroy();
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    server.on('connect', (_request, socket) => socket.destroy());
    server.on('checkContinue', (_req, res) => response(res, 403, 'denied'));
    return server;
  }
  function listen(server: Server) {
    return new Promise<string>((done, reject) => {
      server.once('error', reject);
      server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
        server.off('error', reject); server.on('error', fail);
        const address = server.address();
        if (!address || typeof address === 'string' || address.address !== '127.0.0.1') reject(Error());
        else done('http://127.0.0.1:' + address.port);
      });
    });
  }
  let studioOrigin = '', previewOrigin = '', wsOrigin = '', studioCsp = '';
  const json = (res: Parameters<typeof response>[0], code: number, data: object) =>
    response(res, code, JSON.stringify(data), 'application/json; charset=utf-8');
  const invalid = (res: Parameters<typeof response>[0], code: number, error: string) => json(res, code, { error, code: error });
  const reads = new Map<string, () => object>([
    ['GET /api/examples', () => ({ examples: [] })], ['GET /api/health', () => ({ version: '0.0.0' })],
    ['GET /api/prefs', () => ({ seenVersion: '99.0.0', autoVersions: false })],
    ['GET /api/projects', () => ({ projects: [project] })], ['GET /api/projects/folders', () => ({ folders: [] })],
    ['GET /api/skills', () => ({ skills: [] })], ['GET /api/version', () => ({ version: '0.0.0' })],
    ['GET ' + projectPath, () => ({ project, folder: previewOrigin + '/', ...state, doc: state.value, problems: [] })],
    ['GET ' + projectPath + '/files', () => ({ files: sources.map((path) => ({ path, kind: 'image', size: Buffer.byteLength(images.get(path)!), mtime: 1 })), folders: [], pages: [] })],
    ['GET ' + projectPath + '/settings', () => ({ settings: { fps: 30 } })],
    ['GET ' + projectPath + '/markers', () => ({ markers: [] })],
    ['POST ' + projectPath + '/opened', () => ({ project })],
    ...sources.map((path): [string, () => object] => ['GET ' + projectPath + '/media?what=probe&path=' + path + '&v=1',
      () => ({ width: 640, height: 360, duration: null, audio: false })]),
  ]);
  function hasAccess(req: IncomingMessage, origin: string) {
    const supplied = header(req, accessHeader);
    if (!authorized() || req.socket.remoteAddress !== '127.0.0.1' || header(req, 'host') !== origin.slice(7) || !digest(supplied)) return false;
    const seen = new Set<string>();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i].toLowerCase();
      if (!['host', 'origin', 'sec-fetch-site', accessHeader, 'upgrade', 'sec-websocket-key', 'sec-websocket-version',
        'content-type', 'content-length', 'transfer-encoding'].includes(key)) continue;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return timingSafeEqual(Buffer.from(supplied, 'hex'), token);
  }
  async function edit(req: IncomingMessage, res: Parameters<typeof response>[0]) {
    const size = header(req, 'content-length');
    if (req.headers['transfer-encoding'] || !size || !/^[1-9]\d{0,4}$/.test(size) ||
      header(req, 'content-type') !== 'application/json') return invalid(res, 400, 'invalid-body');
    if (Number(size) > 8192) { req.resume(); return invalid(res, 413, 'body-too-large'); }
    const chunks: Buffer[] = []; let length = 0;
    try {
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 8192) return invalid(res, 413, 'body-too-large');
        chunks.push(Buffer.from(chunk));
      }
      if (!authorized()) return;
      if (length !== Number(size)) return invalid(res, 400, 'invalid-body');
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(body) || !exactKeys(body, ['base', 'ops', 'undo']) ||
        (body.undo !== undefined && typeof body.undo !== 'boolean')) return invalid(res, 422, 'unsupported-edit');
      if (body.base === null || typeof body.base === 'string' && body.base !== state.rev) return invalid(res, 409, 'conflict');
      if (typeof body.base !== 'string' || !Array.isArray(body.ops) || body.ops.length < 1 || body.ops.length > 2) return invalid(res, 422, 'unsupported-edit');
      let placements = 0;
      for (const op of body.ops) {
        if (!object(op)) return invalid(res, 422, 'unsupported-edit');
        if (op.op === 'move') {
          if (!exactKeys(op, ['op', 'clip', 'at', 'track']) ||
            typeof op.clip !== 'string' || !ids.includes(op.clip) || typeof op.at !== 'number' || !Number.isFinite(op.at) ||
            op.at < 0 || op.at > 30 || (op.track !== undefined && op.track !== 0)) return invalid(res, 422, 'unsupported-edit');
          placements++;
        } else if (op.op === 'props') {
          if (!exactKeys(op, ['op', 'edits']) || !Array.isArray(op.edits) || op.edits.length < 1 || op.edits.length > 2) {
            return invalid(res, 422, 'unsupported-edit');
          }
          for (const edit of op.edits) {
            if (!object(edit) || !exactKeys(edit, ['clip', 'prop', 'value']) ||
              typeof edit.clip !== 'string' || !ids.includes(edit.clip) || edit.prop !== 'at' ||
              typeof edit.value !== 'number' || !Number.isFinite(edit.value) || edit.value < 0 || edit.value > 30) {
              return invalid(res, 422, 'unsupported-edit');
            }
          }
          placements += op.edits.length;
        } else return invalid(res, 422, 'unsupported-edit');
        if (placements > 2) return invalid(res, 422, 'unsupported-edit');
      }
      // No await between revision check and replace: one atomic memory transaction.
      const changed = pure.applyOps(structuredClone(state.value), body.ops);
      const nextValue = checkedFilm(pure.readFilm(changed));
      const nextText = pure.filmHtml(nextValue, state.text);
      if (typeof nextText !== 'string' || !nextText) throw Error();
      const next = { value: nextValue, text: nextText, rev: hash(nextText).digest('hex').slice(0, 16) };
      state = next;
      return json(res, 200, { ...next, doc: next.value, rebased: false });
    } catch { if (active && !res.writableEnded) return invalid(res, 400, 'invalid-edit'); }
  }
  const studioServer = makeServer((req, res) => {
    if (!hasAccess(req, studioOrigin)) return response(res, 403, 'denied');
    const path = req.url ?? '', origin = header(req, 'origin');
    if (origin !== undefined && origin !== studioOrigin) return response(res, 403, 'denied');
    if (path === projectPath + '/edit' && req.method === 'POST') {
      if (origin !== studioOrigin || header(req, 'sec-fetch-site') !== 'same-origin') return response(res, 403, 'denied');
      void edit(req, res); return;
    }
    if (!noBody(req)) return response(res, 403, 'denied');
    const document = path === '/' || path === '/projects/local-experience';
    const asset = req.method === 'GET' && studioAssets.get(document ? '/index.html' : path);
    if (asset && path !== '/index.html') return response(res, 200, asset.bytes, asset.type, document ? studioCsp : undefined);
    const read = reads.get(req.method + ' ' + path);
    if (!read || header(req, 'sec-fetch-site') !== 'same-origin' || (req.method === 'POST' && origin !== studioOrigin)) return response(res, 403, 'denied');
    return json(res, 200, read());
  });
  let boot = '', previewCsp = '';
  const previewServer = makeServer((req, res) => {
    if (!hasAccess(req, previewOrigin) || !noBody(req)) return response(res, 403, 'denied');
    const origin = header(req, 'origin'), path = req.url ?? '';
    if (origin !== undefined && origin !== studioOrigin && origin !== previewOrigin) return response(res, 403, 'denied');
    const kind = previewKind(path);
    if (req.method === 'GET' && kind) {
      if (kind === 'preview-film') return response(res, 200, state.text, 'text/html; charset=utf-8', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      const html = state.text.replace('</head>', '<style>html,body{margin:0;background:#000}section>*{visibility:hidden}</style>' +
        '<script>' + boot + '</script><script src="/__film/bridge.js"></script><script type="module" src="/__film/timeline.mjs"></script></head>');
      return response(res, 200, html, 'text/html; charset=utf-8', previewCsp);
    }
    const script = scripts.get(path);
    if (req.method === 'GET' && script) return response(res, 200, script === 'bridgeJs' ? browser[script].replace('__EDITOR__', JSON.stringify(studioOrigin)) : browser[script], 'text/javascript; charset=utf-8');
    const name = imageName(path);
    if ((req.method === 'GET' || req.method === 'HEAD') && name) return response(res, 200, req.method === 'HEAD' ? '' : images.get(name)!,
      'image/svg+xml', "default-src 'none'; style-src 'none'; sandbox; frame-ancestors 'none'");
    return response(res, 403, 'denied');
  });
  const denyUpgrade = (socket: Duplex) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  previewServer.on('upgrade', (req, socket) => { hasAccess(req, previewOrigin); denyUpgrade(socket); });
  studioServer.on('upgrade', (req, socket, head) => {
    const global = globalEvents.test(req.url ?? ''), key = header(req, 'sec-websocket-key');
    if (!hasAccess(req, studioOrigin) || !noBody(req) || req.method !== 'GET' || (!global && req.url !== projectPath + '/events') ||
      header(req, 'origin') !== studioOrigin || header(req, 'upgrade')?.toLowerCase() !== 'websocket' ||
      header(req, 'sec-websocket-version') !== '13' || !key || !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
      Buffer.from(key, 'base64').toString('base64') !== key || !/\bupgrade\b/i.test(header(req, 'connection') ?? '')) return denyUpgrade(socket);
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    bindWsInput(socket, head, global);
  });
  try {
    previewOrigin = await listen(previewServer); studioOrigin = await listen(studioServer); wsOrigin = studioOrigin.replace('http:', 'ws:');
    studioCsp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: " +
      previewOrigin + "; connect-src 'self' " + wsOrigin + "; frame-src " + previewOrigin +
      "; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'";
    boot = 'window.filmHost={version:"0.1",name:"film"};addEventListener("message",e=>{if(e.origin!==' +
      JSON.stringify(studioOrigin) + '||e.source!==parent)e.stopImmediatePropagation();},true);';
    previewCsp = "default-src 'none'; script-src 'self' 'sha256-" + hash(boot).digest('base64') +
      "'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; sandbox allow-scripts allow-same-origin; frame-ancestors " +
      studioOrigin + "; frame-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'";
  } catch { await close(); throw Error('Studio experience listener failed'); }
  return Object.freeze({ studioOrigin, previewOrigin, close,
    route(url: string, method: string): StudioExperienceRoute | undefined {
      if (!authorized()) return;
      if (url.startsWith(studioOrigin + '/')) {
        const path = url.slice(studioOrigin.length);
        if (method === 'GET' && (path === '/' || path === '/projects/local-experience')) return 'document';
        if (method === 'GET' && path !== '/index.html' && studioAssets.has(path)) return 'asset';
        if (reads.has(method + ' ' + path) || method === 'POST' && path === projectPath + '/edit') return 'api';
      } else if (url.startsWith(previewOrigin + '/')) {
        const path = url.slice(previewOrigin.length);
        if (method === 'GET' && previewKind(path)) return previewKind(path);
        if (method === 'GET' && scripts.has(path)) return 'preview-runtime';
        if ((method === 'GET' || method === 'HEAD') && imageName(path)) return 'preview-asset';
      } else if (method === 'GET' && url.startsWith(wsOrigin + '/')) {
        const path = url.slice(wsOrigin.length);
        if (globalEvents.test(path) || path === projectPath + '/events') return 'ws';
      }
    },
    requestHeaders(headers: Record<string, string>, allow: boolean) {
      const stripped = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== accessHeader));
      if (authorized() && allow) stripped[accessHeader] = token.toString('hex');
      return stripped;
    },
  });
}
