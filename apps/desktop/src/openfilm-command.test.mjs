import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandScript, commandScriptWindows, installOpenfilmCommand, openfilmCommand } from './openfilm-command.mjs';

test("the openfilm command alone has the app's ffmpeg first and its browser; the agent's PATH is left as it is", () => {
  const sh = commandScript('/app/node', '/app/openfilm.mjs', { ffmpeg: '/app/ffmpeg', env: { PLAYWRIGHT_BROWSERS_PATH: '/app/pw' } });
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.match(sh, /PLAYWRIGHT_BROWSERS_PATH='\/app\/pw' PATH='\/app\/ffmpeg':"\$PATH" ELECTRON_RUN_AS_NODE=1 OPENFILM_NO_UPDATE_CHECK=1 exec '\/app\/node' '\/app\/openfilm.mjs' "\$@"\n$/);
  assert.doesNotMatch(commandScript('/n', '/c'), /PATH=/);
  const cmd = commandScriptWindows('C:\\app\\node.exe', 'C:\\app\\openfilm.mjs', { ffmpeg: 'C:\\app\\ffmpeg', env: { PLAYWRIGHT_BROWSERS_PATH: 'C:\\pw' } });
  assert.match(cmd, /setlocal\r\nset "PLAYWRIGHT_BROWSERS_PATH=C:\\pw"\r\nset "PATH=C:\\app\\ffmpeg;%PATH%"\r\n/);
});

test('the installed command names itself by its whole path in all it prints (OPENFILM_RUN), a space in it too', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'openfilm app '));
  try {
    /* stands in for the app's Node: says what the CLI would be run with */
    const node = join(dir, 'node');
    writeFileSync(node, '#!/bin/sh\nprintf %s "$OPENFILM_RUN"\n');
    chmodSync(node, 0o755);
    const bin = installOpenfilmCommand(dir, { node });
    assert.equal(execFileSync(join(bin, 'openfilm'), { encoding: 'utf8' }), openfilmCommand(bin));
    assert.equal(execFileSync('/bin/sh', ['-c', `${openfilmCommand(bin)} --version`], { encoding: 'utf8' }), openfilmCommand(bin), 'runs as the agent types it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a script run after as-node.mjs is the main module, with its arguments, and no ELECTRON_RUN_AS_NODE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openfilm-as-node-'));
  try {
    const script = join(dir, 'show.mjs');
    writeFileSync(script, "console.log(JSON.stringify({ main: import.meta.main, argv: process.argv.slice(1), runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }));\n");
    const asNode = new URL('./as-node.mjs', import.meta.url).href;
    const out = JSON.parse(execFileSync(process.execPath, ['--import', asNode, script, '--flag', 'x'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }));
    assert.deepEqual(out, { main: true, argv: [script, '--flag', 'x'], runAsNode: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isolated installed CLI retains all approved paths even when the invoking shell changes them', async () => {
  const { readIsolationProfile, isolationEnvironment } = await import('openfilm/development-isolation');
  const dir = mkdtempSync(join(tmpdir(),'isolated-cli-'));
  try {
    const c={baseRoot:join(dir,'profile%literal'),instanceId:'instance-a',taskId:'T01',attemptId:'attempt-1',ports:{studio:18471,film:18472}};
    const declared={OPENFILM_ISOLATION_PROFILE:Buffer.from(JSON.stringify(c)).toString('base64url'),OPENFILM_ISOLATION_ROOT:c.baseRoot};
    const profile=readIsolationProfile(declared);
    // Probe only the generated original CLI launcher; never run Electron or media.
    const probe=join(dir,process.platform==='win32'?'probe.cmd':'probe');
    writeFileSync(probe,process.platform==='win32'?`@echo off\r\n"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.env))"\r\n`:`#!/bin/sh\nexec '${process.execPath}' -e 'process.stdout.write(JSON.stringify(process.env))'\n`);
    if(process.platform!=='win32')chmodSync(probe,0o755);
    const bin=installOpenfilmCommand(profile.paths.userData,{node:probe,env:declared});
    const out=process.platform==='win32'?execFileSync(process.env.ComSpec??'cmd.exe',['/d','/c','openfilm.cmd'],{encoding:'utf8',cwd:bin}):execFileSync(join(bin,'openfilm'),{encoding:'utf8'});
    const actual=JSON.parse(out);const expected=isolationEnvironment(profile);
    for(const[key,want]of Object.entries(expected))assert.equal(actual[key],want,key);
  } finally {rmSync(dir,{recursive:true,force:true})}
});

test('isolated CLI installer refuses a linked bin directory before writing a command', async () => {
  const {mkdirSync,symlinkSync,existsSync}=await import('node:fs');const {readIsolationProfile}=await import('openfilm/development-isolation');
  const root=mkdtempSync(join(tmpdir(),'isolated-command-link-'));
  try{const c={baseRoot:join(root,'approved'),instanceId:'instance-a',taskId:'T01',attemptId:'attempt-1',ports:{studio:18471,film:18472}};
    const env={OPENFILM_ISOLATION_PROFILE:Buffer.from(JSON.stringify(c)).toString('base64url'),OPENFILM_ISOLATION_ROOT:c.baseRoot};const p=readIsolationProfile(env);
    mkdirSync(p.paths.userData,{recursive:true});const outside=join(root,'outside');mkdirSync(outside);symlinkSync(outside,join(p.paths.userData,'bin'),'junction');
    assert.throws(()=>installOpenfilmCommand(p.paths.userData,{env}),/link|alias/);assert.equal(existsSync(join(outside,'openfilm.cmd')),false);
  }finally{rmSync(root,{recursive:true,force:true})}
});
