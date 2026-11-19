// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The document text and the `p_row` shape, pinned against `docs/sql/012_media_doc.sql`.
 *
 * The RPC's key list is *read out of the SQL file* (`p_row ->> 'x'` / `p_row -> 'x'`) instead of being copied here: a
 * second hand-kept list would drift the moment somebody adds a column, and the failure it produces is a silent `null`
 * in a 78 874-row backfill, not a red test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_ANALYZER_VER,
  MEDIA_DOC_TEXT_MAX,
  TRUNCATION_MARK,
  docLabels,
  formatDocDuration,
  mediaDocId,
  mediaDocRow,
  mediaDocText,
  stripSequence,
} from './material-doc.mjs';

const SQL_PATH = new URL('../../../docs/sql/012_media_doc.sql', import.meta.url);
const SQL = readFileSync(SQL_PATH, 'utf8');
/* 013 is being written on another path (`chore/vendor-0.3.2` has it as an untracked file); read it when it is there and
   pin against it, because it is what turns the asset shape into `shot_index = 0`. */
const readIfPresent = (relative) => {
  try {
    return readFileSync(new URL(relative, import.meta.url), 'utf8');
  } catch {
    return null;
  }
};
const SQL13 = readIfPresent('../../../docs/sql/013_media_doc_shot_key.sql');
const CONTRACT = JSON.parse(readFileSync(new URL('../../../docs/contracts/media-doc.schema.json', import.meta.url), 'utf8'));

/** Every key `upsert_media_doc` reads off `p_row`, taken from the function body itself. */
function pRowKeys(sql = SQL) {
  const keys = new Set();
  for (const match of sql.matchAll(/p_row\s*->>?\s*'([a-z_]+)'/g)) keys.add(match[1]);
  return keys;
}

/** The `upsert_media_doc` body only — `media_search` reads no `p_row`. */
const UPSERT_BODY = SQL.slice(
  SQL.indexOf('CREATE OR REPLACE FUNCTION public.upsert_media_doc'),
  SQL.indexOf('COMMENT ON FUNCTION public.upsert_media_doc'),
);

const TEA = '20261106-柠檬宝藏茶200g罐-外包装 (46)';
const OIL = '20261109-油弃乌龙茶-茶干 (12)';
const FREE = '素材-王鑫-3.18但哥茶膏_2';

test('the same entry always gives the same text (no clock, locale or map order)', () => {
  const entry = { videoId: 'v1', name: TEA, md5: 'ab' };
  assert.equal(mediaDocText(entry), mediaDocText(entry));
  assert.equal(mediaDocText({ ...entry }), mediaDocText(entry));
  /* The row too: an equal entry must produce a byte-identical payload — a changed text invalidates a stored vector. */
  assert.equal(JSON.stringify(mediaDocRow(entry)), JSON.stringify(mediaDocRow({ ...entry })));
});

test('the template is one-level, two-level, product, group, tags, duration, author, name-without-sequence', () => {
  const text = mediaDocText({
    videoId: 'v1', name: TEA, oneLevel: '花草养生茶', twoLevel: '柠檬宝藏茶',
    labels: ['样品', '茶'], durationMs: 23400, author: '王鑫',
  });
  /* `样品` and `茶` are sorted (code-point order) so a different label order on the next read is not a new text. */
  assert.equal(text, '花草养生茶 柠檬宝藏茶 柠檬宝藏茶200g罐 外包装 样品 茶 23.4s 王鑫 20261106-柠檬宝藏茶200g罐-外包装');
  assert.ok(!text.includes('(46)'), 'the album position is not part of the searchable text');
  /* The batch date left its own slot when the categories took it: it is still the `p_row.batch` column, and the
     name-without-sequence still opens with it, so nothing searchable was lost. */
  assert.equal(text.split(' ')[0], '花草养生茶', 'the classification leads, the date does not');
  assert.ok(text.includes('20261106-柠檬宝藏茶200g罐-外包装'), 'the date is still in the name');
});

test('the classification levels are what a shared group token lacked, and the supplier\'s field names work too', () => {
  /* The measured miss: 「柠檬宝藏茶 外包装」 answered 「墨红玫瑰-外包装」 because `外包装` was all the text had. */
  const tea = mediaDocText({
    videoId: 'v1', name: TEA, oneLevel: '花草养生茶', twoLevel: '柠檬宝藏茶', labels: [], author: '周佳',
  });
  const rose = mediaDocText({
    videoId: 'v2', name: '20261109-墨红玫瑰-外包装 (12)', oneLevel: '花草养生茶', twoLevel: '墨红玫瑰', author: '周佳',
  });
  assert.match(tea, /柠檬宝藏茶/);
  assert.notEqual(tea, rose, 'two cards that share a group token are two different documents');

  /* A raw supplier entry (no normalization step in between) is rendered with its categories, not without them. */
  const raw = mediaDocText({
    videoId: 'v3',
    name: TEA,
    oneLevelVideoType: { id: { sourceType: 'number', source: '98418' }, name: '花草养生茶' },
    twoLevelVideoType: { name: '柠檬宝藏茶' },
  });
  assert.ok(raw.startsWith('花草养生茶 柠檬宝藏茶 '), raw);
});

test('empty slots are skipped, one space apart, never a leading or trailing space', () => {
  const bare = mediaDocText({ videoId: 'v1', name: TEA });
  assert.equal(bare, '柠檬宝藏茶200g罐 外包装 20261106-柠檬宝藏茶200g罐-外包装');
  assert.equal(bare, bare.trim());
  assert.ok(!/\s{2}/.test(bare));
  /* A duplicate is one tag, not two: `docLabels` dedupes before the join. */
  assert.deepEqual(docLabels(['茶', '茶', '  ']), ['茶']);
  assert.equal(mediaDocText({ videoId: 'v1', name: TEA, labels: ['茶', '茶'] }), mediaDocText({ videoId: 'v1', name: TEA, labels: ['茶'] }));
});

test('the sequence off the end is dropped, and only that tail', () => {
  assert.equal(stripSequence(TEA), '20261106-柠檬宝藏茶200g罐-外包装');
  assert.equal(stripSequence('无序号的名字'), '无序号的名字');
  assert.equal(stripSequence(FREE), FREE, '`_2` is the derived layer\'s tail, not the supplier sequence');
  assert.equal(stripSequence(''), '');
});

test('batch / product / group come from parseMaterialName, and an unparsed name claims none of them', () => {
  const tea = mediaDocRow({ videoId: 'v1', name: TEA });
  assert.deepEqual([tea.batch, tea.product, tea.gname], ['20261106', '柠檬宝藏茶200g罐', '外包装']);

  const oil = mediaDocRow({ videoId: 'v2', name: OIL });
  assert.deepEqual([oil.batch, oil.product, oil.gname], ['20261109', '油弃乌龙茶', '茶干']);

  const free = mediaDocRow({ videoId: 'v3', name: FREE });
  assert.deepEqual([free.batch, free.product, free.gname], [null, null, null]);
  /* Still searchable: the text degrades to the name minus its sequence, not to nothing. */
  assert.equal(free.text, FREE);
});

test('a name that is empty still yields non-empty text (the table would reject an empty line)', () => {
  const row = mediaDocRow({ videoId: 'v9', name: '', author: '王鑫', durationMs: 1000 });
  assert.equal(row.text, '1s 王鑫');
  const onlyId = mediaDocRow({ videoId: 'v9', name: '' });
  assert.equal(onlyId.text, 'asset:v9');
  assert.ok(onlyId.text.length > 0);
});

test('the row carries the same text the text function gives (§ the entry and the options agree)', () => {
  const entry = { videoId: 'v1', name: TEA, labels: ['样品'], durationMs: 23400, author: '王鑫' };
  assert.equal(mediaDocRow(entry).text, mediaDocText(entry));
  /* Options win when given; when they are not, the entry's own fields are read — never a second, different document. */
  assert.equal(mediaDocRow(entry, { author: '李雪妮' }).author, '李雪妮');
  assert.equal(mediaDocRow(entry).author, '王鑫');
  assert.equal(mediaDocRow({ videoId: 'v1', name: TEA }).text, mediaDocText({ videoId: 'v1', name: TEA }));
});

test('text is cut at 2000 characters and says so inside the ceiling', () => {
  const long = `${'长'.repeat(1900)}_${'尾'.repeat(400)} (7)`;
  const text = mediaDocText({ videoId: 'v1', name: long });
  assert.equal(Array.from(text).length, MEDIA_DOC_TEXT_MAX);
  assert.ok(text.endsWith(TRUNCATION_MARK));
  /* Short text is untouched by the same path. */
  assert.equal(mediaDocText({ videoId: 'v1', name: TEA }).includes(TRUNCATION_MARK), false);
});

test('durations format deterministically and drop what the column cannot hold', () => {
  assert.equal(formatDocDuration(12000), '12s');
  assert.equal(formatDocDuration(12340), '12.3s');
  assert.equal(formatDocDuration(60000), '1m0s');
  assert.equal(formatDocDuration(83400), '1m23s');
  assert.equal(formatDocDuration(null), '');
  assert.equal(formatDocDuration(-1), '');
  assert.equal(formatDocDuration(Number.NaN), '');
  assert.equal(mediaDocRow({ videoId: 'v1', name: TEA, }, { durationMs: 12340 }).duration_ms, 12340);
});

test('mediaDocId is stable and says which identity it used', () => {
  assert.equal(mediaDocId({ videoId: 'v1', name: TEA }), 'asset:v1');
  assert.equal(mediaDocId({ videoId: 'v1', name: TEA }), mediaDocId({ videoId: 'v1', name: '别的名字' }), 'identity is the id, not the name');
  assert.equal(mediaDocId({ name: TEA, md5: 'abc123' }), 'asset:md5:abc123');
  assert.equal(mediaDocId({ name: TEA }), `asset:name:${stripSequence(TEA)}`);
  assert.equal(mediaDocId({ name: '' }), '');
});

test('the row keys are exactly the keys 012 reads off p_row, minus the vector', () => {
  const sqlKeys = pRowKeys(UPSERT_BODY);
  /* Guard the extractor itself: if this ever comes back empty, every assertion below would pass vacuously. */
  assert.ok(sqlKeys.size >= 14, `expected the RPC body to read ~16 p_row keys, found ${sqlKeys.size}`);
  for (const required of ['media_key', 'gran', 'text', 'analyzer_ver']) {
    assert.ok(sqlKeys.has(required), `012 does not read ${required}? extractor is wrong`);
  }

  const row = mediaDocRow({ videoId: 'v1', name: TEA });
  for (const key of Object.keys(row)) {
    assert.ok(sqlKeys.has(key), `row key ${key} is not read by upsert_media_doc — it would be dropped silently`);
  }

  /* Nothing the row needs may be missing. `embedding` / `embedding_ver` are the caller's (they belong to the embedding
     model); `video_id` is ours, because the row is what a re-analysis replays. */
  const ownKeys = [...sqlKeys].filter((key) => key !== 'embedding' && key !== 'embedding_ver');
  assert.deepEqual(Object.keys(row).sort(), ownKeys.sort());

  assert.equal(row.embedding, undefined);
  assert.equal(row.embedding_ver, undefined);
  assert.ok(sqlKeys.has('embedding') && sqlKeys.has('embedding_ver'), '012 reads the vector keys — the caller adds them');
});

test('the row satisfies the constraints the media_doc DDL puts on an asset document', () => {
  const row = mediaDocRow({ videoId: 'v1', name: TEA });

  assert.equal(row.gran, 'asset');
  assert.equal(row.shot_index, 0);
  /* 013: asset ⇒ shot_index = 0 (NOT NULL, and part of the PK — a NULL key column would be mutually distinct). */
  if (SQL13) {
    assert.match(SQL13, /gran = 'asset' AND shot_index = 0/);
    assert.match(SQL13, /ALTER COLUMN shot_index SET DEFAULT 0/);
    assert.match(SQL13, /ALTER COLUMN shot_index SET NOT NULL/);
  }
  /* 012 alone: the value is inert, not wrong — the RPC's `v_shot` has no default and is only assigned in the shot
     branch, so an asset row still lands as NULL. That is why one value serves both DDLs. */
  assert.match(UPSERT_BODY, /v_shot\s+integer;/);
  assert.match(SQL, /gran = 'asset' AND shot_index IS NULL/);

  /* media_doc_media_key_nonempty / media_doc_text_nonempty (012:81-83). */
  assert.ok(row.media_key.length > 0);
  assert.ok(row.text.trim().length > 0);
  assert.equal(row.video_id, row.media_key);
  assert.equal(row.analyzer_ver, DEFAULT_ANALYZER_VER);

  /* source_kind CHECK (012:73). */
  assert.equal(row.source_kind, 'cloud');
  assert.equal(mediaDocRow({ videoId: 'v1', name: TEA }, { sourceKind: 'project' }).source_kind, 'project');
  assert.throws(() => mediaDocRow({ videoId: 'v1', name: TEA }, { sourceKind: 'local' }), /source_kind/);

  /* labels is `text[] NOT NULL DEFAULT '{}'` (012:70) — always an array, never null. */
  assert.deepEqual(row.labels, []);
  assert.ok(Array.isArray(mediaDocRow({ videoId: 'v1', name: TEA }, { labels: ['b', 'a', 'b'] }).labels));

  /* An entry with no identity cannot become a row (media_key may not be empty). */
  assert.throws(() => mediaDocRow({ name: TEA }), /media_key/);
});

test('the row is a legal orange/media-doc/2 `row` (the contract file, not a copy of it)', () => {
  const schema = CONTRACT?.$defs?.row;
  assert.ok(schema, 'docs/contracts/media-doc.schema.json has no $defs.row');
  const row = mediaDocRow({ videoId: 'v1', name: TEA, labels: ['样品'], durationMs: 1000, author: '王鑫' });

  assert.equal(schema.additionalProperties, false, 'an extra key would be rejected by the contract');
  for (const key of Object.keys(row)) {
    assert.ok(Object.hasOwn(schema.properties, key), `row key ${key} is not in orange/media-doc/2`);
  }
  for (const key of schema.required) {
    assert.ok(Object.hasOwn(row, key), `orange/media-doc/2 requires ${key}`);
  }

  /* Types the contract pins: shot_index is an integer now (v2), labels an array of strings, duration_ms nullable int. */
  assert.equal(Number.isInteger(row.shot_index), true);
  assert.equal(schema.properties.shot_index.type, 'integer');
  assert.ok(row.labels.every((label) => typeof label === 'string'));
  assert.equal(Number.isInteger(row.duration_ms), true);
  assert.equal(row.source_kind, 'cloud');
  /* No vector: `embedding`/`embedding_ver` belong to the embedding model, and the contract needs the version beside it. */
  assert.equal(Object.hasOwn(row, 'embedding'), false);
  assert.equal(Object.hasOwn(row, 'embedding_ver'), false);
});
