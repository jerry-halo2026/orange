// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The wiki's words, in the two languages this workspace writes first-class copy for (the rest fall back to English).
 */
import type {Production, WikiEntity, WikiFailureKind, WikiKind, WikiStatus} from './wiki.ts';

export type WikiCopy = {
  readonly open: string;
  readonly close: string;
  readonly loading: string;
  readonly notConnected: string;
  readonly limited: string;
  readonly failed: string;
  readonly oneLine: string;
  readonly scenes: string;
  readonly bestClip: string;
  readonly useClip: string;
  readonly tags: string;
  readonly risks: string;
  readonly confidence: string;
  readonly entities: string;
  readonly entitiesEmpty: string;
  readonly back: string;
  readonly sources: string;
  readonly disputed: string;
  readonly adoptA: string;
  readonly adoptB: string;
  readonly keepConflict: string;
  readonly arbitrating: string;
  readonly production: Record<Production, string>;
  readonly status: Record<WikiStatus, string>;
  readonly kinds: Record<WikiKind, string>;
};

const zh: WikiCopy = {
  open: '纪要',
  close: '收起纪要',
  loading: '正在读取纪要…',
  notConnected: '纪要服务未接通。',
  limited: '限流，稍后重试。',
  failed: '纪要读取失败，本次结果不作数。',
  oneLine: '一句话纪要',
  scenes: '场景时间线',
  bestClip: '最佳片段',
  useClip: '用这段',
  tags: '标签',
  risks: '风险',
  confidence: '置信度',
  entities: '实体',
  entitiesEmpty: '还没有实体。',
  back: '返回实体列表',
  sources: '来源素材',
  disputed: '存在冲突，待人工裁决',
  adoptA: '采纳 A',
  adoptB: '采纳 B',
  keepConflict: '保留冲突',
  arbitrating: '正在写入裁决…',
  production: {live: '实拍', ai: 'AI', code: '代码', mixed: '混合'},
  status: {candidate: '候选', trusted: '可信', disputed: '有争议'},
  kinds: {product: '产品', person: '人物', scene: '场景', style: '风格', brand: '品牌', collection: '合集', hook: '话术钩子', selling_point: '卖点'},
};

const en: WikiCopy = {
  open: 'Notes',
  close: 'Hide notes',
  loading: 'Reading the notes…',
  notConnected: 'The notes service is not connected.',
  limited: 'Rate-limited; try again shortly.',
  failed: 'Reading the notes failed; this result does not count.',
  oneLine: 'In one line',
  scenes: 'Scene timeline',
  bestClip: 'Best clip',
  useClip: 'Use this',
  tags: 'Tags',
  risks: 'Risks',
  confidence: 'Confidence',
  entities: 'Entities',
  entitiesEmpty: 'No entities yet.',
  back: 'Back to entities',
  sources: 'Source material',
  disputed: 'In conflict; a person must decide',
  adoptA: 'Adopt A',
  adoptB: 'Adopt B',
  keepConflict: 'Keep the conflict',
  arbitrating: 'Writing the decision…',
  production: {live: 'Live', ai: 'AI', code: 'Code', mixed: 'Mixed'},
  status: {candidate: 'Candidate', trusted: 'Trusted', disputed: 'Disputed'},
  kinds: {product: 'Product', person: 'Person', scene: 'Scene', style: 'Style', brand: 'Brand', collection: 'Collection', hook: 'Hook', selling_point: 'Selling point'},
};

export function wikiCopyFor(language: string): WikiCopy {
  return language === 'zh-CN' ? zh : en;
}

export function wikiFailureCopy(copy: WikiCopy, kind: WikiFailureKind): string {
  if (kind === 'not-connected') return copy.notConnected;
  if (kind === 'limited') return copy.limited;
  return copy.failed;
}

/** The minimum a page needs to draw one entity row without the whole wiki copy. */
export function entityStatusWord(copy: WikiCopy, entity: WikiEntity): string {
  return entity.status === 'disputed' ? copy.disputed : entity.status === 'retired' ? copy.status.disputed : copy.status.trusted;
}
