// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The UI's words. `t('timeline.split')` looks up a dotted path in the chosen language's table, then in English; a
 * path in neither comes back as itself, so a typo shows on screen instead of an empty label. Placeholders (`{n}`) are
 * filled by the caller.
 *
 * The language is the person's choice in Settings → General, kept in localStorage `openfilm.language`, or the
 * system's ("system", the default: the first of the browser's languages there is a table for, else English). It is
 * shown as `<html lang>`, which an app embedding Studio reads to match it.
 */
import React from 'react';
import { en } from './en.ts';
import { es } from './es.ts';
import { ja } from './ja.ts';
import { ko } from './ko.ts';
import { zhCN } from './zh-CN.ts';
import { withOrangeWords } from './orange-words.ts';
/* the product's name, from brand.json (lib/brand-name.ts): every phrase that names the product says `{brand}` */
import { brandName } from '../lib/brand-name.ts';

/* upstream's tables with our words laid over them (orange-words.ts): the tables every lookup below reads */
export const LANGUAGES = withOrangeWords([
  { code: 'en', name: 'English', words: en },
  { code: 'zh-CN', name: '简体中文', words: zhCN },
  { code: 'ja', name: '日本語', words: ja },
  { code: 'ko', name: '한국어', words: ko },
  { code: 'es', name: 'Español', words: es },
] as const);

/** English with our words in it: what a path no table has falls back to. */
const EN = LANGUAGES[0].words;

export type Language = (typeof LANGUAGES)[number]['code'];
export type LanguageChoice = Language | 'system';

const KEY = 'openfilm.language';

function node(table: unknown, path: string): unknown {
  let cur = table;
  for (const part of path.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return null;
  }
  return cur;
}

function find(table: unknown, path: string): string | null {
  const found = node(table, path);
  return typeof found === 'string' ? found : null;
}

/** Every phrase under `path`, in `language` and in English: what a search through that part of the interface matches. */
export function phrasesUnder(path: string, language: Language = current()): string[] {
  const out: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === 'string') out.push(value);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) collect(v);
  };
  collect(node(EN, path));
  if (language !== 'en') collect(node(LANGUAGES.find((l) => l.code === language)?.words, path));
  return out;
}

/** The language a browser's list asks for, as one of ours: `zh-Hans-CN` and `zh` are 简体中文, `es-MX` is Español. */
export function languageFor(asked: readonly string[]): Language {
  for (const tag of asked) {
    const lower = tag.toLowerCase();
    if (lower.startsWith('zh')) {
      if (/^zh-(hant|tw|hk|mo)\b/.test(lower)) continue;
      return 'zh-CN';
    }
    const base = lower.split('-')[0];
    const found = LANGUAGES.find((l) => l.code === base);
    if (found) return found.code;
  }
  return 'en';
}

function savedChoice(): LanguageChoice {
  try {
    const value = localStorage.getItem(KEY);
    return LANGUAGES.some((l) => l.code === value) ? value as Language : 'system';
  } catch { return 'system'; }
}

function current(): Language {
  const choice = savedChoice();
  if (choice !== 'system') return choice;
  return typeof navigator === 'undefined' ? 'en' : languageFor(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

/**
 * The product's name in a phrase: the tables say `{brand}` where the product is named (in every language, once), and
 * this is the one place it becomes the brand.json's word. A rename never touches a sentence.
 */
const withBrand = (text: string) => (text.includes('{brand}') ? text.split('{brand}').join(brandName) : text);

/** The path in `language`'s table, else in English's, else the path itself. */
export function lookup(path: string, language: Language = current()): string {
  const words = LANGUAGES.find((l) => l.code === language)?.words;
  return withBrand((words && language !== 'en' ? find(words, path) : null) ?? find(EN, path) ?? path);
}

const listeners = new Set<() => void>();
let shown: Language = current();

function apply() {
  shown = current();
  if (typeof document !== 'undefined') document.documentElement.lang = shown;
  for (const listener of listeners) listener();
}
if (typeof window !== 'undefined') {
  apply();
  window.addEventListener('languagechange', () => { if (savedChoice() === 'system') apply(); });
  /* another tab of Studio changed it */
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply(); });
}

export function setLanguageChoice(choice: LanguageChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch { /* not kept past this page */ }
  apply();
}

const subscribe = (on: () => void) => { listeners.add(on); return () => { listeners.delete(on); }; };

/** The language shown now; a change draws again whoever uses it. */
export function useLanguage(): Language {
  return React.useSyncExternalStore(subscribe, () => shown, () => 'en' as Language);
}

/** The person's choice (or "system") and a way to change it. */
export function useLanguageChoice(): [LanguageChoice, (choice: LanguageChoice) => void] {
  const choice = React.useSyncExternalStore(subscribe, savedChoice, () => 'system' as LanguageChoice);
  return [choice, setLanguageChoice];
}

/** The translator for the language shown, steady until the language changes. */
export function useT(): (path: string) => string {
  const language = useLanguage();
  return React.useCallback((path: string) => lookup(path, language), [language]);
}
