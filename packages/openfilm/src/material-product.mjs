// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 从素材名里认出「产品」：供应商没有产品/合集接口（开放接口文档 12 章里只有视频、分类、标签、用户/团队/小组），
 * 但每条素材的名字自己带着它：
 *
 *   20261119李雪妮-山楂陈皮普洱茶纸袋装90g/袋   → 山楂陈皮普洱茶纸袋装
 *   20261119-油弃乌龙中医科学院联名款60g/盒     → 油弃乌龙中医科学院联名款
 *   20261112李雪妮-迪士尼10+16生晒柑50克/袋     → 迪士尼10+16生晒柑
 *
 * 规则：去掉开头的 8 位日期；第一个 `-` 之前的部分（作者名）丢掉；再去掉末尾的规格/包装（90g/袋、50克/袋…）。
 * 认不出（没有日期、没有 `-`、太短）就返回 null，宁可不成组，也不把作者名/日期当产品。
 */

const DATE = /^(\d{8})/;
/** 末尾规格与包装：`90g/袋`、`50克/袋`、`1.5L/瓶`、`200ml*12/箱`… */
const SPEC = /\s*[（(]?\s*\d+(?:\.\d+)?\s*(?:g|kg|克|千克|ml|毫升|l|升)\s*(?:[*x×]\s*\d+\s*)?[/／]\s*(?:袋|盒|罐|瓶|包|箱|条|支|片)\s*[)）]?\s*$/i;
/** 一个只有序号或只有作者的名字，不是产品 */
const NOT_PRODUCT = /^(?:[-\s]*|\d+|\p{Script=Han}{1,4}(?:[-\s].*)?)$/u;

export function productOf(name) {
  const text = String(name ?? '').trim().normalize('NFC');
  if (!text) return null;
  const dated = DATE.exec(text);
  if (!dated) return null;
  let rest = text.slice(dated[1].length);
  const dash = rest.indexOf('-');
  if (dash < 0) return null;
  rest = rest.slice(dash + 1).trim();
  if (!rest) return null;
  const product = rest.replace(SPEC, '').trim();
  if (!product || product.length > 80 || NOT_PRODUCT.test(product)) return null;
  return product;
}

/** 产品 → 该产品下的素材名（按产品聚合，跨日期）。 */
export function groupByProduct(names) {
  const groups = new Map();
  for (const name of names) {
    const product = productOf(name);
    if (!product) continue;
    const list = groups.get(product) ?? [];
    list.push(name);
    groups.set(product, list);
  }
  return groups;
}
