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

const outputs = [
  ["generated/ts/K07.ts", ts],
  ["generated/dotnet/K07.g.cs", csHeader + "\n" + csRuntime],
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
    await mkdir(new URL(".", target), { recursive: true });
    await writeFile(fileURLToPath(target), source);
  }
}
if (!process.exitCode) process.stdout.write(check ? "K07 generated artifacts match the schema.\n" : "K07 generated artifacts written.\n");
