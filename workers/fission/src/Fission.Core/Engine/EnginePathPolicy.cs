using System.Text;
using Fission.Core.Jobs;

namespace Fission.Core.Engine;

/// <summary>
/// Pure, opt-in directory policy over the original EnginePaths and FissionJob.
/// The caller must independently approve the read-only engine/assets configuration
/// and own the writable root. No directory is created and no engine is executed.
/// This is a point-in-time check, not an OS sandbox: the future host must prevent
/// concurrent link replacement and secure each actual file open/write.
/// </summary>
public sealed class EnginePathPolicy
{
    private readonly string writableRoot;
    private readonly string[] readOnlyFiles;
    private readonly string[] readOnlyDirectories;

    /// <summary>
    /// Derives work/out/cache below a distinct lowercase task and attempt.
    /// EnginePaths' legacy WorkRoot/OutRoot are never used as write grants.
    /// Approved read-only locations must already exist, without link ancestors.
    /// Missing Windows managed writable components use lowercase ASCII for cased
    /// letters; uncased Unicode (including Chinese) and spaces remain valid.
    /// Existing trusted names retain exact filesystem spelling. This directory
    /// constraint does not rename or normalize native IDs or read-only filenames.
    /// </summary>
    public EnginePathPolicy(EnginePaths approvedReadOnly, string writableRoot, string taskId, string attemptId)
    {
        ArgumentNullException.ThrowIfNull(approvedReadOnly);
        this.writableRoot = CanonicalDirectory(writableRoot, managedWritable: true);
        ValidateIdentity(taskId, nameof(taskId));
        ValidateIdentity(attemptId, nameof(attemptId));

        readOnlyFiles =
        [
            CanonicalPath(approvedReadOnly.FFmpeg, allowTerminalFile: true),
            CanonicalPath(approvedReadOnly.FFprobe, allowTerminalFile: true),
            CanonicalPath(approvedReadOnly.FFmpeg6, allowTerminalFile: true),
        ];
        readOnlyDirectories =
        [
            CanonicalDirectory(approvedReadOnly.TransitionsDir),
            CanonicalDirectory(approvedReadOnly.AssetsRoot),
            CanonicalDirectory(approvedReadOnly.LocalAssetsRoot),
        ];
        ValidateReadOnlyLocations();
        var attemptRoot = Path.Combine(this.writableRoot, taskId, attemptId);
        Paths = approvedReadOnly with
        {
            WorkRoot = CanonicalDirectory(Path.Combine(attemptRoot, "work"), managedWritable: true),
            OutRoot = CanonicalDirectory(Path.Combine(attemptRoot, "out"), managedWritable: true),
        };
        CacheRoot = CanonicalDirectory(Path.Combine(attemptRoot, "cache"), managedWritable: true);
    }

    /// <summary>Original read-only paths plus derived, task-owned WorkRoot/OutRoot.</summary>
    public EnginePaths Paths { get; }

    /// <summary>Attempt-local cache; never a shared or legacy default cache.</summary>
    public string CacheRoot { get; }

    /// <summary>
    /// Returns a canonical directory only inside this attempt's work/out/cache.
    /// Existing regular files and every reparse-point ancestor are refused.
    /// Rechecks ancestry on every call, including links introduced after creation.
    /// </summary>
    public string ValidateWritablePath(string path)
    {
        ValidateReadOnlyLocations();
        CanonicalDirectory(writableRoot, managedWritable: true);
        var candidate = CanonicalDirectory(path, managedWritable: true);
        if (!Contains(Paths.WorkRoot, candidate) && !Contains(Paths.OutRoot, candidate) && !Contains(CacheRoot, candidate))
            throw new ArgumentException("Directory is outside this task attempt's writable locations.", nameof(path));
        return candidate;
    }

    /// <summary>
    /// Resolves only the original job.OutDir override; null/empty uses this task's
    /// OutRoot. Does not validate media, invoke FissionJob.Validate, or mutate job.
    /// </summary>
    public string ValidateJob(FissionJob job)
    {
        ArgumentNullException.ThrowIfNull(job);
        var requested = job.OutDir;
        var candidate = ValidateWritablePath(string.IsNullOrEmpty(requested) ? Paths.OutRoot : requested);
        if (!Contains(Paths.OutRoot, candidate))
            throw new ArgumentException("job.OutDir must stay inside this task attempt's output.", nameof(job));
        return candidate;
    }

    private void ValidateReadOnlyLocations()
    {
        foreach (var path in readOnlyFiles)
        {
            CanonicalPath(path, allowTerminalFile: true);
            if (!File.Exists(path))
                throw new ArgumentException("An explicitly approved engine file is missing.");
            RefuseReadWriteOverlap(path);
        }
        foreach (var path in readOnlyDirectories)
        {
            CanonicalDirectory(path);
            if (!Directory.Exists(path))
                throw new ArgumentException("An explicitly approved read-only asset directory is missing.");
            RefuseReadWriteOverlap(path);
        }
    }

    private void RefuseReadWriteOverlap(string readOnlyPath)
    {
        if (Contains(writableRoot, readOnlyPath) || Contains(readOnlyPath, writableRoot))
            throw new ArgumentException("Read-only and task-writable trees must be disjoint.");
    }

    private static bool Contains(string root, string candidate)
        => string.Equals(root, candidate, StringComparison.Ordinal)
            || candidate.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal);

    private static void ValidateIdentity(string identity, string parameter)
    {
        if (string.IsNullOrEmpty(identity) || identity.Any(c => !(c is >= 'a' and <= 'z' or >= '0' and <= '9' or '-'))
            || identity[0] == '-' || identity[^1] == '-' || IsReserved(identity))
            throw new ArgumentException("Task and attempt must be explicit lowercase alphanumeric/hyphen components.", parameter);
    }

    private static string CanonicalDirectory(string path, bool managedWritable = false)
        => CanonicalPath(path, allowTerminalFile: false, managedWritable);

    private static string CanonicalPath(string path, bool allowTerminalFile, bool managedWritable = false)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path))
            throw new ArgumentException("An explicit fully-qualified local path is required.", nameof(path));
        var root = Path.GetPathRoot(path)!;
        if (path.Length == root.Length
            || (OperatingSystem.IsWindows() && root[0] == Path.DirectorySeparatorChar)
            || (Path.AltDirectorySeparatorChar != Path.DirectorySeparatorChar && path.Contains(Path.AltDirectorySeparatorChar)))
            throw new ArgumentException("Root, UNC/device, and alternate-separator paths are not accepted.", nameof(path));

        var components = path[root.Length..].Split(Path.DirectorySeparatorChar);
        foreach (var component in components)
        {
            if (string.IsNullOrEmpty(component) || component is "." or ".."
                || component.EndsWith('.') || component.EndsWith(' ')
                || component.Contains('~') || component.Contains(':')
                || component.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || IsReserved(component))
                throw new ArgumentException("Ambiguous path components are not accepted.", nameof(path));
        }
        var full = Path.GetFullPath(path);
        if (!string.Equals(path, full, StringComparison.Ordinal)
            || (OperatingSystem.IsWindows() && char.IsLower(root[0])))
            throw new ArgumentException("A canonical path spelling is required.", nameof(path));

        InspectExistingAncestry(full, root, components, allowTerminalFile, managedWritable);
        return full;
    }

    private static void ValidateMissingManagedCase(string component)
    {
        foreach (var rune in component.EnumerateRunes())
        {
            var hasCase = Rune.ToUpperInvariant(rune) != Rune.ToLowerInvariant(rune);
            if (hasCase && rune.Value is not (>= 'a' and <= 'z'))
                throw new ArgumentException("Missing Windows managed directories require lowercase ASCII cased letters.");
        }
    }
    private static bool IsReserved(string component)
    {
        // Windows device aliases remain forbidden on other platforms too, so a
        // task/attempt or directory cannot become a device after transfer.
        var stem = component.Split('.')[0].TrimEnd(' ', '.');
        if (stem.Equals("CON", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("PRN", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("AUX", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("NUL", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("CONIN$", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("CONOUT$", StringComparison.OrdinalIgnoreCase)
            || stem.Equals("CLOCK$", StringComparison.OrdinalIgnoreCase))
            return true;
        return stem.Length == 4
            && (stem.StartsWith("COM", StringComparison.OrdinalIgnoreCase) || stem.StartsWith("LPT", StringComparison.OrdinalIgnoreCase))
            && (stem[3] is >= '1' and <= '9' or '¹' or '²' or '³');
    }

    private static void InspectExistingAncestry(string full, string root, string[] components, bool allowTerminalFile, bool managedWritable)
    {
        try
        {
            if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("Linked path roots are not accepted.", nameof(full));
            var current = root;
            for (var i = 0; i < components.Length; i++)
            {
                // Exact spelling prevents case/short-name aliases of existing
                // directories from manufacturing a second apparent task root.
                var match = new DirectoryInfo(current).EnumerateFileSystemInfos(components[i]).FirstOrDefault();
                if (match is null)
                {
                    // The filesystem cannot supply canonical case for missing
                    // components. A deterministic managed namespace prevents
                    // two accepted spellings from becoming the same directory.
                    if (managedWritable && OperatingSystem.IsWindows())
                        for (var missing = i; missing < components.Length; missing++)
                            ValidateMissingManagedCase(components[missing]);
                    break; // Validation never creates the missing descendants.
                }
                if (!string.Equals(match.Name, components[i], StringComparison.Ordinal))
                    throw new ArgumentException("Case/short-name aliases are not accepted.", nameof(full));
                var attributes = match.Attributes;
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new ArgumentException("Linked path ancestors are not accepted.", nameof(full));
                var terminal = i == components.Length - 1;
                if ((attributes & FileAttributes.Directory) == 0 && (!terminal || !allowTerminalFile))
                    throw new ArgumentException("A directory path cannot contain an existing regular file.", nameof(full));
                current = Path.Combine(current, components[i]);
            }
        }
        catch (IOException exception)
        {
            throw new ArgumentException("Path ancestry cannot be safely inspected.", nameof(full), exception);
        }
        catch (UnauthorizedAccessException exception)
        {
            throw new ArgumentException("Path ancestry cannot be safely inspected.", nameof(full), exception);
        }
    }
}
