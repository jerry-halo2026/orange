import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  process.stderr.write("Usage: node tools/contracts/generate.mjs [--check]\n");
  process.exit(2);
}
const check = args[0] === "--check";
const base = new URL("../../packages/contracts/", import.meta.url);
const schema = JSON.parse(await readFile(new URL("schemas/K07/v1.schema.json", base), "utf8"));
// These are the shapes consumed by the generated runtime templates, not a general JSON Schema engine.
// Require every supported keyword and reject all others before reading constraints or generating artifacts.
const keywordLayout = {
  schemaVersion: ["type", "const"],
  eventName: ["enum"],
  component: ["const"],
  timestamp: ["type", "pattern", "format"],
  traceId: ["type", "pattern"],
  eventId: ["type", "pattern"],
  environment: ["const"],
  appVersion: ["type", "pattern"],
  buildCommit: ["type", "pattern"],
  severity: ["enum"],
  outcome: ["enum"],
  durationMs: ["type", "minimum", "maximum"],
  errorCode: ["enum"],
};
const orderedNames = Object.keys(keywordLayout);
const common = orderedNames.slice(0, 10);
const phaseFields = [
  ["begin", common, ["eventName", "severity"]],
  ["finishOk", [...common, "outcome", "durationMs"], ["eventName", "severity", "outcome"]],
  ["finishFailed", orderedNames, ["eventName", "severity", "outcome"]],
];

function expect(condition, scope) {
  if (!condition) throw new Error("Unsupported K07 schema (" + scope + ").");
}
function keys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function list(value, expected) {
  return Array.isArray(value) && value.length === expected.length && expected.every((item, i) => item === value[i]);
}
function ascii(value) {
  return typeof value === "string" && /^[\x20-\x7e]+$(?![\s\S])/.test(value);
}
function enumStrings(value) {
  return Array.isArray(value) && value.length === 2 && value.every(ascii) && new Set(value).size === value.length;
}

expect(keys(schema, ["$schema", "$id", "title", "description", "type", "additionalProperties",
  "required", "properties", "oneOf", "x-orange-k07"]) &&
  schema.$schema === "https://json-schema.org/draft/2020-12/schema" &&
  schema.$id === "urn:orange:contracts:K07:desktop-startup:v1" &&
  schema.title === "K07.desktop-startup.v1" && ascii(schema.description) &&
  schema.type === "object" && schema.additionalProperties === false && list(schema.required, common) &&
  keys(schema.properties, orderedNames) && list(Object.keys(schema.properties), orderedNames) &&
  Array.isArray(schema.oneOf) && schema.oneOf.length === phaseFields.length, "root");

for (const [name, expected] of Object.entries(keywordLayout)) {
  const rule = schema.properties[name];
  expect(keys(rule, expected), name);
  if (expected.includes("pattern")) {
    expect(rule.type === "string" && ascii(rule.pattern), name);
    try { new RegExp(rule.pattern); } catch { expect(false, name); }
  }
  if (expected.includes("enum")) expect(enumStrings(rule.enum), name);
  if (expected.includes("const") && name !== "schemaVersion") expect(ascii(rule.const), name);
}
const { schemaVersion, eventName, severity, outcome, durationMs, errorCode, timestamp } = schema.properties;
expect(timestamp.format === "date-time", "timestamp");
expect(schemaVersion.type === "integer" && schemaVersion.const === 1, "schemaVersion");
expect(durationMs.type === "integer" && Number.isSafeInteger(durationMs.minimum) &&
  Number.isSafeInteger(durationMs.maximum) && durationMs.minimum >= 0 && durationMs.maximum >= durationMs.minimum, "durationMs");

for (const [i, [title, required, conditions]] of phaseFields.entries()) {
  const branch = schema.oneOf[i];
  const forbidden = orderedNames.filter(name => !required.includes(name));
  expect(keys(branch, ["title", "required", "properties", ...(forbidden.length ? ["not"] : [])]) &&
    branch.title === title && list(branch.required, required) && keys(branch.properties, conditions), "branch " + title);
  for (const name of conditions) {
    const condition = branch.properties[name];
    expect(keys(condition, ["const"]) && schema.properties[name].enum.includes(condition.const), "branch " + title);
  }
  if (forbidden.length) {
    const exclusion = branch.not;
    expect(keys(exclusion, ["anyOf"]) && Array.isArray(exclusion.anyOf) &&
      exclusion.anyOf.length === forbidden.length &&
      exclusion.anyOf.every((item, j) => keys(item, ["required"]) && list(item.required, [forbidden[j]])), "exclusion " + title);
  }
}
const [begin, ok, failed] = schema.oneOf.map(branch => branch.properties);
expect(list(eventName.enum, [begin.eventName.const, ok.eventName.const]) &&
  failed.eventName.const === ok.eventName.const && list(severity.enum, [ok.severity.const, failed.severity.const]) &&
  begin.severity.const === ok.severity.const && list(outcome.enum, [ok.outcome.const, failed.outcome.const]), "branches");

const diagnostics = schema["x-orange-k07"];
expect(keys(diagnostics, ["frame", "failure", "errors"]), "diagnostics");
const { frame, failure, errors } = diagnostics;
expect(keys(frame, ["maxLineBytes", "maxRecords", "eofDeadlineMs"]) &&
  Object.values(frame).every(value => Number.isInteger(value) && value > 0 && value <= 2147483647), "frame");
expect(keys(failure, ["startup", "loadFile", "category", "retryable"]) &&
  list(errorCode.enum, [failure.startup, failure.loadFile]) && ascii(failure.category) &&
  typeof failure.retryable === "boolean", "failure");
expect(keys(errors, ["version", "field", "shape", "frame", "conflict", "mismatch", "incomplete"]), "errors");
for (const [name, error] of Object.entries(errors)) {
  const path = name === "field" ? "pathPrefix" : "path";
  expect(keys(error, ["code", path]) && ascii(error.code) && ascii(error[path]), "errors");
}

const fields = Object.entries(schema.properties);
const literal = value => JSON.stringify(value);
const pascal = name => name[0].toUpperCase() + name.slice(1);
const choices = field => field.enum ?? (typeof field.const === "string" ? [field.const] : null);
const typeOf = field => field.const !== undefined ? literal(field.const) :
  field.enum ? field.enum.map(literal).join(" | ") : field.type === "integer" ? "number" : "string";
const csharpType = field => field.type === "integer" ? "long" : "string";
const shapes = schema.oneOf.map(branch => ({
  title: branch.title,
  eventName: branch.properties.eventName.const,
  severity: branch.properties.severity.const,
  outcome: branch.properties.outcome?.const ?? null,
  required: branch.required,
}));

const header = "// Generated from schemas/K07/v1.schema.json by tools/contracts/generate.mjs; do not edit.\n";
const tsRecord = shapes.map((shape, i) => {
  const branch = schema.oneOf[i];
  return "{\n" + fields.map(([name, field]) => {
    return shape.required.includes(name)
      ? "  readonly " + name + ": " + typeOf(branch.properties[name] ?? field) + ";"
      : "  readonly " + name + "?: never;";
  }).join("\n") + "\n}";
}).join(" | ");
const ts = header +
  "export const K07_KEY = " + literal(schema.title) + ";\n" +
  "export const K07_FIELDS = " + JSON.stringify(schema.properties, null, 2) + " as const;\n" +
  "export const K07_SHAPES = " + JSON.stringify(shapes, null, 2) + " as const;\n" +
  "export const K07_DIAGNOSTICS = " + JSON.stringify(diagnostics, null, 2) + " as const;\n" +
  "export type K07Record = " + tsRecord + ";\n";

const csString = literal; // all generated spec strings are printable ASCII
const csList = values => "[" + values.map(csString).join(", ") + "]";
const csError = ([name, { code, path }]) =>
  "    internal static readonly ContractError " + pascal(name) + " = new(" + csString(code) + ", " + csString(path) + ");";
const csField = ([name, field]) => {
  const permitted = choices(field);
  return "        new(" + [csString(name), String(field.type === "integer"), permitted ? csList(permitted) : "null",
    field.pattern ? "new Regex(" + csString(field.pattern) + ", RegexOptions.CultureInvariant)" : "null",
    String(field.format === "date-time"), field.minimum ?? "null", field.maximum ?? "null"].join(", ") + "),";
};
const csShape = shape => "        new(" + [csString(shape.eventName), csString(shape.severity),
  csString(shape.outcome), csList(shape.required)].join(", ") + "),";
const csProperties = fields.map(([name, field], order) => {
  const nullable = schema.required.includes(name) ? "" : "?";
  return "    [property: JsonPropertyName(" + csString(name) + "), JsonPropertyOrder(" + order + ")] " +
    csharpType(field) + nullable + " " + pascal(name);
}).join(",\n");
const csNormalize = fields.map(([name, field]) => {
  const access = field.type === "integer" ? "ContractValidator.ReadInteger(value)" : "value.GetString()";
  if (schema.required.includes(name))
    return "        " + access.replace(/\bvalue\b/g, "fields[" + csString(name) + "]") +
      (field.type === "integer" ? "!.Value" : "!");
  return "        fields.TryGetValue(" + csString(name) + ", out var " + name + ") ? " +
    access.replace(/\bvalue\b/g, name) + " : null";
}).join(",\n");
const csData = [
  "internal static class K07Data",
  "{",
  "    internal const string Key = " + csString(schema.title) + ";",
  "    internal const long SchemaVersion = " + schema.properties.schemaVersion.const + ";",
  "    internal const long DurationMaximum = " + schema.properties.durationMs.maximum + ";",
  ...Object.entries(diagnostics.frame).map(([name, value]) => "    internal const int " + pascal(name) + " = " + value + ";"),
  ...Object.entries(diagnostics.failure).map(([name, value]) =>
    "    internal const " + (typeof value === "boolean" ? "bool" : "string") + " Failure" + pascal(name) + " = " + literal(value) + ";"),
  ...Object.entries(diagnostics.errors).filter(([name]) => name !== "field").map(csError),
  "    internal const string FieldCode = " + csString(diagnostics.errors.field.code) + ";",
  "    internal const string FieldPrefix = " + csString(diagnostics.errors.field.pathPrefix) + ";",
  "",
  "    internal sealed record FieldSpec(string Name, bool Integer, string[]? Values, Regex? Pattern, bool DateTime, long? Minimum, long? Maximum);",
  "    internal static readonly FieldSpec[] Fields =",
  "    [",
  ...fields.map(csField),
  "    ];",
  "    internal static readonly HashSet<string> KnownFields = new(Fields.Select(field => field.Name), StringComparer.Ordinal);",
  "",
  "    internal sealed record ShapeSpec(string EventName, string Severity, string? Outcome, string[] Required);",
  "    internal static readonly ShapeSpec[] Shapes =",
  "    [",
  ...shapes.map(csShape),
  "    ];",
  "",
  "    internal static K07Record Normalize(Dictionary<string, JsonElement> fields) => new(",
  csNormalize + ");",
  "}",
  "",
].join("\n");
const csHeader = header + "#nullable enable\n" +
  "using System;\nusing System.Collections.Generic;\nusing System.Globalization;\nusing System.Linq;\n" +
  "using System.Text;\nusing System.Text.Json;\nusing System.Text.Json.Serialization;\nusing System.Text.RegularExpressions;\n\n" +
  "namespace Orange.Contracts;\n\npublic sealed record K07Record(\n" + csProperties + ");\n\n" + csData;

const csRuntime = String.raw`
public sealed record ContractError(string Code, string Path);
public sealed record ContractResult<T>(bool Ok, T? Value, ContractError? Error) where T : class;
public sealed record StartupFailure(string ErrorCode, string Category, bool Retryable);
public sealed record StartupBinding(string ChildId, string AppVersion, string BuildCommit);
public sealed record StartupPair(K07Record Begin, K07Record Finish);

public static class ContractValidator
{
    private static readonly JsonSerializerOptions Wire = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly Regex NumberToken = new(
        @"\A-?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?\z", RegexOptions.CultureInvariant);

    internal static ContractResult<T> Fail<T>(ContractError error) where T : class => new(false, null, error);
    internal static ContractResult<T> Pass<T>(T value) where T : class => new(true, value, null);

    private static string? ReadString(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String) return null;
        try { return value.GetString(); }
        catch (InvalidOperationException) { return null; }
    }

    // A JSON fraction or underflow must not become an integer by IEEE-754 rounding.
    internal static long? ReadInteger(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Number) return null;
        if (value.TryGetInt64(out var integer)) return integer;
        if (!value.TryGetDouble(out var number) || !double.IsFinite(number) ||
            Math.Truncate(number) != number || Math.Abs(number) > K07Data.DurationMaximum) return null;

        var groups = NumberToken.Match(value.GetRawText()).Groups;
        var fraction = groups[2].Value;
        var digits = (groups[1].Value + fraction).TrimStart('0');
        if (digits.Length == 0) return 0;
        var exp = groups[3].Success ?
            double.Parse(groups[3].Value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture) : 0;
        var scale = exp - fraction.Length;
        if (scale >= 0) return digits.Length + scale <= 16 ? (long)number : null;
        if (-scale >= digits.Length) return null;
        for (var i = digits.Length + (int)scale; i < digits.Length; i++)
            if (digits[i] != '0') return null;
        return (long)number;
    }

    private static bool IsValid(K07Data.FieldSpec field, JsonElement value)
    {
        if (field.Integer)
        {
            return ReadInteger(value) is long number && (field.Minimum is null || number >= field.Minimum) &&
                (field.Maximum is null || number <= field.Maximum);
        }
        var text = ReadString(value);
        if (text is null || (field.Values is not null && !field.Values.Contains(text, StringComparer.Ordinal)) ||
            (field.Pattern is not null && !field.Pattern.IsMatch(text))) return false;
        return !field.DateTime || DateTime.TryParseExact(text, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
            CultureInfo.InvariantCulture, DateTimeStyles.None, out _);
    }

    /// <summary>Check a controlled JSON value: version, shape, then known fields. Use ValidateJson for untrusted bytes.</summary>
    public static ContractResult<K07Record> Validate(string key, JsonElement input)
    {
        if (key != K07Data.Key || input.ValueKind != JsonValueKind.Object)
            return Fail<K07Record>(K07Data.Shape);
        if (!input.TryGetProperty("schemaVersion", out var version) ||
            ReadInteger(version) != K07Data.SchemaVersion)
            return Fail<K07Record>(K07Data.Version);

        var fields = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        try
        {
            foreach (var member in input.EnumerateObject())
                if (!K07Data.KnownFields.Contains(member.Name) || !fields.TryAdd(member.Name, member.Value))
                    return Fail<K07Record>(K07Data.Shape);
        }
        catch (InvalidOperationException) { return Fail<K07Record>(K07Data.Shape); }
        var eventName = ReadString(fields.GetValueOrDefault("eventName"));
        var outcome = ReadString(fields.GetValueOrDefault("outcome"));
        var shape = K07Data.Shapes.FirstOrDefault(branch => branch.EventName == eventName && branch.Outcome == outcome);
        var isFinish = eventName == K07Data.Shapes[1].EventName;
        var required = shape?.Required ?? (isFinish ? K07Data.Shapes[1].Required : K07Data.Shapes[0].Required);
        var allowed = shape?.Required ?? (eventName == K07Data.Shapes[0].EventName ? K07Data.Shapes[0].Required : null);
        if (required.Any(name => !fields.ContainsKey(name)) ||
            (allowed is not null && fields.Keys.Any(name => !allowed.Contains(name, StringComparer.Ordinal))))
            return Fail<K07Record>(K07Data.Shape);

        foreach (var field in K07Data.Fields)
        {
            if (!fields.TryGetValue(field.Name, out var value)) continue;
            if (!IsValid(field, value) || (field.Name == "severity" && shape is not null &&
                ReadString(value) != shape.Severity))
                return Fail<K07Record>(new(K07Data.FieldCode, K07Data.FieldPrefix + field.Name));
        }
        return Pass(K07Data.Normalize(fields));
    }

    internal static string CanonicalLine(K07Record value) => JsonSerializer.Serialize(value, Wire);

    /// <summary>Encode a controlled value. Use EncodeStartupFrameJson for original JSON bytes.</summary>
    public static ContractResult<string> EncodeStartupFrame(JsonElement input)
    {
        var result = Validate(K07Data.Key, input);
        return result.Value is not null ? Pass(CanonicalLine(result.Value) + "\n") : Fail<string>(result.Error!);
    }

    /// <summary>The original error is deliberately never inspected or retained.</summary>
    public static ContractResult<StartupFailure> ProjectStartupFailure(string stage, Exception? cause)
    {
        var code = stage switch
        {
            "startup" => K07Data.FailureStartup,
            "loadFile" => K07Data.FailureLoadFile,
            _ => null
        };
        return code is not null ? Pass(new StartupFailure(code, K07Data.FailureCategory, K07Data.FailureRetryable))
            : Fail<StartupFailure>(K07Data.Shape);
    }

    // JSON parser syntax checks come first, including duplicate decoded key names.
    private static bool HasUniqueJsonKeys(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String)
            _ = value.GetString(); // detects unmatched UTF-16 escapes
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in value.EnumerateArray())
                if (!HasUniqueJsonKeys(element)) return false;
        }
        else if (value.ValueKind == JsonValueKind.Object)
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var member in value.EnumerateObject())
                if (!keys.Add(member.Name) || !HasUniqueJsonKeys(member.Value)) return false;
        }
        return true;
    }

    /// <summary>Validate original UTF-8 JSON object bytes, without NDJSON framing or canonical ordering.</summary>
    public static ContractResult<K07Record> ValidateJson(string key, ReadOnlySpan<byte> bytes) =>
        DecodeRecord(key, bytes, requireCanonical: false);

    /// <summary>Encode an untrusted JSON object from its original bytes; do not parse it first.</summary>
    public static ContractResult<string> EncodeStartupFrameJson(ReadOnlySpan<byte> bytes)
    {
        var result = ValidateJson(K07Data.Key, bytes);
        return result.Value is not null ? Pass(CanonicalLine(result.Value) + "\n") : Fail<string>(result.Error!);
    }

    internal static ContractResult<K07Record> DecodeLine(ReadOnlySpan<byte> bytes) =>
        DecodeRecord(K07Data.Key, bytes, requireCanonical: true);

    private static ContractResult<K07Record> DecodeRecord(string key, ReadOnlySpan<byte> bytes, bool requireCanonical)
    {
        if (bytes.IsEmpty || bytes.Length > K07Data.MaxLineBytes ||
            (requireCanonical && bytes.Contains((byte)13))) return Fail<K07Record>(K07Data.Frame);
        try
        {
            var text = StrictUtf8.GetString(bytes);
            if (text[0] == '\uFEFF') return Fail<K07Record>(K07Data.Frame);
            using var doc = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = K07Data.MaxLineBytes });
            if (!HasUniqueJsonKeys(doc.RootElement)) return Fail<K07Record>(K07Data.Frame);
            var result = Validate(key, doc.RootElement);
            return requireCanonical && result.Value is not null && CanonicalLine(result.Value) != text
                ? Fail<K07Record>(K07Data.Frame) : result;
        }
        catch (Exception e) when (e is JsonException or DecoderFallbackException or InvalidOperationException)
        {
            return Fail<K07Record>(K07Data.Frame);
        }
    }
}

/// <summary>A byte-bounded parser for one trusted launch. The caller owns I/O and the monotonic deadline.</summary>
public sealed class DesktopStartupDiagnosticStream(StartupBinding binding)
{
    public const int EofDeadlineMs = K07Data.EofDeadlineMs;
    private readonly byte[] _line = new byte[K07Data.MaxLineBytes];
    private int _length;
    private int _count;
    private K07Record? _begin;
    private K07Record? _finish;
    private ContractResult<StartupPair>? _result;

    private ContractResult<StartupPair> Settle(ContractResult<StartupPair> result)
    {
        Array.Clear(_line);
        _length = 0;
        _begin = null;
        _finish = null;
        return _result = result;
    }

    private ContractError Stop(ContractError error)
    {
        Settle(ContractValidator.Fail<StartupPair>(error));
        return error;
    }

    private ContractError? Accept(K07Record value)
    {
        var existing = _begin?.EventId == value.EventId ? _begin : _finish?.EventId == value.EventId ? _finish : null;
        if (existing is not null) return existing == value ? null : K07Data.Conflict;

        if (value.AppVersion != binding.AppVersion || value.BuildCommit != binding.BuildCommit ||
            (_begin is not null && _begin.TraceId != value.TraceId)) return K07Data.Mismatch;
        if (value.EventName == K07Data.Shapes[0].EventName)
        {
            if (_begin is not null) return K07Data.Conflict;
            _begin = value;
        }
        else
        {
            if (_begin is null || _finish is not null) return K07Data.Conflict;
            _finish = value;
        }
        return null;
    }

    /// <summary>A returned error is terminal; stop feeding bytes and discard the original stream.</summary>
    public ContractError? Push(string childId, ReadOnlySpan<byte> bytes)
    {
        if (_result is not null) return _result.Error;
        if (childId != binding.ChildId) return Stop(K07Data.Mismatch);
        foreach (var next in bytes)
        {
            if (_count == K07Data.MaxRecords) return Stop(K07Data.Frame);
            if (next != 10)
            {
                if (_length == _line.Length) return Stop(K07Data.Frame);
                _line[_length++] = next;
                continue;
            }
            var result = ContractValidator.DecodeLine(_line.AsSpan(0, _length));
            Array.Clear(_line, 0, _length);
            _length = 0;
            _count++;
            if (result.Error is not null) return Stop(result.Error);
            if (Accept(result.Value!) is ContractError error) return Stop(error);
        }
        return null;
    }

    public ContractResult<StartupPair> CompleteAtDeadline() =>
        _result ?? Settle(ContractValidator.Fail<StartupPair>(K07Data.Incomplete));

    public ContractResult<StartupPair> CompleteAtEof()
    {
        if (_result is not null) return _result;
        if (_length != 0) return Settle(ContractValidator.Fail<StartupPair>(K07Data.Frame));
        if (_begin is null || _finish is null) return Settle(ContractValidator.Fail<StartupPair>(K07Data.Incomplete));
        return Settle(ContractValidator.Pass(new StartupPair(_begin, _finish)));
    }
}
`.trimStart();


const k01Schema = JSON.parse(await readFile(new URL("schemas/K01/v1.schema.json", base), "utf8"));
const requireK01 = (valid, part) => {
  if (!valid) throw new Error("Unsupported K01 schema (" + part + ").");
};
const k01Equals = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
const k01Object = (shape, names, root = false) =>
  (root || keys(shape, ["type", "additionalProperties", "required", "properties"])) &&
  shape.type === "object" && shape.additionalProperties === false &&
  list(shape.required, names) && keys(shape.properties, names) && list(Object.keys(shape.properties), names);
const rootFields = ["schemaVersion", "commandName", "commandId", "idempotencyKey", "subjectRef", "expectedRevision", "payload"];
const subjectFields = ["type", "id"];
const payloadFields = ["subtitleId", "text"];
const resultFields = ["commandId", "projectRevisionId", "revision"];
requireK01(keys(k01Schema, ["$schema", "$id", "title", "description", "type", "additionalProperties",
  "required", "properties", "$defs", "x-orange-k01"]) &&
  k01Schema.$schema === "https://json-schema.org/draft/2020-12/schema" &&
  k01Schema.$id === "urn:orange:contracts:K01:project-subtitle-text-replace:v1" &&
  k01Schema.title === "K01.project.subtitle_text.replace.v1" && ascii(k01Schema.description) &&
  k01Object(k01Schema, rootFields, true), "root");

const request = k01Schema.properties;
const defs = k01Schema.$defs;
const wire = k01Schema["x-orange-k01"];
const uuidRef = { $ref: "#/$defs/uuidV4" };
const textRef = { $ref: "#/$defs/subtitleText" };
const max = Number.MAX_SAFE_INTEGER;
const version = request.schemaVersion.const;
const command = request.commandName.const;
requireK01(k01Equals(request.schemaVersion, { type: "integer", const: 1 }) &&
  k01Equals(request.commandName, { type: "string", const: "project.subtitle_text.replace" }) &&
  k01Equals(request.commandId, uuidRef) && k01Equals(request.idempotencyKey, uuidRef) &&
  k01Equals(request.expectedRevision, { type: "integer", minimum: 1, maximum: max - 1 }), "command fields");
requireK01(k01Object(request.subjectRef, subjectFields) &&
  k01Equals(request.subjectRef.properties.type, { type: "string", const: "project" }) &&
  k01Equals(request.subjectRef.properties.id, uuidRef), "subjectRef");
requireK01(k01Object(request.payload, payloadFields) && k01Equals(request.payload.properties.subtitleId, uuidRef) &&
  k01Equals(request.payload.properties.text, textRef), "payload");
requireK01(keys(defs, ["uuidV4", "subtitleText", "saveResult", "error"]) &&
  k01Equals(defs.uuidV4, { type: "string", minLength: 36, maxLength: 36,
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }) &&
  k01Equals(defs.subtitleText, { type: "string", minLength: 1, maxLength: 500,
    pattern: String.raw`^[^\u0000-\u0009\u000B-\u001F\u007F-\u009F\uD800-\uDFFF]+$(?![\s\S])` }), "scalar rules");
requireK01(k01Object(defs.saveResult, resultFields) &&
  k01Equals(defs.saveResult.properties.commandId, uuidRef) && k01Equals(defs.saveResult.properties.projectRevisionId, uuidRef) &&
  k01Equals(defs.saveResult.properties.revision, { type: "integer", minimum: 2, maximum: max }), "save result");
requireK01(keys(wire, ["wire", "integerToken", "schemaVersionTokenMaximum", "forbiddenFields", "digestDomain"]) &&
  wire.wire === "strict-utf8-json-no-bom" && wire.integerToken === "positive-decimal" &&
  wire.schemaVersionTokenMaximum === max && wire.digestDomain === "orange:k01:" + command + ":v" + version &&
  list(wire.forbiddenFields, ["actorUserId", "authorizationContextRef", "ownerUserId", "groupId", "externalAccountKey",
    "requestId", "traceId", "occurredAt", "jobId", "attemptId", "eventName", "eventId"]), "wire");

// The only invalid paths are the root, declared fields (including object
// paths) and named forbidden fields in each of the three recognized scopes.
const invalidPaths = ["", ...[
  ["", k01Schema.required],
  ["/subjectRef", request.subjectRef.required],
  ["/payload", request.payload.required],
].flatMap(([scope, names]) => [...names, ...wire.forbiddenFields].map(name => scope + "/" + name))];
const errorsByPath = [
  ["CONTRACT_INVALID", { enum: invalidPaths }],
  ["UNSUPPORTED_VERSION", { const: "/schemaVersion" }],
  ["ACCESS_DENIED", { const: "" }],
  ["IDEMPOTENCY_CONFLICT", { const: "/idempotencyKey" }],
  ["OUTCOME_UNKNOWN", { const: "" }],
];
const errorFields = ["code", "path"];
const errorBranches = defs.error?.oneOf;
requireK01(keys(defs.error, ["oneOf"]) && Array.isArray(errorBranches) &&
  errorBranches.length === errorsByPath.length + 1 &&
  errorsByPath.every(([code, path], i) => k01Object(errorBranches[i], errorFields) &&
    k01Equals(errorBranches[i].properties, { code: { const: code }, path })) &&
  k01Object(errorBranches.at(-1), [...errorFields, "currentRevision"]) &&
  k01Equals(errorBranches.at(-1).properties, { code: { const: "REVISION_CONFLICT" }, path: { const: "/expectedRevision" },
    currentRevision: { type: "integer", minimum: 1, maximum: max } }), "errors");

const k01Data = {
  version,
  versionMaximum: wire.schemaVersionTokenMaximum,
  command,
  subjectType: request.subjectRef.properties.type.const,
  revisionMinimum: request.expectedRevision.minimum,
  revisionMaximum: request.expectedRevision.maximum,
  uuidLength: defs.uuidV4.minLength,
  uuidPattern: defs.uuidV4.pattern,
  textMinimum: defs.subtitleText.minLength,
  textMaximum: defs.subtitleText.maxLength,
  textPattern: defs.subtitleText.pattern,
  rootFields: k01Schema.required,
  subjectFields: request.subjectRef.required,
  payloadFields: request.payload.required,
  forbiddenFields: wire.forbiddenFields,
  digestDomain: wire.digestDomain,
  invalidCode: errorBranches[0].properties.code.const,
  unsupportedCode: errorBranches[1].properties.code.const,
};
const k01Header = "// Generated from schemas/K01/v1.schema.json by tools/contracts/generate.mjs; do not edit.\n";
const k01TsType = (property, indent = "") => {
  if (property.type === "object") {
    return "{\n" + Object.entries(property.properties).map(([name, field]) =>
      indent + "  readonly " + name + ": " + k01TsType(field, indent + "  ") + ";\n").join("") + indent + "}";
  }
  return property.$ref ? "string" : typeOf(property);
};
const k01Ts = k01Header + "export const K01_KEY = " + literal(k01Schema.title) + ";\n" +
  "export const K01_RULES = " + JSON.stringify(k01Data, null, 2) + " as const;\n" +
  "export type K01Record = " + k01TsType(k01Schema) + ";\n" +
  "export type K01SaveResult = " + k01TsType(defs.saveResult) + ";\n";

const k01CsRecord = (name, shape) => "public sealed record " + name + "(\n" +
  Object.entries(shape.properties).map(([key, property]) =>
    "    [property: JsonPropertyName(" + csString(key) + ")] " +
    ({ subjectRef: "K01SubjectRef", payload: "K01Payload" }[key] ?? csharpType(property)) + " " + pascal(key)).join(",\n") +
  ");\n\n";
const k01Cs = k01Header + "#nullable enable\n" +
  "using System;\nusing System.Collections.Generic;\nusing System.Security.Cryptography;\nusing System.Text;\n" +
  "using System.Text.Json;\nusing System.Text.Json.Serialization;\nusing System.Text.RegularExpressions;\n\n" +
  "namespace Orange.Contracts;\n\n" +
  k01CsRecord("K01Record", k01Schema) + k01CsRecord("K01SubjectRef", request.subjectRef) +
  k01CsRecord("K01Payload", request.payload) + k01CsRecord("K01SaveResult", defs.saveResult) +
  "public static class K01ContractValidator\n{\n" +
  "    public const string Key = " + csString(k01Schema.title) + ";\n" +
  Object.entries(k01Data).filter(([key]) => key !== "textPattern").map(([key, value]) => Array.isArray(value)
    ? "    private static readonly string[] " + pascal(key) + " = " + csList(value) + ";\n"
    : "    private const " + (typeof value === "number" ? "long" : "string") + " " + pascal(key) + " = " + literal(value) + ";\n").join("") +
  String.raw`
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly Regex Uuid = new(UuidPattern, RegexOptions.CultureInvariant);

    private readonly record struct Field(string? Text = null, long? Number = null);

    // Arrays and unknown objects inherit only the nearest recognized path, never its field names.
    private sealed class Scope(string path, string[]? fields, bool isObject)
    {
        internal string Path { get; } = path;
        internal string[]? Fields { get; } = fields;
        internal HashSet<string>? Seen { get; } = isObject ? new(StringComparer.Ordinal) : null;
        internal Dictionary<string, Field>? Values { get; } = fields is null ? null : new(StringComparer.Ordinal);
        internal string? Pending;
        internal bool Allows(string name) => Fields is not null && Array.IndexOf(Fields, name) >= 0;
        internal bool CanName(string name) => Allows(name) || (Fields is not null && Array.IndexOf(ForbiddenFields, name) >= 0);
        internal Field Get(string name) => Values!.GetValueOrDefault(name);

        internal string? Extra()
        {
            foreach (var name in ForbiddenFields)
                if (Seen!.Contains(name)) return Path + "/" + name;
            foreach (var name in Seen!)
                if (!Allows(name)) return Path;
            return null;
        }
    }

    private static ContractResult<K01Record> Invalid(string path) =>
        ContractValidator.Fail<K01Record>(new(InvalidCode, path));

    private static bool IsUuid(string? text) => text?.Length == UuidLength && Uuid.IsMatch(text);

    private static bool IsText(string? text)
    {
        if (text is null) return false;
        var count = 0;
        for (var i = 0; i < text.Length; i++)
        {
            var ch = text[i];
            if ((ch < 32 && ch != '\n') || (ch >= 0x7f && ch <= 0x9f)) return false;
            if (char.IsSurrogate(ch))
            {
                if (!char.IsSurrogatePair(text, i)) return false;
                i++;
            }
            if (++count > TextMaximum) return false;
        }
        return count >= TextMinimum;
    }

    private static long? ReadPositiveInteger(ref Utf8JsonReader reader)
    {
        var raw = reader.ValueSpan;
        if (raw.IsEmpty || raw[0] == '0') return null;
        foreach (var ch in raw)
            if (ch < '0' || ch > '9') return null;
        return reader.TryGetInt64(out var value) ? value : null;
    }

    private static string? ReadString(ref Utf8JsonReader reader)
    {
        try { return reader.GetString(); }
        catch (InvalidOperationException) { return null; } // unmatched UTF-16 escape in a value
    }

    // JSON permits lone \u escapes in strings at the grammar layer. Unknown keys
    // still need exact decoded equality (including lone code units) for redaction and precedence.
    private static string ReadKey(ref Utf8JsonReader reader)
    {
        if (ReadString(ref reader) is string name) return name;
        var raw = StrictUtf8.GetString(reader.ValueSpan);
        var decoded = new StringBuilder(raw.Length);
        for (var i = 0; i < raw.Length; i++)
        {
            if (raw[i] != '\\') { decoded.Append(raw[i]); continue; }
            var escape = raw[++i];
            if (escape == 'u')
            {
                var codeUnit = Convert.ToUInt16(raw.Substring(i + 1, 4), 16);
                decoded.Append((char)codeUnit);
                i += 4;
            }
            else decoded.Append(escape switch
            {
                'b' => '\b', 'f' => '\f', 'n' => '\n', 'r' => '\r', 't' => '\t', _ => escape
            });
        }
        return decoded.ToString();
    }

    private static void SaveField(Scope? scope, ref Utf8JsonReader reader)
    {
        if (scope?.Pending is not string name || !scope.Allows(name)) return;
        scope.Values![name] = reader.TokenType switch
        {
            JsonTokenType.String => new(Text: ReadString(ref reader)),
            JsonTokenType.Number => new(Number: ReadPositiveInteger(ref reader)),
            _ => default
        };
    }

    /// <summary>Validate the original UTF-8 bytes. No materialized JsonElement/object is accepted as K01 wire.</summary>
    public static ContractResult<K01Record> ValidateJson(ReadOnlySpan<byte> bytes)
    {
        if (bytes.StartsWith("\uFEFF"u8)) return Invalid("");
        Scope? root = null, subject = null, payload = null;
        string? duplicate = null;
        var scopes = new Stack<Scope>();
        try
        {
            _ = StrictUtf8.GetCharCount(bytes); // the reader alone does not decode every skipped string
            var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { MaxDepth = int.MaxValue });
            while (reader.Read())
            {
                // Keep reading grammar after finding a duplicate; syntax/encoding always wins.
                if (duplicate is not null) continue;
                scopes.TryPeek(out var parent);
                switch (reader.TokenType)
                {
                    case JsonTokenType.StartObject:
                    case JsonTokenType.StartArray:
                        var isObject = reader.TokenType == JsonTokenType.StartObject;
                        Scope scope;
                        if (isObject && parent is null)
                            scope = root = new("", RootFields, true);
                        else if (isObject && parent == root && parent?.Pending == "subjectRef")
                            scope = subject = new("/subjectRef", SubjectFields, true);
                        else if (isObject && parent == root && parent?.Pending == "payload")
                            scope = payload = new("/payload", PayloadFields, true);
                        else
                            scope = new(parent?.Path ?? "", null, isObject);
                        scopes.Push(scope);
                        break;
                    case JsonTokenType.EndObject:
                    case JsonTokenType.EndArray:
                        scopes.Pop();
                        break;
                    case JsonTokenType.PropertyName:
                        var name = ReadKey(ref reader);
                        parent!.Pending = name;
                        if (!parent.Seen!.Add(name))
                            duplicate = parent.CanName(name) ? parent.Path + "/" + name : parent.Path;
                        break;
                    default:
                        SaveField(parent, ref reader);
                        break;
                }
            }
        }
        catch (Exception e) when (e is JsonException or DecoderFallbackException)
        {
            return Invalid("");
        }

        if (duplicate is not null) return Invalid(duplicate);
        if (root is null) return Invalid("");
        if (root.Get("schemaVersion").Number is not long version || version > VersionMaximum)
            return Invalid("/schemaVersion");
        if (version != Version) return ContractValidator.Fail<K01Record>(new(UnsupportedCode, "/schemaVersion"));
        if (root.Get("commandName").Text != Command) return Invalid("/commandName");
        var commandId = root.Get("commandId").Text;
        if (!IsUuid(commandId)) return Invalid("/commandId");
        var key = root.Get("idempotencyKey").Text;
        if (!IsUuid(key)) return Invalid("/idempotencyKey");
        if (subject is null) return Invalid("/subjectRef");
        if (subject.Get("type").Text != SubjectType) return Invalid("/subjectRef/type");
        var projectId = subject.Get("id").Text;
        if (!IsUuid(projectId)) return Invalid("/subjectRef/id");
        if (root.Get("expectedRevision").Number is not long revision || revision < RevisionMinimum || revision > RevisionMaximum)
            return Invalid("/expectedRevision");
        if (payload is null) return Invalid("/payload");
        var subtitleId = payload.Get("subtitleId").Text;
        if (!IsUuid(subtitleId)) return Invalid("/payload/subtitleId");
        var text = payload.Get("text").Text;
        if (!IsText(text)) return Invalid("/payload/text");
        var extra = root.Extra() ?? subject.Extra() ?? payload.Extra();
        if (extra is not null) return Invalid(extra);

        return ContractValidator.Pass(new K01Record(Version, Command, commandId!, key!,
            new(SubjectType, projectId!), revision, new(subtitleId!, text!)));
    }

    /// <summary>Hash the canonical K01 intent only; neither the wire JSON nor trusted metadata enters the digest.</summary>
    public static (int ByteLength, string Sha256) DigestInput(long expectedRevision, string subtitleId, string text)
    {
        if (expectedRevision < RevisionMinimum || expectedRevision > RevisionMaximum || !IsUuid(subtitleId) || !IsText(text))
            throw new ArgumentException("Expected validated K01 digest fields.");
        var textLength = StrictUtf8.GetByteCount(text);
        var canonical = FormattableString.Invariant($"{DigestDomain}\n{expectedRevision}\n{subtitleId}\n{textLength}:{text}");
        var bytes = StrictUtf8.GetBytes(canonical);
        return (bytes.Length, Convert.ToHexStringLower(SHA256.HashData(bytes)));
    }
}
`;

const outputs = [
  ["generated/ts/K07.ts", ts],
  ["generated/dotnet/K07.g.cs", csHeader + "\n" + csRuntime],
  ["generated/ts/K01.ts", k01Ts],
  ["generated/dotnet/K01.g.cs", k01Cs],
];
for (const [path, source] of outputs) {
  const target = new URL(path, base);
  if (check) {
    const actual = await readFile(target, "utf8").catch(error => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    if (actual.replaceAll("\r\n", "\n") !== source) {
      process.stderr.write("Generated contract differs: " + path + "\n");
      process.exitCode = 1;
    }
  } else {
    // Already matching artifacts are not touched, including the frozen K07 files.
    const actual = await readFile(target, "utf8").catch(error => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    if (actual.replaceAll("\r\n", "\n") !== source) {
      await mkdir(new URL(".", target), { recursive: true });
      await writeFile(fileURLToPath(target), source);
    }
  }
}
if (!process.exitCode) process.stdout.write(check ? "K07 and K01 generated artifacts match their schemas.\n" : "K07 and K01 generated artifacts written.\n");
