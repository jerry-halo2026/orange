// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Our chat words, apart from upstream's locale files: the phrases we wrote, in the languages we wrote them in.
 *
 * One owner for our copy: the keys we changed upstream live here, so the overlay step can take them out of the upstream
 * files without losing the words. Only the keys we changed are here; every other path is upstream's.
 */
import type { Words } from './locales/words';

/** The chat's languages, named as Studio names them. */
export type OrangeLocale = 'en' | 'zh-CN' | 'ja' | 'ko' | 'es';

/** skills.addHint, said in each language. */
const en: Words = {
  skills: {
    addHint: 'Paste a skill from the skills index (orange-film-skill), or a folder of skills on this computer.',
  },
};
const zhCN: Words = {
  skills: {
    addHint: '粘贴技能索引（orange-film-skill）里的一个 skill，或本机上一个 skill 文件夹。',
  },
};
const ja: Words = {
  skills: {
    addHint: 'スキル索引（orange-film-skill）のスキル、またはこのコンピューター上のスキルのフォルダを貼り付けてください。',
  },
};
const ko: Words = {
  skills: {
    addHint: '스킬 색인(orange-film-skill)의 스킬 또는 이 컴퓨터의 스킬 폴더를 붙여넣으세요.',
  },
};
const es: Words = {
  skills: {
    addHint: 'Pega una skill del índice de skills (orange-film-skill), o una carpeta de skills de este ordenador.',
  },
};

/** Our words, per language: what `withOrangeWords` lays over upstream's table. */
export const ORANGE_WORDS: Record<OrangeLocale, Words> = { en, 'zh-CN': zhCN, ja, ko, es };

/** `base` with our phrases laid over it; neither table is changed and nothing here removes a phrase. */
function layOver(base: unknown, overlay: unknown): unknown {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return base;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return overlay;
  const out = { ...(base as Record<string, unknown>) };
  for (const [path, value] of Object.entries(overlay as Record<string, unknown>)) {
    out[path] = value && typeof value === 'object' && !Array.isArray(value)
      ? layOver((base as Record<string, unknown>)[path], value)
      : value;
  }
  return out;
}

/**
 * The chat's tables with our words laid over each one: the one place the overlay is applied, so `useT` and `translate`
 * read the same tables. A language we have nothing for keeps upstream's words.
 */
export function withOrangeWords<const T extends Record<OrangeLocale, unknown>>(tables: T): T {
  const out: Record<string, unknown> = {};
  for (const locale of Object.keys(ORANGE_WORDS) as OrangeLocale[]) out[locale] = layOver(tables[locale], ORANGE_WORDS[locale]);
  return out as T;
}
