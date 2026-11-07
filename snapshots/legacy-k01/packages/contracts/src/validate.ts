import { K01_KEY, K01_RULES, type K01Record } from "../generated/ts/K01.ts";

import {
  K07_KEY, K07_FIELDS, K07_SHAPES, K07_DIAGNOSTICS,
  type K07Record,
} from "../generated/ts/K07.ts";

export type ContractKey = typeof K07_KEY | typeof K01_KEY;
export type { K07Record };
export type { K01Record, K01SaveResult } from "../generated/ts/K01.ts";
export type ContractError = Readonly<{ code: string; path: string }>;
export type ContractResult<T = K07Record> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: ContractError }>;

const errors = K07_DIAGNOSTICS.errors;
const fail = (error: ContractError): ContractResult<never> => ({ ok: false, error: { ...error } });
const pass = <T>(value: T): ContractResult<T> => ({ ok: true, value });

type Field = keyof typeof K07_FIELDS;
type FieldRule = {
  const?: string | number; enum?: readonly string[]; pattern?: string; format?: string;
  type?: string; minimum?: number; maximum?: number;
};
const fieldNames = Object.keys(K07_FIELDS) as Field[];
const patterns = new Map(fieldNames.flatMap(name => {
  const rule: FieldRule = K07_FIELDS[name];
  return rule.pattern ? [[name, new RegExp(rule.pattern)] as const] : [];
}));

function validField(name: Field, value: unknown): boolean {
  const rule: FieldRule = K07_FIELDS[name];
  if (rule.const !== undefined && value !== rule.const) return false;
  if (rule.enum && (typeof value !== "string" || !rule.enum.includes(value))) return false;
  if (rule.type === "integer")
    return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= (rule.minimum ?? Number.MIN_SAFE_INTEGER) && value <= (rule.maximum ?? Number.MAX_SAFE_INTEGER);
  if (rule.type === "string" && typeof value !== "string") return false;
  const pattern = patterns.get(name);
  if (pattern && (typeof value !== "string" || !pattern.test(value))) return false;
  if (rule.format === "date-time") {
    const parsed = new Date(value as string);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
  }
  return true;
}

/**
 * Check an already materialized, controlled value (version, shape, then known fields).
 * Use validateContractJson for untrusted JSON: an object cannot recover rounded numbers or lost keys.
 */
export function validateContract(key: ContractKey, input: unknown): ContractResult {
  if (key === K01_KEY) return invalidK01("");
  if (key !== K07_KEY || input === null || typeof input !== "object") return fail(errors.shape);
  let descriptors: PropertyDescriptorMap;
  try {
    if (Array.isArray(input)) return fail(errors.shape);
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    return fail(errors.shape);
  }
  const version = descriptors.schemaVersion;
  if (!version || !Object.hasOwn(version, "value") || version.value !== K07_FIELDS.schemaVersion.const)
    return fail(errors.version);

  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== "string" || !Object.hasOwn(K07_FIELDS, key) ||
      !Object.hasOwn(descriptors[key], "value") || !descriptors[key].enumerable))
    return fail(errors.shape);

  const has = (key: Field) => Object.hasOwn(descriptors, key);
  const read = (key: Field): unknown => descriptors[key]?.value;
  const outcome = read("outcome");
  const eventName = read("eventName");
  const shape = K07_SHAPES.find(branch => branch.eventName === eventName && branch.outcome === (outcome ?? null));
  const isFinish = eventName === K07_SHAPES[1].eventName;
  const required: readonly Field[] = shape?.required ??
    (isFinish ? K07_SHAPES[1].required : K07_SHAPES[0].required);
  const allowed = shape?.required ?? (
    eventName === K07_SHAPES[0].eventName ? K07_SHAPES[0].required : fieldNames);
  const allowedFields: readonly Field[] = allowed;
  if (required.some(key => !has(key)) || fieldNames.some(key => has(key) && !allowedFields.includes(key)))
    return fail(errors.shape);

  const normalized: [Field, unknown][] = [];
  for (const name of fieldNames) {
    if (!has(name)) continue;
    const value = read(name);
    if (!validField(name, value) || (name === "severity" && shape && value !== shape.severity))
      return fail({ code: errors.field.code, path: errors.field.pathPrefix + name });
    normalized.push([name, Object.is(value, -0) ? 0 : value]);
  }
  return pass(Object.fromEntries(normalized) as K07Record);
}

function canonicalLine(record: K07Record): string {
  // The validator always copies only allowed fields in schema order.
  return JSON.stringify(record);
}

/** Encode a controlled value. Use encodeStartupFrameJson for original JSON bytes. */
export function encodeStartupFrame(input: unknown): ContractResult<string> {
  const result = validateContract(K07_KEY, input);
  return result.ok ? pass(canonicalLine(result.value) + "\n") : result;
}

type StartupFailure = {
  errorCode: typeof K07_DIAGNOSTICS.failure.startup | typeof K07_DIAGNOSTICS.failure.loadFile;
  category: typeof K07_DIAGNOSTICS.failure.category;
  retryable: typeof K07_DIAGNOSTICS.failure.retryable;
};

/** The original error is deliberately never inspected or retained. */
export function projectStartupFailure(stage: string, _cause: unknown): ContractResult<StartupFailure> {
  const failure = K07_DIAGNOSTICS.failure;
  if (stage !== "startup" && stage !== "loadFile") return fail(errors.shape);
  return pass({ errorCode: failure[stage], category: failure.category, retryable: failure.retryable });
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type K01Object = Record<string, unknown>;
type K01JsonScope = {
  path: string;
  fields?: readonly string[];
  seen?: Set<string>;
  key?: string;
};
const k01Uuid = new RegExp(K01_RULES.uuidPattern, "u");
const k01TextPattern = new RegExp(K01_RULES.textPattern, "u");
const k01Forbidden = new Set<string>(K01_RULES.forbiddenFields);
const k01Encoder = new TextEncoder();
const invalidK01 = (path: string) => fail({ code: K01_RULES.invalidCode, path });
const k01IsObject = (value: unknown): value is K01Object =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const k01Read = (object: K01Object, field: string): unknown => Object.hasOwn(object, field) ? object[field] : undefined;
const k01IsUuid = (value: unknown): value is string =>
  typeof value === "string" && value.length === K01_RULES.uuidLength && k01Uuid.test(value);
function k01IsText(value: unknown): value is string {
  if (typeof value !== "string" || value.length > K01_RULES.textMaximum * 2 || !k01TextPattern.test(value)) return false;
  const count = [...value].length;
  return count >= K01_RULES.textMinimum && count <= K01_RULES.textMaximum;
}

/** Read original key spellings and integer tokens only after JSON.parse has accepted the entire syntax. */
function scanK01(text: string): { duplicate?: string; version?: string; revision?: string } {
  const scopes: K01JsonScope[] = [];
  let version: string | undefined;
  let revision: string | undefined;
  for (const match of text.matchAll(/("(?:[^"\\]|\\[\s\S])*")(?=\s*:)|"(?:[^"\\]|\\[\s\S])*"|[{}\[\]]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    const token = match[0];
    const parent = scopes.at(-1);
    if (token === "{") {
      const root = parent?.fields === K01_RULES.rootFields;
      const scope = !parent ? { path: "", fields: K01_RULES.rootFields } :
        root && parent.key === "subjectRef" ? { path: "/subjectRef", fields: K01_RULES.subjectFields } :
        root && parent.key === "payload" ? { path: "/payload", fields: K01_RULES.payloadFields } : { path: parent.path };
      scopes.push({ ...scope, seen: new Set() });
    } else if (token === "[") {
      scopes.push({ path: parent?.path ?? "" });
    } else if (token === "}" || token === "]") {
      scopes.pop();
    } else if (match[1]) {
      const key: string = JSON.parse(token);
      const scope = parent!;
      if (scope.seen!.has(key)) {
        const known = scope.fields && (scope.fields.includes(key) || k01Forbidden.has(key));
        return { duplicate: known ? scope.path + "/" + key : scope.path };
      }
      scope.seen!.add(key);
      scope.key = key;
    } else if (token[0] !== '"' && parent?.fields === K01_RULES.rootFields) {
      if (parent.key === "schemaVersion") version = token;
      if (parent.key === "expectedRevision") revision = token;
    }
  }
  return { version, revision };
}

function k01Extra(value: K01Object, fields: readonly string[], path: string): string | undefined {
  for (const key of K01_RULES.forbiddenFields) if (Object.hasOwn(value, key)) return path + "/" + key;
  return Object.keys(value).some(key => !fields.includes(key)) ? path : undefined;
}

function k01PositiveInteger(token: string | undefined, maximum: number): number | undefined {
  if (!token || !/^[1-9][0-9]{0,15}$/.test(token)) return undefined;
  const value = Number(token);
  return value <= maximum ? value : undefined;
}

function validateK01Json(bytes: Uint8Array): ContractResult<K01Record> {
  if (!(bytes instanceof Uint8Array)) return invalidK01("");
  let value: unknown;
  let tokens: ReturnType<typeof scanK01>;
  try {
    const text = decoder.decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) return invalidK01("");
    value = JSON.parse(text);
    tokens = scanK01(text);
  } catch {
    return invalidK01("");
  }
  if (tokens.duplicate !== undefined) return invalidK01(tokens.duplicate);
  if (!k01IsObject(value)) return invalidK01("");
  const version = k01PositiveInteger(tokens.version, K01_RULES.versionMaximum);
  if (version === undefined) return invalidK01("/schemaVersion");
  if (version !== K01_RULES.version) return fail({ code: K01_RULES.unsupportedCode, path: "/schemaVersion" });
  if (k01Read(value, "commandName") !== K01_RULES.command) return invalidK01("/commandName");
  const commandId = k01Read(value, "commandId");
  if (!k01IsUuid(commandId)) return invalidK01("/commandId");
  const key = k01Read(value, "idempotencyKey");
  if (!k01IsUuid(key)) return invalidK01("/idempotencyKey");
  const subject = k01Read(value, "subjectRef");
  if (!k01IsObject(subject)) return invalidK01("/subjectRef");
  if (k01Read(subject, "type") !== K01_RULES.subjectType) return invalidK01("/subjectRef/type");
  const id = k01Read(subject, "id");
  if (!k01IsUuid(id)) return invalidK01("/subjectRef/id");
  const revision = k01PositiveInteger(tokens.revision, K01_RULES.revisionMaximum);
  if (revision === undefined || revision < K01_RULES.revisionMinimum) return invalidK01("/expectedRevision");
  const payload = k01Read(value, "payload");
  if (!k01IsObject(payload)) return invalidK01("/payload");
  const subtitleId = k01Read(payload, "subtitleId");
  if (!k01IsUuid(subtitleId)) return invalidK01("/payload/subtitleId");
  const text = k01Read(payload, "text");
  if (!k01IsText(text)) return invalidK01("/payload/text");
  const extra = k01Extra(value, K01_RULES.rootFields, "") ??
    k01Extra(subject, K01_RULES.subjectFields, "/subjectRef") ?? k01Extra(payload, K01_RULES.payloadFields, "/payload");
  if (extra !== undefined) return invalidK01(extra);
  return pass({ schemaVersion: version, commandName: K01_RULES.command, commandId, idempotencyKey: key,
    subjectRef: { type: K01_RULES.subjectType, id }, expectedRevision: revision, payload: { subtitleId, text } });
}

export type K01DigestInput = Readonly<{ expectedRevision: number; subtitleId: string; text: string }>;

/** Hash only the validated K01 intent, not the serialized request or trusted metadata. */
export async function digestK01Input({ expectedRevision, subtitleId, text }: K01DigestInput): Promise<{ byteLength: number; sha256: string }> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < K01_RULES.revisionMinimum ||
      expectedRevision > K01_RULES.revisionMaximum || !k01IsUuid(subtitleId) || !k01IsText(text))
    throw new TypeError("Expected validated K01 digest fields.");
  const length = k01Encoder.encode(text).byteLength;
  const bytes = k01Encoder.encode(`${K01_RULES.digestDomain}\n${expectedRevision}\n${subtitleId}\n${length}:${text}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  return { byteLength: bytes.byteLength, sha256 };
}


const invalidNumber = Symbol("invalid K07 JSON integer");

/** A JSON fraction or underflow must not become an integer by IEEE-754 rounding. */
function exactInteger(value: number, source: string): boolean {
  if (!Number.isSafeInteger(value)) return false;
  const match = /^-?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(source)!;
  const fraction = match[2] ?? "";
  const digits = (match[1] + fraction).replace(/^0+/, "");
  if (!digits) return true;
  const scale = Number(match[3] ?? 0) - fraction.length;
  return scale >= 0 ? digits.length + scale <= 16 :
    -scale < digits.length && /^0+$/.test(digits.slice(scale));
}

/** JSON.parse already checked grammar. Inspect every key spelling before trusting its result. */
function hasUniqueJsonKeys(text: string): boolean {
  const scopes: Set<string>[] = [];
  for (const match of text.matchAll(/("(?:[^"\\]|\\[\s\S])*")(?=\s*:)|"(?:[^"\\]|\\[\s\S])*"|[{}]/g)) {
    if (match[0] === "{") scopes.push(new Set());
    else if (match[0] === "}") scopes.pop();
    else {
      const decoded: string = JSON.parse(match[0]);
      if (/[\uD800-\uDFFF]/u.test(decoded)) return false; // unmatched UTF-16 escape
      if (!match[1]) continue;
      const scope = scopes[scopes.length - 1];
      if (scope.has(decoded)) return false;
      scope.add(decoded);
    }
  }
  return true;
}

function decodeRecord(key: ContractKey, bytes: Uint8Array, requireCanonical: boolean): ContractResult {
  if (!bytes.length || bytes.length > K07_DIAGNOSTICS.frame.maxLineBytes ||
      (requireCanonical && bytes.includes(13))) return fail(errors.frame);
  try {
    const text = decoder.decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) return fail(errors.frame);
    const parsed: unknown = JSON.parse(text, (_key, value: unknown, context?: { source: string }) =>
      typeof value === "number" && (!context || !exactInteger(value, context.source)) ? invalidNumber : value);
    if (!hasUniqueJsonKeys(text)) return fail(errors.frame);
    const result = validateContract(key, parsed);
    return requireCanonical && result.ok && canonicalLine(result.value) !== text ? fail(errors.frame) : result;
  } catch {
    return fail(errors.frame);
  }
}

/** Validate original UTF-8 JSON object bytes, without NDJSON framing or canonical ordering. */
export function validateContractJson(key: typeof K07_KEY, bytes: Uint8Array): ContractResult<K07Record>;
export function validateContractJson(key: typeof K01_KEY, bytes: Uint8Array): ContractResult<K01Record>;
export function validateContractJson(key: ContractKey, bytes: Uint8Array): ContractResult<K07Record | K01Record>;
export function validateContractJson(key: ContractKey, bytes: Uint8Array): ContractResult<K07Record | K01Record> {
  return key === K01_KEY ? validateK01Json(bytes) : decodeRecord(key, bytes, false);
}

/** Encode an untrusted JSON object from its original bytes; do not parse it first. */
export function encodeStartupFrameJson(bytes: Uint8Array): ContractResult<string> {
  const result = validateContractJson(K07_KEY, bytes);
  return result.ok ? pass(canonicalLine(result.value) + "\n") : result;
}

export const STARTUP_EOF_DEADLINE_MS = K07_DIAGNOSTICS.frame.eofDeadlineMs;
export type StartupBinding = Readonly<{ childId: string; appVersion: string; buildCommit: string }>;
type StartupPair = { begin: K07Record; finish: K07Record };

/** A byte-bounded parser for one trusted launch. The caller owns I/O and the monotonic deadline. */
export class DesktopStartupDiagnosticStream {
  #binding: StartupBinding;
  #line = new Uint8Array(K07_DIAGNOSTICS.frame.maxLineBytes);
  #length = 0;
  #count = 0;
  #begin?: K07Record;
  #finish?: K07Record;
  #result?: ContractResult<StartupPair>;

  constructor(binding: StartupBinding) {
    const { childId, appVersion, buildCommit } = binding;
    this.#binding = { childId, appVersion, buildCommit };
  }

  #settle(result: ContractResult<StartupPair>) {
    this.#line.fill(0);
    this.#length = 0;
    this.#begin = undefined;
    this.#finish = undefined;
    return this.#result = result;
  }

  #accept(record: K07Record): ContractError | undefined {
    const existing = this.#begin?.eventId === record.eventId ? this.#begin :
      this.#finish?.eventId === record.eventId ? this.#finish : undefined;
    if (existing) return canonicalLine(existing) === canonicalLine(record) ? undefined : errors.conflict;

    if (record.appVersion !== this.#binding.appVersion || record.buildCommit !== this.#binding.buildCommit ||
        (this.#begin && this.#begin.traceId !== record.traceId))
      return errors.mismatch;
    if (record.eventName === K07_SHAPES[0].eventName) {
      if (this.#begin) return errors.conflict;
      this.#begin = record;
    } else {
      if (!this.#begin || this.#finish) return errors.conflict;
      this.#finish = record;
    }
  }

  /** A returned error is terminal; stop feeding bytes and discard the original stream. */
  push(childId: string, bytes: Uint8Array): ContractError | undefined {
    if (this.#result) return this.#result.ok ? undefined : { ...this.#result.error };
    const stop = (error: ContractError) => {
      this.#settle(fail(error));
      return { ...error };
    };
    if (childId !== this.#binding.childId) return stop(errors.mismatch);
    for (const byte of bytes) {
      if (this.#count === K07_DIAGNOSTICS.frame.maxRecords) return stop(errors.frame);
      if (byte !== 10) {
        if (this.#length === this.#line.length) return stop(errors.frame);
        this.#line[this.#length++] = byte;
        continue;
      }
      const result = decodeRecord(K07_KEY, this.#line.subarray(0, this.#length), true);
      this.#line.fill(0, 0, this.#length);
      this.#length = 0;
      this.#count++;
      if (!result.ok) return stop(result.error);
      const error = this.#accept(result.value);
      if (error) return stop(error);
    }
  }

  complete(reason: "eof" | "deadline"): ContractResult<StartupPair> {
    if (this.#result) return this.#result;
    if (reason !== "eof") return this.#settle(fail(errors.incomplete));
    if (this.#length > 0) return this.#settle(fail(errors.frame));
    if (!this.#begin || !this.#finish) return this.#settle(fail(errors.incomplete));
    return this.#settle(pass({ begin: this.#begin, finish: this.#finish }));
  }
}
