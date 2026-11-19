// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

﻿// @ts-check
/**
 * The material centre's on-disk cache: what the provider already answered, kept out of the project
 * tree and out of memory.
 *
 * Shape (under the injected `cacheRoot`, which must come from the isolated profile or an explicit
 * caller — never from the project folder):
 *
 *   <cacheRoot>/materials/meta/<sha1>.json   one upstream answer, named by its query signature
 *   <cacheRoot>/materials/cover/<sha1>.bin   one cover image, named by the provider's id
 *   <cacheRoot>/materials/cover/<sha1>.type  that image's content type
 *
 * A stale answer is still an answer: readers get it immediately and one background revalidation
 * is asked for, which never overwrites a newer write and never erases the old body on failure.
 * Covers are only fetched when somebody asks for that cover — nothing here walks a list.
 *
 * Capacity: the whole tree is bounded by `maxBytes` (512 MB unless injected), and the least
 * recently *used* entry goes first. Use is the file's mtime, bumped on every hit, so eviction
 * needs no side index that could drift from the files.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';

/** Answers that describe one page of the provider's catalogue. */
export const META_TTL_MS = 15 * 60_000;
/** Answers that describe the catalogue's own vocabulary (categories, states, labels). */
export const DICTIONARY_TTL_MS = 24 * 60 * 60_000;
/** Room for every cached answer and cover together. */
export const MAX_BYTES = 512 * 1024 * 1024;
/**
 * The shape of the answers this cache stores. It is part of every key, so a server-side fix that
 * changes what an answer looks like is visible at once instead of after the dictionary's 24 hours.
 * Bump it whenever a route's response contract changes shape (fields renamed, wrapped or unwrapped,
 * numbers turned into strings…). It is deliberately separate from the file format ersion below:
 * that one only says how the cache file itself is written.
 */
export const SHAPE_VERSION = 2;

/** A provider cover id, or a query signature: 40 hex digits, nothing else. @param {unknown} value */
export const isCacheName = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/**
 * The name of one upstream answer: the route and every parameter, sorted, so the same question
 * asked in another order is the same file.
 * @param {string} route @param {Record<string, string | string[]>} params @param {number} [shapeVersion]
 */
export function querySignature(route, params, shapeVersion = SHAPE_VERSION) {
  const pairs = Object.entries(params)
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return createHash('sha1').update(`${route}\u0000${shapeVersion}\u0000${pairs}`).digest('hex');
}

/**
 * @param {{ root: string, maxBytes?: number, metaTtlMs?: number, dictionaryTtlMs?: number, now?: () => number, evictIntervalMs?: number, shapeVersion?: number }} options
 */
export function createMaterialsCache({ root, maxBytes = MAX_BYTES, metaTtlMs = META_TTL_MS, dictionaryTtlMs = DICTIONARY_TTL_MS, now = Date.now, evictIntervalMs = 5_000, shapeVersion = SHAPE_VERSION }) {
  if (typeof root !== 'string' || !root) throw new TypeError('a materials cache root is required');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive number');
  const base = join(root, 'materials');
  const metaDir = join(base, 'meta');
  const coverDir = join(base, 'cover');
  /** @type {number} */
  let lastEvict = 0;
  /** @type {Promise<void> | null} */
  let evicting = null;

  /** @param {string} file */
  const touch = async (file) => {
    try { const stamp = new Date(now()); await utimes(file, stamp, stamp); } catch { /* gone: nothing to keep warm */ }
  };

  /** Everything the tree holds, oldest use first. */
  async function entries() {
    /** @type {{ path: string, size: number, used: number }[]} */
    const found = [];
    for (const dir of [metaDir, coverDir]) {
      /** @type {string[]} */
      let names;
      try { names = await readdir(dir); } catch { continue; }
      for (const name of names) {
        if (name.endsWith('.tmp')) continue;
        const path = join(dir, name);
        try {
          const info = await stat(path);
          if (info.isFile()) found.push({ path, size: info.size, used: info.mtimeMs });
        } catch { /* gone meanwhile */ }
      }
    }
    return found.sort((a, b) => a.used - b.used);
  }

  /** Drop the least recently used entries until the tree fits `maxBytes`. */
  async function evict({ force = false } = {}) {
    if (evicting) return evicting;
    if (!force && now() - lastEvict < evictIntervalMs) return;
    lastEvict = now();
    evicting = (async () => {
      const all = await entries();
      let total = all.reduce((sum, entry) => sum + entry.size, 0);
      for (const entry of all) {
        if (total <= maxBytes) break;
        try { await rm(entry.path, { force: true }); total -= entry.size; } catch { /* someone else took it */ }
      }
    })().finally(() => { evicting = null; });
    return evicting;
  }

  return {
    root: base,
    metaDir,
    coverDir,
    maxBytes,
    /** One upstream answer, with its age, when this exact question was answered before. @param {string} route @param {Record<string, string | string[]>} params */
    async readMeta(route, params) {
      const key = querySignature(route, params, shapeVersion);
      const file = join(metaDir, `${key}.json`);
      /** @type {string} */
      let raw;
      try { raw = await readFile(file, 'utf8'); } catch { return null; }
      /** @type {{ version?: number, shapeVersion?: number, route?: string, savedAt?: number, ttlMs?: number, status?: number, body?: unknown }} */
      let stored;
      try { stored = JSON.parse(raw); } catch { await rm(file, { force: true }); return null; }
      // Two versions, never one: 'version' is the file format, 'shapeVersion' the answer's shape.
      // An entry written for another shape is not this question's answer — keep nothing of it.
      if (stored?.version !== 1 || stored.shapeVersion !== shapeVersion
        || typeof stored.savedAt !== 'number' || typeof stored.ttlMs !== 'number') { await rm(file, { force: true }); return null; }
      await touch(file);
      return { key, body: stored.body, status: stored.status ?? 200, savedAt: stored.savedAt, stale: now() - stored.savedAt >= stored.ttlMs };
    },
    /** @param {string} route @param {Record<string, string | string[]>} params @param {unknown} body @param {number} ttlMs */
    async writeMeta(route, params, body, ttlMs, status = 200) {
      const key = querySignature(route, params, shapeVersion);
      await mkdir(metaDir, { recursive: true });
      await writeAtomic(join(metaDir, `${key}.json`), JSON.stringify({ version: 1, shapeVersion, route, savedAt: now(), ttlMs, status, body }));
      await evict();
      return key;
    },
    /** A cover already on disk. @param {string} name */
    async readCover(name) {
      if (!isCacheName(name)) return null;
      const file = join(coverDir, `${name}.bin`);
      /** @type {Buffer} */
      let bytes;
      try { bytes = await readFile(file); } catch { return null; }
      /** @type {string} */
      let contentType = 'application/octet-stream';
      try { contentType = (await readFile(join(coverDir, `${name}.type`), 'utf8')).trim() || contentType; } catch { /* keep the default */ }
      await touch(file);
      return { bytes, contentType, key: name };
    },
    /** @param {string} name @param {Uint8Array} bytes @param {string} contentType */
    async writeCover(name, bytes, contentType) {
      if (!isCacheName(name)) throw new TypeError('a cover is named by its provider id (40 hex digits)');
      await mkdir(coverDir, { recursive: true });
      await writeFile(join(coverDir, `${name}.type`), contentType);
      await writeAtomic(join(coverDir, `${name}.bin`), bytes);
      await evict();
      return join(coverDir, `${name}.bin`);
    },
    /** Forget everything: the person asked for a clean slate. */
    async clear() {
      await rm(base, { recursive: true, force: true });
    },
    /** What the tree holds now, for tests and diagnostics. */
    async stats() {
      const all = await entries();
      return { files: all.length, bytes: all.reduce((sum, entry) => sum + entry.size, 0) };
    },
    evict,
  };
}

/** @typedef {ReturnType<typeof createMaterialsCache>} MaterialsCache */




