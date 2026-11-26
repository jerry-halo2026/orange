// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 把一个 Saved bundle 收进内置模板库：复制到 `library/templates/<slug>/`，补 poster/preview（有 ffmpeg 时），
 * 并在 `library/catalogs/templates.json` 里追加条目。
 *
 *   node packages/orangefilm/scripts/import-template.mjs \
 *     --bundle "<Saved bundle 文件夹>" --slug talking-01 --group talking \
 *     --name "口播-开场自报家门" --name-en "Talking head opener" --tags "口播,开场"
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith('--')) continue;
  args[key.slice(2)] = process.argv[i + 1];
  i += 1;
}
const bundle = resolve(String(args.bundle ?? ''));
const slug = String(args.slug ?? '').trim();
const group = String(args.group ?? '').trim();
const nameZh = String(args.name ?? '').trim();
const nameEn = String(args['name-en'] ?? nameZh).trim();
const tags = String(args.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
if (!bundle || !slug || !group || !nameZh) throw new Error('--bundle --slug --group --name are required');
if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) throw new Error('--slug must be lowercase letters, digits and dashes');

const root = resolve('packages/orangefilm/library');
const target = join(root, 'templates', slug);
const catalog = join(root, 'catalogs', 'templates.json');
const savedPath = join(bundle, 'saved.json');
if (!existsSync(savedPath)) throw new Error(`no saved.json in ${bundle}`);

mkdirSync(target, { recursive: true });
cpSync(bundle, target, { recursive: true });

const saved = JSON.parse(readFileSync(savedPath, 'utf8'));
const clips = Array.isArray(saved.clips) ? saved.clips : [];
const durationMs = Math.max(1000, Math.round(clips.reduce((end, row) => Math.max(end, Number(row?.at) + Number(row?.clip?.time?.[1] ?? 0)), 0) * 1000));
const slots = clips.filter((row) => row?.clip?.attrs?.['data-props']).length;

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const firstVideo = clips.map((row) => row?.clip?.src).find((src) => typeof src === 'string');
const make = (out, extra) => {
  try {
    execFileSync(ffmpeg, ['-y', ...extra, out], { stdio: 'ignore' });
    return true;
  } catch { return false; }
};
if (!existsSync(join(target, 'poster.jpg')) && firstVideo?.endsWith('.mp4')) {
  make(join(target, 'poster.jpg'), ['-i', join(target, 'files', firstVideo), '-frames:v', '1', '-q:v', '3']);
}
if (!existsSync(join(target, 'preview.mp4')) && firstVideo?.endsWith('.mp4')) {
  make(join(target, 'preview.mp4'), ['-i', join(target, 'files', firstVideo), '-t', '4', '-an', '-vf', 'scale=480:-2']);
}

const index = JSON.parse(readFileSync(catalog, 'utf8'));
index.groups ??= { template: [] };
index.items ??= [];
const entry = {
  id: `templates/${slug}`,
  cat: 'template',
  group,
  name: { en: nameEn, 'zh-CN': nameZh },
  kind: 'group',
  durationMs,
  slots,
  about: String(args.about ?? `${nameZh}（${group}）`),
  tags,
};
const at = index.items.findIndex((row) => row.id === entry.id);
if (at >= 0) index.items[at] = entry; else index.items.push(entry);
if (!index.groups.template.some((row) => row.id === group)) throw new Error(`unknown template group: ${group}`);
writeFileSync(catalog, `${JSON.stringify(index, null, 1)}\n`, 'utf8');
console.log(`imported ${slug}: ${clipCount(clips)} clips, ${durationMs} ms, group ${group}`);
function clipCount(rows) { return rows.length; }
