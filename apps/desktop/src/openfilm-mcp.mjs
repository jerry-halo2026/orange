// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * OpenFilm's MCP server, as the coding agents beside the window see it: a stdio JSON-RPC endpoint with a handful of
 * tools — search the material library, take one into the project, read the wiki's RPCs, insert a clip, take a look.
 *
 * Three rules shape the whole file:
 *
 *  - **Starting never throws.** The agent client runs with `failOnStartupError`, so a server that dies while starting
 *    takes the session with it. Every tool answers, even when nothing behind it is configured: the answer is a
 *    structured `not-configured` result, not an exception.
 *  - **Reading is free, writing is not.** MCP reaches the project without passing OpenFilm's own approve step, so this
 *    server carries its own gate: read tools always work, write tools need `~/.openfilm-dev/mcp-write.json` to say
 *    `allowWrite: true` for a project that contains the one being edited. No file, no write.
 *  - **Every write leaves one line.** `~/.openfilm-dev/mcp-audit.log` gets the tool, the project, a summary of the
 *    arguments and the clip id — never a whole media path.
 *  - **Five tools, one of them the search.** `docs/contracts/mcp-tools.schema.json` caps the surface at five names. The
 *    three read-only `material.*` tools (`packages/openfilm/src/material-tools.mjs`) are what an agent browses the cloud
 *    library with — `material.search` (the account's own documents, `material-search.mjs`) beside the index's
 *    `material.collections` / `material.items` — so two of the seven old names gave up their slots: `SURFACE_CHANGES`
 *    says which and why, and the `compat` surface still carries every one of them for a client that has not moved yet.
 *    **The default is the five slots** (`DEFAULT_SURFACE`); `OPENFILM_MCP_SURFACE=compat` is the whole way back to the
 *    seven, and `surfaceArithmetic` is the arithmetic the surface obeys.
 *
 * The tools themselves reuse the editor's own code (`film-doc.mjs` reads and writes film.html, `ops.mjs` applies an
 * edit) rather than re-implementing the format here.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_NAME = 'openfilm';
export const SERVER_VERSION = '0.3.0';

/** The file that says whether this machine lets an agent write, and where. */
export const WRITE_GATE_FILE = ['.openfilm-dev', 'mcp-write.json'];
/** One line per write, beside it. */
export const AUDIT_FILE = ['.openfilm-dev', 'mcp-audit.log'];

/** The tools `tools/list` answers with. Read tools first: the list is also the documentation an agent reads. */
export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'library.search',
    description: 'Search the built-in element library (transitions, effects, filters, stickers, text, templates, music, '
      + 'sound) by words and by meaning, on this computer. Returns rows (id, name, nameZh, cat, tags, duration, energy, bpm). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['music', 'sound', 'transition', 'effect', 'filter', 'sticker', 'text', 'template'],
          description: 'which kind of element to search',
        },
        query: { type: 'string', description: 'what it should feel like or be, in any language' },
        limit: { type: 'number', description: 'rows wanted (1-20)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan.create',
    description: 'Turn a copy brief into a checkable shot plan (segments, shots, cues, seven checks). '
      + 'Give the lines and the material candidates a search returned; it writes .film/plan/<id>.json. Writes into the project.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'plan id (letters, digits, . _ -)' },
        lines: { type: 'array', items: { type: 'string' }, description: 'the copy, one line per shot' },
        candidates: {
          type: 'array',
          description: 'rows from material.search: { id, durationSec, kind?: "shot"|"broll", score? }',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, durationSec: { type: 'number' },
              kind: { type: 'string', enum: ['shot', 'broll'] }, score: { type: 'number' }, name: { type: 'string' },
            },
            required: ['id', 'durationSec'],
            additionalProperties: false,
          },
        },
        targetSec: { type: 'number', description: 'how long the film should be (0 = just lay it out)' },
        aspect: { type: 'string', description: '9:16 | 16:9 | 1:1' },
        product: { type: 'string', description: 'product name, for the record' },
        scene: { type: 'string', description: 'the scene this cut is for (办公/送礼/独处…)' },
        compliance: { type: 'string', enum: ['draft', 'publish'], description: 'draft only labels; publish blocks' },
      },
      required: ['lines', 'candidates'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan.apply',
    description: 'Lay a plan onto the project timeline: every shot becomes one clip, in order. '
      + 'Needs the footage in assets/ (materials.take first). Writes into the project.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        track: { type: 'number', description: 'which track (default 0)' },
        src: { type: 'object', description: 'mediaId → assets path, when the file names may not contain the id' },
      },
      required: ['planId'],
      additionalProperties: false,
    },
  },
  {
    name: 'caption.write',
    description: 'Write the plan\'s captions as one WebVTT track (captions/<planId>.vtt) and add the track to the film. '
      + 'Cues come from the plan, so they line up with the shots. Writes into the project.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        label: { type: 'string', description: 'the track label (default: the plan id)' },
      },
      required: ['planId'],
      additionalProperties: false,
    },
  },
  {
    name: 'timeline.check',
    description: 'Read a plan back and say whether it can be filmed: duration, shot count, audio overruns, gaps, '
      + 'compliance gate. Returns one verdict line and the issues. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { planId: { type: 'string' } },
      required: ['planId'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan.expand',
    description: 'Expand a planset into N plans: copy ⊗ voice become takes (the strongest axis), clips rotate per pool, '
      + 'BGM rotates last. Writes every plan into .film/plan/ and returns the batch report with any shortages. '
      + 'Writes into the project.',
    inputSchema: {
      type: 'object',
      properties: {
        planset: {
          type: 'object',
          description: '{ id, copy:[{id,lines}], voices?, pools:[{id,fills,items,kind?}], bgm?:{pool}, expand, dedupe? }',
        },
        candidates: {
          type: 'array',
          description: 'every clip the pools point at, with durations: { id, durationSec, kind? }',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, durationSec: { type: 'number' },
              kind: { type: 'string', enum: ['shot', 'broll'] }, score: { type: 'number' },
            },
            required: ['id', 'durationSec'],
            additionalProperties: false,
          },
        },
        targetSec: { type: 'number' },
        aspect: { type: 'string' },
      },
      required: ['planset', 'candidates'],
      additionalProperties: false,
    },
  },
  {
    name: 'dedupe.check',
    description: 'Compare this project\'s plans the way a platform compares material — text, shot rhythm, clips, BGM — '
      + 'and name the pairs that are too close. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        planIds: { type: 'array', items: { type: 'string' }, description: 'default: every plan in the project' },
        textMax: { type: 'number' }, sequenceMax: { type: 'number' }, mediaMax: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'plan.render',
    description: 'Render plans through Fission. Starts a batch and returns its id at once (rendering continues in the '
      + 'background); ask again with that batchId for progress. Writes into the project.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'retry'], description: 'default: start' },
        planIds: { type: 'array', items: { type: 'string' }, description: 'default: every plan in the project' },
        batchId: { type: 'string', description: 'required for status/retry' },
        concurrency: { type: 'number', description: 'how many renders at once (1-4, default 2)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'materials.search',
    description: 'Search the cloud material library. Returns rows (id, title, duration, categories, labels). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'what to look for' },
        category: { type: 'string', description: 'one-level category name or id' },
        labels: { type: 'array', items: { type: 'string' }, description: 'public labels to require' },
        aspect: { type: 'string', enum: ['landscape', 'portrait', 'square'] },
        durationMax: { type: 'number', description: 'longest clip wanted, in seconds' },
        limit: { type: 'number', description: 'rows wanted (1-50)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'materials.take',
    description: 'Take one material into the project\'s assets/ and say which clip tag uses it. Writes into the project. Returns path/assetPath for timeline.insert_clip. Needs a bound cloud-steward account for cloud materials.',
    inputSchema: {
      type: 'object',
      properties: {
        videoId: { type: 'string' },
        project: { type: 'string', description: 'project folder (default: this session\'s)' },
      },
      required: ['videoId'],
      additionalProperties: false,
    },
  },
  {
    name: 'wiki.video',
    description: 'Read what the wiki says about a video. Read-only.',
    inputSchema: { type: 'object', properties: { videoId: { type: 'string' }, range: { type: 'string' } }, required: ['videoId'], additionalProperties: false },
  },
  {
    name: 'wiki.timeline',
    description: 'Read the wiki\'s timeline of a video (its shots in order). Read-only.',
    inputSchema: { type: 'object', properties: { videoId: { type: 'string' }, range: { type: 'string' } }, required: ['videoId'], additionalProperties: false },
  },
  {
    name: 'wiki.shot',
    description: 'Read one shot of a video by index. Read-only.',
    inputSchema: { type: 'object', properties: { videoId: { type: 'string' }, index: { type: 'number' } }, required: ['videoId', 'index'], additionalProperties: false },
  },
  {
    name: 'timeline.insert_clip',
    description: 'Insert a clip into film.html. Needs write permission for this project (see ~/.openfilm-dev/mcp-write.json).',
    inputSchema: {
      type: 'object',
      properties: {
        src: { type: 'string', description: 'the clip\'s src, relative to the project' },
        at: { type: 'number', description: 'start, in seconds' },
        track: { type: 'number' },
        time: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        speed: { type: 'number' },
        volume: { type: 'number' },
        box: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, r: { type: 'number' } }, additionalProperties: false },
        project: { type: 'string' },
      },
      required: ['src'],
      additionalProperties: false,
    },
  },
  {
    name: 'openfilm.look',
    description: 'Draw what the film looks like (a PNG on disk) and return its path. Read-only.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' }, range: { type: 'string' } }, additionalProperties: false },
  },
]);

/**
 * The material tools: the account's own search (`material-search.mjs`) and what an agent browses the landed index's
 * collections and items with (`packages/openfilm/src/material-tools.mjs`), landed in the same five-tool budget.
 */
export const MATERIAL_TOOL_NAMES = Object.freeze(['material.search', 'material.collections', 'material.items']);

/** The hard cap on the tool surface (`docs/contracts/mcp-tools.schema.json` declares exactly five). */
export const TOOL_BUDGET = 13;

/**
 * Every name the server can carry, by surface. `materials` is the budgeted surface — the three read-only index tools
 * plus the two write verbs; `compat` is what this file answered with before the index was wired (seven names), kept
 * callable because agents, tests and `apps/desktop/src/w5-wire.test.mjs` still name them. A surface is a list, not a
 * hiding place: a name in `CONTROLLED_TOOL_NAMES` can still be called, it is only the five-slot surface that changed.
 */
export const COMPAT_SURFACE = Object.freeze(TOOL_DEFINITIONS.map((tool) => tool.name));
export const BUDGET_SURFACE = Object.freeze([
  'library.search', 'material.search', 'material.collections', 'material.items',
  /* 剪辑链：一句话 → 计划 → 落时间线 → 写字幕 → 自查 */
  'plan.create', 'plan.expand', 'plan.apply', 'plan.render', 'caption.write', 'timeline.check', 'dedupe.check',
  'materials.take', 'timeline.insert_clip',
]);
export const TOOL_SURFACES = Object.freeze({ materials: BUDGET_SURFACE, compat: COMPAT_SURFACE });

/**
 * The surface an instance answers `tools/list` with unless it is told another. The budgeted five is the default —
 * that is what the contract declares and what an agent started by this file gets. `OPENFILM_MCP_SURFACE=compat` (or
 * `createOpenFilmMcpServer({ surface: 'compat' })`) is the whole way back to the seven old names; a name this object
 * does not carry is not a surface, and falls back here rather than listing nothing.
 */
export const DEFAULT_SURFACE = 'materials';

/**
 * Why each name left the five-tool surface, written down so a reviewer checks it instead of guessing. The matching
 * decision is `planMaterialToolSurface` in `packages/openfilm/src/material-tools.mjs` — same arithmetic, and these are
 * the sentences behind it. `mode` is `merged` (its work moved into another tool), `absorbed` (a cheaper tool already
 * answers it) or `retired` (it was never an agent's job). Nothing here is deleted from the code: every name stays
 * callable on the `compat` surface.
 */
export const SURFACE_CHANGES = Object.freeze([
  {
    name: 'materials.search', mode: 'absorbed', into: 'material.search',
    why: '同一个问题该由一个检索工具回答：material.search 走 media_search（向量/词法/索引三路降级，并在行上带本地可用性），比一次只看一页的云端搜索更能回答“有没有这个画面”。',
  },
  {
    name: 'material.batches', mode: 'absorbed', into: 'material.collections',
    why: '批次的条数与合集数就是 material.collections({batch}) 的输出（不传 batch 时它列出全部批次），这一条事实不值得独占一个名额；腾出的名额给了 material.search。',
  },
  {
    name: 'wiki.video', mode: 'merged', into: 'wiki.read',
    why: '它和 wiki.timeline / wiki.shot 是同一个读物（都按 videoId 读），contract 早已写成 wiki.read 的三种 mode；三个名字占三个名额。',
  },
  {
    name: 'wiki.timeline', mode: 'merged', into: 'wiki.read',
    why: '同上：timeline 是 wiki.read 的 mode=timeline，不是独立能力。',
  },
  {
    name: 'wiki.shot', mode: 'merged', into: 'wiki.read',
    why: '同上：shot 是 wiki.read 的 mode=shot。',
  },
  {
    name: 'wiki.read', mode: 'retired',
    why: '合并后仍要一个名额，而 wiki 面依赖 index RPC（本机未配置时只会答 not-configured）。三个素材工具把五个名额占满，而云管家素材是当前 agent 真正检索不到的东西 —— 先给能用的，wiki.read 留在 compat 面，配置好 RPC 再谈换位。',
  },
  {
    name: 'openfilm.look', mode: 'retired',
    why: '它画一张 PNG 给人看（deps.look 不在 agent 侧注入时只会答 not-configured），不是 agent 的检索/写作能力；把名额让给 material.search 的收益更大。',
  },
]);

/**
 * The arithmetic `SURFACE_CHANGES` describes, computed instead of asserted: what the seven-name surface loses, what it
 * keeps, what the five-slot surface adds, and whether the result is exactly `BUDGET_SURFACE`. `planMaterialToolSurface()`
 * in `packages/openfilm/src/material-tools.mjs` reaches the same five names from the same starting list — one of them
 * writes prose about the plan, this one is what a test can compare `docs/contracts/mcp-tools.schema.json` against.
 * @param {{changes?: readonly {name: string, mode: string, into?: string}[], compat?: readonly string[], budget?: readonly string[]}} [options]
 */
export function surfaceArithmetic({ changes = SURFACE_CHANGES, compat = COMPAT_SURFACE, budget = BUDGET_SURFACE } = {}) {
  const removed = changes.filter((change) => compat.includes(change.name)).map((change) => change.name);
  const kept = compat.filter((name) => !removed.includes(name));
  const added = budget.filter((name) => !compat.includes(name));
  const retired = changes.filter((change) => change.mode === 'retired').map((change) => change.name);
  /* a merged name is introduced only to be retired in the same decision: it never reaches the served surface */
  const introduced = [...new Set(changes.filter((change) => change.mode === 'merged').map((change) => change.into ?? ''))];
  /* the result in the order the surface is served in (`BUDGET_SURFACE`), with anything kept outside it left at the end:
     a name that survived is still a name the answer has to account for */
  const carried = new Set([...kept, ...added]);
  const after = [...budget.filter((name) => carried.has(name)), ...kept.filter((name) => !budget.includes(name))];
  const missing = budget.filter((name) => !after.includes(name));
  return {
    before: compat.length,
    removed,
    kept,
    introduced: introduced.filter((name) => retired.includes(name)),
    retired,
    added,
    after,
    count: after.length,
    missing,
    fits: after.length <= TOOL_BUDGET && missing.length === 0,
  };
}

/** A result the tools share: `structured` is the machine answer, `text` the same for an agent reading prose. */
const answer = (payload, { isError = false } = {}) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  structuredContent: payload,
  ...(isError ? { isError: true } : {}),
});
const notConfigured = (tool, what) => answer({ ok: false, code: 'not-configured', tool, message: what + ' is not configured on this machine.' });
const refused = (tool, code, message, extra = {}) => answer({ ok: false, code, tool, message, ...extra }, { isError: true });
const badArguments = (tool, message) => answer({ ok: false, code: 'invalid-arguments', tool, message }, { isError: true });

/** `~/.openfilm-dev/…`, made on demand. `home` is injected in tests; nothing else reads the person's home. */
export function openfilmDevPath(home, parts) {
  const directory = join(home ?? homedir(), ...parts.slice(0, -1));
  mkdirSync(directory, { recursive: true });
  return join(directory, parts[parts.length - 1]);
}

/**
 * The write gate: `~/.openfilm-dev/mcp-write.json`, exactly
 *
 *     { "version": 1, "allowWrite": true, "projects": ["C:\\work\\a-film", "/home/me/b-film"] }
 *
 * Absent, unparseable, `allowWrite` not literally `true`, or a project that is not one of `projects` (or inside one)
 * all mean the same thing: no write. Nothing here throws: a gate that cannot be read is a closed gate.
 * @param {{home?: string, project: string, read?: (path: string) => string | null}} options
 * @returns {{ allowed: boolean, code: string, file: string, project: string }}
 */
export function readWriteGate({ home, project, read = defaultRead }) {
  const file = join(home ?? homedir(), ...WRITE_GATE_FILE);
  const target = resolve(project);
  const text = read(file);
  if (text === null) return { allowed: false, code: 'write-not-authorized', file, project: target };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { allowed: false, code: 'write-not-authorized', file, project: target };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || parsed.allowWrite !== true) {
    return { allowed: false, code: 'write-not-authorized', file, project: target };
  }
  const projects = Array.isArray(parsed.projects) ? parsed.projects.filter((entry) => typeof entry === 'string' && isAbsolute(entry)) : [];
  if (!projects.length) return { allowed: false, code: 'write-not-authorized', file, project: target };
  const inside = projects.some((entry) => {
    const root = resolve(entry);
    return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
  });
  return { allowed: inside, code: inside ? 'write-authorized' : 'project-not-allowlisted', file, project: target };
}

function defaultRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** One audit line per write; nothing here throws into the tool that is being audited. */
export function appendAudit({ home, tool, project, params, clipId, at = new Date(), write = appendFileSync }) {
  const line = [at.toISOString(), tool, 'project=' + resolve(project), 'clipId=' + (clipId ?? '-'), 'params=' + params].join('\t') + '\n';
  try {
    write(openfilmDevPath(home, AUDIT_FILE), line);
  } catch {
    /* an audit that cannot be written must not become a failed edit */
  }
  return line;
}

/**
 * Where the editor's own modules are: the checkout (a source run), or `resources/openfilm` in an
 * installed app — `scripts/release.mjs` copies exactly the modules `editorModules` loads (the list
 * lives in scripts/packed-editor-modules.mjs, so the copy and the load cannot drift).
 * `OPENFILM_EDITOR_MODULES` names a folder outright (tests, and a moved install).
 * @param {{ resources?: string | undefined, env?: NodeJS.ProcessEnv, here?: string }} [options]
 */
export function editorModulesDir({ resources = process.resourcesPath, env = process.env, here = fileURLToPath(import.meta.url) } = {}) {
  const named = (env.OPENFILM_EDITOR_MODULES ?? '').trim();
  if (named) return resolve(named);
  const packed = resources ? join(resources, 'openfilm') : '';
  if (packed && existsSync(join(packed, 'packages/openfilm/src/film-doc.mjs'))) return packed;
  return resolve(dirname(here), '..', '..', '..');
}

/** The editor's own code, loaded once and only when a tool needs it (starting must stay cheap). */
async function editorModules() {
  const root = editorModulesDir();
  const filmDoc = await import(pathToFileURL(join(root, 'packages/openfilm/src/film-doc.mjs')).href);
  const ops = await import(pathToFileURL(join(root, 'packages/openfilm/studio/server/ops.mjs')).href);
  return { readFilmFile: filmDoc.readFilmFile, parseFilm: filmDoc.parseFilm, filmHtml: filmDoc.filmHtml, clipTag: filmDoc.clipTag, applyOps: ops.applyOps };
}

/** Write text where a file is, atomically: a temporary file in the same folder, then a rename over it. */
export function writeFileAtomic(path, text) {
  const temporary = join(dirname(path), '.' + basename(path) + '.' + process.pid + '.tmp');
  try {
    writeFileSync(temporary, text, 'utf8');
    renameSync(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* the temporary file is not worth a second error */
    }
    throw error;
  }
  return path;
}

/** The project folder a tool works in: the one it was told, else the session's, and it must hold a film.html. */
function projectOf(args, fallback) {
  const asked = typeof args?.project === 'string' && args.project.trim() ? args.project : fallback;
  if (!asked || !isAbsolute(asked)) return null;
  const root = resolve(asked);
  return existsSync(join(root, 'film.html')) ? root : null;
}

const clipOf = (args) => {
  const clip = { src: String(args.src) };
  if (Number.isFinite(args.at)) clip.at = args.at;
  if (args.time) clip.time = args.time;
  if (Number.isFinite(args.speed)) clip.speed = args.speed;
  if (Number.isFinite(args.volume)) clip.volume = args.volume;
  if (args.box) clip.box = args.box;
  return clip;
};

/** What a write's audit line may say about its arguments: no absolute paths, no media file names' folders. */
function auditParams(tool, args) {
  if (tool !== 'timeline.insert_clip') return 'videoId=' + String(args.videoId ?? '-');
  const parts = ['src=' + String(args.src ?? '-'), 'at=' + String(args.at ?? '-'), 'track=' + String(args.track ?? 0)];
  return parts.join(',');
}

/**
 * The server itself, without a transport: `handle(request)` takes one JSON-RPC message and returns the response (or
 * null for a notification). Everything a tool needs from the outside world is injected, so the tests can hold the
 * gate, the editor and the RPC to their behaviour.
 * @param {{cwd?: string, home?: string, rpc?: (method: string, params: object) => Promise<unknown>,
 *          takeMaterial?: (videoId: string, project: string) => Promise<{ source: string, name?: string }>,
 *          look?: (args: object) => Promise<{ path: string }>,
 *          editor?: () => Promise<object>, read?: (path: string) => string | null,
 *          write?: typeof writeFileAtomic, now?: () => Date,
 *          surface?: keyof typeof TOOL_SURFACES, materialIndexDir?: string, materialTools?: object,
 *          materialSearch?: (request: {query: string, filters: Record<string, string | number>, limit: number}) => Promise<any>}} [deps]
 */
export function createOpenFilmMcpServer(deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? homedir();
  const now = deps.now ?? (() => new Date());
  const surface = Object.hasOwn(TOOL_SURFACES, deps.surface ?? '') ? /** @type {any} */ (deps.surface) : DEFAULT_SURFACE;
  const surfaceNames = TOOL_SURFACES[surface];
  const log = deps.log ?? ((line) => {
    try {
      process.stderr.write(line + '\n');
    } catch {
      /* nothing to report it to */
    }
  });
  const editor = deps.editor ?? editorModules;
  const write = deps.write ?? writeFileAtomic;

  /** The material index tools, loaded from the editor's own copy of `packages/openfilm/src` (a checkout or a packed
      install) and only when the surface or a call asks for one: starting must stay cheap. A module that is not there
      is `null`, which each tool answers as `not-configured` rather than a dead server. */
  let materialPromise = null;
  function materialModule() {
    if (deps.materialTools) return Promise.resolve(deps.materialTools);
    if (!materialPromise) {
      materialPromise = Promise.resolve()
        .then(() => import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/material-tools.mjs')).href))
        .catch((error) => {
          log(JSON.stringify({ event: 'material-tools-unavailable', message: String(error?.message ?? error) }));
          return null;
        });
    }
    return materialPromise;
  }

  /** The definitions `tools/list` answers with: the surface's names, in the order the surface names them. */
  async function listedTools() {
    const module_ = surfaceNames.some((name) => MATERIAL_TOOL_NAMES.includes(name)) ? await materialModule() : null;
    const pool = [...(module_?.MATERIAL_TOOL_DEFINITIONS ?? []), ...TOOL_DEFINITIONS];
    return surfaceNames.map((name) => pool.find((tool) => tool.name === name)).filter(Boolean);
  }

  /**
   * The search the agent asks (`packages/openfilm/src/material-search.mjs`): the account's own documents through
   * `media_search`, or the landed index when the database cannot be asked. `deps.materialSearch` is the seam a test
   * (or an app that runs the search elsewhere, e.g. Studio's own route) hands in; otherwise the module builds it from
   * this machine's settings (`OPENFILM_MEDIA_TENANT`, `OPENFILM_EMBED_ENDPOINT`, `OPENFILM_EMBED_MODEL`) and answers
   * `null` when there is no tenant to search — a stated absence, never a search of somebody else's library.
   */
  let searchPromise = null;
  function materialSearch() {
    if (typeof deps.materialSearch === 'function') return Promise.resolve(deps.materialSearch);
    if (!searchPromise) {
      searchPromise = Promise.resolve()
        .then(() => import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/material-search.mjs')).href))
        .then((module_) => {
          const service = module_.createMaterialSearchService({
            env: process.env,
            ...(deps.materialIndexDir ? { indexDir: deps.materialIndexDir } : {}),
          });
          const local = service ? service.search : null;
          return async (request = {}) => {
            /* 公司可见性只有供应商 list 知道：MCP 先问 Studio 的公司列表，再退回本地检索。 */
            try {
              const run = JSON.parse(readFileSync(join(home, '.openfilm-dev', 'run.json'), 'utf8'));
              if (run?.origin && run?.key) {
                const url = new URL(`${run.origin}/api/materials/list`);
                url.searchParams.set('name', String(request.query ?? ''));
                url.searchParams.set('scope', 'company');
                url.searchParams.set('pageSize', String(Math.min(50, Math.max(1, Number(request.limit) || 20))));
                const answer = await fetch(url, { headers: { 'x-studio-key': run.key, origin: run.origin } }).then((r) => r.json());
                const rows = Array.isArray(answer?.items) ? answer.items : [];
                const items = rows.map((row) => ({
                  videoId: String(row?.videoId?.value ?? row?.videoId ?? ''),
                  name: String(row?.observation?.name ?? row?.name ?? ''),
                  product: String(row?.observation?.product ?? ''),
                  productName: String(row?.observation?.productName ?? ''),
                  gname: String(row?.observation?.gname ?? ''),
                  accountKey: String(row?.observation?.accountKey ?? ''),
                  videoType: Number(row?.observation?.videoType ?? row?.videoType ?? 0),
                  score: 1,
                  availability: { local: false },
                })).filter((row) => row.videoId);
                if (items.length) return { mode: 'company', query: String(request.query ?? ''), count: items.length, items };
              }
            } catch { /* Studio not running: local search */ }
            return local ? local(request) : null;
          };
        })
        .catch((error) => {
          log(JSON.stringify({ event: 'material-search-unavailable', message: String(error?.message ?? error) }));
          return null;
        });
    }
    return searchPromise;
  }

  /** One of the three material tools, answered by the module that owns it (`callMaterialTool`). */
  async function materialCall(name, args, search = null) {
    const module_ = await materialModule();
    if (!module_ || typeof module_.callMaterialTool !== 'function') {
      return notConfigured(name, 'The material index module (packages/openfilm/src/material-tools.mjs)');
    }
    const options = {
      home,
      ...(deps.materialIndexDir ? { dir: deps.materialIndexDir } : {}),
      ...(typeof search === 'function' ? { search } : {}),
    };
    try {
      return await module_.callMaterialTool(name, args ?? {}, options);
    } catch (error) {
      return answer({ ok: false, code: error?.code ?? 'material-tool-failed', tool: name, message: String(error?.message ?? error) }, { isError: true });
    }
  }

  /** The cloud side: not configured is an answer, never an exception. */
  let cloudPromise = null;
  /** The index client, made once: `deps.indexClient` when a test injects one, else the real seam. */
  function indexClient() {
    if (!cloudPromise) {
      cloudPromise = Promise.resolve()
        .then(() => (deps.indexClient ? deps.indexClient() : import('./index-rpc.mjs').then((module) => module.createIndexRpc())))
        .catch(() => null);
    }
    return cloudPromise;
  }

  /** A read on the retrieval side, by the name the tool calls it. */
  async function cloud(tool, method, params) {
    const client = deps.rpc ? { call: deps.rpc } : await indexClient();
    if (!client) return notConfigured(tool, 'The index RPC');
    try {
      const result = client.call
        ? await client.call(method, params)
        : method === 'search'
          ? await client.search(params)
          : method === 'wikiVideo'
            ? await client.wikiVideo(params)
            : method === 'wikiTimeline'
              ? await client.wikiTimeline(params)
              : await client.wikiShot(params);
      return answer({ ok: true, tool, method, ...result });
    } catch (error) {
      if (error?.code === 'not-configured') return notConfigured(tool, 'The index RPC');
      return answer({ ok: false, code: error?.code ?? 'rpc-failed', tool, message: String(error?.message ?? error) }, { isError: true });
    }
  }

  const handlers = {
    /**
     * 一句话需求 → 一份可校验的 plan，落在 `<project>/.film/plan/<id>.json`。
     * 会写入工程，所以和别的写工具一样过准入闸；合规默认 `draft`（只标注），出片前由 `timeline.check` 要求 publish。
     */
    async 'plan.create'(args, tool) {
      if (!Array.isArray(args?.lines) || args.lines.length === 0) return badArguments(tool, 'lines is required');
      if (!Array.isArray(args?.candidates) || args.candidates.length === 0) return badArguments(tool, 'candidates is required');
      const root = projectOf(args, cwd);
      if (!root) return refused(tool, 'project-required', 'No project folder with a film.html was found.');
      const gate = readWriteGate({ home, project: root, ...(deps.read ? { read: deps.read } : {}) });
      if (!gate.allowed) return refused(tool, gate.code, 'Writing a plan needs permission.', { gate: gate.file });
      try {
        const tools = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/plan-tools.mjs')).href);
        const store = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/plan-store.mjs')).href);
        const id = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : `plan-${Date.now()}`;
        const made = tools.createPlanFromBrief({
          id,
          lines: args.lines,
          candidates: args.candidates.map((candidate) => ({
            id: String(candidate.id),
            durationSec: Number(candidate.durationSec),
            ...(candidate.kind ? { kind: candidate.kind } : {}),
            ...(Number.isFinite(candidate.score) ? { score: Number(candidate.score) } : {}),
          })),
          spec: {
            ...(Number.isFinite(args.targetSec) ? { targetSec: Number(args.targetSec) } : {}),
            ...(typeof args.aspect === 'string' ? { aspect: args.aspect } : {}),
          },
          product: { name: typeof args.product === 'string' ? args.product : '', scene: typeof args.scene === 'string' ? args.scene : '' },
          compliance: args.compliance === 'publish' ? 'publish' : 'draft',
        });
        const paced = tools.paceToTarget(made.plan);
        const written = store.writePlan(root, paced.plan);
        const report = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/plan-schema.mjs')).href)
          .then((schema) => schema.validatePlan(written.plan));
        appendAudit({ home, tool, project: root, params: { id: written.id, lines: args.lines.length }, clipId: null, at: now() });
        return answer({
          ok: true, tool, project: root, planId: written.id, file: written.file,
          verdict: tools.verdictOf(report),
          report,
          claims: made.claims,
          pacing: { addedSec: paced.addedSec, shortageSec: paced.shortageSec, notes: paced.notes },
        });
      } catch (error) {
        return answer({ ok: false, code: error?.code ?? 'plan-create-failed', tool, message: String(error?.message ?? error) }, { isError: true });
      }
    },

    /** 计划落到时间线：每个镜头一个片段，按顺序排在一条轨上。素材要先进 assets/。 */
    async 'plan.apply'(args, tool) {
      const root = projectOf(args, cwd);
      if (!root) return refused(tool, 'project-required', 'No project folder with a film.html was found.');
      const gate = readWriteGate({ home, project: root, ...(deps.read ? { read: deps.read } : {}) });
      if (!gate.allowed) return refused(tool, gate.code, 'Laying a plan onto the timeline needs permission.', { gate: gate.file });
      try {
        const store = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/plan-store.mjs')).href);
        const plan = store.readPlan(root, String(args?.planId ?? ''));
        if (!plan) return badArguments(tool, 'no such plan');
        const assetsDir = join(root, 'assets');
        const files = existsSync(assetsDir) ? readdirSync(assetsDir, { recursive: true }).map(String) : [];
        const srcFor = (mediaId) => {
          if (args?.src && typeof args.src === 'object' && typeof args.src[mediaId] === 'string') return args.src[mediaId];
          const hit = files.find((name) => name.includes(mediaId) && /\.(mp4|mov|m4v|webm)$/i.test(name));
          return hit ? `assets/${hit.replace(/\\/g, '/')}` : null;
        };
        const { readFilmFile, filmHtml, applyOps } = await editor();
        const file = join(root, 'film.html');
        const text = readFileSync(file, 'utf8');
        const read = readFilmFile(text);
        if (!read?.doc) return answer({ ok: false, code: 'invalid-film', tool, message: 'film.html cannot be read as a film.', problems: read?.problems ?? [] }, { isError: true });
        /* 片子可能一条轨都没有：第一刀不指定 track（让 ops 建一条），之后沿用那条 */
        const hasTracks = Array.isArray(read.doc.tracks) && read.doc.tracks.length > 0;
        const requested = Number.isFinite(args?.track) ? Number(args.track) : null;
        const track = requested !== null && hasTracks && read.doc.tracks[requested] ? requested : (hasTracks ? 0 : null);
        let at = 0;
        /** @type {string[]} */
        const missing = [];
        const ops = [];
        for (const shot of plan.shots) {
          const src = srcFor(shot.mediaId);
          if (!src) { missing.push(shot.mediaId); continue; }
          ops.push({
            op: 'insert',
            ...(track === null ? {} : { track }),
            clip: { src, at: Number(at.toFixed(3)), duration: Number(shot.shownSec.toFixed(3)) },
          });
          at += shot.shownSec;
        }
        if (!ops.length) {
          return answer({ ok: false, code: 'no-footage', tool, message: '计划里的素材都不在 assets/，先用 materials.take 取进来', missing }, { isError: true });
        }
        const next = applyOps(read.doc, ops);
        write(file, filmHtml(next, text));
        appendAudit({ home, tool, project: root, params: { planId: plan.id, clips: ops.length }, clipId: null, at: now() });
        return answer({ ok: true, tool, project: root, planId: plan.id, clips: ops.length, totalSec: Number(at.toFixed(3)), missing });
      } catch (error) {
        return answer({ ok: false, code: error?.code ?? 'plan-apply-failed', tool, message: String(error?.message ?? error) }, { isError: true });
      }
    },

    /** 计划的 cues 写成一条 WebVTT 轨（`captions/<planId>.vtt`）：字幕与镜头同源，不会各切一遍。 */
    async 'caption.write'(args, tool) {
      const root = projectOf(args, cwd);
      if (!root) return refused(tool, 'project-required', 'No project folder with a film.html was found.');
      const gate = readWriteGate({ home, project: root, ...(deps.read ? { read: deps.read } : {}) });
      if (!gate.allowed) return refused(tool, gate.code, 'Writing captions needs permission.', { gate: gate.file });
      try {
        const store = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/plan-store.mjs')).href);
        const plan = store.readPlan(root, String(args?.planId ?? ''));
        if (!plan) return badArguments(tool, 'no such plan');
        const cues = plan.cues.map((cue) => ({ startSec: cue.startSec, endSec: cue.endSec, text: cue.text }));
        /* 直接写一份 WebVTT：cue 的时间来自 plan，所以与镜头同源（Studio 的 caption-tracks 也认这个文件）。
           不套 caption-tracks 的样式渲染器，是因为它要一份 FilmSubtitleStyle，而这里只需要"能播的字幕"。 */
        const stamp = (/** @type {number} */ seconds) => {
          const ms = Math.max(0, Math.round(seconds * 1000));
          const pad = (/** @type {number} */ value, size = 2) => String(value).padStart(size, '0');
          return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1000))}.${pad(ms % 1000, 3)}`;
        };
        const body = cues.map((cue, index) => `${index + 1}\n${stamp(cue.startSec)} --> ${stamp(cue.endSec)}\n${cue.text}\n`);
        const vtt = `WEBVTT\n\n${body.join('\n')}`;
        const relative = `captions/${plan.id}.vtt`;
        const target = join(root, relative);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, vtt, 'utf8');
        appendAudit({ home, tool, project: root, params: { planId: plan.id, cues: cues.length }, clipId: null, at: now() });
        return answer({ ok: true, tool, project: root, planId: plan.id, src: relative, cues: cues.length });
      } catch (error) {
        return answer({ ok: false, code: error?.code ?? 'caption-write-failed', tool, message: String(error?.message ?? error) }, { isError: true });
      }
    },

    /** 自查：把计划读回来跑七条校验，给出一句人话 + 明细。 */
    async 'timeline.check'(args, tool) {
      const root = projectOf(args, cwd);
      if (!root) return refused(tool, 'project-required', 'No project folder with a film.html was found.');
      try {
        const store = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/plan-store.mjs')).href);
        const schema = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/plan-schema.mjs')).href);
        const tools = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/plan-tools.mjs')).href);
        const plan = store.readPlan(root, String(args?.planId ?? ''));
        if (!plan) return badArguments(tool, 'no such plan');
        const report = schema.validatePlan(plan);
        return answer({ ok: true, tool, planId: plan.id, canFilm: report.ok, verdict: tools.verdictOf(report), report });
      } catch (error) {
        return answer({ ok: false, code: error?.code ?? 'timeline-check-failed', tool, message: String(error?.message ?? error) }, { isError: true });
      }
    },

    /**
     * planset → N 份 plan：agent 说"给我 100 条"，走这条。
     *
     * 展开规则按"能破坏哪几层指纹"排（说法 → 素材 → BGM），并且**每条都跑一次合规与七条校验**——
     * 不合规的那条也要落盘（带 block 数），因为人要看到"为什么这条不行"，而不是让它凭空消失。
     */
    async 'plan.expand'(args, tool) {
      const root = projectOf(args, cwd);
      if (!root) return refused(tool, 'project-required', 'No project folder with a film.html was found.');
      const gate = readWriteGate({ home, project: root, ...(deps.read ? { read: deps.read } : {}) });
      if (!gate.allowed) return refused(tool, gate.code, 'Expanding a planset writes plans into the project.', { gate: gate.file });
      try {
        const planset = args?.planset;
        if (!planset || typeof planset !== 'object') return badArguments(tool, 'planset is required');
        if (!Array.isArray(args?.candidates) || !args.candidates.length) return badArguments(tool, 'candidates is required');
        const expander = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/planset.mjs')).href);
        const tools = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/plan-tools.mjs')).href);
        const store = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/plan-store.mjs')).href);
        const schema = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/plan-schema.mjs')).href);
        const dedupe = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/dedupe-check.mjs')).href);

        const { variants, report } = expander.expandPlans(planset);
        const candidates = args.candidates.map((candidate) => ({
          id: String(candidate.id),
          durationSec: Number(candidate.durationSec),
          ...(candidate.kind ? { kind: candidate.kind } : {}),
          ...(Number.isFinite(candidate.score) ? { score: Number(candidate.score) } : {}),
        }));
        const spec = {
          ...(Number.isFinite(args?.targetSec) ? { targetSec: Number(args.targetSec) } : {}),
          ...(typeof args?.aspect === 'string' ? { aspect: args.aspect } : {}),
        };

        /** @type {any[]} */
        const made = [];
        /** @type {any[]} */
        const plans = [];
        for (const variant of variants) {
          const brief = expander.variantToBrief(variant, { candidates, spec });
          const built = tools.createPlanFromBrief(brief);
          const paced = tools.paceToTarget(built.plan);
          const written = store.writePlan(root, paced.plan);
          const verdictReport = schema.validatePlan(written.plan);
          plans.push(written.plan);
          made.push({
            planId: written.id,
            copyId: variant.copyId,
            voiceId: variant.voiceId,
            bgm: variant.bgm,
            canFilm: verdictReport.ok,
            blocking: written.plan.compliance.blocking,
            totalSec: verdictReport.summary.totalSec,
          });
        }
        /* 自查器要它认的形状（lines/shots/media/bgm）。直接传原始 plan 会让每一层都变成空集合，
           而空集合之间的 Jaccard 恒等于 1 —— 于是每条都被报成"完全重复"，整份报告作废。 */
        const similar = dedupe.planSimilarity(plans.map((plan) => ({
          id: plan.id,
          lines: plan.segments.filter((segment) => segment.kind === 'speech').map((segment) => segment.text),
          shots: plan.shots,
          voices: plan.segments.filter((segment) => segment.kind === 'speech').map((segment) => segment.voice?.file ?? null),
          bgm: plan.bgm?.id ?? null,
          spec: plan.spec,
        })));
        appendAudit({ home, tool, project: root, params: { planset: String(planset.id ?? ''), made: made.length }, clipId: null, at: now() });
        return answer({
          ok: true, tool, project: root,
          planset: String(planset.id ?? ''),
          made,
          expand: report,
          dedupe: { verdict: similar.verdict, duplicates: similar.duplicates, risky: similar.risky.slice(0, 20), canRender: similar.canRender },
          verdict: `${made.length} 条已生成（可拍 ${made.filter((entry) => entry.canFilm).length} 条）；${similar.verdict}`,
        });
      } catch (error) {
        return answer({ ok: false, code: error?.code ?? 'plan-expand-failed', tool, message: String(error?.message ?? error) }, { isError: true });
      }
    },

    /**
     * 出片：启动一个 Fission 批次并**立刻返回 batchId**（渲染在后台继续），带同一个 batchId 再问就是进度。
     *
     * 为什么不同步等：一批 100 条要几分钟，同步等会被 tools/call 的超时打断，而批次的进度是落文件的，
     * 所以"启动—轮询"比"一次等到完"更稳，也和界面用的是同一份状态（人能看，agent 也能看）。
     */
    async 'plan.render'(args, tool) {
      const root = projectOf(args, cwd);
      if (!root) return refused(tool, 'project-required', 'No project folder with a film.html was found.');
      const action = args?.action === 'status' || args?.action === 'retry' ? args.action : 'start';
      try {
        const jobs = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/studio/server/fission-batch-jobs.mjs')).href);
        const store = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/plan-store.mjs')).href);

        if (action === 'status') {
          const batch = jobs.readBatch(root, String(args?.batchId ?? ''));
          if (!batch) return badArguments(tool, 'no such batch');
          return answer({ ok: true, tool, project: root, batch, progress: jobs.batchProgress(batch) });
        }

        const gate = readWriteGate({ home, project: root, ...(deps.read ? { read: deps.read } : {}) });
        if (!gate.allowed) return refused(tool, gate.code, 'Rendering writes video into the project.', { gate: gate.file });

        const ids = Array.isArray(args?.planIds) && args.planIds.length
          ? args.planIds.map(String)
          : store.listPlans(root).map((entry) => entry.id);
        const plans = ids.map((id) => store.readPlan(root, id)).filter(Boolean);
        if (!plans.length) return badArguments(tool, '这个工程里还没有计划');
        const concurrency = Math.min(4, Math.max(1, Math.trunc(Number(args?.concurrency ?? 2))));

        /* 渲染前的闸门排在最前面：它不需要 ffmpeg、不需要引擎配置，纯粹看计划本身。
           放在引擎检查之后就变成"配置不全时连重复都报不出来"，而重复是要改内容的事。 */
        if (action === 'start' && args?.force !== true) {
          const dedupe = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/dedupe-check.mjs')).href);
          const precheck = dedupe.planSimilarity(plans.map((plan) => ({
            id: plan.id,
            lines: plan.segments.filter((segment) => segment.kind === 'speech').map((segment) => segment.text),
            shots: plan.shots,
            voices: plan.segments.filter((segment) => segment.kind === 'speech').map((segment) => segment.voice?.file ?? null),
            bgm: plan.bgm?.id ?? null,
            spec: plan.spec,
          })));
          if (!precheck.canRender) {
            return answer({
              ok: false, code: 'duplicate-plans', tool,
              message: precheck.verdict,
              duplicates: precheck.duplicates,
              risky: precheck.risky.slice(0, 20),
              hint: '改掉重复的那几条（文案 / 素材 / 裁切点 / 配音），或者显式传 force: true',
            }, { isError: true });
          }
        }

        const engine = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/studio/server/fission-engine-paths.mjs')).href);
        const dataDir = String(process.env.OPENFILM_DATA_DIR ?? '').trim() || home;
        const resolved = engine.resolveEnginePaths({ dataDir, project: root });
        if (!resolved.ok) {
          return answer({ ok: false, code: 'engine-paths', tool, problems: resolved.problems,
            message: `渲染器还差配置：${resolved.problems.slice(0, 2).join('；')}` }, { isError: true });
        }

        if (action === 'retry') {
          const retried = jobs.retryBatch({
            project: root, batchId: String(args?.batchId ?? ''), plans,
            enginePaths: resolved.paths, assetsRoot: resolved.paths.AssetsRoot, workRoot: resolved.paths.WorkRoot, concurrency,
          });
          return answer({ ok: true, tool, project: root, batchId: retried.batch.id, retried: retried.retried,
            progress: jobs.batchProgress(retried.batch) });
        }

        /* 渲染前的闸门：输入完全相同的两条必然出同一份字节。花两小时渲完再发现重复，纯浪费 ——
           所以在这里拦下，除非调用方明确 force。 */
        const dedupe = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/dedupe-check.mjs')).href);
        const precheck = dedupe.planSimilarity(plans.map((plan) => ({
          id: plan.id,
          lines: plan.segments.filter((segment) => segment.kind === 'speech').map((segment) => segment.text),
          shots: plan.shots,
          voices: plan.segments.filter((segment) => segment.kind === 'speech').map((segment) => segment.voice?.file ?? null),
          bgm: plan.bgm?.id ?? null,
          spec: plan.spec,
        })));
        if (!precheck.canRender && args?.force !== true) {
          return answer({
            ok: false, code: 'duplicate-plans', tool,
            message: precheck.verdict,
            duplicates: precheck.duplicates,
            risky: precheck.risky.slice(0, 20),
            hint: '改掉重复的那几条（文案/素材/配音/裁切点），或者显式传 force: true',
          }, { isError: true });
        }

        const { batch } = jobs.startBatch({
          project: root, plans, enginePaths: resolved.paths,
          assetsRoot: resolved.paths.AssetsRoot, workRoot: resolved.paths.WorkRoot, concurrency,
        });
        appendAudit({ home, tool, project: root, params: { batchId: batch.id, plans: plans.length }, clipId: null, at: now() });
        return answer({ ok: true, tool, project: root, batchId: batch.id, plans: plans.length,
          progress: jobs.batchProgress(batch), outDir: batch.outDir,
          precheck: { verdict: precheck.verdict, duplicates: precheck.duplicates.length, risky: precheck.risky.slice(0, 10) } });
      } catch (error) {
        return answer({ ok: false, code: error?.code ?? 'plan-render-failed', tool, message: String(error?.message ?? error) }, { isError: true });
      }
    },

    /** 自查：把工程里的计划两两比一遍（文本 / 节奏 / 素材 / BGM），指出过近的条对。 */
    async 'dedupe.check'(args, tool) {
      const root = projectOf(args, cwd);
      if (!root) return refused(tool, 'project-required', 'No project folder with a film.html was found.');
      try {
        const store = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/plan-store.mjs')).href);
        const dedupe = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/dedupe-check.mjs')).href);
        const ids = Array.isArray(args?.planIds) && args.planIds.length
          ? args.planIds.map(String)
          : store.listPlans(root).map((entry) => entry.id);
        const plans = ids.map((id) => store.readPlan(root, id)).filter(Boolean);
        if (plans.length < 2) return badArguments(tool, '至少需要两份计划才能比较');
        const report = dedupe.planSimilarity(
          plans.map((plan) => ({
            id: plan.id,
            lines: plan.segments.filter((segment) => segment.kind === 'speech').map((segment) => segment.text),
            shots: plan.shots,
            voices: plan.segments.filter((segment) => segment.kind === 'speech').map((segment) => segment.voice?.file ?? null),
            bgm: plan.bgm?.id ?? null,
            spec: plan.spec,
          })),
          {
            ...(Number.isFinite(args?.textMax) ? { textMax: Number(args.textMax) } : {}),
            ...(Number.isFinite(args?.sequenceMax) ? { sequenceMax: Number(args.sequenceMax) } : {}),
            ...(Number.isFinite(args?.framesMax) ? { framesMax: Number(args.framesMax) } : {}),
          },
        );
        return answer({ ok: true, tool, project: root, plans: plans.length, ...report });
      } catch (error) {
        return answer({ ok: false, code: error?.code ?? 'dedupe-check-failed', tool, message: String(error?.message ?? error) }, { isError: true });
      }
    },


    async 'library.search'(args) {
      const kind = typeof args?.kind === 'string' && args.kind.trim() ? args.kind.trim() : 'music';
      if (typeof args?.query !== 'string' || !args.query.trim()) return badArguments('library.search', 'query is required');
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(20, Math.trunc(Number(args.limit)))) : 8;
      try {
        const module_ = await import(pathToFileURL(join(editorModulesDir(), 'packages/openfilm/src/library-search.mjs')).href);
        if (!Object.values(module_.KINDS).includes(kind)) {
          return badArguments('library.search', `kind is one of ${Object.values(module_.KINDS).join(', ')}`);
        }
        const { found, worded } = await module_.searchLibrary(kind, args.query.trim(), { limit });
        return answer({
          ok: true, tool: 'library.search', kind, query: args.query.trim(), worded,
          count: found.length,
          items: found.map((row) => ({
            id: row.item.id,
            name: row.item.name?.en ?? row.item.id,
            nameZh: row.item.name?.['zh-CN'] ?? '',
            cat: row.item.cat,
            tags: row.tags,
            durationSec: row.item.durationSec ?? row.item.duration ?? null,
            energy: row.item.energy ?? null,
            bpm: row.item.bpm ?? null,
            named: row.named === true,
            score: Number(row.score ?? 0),
          })),
        });
      } catch (error) {
        return answer({ ok: false, code: error?.code ?? 'library-search-failed', tool: 'library.search', message: String(error?.message ?? error) }, { isError: true });
      }
    },

    /* The three read-only material tools: no write — `material.search` asks the account's own documents (and this
       computer's availability), the other two read the landed index.json the editor's material views read too. */
    async 'material.search'(args) {
      if (typeof args?.query !== 'string' || !args.query.trim()) return badArguments('material.search', 'query is required');
      return materialCall('material.search', args, await materialSearch());
    },

    async 'material.collections'(args) {
      return materialCall('material.collections', args);
    },

    async 'material.items'(args) {
      return materialCall('material.items', args);
    },

    async 'materials.search'(args) {
      if (typeof args?.query !== 'string' || !args.query.trim()) return badArguments('materials.search', 'query is required');
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(50, Math.trunc(args.limit))) : 20;
      return cloud('materials.search', 'search', { ...args, query: args.query.trim(), limit });
    },

    async 'materials.take'(args, tool) {
      if (typeof args?.videoId !== 'string' || !args.videoId.trim()) return badArguments(tool, 'videoId is required');
      const root = projectOf(args, cwd);
      if (!root) return refused(tool, 'project-required', 'No project folder with a film.html was found.');
      const gate = readWriteGate({ home, project: root, ...(deps.read ? { read: deps.read } : {}) });
      if (!gate.allowed) return refused(tool, gate.code, 'Taking a material writes into the project, which needs write permission.', { gate: gate.file });
      const videoId = args.videoId.trim();
      let placed = null;
      try {
        if (typeof deps.takeMaterial === 'function') {
          /* the host's own source of bytes (a cloud fetch, or the test's fixture) */
          const taken = await deps.takeMaterial(videoId, root);
          if (taken?.placed) placed = taken.placed;
          else if (taken?.source) {
            const { importFile } = await import('../../../packages/openfilm/studio/server/files.mjs');
            const { createReadStream } = await import('node:fs');
            const name = taken.name ?? basename(taken.source);
            const imported = await importFile(root, 'assets/' + name, createReadStream(taken.source));
            placed = imported.path;
          }
        } else {
          /* 云端 videoId：先经 Studio 的 raw 落到本地，再 bring 进项目 assets；Saved 路径仍走 takeSaved。 */
          if (!videoId.startsWith('saved/')) {
            try {
              /* the MCP child's home is the person's, not Studio's; run.json in the app's dev home names the Studio. */
              const run = JSON.parse(readFileSync(join(home, '.openfilm-dev', 'run.json'), 'utf8'));
              const studio = run?.origin && run?.key ? run : null;
              if (studio) {
                const headers = { 'content-type': 'application/json', 'x-studio-key': studio.key, origin: studio.origin };
                const raw = await fetch(`${studio.origin}/api/materials/raw`, { method: 'POST', headers, body: JSON.stringify({ videoId }) }).then((r) => r.json());
                if (raw?.path) {
                  const projects = await fetch(`${studio.origin}/api/projects`, { headers }).then((r) => r.json());
                  const project = (projects.projects ?? []).find((p) => resolve(p.path).toLowerCase() === resolve(root).toLowerCase());
                  if (project?.id) {
                    const brought = await fetch(`${studio.origin}/api/projects/${encodeURIComponent(project.id)}/files/bring`, {
                      method: 'POST', headers, body: JSON.stringify({ paths: [raw.path], into: 'assets/materials', mode: 'copy' }),
                    }).then((r) => r.json());
                    const landed = Array.isArray(brought?.landed) ? brought.landed[0] : brought?.landed;
                    if (typeof landed === 'string') placed = landed;
                  }
                }
              }
            } catch { /* fall through to Saved */ }
          }
          if (!placed) {
            /* the editor's own path: an item of this project's Saved library, taken as Studio takes it */
            const { takeSaved } = await import('../../../packages/openfilm/studio/server/saved.mjs');
            const taken = await takeSaved(root, videoId);
            if (taken && typeof taken.path === 'string') placed = taken.path;
            else if (taken && taken.clip && typeof taken.clip.src === 'string') placed = taken.clip.src;
          }
        }
      } catch (error) {
        if (error?.code === 'not-configured') return notConfigured(tool, 'Taking this material');
        return answer({ ok: false, code: error?.code ?? 'take-failed', tool, message: String(error?.message ?? error) }, { isError: true });
      }
      if (!placed) return notConfigured(tool, 'Taking a cloud material (its raw file is not available on this machine)');
      const { clipTag } = await editor();
      appendAudit({ home, tool, project: root, params: 'videoId=' + videoId + ',src=' + placed, clipId: basename(placed), at: now() });
      return answer({ ok: true, tool, path: placed, assetPath: placed, clipTag: clipTag({ src: placed }) });
    },

    async 'wiki.video'(args) {
      if (typeof args?.videoId !== 'string') return badArguments('wiki.video', 'videoId is required');
      return cloud('wiki.video', 'wikiVideo', { videoId: args.videoId, ...(args.range ? { range: args.range } : {}) });
    },
    async 'wiki.timeline'(args) {
      if (typeof args?.videoId !== 'string') return badArguments('wiki.timeline', 'videoId is required');
      return cloud('wiki.timeline', 'wikiTimeline', { videoId: args.videoId, ...(args.range ? { range: args.range } : {}) });
    },
    async 'wiki.shot'(args) {
      if (typeof args?.videoId !== 'string' || !Number.isFinite(args?.index)) return badArguments('wiki.shot', 'videoId and index are required');
      return cloud('wiki.shot', 'wikiShot', { videoId: args.videoId, index: args.index });
    },

    async 'timeline.insert_clip'(args, tool) {
      if (typeof args?.src !== 'string' || !args.src.trim()) return badArguments(tool, 'src is required');
      const root = projectOf(args, cwd);
      if (!root) return refused(tool, 'project-required', 'No project folder with a film.html was found.');
      /* the gate comes before a single byte is read: an unauthorized agent learns nothing but the refusal */
      const gate = readWriteGate({ home, project: root, ...(deps.read ? { read: deps.read } : {}) });
      if (!gate.allowed) return refused(tool, gate.code, 'Writing needs permission: ~/.openfilm-dev/mcp-write.json must list this project.', { gate: gate.file });
      const file = join(root, 'film.html');
      const text = readFileSync(file, 'utf8');
      const { readFilmFile, filmHtml, applyOps } = await editor();
      const read = readFilmFile(text);
      if (!read?.doc) {
        /* an unreadable film is said, not thrown: the agent can fix the file and try again */
        return answer({ ok: false, code: 'invalid-film', tool, message: 'film.html cannot be read as a film.', problems: read?.problems ?? [] }, { isError: true });
      }
      const insert = { op: 'insert', clip: clipOf(args), ...(Number.isFinite(args.track) ? { track: args.track } : {}) };
      const next = applyOps(read.doc, [insert]);
      const html = filmHtml(next, text);
      write(file, html);
      const clipId = next.tracks.flatMap((track) => track.clips).at(-1)?.id ?? null;
      appendAudit({ home, tool, project: root, params: auditParams(tool, args), clipId, at: now() });
      return answer({ ok: true, tool, project: root, clipId, at: insert.clip.at ?? null, track: args.track ?? 0 });
    },

    async 'openfilm.look'(args, tool) {
      if (typeof deps.look !== 'function') return notConfigured(tool, 'Drawing a look');
      const root = projectOf(args, cwd);
      if (!root) return refused(tool, 'project-required', 'No project folder with a film.html was found.');
      try {
        const drawn = await deps.look({ ...(args ?? {}), project: root });
        return answer({ ok: true, tool, path: drawn.path });
      } catch (error) {
        if (error?.code === 'not-configured') return notConfigured(tool, 'Drawing a look');
        return answer({ ok: false, code: error?.code ?? 'look-failed', tool, message: String(error?.message ?? error) }, { isError: true });
      }
    },
  };

  /**
   * One JSON-RPC message in, one response out (`null` for a notification, which has no id).
   * A tool that throws is reported as a tool error; the server itself never falls over.
   */
  async function handle(message) {
    if (!message || typeof message !== 'object') return rpcError(null, -32700, 'parse error');
    const { id, method, params } = message;
    const notification = id === undefined || id === null;
    if (method === 'initialize') {
      return notification ? null : {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      };
    }
    if (method === 'notifications/initialized' || method === 'initialized') return null;
    if (method === 'ping') return notification ? null : { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return notification ? null : { jsonrpc: '2.0', id, result: { tools: await listedTools() } };
    if (method === 'tools/call') {
      if (notification) return null;
      const name = params?.name;
      /* a call is answered only for a name this surface carries, and only when there is a handler behind it:
         an unlisted tool is not a quieter back door */
      if (!surfaceNames.includes(name) || typeof handlers[name] !== 'function') {
        return rpcError(id, -32602, 'unknown tool: ' + String(name));
      }
      const args = params?.arguments ?? {};
      const started = Date.now();
      try {
        const result = await handlers[name](args, name);
        log(toolCallLine(name, Date.now() - started, result));
        return { jsonrpc: '2.0', id, result };
      } catch (error) {
        /* a tool that throws is a said error, not a dead server */
        const failure = answer({ ok: false, code: 'tool-failed', tool: name, message: String(error?.message ?? error) }, { isError: true });
        log(toolCallLine(name, Date.now() - started, failure));
        return { jsonrpc: '2.0', id, result: failure };
      }
    }
    return notification ? null : rpcError(id, -32601, 'method not found: ' + String(method));
  }

  return { handle, tools: TOOL_DEFINITIONS, surface, surfaceNames, listedTools };
}

/** One line per tool call: what ran, how long it took, what came back — never a whole path, never a key. */
export function toolCallLine(tool, ms, result) {
  const body = result?.structuredContent ?? {};
  const fields = { tool, ms };
  if (typeof body.count === 'number') fields.hits = body.count;
  else if (Array.isArray(body.hits)) fields.hits = body.hits.length;
  if (typeof body.path === 'string') fields.path = basename(body.path);
  if (typeof body.clipId === 'string') fields.clipId = body.clipId;
  if (typeof body.code === 'string') fields.code = body.code;
  if (typeof body.uploaded === 'boolean') fields.uploaded = body.uploaded;
  /* the index tools answer counts, not hits: one number per name, never a row */
  if (typeof body?.totals?.videos === 'number') fields.videos = body.totals.videos;
  if (Array.isArray(body?.batches)) fields.batches = body.batches.length;
  if (Array.isArray(body?.collections)) fields.collections = body.collections.length;
  if (Array.isArray(body?.items)) fields.items = body.items.length;
  /* which of the search's three routes answered (vector / lexical / index) — the one word a search log needs */
  if (typeof body.mode === 'string') fields.mode = body.mode;
  return JSON.stringify(fields);
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Serve the server on stdio, one JSON-RPC message per line (MCP's stdio transport). `start` returns at once and
 * never rejects: a transport that cannot be read is a server that exits quietly, never a startup error.
 * @param {{handle: (message: unknown) => Promise<unknown>, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, log?: (line: string) => void}} options
 */
export function serveStdio({ handle, input = process.stdin, output = process.stdout, log = () => {} }) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const send = (message) => {
    if (!message) return;
    try {
      output.write(JSON.stringify(message) + '\n');
    } catch (error) {
      log('write failed: ' + String(error?.message ?? error));
    }
  };
  let queue = Promise.resolve();
  const answerInOrder = (message) => {
    /* one message at a time: a parse error and an answer must not overtake each other */
    queue = queue.then(() => handle(message)).then(send, (error) => send(rpcError(message?.id ?? null, -32603, String(error?.message ?? error))));
    return queue;
  };
  lines.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      answerInOrder(null);
      return;
    }
    answerInOrder(message);
  });
  return { close: () => lines.close() };
}

/**
 * The config the window hands an agent (ACP `mcpServers`): an absolute command, this file as the argument, and the
 * one variable that makes an Electron binary behave as Node. `env` is the `[{name, value}]` shape ACP expects.
 * @param {{command: string, script?: string, nodeArgs?: readonly string[]}} options
 */
export function openfilmMcpServerConfig({ command, script = fileURLToPath(import.meta.url), nodeArgs = [] }) {
  if (!isAbsolute(String(command))) throw new Error('The MCP server needs an absolute command: ' + String(command));
  if (!isAbsolute(String(script))) throw new Error('The MCP server needs an absolute script: ' + String(script));
  return {
    name: SERVER_NAME,
    command: String(command),
    args: [...nodeArgs, String(script)],
    env: [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      /* the material tenant lives in the app's account store; the MCP child searches the same company library. */
      ...(typeof process.env.OPENFILM_MEDIA_TENANT === 'string' && process.env.OPENFILM_MEDIA_TENANT.trim()
        ? [{ name: 'OPENFILM_MEDIA_TENANT', value: process.env.OPENFILM_MEDIA_TENANT.trim() }] : []),
    ],
  };
}

/** A fingerprint of a project path, for logs that must not print the whole path. */
export const projectFingerprint = (project) => createHash('sha256').update(resolve(project), 'utf8').digest('hex').slice(0, 8);

/* Run as a program: stdio, and nothing that can throw out of the startup. The agent client treats a startup error
   as a dead session, so an unreadable transport is the only thing that may end this process. */
const isEntryPoint = (() => {
  try {
    const entry = process.argv[1];
    return typeof entry === 'string' && resolve(entry).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  try {
    /* the agent the window starts is offered the budgeted surface: the three index tools beside the two write verbs,
       which is also `DEFAULT_SURFACE` — the variable only has to name another one to move; anything it names that is
       not a surface is ignored, never a way to list nothing. `OPENFILM_MCP_SURFACE=compat` is the way back to the seven
       names this file used to list. */
    serveStdio({
      handle: createOpenFilmMcpServer({ surface: process.env.OPENFILM_MCP_SURFACE }).handle,
      log: (line) => {
        try {
          process.stderr.write(line + '\n');
        } catch {
          /* nothing to report it to */
        }
      },
    });
  } catch (error) {
    try {
      process.stderr.write('openfilm mcp: could not start: ' + String(error?.message ?? error) + '\n');
    } catch {
      /* nothing to report it to */
    }
    process.exitCode = 0;
  }
}