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
