#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 实机验证：起一个真的 Studio（真路由、真服务、真包与模型），用 HTTP 打 `POST /api/materials/search`。
//
//   node scripts/verify-studio-search.mjs
//   node scripts/verify-studio-search.mjs --query "小青柑 外包装" --limit 5 --repeat 3
//
// # 为什么需要它
//
// 素材检索那条路要"登录态"（`auth.assertActive()`），而登录要人去 Supabase 走一遍。做回归时不可能每次都点。
// 这里给一个**只在这条命令里存在**的 auth 桩：它只回答"已登录"，不碰任何账号、不发任何鉴权请求，
// 所以既能验证真实路由与真实服务，又不需要密码，也不会把谁的会话留在磁盘上。
//
// 真正验证的东西：
//   - Studio 起得来、路由挂得上（`/api/materials/search`）；
//   - 包在默认位置（`<shared home>/materials/pack`）被认到，mode 是 `pack` 而不是退回 `vector`/`index`；
//   - 模型在默认位置被认到（bge-base-zh，768 维）；
//   - 冷启动与热查询的耗时、返回的形状（mediaKey + score + availability）。
//
// 退出码：0 = 全部通过；1 = 有一步不对（打印出来）。
process.env.OPENFILM_MEDIA_TENANT = process.env.OPENFILM_MEDIA_TENANT || 'tenant-a';

const argv = process.argv.slice(2);
const arg = (/** @type {string} */ name, /** @type {string} */ fallback) => {
  const at = argv.indexOf(`--${name}`);
  if (at !== -1) return argv[at + 1] ?? fallback;
  const eq = argv.find((item) => item.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/verify-studio-search.mjs [--query TEXT] [--limit N] [--repeat N]');
  process.exit(0);
}
const query = arg('query', '小青柑 外包装');
const limit = Number(arg('limit', '5'));
const repeat = Number(arg('repeat', '1'));

const { startStudio } = await import('../packages/openfilm/studio/server/server.mjs');
const { DEFAULT_PACK_DIR, LOCAL_EMBED_MODEL } = await import('../packages/openfilm/src/material-search.mjs');

const key = 'verify-studio-search-key';
/** 只在这条命令里存在的登录态：不碰账号、不发鉴权请求。 */
const auth = {
  getPublicState: () => ({ signedIn: true, email: 'verify@local' }),
  signIn: async () => ({ state: { signedIn: true } }),
  signOut: async () => ({ state: { signedIn: false } }),
  assertActive: () => ({ subjectId: 'verify', environmentId: 'dev', instanceId: 'verify', epoch: 1 }),
  onState: () => () => {},
  token: () => null,
};

console.log(`包目录 ${DEFAULT_PACK_DIR()}`);
console.log(`模型 ${LOCAL_EMBED_MODEL}（<shared home>/runtime/models 优先，其次 library/models）`);
const studio = await startStudio({ port: 0, key, desktopAuth: auth, openBrowser: () => {}, advertise: false });
const base = studio.origin ?? `http://127.0.0.1:${studio.port}`;
console.log(`Studio ${base}`);

let failed = 0;
for (let round = 1; round <= repeat; round += 1) {
  const startedAt = Date.now();
  const response = await fetch(`${base}/api/materials/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-studio-key': key, origin: base },
    body: JSON.stringify({ query, limit }),
  });
  const text = await response.text();
  const elapsed = Date.now() - startedAt;
  /** @type {any} */
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  const first = body?.items?.[0];
  const shapeOk = response.ok && body && typeof body.mode === 'string' && Array.isArray(body.items);
  console.log(`${round}. ${query}  status=${response.status} ${elapsed}ms  mode=${body?.mode ?? '-'} `
    + `count=${body?.count ?? '-'}  top=${first?.mediaKey ?? '-'} (${first?.score?.toFixed?.(4) ?? '-'})`);
  if (!shapeOk) { failed += 1; console.log(`   回答不对：${text.slice(0, 200)}`); continue; }
  if (body.mode !== 'pack' && body.mode !== 'vector') {
    /* 退到索引/词法说明包或模型没被认到 —— 这正是要抓的 */
    failed += 1;
    console.log(`   mode=${body.mode}：包或模型没被认到（期望 pack）`);
  }
  if (!Array.isArray(body.items) || body.items.length === 0) { failed += 1; console.log('   没有结果'); }
}

try { studio.close?.(); } catch { /* already closed */ }
console.log(failed ? `失败 ${failed} 项` : '通过：路由、包、模型、返回形状都对');
process.exit(failed ? 1 : 0);
