// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Slugs are the wiki's natural key, so the rule has to be boring and total: lowercase, every run of
 * non-letter/digit characters becomes one hyphen, and the ends are trimmed.
 *
 * Chinese is kept as Chinese. "Translate to pinyin" would be a dependency and a guess, and dropping it
 * (the usual `[^a-z0-9]` rule) would collapse every Chinese product name to the same empty slug. So a
 * CJK title becomes a CJK kebab (`新仓 产品` -> `新仓-产品`), which is stable, readable, and distinct.
 */

/** Anything that is a letter or a digit in any script stays; everything else separates. */
const SEPARATOR=/[^\p{L}\p{N}]+/gu;

export function slugify(title:string):string {
  const slug=title
    .normalize('NFKC')
    .toLowerCase()
    .replace(SEPARATOR,'-')
    .replace(/^-+|-+$/g,'')
    .slice(0,96)
    .replace(/-+$/g,'');
  return slug.length?slug:'entity';
}

/** A slug from whatever the caller offered, falling back to the title when the slug is unusable. */
export function slugFor(title:string,explicit?:string):string {
  return slugify(explicit&&explicit.trim().length?explicit:title);
}
