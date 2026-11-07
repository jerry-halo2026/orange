const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const {
  DesktopStartupDiagnosticStream, encodeStartupFrame, encodeStartupFrameJson, projectStartupFailure, validateContract, validateContractJson,
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
const fixture: Fixture = JSON.parse(readFileSync(join(__dirname, "../fixtures/K07/cases.json"), "utf8"));
const packArg = process.argv.slice(2).filter(arg => arg !== "--");
assert.ok(packArg.length === 0 || (packArg.length === 2 && packArg[0] === "--pack" && packArg[1] === fixture.pack), "expected --pack K07 or no pack filter");
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
