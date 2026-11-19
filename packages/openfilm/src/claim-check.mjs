// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * 文案合规检查：一句话能不能发，能不能用暗示，暗示到什么程度会被平台判违规。
 *
 * # 为什么要有它
 *
 * 我们做的是「KOC 口播 + 暗示性表达」——暗示本身就是这条产品线的语言。但**暗示与违规之间没有灰色地带，
 * 只有"平台怎么写规则"这一条线**。抖音电商《食品饮料行业宣传规范》把线画得很具体：
 *
 *   - 食品不得出现与药品、保健品相混淆的用语，不得直接或间接宣传治疗、保健作用；
 *   - 不得涉及医疗保健效果词（减肥、祛湿、助消化、促进肠道蠕动、增强免疫力、降火…）；
 *   - 不得暗示病症（二甲双胍、糖友、升糖指数…）；**茶叶素材提"二甲双胍"是被点名的违规案例**；
 *   - 绝对化用语（国家级、最高级、最佳、顶级、第一品牌…）；
 *   - 黑五类（壮阳/减肥/丰胸/增高）明示暗示都算（微信小店规则原文）。
 *
 * 所以这里不是"纠错工具"，是**改写工具**：命中就给出同义的、不触线的说法（体感/场景/生活方式），
 * 让人能继续写，而不是只能说"不行"。
 *
 * # 三档
 *
 * `block` —— 直接下架/限流级别，必须改；
 * `warn`  —— 有风险，通常要配证据（质检报告、销量截图、专利号）或换说法；
 * `hint`  —— 不是违规，但"太像广告"，完播率会掉（营销套路词、夸张承诺）。
 */

/**
 * @typedef {{ id: string, category: string, severity: 'block' | 'warn' | 'hint',
 *   patterns: RegExp[], why: string, rewrite: string }} ClaimRule
 */

/** 规则表。`why` 写"平台怎么说"，`rewrite` 写"我们可以怎么说"。 */
export const CLAIM_RULES = /** @type {ClaimRule[]} */ ([
  {
    id: 'medical-effect',
    category: '医疗保健功效',
    severity: 'block',
    patterns: [/减肥|瘦身|燃脂|掉秤|去湿|祛湿|除湿|排毒|清热解毒|利尿|消肿/,
      /防癌|抗癌|抗癌变|抑制肿瘤/,
      /增强免疫|提高免疫|免疫力|抵抗力/,
      /降火|败火|去火|降三高|降血压|降血糖|降血脂/,
      /调理肠胃|养胃|护胃|助消化|促进消化|促进肠道蠕动|通便|便秘|排宿便/,
      /改善睡眠|治失眠|安神|助眠/,
      /护肝|养肝|解酒|护肾|壮阳|丰胸|增高/],
    why: '食品不得直接或间接宣传治疗、保健作用（抖音电商《食品饮料行业宣传规范》2.5）',
    rewrite: '改写成体感与场景："喝完胃里暖暖的""下午那杯替我顶住了嘴馋"——说感受，不说功效',
  },
  {
    id: 'disease-hint',
    category: '病症暗示',
    severity: 'block',
    patterns: [/二甲双胍|胰岛素|糖友|糖尿|血糖高|嘌呤|痛风|升糖指数|\bGI\b/i,
      /三高|高血压|高血脂|脂肪肝|结节|肌瘤|内分泌失调/,
      /病号服|住院|吃药|停药|替代药物/],
    why: '食品广告不得暗示病症或替代药物；茶叶素材提及"二甲双胍"是抖音点名的违规案例',
    rewrite: '删掉病症词，只留场景："办公室下午那杯""爸妈也爱喝"',
  },
  {
    id: 'absolute',
    category: '绝对化用语',
    severity: 'block',
    patterns: [/国家级|世界级|最高级|最佳|最好|最强|第一品牌|销量第一|排名第一|顶级|极品|绝无仅有|独一无二|万能/,
      /* 价格类绝对化同样是广告法禁止的（"最低价"比"最好"更容易被直接判） */
      /全网最低|史上最低|绝对最低|价格最低|最低价/],
    why: '广告不得使用"国家级/最高级/最佳"及同义绝对化用语（《广告法》第九条；抖音 5.2）',
    rewrite: '有凭证才说具体数字与来源（"××平台 2025 年 3–8 月同类目销量第一，截图见详情"），否则只说"我们家卖得最好的是这款"这种主观表述（也要慎用）',
  },
  {
    id: 'koc-black-five',
    category: '黑五类暗示',
    severity: 'block',
    patterns: [/悄悄变瘦|偷偷瘦|瘦成|小腹平了|肚子小了一圈|体重掉了|穿小一码|锁骨出来了|CUP|罩杯|长高|二次发育/,
      /* 外貌变化承诺："惊艳所有人"本身不含功效词，但配上"这个冬天/过年"就是"变好看"的承诺 */
      /惊艳所有人|惊艳全场|惊艳到所有人/],
    why: '减肥/丰胸/增高等属平台禁止或严格管控类目，明示暗示均按违规处置（微信小店带货规范）',
    rewrite: '换成生活方式与仪式感："每天一杯，成了我下班后的开关"——不指向身体变化',
  },
  {
    id: 'causal-effect',
    category: '因果暗示功效',
    severity: 'block',
    /* 因果句是功效暗示最常见的包装：不写"减肥"，写"喝了一个月，裤子松了"——平台按"间接宣传功效"判。
       所以这里抓的是**连接词 + 结果**的组合，而不是单独的词。 */
    patterns: [
      /[喝吃用]{1,2}[了着过].{0,14}(所以|就|才|结果|后来|从此).{0,14}(好|轻|小|顺|消|没|不|改|变|松|紧|平|白|细|舒服|精神)/,
      /坚持.{0,12}(所以|就|才|结果|后来).{0,12}(好|轻|小|顺|消|没|不|改|变|松|平|白|舒服|精神)/,
      /一[喝吃用].{0,4}就.{0,10}(好|轻|顺|舒服|暖|通|消)/,
      /(因为|由于).{0,10}(喝|吃|用).{0,16}(所以|才|因此).{0,14}/,
      /(让|使).{0,8}(皮肤|脸|体重|身体|肠胃|睡眠|气色|精神).{0,8}(变|更|好|轻)/,
      /喝(了|完)?之后.{0,12}(不|没|变|轻|好|顺|消)/,
      /(因为|由于).{0,12}(它|这个|这款|喝|吃|用).{0,16}(好|轻|顺|不|没|变|松|平)/,
    ],
    why: '食品不得"间接"宣传保健/治疗作用：用因果关系把功效说成"经历"仍属暗示（抖音《食品饮料行业宣传规范》2.5）',
    rewrite: '拆掉因果，只留并列的事实与体感："我下午泡一颗"（事实）／"胃里暖暖的"（体感）—— 两件事并列说，不连成"所以"',
  },
  {
    id: 'time-promise',
    category: '效果承诺与时间',
    severity: 'warn',
    patterns: [/[三五四七两1-9十]{1,2}[天日周].{0,4}(见效|有效|变好|不一样|改观)/,
      /立刻|马上|当天|秒变|一喝就|立竿见影|彻底|当天就/],
    why: '效果保证属虚假宣传高风险点（抖音 3.1.4 效果保证）',
    rewrite: '去掉时间承诺，改成频率与习惯："我一般连着喝一个月，配合作息"——只说自己的做法，不承诺结果',
  },
  {
    id: 'compare',
    category: '贬低与对比',
    severity: 'warn',
    patterns: [/比\S{0,6}好用|吊打|秒杀|碾压|吊锤|完爆|甩开|别家都是|同行都/],
    why: '贬低同行属不正当竞争，且平台按"虚假宣传/不正当竞争"处置',
    rewrite: '只说自己的差异："我们用的是三年陈的柑，别人家用几年的我不知道"',
  },
  {
    id: 'price-fake',
    category: '价格与稀缺',
    severity: 'warn',
    patterns: [/原价\s*\d+|日常价\s*\d+|限时秒杀|仅此一天|最后\s*\d+\s*件|错过再无|全网最低/],
    why: '虚构原价、虚假稀缺属价格欺诈（抖音"价格虚假、诱导消费"）',
    rewrite: '真实价格与真实库存：写清活动周期与划线价的成交记录，或只说"这一批做活动"',
  },
  /* ── 付费投放（千川 / 广告法）比自然流量更严的几条 ───────────────────────────────────────────── */
  {
    id: 'ad-solicit',
    category: '诱导点击与站外引流',
    severity: 'block',
    patterns: [/点击下方|点左下角|点进直播间|私信我|加我微信|扫码|二维码|vx[:：]|微信[:：]/i, /主页领|评论区扣\d|扣1领/],
    why: '广告不得诱导用户点击与站外导流（千川素材审核）；二维码、联系方式一律不可出现',
    rewrite: '改成对产品本身的陈述与行动指令："15 秒，一颗一泡" / "这一批是去年晒的"',
  },
  {
    id: 'ad-price-claim',
    category: '价格与促销真实性',
    severity: 'warn',
    patterns: [/全网最低|史上最低|绝对最低|底价|赔本|免费送|0元购|买一送一(?!.*限)/, /原价\s*\d+\s*现价|划线价/],
    why: '价格承诺需真实成交记录与凭证，否则属虚假宣传（千川/广告法）',
    rewrite: '写真实活动：活动周期、到手价、赠品清单；原价要有近 7 天成交记录支撑',
  },
  {
    id: 'ad-guarantee',
    category: '效果保证',
    severity: 'block',
    patterns: [/无效退款|不满意全额|包治|根治|立刻见效|一喝就好|保证\S{0,6}(好|瘦|白)/],
    why: '广告不得对效果作保证性承诺（食品尤其）',
    rewrite: '只描述产品事实与使用方式，不承诺结果',
  },

  {
    id: 'marketing-cliche',
    category: '营销套路词（不违规但伤完播）',
    severity: 'hint',
    patterns: [/家人们|姐妹们冲|闭眼入|yyds|绝绝子|谁懂啊|宝藏|天花板|氛围感拉满/],
    why: '不是违规，但这类词在 2025 之后完播率明显下降，观众会当广告划走',
    rewrite: '换成具体细节："第一口是柑皮的苦，回甘在第三秒"——细节比形容词留人',
  },
]);

/** 把命中位置前后各截一点，方便看上下文。 */
const around = (/** @type {string} */ text, /** @type {number} */ index, /** @type {number} */ length, pad = 12) =>
  text.slice(Math.max(0, index - pad), Math.min(text.length, index + length + pad)).replace(/\s+/g, ' ');

/**
 * 检查一段文案。
 *
 * `mode` 决定它处在哪个阶段：**`draft` 只标注**（允许先写得更有力度），`publish` 才真正阻断。
 * 理由就是"违规是上下文"—— 草稿期要的是"这句有多危险、危险在哪"，发布期要的是"能不能过"。
 * 先写最有力度的那句，再照着命中项的 `rewrite` 改：力度保住了，线也没踩。
 *
 * @param {string} text
 * @param {{ mode?: 'draft' | 'publish' }} [options]
 * @returns {{ ok: boolean, mode: 'draft' | 'publish', blocking: number, needsRewrite: boolean, hits: { ruleId: string, category: string,
 *   severity: 'block' | 'warn' | 'hint', match: string, context: string, why: string, rewrite: string }[] }}
 */
export function checkClaims(text, { mode = 'publish' } = {}) {
  const source = String(text ?? '');
  /** @type {any[]} */
  const hits = [];
  for (const rule of CLAIM_RULES) {
    for (const pattern of rule.patterns) {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      const scan = new RegExp(pattern.source, flags);
      /** @type {RegExpExecArray | null} */
      let found = scan.exec(source);
      while (found) {
        hits.push({
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity,
          match: found[0],
          context: around(source, found.index, found[0].length),
          why: rule.why,
          rewrite: rule.rewrite,
        });
        if (!found[0]) break;
        found = scan.exec(source);
      }
    }
  }
  hits.sort((a, b) => a.context.length - b.context.length);
  const blocking = hits.filter((hit) => hit.severity === 'block').length;
  /* draft 阶段有 block 也仍然 ok（只是标注），发布前必须用 publish 再跑一次 */
  /* draft 不阻断（草稿就是用来写得更有力度的），但把「发布前要改」标出来；publish 才看 blocking */
  return { ok: mode === 'draft' ? true : blocking === 0, mode, blocking, needsRewrite: hits.length > 0, hits };
}

/**
 * 场景标签：把一句文案落到"应用场景/动作场景"（不是地点），供选镜头与配 BGM 用。
 * 这张表是产品知识，不是规则 —— 场景越具体，素材与音效越好选。
 */
export const SCENE_TAGS = Object.freeze({
  办公: [/办公|上班|工位|开会|加班|下午三点|摸鱼/],
  居家: [/在家|沙发|阳台|窝着|追剧|晚上/],
  通勤: [/地铁|路上|通勤|包里|随身/],
  待客: [/客人|亲戚|朋友来|招待|泡一壶/],
  送礼: [/送礼|礼盒|长辈|爸妈|丈母娘|伴手礼|迪士尼/],
  独处: [/一个人|独处|安静|放空|睡前/],
  仪式感: [/仪式|开关|习惯|每天|第一杯|开场/],
  爱茶: [/茶友|老茶客|回甘|喉韵|汤色|年份|陈化/],
  运动后: [/健身|运动|跑步|瑜伽|出汗/],
  天气: [/冬天|入秋|降温|潮湿|回南天|梅雨/],
});

/**
 * 这段文案落在哪些场景（可能多个；一个都没有就是"没说清给谁看"）。
 * @param {string} text
 * @returns {string[]}
 */
export function sceneTags(text) {
  const source = String(text ?? '');
  /** @type {string[]} */
  const tags = [];
  for (const [tag, patterns] of Object.entries(SCENE_TAGS)) {
    if (patterns.some((pattern) => pattern.test(source))) tags.push(tag);
  }
  return tags;
}
