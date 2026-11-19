#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// G17: a task's evidence directory has the five artefacts, and they are machine-checkable.
//
// Five files, no prose required:
//   commands.json  [{cmd, exit, at}]                 every gate command and its exit code
//   output.txt     <= 200 lines                       the command output, trimmed, no secrets
//   diff.txt       `git diff --stat` + file list      what changed, bound to a commit range
//   gates.json     {schema:"evidence/1", task, base, head, gates:[{id,ok}], diff:{stat,files}}
//   review.json    {reviewer, verdict, boundHead}     a non-author's verdict on exactly this head
//
// Secrets are refused by pattern, not by trust: a token, a connection string with a password, an
// absolute user path, or a private key block fails the gate.
//
// Usage: node scripts/gate-evidence.mjs docs/execution/2026-11-13-P1 [--json]
// Exit:  0 complete; 1 missing/invalid/leaky; 2 bad arguments.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED = ['commands.json', 'output.txt', 'diff.txt', 'gates.json', 'review.json'];
const SECRET = [
  /sb_secret_[A-Za-z0-9_-]{8,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /postgres(?:ql)?:\/\/[^\s:]+:[^\s@]+@/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /[A-Za-z]:\\+/,
  /(?:^|["'\s])\/(?:home|Users)\/[A-Za-z0-9._-]+/,
  /"?(?:password|passwd|pwd|secret|token)"?\s*[=:]\s*"?[^\s",}]{6,}/i,
  /Bearer\s+[A-Za-z0-9_-]{12,}/,
];

const dir = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
if (!dir || !existsSync(dir)) {
  console.error('gate-evidence: usage: node scripts/gate-evidence.mjs <evidence-dir> [--json]');
  process.exit(2);
}

const problems = [];
const read = (name) => {
  const path = join(dir, name);
  if (!existsSync(path)) { problems.push(`missing ${name}`); return null; }
  if (statSync(path).size === 0) { problems.push(`empty ${name}`); return null; }
  return readFileSync(path, 'utf8');
};

const commandsText = read('commands.json');
const outputText = read('output.txt');
const diffText = read('diff.txt');
const gatesText = read('gates.json');
const reviewText = read('review.json');

const parse = (text, name) => {
  if (text === null) return null;
  try { return JSON.parse(text); } catch (error) { problems.push(`${name}: ${error.message}`); return null; }
};

const commands = parse(commandsText, 'commands.json');
if (commands && (!Array.isArray(commands) || commands.some((entry) => typeof entry?.cmd !== 'string' || !Number.isInteger(entry?.exit)))) {
  problems.push('commands.json: expected [{cmd:string, exit:number, at?:string}]');
}
if (Array.isArray(commands)) {
  const failed = commands.filter((entry) => entry?.exit !== 0);
  for (const entry of failed) problems.push(`commands.json: exit ${entry.exit} from \`${entry.cmd}\` — evidence of a passing gate cannot contain a failing command`);
}
const gates = parse(gatesText, 'gates.json');
if (gates) {
  if (gates.schema !== 'evidence/1') problems.push('gates.json: schema must be "evidence/1"');
  if (gates.ok === false) problems.push('gates.json: ok is false — this evidence records a red gate');
  for (const key of ['task', 'base', 'head']) if (typeof gates[key] !== 'string' || !gates[key]) problems.push(`gates.json: ${key} must be a non-empty string`);
  if (!Array.isArray(gates.gates) || !gates.gates.length) problems.push('gates.json: gates[] must be non-empty');
  else for (const gate of gates.gates) {
    if (typeof gate?.id !== 'string' || typeof gate?.ok !== 'boolean') problems.push('gates.json: every gate needs {id:string, ok:boolean}');
    else if (gate.ok !== true) problems.push(`gates.json: ${gate.id} is not passing`);
  }
  if (!gates.diff || typeof gates.diff.stat !== 'string' || !Array.isArray(gates.diff.files)) problems.push('gates.json: diff needs {stat:string, files:string[]}');
}
const review = parse(reviewText, 'review.json');
if (review) {
  if (typeof review.reviewer !== 'string' || !review.reviewer) problems.push('review.json: reviewer is required');
  if (!['approve', 'changes'].includes(review.verdict)) problems.push('review.json: verdict must be approve|changes');
  else if (review.verdict === 'changes') problems.push('review.json: verdict is changes — the work is not approved yet');
  if (typeof review.boundHead !== 'string' || !/^[0-9a-f]{7,40}$/.test(review.boundHead)) problems.push('review.json: boundHead must be a commit id');
  if (gates?.head && review.boundHead && !gates.head.startsWith(review.boundHead) && !review.boundHead.startsWith(gates.head)) {
    problems.push('review.json: boundHead does not match gates.json head');
  }
}
if (outputText) {
  const lines = outputText.split(/\r?\n/).length;
  if (lines > 200) problems.push(`output.txt: ${lines} lines (keep <= 200)`);
}
for (const [name, text] of [['commands.json', commandsText], ['output.txt', outputText], ['diff.txt', diffText], ['gates.json', gatesText], ['review.json', reviewText]]) {
  if (!text) continue;
  for (const pattern of SECRET) if (pattern.test(text)) problems.push(`${name}: looks like a secret (${pattern.source})`);
}

const ok = problems.length === 0;
if (process.argv.includes('--json')) console.log(JSON.stringify({ schema: 'gate/1', gate: 'G17', ok, problems }));
else {
  console.log(`gate-evidence: ${dir} — ${ok ? 'complete' : `${problems.length} problem(s)`}`);
  for (const problem of problems) console.log(`  ${problem}`);
}
process.exit(ok ? 0 : 1);
