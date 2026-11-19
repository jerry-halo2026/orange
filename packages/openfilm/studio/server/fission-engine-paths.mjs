// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Fission 要的那份 `FISSION_ENGINE_PATHS`：七个路径，一个都不能猜。
 *
 * Fission 的原话是「未注入引擎路径即配置错误，不猜测默认路径」（`EnginePaths.ValidateConfiguration`）——
 * 这是对的：渲染器猜错一个路径，出来的片子是黑的，而错误信息会离现场很远。
 *
 * 所以这一层的职责是**把它那份配置从我们已有的东西里算出来**，并在算不出来时说清缺什么：
 *
 *   FFmpeg / FFprobe  ← app 自带的 `ffmpeg-runtime`（`<dataDir>/runtime/ffmpeg-<ver>/`）
 *   TransitionsDir    ← `<dataDir>/runtime/transitions`（.glsl 目录；**缺失不阻断**，Fission 只在实际有 glsl 时
 *                        冻结着色器证据，转场按 xfade 能力降级 —— 记录在 docs/transitions-ffmpeg9.md）
 *   AssetsRoot        ← 项目 `assets/`（素材取进来就落这里）
 *   LocalAssetsRoot   ← 这台机器的内容库（`<dataDir>/material-cache/content`）
 *   WorkRoot / OutRoot ← 项目 `.film/fission/`（跟着项目走，不污染用户目录）
 */
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const isWin = process.platform === 'win32';
const exe = (/** @type {string} */ name) => (isWin ? `${name}.exe` : name);

/**
 * app 自带的那份 ffmpeg 目录（`runtime/ffmpeg-<version>`，取版本号最大的一个）。
 * @param {string} dataDir
 */
export function ffmpegRuntimeDir(dataDir) {
  const runtime = join(dataDir, 'runtime');
  if (!existsSync(runtime)) return null;
  const candidates = readdirSync(runtime)
    .filter((name) => name.startsWith('ffmpeg-'))
    .map((name) => join(runtime, name))
    .filter((dir) => existsSync(join(dir, exe('ffmpeg'))) && existsSync(join(dir, exe('ffprobe'))));
  if (!candidates.length) return null;
  /* 版本号大的优先（`ffmpeg-9.0.2` > `ffmpeg-8.1.2`）：按目录名里的数字段比较 */
  const score = (/** @type {string} */ dir) => dir.split(/[^0-9]+/).filter(Boolean).map(Number);
  return candidates.sort((a, b) => {
    const x = score(a);
    const y = score(b);
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
      const diff = (y[i] ?? 0) - (x[i] ?? 0);
      if (diff) return diff;
    }
    return 0;
  })[0];
}

/**
 * 算出 `FISSION_ENGINE_PATHS` 的七项。
 *
 * @param {{ dataDir: string, project: string, env?: Record<string, string | undefined>, mkdirs?: boolean }} options
 * @returns {{ paths: Record<string, string>, json: string, problems: string[], ok: boolean }}
 */
export function resolveEnginePaths({ dataDir, project, env = process.env, mkdirs = true }) {
  /** @type {string[]} */
  const problems = [];
  const runtime = ffmpegRuntimeDir(String(env.OPENFILM_FFMPEG_DIR ?? '').trim() || dataDir);
  if (!runtime) {
    problems.push('找不到 app 自带的 ffmpeg（<dataDir>/runtime/ffmpeg-<version>/）：先让 `ffmpeg-runtime` 把它下下来');
  }
  const ffmpeg = runtime ? join(runtime, exe('ffmpeg')) : '';
  const ffprobe = runtime ? join(runtime, exe('ffprobe')) : '';

  const transitions = String(env.OPENFILM_TRANSITIONS_DIR ?? '').trim() || join(dataDir, 'runtime', 'transitions');
  const assets = join(project, 'assets');
  const localAssets = join(dataDir, 'material-cache', 'content');
  const work = join(project, '.film', 'fission', 'work');
  const out = join(project, '.film', 'fission', 'out');

  /**
   * Fission 只收**规范长路径**：`C:\Users\ADMINI~1\...` 这种 8.3 短名会被
   * "canonical path spelling" 直接拒（只回一句 CFG_ARGS，看不出是路径问题）。
   * `realpathSync.native` 正好把短名展开成长名。建不出来的目录原样返回，交给存在性检查报错。
   */
  const canonicalDir = (/** @type {string} */ dir) => {
    if (!mkdirs) return dir;
    try {
      mkdirSync(dir, { recursive: true });
      return realpathSync.native(dir);
    } catch {
      return dir;
    }
  };

  /* 全部规范成长名：短名会被 Fission 的路径策略拒掉，而它只回一句 CFG_ARGS */
  const dirs = {
    TransitionsDir: canonicalDir(transitions),
    AssetsRoot: canonicalDir(assets),
    LocalAssetsRoot: canonicalDir(localAssets),
    WorkRoot: canonicalDir(work),
    OutRoot: canonicalDir(out),
  };
  for (const [key, dir] of Object.entries(dirs)) {
    if (!existsSync(dir)) problems.push(`目录不可用：${key}=${dir}`);
  }

  const paths = { FFmpeg: ffmpeg, FFprobe: ffprobe, ...dirs };
  return { paths, json: JSON.stringify(paths), problems, ok: problems.length === 0 };
}

/**
 * 转场目录里现在有哪些 `.glsl`（Fission 用它当转场名字的唯一来源；空目录 = 全部按 xfade 降级）。
 * @param {Record<string, string>} paths
 * @returns {string[]}
 */
export function transitionNames(paths) {
  try {
    return readdirSync(paths.TransitionsDir).filter((name) => name.endsWith('.glsl')).map((name) => name.slice(0, -5)).sort();
  } catch {
    return [];
  }
}
