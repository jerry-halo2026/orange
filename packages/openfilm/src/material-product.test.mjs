// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByProduct, productOf } from './material-product.mjs';

test('产品名：去掉日期、作者与规格包装', () => {
  assert.equal(productOf('20261119李雪妮-山楂陈皮普洱茶纸袋装90g/袋'), '山楂陈皮普洱茶纸袋装');
  assert.equal(productOf('20261119-油弃乌龙中医科学院联名款60g/盒'), '油弃乌龙中医科学院联名款');
  assert.equal(productOf('20261112李雪妮-迪士尼10+16生晒柑50克/袋'), '迪士尼10+16生晒柑');
});

test('不是产品的名字：作者、日期、没有短横线', () => {
  assert.equal(productOf('20261119'), null);
  assert.equal(productOf('李雪妮'), null);
  assert.equal(productOf('20261119-'), null);
  assert.equal(productOf('随手拍的一段'), null);
});

test('跨日期按产品聚合', () => {
  const groups = groupByProduct([
    '20261119-油弃乌龙中医科学院联名款60g/盒',
    '20261118-油弃乌龙中医科学院联名款60g/盒',
    '20261119李雪妮-山楂陈皮普洱茶纸袋装90g/袋',
  ]);
  assert.deepEqual([...groups.keys()].sort(), ['山楂陈皮普洱茶纸袋装', '油弃乌龙中医科学院联名款'].sort());
  assert.equal(groups.get('油弃乌龙中医科学院联名款')?.length, 2);
});
