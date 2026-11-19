// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The three-step wizard as a source contract (the view is too large to mount here, and the browser
 * test in `studio/fission-workbench-render.test.mjs` already drives it end to end).
 *
 * What is held here: the steps exist and are reachable, the group table became cards without losing a
 * field, 高级 is folded by default, the preset / 自定义 boundary is real, the summary and the estimate
 * are fixed at the top, and the submitted job keeps the same field names it always had.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const workbench = read('./FissionWorkbench.tsx');
const wizard = read('./fission/wizard.ts');
const card = read('./fission/SceneGroupCard.tsx');
const summary = read('./fission/SummaryBar.tsx');
const steps = read('./fission/StepNav.tsx');
const presets = read('./fission/PresetPicker.tsx');

test('three steps, numbered, each one an addressable section', () => {
  for (const [index, id] of ['materials', 'rules', 'export'].entries()) {
    assert.match(workbench, new RegExp(`ref=\\{sectionRefs\\.${id}\\}[\\s\\S]{0,200}aria-labelledby="fission-step-${id}"`), `${id} is a labelled section`);
    assert.match(workbench, new RegExp(`id="fission-step-${id}"`), `${id} has a heading id`);
    assert.ok(workbench.includes(`L('${'①②③'[index]} `), `${id} is numbered ${'①②③'[index]}`);
  }
  assert.ok(workbench.indexOf('fission-step-materials') < workbench.indexOf('fission-step-rules'), 'materials come first');
  assert.ok(workbench.indexOf('fission-step-rules') < workbench.indexOf('fission-step-export'), 'export comes last');
});

test('a step can always be revisited, with the keyboard, and focus follows the move', () => {
  assert.match(steps, /<nav aria-label=\{L\('混剪步骤','Batch steps'\)\}/, 'a nav landmark names the rail');
  assert.match(steps, /aria-current=\{selected \? 'step' : undefined\}/, 'the current step is announced');
  assert.match(steps, /onClick=\{\(\) => onSelect\(step\.id\)\}/, 'every step is a button');
  assert.match(workbench, /const goStep=\(id:StepId\)=>\{setStep\(id\);const node=sectionRefs\[id\]\.current;node\?\.scrollIntoView/, 'moving a step scrolls to it');
  assert.match(workbench, /node\?\.focus\(\)/, 'and puts the keyboard there');
  assert.match(workbench, /tabIndex=\{-1\}/, 'the section can take focus');
});

test('the scene-group table is cards, and every card keeps the five face fields plus 高级', () => {
  assert.doesNotMatch(workbench, /<table|<thead|<tbody|<tr>/, 'no table is left in the workbench');
  assert.match(workbench, /groups\.map\(\(group,index\)=><SceneGroupCard/, 'one card per group');
  for (const field of ["L('启用 ','Use ')", "L('顺序','Order')", "L('每条抽取','Take per output')", "L('变速','Speed')", "L('允许复用 ','Allow reuse ')"]) {
    assert.ok(card.includes(field), `${field} stays on the card face`);
  }
  assert.ok(card.includes("L('高级','Advanced')"), 'the rest sits behind 高级');
  assert.match(card, /const \[advanced, setAdvanced\] = React\.useState\(false\)/, '高级 is folded by default');
  assert.match(card, /<div id=\{advancedId\} hidden=\{!advanced\}/, 'and its body really is hidden until opened');
  assert.ok(card.includes("L('用过即删（确认后入缓存，后续批次不再选取）'"), '用过即删 is presented, not dropped');
  assert.match(card, /aria-expanded=\{advanced\} aria-controls=\{advancedId\}/, 'the toggle is announced');
});

test('a card can be reordered by dragging or by its arrows', () => {
  assert.match(workbench, /onDragStart=\{setDragging\}/, 'drag starts on a card');
  assert.match(workbench, /onDrop=\{index=>\{if\(dragging!==null\)moveGroup\(dragging,index\);setDragging\(null\);\}\}/, 'the drop moves that card where it was dropped');
  assert.match(workbench, /const moveGroup=\(from:number,to:number\)=>setGroups\(current=>reorder\(current,from,to\)\)/, 'one reorder path for both inputs');
  assert.ok(card.includes("L('上移 ','Move up ')"), 'the arrow up is labelled per group');
  assert.ok(card.includes("L('下移 ','Move down ')"), 'the arrow down is labelled per group');
  assert.match(card, /aria-keyshortcuts="Alt\+ArrowUp"/, 'the keyboard shortcut is advertised');
});

test('presets write a known set; 自定义 is what opens the whole parameter surface', () => {
  for (const label of ["['口播混剪', 'Voice mix']", "['产品展示', 'Product showcase']", "['快节奏', 'Fast cut']", "['自定义', 'Custom']"]) {
    assert.ok(presets.includes(label), `${label} is offered`);
  }
  assert.match(workbench, /const choosePreset=\(id:PresetId\)=>\{setPreset\(id\);setOptionsState\(current=>applyPreset\(id,current\)\);setGroups\(current=>applyPresetToGroups\(id,current\)\);setAdvancedOpen\(id==='custom'\)/, 'a preset writes options and card defaults; 自定义 opens 进阶');
  assert.match(workbench, /setOptionsState\(previous=>\(\{\.\.\.previous,\[key\]:value\}\)\);setPreset\('custom'\)/, 'a hand edit leaves the preset');
  assert.match(workbench, /open=\{advancedOpen\}/, '进阶 follows that state');
  assert.match(wizard, /preset === 'custom' \? current : \{ \.\.\.presetOptions\[preset\] \}/, '自定义 writes nothing');
});

test('the summary and the estimate are fixed at the top and live', () => {
  assert.match(summary, /className="sticky top-0 z-10/, 'the summary stays in view');
  assert.match(summary, /L\('预计产出 ','Estimate '\)\}\{planned\.outputs\}/, 'estimated outputs are shown');
  assert.match(summary, /formatDuration\(planned\.seconds, L\)/, 'estimated time is shown');
  assert.match(workbench, /const planned=plan\(options\)/, 'both the summary and step ③ read one plan');
  assert.match(workbench, /<SummaryBar L=\{L\} options=\{options\} plan=\{planned\}/, 'the summary is the plan');
});

test('no parameter was deleted: every option field is still reachable from the wizard', () => {
  const body = wizard.slice(wizard.indexOf('export type Options = {'), wizard.indexOf('export const roles'));
  const keys = [...body.matchAll(/(\w+)\s*:\s*(?:number|string|boolean)/g)].map(match => match[1]);
  assert.ok(keys.length >= 27, `the option record still has its fields (${keys.length})`);
  for (const key of keys) {
    const wired = workbench.includes(key) || card.includes(key) || summary.includes(key);
    assert.ok(wired, `${key} is still set or read somewhere in the wizard`);
  }
  for (const field of ['OutWidth', 'OutHeight']) assert.ok(workbench.includes(field), `${field} is still written by the frame-size picker`);
});

test('the job sent to Fission is the same job, with the same field names', () => {
  assert.match(workbench, /const job=\{\.\.\.options,SceneGroups:groups\.length\?groups:null,/, 'the options spread and the scene-group record are unchanged');
  assert.match(workbench, /\.\.\.\(!selections\.audio\?\{GeneratedAudioCount:Math\.max\(options\.Count,1\),GeneratedAudioDurationSec:options\.TargetDurationSec\?\?12\}:\{\}\)/, 'the generated-audio fields are unchanged');
  assert.match(workbench, /const chosen=Object\.fromEntries\(roles\.map\(role=>\[role,selections\[role\]\?\.selectionId\?\?null\]\)\)/, 'selections stay ids, never paths');
  assert.match(workbench, /const candidate=\{requestId:crypto\.randomUUID\(\),selections:chosen,job\}/, 'the request shape is unchanged');
  for (const field of ['Name', 'Enabled', 'TakePerOutput', 'Rule', 'Speed', 'UseThenDelete', 'AllowReuse']) {
    assert.ok(card.includes(field) || workbench.includes(field), `the group record still carries ${field}`);
  }
  assert.match(card, /onPatch\(index, \{ (Enabled|Rule|TakePerOutput|Speed|AllowReuse|UseThenDelete):/, 'cards only patch the record\'s own fields');
});

test('the labels the browser test drives are still there, once each', () => {
  assert.equal((workbench.match(/L\('选择文件夹','Choose folder'\)/g) ?? []).length, 1, 'one Choose folder label, rendered per role');
  assert.match(workbench, /roles\.map\(role=>/, 'the five role rows still come from the role list');
  assert.match(workbench, /L\('生成数量','Count'\)/, 'the count field keeps its label');
  assert.ok(workbench.includes("L('转场时长（0–2 秒，0 为关闭）','Transition seconds, 0–2; 0 disables')"), 'the transition field keeps its label');
  assert.match(workbench, /L\('开始批量出片','Start batch'\)/, 'the start button keeps its label');
  assert.match(workbench, /L\('已有任务','Existing batches'\)/, 'the existing-batch picker keeps its label');
  assert.match(workbench, /否则使用测试音调|否则未选择时使用测试音调|otherwise a test tone is used with no voice/, 'the test-tone note is still written');
  assert.equal((workbench.match(/type="checkbox"/g) ?? []).length, 0, 'the card owns its checkboxes, not the workbench');
});

test('errors show up where the field is, and the service stays a single disabled fieldset', () => {
  assert.equal((workbench.match(/<fieldset/g) ?? []).length, 1, 'exactly one fieldset gates the wizard');
  assert.match(workbench, /const fieldIssues=\(id:StepId\)=>issueLines\(issuesFor\(found,id\)/, 'each step renders its own issues');
  assert.match(workbench, /const alertAt=\(id:StepId\)=>message&&messageStep===id\?<p role="alert"/, 'a batch failure lands in the step that caused it');
  assert.match(workbench, /ariaInvalid=\{invalidField\('transition-range'\)\}/, 'an invalid field is marked where it is typed');
  assert.match(workbench, /role="alert"/, 'and announced');
});

test('one screen per step: the other two are behind the one that is showing, not below it', () => {
  for (const id of ['materials', 'rules', 'export']) {
    assert.ok(workbench.includes(`data-step="${id}" data-step-state={stepState('${id}')}`), `${id} names itself and its state`);
  }
  assert.equal((workbench.match(/data-step-active=/g) ?? []).length, 3, 'every step says whether it is the one on screen');
  assert.ok(workbench.includes("const stepFace=(id:StepId)=>`${panel} ${step===id?'border-[var(--text)]':'pointer-events-none absolute inset-0 overflow-hidden opacity-0'}`"),
    'the step that is not showing is laid out behind the one that is, and takes no pointer');
  assert.ok(workbench.includes('<div className="relative">'), 'one column holds the three screens, so only the shown one sets the height');
});

test('the gate is the data\'s and a shut step says why instead of moving', () => {
  assert.match(workbench, /const gated=stepStates\(options,groups,\{hasVideo:Boolean\(selections\.video\),selectedMaterials:selectedRoles\.length\}\)/,
    'the rail reads the chosen materials, not the clicks');
  assert.match(workbench, /const stepState=\(id:StepId\)=>gated\.states\[id\]/, 'one state per step, from that record');
  assert.ok(workbench.includes("const stepBlocked=L('先选择至少 1 个素材','Choose at least one folder first')"),
    'the reason is written in both languages');
  assert.match(workbench, /const requestStep=\(id:StepId\)=>\{if\(stepState\(id\)==='locked'\)\{setStepHint\(stepBlocked\);return;\}setStepHint\(''\);goStep\(id\);\}/,
    'a shut step answers with the reason and the wizard stays where it is');
  assert.match(workbench, /<StepNav L=\{L\} current=\{step\} onSelect=\{requestStep\}/, 'the rail goes through that one door');
  assert.equal((workbench.match(/data-note="next-blocked"/g) ?? []).length, 2, 'both a disabled 下一步 says why, in one line');
  assert.match(workbench, /disabled=\{gated\.states\.rules==='locked'\}/, '下一步 to ② is disabled while ① is open');
  assert.match(workbench, /disabled=\{gated\.states\.export==='locked'\}/, '下一步 to ③ too');
  assert.match(workbench, /inert=\{stepShut\('materials'\)\|\|undefined\}/, 'a shut step is out of the keyboard order as well');
  assert.match(steps, /aria-disabled=\{locked \|\| undefined\}/, 'the rail announces a shut step without making it dead');
  assert.match(steps, /data-step=\{step\.id\} data-step-state=\{step\.state\}/, 'the rail carries the step contract');
  assert.ok(workbench.includes('data-action="step-back"') && workbench.includes('data-action="step-next"'), 'the footer is 上一步 / 下一步');
});

test('the summary stays at the top and is measured, so a step is never jumped to behind it', () => {
  assert.match(summary, /className="sticky top-0 z-10/, 'the summary is sticky at the top');
  assert.match(workbench, /const measure=\(\)=>setSummaryHeight\(Math\.round\(node\.getBoundingClientRect\(\)\.height\)\)/, 'its real height is read');
  assert.match(workbench, /style=\{\{scrollMarginTop:summaryHeight\+12\}\}/, 'and every step keeps that much room above it');
  assert.equal((workbench.match(/scrollMarginTop:summaryHeight\+12/g) ?? []).length, 3, 'all three steps, not only the first');
  assert.match(summary, /data-summary="full"[\s\S]{0,80}max-\[1200px\]:hidden/, 'the full reading folds away under 1200px');
  assert.match(summary, /data-summary="folded"[\s\S]{0,120}max-\[1200px\]:flex/, 'and the folded summary line takes its place');
});
