// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// fp16 编码器是这条打包链上唯一"手写"的一段，错了不会崩、只会让客户端的余弦悄悄变差 —— 所以要逐值验。
import test from 'node:test';
import assert from 'node:assert/strict';

import { toFloat16, parseArgs, defaultOptions } from './material-vector-pack.mjs';

/** 把 fp16 位模式按 IEEE 754 半精度解回浮点（测试用，独立于被测实现）。 */
function fromFloat16(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

test('toFloat16：常见向量值的往返误差在半精度能表示的范围内', () => {
  const values = [0, 1, -1, 0.5, -0.5, 0.1, -0.1, 0.001, 1e-5, 65.5, -120.25, 0.3333, 1 / 3];
  for (const value of values) {
    const back = fromFloat16(toFloat16(value));
    assert.ok(Math.abs(back - value) <= Math.max(Math.abs(value) * 0.001, 1e-6),
      `${value} → ${back}（差 ${Math.abs(back - value)}）`);
  }
});

test('toFloat16：超出半精度范围的走无穷，零与负数符号正确', () => {
  assert.equal(fromFloat16(toFloat16(1e6)), Infinity);
  assert.equal(fromFloat16(toFloat16(-1e6)), -Infinity);
  assert.equal(fromFloat16(toFloat16(0)), 0);
  assert.equal(fromFloat16(toFloat16(-0)), -0);
  assert.ok(Number.isNaN(fromFloat16(toFloat16(NaN))));
});

test('归一化后的向量元素（都在 ±0.3 内）误差不超过 3e-4', () => {
  /* 真实的 bge 向量元素基本落在 ±0.3：这一档的分辨率决定余弦能有多准 */
  for (let value = 0; value <= 0.3; value += 0.01) {
    const back = fromFloat16(toFloat16(value));
    assert.ok(Math.abs(back - value) < 3e-4, `${value.toFixed(2)} → ${back}`);
  }
});

test('参数：默认打 768 维的 bge-base，输出到 .dev/vector-pack', () => {
  const options = defaultOptions();
  assert.equal(options.dims, 768);
  assert.equal(options.column, 'embedding_768_bge_base');
  assert.equal(options.model, 'bge-base-zh-v1.5');
  assert.match(options.out, /vector-pack$/);
  assert.equal(parseArgs(['--limit', '5', '--dims', '512']).limit, 5);
  assert.equal(parseArgs(['--out=/tmp/pack']).out, '/tmp/pack');
  assert.equal(parseArgs(['--help']), null);
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
});
