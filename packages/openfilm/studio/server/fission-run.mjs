// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 真跑 Fission：写两份 JSON、拼十一条参数、收进度、把失败翻成人话。
 *
 * # 今天实测踩出来的五条（都写进代码了，别再犯）
 *
 * 1. `FISSION_ENGINE_PATHS` 是**一个 JSON 文件的绝对路径**，不是内联 JSON —— 传内联会报"必须是绝对路径"；
 * 2. `run --paths` 的文件只允许 5 个键（FFmpeg/FFprobe/[FFmpeg6]/TransitionsDir/AssetsRoot/LocalAssetsRoot）；
 *    **WorkRoot/OutRoot 由 `--workspace <ws>/<task>/<attempt>` 派生**，写进文件就 `CFG_ARGS`；
 * 3. 路径必须是**规范长路径**：`C:\Users\ADMINI~1\…` 这类短名会被"canonical path spelling"拒掉；
 * 4. 输入目录（VideoDir/AudioDir）必须在 AssetsRoot 或 LocalAssetsRoot 之下；
 * 5. NVENC 不可用（driver 太旧）会回落到 CPU 编码 —— 那不是错误，只是慢。
 *
 * 实测（两条测试片段 + 两段配音，TrimLonger）：
 *   成功 1 / 失败 0 / countReached / 3.9s → out/job<时间戳>/01_S1.mp4
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { explainFissionFailure } from './fission-plan.mjs';

/** 应用启动时写下的随包运行时（`ORANGE_FISSION_CONFIG_FILE`）：`{dotnet, cli}`；读不出就是空串。 */
export function readConfiguredRuntime(file = process.env.ORANGE_FISSION_CONFIG_FILE) {
  /* dev 没把 env 带进 Studio 进程时，退回到检出里的 .dev/fission-config.json（安装版仍由 env 指定）。 */
  const devFile = join(REPO_ROOT, '.dev', 'fission-config.json');
  const source = String(file ?? '').trim() || (existsSync(devFile) ? devFile : '');
  if (!source) return { dotnet: '', cli: '' };
  try {
    const parsed = JSON.parse(readFileSync(source, 'utf8'));
    return {
      dotnet: typeof parsed?.dotnet === 'string' ? parsed.dotnet : '',
      cli: typeof parsed?.cli === 'string' ? parsed.cli : '',
    };
  } catch {
    return { dotnet: '', cli: '' };
  }
}

/** Fission CLI 的 dll（检出里 build 出来的那份）。 */
export const FISSION_DLL = ['workers', 'fission', 'src', 'Fission.Cli', 'bin', 'Debug', 'net10.0', 'Fission.Cli.dll'];

/**
 * 这个文件所在的**检出根**（`packages/openfilm/studio/server/` 往上四级）。
 *
 * 不能从"工程目录"往上推算：工程在用户的项目里，和检出没有关系 —— 之前就是这么写错的，
 * 结果 spawn 出来一句"找不到指定的文件"，而那句话离真正的原因很远。
 */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * `run` 要的那十一条参数（run + 五个成对的 flag）。
 * 单独抽出来测，因为它错一个字符就是 `CFG_ARGS`，而 CLI 不会告诉你是哪一个。
 * @param {{ pathsFile: string, workspace: string, task: string, attempt: string, jobFile: string }} files
 */
export function runArgs({ pathsFile, workspace, task, attempt, jobFile }) {
  for (const [name, value] of Object.entries({ pathsFile, workspace, task, attempt, jobFile })) {
    if (typeof value !== 'string' || !value) throw new Error(`${name} 不能为空`);
  }
  /* task / attempt 必须是显式的小写字母数字与连字符（CLI 的 ValidateIdentity） */
  for (const [name, value] of Object.entries({ task, attempt })) {
    if (!/^[a-z0-9-]{1,40}$/.test(value)) throw new Error(`${name} 只能是小写字母、数字与连字符：${value}`);
  }
  return ['run', '--paths', pathsFile, '--workspace', workspace, '--task', task, '--attempt', attempt, '--job', jobFile];
}

/**
 * `run --paths` 的文件：**只有五个键**。WorkRoot/OutRoot 由 workspace 派生，写进去会被拒。
 * @param {Record<string, string>} paths
 */
export function pathsFileJson(paths) {
  /* Fission 的路径策略明确拒绝"符号链接祖先"（`Linked path ancestors are not accepted`）。
     macOS 上 /tmp 与 /var 都是链接（→ /private/…），所以同一个工程在 Windows 上没事、在 Mac 上直接被拒。
     这里统一在写文件前 realpath 一遍：它是**产品级**修正，不只是测试脚本的方便 —— 用户的工程只要落在
     任何符号链接下面（iCloud、/tmp、外接盘的挂载点）都会撞上这条规则。 */
  const canonical = (/** @type {string} */ value) => {
    if (typeof value !== 'string' || !value) return value;
    try {
      return existsSync(value) ? realpathSync.native(value) : value;
    } catch {
      return value;
    }
  };
  return JSON.stringify({
    FFmpeg: canonical(paths.FFmpeg),
    FFprobe: canonical(paths.FFprobe),
    TransitionsDir: canonical(paths.TransitionsDir),
    AssetsRoot: canonical(paths.AssetsRoot),
    LocalAssetsRoot: canonical(paths.LocalAssetsRoot),
  });
}

/**
 * 跑一次 Fission。
 *
 * @param {{ job: any, enginePaths: Record<string, string>, root: string, dotnet?: string, dll?: string,
 *   onLine?: (line: string) => void, timeoutMs?: number }} options
 * @returns {Promise<{ code: number, outDir: string, files: string[], message: string, stderr: string }>}
 */
export function runFission({ job, enginePaths, root, dotnet, dll, onLine = () => {}, timeoutMs = 30 * 60_000 }) {
  mkdirSync(root, { recursive: true });
  /* Fission 拒收 8.3 短名（C:\Users\ADMINI~1\...）：跑之前把 root 规范成长名 */
  const canonicalRoot = (() => { try { return realpathSync.native(root); } catch { return root; } })();
  const workspace = join(canonicalRoot, 'workspace');
  const task = 't1';
  const attempt = 'a1';
  const pathsFile = join(canonicalRoot, 'engine-paths.json');
  const jobFile = join(canonicalRoot, 'job.json');
  writeFileSync(pathsFile, pathsFileJson(enginePaths), 'utf8');
  writeFileSync(jobFile, JSON.stringify(job, null, 1), 'utf8');
  /* 打包后的应用里，dotnet 是随包的 atom 启动器、dll 是随包的 CLI（见 fission-publish.mjs 的 host 说明） */
  /* 打包后的应用把 host/CLI 的对应关系写在 `ORANGE_FISSION_CONFIG_FILE` 里；没有它才退回开发检出。 */
  const configured = readConfiguredRuntime();
  const dotnetExe = String(dotnet ?? '').trim() || configured.dotnet || 'dotnet';
  const cliDll = String(dll ?? '').trim() || process.env.FISSION_CLI_DLL?.trim() || configured.cli || join(REPO_ROOT, ...FISSION_DLL);

  return new Promise((resolve) => {
    const child = spawn(dotnetExe, [cliDll, ...runArgs({ pathsFile, workspace, task, attempt, jobFile })], {
      windowsHide: true,
      env: { ...process.env, FISSION_ENGINE_PATHS: pathsFile },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => { const text = String(chunk); stdout += text; onLine(text); });
    child.stderr.on('data', (chunk) => { const text = String(chunk); stderr += text; onLine(text); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const outRoot = join(workspace, task, attempt, 'out');
      /** @type {string[]} */
      const files = [];
      try {
        for (const folder of readdirSync(outRoot)) {
          const dir = join(outRoot, folder);
          for (const name of readdirSync(dir)) if (/\.(mp4|mov)$/i.test(name)) files.push(join(dir, name));
        }
      } catch { /* 没有产物就是失败，下面按 stderr 说 */ }
      resolve({
        code: code ?? 1,
        outDir: outRoot,
        files,
        stderr,
        message: explainFissionFailure({ code: code ?? 1, stderr, outDir: outRoot }),
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, outDir: '', files: [], stderr: String(error?.message ?? error), message: 'dotnet 没跑起来（.NET 10 装了没？）' });
    });
  });
}
