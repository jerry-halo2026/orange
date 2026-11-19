// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 改写三式：命中之后不删句子，换结构。
 *
 * 为什么不能只报"违规"：把人卡住的是"那我该怎么说"，不是"我错了"。所以每条命中都要能给出可用的候选句，
 * 而且候选句要保留原来的锚点（一个动作 + 一个可验证细节）—— 没有锚点的句子就算合规，也是空话。
 *
 * 三式（与 skills/*\/references/rewrite-modes.md 一一对应）：
 *   parallel 并列式：把"因为 A 所以 B"拆成两句并列的事实；
 *   reported 转述式：把结论交给第三方（同事 / 岳母 / 客户的疑问或评价）；
 *   scene    场景式：只描述"什么时候、在做什么"。
 *
 * 这里是**规则化**的候选生成（离线、可测）：把句子切成"动作"与"结果"两半，结果换掉、动作保留。
 * 它的价值不是替你写出好句子，而是给你三个不改锚点的起点。
 */

/** 因果连词：打断它们就打断因果。 */
const CAUSAL = /(所以|因此|于是|就|才|让|使|导致|弄得|变得)/;

/** 结果类词：命中这些说明后半句在讲身体 / 外貌 / 效果。 */
const RESULT = /(瘦|胖|轻|松|紧|白|嫩|滑|好|舒服|精神|症状|指标|血压|血糖|湿气|上火|不胀|睡得|便|痘|斑)/;

/** 时间 / 动作类开头：这部分是要保留的锚点。 */
const ANCHOR = /(早上|上午|下午|中午|晚上|睡前|饭后|饭局|上班|加班|工位|办公室|回家|开车|出差|过年|送礼|开箱|泡|冲|煮|倒|喝|拿到|拆开)/;

/**
 * 把一句话拆成"锚点（动作 / 时间 / 场景）"与"结论（效果 / 因果）"。
 * @param {string} text
 * @returns {{ anchor: string, claim: string, joined: boolean }}
 */
export function splitClaim(text) {
  const clean = String(text ?? '').replace(/\s+/g, '');
  const causal = CAUSAL.exec(clean);
  if (causal) {
    /* 因果词前如果有逗号，就在逗号处断开 —— 否则会切出喝了一个月，裤腰这种半截话 */
    const commaBefore = Math.max(clean.lastIndexOf('，', causal.index), clean.lastIndexOf(',', causal.index));
    const at = commaBefore > 0 ? commaBefore : causal.index;
    const claimStart = commaBefore > 0 ? commaBefore + 1 : causal.index + causal[0].length;
    return { anchor: clean.slice(0, at), claim: clean.slice(claimStart), joined: true };
  }
  const anchor = ANCHOR.exec(clean);
  if (anchor) {
    const at = anchor.index;
    /* 没有连词：把动作之后的部分当结论。例：下午泡一颗，裤腰松了 */
    const comma = Math.max(clean.lastIndexOf('，', clean.length), clean.lastIndexOf(',', clean.length));
    if (comma > at) return { anchor: clean.slice(0, comma), claim: clean.slice(comma + 1), joined: false };
    return { anchor: clean, claim: '', joined: false };
  }
  return { anchor: clean, claim: '', joined: false };
}

/**
 * 从一句话里找可验证细节（数字、产地、人称、具体物件）—— 锚点的另一半。
 * @param {string} text
 */
export function anchorDetail(text) {
  const clean = String(text ?? '');
  /* 中文数字也算细节：一个月、三年陈、两颗 */
  /* 数字必须带单位才算细节（一句话 里的一不算） */
  const detail = /([一二三四五六七八九十两半零\d]+[个只支片盒包]?[年月天次颗泡克斤][^，。]{0,2}|新会|云南|景谷|勐海|丈母娘|岳母|同事|客户|朋友|媳妇|我妈|外婆)/.exec(clean);
  return detail ? detail[0] : '';
}

/**
 * 生成三式候选。
 *
 * @param {string} text 原句
 * @param {{ category?: string, severity?: string }[]} [hits] 命中的规则（用来自适应措辞）
 * @param {{ detail?: string, scene?: string }} [options] 由调用方补的可验证细节 / 场景
 * @returns {{ mode: string, label: string, text: string, keepsAnchor: boolean }[]}
 */
export function rewriteSuggestions(text, hits = [], options = {}) {
  const parts = splitClaim(text);
  const detail = options.detail?.trim() || anchorDetail(text);
  const base = parts.anchor || String(text ?? '').replace(/[，。,.]$/, '');
  const scene = options.scene?.trim() || '回南天';
  const efficacy = hits.some((hit) => ['medical-effect', 'causal-effect', 'disease-hint', 'koc-black-five', 'ad-guarantee']
    .includes(String(hit?.category ?? '')));

  const keepsAnchor = (/** @type {string} */ candidate) => ANCHOR.test(candidate) || candidate.includes(base.slice(0, 4));

  const person = (/(丈母娘|岳母|同事|客户|朋友|媳妇|我妈|外婆)/.exec(String(text ?? '')) ?? ['同事'])[0];
  /* 细节如果已经在锚点里（喝了一个月 与 一个月），就别重复说第二遍 */
  const spareDetail = detail && !base.includes(detail) ? detail : '';
  const parallel = base + '。' + (spareDetail || '裤腰还是那条裤子') + '。';
  /* 转述式必须带上锚点，否则就是没有内容的空话 */
  const reported = person + '问我：最近是不是' + base + '？';
  const sceneLine = scene + '，我' + base;
  /* 非功效场景下，结论整句换成"可验证的记录"，不留半截 */
  const factual = base + '。这个月的记录我留着。';

  const three = [
    { mode: 'parallel', label: '并列式（拆掉因果）', text: efficacy ? parallel : factual },
    { mode: 'reported', label: '转述式（交给第三方）', text: reported },
    { mode: 'scene', label: '场景式（只讲时间与动作）', text: sceneLine },
  ];
  return three.map((entry) => ({ ...entry, keepsAnchor: keepsAnchor(entry.text) }));
}

/**
 * 一句话的人话结论：哪个候选可用、哪个丢了锚点。
 * @param {{ label: string, keepsAnchor?: boolean }[]} candidates
 */
export function rewriteVerdict(candidates) {
  const usable = candidates.filter((entry) => entry.keepsAnchor);
  if (!usable.length) return '三个候选都丢了锚点 —— 加回一个动作（泡 / 开箱 / 送礼）或一个细节（年份 / 产地 / 谁说的）';
  return '可用 ' + usable.length + ' 式：' + usable.map((entry) => entry.label).join('、');
}
