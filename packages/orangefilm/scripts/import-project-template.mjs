// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 把一个 Studio 工程（film.html + assets/）收进内置模板库：
 * 读 film.html 的 tracks/clips，复制被引用的素材，写 saved.json，并追加 catalog 条目。
 *
 *   node packages/orangefilm/scripts/import-project-template.mjs --project "E:\剪辑\orangefilm\柑普茶" \
 *     --slug ganpu-talking --group talking --name "柑普茶" --name-en "Ganpu tea"
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readFilmFile } from '../src/film-doc.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith('--')) continue;
  args[key.slice(2)] = process.argv[i + 1];
  i += 1;
}
const project = resolve(String(args.project ?? ''));
const slug = String(args.slug ?? '').trim();
const group = String(args.group ?? 'talking').trim();
const nameZh = String(args.name ?? '').trim();
const nameEn = String(args['name-en'] ?? nameZh).trim();
const tags = String(args.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
if (!project || !slug || !nameZh) throw new Error('--project --slug --name are required');

const filmPath = join(project, 'film.html');
if (!existsSync(filmPath)) throw new Error(`no film.html in ${project}`);
const read = readFilmFile(readFileSync(filmPath, 'utf8'));
if (!read.doc) throw new Error(`film.html problems: ${read.problems.join('; ')}`);

const root = resolve('packages/orangefilm/library');
const target = join(root, 'templates', slug);
const files = join(target, 'files');
mkdirSync(files, { recursive: true });

let end = 0;
const clips = [];
const copied = new Set();
for (const [track, row] of read.doc.tracks.entries()) {
  for (const clip of row.clips ?? []) {
    const src = String(clip.src ?? '');
    if (!src) continue;
    const from = join(project, src);
    const rel = src.startsWith('assets/') ? src : `assets/${basename(src)}`;
    const to = join(files, rel);
    if (!copied.has(rel)) {
      if (!existsSync(from)) throw new Error(`missing asset: ${from}`);
      mkdirSync(join(to, '..'), { recursive: true });
      copyFileSync(from, to);
      copied.add(rel);
    }
    const tail = Number(clip.time?.[1] ?? 0);
    end = Math.max(end, Number(clip.at ?? 0) + tail);
    clips.push({ track, at: Number(clip.at ?? 0), clip: { ...clip, src: rel } });
  }
}
const saved = { version: 2, kind: 'group', clips, durationMs: Math.round(end * 1000) };
writeFileSync(join(target, 'saved.json'), `${JSON.stringify(saved, null, 1)}\n`, 'utf8');

const catalog = join(root, 'catalogs', 'templates.json');
const index = JSON.parse(readFileSync(catalog, 'utf8'));
index.groups ??= { template: [] };
index.items ??= [];
if (!index.groups.template.some((row) => row.id === group)) throw new Error(`unknown group ${group}`);
const entry = {
  id: `templates/${slug}`, cat: 'template', group,
  name: { en: nameEn, 'zh-CN': nameZh }, kind: 'group',
  durationMs: Math.round(end * 1000), slots: 0,
  about: String(args.about ?? `${nameZh}（口播模板，自带素材）`), tags,
};
const at = index.items.findIndex((row) => row.id === entry.id);
if (at >= 0) index.items[at] = entry; else index.items.push(entry);
writeFileSync(catalog, `${JSON.stringify(index, null, 1)}\n`, 'utf8');
const bytes = [...copied].reduce((n, rel) => n + statSync(join(files, rel)).size, 0);
console.log(`imported ${slug}: ${clips.length} clips, ${Math.round(end * 1000)} ms, ${copied.size} files, ${(bytes / 1e6).toFixed(1)} MB`);
