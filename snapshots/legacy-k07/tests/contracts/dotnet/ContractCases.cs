using System;
using System.Collections.Generic;
using System.IO;
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
