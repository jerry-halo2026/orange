const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const {
  DesktopStartupDiagnosticStream, digestK01Input, encodeStartupFrame, encodeStartupFrameJson, projectStartupFailure, validateContract, validateContractJson,
} = require("../../../packages/contracts/src/validate.ts") as typeof import("../../../packages/contracts/src/validate.ts");

type StartupBinding = import("../../../packages/contracts/src/validate.ts").StartupBinding;
type ContractKey = import("../../../packages/contracts/src/validate.ts").ContractKey;
type RawFixture = { text: string; hex?: never } | { hex: string; text?: never };
type FixtureInput =
  | { kind: "object" | "encode"; input: unknown }
  | { kind: "json" | "json-encode"; input: RawFixture }
  | { kind: "projection"; input: { stage: string; cause: { message: string; stack: string } } }
  | { kind: "stream"; input: {
      expectedBinding: StartupBinding;
      completion: "eof" | "deadline";
      items: ({ childId: string } & RawFixture)[];
    } };
type Fixture = {
  pack: string; slice: ContractKey;
  sentinels: string[];
  cases: (FixtureInput & { id: string; expected: { ok: boolean; value?: unknown; error?: { code: string; path: string } } })[];
};
const packArg = process.argv.slice(2).filter(arg => arg !== "--");
assert.ok(packArg.length === 0 || (packArg.length === 2 && packArg[0] === "--pack" &&
  ["K01", "K07"].includes(packArg[1])), "expected --pack K01, --pack K07 or no pack filter");

function registerK07(): void {
  const fixture: Fixture = JSON.parse(readFileSync(join(__dirname, "../fixtures/K07/cases.json"), "utf8"));
  assert.equal(fixture.pack, "K07");
  assert.equal(fixture.slice, "K07.desktop-startup.v1");
  assert.ok(fixture.cases.length > 0, "no matching contract cases");
  assert.equal(new Set(fixture.cases.map(({ id }) => id)).size, fixture.cases.length);

  const bytesOf = (input: RawFixture) => input.hex !== undefined ? Buffer.from(input.hex, "hex") : Buffer.from(input.text, "utf8");

  for (const { kind, id, input, expected } of fixture.cases) {
    test(`[K07] ${kind}: ${id}`, () => {
      let result: unknown;
      switch (kind) {
        case "object": result = validateContract(fixture.slice, input); break;
        case "encode": result = encodeStartupFrame(input); break;
        case "json": result = validateContractJson(fixture.slice, bytesOf(input)); break;
        case "json-encode": result = encodeStartupFrameJson(bytesOf(input)); break;
        case "projection": {
          const cause = new Error(input.cause.message);
          cause.stack = input.cause.stack;
          result = projectStartupFailure(input.stage, cause);
          break;
        }
        case "stream": {
          const stream = new DesktopStartupDiagnosticStream(input.expectedBinding);
          let pushError;
          for (const item of input.items) {
            const bytes = bytesOf(item);
            const error = stream.push(item.childId, bytes);
            if (error && pushError === undefined) pushError = error;
          }
          result = stream.complete(input.completion);
          if (expected.error?.code === "DIAGNOSTIC_FRAME" && input.completion === "deadline") {
            assert.equal(pushError?.code, "DIAGNOSTIC_FRAME", "frame limit must reject before completion");
          }
          break;
        }
        default: assert.fail("unrecognized fixture kind");
      }
      const safeJson = JSON.stringify(result);
      assert.ok(fixture.sentinels.every((sentinel: string) => !safeJson.includes(sentinel)), "output leaked a synthetic sentinel");
      assert.deepEqual(result, expected);
    });
  }

  type TestSchema = {
    properties: Record<string, Record<string, unknown>>;
    oneOf: { properties: Record<string, unknown>; not?: { anyOf: { required: string[] }[] } }[];
  } & Record<string, unknown>;

  const mutations: [string, (schema: TestSchema) => void][] = [
    ["unsupported root maximum property count", schema => { schema.maxProperties = 9; }],
    ["missing root object type", schema => { delete schema.type; }],
    ["missing root required", schema => { delete schema.required; }],
    ["unsupported branch constraint", schema => { Object.assign(schema.oneOf[0], { minProperties: 99 }); }],
    ["unsupported branch field constraint", schema => { Object.assign(schema.oneOf[0].properties.severity as object, { not: { const: "info" } }); }],
    ["missing branch exclusion", schema => { delete schema.oneOf[0].not; }],
    ["branch exclusion contains unknown key", schema => { Object.assign(schema.oneOf[0].not!.anyOf[0], { minProperties: 99 }); }],
    ["missing Gregorian format", schema => { delete schema.properties.timestamp.format; }],
    ["missing integer bound", schema => { delete schema.properties.durationMs.maximum; }],
    ["unsupported field constraint", schema => { schema.properties.buildCommit.maxLength = 4; }],
    ["unhandled version bound", schema => { schema.properties.schemaVersion.maximum = 0; }],
  ];

  for (const [label, mutate] of mutations) {
    test("[K07] generator fails closed: " + label, (t: import("node:test").TestContext) => {
      const { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const { basename, dirname, relative, resolve, sep } = require("node:path") as typeof import("node:path");
      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      const temp = realpathSync(tmpdir());
      const dir = mkdtempSync(join(temp, "orange-k07-schema-"));
      t.after(() => {
        const target = realpathSync(dir);
        const child = relative(temp, target);
        assert.ok(child === basename(dir) && child.startsWith("orange-k07-schema-") && !child.includes(sep));
        rmSync(target, { recursive: true });
      });

      const root = resolve(__dirname, "../../..");
      const schemaFile = "packages/contracts/schemas/K07/v1.schema.json";
      const generator = "tools/contracts/generate.mjs";
      const artifacts = [
        "packages/contracts/generated/ts/K07.ts",
        "packages/contracts/generated/dotnet/K07.g.cs",
      ];
      for (const file of [schemaFile, generator, ...artifacts]) {
        const dest = join(dir, file);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(root, file), dest);
      }
      const schema: TestSchema = JSON.parse(readFileSync(join(dir, schemaFile), "utf8"));
      mutate(schema);
      writeFileSync(join(dir, schemaFile), JSON.stringify(schema));

      for (const args of [["--check"], []]) {
        const result = spawnSync(process.execPath, [join(dir, generator), ...args], { encoding: "utf8" });
        assert.ifError(result.error);
        assert.equal(result.status, 1, "generator must refuse unsupported schema in both modes");
        assert.match(result.stderr, /Unsupported K07 schema/);
      }
      for (const file of artifacts) assert.deepEqual(readFileSync(join(dir, file)), readFileSync(join(root, file)));
    });
  }
}

const k01Key = "K01.project.subtitle_text.replace.v1";
type K01CanonicalInput = import("../../../packages/contracts/src/validate.ts").K01DigestInput;

type K01Scope = { actorUserId: string; commandName: string; projectId: string };
type K01Receipt = { commandId: string; projectRevisionId: string; revision: number };
type K01StoredOutcome = {
  commandId: string; idempotencyKey: string; canonicalInput: K01CanonicalInput;
  result?: K01Receipt; scope?: K01Scope;
};
type K01State = {
  actorUserId: string | null; verifiedLocalEditSession: boolean;
  project: { id: string; ownerUserId: string; headRevision: number; subtitle: { id: string; text: string } } | null;
  storedOutcome: K01StoredOutcome | null;
  simulatedAllocatedProjectRevisionId: string;
};
const readK01 = (bytes: Uint8Array) => validateContractJson(k01Key, bytes);

const k01Failure = (code: string, path: string, currentRevision?: number) => ({
  ok: false, error: currentRevision === undefined ? { code, path } : { code, path, currentRevision }, writes: 0,
});

// A synthetic single-record model: the signed fixture provides a current trusted project
// snapshot. A write advances that snapshot and records the receipt in test memory only.
async function modelK01(bytes: Uint8Array, state: K01State) {
  const parsed = readK01(bytes);
  if (!parsed.ok) return { ...parsed, writes: 0 };
  const { commandName, commandId, idempotencyKey, subjectRef, expectedRevision, payload } = parsed.value;
  const { actorUserId, verifiedLocalEditSession, project } = state;
  if (!verifiedLocalEditSession || !actorUserId || !project ||
      project.ownerUserId !== actorUserId || project.id !== subjectRef.id)
    return k01Failure("ACCESS_DENIED", "");

  const stored = state.storedOutcome;
  const scope = stored?.scope;
  if (stored && (!scope || (scope.actorUserId === actorUserId && scope.commandName === commandName && scope.projectId === project.id))) {
    if (stored.idempotencyKey === idempotencyKey) {
      const digest = await digestK01Input({ expectedRevision, ...payload });
      if (stored.commandId !== commandId || (await digestK01Input(stored.canonicalInput)).sha256 !== digest.sha256)
        return k01Failure("IDEMPOTENCY_CONFLICT", "/idempotencyKey");
      return stored.result ? { ok: true, result: stored.result, writes: 0 } : k01Failure("OUTCOME_UNKNOWN", "");
    }
    if (stored.commandId === commandId)
      return k01Failure("IDEMPOTENCY_CONFLICT", "/idempotencyKey");
  }
  if (expectedRevision !== project.headRevision)
    return k01Failure("REVISION_CONFLICT", "/expectedRevision", project.headRevision);
  if (payload.subtitleId !== project.subtitle.id)
    return k01Failure("CONTRACT_INVALID", "/payload/subtitleId");
  if (payload.text === project.subtitle.text)
    return k01Failure("CONTRACT_INVALID", "/payload/text");
  const result = { commandId, projectRevisionId: state.simulatedAllocatedProjectRevisionId, revision: project.headRevision + 1 };
  project.headRevision = result.revision;
  project.subtitle.text = payload.text;
  state.storedOutcome = { idempotencyKey, commandId, canonicalInput: { expectedRevision, ...payload }, result };
  return { ok: true, result, writes: 1 };
}


type K01ErrorSchemaRule = {
  oneOf?: K01ErrorSchemaRule[];
  type?: "object" | "string" | "integer";
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, K01ErrorSchemaRule>;
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
};

// Interpret only the vocabulary used by $defs.error; refuse unsupported rules.
const k01ErrorSchemaKeywords = new Set([
  "oneOf", "type", "additionalProperties", "required", "properties", "const", "enum", "minimum", "maximum",
]);
function matchesK01ErrorRule(rule: K01ErrorSchemaRule, value: unknown): boolean {
  for (const key of Object.keys(rule)) assert.ok(k01ErrorSchemaKeywords.has(key), "unsupported K01 error schema keyword: " + key);
  if (rule.oneOf && rule.oneOf.filter(branch => matchesK01ErrorRule(branch, value)).length !== 1) return false;
  if (Object.hasOwn(rule, "const") && !Object.is(rule.const, value)) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (rule.type === "string" && typeof value !== "string") return false;
  if (rule.type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) return false;
  if (rule.minimum !== undefined && (typeof value !== "number" || value < rule.minimum)) return false;
  if (rule.maximum !== undefined && (typeof value !== "number" || value > rule.maximum)) return false;
  if (rule.type === "object" || rule.required || rule.properties) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (rule.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (rule.properties)
      for (const [key, member] of Object.entries(value)) {
        if (Object.hasOwn(rule.properties, key)) {
          if (!matchesK01ErrorRule(rule.properties[key], member)) return false;
        } else if (rule.additionalProperties === false) return false;
      }
  }
  return true;
}

function registerK01(): void {
  const signed = readFileSync(join(__dirname, "../fixtures/K01/cases.json"));
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  assert.equal(createHash("sha256").update(signed).digest("hex"),
    "1bd42bdf3b0233ae39384434a146d4cee912dfb89f76a53ddd6566881622f506");
  const fixture: { draftRevision: number; cases: { id: string;
    input: { wireJson: string; trustedFixtureState: K01State }; expected: { ok: true } | { ok: false; error: unknown } }[] } = JSON.parse(signed.toString("utf8"));
  assert.equal(fixture.draftRevision, 3);
  assert.equal(fixture.cases.length, 32);
  assert.equal(new Set(fixture.cases.map(row => row.id)).size, 32);
  for (const { id, input, expected } of fixture.cases)
    test("[K01] signed: " + id, async () => {
      assert.deepEqual(await modelK01(Buffer.from(input.wireJson, "utf8"), structuredClone(input.trustedFixtureState)), expected);
    });


  const { $defs: { error: errorSchema } }: { $defs: { error: K01ErrorSchemaRule } } = JSON.parse(
    readFileSync(join(__dirname, "../../../packages/contracts/schemas/K01/v1.schema.json"), "utf8"));
  test("[K01] outward error schema accepts all signed errors and registered nested diagnostics", () => {
    const signedErrors = fixture.cases.flatMap(({ expected }) => expected.ok ? [] : [expected.error]);
    assert.equal(signedErrors.length, 30);
    for (const error of [...signedErrors,
      { code: "CONTRACT_INVALID", path: "/subjectRef/eventId" },
      { code: "CONTRACT_INVALID", path: "/payload/authorizationContextRef" },
      { code: "CONTRACT_INVALID", path: "/subjectRef" },
    ]) assert.ok(matchesK01ErrorRule(errorSchema, error), JSON.stringify(error));
  });
  for (const [label, code, path] of [
    ["not a JSON Pointer", "ACCESS_DENIED", "not-a-pointer"],
    ["private unregistered path", "CONTRACT_INVALID", "/payload/unregistered"],
    ["version path missing", "UNSUPPORTED_VERSION", ""],
    ["idempotency path points to revision", "IDEMPOTENCY_CONFLICT", "/expectedRevision"],
    ["unknown outcome exposes field", "OUTCOME_UNKNOWN", "/subjectRef/id"],
  ]) {
    test("[K01] outward error schema rejects " + label, () => {
      assert.equal(matchesK01ErrorRule(errorSchema, { code, path }), false, JSON.stringify({ code, path }));
    });
  }

  // Supplemental N1 assertions; not part of the byte-exact signed N0 fixture.
  const first = fixture.cases[0];
  const wire = first.input.wireJson;
  const invalid = (path: string) => ({ ok: false, error: { code: "CONTRACT_INVALID", path } });
  const edgeCases: [string, Uint8Array, unknown][] = [
    ["BOM", Buffer.concat([Buffer.from("efbbbf", "hex"), Buffer.from(wire)]), invalid("")],
    ["invalid UTF-8", Buffer.concat([Buffer.from('{"text":"'), Buffer.from("eda080", "hex"), Buffer.from('"}')]), invalid("")],
    ["syntax precedes duplicate", Buffer.from('{"schemaVersion":1,"schemaVersion":2,}'), invalid("")],
    ["first duplicate precedes version and later duplicates", Buffer.from('{"payload":{"text":1,"te\\u0078t":2},"schemaVersion":2,"schemaVersion":1}'), invalid("/payload/text")],
    ["nested unknown duplicate redacts path", Buffer.from('{"payload":{"unlisted":[{"actorUserId":1,"actorUserId":2}]},"schemaVersion":2}'), invalid("/payload")],
    ["duplicates inside root array precede root shape but redact", Buffer.from('[{"schemaVersion":1,"schemaVersion":1}]'), invalid("")],
    ["known field validation precedes extras", Buffer.from(wire.replace('"expectedRevision":7', '"expectedRevision":7.0,"actorUserId":0')), invalid("/expectedRevision")],
    ["exponent version token", Buffer.from(wire.replace('"schemaVersion":1', '"schemaVersion":1e0')), invalid("/schemaVersion")],
    ["rounded oversized version token", Buffer.from(wire.replace('"schemaVersion":1', '"schemaVersion":9007199254740992')), invalid("/schemaVersion")],
    ["max supported numeric token but unsupported version", Buffer.from(wire.replace('"schemaVersion":1', '"schemaVersion":9007199254740991')),
      { ok: false, error: { code: "UNSUPPORTED_VERSION", path: "/schemaVersion" } }],
    ["nested known extras beat nested unknown extras", Buffer.from(wire.replace('"subtitleId"', '"unknownSentinel":0,"eventId":0,"actorUserId":0,"subtitleId"')), invalid("/payload/actorUserId")],
    ["C1 control", Buffer.from(wire.replace("你好，Ethan！", "\\u0085")), invalid("/payload/text")],
    ["501 scalars", Buffer.from(wire.replace("你好，Ethan！", "😀".repeat(501))), invalid("/payload/text")],
  ];
  for (const [id, bytes, expected] of edgeCases)
    test("[K01] supplemental wire: " + id, () => assert.deepEqual(readK01(bytes), expected));

  test("[K01] supplemental wire: object and byte buffer do not pass object entry", () => {
    assert.deepEqual(validateContract(k01Key, JSON.parse(wire)), invalid(""));
    assert.deepEqual(validateContract(k01Key, Buffer.from(wire)), invalid(""));
  });
  test("[K01] supplemental wire: 500 scalars, LF and spaces preserved, max revision", () => {
    const text = " " + "😀".repeat(497) + "\n ";
    const raw = wire.replace("你好，Ethan！", JSON.stringify(text).slice(1, -1))
      .replace('"expectedRevision":7', '"expectedRevision":9007199254740990');
    const actual = readK01(Buffer.from(raw));
    assert.ok(actual.ok);
    assert.equal(actual.value.payload.text, text);
    assert.equal(actual.value.expectedRevision, 9007199254740990);
  });
  test("[K01] supplemental digest: canonical 103-byte vector and scalar sensitivity", async () => {
    const expected = { byteLength: 103, sha256: "ceefc161aca6b1d8d5294b418277b4b5e136211937125a1cbf1753fe3aca42ba" };
    const canonical = { expectedRevision: 7, subtitleId: "22222222-2222-4222-8222-222222222222", text: "你好，Ethan！" };
    assert.deepEqual(await digestK01Input(canonical), expected);
    const reordered = fixture.cases[1].input.wireJson.replace("你好", "\\u4f60\\u597d");
    const equivalent = readK01(Buffer.from(reordered));
    assert.ok(equivalent.ok);
    assert.deepEqual(await digestK01Input({ expectedRevision: equivalent.value.expectedRevision, ...equivalent.value.payload }), expected);
    const [composed, decomposed, otherRevision, otherSubtitle] = await Promise.all([
      digestK01Input({ ...canonical, text: "é" }),
      digestK01Input({ ...canonical, text: "e\u0301" }),
      digestK01Input({ ...canonical, expectedRevision: 8 }),
      digestK01Input({ ...canonical, subtitleId: "88888888-8888-4888-8888-888888888888" }),
    ]);
    assert.notEqual(composed.sha256, decomposed.sha256);
    assert.notEqual(otherRevision.sha256, expected.sha256);
    assert.notEqual(otherSubtitle.sha256, expected.sha256);
  });

  test("[K01] supplemental digest: shared contract loads without Node modules", () => {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const { pathToFileURL } = require("node:url") as typeof import("node:url");
    const entry = pathToFileURL(join(__dirname, "../../../packages/contracts/src/validate.ts")).href;
    // Emulate a browser's ESM graph: permit relative package modules and Web APIs,
    // but do not provide require, process, Buffer, or any built-in Node module.
    const program = String.raw`
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { stripTypeScriptTypes } from "node:module";
      import { createContext, SourceTextModule } from "node:vm";
      const context = createContext({ TextDecoder, TextEncoder, Uint8Array, crypto: globalThis.crypto });
      const modules = new Map();
      function load(url) {
        if (!modules.has(url.href)) {
          const source = stripTypeScriptTypes(readFileSync(url, "utf8"));
          modules.set(url.href, new SourceTextModule(source, { context, identifier: url.href }));
        }
        return modules.get(url.href);
      }
      const root = load(new URL(process.argv[1]));
      await root.link((name, referring) => {
        if (!name.startsWith("./") && !name.startsWith("../")) throw new Error("Non-portable contract import: " + name);
        return load(new URL(name, referring.identifier));
      });
      await root.evaluate();
      const { validateContractJson, digestK01Input } = root.namespace;
      const result = validateContractJson("K01.project.subtitle_text.replace.v1", new TextEncoder().encode(process.argv[2]));
      assert.equal(result.ok, true);
      const digest = await digestK01Input({ expectedRevision: result.value.expectedRevision, ...result.value.payload });
      assert.equal(digest.byteLength, 103);
      assert.equal(digest.sha256, "ceefc161aca6b1d8d5294b418277b4b5e136211937125a1cbf1753fe3aca42ba");
    `;
    const child = spawnSync(process.execPath,
      ["--experimental-vm-modules", "--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", program, entry, wire],
      { encoding: "utf8", timeout: 15_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
  });

  for (const dimension of ["actorUserId", "commandName", "projectId"] as const) {
    test("[K01] supplemental model: stored key and command ID invisible across " + dimension, async () => {
      const baseState = first.input.trustedFixtureState;
      const scope: K01Scope = { actorUserId: baseState.actorUserId!, commandName: "project.subtitle_text.replace", projectId: baseState.project!.id };
      scope[dimension] = "different synthetic " + dimension;
      const storedOutcome = { ...fixture.cases[1].input.trustedFixtureState.storedOutcome!, scope };
      for (const raw of [wire, wire.replace(storedOutcome.idempotencyKey, "88888888-8888-4888-8888-888888888888")])
        assert.deepEqual(await modelK01(Buffer.from(raw), { ...structuredClone(baseState), storedOutcome }), first.expected);
    });
  }
  test("[K01] supplemental model: reject, correct same key, and replay one committed write", async () => {
    const state = structuredClone(first.input.trustedFixtureState);
    const stale = Buffer.from(wire.replace('"expectedRevision":7', '"expectedRevision":6'));
    assert.deepEqual(await modelK01(stale, state), k01Failure("REVISION_CONFLICT", "/expectedRevision", 7));
    assert.equal(state.storedOutcome, null);
    assert.deepEqual(await modelK01(Buffer.from(wire), state), first.expected);
    assert.equal(state.project?.headRevision, 8);
    assert.deepEqual(await modelK01(Buffer.from(wire), state), fixture.cases[1].expected);
  });
  test("[K01] supplemental model: denied input never queries an outcome", async () => {
    const state = { ...first.input.trustedFixtureState, verifiedLocalEditSession: false,
      get storedOutcome(): K01StoredOutcome | null { assert.fail("denied input queried a stored outcome"); } };
    assert.deepEqual(await modelK01(Buffer.from(wire), state), k01Failure("ACCESS_DENIED", ""));
  });
}

if (packArg.length === 0 || packArg[1] === "K07") registerK07();
if (packArg.length === 0 || packArg[1] === "K01") registerK01();