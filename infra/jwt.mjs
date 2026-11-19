#!/usr/bin/env node
// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// HS256 JWT 签发/校验（Supabase / PostgREST 同形），零依赖，只用 node: 内置模块。
//
// 用途：本地验 authenticated / service_role / anon 三种身份下的 RLS 与租户回落
// （008 的 app_tenant_key() 第②级就是 request.jwt.claims.app_metadata.company_key）。
//
// 用法：
//   node infra/jwt.mjs --role authenticated --sub <uuid> --company-key t-a          # 打印 token
//   node infra/jwt.mjs --role service_role --ttl 3600                              # 打印 token
//   node infra/jwt.mjs --claims --role authenticated --company-key t-a             # 打印 payload（便于核对）
//   node infra/jwt.mjs --verify <token>                                            # 打印校验结果（true/false）
//   node infra/jwt.mjs --init-secret                                               # 生成 .dev/rest.jwt（不打印内容）
//
// secret 来源（按序）：$PGRST_JWT_SECRET → .dev/rest.jwt（首行）。**绝不打印 secret**。
// 退出码：0 成功；1 参数/校验失败；2 缺 secret。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET_FILE = path.join(ROOT, '.dev', 'rest.jwt');
const MIN_SECRET_BYTES = 32;   // Supabase 要求 JWT secret >= 32 字节

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const b64urlJson = (obj) => b64url(JSON.stringify(obj));

/** 读 secret：环境变量优先，其次 .dev/rest.jwt。读不到返回 null（不打印任何内容）。 */
export function loadSecret() {
  const env = process.env.PGRST_JWT_SECRET;
  if (env && env.trim()) return env.trim();
  if (existsSync(SECRET_FILE)) {
    const first = readFileSync(SECRET_FILE, 'utf8').split(/\r?\n/)[0]?.trim();
    if (first) return first;
  }
  return null;
}

/** 生成 secret 文件（只写盘，不打印）。 */
export function initSecret() {
  mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  if (existsSync(SECRET_FILE)) return false;
  const secret = randomBytes(48).toString('base64url');
  writeFileSync(SECRET_FILE, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(SECRET_FILE, 0o600); } catch { /* Windows 上无实际效果，忽略 */ }
  return true;
}

/**
 * 签一个 HS256 JWT。
 * payload 形如 { role, sub, exp, iat, app_metadata: { company_key } }。
 */
export function signJwt(payload, secret) {
  if (!secret) throw new Error('missing jwt secret');
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload };
  if (body.iat === undefined) body.iat = Math.floor(Date.now() / 1000);
  if (body.exp === undefined) body.exp = body.iat + 3600;

  const signingInput = `${b64urlJson(header)}.${b64urlJson(body)}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

/** 校验签名与过期时间；返回 { valid, payload?, reason? }。 */
export function verifyJwt(token, secret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return { valid: false, reason: 'not-a-jwt' };
  const [h, p, s] = parts;
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: 'bad-signature' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'bad-payload' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) return { valid: false, reason: 'expired', payload };
  return { valid: true, payload };
}

/** PostgREST 认的 claim 形状：role 必须在顶层，租户放 app_metadata。 */
export function makeClaims({ role = 'authenticated', sub, companyKey, ttl = 3600, extra = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    role,
    sub: sub ?? randomUUID(),
    iat: now,
    exp: now + ttl,
    ...extra,
  };
  if (companyKey) {
    claims.app_metadata = { ...(extra.app_metadata ?? {}), company_key: companyKey };
  }
  return claims;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { role: 'authenticated', ttl: 3600, mode: 'token' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--role') opts.role = argv[++i] ?? '';
    else if (a === '--sub') opts.sub = argv[++i] ?? '';
    else if (a === '--company-key') opts.companyKey = argv[++i] ?? '';
    else if (a === '--ttl') opts.ttl = Number.parseInt(argv[++i] ?? '3600', 10);
    else if (a === '--claims') opts.mode = 'claims';
    else if (a === '--verify') { opts.mode = 'verify'; opts.token = argv[++i] ?? ''; }
    else if (a === '--init-secret') opts.mode = 'init-secret';
    else if (a === '--help' || a === '-h') { opts.mode = 'help'; }
    else { console.error(`未知参数：${a}`); process.exit(1); }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === 'help') {
    console.log('usage: node infra/jwt.mjs [--role anon|authenticated|service_role] [--sub UUID] [--company-key KEY] [--ttl SEC]');
    console.log('       node infra/jwt.mjs --claims ...      # 打印 payload（不含 secret）');
    console.log('       node infra/jwt.mjs --verify <token>  # 只打印校验结果');
    console.log('       node infra/jwt.mjs --init-secret     # 生成 .dev/rest.jwt（不打印内容）');
    return 0;
  }

  if (opts.mode === 'init-secret') {
    const created = initSecret();
    console.log(created ? `.dev/rest.jwt 已生成（内容不打印；PGRST_JWT_SECRET 优先）` : `.dev/rest.jwt 已存在，未覆盖`);
    return 0;
  }

  const secret = loadSecret();
  if (!secret) {
    console.error('缺少 JWT secret：设置环境变量 PGRST_JWT_SECRET，或先跑 node infra/jwt.mjs --init-secret');
    return 2;
  }
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    console.error(`JWT secret 太短（<${MIN_SECRET_BYTES} 字节）；Supabase 会拒绝签发。`);
    return 2;
  }

  if (opts.mode === 'verify') {
    const r = verifyJwt(opts.token, secret);
    console.log(JSON.stringify({ valid: r.valid, reason: r.reason ?? null, payload: r.payload ?? null }));
    return r.valid ? 0 : 1;
  }

  const claims = makeClaims({ role: opts.role, sub: opts.sub, companyKey: opts.companyKey, ttl: opts.ttl });
  if (opts.mode === 'claims') {
    // 只回 payload：便于把 app_metadata.company_key 贴进 psql 的 set_config
    console.log(JSON.stringify(claims));
    return 0;
  }

  console.log(signJwt(claims, secret));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
