// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 分区 + 续传抓取器：按 `videoType × twoLevelTypeIds` 切片，每片一页页抓；`state.json` 记住每片下一页，
 * 进程退出/429 之后从上次端点继续。索引由 `rows.jsonl` 重建。
 *
 * 用法（dev）：
 *   STUDIO_ORIGIN=http://127.0.0.1:4757 STUDIO_KEY=... INDEX_DIR=... \
 *     node packages/openfilm/scripts/material-index-resume.mjs [--max-pages N] [--no-partition]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMaterialIndex } from '../src/material-index.mjs';
import { INDEX_SCHEMA, MATERIAL_VIDEO_TYPES, PAGE_SIZE, rowsFromPage, writeMaterialIndex } from '../src/material-index-build.mjs';
import { fetchPageFromStudio } from './material-index-build.mjs';

const ROWS = 'rows.jsonl';
const STATE = 'state.json';

const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
};

function loadRows(dir) {
  const path = join(dir, ROWS);
  const rows = new Map();
  if (!existsSync(path)) return rows;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.videoId) rows.set(String(row.videoId), row);
    } catch { /* a torn last line is not a row */ }
  }
  return rows;
}

async function facets(origin, key, videoType) {
  const response = await fetch(`${origin}/api/materials/facets?scope=company&videoType=${videoType}`, {
    headers: { accept: 'application/json', 'x-studio-key': key, origin },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) return [];
  return Array.isArray(body.twoLevel) ? body.twoLevel.map((row) => row?.id).filter((id) => Number.isInteger(id)) : [];
}

function nextDate(date) {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

function monthDays(filter) {
  const start = filter.uploadStartTime;
  const end = filter.uploadEndTime;
  const [year, month] = start.split('-').map(Number);
  const days = [];
  for (let day = 1; day <= 31; day += 1) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (date > end) break;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (parsed.getUTCMonth() + 1 !== month) break;
    days.push(date);
  }
  return days;
}

/** 日期窗口：按月切片（供应商支持 uploadStartTime/uploadEndTime 成对）；总量过大时再拆到天。 */
function buildSlices() {
  const slices = [];
  for (const videoType of MATERIAL_VIDEO_TYPES) {
    for (let year = 2023; year <= 2026; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        if (year === 2026 && month > 11) break;
        const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const start = `${year}-${String(month).padStart(2, '0')}-01`;
        const end = `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
        slices.push({ key: `${videoType}|date:${start}..${end}`, videoType, filter: { uploadStartTime: start, uploadEndTime: end }, pageNo: 1, total: null, rows: 0, stopped: null });
      }
    }
  }
  return slices;
}

function land(dir, rows, claimed, slices) {
  const index = buildMaterialIndex([...rows.values()], new Date(), {
    sourceTotal: claimed, pageable: rows.size, unreachable: Math.max(0, claimed - rows.size),
  });
  return {
    schema: INDEX_SCHEMA,
    generatedAt: index.generatedAt,
    staleAfterMs: 24 * 60 * 60 * 1000,
    sourceTotal: claimed,
    pageable: rows.size,
    unreachable: Math.max(0, claimed - rows.size),
    duplicates: 0,
    videos: index.totals.videos,
    parsed: index.totals.parsed,
    unclassified: index.totals.unclassified,
    pageSize: PAGE_SIZE,
    pages: { fetched: slices.reduce((n, s) => n + (s.pages ?? 0), 0), backedOff: 0, perType: [] },
    warnings: [],
    index,
  };
}

async function main() {
  const dir = process.env.INDEX_DIR;
  const origin = String(process.env.STUDIO_ORIGIN ?? '').replace(/\/+$/, '');
  const maxPages = Number(process.argv.find((arg) => arg.startsWith('--max-pages='))?.split('=')[1] ?? 0) || Infinity;
  const keyFile = String(process.argv.find((arg) => arg.startsWith('--key-file='))?.split('=').slice(1).join('=') ?? '');
  const waitKeyMs = (Number(process.argv.find((arg) => arg.startsWith('--wait-key-min='))?.split('=')[1] ?? 15) || 15) * 60_000;
  let key = process.env.STUDIO_KEY ?? '';
  if (!key && keyFile) { try { key = readFileSync(keyFile, 'utf8').trim(); } catch { /* no file */ } }
  if (!dir || !origin || !key) throw new Error('INDEX_DIR, STUDIO_ORIGIN and (STUDIO_KEY or --key-file) are required');
  mkdirSync(dir, { recursive: true });
  const readKey = () => {
    if (!keyFile) return '';
    try { return readFileSync(keyFile, 'utf8').trim(); } catch { return ''; }
  };
  let fetchPage = fetchPageFromStudio({ origin, key, scope: 'company' });
  const throttleMs = Number(process.argv.find((arg) => arg.startsWith('--throttle-ms='))?.split('=')[1] ?? 0) || 0;
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  /** 429 退避重试；其他错误才停片。 */
  const fetchWithRetry = async (ask) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (throttleMs) await sleep(throttleMs);
        return await fetchPage(ask);
      } catch (error) {
        const message = String(error?.message ?? error);
        const limited = /HTTP 429|限流|rate/i.test(message);
        const transient = /HTTP 503|时钟不可信|provider-clock-unconfirmed|暂时|超时|timeout/i.test(message);
        if ((!limited && !transient) || attempt >= 10) throw error;
        await sleep(limited ? 5000 * attempt : 4000 * attempt);
      }
    }
  };
  const saved = readJson(join(dir, STATE), { slices: [], claimed: 0 });
  const rows = loadRows(dir);
  let slices = Array.isArray(saved.slices) && saved.slices.length ? saved.slices : [];
  if (!slices.length) slices = buildSlices();
  let fetched = 0;
  for (const slice of slices) {
    if (slice.stopped && slice.stopped !== 'page-failed') continue;
    if (slice.stopped === 'page-failed') slice.stopped = null;
    for (;;) {
      if (fetched >= maxPages) break;
      let page;
      try {
        page = await fetchWithRetry({ videoType: slice.videoType, pageNo: slice.pageNo, pageSize: PAGE_SIZE, extra: slice.filter });
      } catch (error) {
        const message = String(error?.message ?? error);
        /* 会话失效：如果给了 --key-file，就等登录后的新 key（最多 --wait-key-min 分钟），再重试同一页。 */
        if (keyFile && /HTTP 40[13]|authentication-required|Sign in is required/i.test(message)) {
          const until = Date.now() + waitKeyMs;
          console.warn(`slice ${slice.key} page ${slice.pageNo}: 会话失效，等待新 key（最多 ${Math.round(waitKeyMs / 60000)} 分钟）`);
          let rotated = false;
          while (Date.now() < until) {
            const next = readKey();
            if (next && next !== key) {
              key = next;
              fetchPage = fetchPageFromStudio({ origin, key, scope: 'company' });
              rotated = true;
              break;
            }
            await sleep(10_000);
          }
          if (rotated) continue;
        }
        console.warn(`slice ${slice.key} page ${slice.pageNo}: ${error?.message ?? error} — 保存后退出，下次继续`);
        slice.stopped = 'page-failed';
        writeFileSync(join(dir, STATE), JSON.stringify({ slices, claimed: saved.claimed }, null, 2));
        await writeMaterialIndex(dir, land(dir, rows, saved.claimed, slices));
        return;
      }
      const pageRows = rowsFromPage(page.items);
      const known = new Set(rows.keys());
      const fresh = [];
      for (const row of pageRows) {
        if (!row?.videoId || known.has(String(row.videoId))) continue;
        known.add(String(row.videoId));
        rows.set(String(row.videoId), row);
        fresh.push(row);
      }
      if (fresh.length) appendFileSync(join(dir, ROWS), fresh.map((row) => JSON.stringify(row)).join('\n') + '\n');
      fetched += 1;
      slice.pages = (slice.pages ?? 0) + 1;
      slice.rows += fresh.length;
      const total = typeof page.total === 'number' ? page.total
        : page.total && typeof page.total === 'object' && typeof page.total.source === 'string' ? Number(page.total.source) : null;
      if (total !== null && Number.isFinite(total)) slice.total = total;
      const signature = pageRows.map((row) => String(row?.videoId ?? '')).join(',');
      const same = slice.lastSignature !== undefined && signature === slice.lastSignature;
      slice.lastSignature = signature;
      const stopped = same ? 'repeat-page' : pageRows.length < PAGE_SIZE ? 'short-page' : slice.total !== null && slice.rows >= slice.total ? 'reached-total' : null;
      /* 月片被 clamp（重复页）或首屏 total 过大：拆成按天，再逐片翻。 */
      if (!slice.day && slice.filter.uploadStartTime && (stopped === 'repeat-page' || (slice.pageNo === 1 && (slice.total ?? 0) > 15_000))) {
        const at = slices.indexOf(slice);
        const days = monthDays(slice.filter);
        const made = days.map((date) => ({
          key: `${slice.videoType}|date:${date}`, videoType: slice.videoType,
          filter: { uploadStartTime: date, uploadEndTime: nextDate(date) }, day: true,
          pageNo: 1, total: null, rows: 0, stopped: null,
        })).filter((row) => !slices.some((have) => have.key === row.key));
        slices.splice(at + 1, 0, ...made);
        slice.stopped = 'split';
        slice.pageNo += 1;
        saved.claimed = slices.reduce((n, s) => n + (typeof s.total === 'number' ? s.total : 0), 0);
        writeFileSync(join(dir, STATE), JSON.stringify({ slices, claimed: saved.claimed }, null, 2));
        break;
      }
      if (stopped) slice.stopped = stopped;
      if (stopped) slice.stopped = stopped;
      slice.pageNo += 1;
      saved.claimed = slices.reduce((n, s) => n + (typeof s.total === 'number' ? s.total : 0), 0);
      writeFileSync(join(dir, STATE), JSON.stringify({ slices, claimed: saved.claimed }, null, 2));
      if (stopped) break;
    }
  }
  const result = land(dir, rows, saved.claimed, slices);
  await writeMaterialIndex(dir, result);
  console.log(`videos ${result.videos} products ${result.index.products?.length ?? 0} slices ${slices.length} pages ${fetched}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
