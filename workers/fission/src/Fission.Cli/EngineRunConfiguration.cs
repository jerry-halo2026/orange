// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using System.Text.Json;
using System.Text.Json.Serialization;
using Fission.Core.Engine;
using Fission.Core.Errors;
using Fission.Core.Jobs;
using Fission.Core.Pipeline;

namespace Fission.Cli;

/// <summary>Explicit configuration for the original controlled CLI run.</summary>
public sealed class EngineRunConfiguration
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        Converters = { new JsonStringEnumConverter() },
    };

    private EngineRunConfiguration(EnginePathPolicy policy, FissionJob job)
    { Policy = policy; Job = job; }

    /// <summary>The existing task-attempt path policy, not a new job protocol.</summary>
    public EnginePathPolicy Policy { get; }

    /// <summary>The unchanged original job.</summary>
    public FissionJob Job { get; }

    public string Mode { get; private init; } = "run";
    public string? SnapshotPath { get; private init; }
    public IReadOnlyList<int>? OutputIndices { get; private init; }
    public FissionPreparedDecisions? Prepared { get; private init; }

    /// <summary>
    /// Read and validate all explicit run inputs before the caller creates a
    /// process pool, probes hardware or writes runtime directories. This does not
    /// establish media ownership, licensing or shared combination admission.
    /// </summary>
    public static EngineRunConfiguration Load(string[] args) => LoadCore(args, true);
    private static EngineRunConfiguration LoadCore(string[] args, bool validateInputs)
    {
        try
        {
            if (args is null || args.Length != 11 || !string.Equals(args[0], "run", StringComparison.OrdinalIgnoreCase))
                throw InvalidConfiguration();
            var options = new Dictionary<string, string>(StringComparer.Ordinal);
            for (var i = 1; i < args.Length; i += 2)
            {
                var name = args[i]; var value = args[i + 1];
                if (name is not ("--paths" or "--workspace" or "--task" or "--attempt" or "--job")
                    || string.IsNullOrWhiteSpace(value) || !options.TryAdd(name, value))
                    throw InvalidConfiguration();
            }
            if (options.Count != 5) throw InvalidConfiguration();
            var paths = ReadPaths(options["--paths"]);
            var policy = new EnginePathPolicy(paths, options["--workspace"], options["--task"], options["--attempt"]);
            var job = JsonSerializer.Deserialize<FissionJob>(File.ReadAllText(options["--job"]), JsonOptions)
                ?? throw InvalidConfiguration();
            policy.ValidateJob(job);
            if (validateInputs) new EngineJobFiles(policy).ValidateJobInputs(job);
            if (validateInputs) job.Validate(); else job.ValidateConfiguration();
            return new EngineRunConfiguration(policy, job);
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException
            or ArgumentException or FissionException)
        {
            // Paths, JSON fragments and underlying I/O messages remain private: only the message's own words travel.
            throw InvalidConfiguration(error);
        }
    }

    /// <summary>Native stage commands reuse the original job/five isolation options. They authorize no business.</summary>
    public static EngineRunConfiguration LoadCommand(string[] args)
    {
        try
        {
            if (args.Length == 0) throw InvalidConfiguration();
            var mode = args[0].ToLowerInvariant();
            if (mode == "run") return Load(args);
            if (mode == "prepare")
            {
                var original = (string[])args.Clone(); original[0] = "run";
                var config = Load(original);
                return new EngineRunConfiguration(config.Policy, config.Job) { Mode = mode, SnapshotPath = Path.Combine(config.Policy.Paths.WorkRoot, "prepared.json") };
            }
            if (mode != "execute-prepared" || args.Length is not (15 or 17)) throw InvalidConfiguration();
            var nativeArgs = new List<string> { "run" }; string? file = null, digest = null, selection = null;
            for (var i = 1; i < args.Length; i += 2)
            {
                if (args[i] == "--prepared") { if (file is not null) throw InvalidConfiguration(); file = args[i + 1]; }
                else if (args[i] == "--digest") { if (digest is not null) throw InvalidConfiguration(); digest = args[i + 1]; }
                else if (args[i] == "--outputs") { if (selection is not null || string.IsNullOrWhiteSpace(args[i + 1])) throw InvalidConfiguration(); selection = args[i + 1]; }
                else { nativeArgs.Add(args[i]); nativeArgs.Add(args[i + 1]); }
            }
            if (file is null || digest is null || digest.Length != 64 || digest.Any(c => !char.IsAsciiHexDigit(c))) throw InvalidConfiguration();
            int[]? outputIndices = null;
            if (selection is not null)
            {
                if (selection.Length > 131072) throw InvalidConfiguration();
                using var json = JsonDocument.Parse(selection);
                if (json.RootElement.ValueKind != JsonValueKind.Array || json.RootElement.GetArrayLength() is < 1 or > 10000) throw InvalidConfiguration();
                outputIndices = json.RootElement.EnumerateArray().Select(value => value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var index) ? index : throw InvalidConfiguration()).ToArray();
                if (outputIndices.Distinct().Count() != outputIndices.Length || outputIndices.Any(index => index < 0)) throw InvalidConfiguration();
            }
            var loaded = LoadCore(nativeArgs.ToArray(), outputIndices is null); var files = new EngineJobFiles(loaded.Policy);
            files.ValidateOwnedFile(file);
            using var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
            files.ValidateOwnedFile(file); if (input.Length > 4 * 1024 * 1024) throw InvalidConfiguration();
            using var reader = new StreamReader(input);
            var prepared = FissionPreparedDecisions.Parse(reader.ReadToEnd());
            if (prepared.Digest != digest || prepared.WorkRoot != loaded.Policy.Paths.WorkRoot || prepared.OutRoot != loaded.Policy.Paths.OutRoot
                || prepared.CacheRoot != loaded.Policy.CacheRoot || prepared.JobSha256 != FissionPreparedDecisions.HashJob(loaded.Job)) throw InvalidConfiguration();
            if (outputIndices is not null && outputIndices.Any(index => !prepared.Outputs.Any(output => output.Index == index))) throw InvalidConfiguration();
            return new EngineRunConfiguration(loaded.Policy, loaded.Job) { Mode = mode, SnapshotPath = file, Prepared = prepared,
                OutputIndices = outputIndices is null ? null : Array.AsReadOnly(outputIndices) };
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException or ArgumentException or FissionException)
        { throw InvalidConfiguration(error); }
    }

    private static EnginePaths ReadPaths(string file)
    {
        using var json = JsonDocument.Parse(File.ReadAllText(file));
        if (json.RootElement.ValueKind != JsonValueKind.Object) throw InvalidConfiguration();
        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in json.RootElement.EnumerateObject())
        {
            if (property.Name is not ("FFmpeg" or "FFprobe" or "FFmpeg6" or "TransitionsDir" or "AssetsRoot" or "LocalAssetsRoot")
                || property.Value.ValueKind != JsonValueKind.String)
                throw InvalidConfiguration();
            var value = property.Value.GetString();
            if (string.IsNullOrWhiteSpace(value) || !fields.TryAdd(property.Name, value)) throw InvalidConfiguration();
        }

        // FFmpeg6 是可选能力（gltransition）：缺省即单引擎 9.x 路径，不算配置错误。
        foreach (var required in new[] { "FFmpeg", "FFprobe", "TransitionsDir", "AssetsRoot", "LocalAssetsRoot" })
        {
            if (!fields.ContainsKey(required)) throw InvalidConfiguration();
        }

        return new EnginePaths
        {
            FFmpeg = fields["FFmpeg"], FFprobe = fields["FFprobe"], FFmpeg6 = fields.GetValueOrDefault("FFmpeg6", string.Empty),
            TransitionsDir = fields["TransitionsDir"], AssetsRoot = fields["AssetsRoot"], LocalAssetsRoot = fields["LocalAssetsRoot"],
            WorkRoot = string.Empty, OutRoot = string.Empty,
        };
    }

    /// <summary>
    /// LoadCore 的每个失败都走到这里。原来只给一句"配置或任务无效"，而真正的原因（哪条路径、哪个字段）
    /// 被吞掉了 —— 调试时那是最贵的成本。现在把捕获到的异常带成 InnerException，由 Program 打印出来。
    /// </summary>
    private static ConfigException InvalidConfiguration(Exception? cause = null)
        => new("CFG_ARGS", "混剪配置或任务无效；请提供完整的显式隔离参数。", retryable: false, inner: cause);
}