// Generated from schemas/K01/v1.schema.json by tools/contracts/generate.mjs; do not edit.
#nullable enable
using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Orange.Contracts;

public sealed record K01Record(
    [property: JsonPropertyName("schemaVersion")] long SchemaVersion,
    [property: JsonPropertyName("commandName")] string CommandName,
    [property: JsonPropertyName("commandId")] string CommandId,
    [property: JsonPropertyName("idempotencyKey")] string IdempotencyKey,
    [property: JsonPropertyName("subjectRef")] K01SubjectRef SubjectRef,
    [property: JsonPropertyName("expectedRevision")] long ExpectedRevision,
    [property: JsonPropertyName("payload")] K01Payload Payload);

public sealed record K01SubjectRef(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("id")] string Id);

public sealed record K01Payload(
    [property: JsonPropertyName("subtitleId")] string SubtitleId,
    [property: JsonPropertyName("text")] string Text);

public sealed record K01SaveResult(
    [property: JsonPropertyName("commandId")] string CommandId,
    [property: JsonPropertyName("projectRevisionId")] string ProjectRevisionId,
    [property: JsonPropertyName("revision")] long Revision);

public static class K01ContractValidator
{
    public const string Key = "K01.project.subtitle_text.replace.v1";
    private const long Version = 1;
    private const long VersionMaximum = 9007199254740991;
    private const string Command = "project.subtitle_text.replace";
    private const string SubjectType = "project";
    private const long RevisionMinimum = 1;
    private const long RevisionMaximum = 9007199254740990;
    private const long UuidLength = 36;
    private const string UuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
    private const long TextMinimum = 1;
    private const long TextMaximum = 500;
    private static readonly string[] RootFields = ["schemaVersion", "commandName", "commandId", "idempotencyKey", "subjectRef", "expectedRevision", "payload"];
    private static readonly string[] SubjectFields = ["type", "id"];
    private static readonly string[] PayloadFields = ["subtitleId", "text"];
    private static readonly string[] ForbiddenFields = ["actorUserId", "authorizationContextRef", "ownerUserId", "groupId", "externalAccountKey", "requestId", "traceId", "occurredAt", "jobId", "attemptId", "eventName", "eventId"];
    private const string DigestDomain = "orange:k01:project.subtitle_text.replace:v1";
    private const string InvalidCode = "CONTRACT_INVALID";
    private const string UnsupportedCode = "UNSUPPORTED_VERSION";

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
