// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandScript, commandScriptWindows, installOrangefilmCommand, orangefilmCommand } from './orangefilm-command.mjs';
import { testRoot } from '../../../packages/orangefilm/src/test-roots.mjs';

test("the orangefilm command alone has the app's ffmpeg first and its browser; the agent's PATH is left as it is", () => {
  const sh = commandScript('/app/node', '/app/orangefilm.mjs', { ffmpeg: '/app/ffmpeg', env: { PLAYWRIGHT_BROWSERS_PATH: '/app/pw' } });
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.match(sh, /PLAYWRIGHT_BROWSERS_PATH='\/app\/pw' PATH='\/app\/ffmpeg':"\$PATH" ELECTRON_RUN_AS_NODE=1 ORANGE_NO_UPDATE_CHECK=1 exec '\/app\/node' '\/app\/orangefilm.mjs' "\$@"\n$/);
  assert.doesNotMatch(commandScript('/n', '/c'), /PATH=/);
  const cmd = commandScriptWindows('C:\\app\\node.exe', 'C:\\app\\orangefilm.mjs', { ffmpeg: 'C:\\app\\ffmpeg', env: { PLAYWRIGHT_BROWSERS_PATH: 'C:\\pw' } });
  assert.match(cmd, /setlocal\r\nset "PLAYWRIGHT_BROWSERS_PATH=C:\\pw"\r\nset "PATH=C:\\app\\ffmpeg;%PATH%"\r\n/);
});

test('the installed command names itself by its whole path in all it prints (ORANGE_RUN), a space in it too', { skip: process.platform === 'win32' && 'POSIX only: the fixture is a sh script standing in for the app\'s node' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'orangefilm app '));
  try {
    /* stands in for the app's Node: says what the CLI would be run with */
    const node = join(dir, 'node');
    writeFileSync(node, '#!/bin/sh\nprintf %s "$ORANGE_RUN"\n');
    chmodSync(node, 0o755);
    const bin = installOrangefilmCommand(dir, { node });
    assert.equal(execFileSync(join(bin, 'orangefilm'), { encoding: 'utf8' }), orangefilmCommand(bin));
    assert.equal(execFileSync('/bin/sh', ['-c', `${orangefilmCommand(bin)} --version`], { encoding: 'utf8' }), orangefilmCommand(bin), 'runs as the agent types it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a script run after as-node.mjs is the main module, with its arguments, and no ELECTRON_RUN_AS_NODE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orangefilm-as-node-'));
  try {
    const script = join(dir, 'show.mjs');
    writeFileSync(script, "console.log(JSON.stringify({ main: import.meta.main, argv: process.argv.slice(1), runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }));\n");
    const asNode = new URL('./as-node.mjs', import.meta.url).href;
    const out = JSON.parse(execFileSync(process.execPath, ['--import', asNode, script, '--flag', 'x'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }));
    assert.deepEqual(out, { main: true, argv: [script, '--flag', 'x'], runAsNode: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isolated installed CLI retains all approved paths even when the invoking shell changes them', async () => {
  const { readIsolationProfile, isolationEnvironment } = await import('orangefilm/development-isolation');
  const dir = mkdtempSync(join(testRoot('orangefilm-command'),'isolated-cli-'));
  try {
    const c={baseRoot:join(dir,'profile%literal'),instanceId:'instance-a',taskId:'T01',attemptId:'attempt-1',ports:{studio:18471,film:18472}};
    const declared={ORANGE_ISOLATION_PROFILE:Buffer.from(JSON.stringify(c)).toString('base64url'),ORANGE_ISOLATION_ROOT:c.baseRoot};
    const profile=readIsolationProfile(declared);
    // Probe only the generated original CLI launcher; never run Electron or media.
    const probe=join(dir,process.platform==='win32'?'probe.cmd':'probe');
    writeFileSync(probe,process.platform==='win32'?`@echo off\r\n"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.env))"\r\n`:`#!/bin/sh\nexec '${process.execPath}' -e 'process.stdout.write(JSON.stringify(process.env))'\n`);
    if(process.platform!=='win32')chmodSync(probe,0o755);
    const bin=installOrangefilmCommand(profile.paths.userData,{node:probe,env:declared});
    const out=process.platform==='win32'?execFileSync(process.env.ComSpec??'cmd.exe',['/d','/c','orangefilm.cmd'],{encoding:'utf8',cwd:bin}):execFileSync(join(bin,'orangefilm'),{encoding:'utf8'});
    const actual=JSON.parse(out);const expected=isolationEnvironment(profile);
    for(const[key,want]of Object.entries(expected))assert.equal(actual[key],want,key);
  } finally {rmSync(dir,{recursive:true,force:true})}
});

test('isolated CLI installer refuses a linked bin directory before writing a command', async () => {
  const {mkdirSync,symlinkSync,existsSync}=await import('node:fs');const {readIsolationProfile}=await import('orangefilm/development-isolation');
  const root=mkdtempSync(join(testRoot('orangefilm-command'),'isolated-command-link-'));
  try{const c={baseRoot:join(root,'approved'),instanceId:'instance-a',taskId:'T01',attemptId:'attempt-1',ports:{studio:18471,film:18472}};
    const env={ORANGE_ISOLATION_PROFILE:Buffer.from(JSON.stringify(c)).toString('base64url'),ORANGE_ISOLATION_ROOT:c.baseRoot};const p=readIsolationProfile(env);
    mkdirSync(p.paths.userData,{recursive:true});const outside=join(root,'outside');mkdirSync(outside);symlinkSync(outside,join(p.paths.userData,'bin'),'junction');
    assert.throws(()=>installOrangefilmCommand(p.paths.userData,{env}),/link|alias/);assert.equal(existsSync(join(outside,'orangefilm.cmd')),false);
  }finally{rmSync(root,{recursive:true,force:true})}
});
