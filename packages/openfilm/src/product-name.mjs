// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The product's name, for the modules that run as plain node (the `openfilm` command, Studio's server and the pages it
 * serves, `doctor`): brand.json's `productName` at the repository's root, which scripts/brand-codegen.mjs turns into
 * `brand.generated.ts` for the pages. This is the same word for those, in one line, and `product-name.test.mjs` fails if
 * the two ever disagree — so a rename is brand.json and this line, never a sentence somewhere else.
 */
export const PRODUCT_NAME = 'OrangeFilm';
