// Generated from schemas/K07/v1.schema.json by tools/contracts/generate.mjs; do not edit.
#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Orange.Contracts;

public sealed record K07Record(
    [property: JsonPropertyName("schemaVersion"), JsonPropertyOrder(0)] long SchemaVersion,
    [property: JsonPropertyName("eventName"), JsonPropertyOrder(1)] string EventName,
    [property: JsonPropertyName("component"), JsonPropertyOrder(2)] string Component,
    [property: JsonPropertyName("timestamp"), JsonPropertyOrder(3)] string Timestamp,
    [property: JsonPropertyName("traceId"), JsonPropertyOrder(4)] string TraceId,
    [property: JsonPropertyName("eventId"), JsonPropertyOrder(5)] string EventId,
    [property: JsonPropertyName("environment"), JsonPropertyOrder(6)] string Environment,
    [property: JsonPropertyName("appVersion"), JsonPropertyOrder(7)] string AppVersion,
    [property: JsonPropertyName("buildCommit"), JsonPropertyOrder(8)] string BuildCommit,
    [property: JsonPropertyName("severity"), JsonPropertyOrder(9)] string Severity,
    [property: JsonPropertyName("outcome"), JsonPropertyOrder(10)] string? Outcome,
    [property: JsonPropertyName("durationMs"), JsonPropertyOrder(11)] long? DurationMs,
    [property: JsonPropertyName("errorCode"), JsonPropertyOrder(12)] string? ErrorCode);

internal static class K07Data
{
    internal const string Key = "K07.desktop-startup.v1";
    internal const long SchemaVersion = 1;
    internal const long DurationMaximum = 9007199254740991;
    internal const int MaxLineBytes = 768;
    internal const int MaxRecords = 4;
    internal const int EofDeadlineMs = 12000;
    internal const string FailureStartup = "SHELL_START_FAILED";
    internal const string FailureLoadFile = "SHELL_LOAD_FAILED";
    internal const string FailureCategory = "system";
    internal const bool FailureRetryable = false;
    internal static readonly ContractError Version = new("CONTRACT_VERSION", "$.schemaVersion");
    internal static readonly ContractError Shape = new("CONTRACT_SHAPE", "$");
    internal static readonly ContractError Frame = new("DIAGNOSTIC_FRAME", "$frame");
    internal static readonly ContractError Conflict = new("DIAGNOSTIC_CONFLICT", "$stream");
    internal static readonly ContractError Mismatch = new("DIAGNOSTIC_MISMATCH", "$stream");
    internal static readonly ContractError Incomplete = new("DIAGNOSTIC_INCOMPLETE", "$stream");
    internal const string FieldCode = "CONTRACT_FIELD";
    internal const string FieldPrefix = "$.";

    internal sealed record FieldSpec(string Name, bool Integer, string[]? Values, Regex? Pattern, bool DateTime, long? Minimum, long? Maximum);
    internal static readonly FieldSpec[] Fields =
    [
        new("schemaVersion", true, null, null, false, null, null),
        new("eventName", false, ["desktop.shell.start.begin", "desktop.shell.start.finish"], null, false, null, null),
        new("component", false, ["desktop.main"], null, false, null, null),
        new("timestamp", false, null, new Regex("^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z(?![\\s\\S])", RegexOptions.CultureInvariant), true, null, null),
        new("traceId", false, null, new Regex("^(?!0{32}(?![\\s\\S]))[0-9a-f]{32}(?![\\s\\S])", RegexOptions.CultureInvariant), false, null, null),
        new("eventId", false, null, new Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\\s\\S])", RegexOptions.CultureInvariant), false, null, null),
        new("environment", false, ["local"], null, false, null, null),
        new("appVersion", false, null, new Regex("^(?:0|[1-9][0-9]{0,8})(?:\\.(?:0|[1-9][0-9]{0,8})){2}(?![\\s\\S])", RegexOptions.CultureInvariant), false, null, null),
        new("buildCommit", false, null, new Regex("^[0-9a-f]{40}(?![\\s\\S])", RegexOptions.CultureInvariant), false, null, null),
        new("severity", false, ["info", "error"], null, false, null, null),
        new("outcome", false, ["ok", "failed"], null, false, null, null),
        new("durationMs", true, null, null, false, 0, 9007199254740991),
        new("errorCode", false, ["SHELL_START_FAILED", "SHELL_LOAD_FAILED"], null, false, null, null),
    ];
    internal static readonly HashSet<string> KnownFields = new(Fields.Select(field => field.Name), StringComparer.Ordinal);

    internal sealed record ShapeSpec(string EventName, string Severity, string? Outcome, string[] Required);
    internal static readonly ShapeSpec[] Shapes =
    [
        new("desktop.shell.start.begin", "info", null, ["schemaVersion", "eventName", "component", "timestamp", "traceId", "eventId", "environment", "appVersion", "buildCommit", "severity"]),
        new("desktop.shell.start.finish", "info", "ok", ["schemaVersion", "eventName", "component", "timestamp", "traceId", "eventId", "environment", "appVersion", "buildCommit", "severity", "outcome", "durationMs"]),
        new("desktop.shell.start.finish", "error", "failed", ["schemaVersion", "eventName", "component", "timestamp", "traceId", "eventId", "environment", "appVersion", "buildCommit", "severity", "outcome", "durationMs", "errorCode"]),
    ];

    internal static K07Record Normalize(Dictionary<string, JsonElement> fields) => new(
        ContractValidator.ReadInteger(fields["schemaVersion"])!.Value,
        fields["eventName"].GetString()!,
        fields["component"].GetString()!,
        fields["timestamp"].GetString()!,
        fields["traceId"].GetString()!,
        fields["eventId"].GetString()!,
        fields["environment"].GetString()!,
        fields["appVersion"].GetString()!,
        fields["buildCommit"].GetString()!,
        fields["severity"].GetString()!,
        fields.TryGetValue("outcome", out var outcome) ? outcome.GetString() : null,
        fields.TryGetValue("durationMs", out var durationMs) ? ContractValidator.ReadInteger(durationMs) : null,
        fields.TryGetValue("errorCode", out var errorCode) ? errorCode.GetString() : null);
}

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
