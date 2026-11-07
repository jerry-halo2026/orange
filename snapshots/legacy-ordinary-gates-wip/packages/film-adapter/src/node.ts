import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';

const sourcePin = '2e18a4bdf54647b2ece3c0975a6f9573720c7821';
const sourceLedger = 'ceeec16d948e301de54a8a06e2d1faa050291777833b49cd9b7edfbbc077d9d6';
const buildReceipt = 'studio-build.json';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes);
const assetSlots = [
  /^index\.html$/, /^assets\/studio-[\w-]+\.js$/, /^assets\/index-[\w-]+\.css$/,
  ...['cyrillic-ext', 'cyrillic', 'greek-ext', 'greek', 'latin-ext', 'latin', 'vietnamese']
    .map((name) => new RegExp('^assets/inter-' + name + '-wght-normal-[\\w-]+\\.woff2$')),
];
const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function getStudioSourceVersion(): string {
  return sourcePin;
}

function requireDirectory(path: string) {
  if (!lstatSync(path).isDirectory() || realpathSync.native(path) !== path) throw Error();
}

function readExactFile(path: string, limit: number, expected?: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || (expected !== undefined && stat.size !== expected) ||
    realpathSync.native(path) !== path) throw Error();
  const fd = openSync(path, 'r');
  try {
    const physical = fstatSync(fd);
    if (!physical.isFile() || physical.nlink !== 1 || physical.ino !== stat.ino || physical.dev !== stat.dev ||
      physical.size !== stat.size || realpathSync.native(path) !== path) throw Error();
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length !== stat.size) throw Error();
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function exactDirectoryEntries(path: string, expected: string[]) {
  const actual = readdirSync(path);
  if (actual.length !== expected.length || !actual.every((name) => expected.includes(name))) throw Error();
}

// Called only by native code. Once checked, HTTP serves this private byte snapshot,
// never a file looked up from a request URL (not even for known URLs).
export function readStudioAssets(directory: string, trustedReceiptSha256: string) {
  try {
    if (!isDigest(trustedReceiptSha256) || directory !== resolve(directory)) throw Error();
    requireDirectory(directory);
    exactDirectoryEntries(directory, ['index.html', buildReceipt, 'assets']);
    const assetsDirectory = join(directory, 'assets');
    requireDirectory(assetsDirectory);
    const receipt = readExactFile(join(directory, buildReceipt), 64 * 1024);
    if (hash(receipt).digest('hex') !== trustedReceiptSha256) throw Error();
    const parsed = JSON.parse(receipt.toString('utf8')) as {
      source: { pin: unknown; ledgerSha256: unknown; files: unknown };
      artifacts: Array<{ name: string; bytes: number; sha256: string }>;
    };
    if (parsed.source.pin !== sourcePin || parsed.source.ledgerSha256 !== sourceLedger || parsed.source.files !== 235 ||
      !Array.isArray(parsed.artifacts) || parsed.artifacts.length !== assetSlots.length) throw Error();
    const slots = new Set<number>();
    for (const { name, bytes, sha256 } of parsed.artifacts) {
      const slot = typeof name === 'string' ? assetSlots.findIndex((pattern) => pattern.test(name)) : -1;
      if (slot < 0 || slots.has(slot) || !Number.isSafeInteger(bytes) || bytes < 1 || !isDigest(sha256)) throw Error();
      slots.add(slot);
    }
    exactDirectoryEntries(assetsDirectory, parsed.artifacts.filter(({ name }) => name !== 'index.html')
      .map(({ name }) => name.slice('assets/'.length)));
    return new Map(parsed.artifacts.map(({ name, bytes, sha256 }) => {
      const data = readExactFile(join(directory, name), 3 * 1024 * 1024, bytes);
      if (hash(data).digest('hex') !== sha256) throw Error();
      const type = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8'
        : name.endsWith('.woff2') ? 'font/woff2' : 'text/html; charset=utf-8';
      return ['/' + name, { bytes: data, type }];
    }));
  } catch {
    throw Error('Studio fixture build verification failed');
  }
}

const projectPath = '/api/projects/fixture-project';
const project = { id: 'fixture-project', name: 'Orange local fixture project', path: 'fixture-only', missing: false, openedAt: 1 };
const film = { stage: { w: 640, h: 360 }, tracks: [] };
const version = { version: '0.0.0' };
const globalEvent = /^\/api\/events\?visible=[01]$/;
const previewPath = /^\/film\.html\?load=([1-9]\d{0,3})&film-missing=skip(?:&film-dpr=(\d(?:\.\d{1,6})?))?$/;
const accessHeader = 'x-orange-studio-access';
const wsGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const denied = 'denied';

function previewRoute(path: string): boolean {
  const match = previewPath.exec(path);
  return !!match && (!match[2] || (Number(match[2]) >= 0.25 && Number(match[2]) <= 4));
}

function previewDocument(parent: string) {
  const origin = JSON.stringify(parent);
  const script = `
const studio = ${origin};
addEventListener('message', ({ origin, source, data }) => {
  if (origin !== studio || source !== parent || data?.source !== 'openfilm-studio' ||
      data.type !== 'seek' || data.t !== 0 || !Number.isSafeInteger(data.seq) || data.seq < 1 ||
      Object.keys(data).some((key) => !['source','type','t','seq','behind'].includes(key)) ||
      (Object.hasOwn(data, 'behind') && typeof data.behind !== 'boolean')) return;
  const reply = { source: 'openfilm-film', type: 'seeked', t: data.t, seq: data.seq };
  if (!Object.hasOwn(window, '__orangeFixtureFirstSeek')) {
    Object.defineProperty(window, '__orangeFixtureFirstSeek', { value: Object.freeze(reply) });
  }
  parent.postMessage(reply, studio);
});
parent.postMessage({source:'openfilm-film',type:'ready',duration:0,width:640,height:360,
  sounds:[],spans:[],origin:performance.timeOrigin}, studio);
`;
  return {
    html: '<!doctype html><meta charset="utf-8"><title>Orange fixture preview</title><body>Empty synthetic preview<script>' +
      script + '</script></body>',
    csp: "default-src 'none'; script-src 'sha256-" + hash(script).digest('base64') +
      "'; sandbox allow-scripts allow-same-origin; frame-ancestors " + parent +
      "; base-uri 'none'; object-src 'none'; form-action 'none'",
  };
}

function response(res: ServerResponse, code: number, bytes: string | Buffer, type = 'text/plain; charset=utf-8', csp?: string) {
  res.writeHead(code, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', ...(csp ? { 'Content-Security-Policy': csp } : {}),
  });
  res.end(bytes);
}

function header(req: IncomingMessage, name: string): string | undefined {
  return typeof req.headers[name] === 'string' ? req.headers[name] : undefined;
}

function sendWs(socket: Duplex, opcode: number, payload: Buffer) {
  socket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]));
}

// The observed App sends only a small visibility notification to the global
// socket; no client message invokes an operation. Bound the RFC6455 subset.
function bindWsInput(socket: Duplex, head: Buffer, global: boolean) {
  let remainder = Buffer.alloc(0);
  const consume = (data: Buffer) => {
    if (remainder.length + data.length > 512) return socket.destroy();
    remainder = Buffer.concat([remainder, data]);
    while (remainder.length >= 2) {
      const opcode = remainder[0] & 0x0f;
      const size = remainder[1] & 0x7f;
      if ((remainder[0] & 0xf0) !== 0x80 || !(remainder[1] & 0x80) || size > 125) return socket.destroy();
      if (remainder.length < size + 6) return;
      const payload = Buffer.from(remainder.subarray(6, size + 6));
      for (let i = 0; i < size; i++) payload[i] ^= remainder[2 + i % 4];
      remainder = remainder.subarray(size + 6);
      if (opcode === 8) {
        sendWs(socket, 8, payload);
        return socket.end();
      }
      if (opcode === 9) sendWs(socket, 10, payload);
      else if (opcode !== 10 && (opcode !== 1 || !global || !/^\{"visible":(?:true|false)\}$/.test(payload.toString()))) {
        return socket.destroy();
      }
    }
  };
  socket.on('data', consume);
  if (head.length) consume(head);
}

export type StudioFixtureRoute = 'document' | 'asset' | 'api' | 'ws' | 'preview';

export async function startStudioFixture(directory: string, trustedReceiptSha256: string, onFailure: () => void) {
  const assets = readStudioAssets(directory, trustedReceiptSha256);
  const token = randomBytes(32);
  let active = true;
  let listing = true;
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  const globalSockets = new Set<Duplex>();
  let stopped: Promise<void> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function close(): Promise<void> {
    if (stopped) return stopped;
    active = false;
    clearTimeout(deadline);
    token.fill(0);
    stopped = Promise.all(servers.map((server) =>
      new Promise<void>((done) => { server.close(() => done()); }))).then(() => {});
    for (const socket of sockets) socket.destroy();
    return stopped;
  }
  function makeServer(handle: (req: IncomingMessage, res: ServerResponse) => void) {
    const server = createServer({ maxHeaderSize: 8192, headersTimeout: 2500, requestTimeout: 3000, keepAliveTimeout: 1500 }, handle);
    servers.push(server);
    server.maxConnections = 32;
    server.maxHeadersCount = 64;
    server.setTimeout(4000, (socket) => socket.destroy());
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => sockets.delete(socket));
      if (!active) socket.destroy();
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    server.on('connect', (_request, socket) => socket.destroy());
    server.on('checkContinue', (_req, res) => response(res, 403, denied));
    return server;
  }
  const listen = (server: Server) => new Promise<string>((done, fail) => {
    server.once('error', fail);
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      server.off('error', fail);
      server.on('error', () => { void close(); onFailure(); });
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') fail(Error());
      else done('http://127.0.0.1:' + address.port);
    });
  });
  const routes = new Map<string, () => object>([
    ['GET /api/examples', () => ({ examples: [] })],
    ['GET /api/health', () => version],
    ['GET /api/prefs', () => ({ seenVersion: '99.0.0', autoVersions: false })],
    ['GET /api/projects', () => ({ projects: listing ? [project] : [] })],
    ['GET /api/projects/folders', () => ({ folders: [] })],
    ['GET /api/skills', () => ({ skills: [] })],
    ['GET /api/version', () => version],
    ['GET ' + projectPath, () => ({ project, folder: previewOrigin + '/', text: '<!doctype html><body></body>',
      rev: 'fixture-only', value: film, doc: film, problems: [] })],
    ['GET ' + projectPath + '/files', () => ({ files: [], folders: [], pages: [] })],
    ['GET ' + projectPath + '/settings', () => ({ settings: { fps: 30 } })],
    ['GET ' + projectPath + '/markers', () => ({ markers: [] })],
    ['POST ' + projectPath + '/opened', () => ({ project })], // No mutation.
  ]);
  function hasAccess(req: IncomingMessage, target: string) {
    const supplied = header(req, accessHeader);
    if (!active || req.socket.remoteAddress !== '127.0.0.1' || header(req, 'host') !== target.slice('http://'.length) ||
      !isDigest(supplied)) return false;
    const single = new Set<string>();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i].toLowerCase();
      if (!['host', 'origin', 'sec-fetch-site', accessHeader, 'upgrade', 'sec-websocket-key', 'sec-websocket-version'].includes(key)) continue;
      if (single.has(key)) return false;
      single.add(key);
    }
    return timingSafeEqual(Buffer.from(supplied, 'hex'), token);
  }
  const noBody = (req: IncomingMessage) => !req.headers['transfer-encoding'] &&
    (req.headers['content-length'] === undefined || req.headers['content-length'] === '0');
  let studioOrigin = '', previewOrigin = '', wsOrigin = '', studioCsp = '';
  let preview: ReturnType<typeof previewDocument>;
  const studioServer = makeServer((req, res) => {
    const path = req.url ?? '';
    if (!hasAccess(req, studioOrigin) || !noBody(req)) return response(res, 403, denied);
    const origin = header(req, 'origin');
    if (origin !== undefined && origin !== studioOrigin) return response(res, 403, denied);
    const asset = req.method === 'GET' && assets.get(path === '/' ? '/index.html' : path);
    if (asset && path !== '/index.html') {
      return response(res, 200, asset.bytes, asset.type, path === '/' ? studioCsp : undefined);
    }
    const route = routes.get(req.method + ' ' + path);
    if (!route || header(req, 'sec-fetch-site') !== 'same-origin' ||
      (req.method === 'POST' && origin !== studioOrigin)) return response(res, 403, denied);
    return response(res, 200, JSON.stringify(route()), 'application/json; charset=utf-8');
  });
  const previewServer = makeServer((req, res) => {
    if (!hasAccess(req, previewOrigin) || !noBody(req) || req.method !== 'GET' || !previewRoute(req.url ?? '') ||
      (req.headers.origin !== undefined && req.headers.origin !== studioOrigin)) return response(res, 403, denied);
    return response(res, 200, preview.html, 'text/html; charset=utf-8', preview.csp);
  });
  const denyUpgrade = (socket: Duplex) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  previewServer.on('upgrade', (_req, socket) => denyUpgrade(socket));
  studioServer.on('upgrade', (req, socket, head) => {
    const isGlobal = globalEvent.test(req.url ?? '');
    const key = header(req, 'sec-websocket-key');
    if (!hasAccess(req, studioOrigin) || !noBody(req) || req.method !== 'GET' ||
      (!isGlobal && req.url !== projectPath + '/events') ||
      header(req, 'origin') !== studioOrigin || header(req, 'upgrade')?.toLowerCase() !== 'websocket' ||
      header(req, 'sec-websocket-version') !== '13' || !key || !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
      Buffer.from(key, 'base64').toString('base64') !== key || !/\bupgrade\b/i.test(header(req, 'connection') ?? '')) {
      denyUpgrade(socket);
      return;
    }
    const accept = createHash('sha1').update(key + wsGuid).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
      accept + '\r\n\r\n');
    if (isGlobal) {
      globalSockets.add(socket);
      socket.once('close', () => globalSockets.delete(socket));
    }
    bindWsInput(socket, head, isGlobal);
  });
  try {
    previewOrigin = await listen(previewServer);
    studioOrigin = await listen(studioServer);
    wsOrigin = studioOrigin.replace('http:', 'ws:');
    studioCsp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
      "img-src 'self' data:; connect-src 'self' " + wsOrigin + "; frame-src " + previewOrigin +
      "; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'";
    preview = previewDocument(studioOrigin);
    deadline = setTimeout(() => { void close(); onFailure(); }, 30_000).unref();
  } catch {
    await close();
    throw Error('Studio fixture listener failed');
  }

  return {
    studioOrigin, previewOrigin, close,
    route(url: string, method: string): StudioFixtureRoute | undefined {
      if (!active) return;
      // Match the exact serialized URL, not a normalized pathname.
      if (url.startsWith(studioOrigin + '/')) {
        const path = url.slice(studioOrigin.length);
        if (method === 'GET' && path === '/') return 'document';
        if (method === 'GET' && path !== '/index.html' && assets.has(path)) return 'asset';
        if (routes.has(method + ' ' + path)) return 'api';
      } else if (method === 'GET' && url.startsWith(previewOrigin + '/') && previewRoute(url.slice(previewOrigin.length))) {
        return 'preview';
      } else if (method === 'GET' && url.startsWith(wsOrigin + '/')) {
        const path = url.slice(wsOrigin.length);
        if (globalEvent.test(path) || path === projectPath + '/events') return 'ws';
      }
    },
    requestHeaders(headers: Record<string, string>, allow: boolean) {
      const stripped = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== accessHeader));
      if (active && allow) stripped[accessHeader] = token.toString('hex');
      return stripped;
    },
    showProjects() {
      if (!active) return;
      listing = false;
      const payload = Buffer.from('{"type":"open","to":"/"}');
      for (const socket of globalSockets) if (!socket.destroyed) sendWs(socket, 1, payload);
    },
  };
}

// Native-only shared transport; the original fixture remains a test-only API.
export const studioTransport = Object.freeze({ response, header, bindWsInput });
export { startStudioExperience } from './experience.ts';
export type { StudioExperience, StudioExperienceRoute, StudioExperienceRuntime } from './experience-contract.ts';
