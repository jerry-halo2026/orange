import {
  K07_KEY, K07_FIELDS, K07_SHAPES, K07_DIAGNOSTICS,
  type K07Record,
} from "../generated/ts/K07.ts";

export type ContractKey = typeof K07_KEY;
export type { K07Record };
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
export function validateContractJson(key: ContractKey, bytes: Uint8Array): ContractResult {
  return decodeRecord(key, bytes, false);
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
