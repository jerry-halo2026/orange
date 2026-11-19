// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html=readFileSync(new URL('./failed.html',import.meta.url),'utf8');
const script=/<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
assert.ok(script,'failure page script is present');
function render(search) {
  const nodes={message:{textContent:''},guidance:{textContent:'default guidance'}};
  runInNewContext(script,{document:{getElementById:id=>nodes[id]},location:{search},URLSearchParams});
  return nodes;
}
test('isolated run refusal explains safe recovery without removing or reusing a prior record',()=>{
  const nodes=render('?code=ISOLATED_RUN_EXISTS&message=fixture');
  assert.equal(nodes.message.textContent,'fixture');
  assert.match(nodes.guidance.textContent,/关闭.*Orange/);
  assert.match(nodes.guidance.textContent,/新.*隔离测试会话.*端口/);
  assert.match(nodes.guidance.textContent,/保留.*运行记录.*不要删除/);
});
test('arbitrary failure text cannot select the isolated-run recovery branch',()=>{
  const nodes=render('?message=ISOLATED_RUN_EXISTS');
  assert.equal(nodes.guidance.textContent,'default guidance');
});
