// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The cloud-steward panel's words, in the two languages this workspace ships first-class copy for (the rest fall back
 * to English through `i18n`'s own lookup). Kept beside the group model so the panel's sentences travel with it.
 */
import type {GroupCopy} from './groups.ts';

const zh: GroupCopy = {
  title: '云管家素材',
  allMaterials: '全部素材',
  clear: '清除',
  close: '收起',
  crumbRoot: '云管家素材',
  back: '返回分组',
  loading: '正在读取分组…',
  empty: '没有可显示的分组。',
  failed: '分组读取失败，本次结果不作数。',
  updated: '最近更新',
  showCounts: '显示每组数量',
  hideCounts: '隐藏每组数量',
  limitNotice: '供应商限流，稍后再试。',
  countAtLeast: count => `≥${count} 条`,
  countExact: count => `${count} 条`,
};

const en: GroupCopy = {
  title: 'Cloud steward material',
  allMaterials: 'All material',
  clear: 'Clear',
  close: 'Collapse',
  crumbRoot: 'Cloud steward material',
  back: 'Back to groups',
  loading: 'Reading groups…',
  empty: 'No groups to show.',
  failed: 'Reading the groups failed; this result does not count.',
  updated: 'Updated',
  showCounts: 'Show group counts',
  hideCounts: 'Hide group counts',
  limitNotice: 'The supplier is rate-limiting; try again later.',
  countAtLeast: count => `≥${count}`,
  countExact: count => `${count}`,
};

export function groupCopyFor(language: string): GroupCopy {
  return language === 'zh-CN' ? zh : en;
}
