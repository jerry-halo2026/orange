#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// 给"需要 5432 的命令"临时开一条直连出口，跑完立刻恢复。
//
//   node scripts/supabase-route.mjs -- node infra/migrate.mjs --target cloud
//   node scripts/supabase-route.mjs -- node infra/verify.mjs --target cloud
//   node scripts/supabase-route.mjs --check          # 只报告：当前 mode + 池化器 5432 是否可连
//
// # 为什么需要它
//
// 本机的 mihomo 是 TUN + fake-ip，只有 443 被隧道（实测：443 到 Supabase 正常，5432 一律在 TLS 握手前被断开）。
// Supabase 的直连主机 `db.<ref>.supabase.co` 又只有 AAAA，而本机没有全局 IPv6 —— 两条路都堵着。
// 唯一可用的出入口是 **session pooler 的 5432 走 DIRECT**（它在 AWS 上有 A 记录）。
//
// 这台机器上 mihomo 的 `PUT /configs` 重载被拒（400，配置由 LILISI 那层托管），所以加规则这条路走不通，
// 只剩"临时切 mode=direct"这一招。它是**全局**的，因此：
//   1. 只在命令执行期间生效，`finally` 恢复原值（Ctrl+C 也走 finally）；
//   2. 干的是"灌库/迁移"这种分钟级的事，不是常开；
//   3. 恢复失败会以非零码退出并吼一声——宁可让人看到，也不要静默留在 direct。
import { spawn } from 'node:child_process';
import net from 'node:net';

const API = process.env.MIHOMO_API || 'http://127.0.0.1:9090';
const POOLER = process.env.SUPABASE_POOLER_HOST || 'aws-0-ap-northeast-2.pooler.supabase.com';
const POOLER_PORT = 5432;

async function readMode() {
  const response = await fetch(`${API}/configs`);
  if (!response.ok) throw new Error(`读不到 mihomo 配置（HTTP ${response.status}）`);
  return (await response.json()).mode;
}

async function setMode(mode) {
  const response = await fetch(`${API}/configs`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error(`切换 mode=${mode} 失败（HTTP ${response.status}）`);
}

function probe(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('error', () => done(false));
    socket.once('connect', () => done(true));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const dashDash = argv.indexOf('--');
  const command = dashDash === -1 ? [] : argv.slice(dashDash + 1);
  const checkOnly = argv.includes('--check') || command.length === 0;

  const before = await readMode().catch((error) => { console.error(error.message); return null; });
  if (before === null) {
    /* 代理没开也能跑：那就当"没有东西需要绕过"，直接把命令交出去。 */
    if (checkOnly) return 1;
    return runCommand(command);
  }

  if (checkOnly) {
    const direct = await probe(POOLER, POOLER_PORT).catch(() => false);
    console.log(`mode=${before}  pooler=${POOLER}:${POOLER_PORT} reachable=${direct}`);
    if (before === 'rule') console.log('（rule 模式下 5432 通常不可达——需要直连出口时用 `-- <命令>` 包一层）');
    return direct ? 0 : 1;
  }

  const touched = before !== 'direct';
  if (touched) {
    await setMode('direct');
    console.log(`route: mihomo mode ${before} → direct（命令结束自动恢复）`);
  }
  try {
    return await runCommand(command);
  } finally {
    if (touched) {
      try {
        await setMode(before);
        console.log(`route: mihomo mode 已恢复 ${before}`);
      } catch (error) {
        console.error(`route: 恢复 mode=${before} 失败：${error.message}（请手动改回）`);
        process.exitCode = 3;
      }
    }
  }
}

function runCommand(command) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
    child.once('exit', (code) => resolve(code ?? 1));
    child.once('error', (error) => { console.error(`route: 启动失败 ${error.message}`); resolve(1); });
  });
}

process.on('SIGINT', () => { process.exitCode = 130; });
main().then((code) => process.exit(code)).catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
