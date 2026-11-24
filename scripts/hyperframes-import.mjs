#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Bring a HyperFrames registry snippet into OrangeFilm's library, as the first half of the work: the file is
 * fetched and made offline (no CDN, no web font), the loop of `data-*`/GSAP is reported line by line for the
 * `frame(t)` that must replace it, and the bundle's `saved.json` and the library entry are written. The registry's
 * keywords are said as the library's own tags (`TAG_BY_KEYWORD`, ids of library/tags.json only); a keyword no tag
 * covers is kept on the entry as `keywords`. The page
 * itself is left with a `window.film` stub that says what is still to do: rewriting a GSAP timeline into a pure
 * `frame(t)` is a decision per snippet (see docs/execution/hyperframes-import-log.md), not something a script
 * should guess.
 *
 *   node scripts/hyperframes-import.mjs --name lt-clean-bar --kind block [--cat text] [--group lower]
 *                                       [--commit <sha>] [--force]
 *   node scripts/hyperframes-import.mjs --list
 *
 * Source: github.com/heygen-com/hyperframes, Apache-2.0. Each page written here is a derivative work: its
 * provenance goes to THIRD_PARTY_NOTICES.md and to the log above.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'https://raw.githubusercontent.com/heygen-com/hyperframes';
const COMMIT = process.env.HYPERFRAMES_COMMIT || 'main';   // pin it: the log records which
const LIB = 'packages/orangefilm/library';

/**
 * An upstream registry keyword, said as one of the library's own tags: the `tags` of an entry are the vocabulary of
 * library/tags.json (SPEC: a thing is searched by the library's tags, not by the registry's free words). A keyword
 * no tag covers is not dropped: it is kept on the entry as `keywords`.
 */
const TAG_BY_KEYWORD = {
  lower: 'lowerthird', third: 'lowerthird', 'lower third': 'lowerthird', name: 'lowerthird', role: 'lowerthird',
  interview: 'lowerthird', podcast: 'lowerthird', card: 'frame',
  caption: 'subtitle', captions: 'subtitle', subtitles: 'subtitle', karaoke: 'subtitle', lyrics: 'subtitle',
  word: 'subtitle', words: 'subtitle', highlight: 'arrow', sweep: 'wipe', tiktok: 'social',
  cover: 'slide', reveal: 'wipe', tilt: 'spin', rotate: 'spin', iris: 'wipe', corner: 'shapes',
  stripes: 'shapes', mask: 'wipe', block: 'shapes', pill: 'shapes', slam: 'impact', punchy: 'intense',
  glow: 'neon', matrix: 'hud', subtle: 'soft', post: 'social', x: 'social', twitter: 'social',
  announcement: 'news', comment: 'social', youtube: 'social', notification: 'ui', product: 'tech',
  player: 'ui', chat: 'speech', thread: 'speech', messages: 'speech', instagram: 'social', follow: 'social',
  data: 'chart', bars: 'chart', ranking: 'chart', numbers: 'chart', graph: 'chart', number: 'countdown',
  count: 'countdown', stats: 'chart', ring: 'shapes', cursor: 'arrow', demo: 'tech', tutorial: 'explainer',
  editor: 'tech', annotation: 'arrow', gradient: 'light', mesh: 'shapes', aurora: 'dreamy', webgl: 'tech',
  talk: 'speech',
};

/** Where each block/component kind goes in the drawer when --cat is not given. */
const CAT_BY_TAG = {
  'lower-third': 'text', captions: 'text', 'caption-style': 'text', social: 'text', typography: 'text',
  'title-card': 'text', data: 'text', 'data-viz': 'text', cursor: 'text', 'video-primitive': 'text',
  transition: 'transition', 'transition-primitive': 'transition', effect: 'effect', background: 'effect',
};

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const get = async (path) => {
  const res = await fetch(`${REPO}/${COMMIT}/${path}`);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.text();
};

if (has('list') || args.length === 0) {
  console.log('usage: node scripts/hyperframes-import.mjs --name <name> --kind block|component [--cat text] [--group lower] [--commit <sha>] [--force]');
  console.log(`commit in use: ${COMMIT}`);
  process.exit(0);
}

const name = flag('name');
const kind = flag('kind', 'component');
if (!name) throw new Error('--name is required');
if (!['block', 'component'].includes(kind)) throw new Error('--kind is block or component');

const dir = kind === 'block' ? `registry/blocks/${name}` : `registry/components/${name}`;
const item = JSON.parse(await get(`${dir}/registry-item.json`));
const html = await get(`${dir}/${item.files?.[0]?.path ?? `${name}.html`}`);

const cat = flag('cat') || (item.tags ?? []).map((t) => CAT_BY_TAG[t]).find(Boolean) || 'text';
const group = flag('group', cat === 'text' ? 'lower' : 'other');
const id = `${cat}/hf-${name}`;
const out = join(LIB, cat, `hf-${name}`);

if (existsSync(out) && !has('force')) {
  console.log(`exists: ${out} (use --force to write over it)`);
  process.exit(0);
}

/** Lines that reach outside the project: the CDN, the web fonts, and the composition's own timing. */
const removed = [];
const offline = html
  .split('\n')
  .filter((line) => {
    const out = /<script[^>]+src="[^"]*(jsdelivr|unpkg|cdn\.)/.test(line)
      || /<link[^>]+href="[^"]*fonts\.(googleapis|gstatic)/.test(line)
      || /@import\s+url\(["']?https?:\/\/fonts\./.test(line)
      || /<title>/.test(line);
    if (out) removed.push(line.trim());
    return !out;
  })
  .join('\n')
  /* the host places the page; its own composition attributes mean nothing here */
  .replace(/\s+data-(composition-id|composition-src|start|duration|fps|timeline-locked|width|height|track-index)="[^"]*"/g, '')
  /* the source's timeline object: what must become this page's frame(t) */
  .replace(/window\.__timelines[^;]*;?/g, '');

const timelines = [...html.matchAll(/(?:tl|timeline)\.(to|from|fromTo|set)\(([^\n]*)/g)].map((m) => m[0].trim());
const props = (item.variables ?? []).map((v) => {
  const type = v.type === 'string' ? 'text' : v.type === 'image' ? 'image' : 'var';
  return type === 'text'
    ? { name: v.label ?? v.id, type: 'text', at: `[data-var-text="${v.id}"], .${v.id}` }
    : type === 'image'
      ? { name: v.label ?? v.id, type: 'image', kind: 'img', at: `[data-var-image="${v.id}"], .${v.id}` }
      : { name: v.label ?? v.id, type: 'var', var: `--${v.id}` };
});

const duration = Number((/data-duration="([\d.]+)"/.exec(html) ?? [])[1] ?? 4);
const width = Number((/data-width="(\d+)"/.exec(html) ?? [])[1] ?? 1920);
const height = Number((/data-height="(\d+)"/.exec(html) ?? [])[1] ?? 1080);

const shell = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${item.title ?? name}</title>
    <!--
      OrangeFilm page made from HyperFrames' ${kind} \`${name}\` (github.com/heygen-com/hyperframes, Apache-2.0,
      pinned ${COMMIT}). The CDN and the web font are gone; the source's GSAP timeline is not written yet: its
      lines are listed in docs/execution/hyperframes-import-log.md and must become frame(t) below (SPEC §3).
    -->
${offline.split('<body')[0]}
  </head>
  <body>
${(offline.split('<body')[1] ?? '').replace(/<\/body>[\s\S]*$/, '')}
    <script>
      const DURATION = ${duration};
      /* TODO: replace with a pure computation of the picture at t (no play(), no wall clock) */
      function draw(t) {
        /* every .clip stays as the source left it: the host shows the page whole */
      }
      window.film = {
        duration: DURATION,
        width: ${width},
        height: ${height},
        ready: document.fonts.ready,
        frame(t) { draw(Math.max(0, t)); },
      };
      draw(0);
    </script>
  </body>
</html>
`;

const saved = {
  version: 2,
  kind: 'clip',
  clip: {
    src: `hf-${name}.html`,
    time: [0, duration],
    ...(props.length ? { attrs: { 'data-props': JSON.stringify(props) } } : {}),
  },
  durationMs: Math.round(duration * 1000),
  w: width,
  h: height,
};

mkdirSync(join(out, 'files'), { recursive: true });
writeFileSync(join(out, 'files', `hf-${name}.html`), shell);
writeFileSync(join(out, 'saved.json'), `${JSON.stringify(saved, null, 2)}\n`);

const catalogFile = join(LIB, 'catalogs', 'hyperframes.json');
const catalog = existsSync(catalogFile)
  ? JSON.parse(readFileSync(catalogFile, 'utf8'))
  : { version: 1, about: 'Pages and pieces from HyperFrames\' registry, rewritten for OrangeFilm.', groups: {}, items: [] };
/* the registry's own keywords said as the library's tags (only ids library/tags.json has); the rest kept apart */
const vocabulary = new Set(JSON.parse(readFileSync(join(LIB, 'tags.json'), 'utf8')).tags.map((t) => t.id));
const said = (item.tags ?? []).map((t) => (vocabulary.has(t) ? t : TAG_BY_KEYWORD[t])).filter((t) => t && vocabulary.has(t));
const asTag = [...new Set(said)];
const asKeyword = (item.tags ?? []).filter((t) => !vocabulary.has(t) && !TAG_BY_KEYWORD[t]);
if (!asTag.length) throw new Error(`${name}: none of its keywords is one of the library's tags — say the closest in TAG_BY_KEYWORD first`);
const entry = {
  id, cat, group, name: { en: item.title ?? name, 'zh-CN': item.title ?? name, ja: item.title ?? name, ko: item.title ?? name, es: item.title ?? name },
  kind: 'page', durationMs: saved.durationMs, src: `hf-${name}.html`,
  about: item.description ?? '', tags: asTag, ...(asKeyword.length ? { keywords: asKeyword } : {}),
  w: width, h: height, fit: Number((height / 1080).toFixed(3)), low: group === 'lower',
};
const at = catalog.items.findIndex((i) => i.id === id);
if (at >= 0) catalog.items[at] = entry; else catalog.items.push(entry);
mkdirSync(join(LIB, 'catalogs'), { recursive: true });
writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 1)}\n`);

console.log(`wrote ${out}`);
console.log(`  catalog entry ${id} (${catalog.items.length} items in catalogs/hyperframes.json)`);
console.log(`  its tags ${asTag.join(', ')}${asKeyword.length ? `; kept as keywords: ${asKeyword.join(', ')}` : ''}`);
console.log(`  removed ${removed.length} lines that reached outside the project:`);
for (const line of removed) console.log(`    ${line.slice(0, 120)}`);
console.log(`  the source's timeline, ${timelines.length} calls to port into frame(t):`);
for (const line of timelines.slice(0, 24)) console.log(`    ${line.slice(0, 140)}`);
console.log(`\nnext: orangefilm look ${join(out, 'files', `hf-${name}.html`)} 1`);
console.log('      node scripts/library-previews.mjs (from packages/orangefilm) then node scripts/library-search-index.mjs');
