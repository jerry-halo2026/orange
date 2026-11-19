// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/* 由 scripts/brand-codegen.mjs 生成，勿手改（generated from brand.json — edit that, or the script, not this file; non-ASCII is written as \u… so this file is plain ASCII）。 */
/** The shape of brand.json (schema orange/brand/1). Every field is optional: a quiet brand.json is allowed. */
export interface BrandData {
  schema?: string;
  productName?: string;
  companyName?: string;
  appId?: string;
  windowTitle?: string;
  /**
   * mark: the product's mark. Either an address a page can load (http(s)/data/file, or a path rooted at the site:
   * "/..."), which a deployment may override without rebuilding, or a file this tree ships, named inside the package
   * (assets/brand-mark.png), which the pages import as an asset and Vite turns into a loadable URL. A package-relative
   * name is not an address: the pages draw the shipped file and use mark only when it is an address.
   */
  logo?: { mark?: string; wordmark?: string };
  installerName?: string;
  updaterChannel?: string;
  about?: { copyright?: string };
  /** anything else brand.json grows before this script learns its name */
  [field: string]: unknown;
}

/** brand.json's own words: the product's name, its company's, and the mark a page shows for it. */
export const brand: BrandData = {
  "about": {
    "copyright": "\u00a9 2026 OrangeFilm",
  },
  "appId": "com.orange.studio",
  "companyName": "Orange",
  "installerName": "OrangeFilm",
  "links": {
    "community": "",
    "discussions": "https://github.com/jerry-halo2026/orange-plan/discussions",
    "docs": "https://github.com/jerry-halo2026/orange-film-skill#readme",
    "github": "https://github.com/jerry-halo2026/orange-plan",
    "issues": "https://github.com/jerry-halo2026/orange-plan/issues/new/choose",
    "skills": "https://github.com/jerry-halo2026/orange-film-skill",
  },
  "logo": {
    "mark": "assets/brand-mark.png",
    "wordmark": "",
  },
  "productName": "OrangeFilm",
  "schema": "orange/brand/1",
  "updaterChannel": "orange-latest",
  "windowTitle": "\u6a59\u5b50\u521b\u4f5c\u4e2d\u5fc3",
};
