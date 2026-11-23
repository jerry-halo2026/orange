// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 从素材索引拼一份混剪配方（agent 用）：按查询词找批次/产品/分组里的云端素材，组成一个场景组，
 * 配上口播文案、音色与参数（9:16、数量、字幕），可选 BGM。
 *
 * 搜索顺序：先按 产品/分组名 精确包含（命中产品 → 它的分组里的 videoId），再退到 批次名；
 * 一个都匹配不到就返回 problems，不编造素材。
 */

/** 把索引里的批次树摊平成可检索的行：每条视频带它所属的批次/产品/分组名字。 */
export function indexRowsForMix(index) {
  const rows = [];
  for (const batch of index?.batches ?? []) {
    for (const product of batch.products ?? []) {
      for (const group of product.groups ?? []) {
        for (const videoId of group.videoIds ?? []) {
          rows.push({
            videoId: String(videoId),
            batch: String(batch.name ?? batch.id ?? ''),
            product: String(product.name ?? ''),
            group: String(group.name ?? ''),
          });
        }
      }
    }
  }
  return rows;
}

/** 查询词命中的行：产品名优先，其次分组名，最后批次名（都做小写包含）。 */
export function matchRows(rows, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [];
  const hit = (text) => text.toLowerCase().includes(needle);
  const byProduct = rows.filter((row) => hit(row.product));
  if (byProduct.length) return byProduct;
  const byGroup = rows.filter((row) => hit(row.group));
  if (byGroup.length) return byGroup;
  return rows.filter((row) => hit(row.batch));
}

/**
 * 组一份配方（`orange/mix-recipe/1`）：一个场景组，refs 是命中的云端素材；
 * 一条口播（`line`）重复用到 `count` 条成片（`audioUses = count`）；字幕按平台给字体。
 */
export function mixRecipeFromIndex({
  index, query, count = 10, line, provider = 'minimax', voice = 'female-shaonv',
  aspect = '9:16', bgmPath = null, platform = process.platform, maxRefs = 40,
}) {
  const rows = indexRowsForMix(index);
  const matched = matchRows(rows, query);
  const videoIds = [...new Set(matched.map((row) => row.videoId))].slice(0, maxRefs);
  const problems = [];
  if (!rows.length) problems.push('index: 索引里没有可用的素材（先在素材中心构建一次索引）');
  if (!videoIds.length) problems.push(`query: 「${query}」没有匹配到素材`);
  const groupName = String(matched[0]?.product || matched[0]?.group || query || '素材').slice(0, 60);
  const text = String(line ?? '').trim() || `${query} 口播`;
  const recipe = {
    schema: 'orange/mix-recipe/1',
    groups: [{ name: groupName, refs: videoIds.map((videoId) => ({ kind: 'cloud', videoId })), rule: 'random' }],
    script: { provider, voice, lines: [text] },
    params: {
      count: Number.isInteger(count) && count > 0 ? count : 10,
      audioUses: Number.isInteger(count) && count > 0 ? count : 10,
      aspect,
      subtitle: true,
      subtitleFontFamily: platform === 'darwin' ? 'Noto Sans CJK SC' : 'Microsoft YaHei',
    },
    bgm: bgmPath ? [{ kind: 'asset', path: bgmPath }] : [],
  };
  return { recipe, matched: videoIds.length, groupName, problems };
}
