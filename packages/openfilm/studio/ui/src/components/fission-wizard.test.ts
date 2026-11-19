// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The wizard's model, held as behaviour rather than markup: presets write known option sets,
 * 自定义 writes nothing, the output plan follows the engine's own capacity rule, and every field
 * check is reported in the step that owns the field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPreset, applyPresetToGroups, detectPreset, initialOptions, issueStep, issueText, issues, issuesFor,
  plan, presetIds, presetOptions, reorder, stepIds, stepStates,
} from './fission/wizard.ts';
import type { Group, Options } from './fission/wizard.ts';

const group = (patch: Partial<Group> = {}): Group => ({ Name: '01', Enabled: true, TakePerOutput: 0, Rule: 'Random', Speed: 1, UseThenDelete: false, AllowReuse: false, ...patch });

test('the three steps are the three steps, in order', () => {
  assert.deepEqual([...stepIds], ['materials', 'rules', 'export']);
});

test('every preset writes a complete, valid option set; 自定义 writes nothing', () => {
  for (const id of presetIds) {
    if (id === 'custom') continue;
    const written = applyPreset(id, initialOptions);
    const keys = Object.keys(initialOptions) as (keyof Options)[];
    assert.deepEqual(Object.keys(written).sort(), keys.slice().sort(), `${id} covers every option field`);
    assert.deepEqual(issues(written, [group()], { hasVideo: true }), [], `${id} is valid as written`);
    assert.equal(detectPreset(written), id, `${id} is recognisable from its own values`);
  }
  const handEdited: Options = { ...initialOptions, TransitionSec: 1 };
  const kept = applyPreset('custom', handEdited);
  assert.deepEqual(kept, handEdited, '自定义 keeps what the person set');
  assert.equal(detectPreset(handEdited), 'custom', 'a hand edit is 自定义');
});

test('a preset also sets the scene-group defaults, and never flips 用过即删', () => {
  const groups = [group(), group({ Name: '02', Enabled: false })];
  const fast = applyPresetToGroups('fast-cut', groups);
  assert.equal(fast[0].Speed, 1.15); assert.equal(fast[0].TakePerOutput, 2); assert.equal(fast[0].AllowReuse, true);
  assert.equal(fast[1].Enabled, false, '启用 is the person\'s, not the preset\'s');
  assert.deepEqual(fast.map(item => item.UseThenDelete), [false, false]);
  assert.deepEqual(applyPresetToGroups('custom', groups), groups, '自定义 leaves the cards alone');
  assert.deepEqual(groups.map(item => item.Speed), [1, 1], 'the incoming cards are not mutated');
});

test('the plan follows the engine: capacity is voices × uses, capped by Count', () => {
  const rich = plan({ ...initialOptions, Count: 3, AudioUses: 1 }, 10);
  assert.equal(rich.outputs, 3); assert.equal(rich.capacity, 10); assert.equal(rich.perOutputSec, 12);
  assert.equal(plan({ ...initialOptions, Count: 5, AudioUses: 1 }, 2).outputs, 2, 'voices run out before Count');
  assert.equal(plan({ ...initialOptions, Count: 0, AudioUses: 2 }, 4).outputs, 8, 'Count 0 means the whole pool');
  assert.equal(plan({ ...initialOptions, Count: 5, AudioUses: 0 }, 1).outputs, 5, 'AudioUses 0 is unlimited');
  assert.equal(plan(initialOptions).outputs, 3, 'no voice folder: one generated voice per output');
});

test('the estimate is monotone in the settings it claims to depend on', () => {
  const base = plan({ ...initialOptions, Count: 10, Threads: 2, TargetDurationSec: 10 }, 10);
  assert.ok(base.seconds > 0);
  assert.equal(plan({ ...initialOptions, Count: 10, Threads: 4, TargetDurationSec: 10 }, 10).seconds, Math.ceil(base.seconds / 2), 'twice the concurrency, half the wall time');
  assert.ok(plan({ ...initialOptions, Count: 10, Threads: 2, TargetDurationSec: 20 }, 10).seconds > base.seconds, 'a longer target costs more time');
  assert.equal(plan({ ...initialOptions, Count: 10, Threads: 2, TargetDurationSec: null }, 10).perOutputSec, 12, 'no target follows the voice; the estimate states its own assumption');
});

test('each field check is reported once, in the step that owns it', () => {
  const found = issues({ ...initialOptions, TransitionSec: 2.05, Count: -1 }, [group({ Speed: 0.4 })], { hasVideo: true });
  const codes = found.map(issue => issue.code);
  assert.ok(codes.includes('transition-range'));
  assert.ok(codes.includes('count-range'));
  assert.ok(codes.includes('group-speed-range'));
  assert.deepEqual(issueStep['transition-range'], 'rules');
  assert.deepEqual(issueStep['count-range'], 'export');
  assert.deepEqual(issueStep['group-speed-range'], 'materials');
  assert.equal(found.find(issue => issue.code === 'group-speed-range')?.group, '01', 'a group problem names its card');
  assert.deepEqual(issuesFor(found, 'rules').map(issue => issue.code), ['transition-range']);
  assert.deepEqual(issuesFor(found, 'export').map(issue => issue.code), ['count-range']);
});

test('a clean configuration reports nothing; the two blocking states are named', () => {
  assert.deepEqual(issues(initialOptions, [group()], { hasVideo: true }), []);
  assert.deepEqual(issues(initialOptions, [group()], { hasVideo: false }).map(issue => issue.code), ['video-missing']);
  assert.deepEqual(issues(initialOptions, [group({ Enabled: false })], { hasVideo: true }).map(issue => issue.code), ['groups-none-enabled']);
  assert.deepEqual(issues(initialOptions, [], { hasVideo: true }), [], 'no scene groups at all is not an error');
});

test('every issue code carries both languages and a step', () => {
  for (const [code, text] of Object.entries(issueText)) {
    assert.equal(text.length, 2, `${code} has zh and en`);
    assert.ok(text[0].length > 0 && text[1].length > 0);
    assert.ok(stepIds.includes(issueStep[code as keyof typeof issueStep]), `${code} belongs to a step`);
  }
});

test('reordering a scene group moves one card and leaves the rest in place', () => {
  const groups = [group({ Name: '01' }), group({ Name: '02' }), group({ Name: '03' })];
  assert.deepEqual(reorder(groups, 0, 2).map(item => item.Name), ['02', '03', '01']);
  assert.deepEqual(reorder(groups, 2, 0).map(item => item.Name), ['03', '01', '02']);
  assert.deepEqual(groups.map(item => item.Name), ['01', '02', '03'], 'the incoming order is untouched');
  assert.equal(reorder(groups, 1, 1), groups, 'a move onto itself is a no-op');
  assert.equal(reorder(groups, -1, 2), groups, 'out of range is a no-op');
  assert.equal(reorder(groups, 0, 3), groups);
});

test('preset option sets are not shared objects: applying one cannot mutate the table', () => {
  const written = applyPreset('product-show', initialOptions);
  written.Count = 99;
  assert.equal(presetOptions['product-show'].Count, 4);
});

test('with no material chosen ① is not done, and ② ③ cannot be opened', () => {
  const empty = stepStates(initialOptions, [], { hasVideo: false, selectedMaterials: 0 });
  assert.equal(empty.states.materials, 'todo', '① waits for a material');
  assert.equal(empty.states.rules, 'locked', '② is shut while ① is open');
  assert.equal(empty.states.export, 'locked', '③ is shut while ① is open');
  assert.equal(empty.materialsDone, false);

  /* the bug this replaces: ②/③ said 已完成 the moment nothing complained about them, with no material chosen at all */
  const chosen = stepStates(initialOptions, [group()], { hasVideo: true, selectedMaterials: 1 });
  assert.deepEqual(chosen.states, { materials: 'ok', rules: 'ok', export: 'ok' }, 'one chosen folder opens the rest');
  assert.equal(chosen.materialsDone, true);
});

test('the gate is the data\'s: a chosen but broken ①, a voice without a video, and a broken later step', () => {
  const brokenFirst = stepStates(initialOptions, [group({ Enabled: false })], { hasVideo: true, selectedMaterials: 1 });
  assert.equal(brokenFirst.states.materials, 'todo', 'every scene group off is still ① to finish');
  assert.equal(brokenFirst.states.rules, 'locked', 'and it keeps ② shut');

  assert.equal(stepStates(initialOptions, [], { hasVideo: false, selectedMaterials: 2 }).materialsDone, false,
    'a voice folder alone does not open the wizard: the batch is built from the video');

  const lateProblem = stepStates({ ...initialOptions, Count: -1 }, [group()], { hasVideo: true, selectedMaterials: 1 });
  assert.deepEqual(lateProblem.states, { materials: 'ok', rules: 'ok', export: 'todo' },
    'a field problem in ③ marks ③, it never locks the steps around it');
});
