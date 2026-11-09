using System.Text.Json;
using System.Text.Json.Serialization;
using Fission.Core.Engine;
using Fission.Core.Errors;
using Fission.Core.Jobs;

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

    /// <summary>
    /// Read and validate all explicit run inputs before the caller creates a
    /// process pool, probes hardware or writes runtime directories. This does not
    /// establish media ownership, licensing or shared combination admission.
    /// </summary>
    public static EngineRunConfiguration Load(string[] args)
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
            new EngineJobFiles(policy).ValidateJobInputs(job);
            job.Validate();
            return new EngineRunConfiguration(policy, job);
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException
            or ArgumentException or FissionException)
        {
            // Paths, JSON fragments and underlying I/O messages remain private.
            throw InvalidConfiguration();
        }
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
        if (fields.Count != 6) throw InvalidConfiguration();
        return new EnginePaths
        {
            FFmpeg = fields["FFmpeg"], FFprobe = fields["FFprobe"], FFmpeg6 = fields["FFmpeg6"],
            TransitionsDir = fields["TransitionsDir"], AssetsRoot = fields["AssetsRoot"], LocalAssetsRoot = fields["LocalAssetsRoot"],
            WorkRoot = string.Empty, OutRoot = string.Empty,
        };
    }

    private static ConfigException InvalidConfiguration()
        => new("CFG_ARGS", "混剪配置或任务无效；请提供完整的显式隔离参数。");
}