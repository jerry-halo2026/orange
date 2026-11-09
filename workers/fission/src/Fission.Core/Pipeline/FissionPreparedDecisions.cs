using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Fission.Core.Errors;
using Fission.Core.Engine;
using Fission.Core.Jobs;
using Fission.Core.Materials;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Fission.Core.Pipeline;

/// <summary>Native file/version evidence only. Never an entitlement or a business grant.</summary>
public sealed record PreparedSourceVersion(string Path, string Sha256, bool Owned, string Identity);
public sealed record PreparedNormalization(int Source, string Path, string Sha256, double DurationSec, double? ImageHoldSec);
public sealed record PreparedGeneratedAudio(string Path, string ProofPath, string ProofSha256, string Purpose);
public sealed record PreparedCut(VisualDecision Decision, PreparedNormalization Normalization);
/// <summary>Expected clock/FX intention, explicitly NOT a measured assembled output.</summary>
public sealed record PreparedOutput(int Index, string Title, string VoicePath, string? MusicPath, double TargetSec, AudioDecision Audio, MaterialItem AudioItem, IReadOnlyList<MaterialItem> SelectedVideos,
    IReadOnlyList<FissionSource> Sources, IReadOnlyList<PreparedCut> Cuts, AlignmentDecision AlignmentIntent,
    TransitionDecision TransitionIntent, SubtitleDecision SubtitleIntent, IReadOnlyList<string> ConsumeVideoPaths, PreparedGeneratedAudio? GeneratedVoice);

/// <summary>Immutable, non-authorizing decisions from the original producer before final media work.</summary>
public sealed record FissionPreparedDecisions(int SchemaVersion, string JobId, string JobSha256, string WorkRoot,
    string OutRoot, string CacheRoot, string RuntimeSha256, IReadOnlyList<PreparedOutput> Outputs, IReadOnlyList<PreparedSourceVersion> Versions, string Digest)
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        Converters = { new JsonStringEnumConverter() },
    };
    public bool AuthorizesBusiness { get; }
    public bool MeasuredAssemblyClock { get; }
    public string ToJson() => JsonSerializer.Serialize(this, Options);
    public static string HashJob(FissionJob job) => Hash(JsonSerializer.Serialize(job, Options));
    public static string HashRuntime(EnginePaths paths) => Hash(JsonSerializer.Serialize(new { paths.FFmpeg, paths.FFprobe, paths.FFmpeg6, paths.TransitionsDir, paths.AssetsRoot, paths.LocalAssetsRoot }, Options));
    private static string Hash(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    private string Payload() => JsonSerializer.Serialize(new { SchemaVersion, JobId, JobSha256, WorkRoot, OutRoot, CacheRoot, RuntimeSha256, Outputs, Versions }, Options);
    public static FissionPreparedDecisions Create(FissionJob job, string jobId, string workRoot, string outRoot, string cacheRoot, EnginePaths paths,
        IEnumerable<PreparedOutput> outputs, IEnumerable<PreparedSourceVersion> versions)
    {
        var value = new FissionPreparedDecisions(1, jobId, HashJob(job), workRoot, outRoot, cacheRoot, HashRuntime(paths),
            Array.AsReadOnly(outputs.OrderBy(o => o.Index).Select(Freeze).ToArray()), Array.AsReadOnly(versions.OrderBy(v => v.Path, StringComparer.Ordinal).ToArray()), string.Empty);
        return value with { Digest = Hash(value.Payload()) };
    }
    private static PreparedOutput Freeze(PreparedOutput value) => value with
    {
        Sources = Array.AsReadOnly(value.Sources.ToArray()), SelectedVideos = Array.AsReadOnly(value.SelectedVideos.ToArray()), Cuts = Array.AsReadOnly(value.Cuts.ToArray()),
        ConsumeVideoPaths = Array.AsReadOnly(value.ConsumeVideoPaths.ToArray()),
        SubtitleIntent = value.SubtitleIntent with { Cues = Array.AsReadOnly(value.SubtitleIntent.Cues.ToArray()) },
    };
    public static FissionPreparedDecisions Parse(string json)
    {
        try
        {
            if (Encoding.UTF8.GetByteCount(json) > 4 * 1024 * 1024) throw Invalid();
            var value = JsonSerializer.Deserialize<FissionPreparedDecisions>(json, Options) ?? throw Invalid();
            value.Validate();
            return value with { Outputs = Array.AsReadOnly(value.Outputs.Select(Freeze).ToArray()), Versions = Array.AsReadOnly(value.Versions.ToArray()) };
        }
        catch (Exception error) when (error is JsonException or ArgumentException or NullReferenceException) { throw Invalid(); }
    }
    public void Validate()
    {
        if (SchemaVersion != 1 || string.IsNullOrEmpty(JobId) || JobId.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_'))
            || Outputs is null || Versions is null || Outputs.Count is < 1 or > 10000 || Versions.Count is < 1 or > 100000
            || Outputs.Select(o => o.Index).Distinct().Count() != Outputs.Count || Digest != Hash(Payload())) throw Invalid();
        foreach (var output in Outputs)
        {
            if (output.Index < 0 || string.IsNullOrWhiteSpace(output.Title) || output.Sources is null || output.Cuts is null || output.Cuts.Count is < 1 or > 20000
                || !double.IsFinite(output.TargetSec) || output.TargetSec <= 0 || output.TransitionIntent.Outcome != "prepared-intent") throw Invalid();
            foreach (var cut in output.Cuts)
                if (cut.Decision.Source < 0 || cut.Decision.Source >= output.Sources.Count || cut.Normalization.Source != cut.Decision.Source
                    || cut.Decision.StartSec < 0 || cut.Decision.DurationSec <= 0 || cut.Decision.Speed <= 0
                    || !double.IsFinite(cut.Decision.StartSec + cut.Decision.DurationSec + cut.Decision.Speed)
                    || cut.Decision.StartSec + cut.Decision.DurationSec > cut.Normalization.DurationSec + .001) throw Invalid();
        }
        foreach (var version in Versions)
            if (!System.IO.Path.IsPathFullyQualified(version.Path) || version.Sha256.Length != 64 || version.Sha256.Any(c => !char.IsAsciiHexDigit(c))) throw Invalid();
    }
    private static ConfigException Invalid() => new("CFG_PREPARED_INVALID", "Prepared native decisions are missing, altered or invalid.");
}

/// <summary>Exact Windows opened-file identity for native prepared provenance. Not a logical asset identifier.</summary>
public static class PreparedFileIdentity
{
    public static string Read(SafeFileHandle handle)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Prepared filesystem binding is qualified only on Windows.");
        if (!GetFileInformationByHandle(handle, out var i) || i.Links != 1) throw new IOException("Prepared source must have one ordinary filesystem binding.");
        return $"{i.Volume:x8}:{i.IndexHigh:x8}{i.IndexLow:x8}:{i.SizeHigh:x8}{i.SizeLow:x8}:{i.Write.dwHighDateTime:x8}{i.Write.dwLowDateTime:x8}";
    }
    [StructLayout(LayoutKind.Sequential)] private struct Information
    {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Information information);
}
