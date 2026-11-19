// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * Fixed error surface for the Zhishang read-only path plus the supplier status-code table.
 *
 * Two tables, both frozen and both asserted by `errors.test.ts`:
 *  1. `statusOf` — every error code this package may throw, and its HTTP status.
 *  2. `supplierStatus` — the supplier `code` values that are mapped to a first-party error
 *     instead of the generic `provider-unconfirmed` fallback.
 *
 * Supplier status table source: `D:/dev/orange/.dev/zhishang/README.md` (the status-code list
 * transcribed from the supplier document). `.dev/namespace-guard/triage.md` referenced by the
 * task card does not exist at this HEAD; the `.dev/zhishang` list is the only in-repo table, so
 * it is the authority here. Nothing is inferred beyond it: an unknown supplier code stays
 * `provider-unconfirmed`.
 *
 * No supplier `info`/`message` text is ever carried into an error. Supplier prose can echo
 * request parameters and is therefore untrusted data.
 */

const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'invalid-configuration': '智尚只读配置不完整',
  'configuration-required': '缺少可信服务配置',
  'invalid-query': '查询参数不合法',
  'authentication-required': '需要已校验的本人身份',
  'authentication-rejected': '身份被拒绝',
  'authentication-unconfirmed': '身份无法确认',
  'lookup-not-authorized': '账号查询未获授权',
  'binding-required': '缺少有效的本人绑定',
  'binding-changed': '本人绑定在请求期间发生变化',
  'account-not-authorized': '该账号不在可读范围内',
  'authorization-denied': '越权请求',
  'account-not-found': '账号未命中',
  'account-ambiguous': '账号匹配不唯一',
  'account-disabled': '账号已停用',
  'provider-permission-denied': '供应商拒绝访问',
  'provider-credential-expired': '供应商 token 已过期',
  'provider-credential-rejected': '供应商 token 被拒绝',
  'provider-signature-rejected': '供应商签名被拒绝',
  'provider-rate-limited': '供应商限流',
  'provider-timeout': '供应商超时',
  'provider-redirect-rejected': '供应商返回了重定向',
  'provider-response-too-large': '供应商响应体过大',
  'provider-response-unconfirmed': '供应商响应无法确认',
  'provider-unavailable': '供应商端点不可用',
  'provider-unconfirmed': '供应商结果未知',
  'provider-auth-unconfirmed': '供应商鉴权结果未知',
  'provider-clock-unconfirmed': '本机时钟不可信',
  'provider-company-unconfirmed': '公司不存在或未开放',
  'provider-state-unconfirmed': '供应商状态异常',
  'server-credential-required': '缺少服务端凭据',
  'unsupported-operation': '不支持的操作',
  'backend-unconfirmed': '后端结果未知',
  'result-unknown': '结果未知',
  'origin-rejected': '来源不被允许',
  'method-not-allowed': '方法不被允许',
  'not-found': '路径不存在',
  'internal-error': '内部错误',
  'stopping': '服务正在关闭',
  'internal-auth-required': '内部调用凭据缺失或错误',
  'bindings-unreadable': '绑定文件不可读',
  'raw-host-not-allowed': '原片地址主机不在白名单',
  'raw-type-not-allowed': '原片扩展名不受支持',
  'raw-too-large': '原片超过大小上限',
  'raw-download-failed': '原片下载失败',
  'staging-write-failed': '写入暂存目录失败',
  'staging-not-directory': '暂存目录不存在或不可用',
  'binding-store-readonly': '绑定存储为只读模式',
  'binding-store-unavailable': '绑定存储不可写',
  'binding-store-write-failed': '绑定写入失败',
  'binding-account-not-found': '云管家账号未命中',
  'binding-account-required': '需要用云管家登录账号认领',
  'material-inner-unreachable': '当前为内网模式，内网素材地址不可达',
  'bindings-invalid': '绑定文件格式非法',
});

const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'invalid-configuration': 503,
  'configuration-required': 503,
  'invalid-query': 422,
  'authentication-required': 403,
  'authentication-rejected': 403,
  'authentication-unconfirmed': 503,
  'lookup-not-authorized': 403,
  'binding-required': 403,
  'binding-changed': 403,
  'account-not-authorized': 403,
  'authorization-denied': 403,
  'account-not-found': 404,
  'account-ambiguous': 409,
  'account-disabled': 403,
  'provider-permission-denied': 403,
  'provider-credential-expired': 401,
  'provider-credential-rejected': 403,
  'provider-signature-rejected': 502,
  'provider-rate-limited': 429,
  'provider-timeout': 504,
  'provider-redirect-rejected': 502,
  'provider-response-too-large': 502,
  'provider-response-unconfirmed': 502,
  'provider-unavailable': 502,
  'provider-unconfirmed': 503,
  'provider-auth-unconfirmed': 503,
  'provider-clock-unconfirmed': 503,
  'provider-company-unconfirmed': 503,
  'provider-state-unconfirmed': 503,
  'server-credential-required': 503,
  'unsupported-operation': 422,
  'backend-unconfirmed': 503,
  'result-unknown': 503,
  'origin-rejected': 403,
  'method-not-allowed': 405,
  'not-found': 404,
  'internal-error': 500,
  'stopping': 503,
  'internal-auth-required': 403,
  'bindings-unreadable': 503,
  'raw-host-not-allowed': 403,
  'raw-type-not-allowed': 422,
  'raw-too-large': 413,
  'raw-download-failed': 502,
  'staging-write-failed': 500,
  'staging-not-directory': 503,
  'binding-store-readonly': 409,
  'binding-store-unavailable': 503,
  'binding-store-write-failed': 500,
  'binding-account-not-found': 400,
  'binding-account-required': 422,
  'material-inner-unreachable': 503,
  'bindings-invalid': 503,
});

/** Supplier `code` values with a first-party meaning. `0`/`1` are handled at the envelope. */
export const supplierStatus: Readonly<Record<string, string>> = Object.freeze({
  '0': 'provider-unconfirmed',
  // 20000 is the supplier rejecting *our* request, not the caller's parameters: never surface it as
  // invalid-query, which would blame the user for a shape we got wrong.
  '20000': 'provider-response-unconfirmed',
  '20001': 'provider-timeout',
  '20002': 'provider-rate-limited',
  '20010': 'provider-company-unconfirmed',
  '20011': 'provider-unavailable',
  '20012': 'provider-state-unconfirmed',
  '20013': 'provider-credential-expired',
  '20014': 'provider-credential-rejected',
  '20015': 'provider-signature-rejected',
  '20020': 'account-not-found',
  '20022': 'authorization-denied',
});

export function supplierFailure(code: unknown): string {
  if (typeof code !== 'number' || !Number.isSafeInteger(code)) return 'provider-unconfirmed';
  return supplierStatus[String(code)] ?? 'provider-unconfirmed';
}

export function statusOf(code: string): number {
  return STATUS[code] ?? 503;
}

export class SupplierError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status?: number) {
    super(code);
    this.code = code;
    this.status = status ?? statusOf(code);
  }
}

export const fail = (code: string, status?: number): never => {
  throw new SupplierError(code, status);
};

export type PublicError = Readonly<{ code: string; status: number; message: string }>;

/**
 * The only shape an HTTP layer may return for a failure. A registered code is preserved even when
 * it comes from another trusted module's error object (`supabase.ts`, admission); anything else
 * collapses to `provider-unconfirmed`. The thrown message is never echoed — it may hold supplier
 * text, a request parameter, or a path.
 */
export function toPublicError(error: unknown): PublicError {
  const raised=error&&typeof error==='object'?(error as {code?:unknown}).code:undefined;
  const code=error instanceof SupplierError?error.code:typeof raised==='string'&&Object.hasOwn(STATUS,raised)?raised:'provider-unconfirmed';
  const candidate=error&&typeof error==='object'?(error as {status?:unknown}).status:undefined;
  const status=Number.isInteger(candidate)&&(candidate as number)>=400&&(candidate as number)<=599?candidate as number:statusOf(code);
  return Object.freeze({code,status,message:MESSAGES[code]??'请求失败'});
}

export function messageOf(code: string): string {
  return MESSAGES[code] ?? '请求失败';
}

export function knownCodes(): readonly string[] {
  return Object.freeze(Object.keys(STATUS).sort());
}
