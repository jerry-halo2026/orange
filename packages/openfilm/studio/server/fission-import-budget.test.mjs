// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {tailPaddingBudget} from './fission-import.mjs';

// 这两条不变式（末段可越界、覆盖可缺口）只有在“确有包尾”时才允许花这笔预算。
// 这里把预算规则单独钉死：任何放宽都必须经过它，避免再次出现“某处引用不到预算就整套失效”。
const plan = (overrides = {}) => ({
    schemaVersion: 1,
    fps: 30,
    durationSec: 4.1,
    alignment: {action: 'trim', inputDurationSec: 4.2, outputDurationSec: 4, tempo: 1, loops: 1},
    transitions: {tailPaddingSec: 0.2},
    ...overrides,
});

test('a plan without a packet tail gets no budget', () => {
    assert.equal(tailPaddingBudget(plan({durationSec: 4})), 0);
    // 只有一帧以内的舍入，不算包尾
    assert.equal(tailPaddingBudget(plan({durationSec: 4 + 0.5 / 30})), 0);
    assert.equal(tailPaddingBudget(plan({alignment: {action: 'speed', inputDurationSec: 8, outputDurationSec: 4, tempo: 2, loops: 1}})), 0);
});

test('a packet tail spends the declared padding, capped at half a second', () => {
    assert.equal(tailPaddingBudget(plan()), 0.2);
    assert.equal(tailPaddingBudget(plan({transitions: {tailPaddingSec: 0.05}})), 0.05);
    // 声明超过上限的“包尾”不是包尾
    assert.equal(tailPaddingBudget(plan({transitions: {tailPaddingSec: 5}})), 0.5);
});

test('a missing or malformed padding never becomes a budget', () => {
    assert.equal(tailPaddingBudget(plan({transitions: {tailPaddingSec: undefined}})), 0);
    assert.equal(tailPaddingBudget(plan({transitions: {tailPaddingSec: '0.2'}})), 0);
    assert.equal(tailPaddingBudget(plan({transitions: undefined})), 0);
    assert.equal(tailPaddingBudget(plan({fps: 0})), 0);
    assert.equal(tailPaddingBudget(undefined), 0);
});
