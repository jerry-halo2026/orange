// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
import { pipeline } from 'node:stream/promises';
import { HttpError, json, readJson } from './http.mjs';

/** A narrow adapter for the native Studio API. Paths never come from the page.
 * @param {{service:any,draft:any,auth:any}} options
 */
export function createLocalFissionRoutes({ service, draft, auth }) {
  const unavailable = () => { throw new HttpError(503, 'Local batch editing is not configured.', { code: 'fission-local-unavailable' }); };
  const owner = () => {
    if (!auth || typeof auth.assertActive !== 'function') throw new HttpError(403, 'Sign in is required.', { code: 'authentication-required' });
    try { return auth.assertActive(); } catch { throw new HttpError(403, 'Sign in is required.', { code: 'authentication-required' }); }
  };
  /** @param {import('node:http').IncomingMessage} req */
  const body = async (req) => {
    const value = await readJson(req, 64 * 1024);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Invalid request.');
    return value;
  };
  /** @param {object} value */ const empty = value => Object.keys(value).length === 0;
  /** @param {unknown} value */ const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
  /** @param {string} value */ const index = value => /^\d{1,4}$/.test(value) ? Number(value) : NaN;
  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {string[]} parts */
  return async (req, res, parts) => {
    if (parts[0] !== 'fission-local') return false;
    const evidence = owner();
    if (!service) unavailable();
    try {
      if (parts.length === 2 && parts[1] === 'select' && req.method === 'POST') {
        const value = await body(req);
        if (Object.keys(value).length !== 1 || !['video', 'audio', 'bgm', 'intro', 'outro'].includes(value.role)) throw new HttpError(400, 'Choose a supported material role.');
        json(res, 200, await service.select(evidence, value.role)); return true;
      }
      if (parts.length === 2 && parts[1] === 'jobs' && req.method === 'POST') {
        const value = await body(req);
        if (Object.keys(value).length !== 3 || !Object.hasOwn(value, 'selections') || !Object.hasOwn(value, 'job') || !id(value.requestId)) throw new HttpError(400, 'Invalid batch request.');
        json(res, 202, await service.start(evidence, value)); return true;
      }
      if (parts.length === 2 && parts[1] === 'jobs' && req.method === 'GET') {
        json(res, 200, await service.list(evidence)); return true;
      }
      if (parts.length === 3 && parts[1] === 'requests' && id(parts[2]) && req.method === 'GET') {
        json(res, 200, await service.find(evidence, parts[2])); return true;
      }
      if (parts[1] === 'jobs' && id(parts[2])) {
        const jobId = parts[2];
        if (parts.length === 3 && req.method === 'GET') { json(res, 200, await service.status(evidence, jobId)); return true; }
        if (parts.length === 4 && parts[3] === 'cancel' && req.method === 'POST') {
          if (!empty(await body(req))) throw new HttpError(400, 'Invalid cancellation request.');
          json(res, 200, await service.cancel(evidence, jobId)); return true;
        }
        const outputIndex = index(parts[4] ?? '');
        if (parts.length === 6 && parts[3] === 'outputs' && Number.isSafeInteger(outputIndex)) {
          if (parts[5] === 'draft' && req.method === 'GET') {
            if (!draft) unavailable();
            json(res, 200, await draft.status({ jobId, index: outputIndex })); return true;
          }
          if (parts[5] === 'draft' && req.method === 'POST') {
            if (!empty(await body(req))) throw new HttpError(400, 'Invalid draft request.');
            if (!draft) unavailable();
            const abort = new AbortController();
            const closed = () => { if (!res.writableFinished) abort.abort(); };
            res.once('close', closed);
            try { json(res, 200, await draft.importSelected({ jobId, index: outputIndex }, abort.signal)); }
            finally { res.removeListener('close', closed); }
            return true;
          }
          if (parts[5] === 'video' && req.method === 'GET') {
            const range = req.headers.range;
            const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
            if (range && !match) throw new HttpError(416, 'Unsupported video range.');
            const start = match ? Number(match[1]) : undefined;
            const end = match && match[2] ? Number(match[2]) : undefined;
            if ((start !== undefined && !Number.isSafeInteger(start)) || (end !== undefined && !Number.isSafeInteger(end))) throw new HttpError(416, 'Unsupported video range.');
            const video = await service.openOutput(evidence, { jobId, index: outputIndex, start, end });
            const headers = { 'content-type': 'video/mp4', 'cache-control': 'no-store', 'accept-ranges': 'bytes', 'content-length': String(video.end - video.start + 1), ...(match ? { 'content-range': `bytes ${video.start}-${video.end}/${video.size}` } : {}) };
            res.writeHead(match ? 206 : 200, headers);
            await pipeline(video.stream, res); return true;
          }
        }
      }
      throw new HttpError(404, 'No such local batch operation.');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const e = /** @type {{code?:unknown,status?:unknown}} */ (error ?? {});
      const code = typeof e.code === 'string' && /^[a-z0-9-]{1,80}$/.test(e.code) ? e.code : 'fission-local-failed';
      const status = Number.isInteger(e.status) && Number(e.status) >= 400 && Number(e.status) <= 599 ? Number(e.status) : 500;
      throw new HttpError(status, 'The local batch operation could not be completed.', { code });
    }
  };
}
