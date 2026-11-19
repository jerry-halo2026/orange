// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The tables Studio shows: English, 简体中文, Español and 日本語 hold the same keys, and 한국어 holds no key of its own
 * (it falls back to English for what it does not have). A phrase added to one table and left out of the others shows up
 * in English to whoever reads that language, which is how a translation goes missing without anyone noticing; this says
 * so before it ships. A key missing from one of the four, or present in one alone, turns it red.
 *
 * LEGACY_UNTRANSLATED is the debt that was already there when this check was written: phrases that never made it into
 * Español and 日本語. Nothing new may join it, and a key that is translated later must come off it (the last test says
 * so), so the list can only shrink.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from './en.ts';
import { es } from './es.ts';
import { ja } from './ja.ts';
import { ko } from './ko.ts';
import { zhCN } from './zh-CN.ts';

/** Every phrase's path in a table, as `t()` reads it (`settings.appearance.theme`). */
function keysOf(table: unknown, at = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    const path = at ? `${at}.${key}` : key;
    if (value && typeof value === 'object') out.push(...keysOf(value, path));
    else out.push(path);
  }
  return out;
}

/** In English, never translated into Español or 日本語. */
const LEGACY_UNTRANSLATED = `
catalog.auth
catalog.binding
catalog.bindingChanged
catalog.config
catalog.denied
catalog.empty
catalog.loading
catalog.local
catalog.next
catalog.noGrant
catalog.page
catalog.previous
catalog.readOnly
catalog.refresh
catalog.search
catalog.title
catalog.unknown
fissionBatch.AudioDir
fissionBatch.BgmDir
fissionBatch.Count
fissionBatch.IntroDir
fissionBatch.OutroDir
fissionBatch.Threads
fissionBatch.VideoDir
fissionBatch.cancel
fissionBatch.candidate
fissionBatch.close
fissionBatch.group
fissionBatch.import
fissionBatch.importFailed
fissionBatch.new
fissionBatch.phase
fissionBatch.ready
fissionBatch.retirementPending
fissionBatch.retry
fissionBatch.start
fissionBatch.submitting
fissionBatch.title
fissionBatch.unavailable
fissionBatch.unconfirmed
homeCards.all
homeCards.catalog
homeCards.catalogBody
homeCards.choose
homeCards.empty
homeCards.features
homeCards.fission
homeCards.fissionBody
homeCards.home
homeCards.loading
homeCards.myProjects
homeCards.recent
homeCards.resume
homeCards.settings
homeCards.studio
homeCards.studioBody
homeCards.studioGuide
homeCards.title
homeEntry.catalog
homeEntry.chooseProject
homeEntry.fission
homeEntry.nextCatalog
homeEntry.nextFission
homeEntry.projects
material.register
material.registered
material.registering
material.stale
material.unavailable
material.unknown
material.unregistered
materialCenter.closePanel
materialCenter.cloudSteward
settings.servicesLimited
settings.servicesLoading
settings.servicesRetry
settings.servicesUnavailable
workspace.author
workspace.backToPanel
workspace.batchPending
workspace.batchTasks
workspace.category
workspace.chooseProject
workspace.cloud
workspace.cloudUnavailable
workspace.draftConflict
workspace.draftRetry
workspace.draftUnavailable
workspace.durationUnconfirmed
workspace.filterUnconfirmed
workspace.filters
workspace.fissionPurpose
workspace.importLocal
workspace.insertInStudio
workspace.invalidGroup
workspace.local
workspace.localEmpty
workspace.localFilter
workspace.localProject
workspace.localUnavailable
workspace.mainCategory
workspace.materialPurpose
workspace.materialRole
workspace.metadataOnly
workspace.modelPending
workspace.openFission
workspace.openMaterials
workspace.outputPending
workspace.outputSettings
workspace.previewUnavailable
workspace.previewVideo
workspace.removeSelection
workspace.resultHint
workspace.results
workspace.role_bgm
workspace.role_intro
workspace.role_outro
workspace.role_video
workspace.role_voice
workspace.sceneGroup
workspace.selectForBatch
workspace.selectedForBatch
workspace.sourceHint
workspace.sourceSelection
workspace.startBatch
workspace.subCategory
workspace.tags
workspace.thumbnailUnavailable
workspace.unverifiedSelection
workspace.voiceScript
`.trim().split('\n').sort();

/** What 한국어 leaves to English today: the debt above, and whatever was added since without Korean words. */
const KOREAN_UNTRANSLATED = [...LEGACY_UNTRANSLATED, 'gallery.skillsIndex'].sort();

/** The keys `all` has that `words` does not, in order. */
const missingFrom = (words: readonly string[], all: readonly string[]) => {
  const has = new Set(words);
  return all.filter((key) => !has.has(key)).sort();
};
/** The keys `words` has beyond `all`, in order. */
const extraIn = (words: readonly string[], all: readonly string[]) => {
  const has = new Set(all);
  return words.filter((key) => !has.has(key)).sort();
};

test('English and 简体中文 hold the same keys', () => {
  const english = keysOf(en);
  const chinese = keysOf(zhCN);
  assert.deepEqual(extraIn(chinese, english), [], '简体中文 has keys English does not');
  assert.deepEqual(missingFrom(chinese, english), [], '简体中文 is missing keys English has');
  assert.equal(english.length, new Set(english).size, 'a phrase path is written twice in English');
});

test('Español and 日本語 hold every English key, but the ones still owed a translation', () => {
  const english = keysOf(en);
  for (const [language, table] of [['Español', es], ['日本語', ja]] as const) {
    const keys = keysOf(table);
    assert.deepEqual(extraIn(keys, english), [], `${language} has keys English does not`);
    assert.deepEqual(missingFrom(keys, english), LEGACY_UNTRANSLATED, `${language} is missing keys beyond the known debt`);
  }
});

test('한국어 adds no key of its own; it reads English for the rest', () => {
  const english = keysOf(en);
  const korean = keysOf(ko);
  assert.deepEqual(extraIn(korean, english), [], '한국어 has keys English does not');
  assert.deepEqual(missingFrom(korean, english), KOREAN_UNTRANSLATED, '한국어 is missing more than it falls back on');
});

test('a phrase translated is taken off the debt', () => {
  const english = new Set(keysOf(en));
  for (const key of LEGACY_UNTRANSLATED) {
    assert.ok(english.has(key), `LEGACY_UNTRANSLATED names ${key}, which English no longer has`);
  }
  const debt = new Set(LEGACY_UNTRANSLATED);
  for (const [language, table] of [['Español', es], ['日本語', ja]] as const) {
    const translated = keysOf(table).filter((key) => debt.has(key));
    assert.deepEqual(translated, [], `${language} now has these: take them off LEGACY_UNTRANSLATED`);
  }
});
