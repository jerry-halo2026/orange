// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * A chat turn put back (`studio/server/server.mjs` history/put-back/done, which emits `{ type: 'canvas', reset: true }`),
 * held as a source contract: the board reads the restored document, and nothing of it is remembered as a change.
 *
 * Why it needs holding at all: the E2E that covers the turn (`studio/canvas-turn-restore.test.mjs`) presses ⌘Z and then
 * ⌘⇧Z, which cancel out, so a board that *did* remember the restored document still ends where the test looks. What the
 * person does alone is ⌘Z — and then the files the turn removed come back, the very thing the reset is for.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('./canvas/CanvasView.tsx', import.meta.url), 'utf8');
const effect = (() => {
  const start = source.indexOf("if (event.type !== 'canvas') return;");
  assert.ok(start > 0, 'the board listens for what an agent changed');
  return source.slice(start, source.indexOf('}), [projectId]);', start));
})();

test('a turned-back turn clears the undo history and lists the boards again, before reading the board', () => {
  assert.match(effect, /if \(event\.reset\) \{\n\s*history\.current = emptyHistory\(\);\n\s*void loadBoards\(\);\n\s*\}/,
    'the history starts again from the restored document, and the boards are listed again (a turn made or removed some)');
  const reset = effect.indexOf('if (event.reset)');
  const read = effect.indexOf('api.canvas(projectId');
  assert.ok(reset > 0 && read > reset, 'the history is emptied before the board is read, not after');
});

test('the restored document is not remembered as a change, and what it adds is not fitted into view', () => {
  assert.match(effect, /if \(!event\.reset\) willChange\(\);/, '⌘Z after a put-back has nothing of the turn to bring back');
  assert.match(effect, /if \(added\.length && !event\.reset\) requestAnimationFrame\(/,
    'the view stays where the person left it: a put-back is not an agent adding something');
});
