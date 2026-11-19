// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 素材清洗：索引里的一行脏数据 → 一行能上云的规范行。
 *
 * 78 874 条云素材里，只有 390 条名字真的按 `日期-产品-分组 (n)` 写；其余 78 484 条是多层派生出来的
 * （见 `material-index.mjs` 的 derived 层）。真正要清洗的不是"哪条属于哪个批次"，而是**同一份素材被写成了几行**、
 * **一行里的名字带着什么噪声**、**哪些行连自己是素材都证不出来**：
 *
 *  - `130113153 | 20261109-油弃乌龙茶-外包装 (24) | md5: ''` —— 空 md5，无从判断是不是同一份字节；
 *  - `26253171 | 12月18日 3  茶含片（小尹) 汪学蕊` —— 双空格、括号只有左半、人名列尾；
 *  - `素材-王鑫-3.18但哥茶膏_2` —— 没有批次形状，尾部一个 `_2`。
 *
 * 所以这一层只做四件**纯函数**的事，每件都能单独测、且不改数据本身：
 *
 *  1. `normalizeName` —— 把名字里与"这份素材是什么"无关的东西拿掉（全角、重复空白、不配对括号、序号尾巴、
 *     孤立的姓名段），并把每一步改动记成 issue；
 *  2. `splitIdentity` —— 决定**内容身份**：md5 非空时以 md5 为准（字节相同就是同一条），为空时退回 videoId。
 *     这是"去重"唯一的依据——名字再像也不是身份，`IMG_2525` 和 `IMG_2526` 就是两条；
 *  3. `classifyEntry` —— 这一行到底是什么：素材（进检索）/ 字幕 / 文本 / 未知（证不出来）；
 *  4. `cleanEntry` —— 把上面三件合起来，输出规范行 + `issues[]`（修了什么，一条不落）。
 *
 * 不变式（测试里钉死）：
 *  - 纯函数：不读文件、不取时钟、不随机；同一个 entry 永远给同一行；
 *  - `issues` 只在真的改了东西时出现（"没改"不产生 issue）；
 *  - 名字清洗**永不产生空 name**：剥到只剩标点就整段放弃并记 `name-kept`。
 */
import {
  categoryName,
  classifyUnparsedName,
  DERIVED_GROUP_WORDS,
  durationMsOf,
  labelNames,
  md5Of,
  parseMaterialName,
} from './material-index.mjs';
import { docLabels, mediaDocId } from './material-doc.mjs';

/* ── 字符层：全角 → 半角、空白折叠 ─────────────────────────────────────────────────────────────────────────────── */

/** 全角 ASCII（U+FF01–U+FF5E，含全角括号 `（）`）：减 `0xFEE0` 就是半角同位字符。 */
const FULLWIDTH = /[\uFF01-\uFF5E]/g;
/** 全角空格与各种窄空格：都是"一个间隔"，不是一个字符。 */
const WIDE_SPACE = /[\u3000\u00A0\u2000-\u200A\u202F\u205F]/g;

/**
 * 全角 ASCII → 半角。`（大翔A款` → `(大翔A款`。U+FF01–FF5E 这一段里既有拉丁标点也有中文常用的全角标点
 * （`，`→`,`、`！`→`!`、`？`→`?`），它们都是**分隔符**，统一成半角对检索只有好处；不在这段里的 `、`、`。`、
 * `「」`、`《》` 属于文字本身，一个都不动。
 * @param {string} text
 */
export function toHalfWidth(text) {
  return String(text ?? '').replace(FULLWIDTH, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0)).replace(WIDE_SPACE, ' ');
}

/* ── 名字层：括号配对修复、序号尾巴、姓名段 ───────────────────────────────────────────────────────────────────── */

/** 尾部序号：供应商自己的相册位置 ` (46)`（全角括号已在半角化时处理掉）。 */
const SEQUENCE_PAREN = /\s*\(\s*\d{1,4}\s*\)$/;
/** 尾部派生序号：`_3`、`_12`（`material-index.mjs` 的 `SEQUENCE_TAIL`）。 */
const SEQUENCE_UNDERLINE = /_\d{1,4}$/;
/**
 * 采集原名：`IMG_2525`、`VID_0007`、`mmexport1699…`、`微信图片_2025…`。这些名字里的 `_2525` 是**相机序号，
 * 就是它的身份**——剥掉 `IMG_2525` 会变成 `IMG`，923 行一起塌成一条，比不清洗更糟。所以这类名字不剥 `_n`。
 */
const CAPTURE_PREFIX = /^(IMG|VID|DSC|DSCF|PXL|DJI|GOPR|mmexport|微信图片|WechatIMG|Screenshot)[_\-.\s]?[\d_\-.\s]/i;

/**
 * 名字末尾不能当人名剥掉的段：分组词表（`material-index.mjs` 的 `DERIVED_GROUP_WORDS`）加上这个账户名字里
 * 当"状态/版本"用的词。`汤色` 尤其重要——首字 `汤` 在百家姓里，没有这张表就会被当成人名剥掉。
 */
const KEEP_TAIL = new Set([
  ...DERIVED_GROUP_WORDS,
  '素材', '合集', '子合集', '样片', '成片', '大货', '模板', '初版', '终版', '改版', '副本', '原图',
  '原片', '实拍', '出图', '特写', '空镜', '备用', '补拍', '重拍', '待定', '未剪', '粗剪', '精剪',
]);

/** 百家姓前 100（`百家姓` 顺序的常用段）。判"这一小段是不是人名列尾"只用它，不用猜。 */
const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤';

const CJK = /[\u4e00-\u9fa5]/;
const TAIL_CANDIDATE = /^[\u4e00-\u9fa5]{2,3}$/;

/**
 * 括号配对修复：缺右括号就补在末尾，多出来的右括号就地删掉。只修**数量**，不搬内容——`5月29日油弃乌龙茶1（隆`
 * 补成 `5月29日油弃乌龙茶1(隆)`，段里一个字都不动。判定用一次深度扫描：深度为 0 时遇到的 `)` 就是多余的。
 * @param {string} text 已半角化
 * @returns {{ text: string, repaired: boolean }}
 */
function repairParens(text) {
  const opens = (text.match(/\(/g) ?? []).length;
  const closes = (text.match(/\)/g) ?? []).length;
  if (opens === closes) return { text, repaired: false };
  let depth = 0;
  let out = '';
  for (const char of text) {
    if (char === '(') { depth += 1; out += char; continue; }
    if (char === ')') {
      if (depth === 0) continue; // 多出来的右括号
      depth -= 1;
      out += char;
      continue;
    }
    out += char;
  }
  if (depth > 0) out += ')'.repeat(depth);
  return { text: out, repaired: true };
}

/**
 * 名字末尾的孤立姓名段怎么判：**剥，还是不剥**。
 *
 * 剥（`strip: true`）当且仅当下面全部成立：
 *  1. 末尾有一段，用**单个空格**与前文分开；
 *  2. 这一段是 2–3 个汉字、不含数字/字母；
 *  3. 这一段不在 `KEEP_TAIL`（分组词、状态词）里；
 *  4. 剥掉之后前文非空，且前文含汉字或数字（名前只有分隔符就说明名字全靠这一段承载，不剥）；
 *  5. 并且满足其一：这一段**等于该行的 `author`**（供应商自己说的作者，最硬的证据，记 `trailing-author`），
 *     或者这一段的首字在百家姓里（记 `trailing-name`）。
 *
 * 保留（`strip: false`）时把原因也说出来，方便复核：`no-space` / `keep-word` / `not-a-name` / `tail-is-all`。
 * @param {string} name 已归一化的名字
 * @param {string} [author] 该行的 `author`
 * @returns {{ strip: boolean, tail: string, rest: string, reason: string }}
 */
export function trailingNameRule(name, author = '') {
  const text = String(name ?? '').trim();
  const at = text.lastIndexOf(' ');
  if (at <= 0) return { strip: false, tail: '', rest: text, reason: 'no-space' };
  const tail = text.slice(at + 1).trim();
  const rest = text.slice(0, at).trim();
  if (KEEP_TAIL.has(tail)) return { strip: false, tail, rest, reason: 'keep-word' };
  if (!TAIL_CANDIDATE.test(tail)) return { strip: false, tail, rest, reason: 'not-a-name' };
  if (!rest || !(CJK.test(rest) || /\d/.test(rest))) return { strip: false, tail, rest, reason: 'tail-is-all' };
  if (String(author ?? '').trim() === tail) return { strip: true, tail, rest, reason: 'trailing-author' };
  if (SURNAMES.includes(tail[0])) return { strip: true, tail, rest, reason: 'trailing-name' };
  return { strip: false, tail, rest, reason: 'not-a-name' };
}

/**
 * 清洗一个名字，并说清每一步改了什么。
 * @param {unknown} text 原始名字
 * @param {{ stripUnderline?: boolean }} [options] `stripUnderline: false` 只剥 ` (n)`、不剥 `_n`
 *   （"同文"统计用这一档：`_n` 是派生序号的猜测，剥它会多塌 15 846 行，不该拿它算重复）
 * @returns {{ name: string, shapeName: string, issues: string[] }} `name` 是能上云的名字；`shapeName` 是**序号还在、
 *   括号已修**的中间态——形状解析（`parseMaterialName` 要 ` (n)`）只能用它，否则全角括号写的序号会被当成没有形状。
 */
export function normalizeNameDetailed(text, options = {}) {
  const { stripUnderline = true } = options;
  const raw = typeof text === 'string' ? text : '';
  const issues = [];
  let name = raw.replace(/\s+/gu, ' ').trim();
  const half = toHalfWidth(name).replace(/\s+/gu, ' ').trim();
  if (half !== name) issues.push('fullwidth');
  if (name !== raw) issues.push('whitespace');
  name = half;
  const parens = repairParens(name);
  if (parens.repaired) issues.push('unbalanced-paren');
  name = parens.text.replace(/\s+/gu, ' ').trim();
  const shapeName = name;
  const beforeSequence = name;
  name = name.replace(SEQUENCE_PAREN, '').trim();
  if (name !== beforeSequence) issues.push('trailing-sequence');
  if (stripUnderline && SEQUENCE_UNDERLINE.test(name) && !CAPTURE_PREFIX.test(name)) {
    const cut = name.replace(SEQUENCE_UNDERLINE, '').trim();
    if (cut) { name = cut; issues.push('trailing-underline'); }
  }
  /* 剥完只剩标点就退回上一步：空名字是清洗的失败，不是清洗的结果。 */
  if (!name.replace(/[\s\-_/.,:;、，。（）()]+/gu, '')) {
    name = half;
    issues.push('name-kept');
  }
  return { name, shapeName, issues };
}

/**
 * `normalizeName(text)` —— 规范名字本身。派生过一次失败（剥成空）时不返回空串，而是退回到半角化后的原名。
 * @param {unknown} text
 * @param {{ stripUnderline?: boolean }} [options]
 * @returns {string}
 */
export function normalizeName(text, options = {}) {
  return normalizeNameDetailed(text, options).name;
}

/**
 * "这一行的名字本身说了什么"的去重键：折叠空白 + 全角半角 + 括号配对 + 去尾部 ` (n)`，**不含** `_n` 与姓名段。
 * 用它数"同文重复"（62 172 条不同的名字 / 78 874 行，见报告 §A）。
 * @param {unknown} text
 */
export function nameTextKey(text) {
  return normalizeName(text, { stripUnderline: false });
}

/* ── 身份层：内容身份（md5 优先）、media_key ───────────────────────────────────────────────────────────────────── */

/**
 * 一行的身份。
 *
 * - `mediaKey` —— 本机/云上同一个 key（`mediaDocId`：`asset:<videoId>`，没有 id 时退回 `asset:md5:…`，再退回名字）；
 * - `contentKey` —— **内容**身份，去重只看它：`md5` 非空就是 `md5:<digest>`（字节相同即同一份），为空才是
 *   `vid:<videoId>`。空 md5 的行与有 md5 的行永远不在同一组——它们只是"可能与别人相同"，不是"已确认相同"；
 * - `dupGroup` —— 只有当同一个 `contentKey` 在这一批里出现 ≥2 次时才给出该 key，否则 `null`。计数要由调用方
 *   用 `contentCounts()` 先算好传进来；不传就等于"只有这一行"。
 *
 * @param {{ videoId?: unknown, mediaKey?: unknown, name?: unknown, md5?: unknown, rawMd5?: unknown }} entry
 * @param {Map<string, number> | Record<string, number> | null} [counts] `contentKey → 行数`
 */
export function splitIdentity(entry, counts = null) {
  const videoId = typeof entry?.videoId === 'string' ? entry.videoId.trim() : String(entry?.videoId ?? '').trim();
  const md5 = md5Of(entry);
  const mediaKey = mediaDocId(entry);
  const nameKey = nameTextKey(entry?.name);
  const contentKey = md5 ? `md5:${md5.toLowerCase()}` : videoId ? `vid:${videoId}` : nameKey ? `name:${nameKey}` : '';
  const seen = counts === null || counts === undefined
    ? 1
    : Number(typeof /** @type {any} */ (counts).get === 'function' ? /** @type {any} */ (counts).get(contentKey) : /** @type {any} */ (counts)[contentKey]) || 1;
  return { mediaKey, videoId, md5, contentKey, dupGroup: seen > 1 ? contentKey : null };
}

/**
 * 一批 entry 的 `contentKey → 行数`。`splitIdentity` 的 `counts` 参数就是它。
 * @param {Array<any>} entries
 * @returns {Map<string, number>}
 */
export function contentCounts(entries) {
  const counts = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const { contentKey } = splitIdentity(entry);
    if (!contentKey) continue;
    counts.set(contentKey, (counts.get(contentKey) ?? 0) + 1);
  }
  return counts;
}

/* ── 类型层：这一行是不是"要检索的素材" ───────────────────────────────────────────────────────────────────────── */

/** 字幕：永不进检索（真跑素材库里一条都没有，规则留着是因为供应商的包随时可能带上）。 */
export const SUBTITLE_EXTENSIONS = Object.freeze(['.vtt', '.srt', '.ass', '.ssa', '.sub', '.lrc']);
/** 文本/文档：同样的理由。 */
export const TEXT_EXTENSIONS = Object.freeze(['.txt', '.md', '.json', '.csv', '.log', '.doc', '.docx', '.pdf', '.rtf', '.xlsx']);
/** 明确的素材扩展名：视频 / 图片 / 音频。 */
export const MATERIAL_EXTENSIONS = Object.freeze([
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.mpg', '.mpeg', '.3gp', '.ts',
  '.mp3', '.wav', '.m4a', '.aac', '.flac',
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.bmp', '.tif', '.tiff',
]);

/** 名字末尾的扩展名（只有**已知**的那几个才算，`3.18但哥茶膏` 的 `.18` 不是扩展名）。 */
function extensionOf(name) {
  const found = /(\.[A-Za-z0-9]{2,5})$/.exec(String(name ?? '').trim());
  if (!found) return '';
  const ext = found[1].toLowerCase();
  return [...SUBTITLE_EXTENSIONS, ...TEXT_EXTENSIONS, ...MATERIAL_EXTENSIONS].includes(ext) ? ext : '';
}

/** 供应商 `videoType` 只取 0–4（`MATERIAL_VIDEO_TYPES`）；别处拿到的原样字符串也认。 */
function videoTypeOf(entry) {
  const raw = entry?.videoType;
  const value = raw && typeof raw === 'object' ? raw.source ?? raw.value : raw;
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isInteger(number) && number >= 0 && number <= 4 ? number : null;
}

/**
 * 这一行是什么：`material | text | subtitle | unknown`。
 *
 * 判定顺序（先证据、后推断，任何一步都不猜）：
 *  1. 扩展名是字幕 → `subtitle`；是文本/文档 → `text`；是视频/图片/音频 → `material`；
 *  2. 没有（已知）扩展名时：`videoType` 在 0–4 之间 → `material`（供应商自己的分类就是证据）；
 *  3. 卡片上还有任一字段（时长 / 封面 / 标签 / 作者 / 一级分类）→ `material`（它是带卡片的一条素材）；
 *  4. 其余 → `unknown`：只有名字的行既没有扩展名、也没有 `videoType`、也没有卡片，**证不出**它是素材。
 *     这不是"脏"，是"缺元数据"——22 行纯数字名、11 839 行只有名字的行都在这里，报告 §D 单独统计。
 *
 * @param {{ name?: unknown, videoType?: unknown, durationMs?: unknown, coverUrl?: unknown, labels?: unknown,
 *   author?: unknown, oneLevel?: unknown }} entry
 * @returns {{ kind: 'material' | 'text' | 'subtitle' | 'unknown', evidence: string }}
 */
export function classifyEntry(entry) {
  const ext = extensionOf(entry?.name);
  if (SUBTITLE_EXTENSIONS.includes(ext)) return { kind: 'subtitle', evidence: `ext:${ext}` };
  if (TEXT_EXTENSIONS.includes(ext)) return { kind: 'text', evidence: `ext:${ext}` };
  if (MATERIAL_EXTENSIONS.includes(ext)) return { kind: 'material', evidence: `ext:${ext}` };
  const videoType = videoTypeOf(entry);
  if (videoType !== null) return { kind: 'material', evidence: `videoType:${videoType}` };
  const hasDuration = typeof durationMsOf(entry) === 'number' && Number(durationMsOf(entry)) > 0;
  const hasCard = hasDuration
    || Boolean(String(entry?.coverUrl ?? '').trim())
    || labelNames(entry?.labels).length > 0
    || Boolean(String(entry?.author ?? '').trim())
    || Boolean(categoryName(entry?.oneLevel ?? entry?.oneLevelVideoType));
  if (hasCard) return { kind: 'material', evidence: 'card' };
  return { kind: 'unknown', evidence: 'name-only' };
}

/* ── 汇总层：一行 entry → 一行规范行 ───────────────────────────────────────────────────────────────────────────── */

/**
 * `issues` 里**真的改动了这一行**的那几个。其余（`no-md5`、`missing-card`、`dup-md5`、`batch-derived`、
 * `no-shape`、`kind-*`）是**诊断**：它们说的是这一行长什么样，不是修了什么。报告要分开算——
 * 78 874 行里 71 686 行没有 issue 是不可能的（7 188 行本来就没有 md5），把诊断算进"修复"等于什么也没说。
 */
export const NAME_REPAIR_ISSUES = Object.freeze([
  'fullwidth', 'whitespace', 'unbalanced-paren', 'trailing-sequence', 'trailing-underline',
  'trailing-author', 'trailing-name', 'labels-normalized', 'name-kept',
]);

/** 这一行被"改"过吗（只有 `NAME_REPAIR_ISSUES` 算改）。 */
export function isRepaired(row) {
  return (row?.issues ?? []).some((issue) => NAME_REPAIR_ISSUES.includes(issue));
}

/**
 * 把一条索引 entry 清洗成规范行。
 *
 * `batch / product / group` 只从**严格形状** `日期-产品-分组 (n)`（`parseMaterialName`）里取；名字不按那个形状写的
 * 行，`product` 留空，`group` 只取 `material-index.mjs` 那份分组词表认出来的词（`derived` 层），批次取派生 token。
 * 换句话说：**猜不出来的字段就空着**，空着能统计，猜错了不能。
 *
 * `md5` / `dupGroup` 是规范行之外多带的两位：报告要数"有 md5 的比例"和"哪些行是同一份内容"，那是身份，不是正文。
 *
 * @param {any} entry 一条索引 entry（可带 `videoType`）
 * @param {Map<string, number> | Record<string, number> | null} [counts] `contentCounts()` 的结果
 * @returns {{ mediaKey: string, contentKey: string, md5: string, dupGroup: string | null, name: string, batch: string,
 *   product: string, group: string, labels: string[], durationMs: number | null, author: string, oneLevel: string,
 *   twoLevel: string, coverUrl: string, kind: 'material' | 'text' | 'subtitle' | 'unknown', issues: string[] }}
 */
export function cleanEntry(entry, counts = null) {
  const rawName = typeof entry?.name === 'string' ? entry.name : '';
  const identity = splitIdentity(entry, counts);
  const author = String(entry?.author ?? '').trim();
  const { name: normalized, shapeName, issues } = normalizeNameDetailed(rawName);
  let name = normalized;

  /* 姓名段：先按 author 认（硬证据），再按百家姓认（弱证据，规则见 trailingNameRule）。 */
  const tail = trailingNameRule(name, author);
  if (tail.strip) {
    name = tail.rest;
    issues.push(tail.reason);
  }

  /* 位置三级：严格形状优先，其次是派生层。形状用 shapeName 判——它把全角括号与配对修好了，序号还在。 */
  const parsed = parseMaterialName(shapeName);
  const derived = classifyUnparsedName(shapeName);
  const batch = parsed ? parsed.date : derived.kind === 'batch' ? derived.token : '';
  const product = parsed ? parsed.product : '';
  const group = parsed ? parsed.group : derived.kind === 'group' ? derived.word : '';
  if (!parsed && derived.kind === 'batch') issues.push('batch-derived');
  if (!parsed && derived.kind === 'group') issues.push('group-derived');
  if (!parsed && derived.kind === 'sequence') issues.push('sequence-only');
  if (!parsed && derived.kind === 'none') issues.push('no-shape');

  const labels = docLabels(entry?.labels ?? entry?.videoLabels);
  if (labels.length !== labelNames(entry?.labels ?? entry?.videoLabels).length) issues.push('labels-normalized');

  const { kind } = classifyEntry({ ...entry, name: rawName });
  if (kind !== 'material') issues.push(`kind-${kind}`);

  if (!identity.md5) issues.push('no-md5');
  if (identity.dupGroup) issues.push(identity.md5 ? 'dup-md5' : 'dup-content');
  if (!rawName.trim()) issues.push('empty-name');
  if (kind === 'unknown') issues.push('missing-card');

  return {
    mediaKey: identity.mediaKey,
    contentKey: identity.contentKey,
    md5: identity.md5,
    dupGroup: identity.dupGroup,
    name,
    batch,
    product,
    group,
    labels,
    durationMs: durationMsOf(entry),
    author,
    oneLevel: categoryName(entry?.oneLevel ?? entry?.oneLevelVideoType),
    twoLevel: categoryName(entry?.twoLevel ?? entry?.twoLevelVideoType),
    coverUrl: String(entry?.coverUrl ?? '').trim(),
    kind,
    issues,
  };
}

/**
 * 全量清洗 + 汇总。脚本（`scripts/material-clean-report.mjs`）只负责读文件、打印，数字全在这里算。
 *
 * `retrievable` 是**能上云检索的条数**：`kind === 'material'` 且 `contentKey` 不重复（同一份字节只留一行）。
 * 留哪一行：**有 md5 的优先**（有 md5 才能本机命中），其次卡片字段多的，再次 videoId 字典序小的——排序键
 * 全部确定，所以两次运行留的是同一行。
 *
 * @param {any[]} entries
 */
export function summarizeClean(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const counts = contentCounts(list);
  const rows = list.map((entry) => cleanEntry(entry, counts));

  const byKind = { material: 0, text: 0, subtitle: 0, unknown: 0 };
  const byIssue = new Map();
  let repaired = 0;
  let touched = 0;
  for (const row of rows) {
    byKind[row.kind] += 1;
    if (row.issues.length) touched += 1;
    if (isRepaired(row)) repaired += 1;
    for (const issue of row.issues) byIssue.set(issue, (byIssue.get(issue) ?? 0) + 1);
  }

  /* 去重：只在 material 里做（字幕/文本不进检索，去不去重都不影响条数），有 md5 的优先留下。 */
  const keptByKey = new Map();
  for (const row of rows) {
    if (row.kind !== 'material' || !row.contentKey) continue;
    const current = keptByKey.get(row.contentKey);
    if (!current || betterRow(row, current)) keptByKey.set(row.contentKey, row);
  }
  const dupRemoved = rows.filter((row) => row.kind === 'material' && row.contentKey).length - keptByKey.size;

  const kept = byKind.material;
  const dropped = rows.length - kept;
  const withMd5 = rows.filter((row) => row.md5).length;
  const missingCard = byIssue.get('missing-card') ?? 0;
  const emptyName = byIssue.get('empty-name') ?? 0;
  const byEvidence = new Map();
  for (const entry of list) {
    const { evidence } = classifyEntry(entry);
    const head = evidence.split(':')[0];
    byEvidence.set(head, (byEvidence.get(head) ?? 0) + 1);
  }

  /* 元数据非空率：五个卡片字段各自的非空行数，和"五个都有"的行数。缺哪个就报哪个，不合成一个模糊的分。 */
  const meta = { labels: 0, durationMs: 0, author: 0, oneLevel: 0, twoLevel: 0, coverUrl: 0 };
  let completeMeta = 0;
  for (const row of rows) {
    if (row.labels.length) meta.labels += 1;
    if (typeof row.durationMs === 'number' && row.durationMs > 0) meta.durationMs += 1;
    if (row.author) meta.author += 1;
    if (row.oneLevel) meta.oneLevel += 1;
    if (row.twoLevel) meta.twoLevel += 1;
    if (row.coverUrl) meta.coverUrl += 1;
    if (row.labels.length && row.durationMs && row.author && row.oneLevel && row.twoLevel) completeMeta += 1;
  }

  /* 同文：只折叠空白与全角、去尾部 ` (n)`，不剥 `_n`、不剥姓名段——那是"名字本身写成一样"的行数。 */
  const textKeys = new Map();
  for (const entry of list) {
    const key = nameTextKey(entry?.name);
    if (key) textKeys.set(key, (textKeys.get(key) ?? 0) + 1);
  }

  return {
    total: rows.length,
    kept,
    dropped,
    repaired,
    touched,
    dupRemoved,
    retrievable: keptByKey.size,
    byKind,
    byIssue: [...byIssue.entries()].sort((a, b) => b[1] - a[1]),
    byEvidence: [...byEvidence.entries()].sort((a, b) => b[1] - a[1]),
    dupGroups: [...counts.values()].filter((count) => count > 1).length,
    dupRows: [...counts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0),
    withMd5,
    md5Rate: rows.length ? withMd5 / rows.length : 0,
    missingCard,
    emptyName,
    meta,
    completeMeta,
    missingMeta: rows.length - completeMeta,
    distinctText: textKeys.size,
    sameTextRows: rows.length - textKeys.size,
    rows,
  };
}

/** 同一份内容的两个候选行，谁留下：md5 有 → 卡片字段多 → issues 少 → videoId 小。 */
function betterRow(a, b) {
  const score = (row) => [
    row.md5 ? 1 : 0,
    (row.coverUrl ? 1 : 0) + (row.durationMs ? 1 : 0) + (row.author ? 1 : 0) + (row.oneLevel ? 1 : 0) + row.labels.length,
    -row.issues.filter((issue) => !issue.startsWith('kind-') && !issue.startsWith('dup-')).length,
  ];
  const left = score(a);
  const right = score(b);
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return left[i] > right[i];
  return a.mediaKey < b.mediaKey;
}

/**
 * 把一个索引文档摊平成 entry 数组，形状相容两种读法：**整份** `index.json`（带 `index` 字段的构建外壳，
 * `material-index-build.mjs` 落的那个）或 `index` 本身。批次树里 parsed 的 390 条与 `unclassified` 的
 * 78 484 条都在——顺序固定（先批次树、后未分类），所以"取前 10 条样本"是可复现的。
 * @param {any} document
 * @returns {any[]}
 */
export function indexEntries(document) {
  const index = document?.index && typeof document.index === 'object' ? document.index : document;
  const out = [];
  for (const batch of index?.batches ?? []) {
    for (const product of batch?.products ?? []) {
      for (const group of product?.groups ?? []) {
        for (const entry of group?.entries ?? []) out.push(entry);
      }
    }
  }
  for (const entry of index?.unclassified ?? []) out.push(entry);
  return out;
}
