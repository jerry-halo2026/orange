using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Orange.Contracts;
using Xunit;

namespace Orange.Contracts.Tests;

public sealed class ContractCases
{
    private const string Slice = "K07.desktop-startup.v1";
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
    private static readonly JsonElement Fixture = ReadFixture();

    private static JsonElement ReadFixture()
    {
        using var doc = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "cases.json")));
        return doc.RootElement.Clone();
    }

    public static IEnumerable<object[]> Cases()
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        Assert.Equal("K07", Fixture.GetProperty("pack").GetString());
        Assert.Equal(Slice, Fixture.GetProperty("slice").GetString());
        foreach (var row in Fixture.GetProperty("cases").EnumerateArray())
        {
            var id = row.GetProperty("id").GetString()!;
            Assert.True(ids.Add(id), "duplicate fixture ID");
            yield return new object[] { id };
        }
        Assert.NotEmpty(ids);
    }

    [Theory]
    [Trait("Pack", "K07")]
    [MemberData(nameof(Cases))]
    public void SharedGoldenCase(string id)
    {
        JsonElement row = default;
        foreach (var candidate in Fixture.GetProperty("cases").EnumerateArray())
        {
            if (candidate.GetProperty("id").GetString() != id) continue;
            row = candidate;
            break;
        }
        var input = row.GetProperty("input");
        var expected = row.GetProperty("expected");
        object result = row.GetProperty("kind").GetString() switch
        {
            "object" => ContractValidator.Validate(Slice, input),
            "encode" => ContractValidator.EncodeStartupFrame(input),
            "json" => ContractValidator.ValidateJson(Slice, BytesOf(input)),
            "json-encode" => ContractValidator.EncodeStartupFrameJson(BytesOf(input)),
            "projection" => Project(input),
            "stream" => Collect(input, expected),
            _ => throw new InvalidOperationException("Unrecognized fixture kind.")
        };
        var serialized = JsonSerializer.Serialize(result, Options);
        foreach (var sentinel in Fixture.GetProperty("sentinels").EnumerateArray())
            Assert.False(serialized.Contains(sentinel.GetString()!, StringComparison.Ordinal), "output leaked a synthetic sentinel");
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(expected.GetRawText()), JsonNode.Parse(serialized)),
            $"Mismatch for {id}: expected {expected.GetRawText()}, got {serialized}");
    }

    private static object Project(JsonElement input)
    {
        var source = input.GetProperty("cause");
        var cause = new InvalidOperationException(source.GetProperty("message").GetString(),
            new Exception(source.GetProperty("stack").GetString()));
        return ContractValidator.ProjectStartupFailure(input.GetProperty("stage").GetString()!, cause);
    }

    private static byte[] BytesOf(JsonElement input) => input.TryGetProperty("hex", out var hex)
        ? Convert.FromHexString(hex.GetString()!)
        : Encoding.UTF8.GetBytes(input.GetProperty("text").GetString()!);

    private static object Collect(JsonElement input, JsonElement expected)
    {
        var binding = input.GetProperty("expectedBinding");
        var stream = new DesktopStartupDiagnosticStream(
            new StartupBinding(binding.GetProperty("childId").GetString()!,
                binding.GetProperty("appVersion").GetString()!, binding.GetProperty("buildCommit").GetString()!));
        ContractError? firstError = null;
        foreach (var item in input.GetProperty("items").EnumerateArray())
        {
            var bytes = BytesOf(item);
            var error = stream.Push(item.GetProperty("childId").GetString()!, bytes);
            firstError ??= error;
        }
        var completion = input.GetProperty("completion").GetString();
        var result = completion == "eof" ? stream.CompleteAtEof() : stream.CompleteAtDeadline();
        if (completion == "deadline" && expected.TryGetProperty("error", out var failure) &&
            failure.GetProperty("code").GetString() == "DIAGNOSTIC_FRAME")
            Assert.Equal("DIAGNOSTIC_FRAME", firstError?.Code);
        return result;
    }
}

public sealed class K01ContractCases
{
    private const string Slice = "K01.project.subtitle_text.replace.v1";
    private const string Vector = "ceefc161aca6b1d8d5294b418277b4b5e136211937125a1cbf1753fe3aca42ba";
    private const string Text = "你好，Ethan！";
    private const string OtherKey = "88888888-8888-4888-8888-888888888888";
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
    private static readonly JsonElement Fixture = ReadSignedFixture();
    private static JsonElement First => Fixture[0].GetProperty("input");
    private static string Wire => String(First, "wireJson");

    private static JsonElement ReadSignedFixture()
    {
        var bytes = File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "K01.cases.json"));
        Assert.Equal("1bd42bdf3b0233ae39384434a146d4cee912dfb89f76a53ddd6566881622f506",
            Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)));
        using var doc = JsonDocument.Parse(bytes);
        Assert.Equal(3, doc.RootElement.GetProperty("draftRevision").GetInt32());
        var cases = doc.RootElement.GetProperty("cases");
        Assert.Equal(32, cases.GetArrayLength());
        return cases.Clone();
    }

    private static string String(JsonElement value, string field) => value.GetProperty(field).GetString()!;
    private static long Number(JsonElement value, string field) => value.GetProperty(field).GetInt64();
    private static byte[] Bytes(string raw) => Encoding.UTF8.GetBytes(raw);
    private static JsonElement ReadK01(byte[] bytes) =>
        JsonSerializer.SerializeToElement(K01ContractValidator.ValidateJson(bytes), Options);
    private static (int ByteLength, string Sha256) Digest(long expectedRevision, string subtitleId, string text) =>
        K01ContractValidator.DigestInput(expectedRevision, subtitleId, text);
    private static object Failure(string code, string path, long? currentRevision = null) =>
        new { ok = false, error = new { code, path, currentRevision }, writes = 0 };

    // A synthetic single-record ledger, not a real session, project store, or write port.
    private sealed class Memory(JsonElement state)
    {
        private JsonElement Project { get; } = state.GetProperty("project");
        internal long Head { get; private set; } = Number(state.GetProperty("project"), "headRevision");
        internal string SubtitleText { get; private set; } = String(state.GetProperty("project").GetProperty("subtitle"), "text");
        internal JsonElement Outcome { get; private set; } = state.GetProperty("storedOutcome");
        internal int Writes { get; private set; }

        internal string SubtitleId => String(Project.GetProperty("subtitle"), "id");

        internal void Commit(long newHead, string text, object outcome)
        {
            Head = newHead;
            SubtitleText = text;
            Outcome = JsonSerializer.SerializeToElement(outcome, Options);
            Writes++;
        }
    }

    private static object Model(byte[] bytes, JsonElement state, Func<JsonElement>? lookup = null,
        (string Actor, string Command, string Project)? storedScope = null, Memory? memory = null)
    {
        var parsed = ReadK01(bytes);
        if (!parsed.GetProperty("ok").GetBoolean())
            return new { ok = false, error = parsed.GetProperty("error"), writes = 0 };
        var value = parsed.GetProperty("value");
        var actor = String(state, "actorUserId");
        var project = state.GetProperty("project");
        var subject = String(value.GetProperty("subjectRef"), "id");
        if (!state.GetProperty("verifiedLocalEditSession").GetBoolean() || string.IsNullOrEmpty(actor) ||
            project.ValueKind == JsonValueKind.Null || String(project, "ownerUserId") != actor ||
            String(project, "id") != subject)
            return Failure("ACCESS_DENIED", "");

        var command = String(value, "commandName");
        var commandId = String(value, "commandId");
        var key = String(value, "idempotencyKey");
        var expected = Number(value, "expectedRevision");
        var payload = value.GetProperty("payload");
        var subtitleId = String(payload, "subtitleId");
        var text = String(payload, "text");
        memory ??= new(state);
        var stored = lookup is null ? memory.Outcome : lookup();
        if (stored.ValueKind != JsonValueKind.Null && (storedScope is null || storedScope == (actor, command, subject)))
        {
            if (String(stored, "idempotencyKey") == key)
            {
                var canonical = stored.GetProperty("canonicalInput");
                var digest = Digest(expected, subtitleId, text).Sha256;
                if (String(stored, "commandId") != commandId ||
                    Digest(Number(canonical, "expectedRevision"), String(canonical, "subtitleId"), String(canonical, "text")).Sha256 != digest)
                    return Failure("IDEMPOTENCY_CONFLICT", "/idempotencyKey");
                return stored.TryGetProperty("result", out var receipt)
                    ? new { ok = true, result = receipt, writes = 0 } : Failure("OUTCOME_UNKNOWN", "");
            }
            if (String(stored, "commandId") == commandId)
                return Failure("IDEMPOTENCY_CONFLICT", "/idempotencyKey");
        }

        if (expected != memory.Head) return Failure("REVISION_CONFLICT", "/expectedRevision", memory.Head);
        if (subtitleId != memory.SubtitleId) return Failure("CONTRACT_INVALID", "/payload/subtitleId");
        if (text == memory.SubtitleText) return Failure("CONTRACT_INVALID", "/payload/text");
        var result = new { commandId, projectRevisionId = String(state, "simulatedAllocatedProjectRevisionId"),
            revision = memory.Head + 1 };
        var priorWrites = memory.Writes;
        memory.Commit(result.revision, text,
            new { idempotencyKey = key, commandId, canonicalInput = new { expectedRevision = expected, subtitleId, text }, result });
        return new { ok = true, result, writes = memory.Writes - priorWrites };
    }

    private static void AssertJson(JsonElement expected, object actual)
    {
        var json = JsonSerializer.Serialize(actual, Options);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(expected.GetRawText()), JsonNode.Parse(json)),
            $"Expected {expected.GetRawText()}, got {json}");
    }

    public static IEnumerable<object[]> SignedCases()
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var row in Fixture.EnumerateArray())
        {
            var id = String(row, "id");
            Assert.True(ids.Add(id), "duplicate fixture ID");
            yield return new object[] { id };
        }
    }

    [Theory]
    [Trait("Pack", "K01")]
    [MemberData(nameof(SignedCases))]
    public void SignedCase(string id)
    {
        foreach (var row in Fixture.EnumerateArray())
        {
            if (String(row, "id") != id) continue;
            var input = row.GetProperty("input");
            AssertJson(row.GetProperty("expected"), Model(Bytes(String(input, "wireJson")), input.GetProperty("trustedFixtureState")));
            return;
        }
        Assert.Fail("signed fixture case was not found");
    }

    // Supplemental N1 assertions; not part of the byte-exact signed N0 fixture.
    public static IEnumerable<object[]> WireCases()
    {
        yield return new object[] { "BOM", new byte[] { 0xef, 0xbb, 0xbf }.Concat(Bytes(Wire)).ToArray(), "", "CONTRACT_INVALID" };
        yield return new object[] { "invalid UTF-8", Convert.FromHexString("7b2274657874223a22eda080227d"), "", "CONTRACT_INVALID" };
        yield return new object[] { "syntax precedes duplicate", Bytes("""{"schemaVersion":1,"schemaVersion":2,}"""), "", "CONTRACT_INVALID" };
        yield return new object[] { "first duplicate precedes version and later duplicates", Bytes("""{"payload":{"text":1,"te\u0078t":2},"schemaVersion":2,"schemaVersion":1}"""), "/payload/text", "CONTRACT_INVALID" };
        yield return new object[] { "nested unknown duplicate redacts path", Bytes("""{"payload":{"unlisted":[{"actorUserId":1,"actorUserId":2}]},"schemaVersion":2}"""), "/payload", "CONTRACT_INVALID" };
        yield return new object[] { "duplicates inside root array precede root shape but redact", Bytes("""[{"schemaVersion":1,"schemaVersion":1}]"""), "", "CONTRACT_INVALID" };
        yield return new object[] { "known field validation precedes extras", Bytes(Wire.Replace("\"expectedRevision\":7", "\"expectedRevision\":7.0,\"actorUserId\":0", StringComparison.Ordinal)), "/expectedRevision", "CONTRACT_INVALID" };
        yield return new object[] { "exponent version token", Bytes(Wire.Replace("\"schemaVersion\":1", "\"schemaVersion\":1e0", StringComparison.Ordinal)), "/schemaVersion", "CONTRACT_INVALID" };
        yield return new object[] { "rounded oversized version token", Bytes(Wire.Replace("\"schemaVersion\":1", "\"schemaVersion\":9007199254740992", StringComparison.Ordinal)), "/schemaVersion", "CONTRACT_INVALID" };
        yield return new object[] { "max supported numeric token but unsupported version", Bytes(Wire.Replace("\"schemaVersion\":1", "\"schemaVersion\":9007199254740991", StringComparison.Ordinal)), "/schemaVersion", "UNSUPPORTED_VERSION" };
        yield return new object[] { "nested known extras beat nested unknown extras", Bytes(Wire.Replace("\"subtitleId\"", "\"unknownSentinel\":0,\"eventId\":0,\"actorUserId\":0,\"subtitleId\"", StringComparison.Ordinal)), "/payload/actorUserId", "CONTRACT_INVALID" };
        yield return new object[] { "C1 control", Bytes(Wire.Replace(Text, "\\u0085", StringComparison.Ordinal)), "/payload/text", "CONTRACT_INVALID" };
        yield return new object[] { "501 scalars", Bytes(Wire.Replace(Text, string.Concat(Enumerable.Repeat("😀", 501)), StringComparison.Ordinal)), "/payload/text", "CONTRACT_INVALID" };
    }

    [Theory]
    [Trait("Pack", "K01")]
    [MemberData(nameof(WireCases), DisableDiscoveryEnumeration = true)]
    public void SupplementalWireCase(string id, byte[] bytes, string path, string code)
    {
        var expected = JsonSerializer.SerializeToElement(new { ok = false, error = new { code, path } }, Options);
        var actual = ReadK01(bytes);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(expected.GetRawText()), JsonNode.Parse(actual.GetRawText())),
            $"{id}: expected {expected.GetRawText()}, got {actual.GetRawText()}");
    }

    [Fact]
    [Trait("Pack", "K01")]
    public void MaterializedJsonIsNotK01Wire()
    {
        using var parsed = JsonDocument.Parse(Wire);
        // The older materialized API remains K07-only; the new API accepts bytes only.
        Assert.Equal(Slice, K01ContractValidator.Key);
        Assert.False(ContractValidator.Validate(Slice, parsed.RootElement).Ok);
    }

    [Fact]
    [Trait("Pack", "K01")]
    public void Preserves500ScalarsLfSpacesAndMaxRevision()
    {
        var text = " " + string.Concat(Enumerable.Repeat("😀", 497)) + "\n ";
        var escaped = JsonSerializer.Serialize(text);
        var raw = Wire.Replace(Text, escaped[1..^1], StringComparison.Ordinal)
            .Replace("\"expectedRevision\":7", "\"expectedRevision\":9007199254740990", StringComparison.Ordinal);
        var actual = ReadK01(Bytes(raw));
        Assert.True(actual.GetProperty("ok").GetBoolean());
        var value = actual.GetProperty("value");
        Assert.Equal(text, String(value.GetProperty("payload"), "text"));
        Assert.Equal(9007199254740990, Number(value, "expectedRevision"));
    }

    [Fact]
    [Trait("Pack", "K01")]
    public void DigestMatches103ByteVectorAndPreservesScalarDifferences()
    {
        const string subtitle = "22222222-2222-4222-8222-222222222222";
        Assert.Equal((103, Vector), Digest(7, subtitle, Text));
        var raw = String(Fixture[1].GetProperty("input"), "wireJson").Replace("你好", "\\u4f60\\u597d", StringComparison.Ordinal);
        var equivalent = ReadK01(Bytes(raw));
        Assert.True(equivalent.GetProperty("ok").GetBoolean());
        var value = equivalent.GetProperty("value");
        var payload = value.GetProperty("payload");
        Assert.Equal((103, Vector), Digest(Number(value, "expectedRevision"), String(payload, "subtitleId"), String(payload, "text")));
        Assert.NotEqual(Digest(7, subtitle, "é").Sha256, Digest(7, subtitle, "e\u0301").Sha256);
        Assert.NotEqual(Vector, Digest(8, subtitle, Text).Sha256);
        Assert.NotEqual(Vector, Digest(7, OtherKey, Text).Sha256);
    }

    [Theory]
    [Trait("Pack", "K01")]
    [InlineData("actorUserId")]
    [InlineData("commandName")]
    [InlineData("projectId")]
    public void StoredKeyAndCommandAreInvisibleAcrossScope(string dimension)
    {
        var state = First.GetProperty("trustedFixtureState");
        var stored = Fixture[1].GetProperty("input").GetProperty("trustedFixtureState").GetProperty("storedOutcome");
        var scope = (dimension == "actorUserId" ? "different synthetic actor" : String(state, "actorUserId"),
            dimension == "commandName" ? "different synthetic command" : "project.subtitle_text.replace",
            dimension == "projectId" ? "different synthetic project" : String(state.GetProperty("project"), "id"));
        var expected = Fixture[0].GetProperty("expected");
        AssertJson(expected, Model(Bytes(Wire), state, () => stored, scope));
        AssertJson(expected, Model(Bytes(Wire.Replace(String(stored, "idempotencyKey"), OtherKey, StringComparison.Ordinal)), state, () => stored, scope));
    }

    [Fact]
    [Trait("Pack", "K01")]
    public void RejectCorrectSameKeyAndReplayOneCommittedWrite()
    {
        var state = First.GetProperty("trustedFixtureState");
        var memory = new Memory(state);
        AssertJson(JsonSerializer.SerializeToElement(Failure("REVISION_CONFLICT", "/expectedRevision", 7), Options),
            Model(Bytes(Wire.Replace("\"expectedRevision\":7", "\"expectedRevision\":6", StringComparison.Ordinal)), state, memory: memory));
        Assert.Equal(JsonValueKind.Null, memory.Outcome.ValueKind);
        AssertJson(Fixture[0].GetProperty("expected"), Model(Bytes(Wire), state, memory: memory));
        Assert.Equal(8, memory.Head);
        AssertJson(Fixture[1].GetProperty("expected"), Model(Bytes(Wire), state, memory: memory));
        Assert.Equal(1, memory.Writes);
    }

    [Fact]
    [Trait("Pack", "K01")]
    public void DeniedInputNeverQueriesAnOutcome()
    {
        var denied = Fixture[6].GetProperty("input").GetProperty("trustedFixtureState");
        AssertJson(Fixture[6].GetProperty("expected"), Model(Bytes(Wire), denied,
            () => throw new InvalidOperationException("denied input queried a stored outcome")));
    }
}