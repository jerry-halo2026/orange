using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Fission.Core.Pipeline;
using Fission.Core.Jobs;

namespace Fission.Core.Engine;

/// <summary>
/// Opt-in file control for one explicit EnginePathPolicy attempt. Input roots must
/// be authorized by the trusted caller independently; these checks do not prove
/// ownership/licensing or protect against hostile concurrent path replacement.
/// No original input is ever moved, deleted or opened for writing.
/// </summary>
public sealed class EngineJobFiles
{
    private readonly EnginePathPolicy policy;
    private readonly string managedRoot;
    private readonly HashSet<string> audio = new(StringComparer.Ordinal);
    private readonly HashSet<string> nativeGenerated = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (PreparedGeneratedAudio Evidence, string Identity, string Sha, string ProofIdentity)> preparedGenerated = new(StringComparer.Ordinal);
    private readonly HashSet<string> generated = new(StringComparer.Ordinal);
    private readonly object gate = new();

    /// <summary>Bind precisely the caller's policy and derived writable namespace.</summary>
    public EngineJobFiles(EnginePathPolicy policy)
    {
        this.policy = policy ?? throw new ArgumentNullException(nameof(policy));
        managedRoot = Directory.GetParent(Directory.GetParent(Directory.GetParent(policy.Paths.WorkRoot)!.FullName)!.FullName)!.FullName;
    }

    /// <summary>Validate original input directories, without writing or probing media.</summary>
    public void ValidateJobInputs(FissionJob job)
    {
        ArgumentNullException.ThrowIfNull(job);
        foreach (var directory in new[] { job.VideoDir, job.AudioDir, job.BgmDir, job.IntroDir, job.OutroDir })
        {
            if (directory is null) continue;
            ValidateReadOnlyDirectory(directory);
            foreach (var file in Directory.EnumerateFiles(directory)) ValidateReadOnlyFile(file);
        }
        // Original engine reads only one level of scene groups. Refuse linked
        // children before enumeration rather than following them recursively.
        foreach (var directory in Directory.EnumerateDirectories(job.VideoDir))
        {
            ValidateReadOnlyDirectory(directory);
            foreach (var file in Directory.EnumerateFiles(directory)) ValidateReadOnlyFile(file);
        }
        if (job.AudioDir is not null)
            ValidateOptionalReadOnlyFile(Path.Combine(Directory.GetParent(job.AudioDir)!.FullName, "meta.json"));
    }

    /// <summary>Check every initial directory before any mkdir; refuse attempt reuse.</summary>
    public void PrepareRun(FissionJob job, string jobId)
    {
        var output = policy.ValidateJob(job);
        ValidateJobInputs(job);
        var work = policy.ValidateWritablePath(Path.Combine(policy.Paths.WorkRoot, jobId));
        var directories = new[] { work, Path.Combine(work, "norm"), Path.Combine(work, "voice"),
            Path.Combine(work, "temp"), Path.Combine(work, "fengmian"), Path.Combine(output, jobId), policy.CacheRoot };
        foreach (var directory in directories) policy.ValidateWritablePath(directory);
        foreach (var root in new[] { policy.Paths.WorkRoot, Path.Combine(output, jobId), policy.CacheRoot })
            if (Directory.Exists(root)) throw new IOException("Controlled run requires fresh task-attempt storage.");
        foreach (var directory in directories) CreateDirectory(directory);
    }

    /// <summary>Create only a directory revalidated against this attempt.</summary>
    public void CreateDirectory(string path) => Directory.CreateDirectory(policy.ValidateWritablePath(path));

    /// <summary>Validate an independently caller-approved regular input file.</summary>
    public string ValidateReadOnlyFile(string path)
    {
        var full = Canonical(path, directory: false, mustExist: true);
        RefuseInputOverlap(full);
        return full;
    }

    /// <summary>Validate an independently caller-approved source directory.</summary>
    public string ValidateReadOnlyDirectory(string path)
    {
        var full = Canonical(path, directory: true, mustExist: true);
        RefuseInputOverlap(full);
        return full;
    }

    /// <summary>Inspect even a dangling metadata link before optional reading.</summary>
    public string ValidateOptionalReadOnlyFile(string path)
    {
        var full = Canonical(path, directory: false, mustExist: false);
        RefuseInputOverlap(full);
        return full;
    }

    /// <summary>Validate the actual owned filename and its policy-approved parent.</summary>
    public string ValidateOwnedFile(string path, bool mustExist = true)
    {
        var full = Canonical(path, directory: false, mustExist: mustExist);
        policy.ValidateWritablePath(Path.GetDirectoryName(full)!);
        return full;
    }

    /// <summary>Refuse any existing output, including ordinary files/hardlinks.</summary>
    public string ValidateNewOutput(string path)
    {
        var full = ValidateOwnedFile(path, mustExist: false);
        if (File.Exists(full)) throw new IOException("Controlled output already exists.");
        return full;
    }

    /// <summary>
    /// Open source read-only and create an exclusive, never-overwritten private
    /// copy. Only a fully copied and revalidated file becomes archive-eligible.
    /// A failed partial file is retained as owned evidence, never registered.
    /// </summary>
    public async Task<string> CopyAudioAsync(string source, string voiceDirectory, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        source = ValidateReadOnlyFile(source);
        voiceDirectory = policy.ValidateWritablePath(voiceDirectory);
        var destination = ValidateNewOutput(Path.Combine(voiceDirectory, Path.GetFileName(source)));
        await using (var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, FileOptions.Asynchronous | FileOptions.SequentialScan))
        {
            ValidateReadOnlyFile(source);
            ct.ThrowIfCancellationRequested();
            CreateDirectory(voiceDirectory);
            ValidateNewOutput(destination);
            await using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, FileOptions.Asynchronous))
            {
                await input.CopyToAsync(output, ct).ConfigureAwait(false);
                await output.FlushAsync(ct).ConfigureAwait(false);
                ct.ThrowIfCancellationRequested();
                ValidateReadOnlyFile(source);
                ValidateOwnedFile(destination);
            }
        }
        lock (gate) audio.Add(destination);
        return destination;
    }

    /// <summary>Reserve a new owned destination before the codec can overwrite it.</summary>
    public void PrepareGeneratedAudio(string path)
    {
        path = ValidateNewOutput(path);
        CreateDirectory(Path.GetDirectoryName(path)!);
        using (new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
        lock (gate) generated.Add(path);
    }

    /// <summary>Register successful generated audio, not arbitrary preexisting files.</summary>
    public void RegisterGeneratedAudio(string path)
    {
        path = ValidateOwnedFile(path);
        lock (gate)
        {
            if (!generated.Contains(path) || new FileInfo(path).Length == 0)
                throw new ArgumentException("Audio must be a completed, freshly reserved generated file.", nameof(path));
            generated.Remove(path);
            audio.Add(path);
            nativeGenerated.Add(path);
        }
    }

    /// <summary>
    /// Called only after MaterialPool.Confirm by the original orchestrator.
    /// Archive only this helper's registered copy/generated audio, never source.
    /// </summary>
    public string ArchiveAudio(string path)
    {
        lock (gate)
        {
            if (!audio.Contains(path)) throw new ArgumentException("Audio is not registered to this attempt.", nameof(path));
            path = ValidateOwnedFile(path);
            var directory = policy.ValidateWritablePath(Path.Combine(policy.Paths.WorkRoot, "_consumed"));
            var destination = ValidateNewOutput(Path.Combine(directory, Path.GetFileName(path)));
            CreateDirectory(directory);
            ValidateOwnedFile(path);
            ValidateNewOutput(destination);
            File.Move(path, destination); // No overwrite; only the owned copy is moved.
            audio.Remove(path);
            return destination;
        }
    }

    private const string PreparedPurpose = "native-offline-lavfi-voice/v1";
    private static readonly JsonSerializerOptions PreparedJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private sealed record GeneratedProof(int Version, string JobId, string WorkRoot, string Path, string Purpose, string Identity, string Sha256, string Mac);
    private string GeneratedPath(string path, string jobId)
    {
        path = ValidateOwnedFile(path);
        var expected = Path.Combine(policy.Paths.WorkRoot, jobId, "voice", Path.GetFileName(path));
        var stem = Path.GetFileNameWithoutExtension(path);
        if (path != expected || Path.GetExtension(path) != ".mp3" || !stem.StartsWith("gen_", StringComparison.Ordinal)
            || stem.Length < 7 || !stem[4..].All(char.IsAsciiDigit)) throw new ArgumentException("Only exact native prepared voice/gen*.mp3 is eligible.", nameof(path));
        return path;
    }
    private static string HeldHash(FileStream held)
    {
        var position = held.Position; held.Position = 0;
        try { return Convert.ToHexStringLower(SHA256.HashData(held)); } finally { held.Position = position; }
    }
    private static void VerifyHeld(string path, FileStream held, string identity, string sha)
    {
        if (held.Name != path || PreparedFileIdentity.Read(held.SafeFileHandle) != identity || HeldHash(held) != sha) throw new IOException("Prepared opened-file evidence differs.");
        using var now = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (PreparedFileIdentity.Read(now.SafeFileHandle) != identity) throw new IOException("Prepared pathname no longer names the held file.");
    }
    private byte[] PreparedKey(bool create)
    {
        var file = Path.Combine(policy.CacheRoot, ".native-prepared-generated.key");
        if (create && !File.Exists(file))
        {
            ValidateNewOutput(file); CreateDirectory(policy.CacheRoot);
            using var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            output.Write(RandomNumberGenerator.GetBytes(32));
        }
        ValidateOwnedFile(file);
        using var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
        ValidateOwnedFile(file); if (input.Length != 32) throw new IOException("Native generated-origin seal is invalid.");
        var key = new byte[32]; input.ReadExactly(key); return key;
    }
    private static string ProofPayload(GeneratedProof proof) => JsonSerializer.Serialize(proof with { Mac = string.Empty }, PreparedJson);
    /// <summary>Seal only a voice this very helper actually reserved and registered as generated; never an incoming path.</summary>
    public PreparedGeneratedAudio SealPreparedGeneratedAudio(string path, string jobId, FileStream held)
    {
        lock (gate)
        {
            path = GeneratedPath(path, jobId);
            if (!nativeGenerated.Contains(path) || !audio.Contains(path)) throw new ArgumentException("Voice was not generated by this native preparation.", nameof(path));
            var identity = PreparedFileIdentity.Read(held.SafeFileHandle); var sha = HeldHash(held); VerifyHeld(path, held, identity, sha);
            if (preparedGenerated.TryGetValue(path, out var existing))
            {
                // Reuse only THIS producer instance's prior seal of the exact held version.
                // A preexisting disk marker, even with matching path/hash, is never adopted here.
                ValidateOwnedFile(existing.Evidence.ProofPath);
                using var proofInput = new FileStream(existing.Evidence.ProofPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                if (existing.Identity != identity || existing.Sha != sha || PreparedFileIdentity.Read(proofInput.SafeFileHandle) != existing.ProofIdentity
                    || HeldHash(proofInput) != existing.Evidence.ProofSha256) throw new IOException("Prepared generated seal version changed.");
                return existing.Evidence;
            }
            var proof = new GeneratedProof(1, jobId, policy.Paths.WorkRoot, path, PreparedPurpose, identity, sha, string.Empty);
            var key = PreparedKey(true);
            try { proof = proof with { Mac = Convert.ToHexStringLower(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(ProofPayload(proof)))) }; }
            finally { CryptographicOperations.ZeroMemory(key); }
            var proofPath = ValidateNewOutput(path + ".prepared-generated.json");
            var bytes = JsonSerializer.SerializeToUtf8Bytes(proof, PreparedJson);
            using (var output = new FileStream(proofPath, FileMode.CreateNew, FileAccess.Write, FileShare.None)) output.Write(bytes);
            var evidence = new PreparedGeneratedAudio(path, proofPath, Convert.ToHexStringLower(SHA256.HashData(bytes)), PreparedPurpose);
            using var sealedInput = new FileStream(proofPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            preparedGenerated.Add(path, (evidence, identity, sha, PreparedFileIdentity.Read(sealedInput.SafeFileHandle)));
            return evidence;
        }
    }
    /// <summary>New native execute owner adopts only sealed original prepare output with held exact file/version and task provenance.</summary>
    public void AdoptPreparedGeneratedAudio(FissionPreparedDecisions prepared, PreparedOutput output, FileStream held)
    {
        lock (gate)
        {
            prepared.Validate(); var evidence = output.GeneratedVoice ?? throw new ArgumentException("Generated provenance is absent.", nameof(output));
            if (prepared.WorkRoot != policy.Paths.WorkRoot || prepared.CacheRoot != policy.CacheRoot || evidence.Purpose != PreparedPurpose
                || evidence.Path != output.VoicePath || output.AudioItem.Path != evidence.Path || output.Sources[output.Audio.Voice.Source].Path != evidence.Path
                || evidence.ProofPath != evidence.Path + ".prepared-generated.json") throw new ArgumentException("Generated provenance binding differs.", nameof(output));
            var path = GeneratedPath(evidence.Path, prepared.JobId); ValidateOwnedFile(evidence.ProofPath);
            if (!prepared.Versions.Any(v => v.Path == evidence.ProofPath && v.Sha256 == evidence.ProofSha256 && v.Owned)) throw new IOException("Generated proof version was not held by preparation.");
            var bytes = File.ReadAllBytes(evidence.ProofPath);
            if (Convert.ToHexStringLower(SHA256.HashData(bytes)) != evidence.ProofSha256) throw new IOException("Generated proof changed.");
            var proof = JsonSerializer.Deserialize<GeneratedProof>(bytes, PreparedJson) ?? throw new IOException("Generated proof is invalid.");
            if (proof.Version != 1 || proof.JobId != prepared.JobId || proof.WorkRoot != policy.Paths.WorkRoot || proof.Path != path || proof.Purpose != PreparedPurpose)
                throw new IOException("Generated proof purpose/task differs.");
            var version = prepared.Versions.Single(v => v.Path == path && v.Owned);
            if (proof.Identity != version.Identity || proof.Sha256 != version.Sha256) throw new IOException("Generated proof version differs.");
            VerifyHeld(path, held, proof.Identity, proof.Sha256);
            var key = PreparedKey(false);
            try
            {
                var mac = HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(ProofPayload(proof)));
                if (!CryptographicOperations.FixedTimeEquals(mac, Convert.FromHexString(proof.Mac))) throw new IOException("Generated origin was not sealed by native preparation.");
            }
            finally { CryptographicOperations.ZeroMemory(key); }
            ValidateOwnedFile(path); audio.Add(path);
        }
    }

    private void RefuseInputOverlap(string path)
    {
        if (Contains(managedRoot, path) || Contains(path, managedRoot))
            throw new ArgumentException("Input and managed writable trees must be disjoint.", nameof(path));
    }

    private static bool Contains(string root, string path)
        => path.Equals(root, StringComparison.Ordinal) || path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal);

    private static string Canonical(string path, bool directory, bool mustExist)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path))
            throw new ArgumentException("An explicit canonical local path is required.", nameof(path));
        var root = Path.GetPathRoot(path)!;
        if (path.Length == root.Length || (OperatingSystem.IsWindows() && (root[0] == Path.DirectorySeparatorChar || char.IsLower(root[0])))
            || (Path.AltDirectorySeparatorChar != Path.DirectorySeparatorChar && path.Contains(Path.AltDirectorySeparatorChar))
            || !path.Equals(Path.GetFullPath(path), StringComparison.Ordinal))
            throw new ArgumentException("Root, device, aliases and relative paths are refused.", nameof(path));
        var components = path[root.Length..].Split(Path.DirectorySeparatorChar);
        foreach (var component in components)
            if (string.IsNullOrEmpty(component) || component is "." or ".." || component.EndsWith('.') || component.EndsWith(' ')
                || component.Contains('~') || component.Contains(':') || component.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || Reserved(component))
                throw new ArgumentException("Ambiguous filename components are refused.", nameof(path));
        try
        {
            if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("Linked root refused.", nameof(path));
            var current = root;
            for (var i = 0; i < components.Length; i++)
            {
                var entry = new DirectoryInfo(current).EnumerateFileSystemInfos(components[i]).FirstOrDefault();
                if (entry is null)
                {
                    if (mustExist) throw new ArgumentException("Input or registered file is missing.", nameof(path));
                    return path;
                }
                if (!entry.Name.Equals(components[i], StringComparison.Ordinal) || (entry.Attributes & (FileAttributes.ReparsePoint | FileAttributes.Device)) != 0)
                    throw new ArgumentException("Linked/nonregular paths and spelling aliases are refused.", nameof(path));
                var expectedDirectory = i < components.Length - 1 || directory;
                if (((entry.Attributes & FileAttributes.Directory) != 0) != expectedDirectory)
                    throw new ArgumentException("Expected a regular file or directory.", nameof(path));
                current = Path.Combine(current, components[i]);
            }
            return path;
        }
        catch (IOException exception) { throw new ArgumentException("Path cannot be safely inspected.", nameof(path), exception); }
        catch (UnauthorizedAccessException exception) { throw new ArgumentException("Path cannot be safely inspected.", nameof(path), exception); }
    }

    private static bool Reserved(string component)
    {
        var stem = component.Split('.')[0];
        return stem.Equals("CON", StringComparison.OrdinalIgnoreCase) || stem.Equals("PRN", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("AUX", StringComparison.OrdinalIgnoreCase) || stem.Equals("NUL", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("CONIN$", StringComparison.OrdinalIgnoreCase) || stem.Equals("CONOUT$", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("CLOCK$", StringComparison.OrdinalIgnoreCase)
            || (stem.Length == 4 && (stem.StartsWith("COM", StringComparison.OrdinalIgnoreCase) || stem.StartsWith("LPT", StringComparison.OrdinalIgnoreCase))
                && stem[3] is >= '1' and <= '9' or '¹' or '²' or '³');
    }
}
