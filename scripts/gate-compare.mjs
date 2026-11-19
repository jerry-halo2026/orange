#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// G09: two `verify --json` files (local and cloud) must agree, check by check.
//
// The point of unifying the data surface is that both environments prove the same statements. A run
// that is green only because it quietly fell back to the local container is exactly the failure this
// gate exists to catch: it refuses files whose target does not match what they claim, and it compares
// ids and verdicts, never free-form text.
//
// Usage: node scripts/gate-compare.mjs local.json cloud.json [--json]
// Exit:  0 same ids, same verdicts; 1 any difference; 2 unreadable or wrong schema.
import { readFileSync } from 'node:fs';

const SCHEMA = 'verify/1';

const read = (path) => {
  try {
    const json = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    if (json?.schema !== SCHEMA || !Array.isArray(json.checks)) throw new Error(`${path}: not a ${SCHEMA} report`);
    if (!json.checks.length) throw new Error(`${path}: no checks — an empty report proves nothing`);
    for (const check of json.checks) {
      if (typeof check?.id !== 'string' || !check.id) throw new Error(`${path}: every check needs a non-empty id`);
      if (typeof check?.ok !== 'boolean') throw new Error(`${path}: ${check.id}: ok must be a boolean, not ${JSON.stringify(check.ok)}`);
    }
    const ids = json.checks.map((check) => check.id);
    if (new Set(ids).size !== ids.length) throw new Error(`${path}: duplicate check ids (${ids.join(', ')})`);
    return json;
  } catch (error) {
    console.error(`gate-compare: ${error.message}`);
    process.exit(2);
  }
};

const [leftPath, rightPath] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (!leftPath || !rightPath) {
  console.error('gate-compare: usage: node scripts/gate-compare.mjs local.json cloud.json [--json]');
  process.exit(2);
}

const left = read(leftPath);
const right = read(rightPath);
const map = (report) => new Map(report.checks.map((check) => [check.id, check.ok]));
const a = map(left);
const b = map(right);

const onlyLeft = [...a.keys()].filter((id) => !b.has(id));
const onlyRight = [...b.keys()].filter((id) => !a.has(id));
const verdicts = [...a.keys()].filter((id) => b.has(id) && a.get(id) !== b.get(id)).map((id) => ({ id, local: a.get(id), cloud: b.get(id) }));
const targetMismatch = left.target !== 'local' || right.target !== 'cloud' ? [{ local: left.target, cloud: right.target }] : [];
const failures = [...left.checks, ...right.checks].filter((check) => check.ok !== true).map((check) => check.id);
const differences = { onlyLocal: onlyLeft, onlyCloud: onlyRight, verdicts, targetMismatch, failing: [...new Set(failures)] };
const ok = !onlyLeft.length && !onlyRight.length && !verdicts.length && !targetMismatch.length && !failures.length;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ schema: 'gate/1', gate: 'G09', ok, differences }));
} else {
  console.log(`gate-compare: local ${a.size} checks / cloud ${b.size} checks — ${ok ? 'identical' : 'DIFFERENT'}`);
  for (const id of onlyLeft) console.log(`  only local  ${id}`);
  for (const id of onlyRight) console.log(`  only cloud  ${id}`);
  for (const diff of verdicts) console.log(`  verdict     ${diff.id}: local=${diff.local} cloud=${diff.cloud}`);
  for (const diff of targetMismatch) console.log(`  target      local=${diff.local} cloud=${diff.cloud} (expected local/cloud)`);
  for (const id of differences.failing) console.log(`  failing     ${id} (a comparison of two red reports is not a pass)`);
}
process.exit(ok ? 0 : 1);
