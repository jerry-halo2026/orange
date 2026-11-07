using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Diagnostics;
using Fission.Core.Engine;
using Fission.Core.Jobs;

namespace Fission.UnitTests;

// Only synthetic engine marker files and task fixtures under the explicitly owned test root.
// No Fission engine, media, network, system configuration, or default runtime path is used.
public sealed class EnginePathPolicyTests
{
    [Fact]
    public void Create_ExplicitChineseAndSpaceRoots_DerivesTaskAttemptWithoutWriting()
    {
        using var f = new Fixture();
        var before = f.Snapshot();
        var p = Create(f.ReadOnly, f.Writable, "task-a", "attempt-1");
        var paths = Paths(p);
        Assert.Equal(Path.Combine(f.Writable, "task-a", "attempt-1", "work"), paths.WorkRoot);
        Assert.Equal(Path.Combine(f.Writable, "task-a", "attempt-1", "out"), paths.OutRoot);
        Assert.Equal(Path.Combine(f.Writable, "task-a", "attempt-1", "cache"), Cache(p));
        Assert.Equal(f.ReadOnly.FFmpeg, paths.FFmpeg);
        Assert.Equal(f.ReadOnly.FFprobe, paths.FFprobe);
        Assert.Equal(f.ReadOnly.FFmpeg6, paths.FFmpeg6);
        Assert.Equal(f.ReadOnly.AssetsRoot, paths.AssetsRoot);
        Assert.Equal(before, f.Snapshot());
    }

    [Fact]
    public void ValidateWritablePath_OriginalDefaultsAndReadOnlyAssets_CannotGainWritePermission()
    {
        using var f = new Fixture();
        var p = Create(f.ReadOnly, f.Writable);
        var original = new EnginePaths();
        foreach (var path in new[] { original.WorkRoot, original.OutRoot, f.ReadOnly.AssetsRoot,
                     f.ReadOnly.LocalAssetsRoot, f.ReadOnly.TransitionsDir, f.ReadOnly.FFmpeg })
        {
            Assert.Throws<ArgumentException>(() => Writable(p, path));
        }
        Assert.Equal("synthetic engine; never execute", File.ReadAllText(f.ReadOnly.FFmpeg));
    }

    [Fact]
    public void Create_OmittedOrNonAbsoluteWritableRoot_Rejects()
    {
        using var f = new Fixture();
        foreach (var root in new[] { "", " ", ".", "relative", @"C:relative", @"\rooted",
                     Path.GetPathRoot(f.Writable)!, @"\\server\share\task", @"\\?\C:\task",
                     @"\\.\C:\task", @"\??\C:\task" })
        {
            Assert.Throws<ArgumentException>(() => Create(f.ReadOnly, root));
        }
        Assert.Throws<ArgumentNullException>(() => Create(null!, f.Writable));
    }

    [Theory]
    [InlineData("")]
    [InlineData(".")]
    [InlineData("..")]
    [InlineData("../escape")]
    [InlineData(@"a\b")]
    [InlineData("a/b")]
    [InlineData("Task-a")]
    [InlineData("task:stream")]
    [InlineData("task.")]
    [InlineData("task ")]
    [InlineData("con")]
    [InlineData("com1")]
    public void Create_UnsafeOrCaseAliasTaskAndAttempt_Rejects(string component)
    {
        using var f = new Fixture();
        Assert.Throws<ArgumentException>(() => Create(f.ReadOnly, f.Writable, component, "attempt-1"));
        Assert.Throws<ArgumentException>(() => Create(f.ReadOnly, f.Writable, "task-a", component));
    }

    [Fact]
    public void Create_UnapprovedMissingReadOnlyLocations_RejectsOriginalDefaults()
    {
        using var f = new Fixture();
        Assert.Throws<ArgumentException>(() => Create(new EnginePaths(), f.Writable));
        Assert.Throws<ArgumentException>(() => Create(f.ReadOnly with { FFmpeg = Path.Combine(f.Root, "missing") }, f.Writable));
        Assert.Throws<ArgumentException>(() => Create(f.ReadOnly with { AssetsRoot = Path.Combine(f.Root, "missing-assets") }, f.Writable));
    }

    [Fact]
    public void Create_ReadOnlyAndWritableTreesOverlapInEitherDirection_Rejects()
    {
        using var f = new Fixture();
        foreach (var root in new[] { f.Root, f.ReadOnly.AssetsRoot, Path.Combine(f.ReadOnly.AssetsRoot, "writable") })
            Assert.Throws<ArgumentException>(() => Create(f.ReadOnly, root));
        Directory.CreateDirectory(f.Writable);
        Assert.Throws<ArgumentException>(() => Create(f.ReadOnly with { LocalAssetsRoot = f.Writable }, f.Writable));
        Assert.Throws<ArgumentException>(() => Create(f.ReadOnly with { LocalAssetsRoot = Path.Combine(f.Writable, "nested") }, f.Writable));
    }

    [Fact]
    public void ValidateJob_OutDirMustStayInsideThisTaskOutput_AndDoesNotMutateJob()
    {
        using var f = new Fixture();
        var p = Create(f.ReadOnly, f.Writable);
        var output = Paths(p).OutRoot;
        var job = new FissionJob();
        Assert.Equal(output, Job(p, job));
        Assert.Null(job.OutDir);
        job.OutDir = Path.Combine(output, "中文 成片");
        Assert.Equal(job.OutDir, Job(p, job));
        foreach (var path in new[] { f.Writable, Path.Combine(f.Writable, "task-b", "attempt-1", "out"),
                     Path.Combine(output, "..", "work"), output + "-sibling", Paths(p).WorkRoot, Cache(p),
                     f.ReadOnly.AssetsRoot, "relative", " " })
        {
            job.OutDir = path;
            Assert.Throws<ArgumentException>(() => Job(p, job));
            Assert.Equal(path, job.OutDir);
        }
        Assert.False(Directory.Exists(output));
    }

    [Fact]
    public void ValidateWritablePath_TasksAttemptsAndRolesCannotShareWritableDirectories()
    {
        using var f = new Fixture();
        var a = Create(f.ReadOnly, f.Writable);
        var b = Create(f.ReadOnly, f.Writable, "task-b");
        var retry = Create(f.ReadOnly, f.Writable, "task-a", "attempt-2");
        foreach (var other in new[] { b, retry })
            foreach (var path in new[] { Paths(other).WorkRoot, Paths(other).OutRoot, Cache(other) })
                Assert.Throws<ArgumentException>(() => Writable(a, path));
        foreach (var path in new[] { Paths(a).WorkRoot, Paths(a).OutRoot, Cache(a) })
            Assert.Equal(Path.Combine(path, "中文 文件"), Writable(a, Path.Combine(path, "中文 文件")));
        Assert.Throws<ArgumentException>(() => Writable(a, Path.GetDirectoryName(Paths(a).OutRoot)!));
    }

    [Theory]
    [InlineData("..")]
    [InlineData(".")]
    [InlineData("file:stream")]
    [InlineData("file.")]
    [InlineData("file ")]
    [InlineData("NUL")]
    [InlineData("con.txt")]
    [InlineData("COM1.txt")]
    [InlineData("LPT9")]
    [InlineData("COM¹")]
    [InlineData("name~1")]
    [InlineData("bad?name")]
    public void ValidateWritablePath_WindowsNormalizationAliases_Rejects(string component)
    {
        using var f = new Fixture();
        var p = Create(f.ReadOnly, f.Writable);
        Assert.Throws<ArgumentException>(() => Writable(p, Path.Combine(Paths(p).OutRoot, component)));
    }

    [Fact]
    public void ValidateWritablePath_CaseAndSeparatorAliasesAndExistingFileAncestor_Rejects()
    {
        using var f = new Fixture();
        var p = Create(f.ReadOnly, f.Writable);
        var output = Paths(p).OutRoot;
        Assert.Throws<ArgumentException>(() => Writable(p, output.Replace("task-a", "TASK-A", StringComparison.Ordinal)));
        Assert.Throws<ArgumentException>(() => Writable(p, output + Path.DirectorySeparatorChar));
        Assert.Throws<ArgumentException>(() => Writable(p, output.Replace(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)));
        Assert.Throws<ArgumentException>(() => Create(f.ReadOnly, f.Writable.ToUpperInvariant()));
        Directory.CreateDirectory(output);
        var file = Path.Combine(output, "not-directory");
        File.WriteAllText(file, "marker");
        Assert.Throws<ArgumentException>(() => Writable(p, Path.Combine(file, "child")));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ValidateWritablePath_RealWindowsJunctionOrSymlinkAncestor_RejectsBeforeAnyCreation(bool symbolic)
    {
        using var f = new Fixture();
        var p = Create(f.ReadOnly, f.Writable);
        var outside = Path.Combine(f.Root, "outside");
        var output = Paths(p).OutRoot;
        Directory.CreateDirectory(outside);
        Directory.CreateDirectory(output);
        var link = Path.Combine(output, symbolic ? "symbolic" : "junction");
        if (symbolic)
            Directory.CreateSymbolicLink(link, outside);
        else
            MakeJunction(link, outside);
        Assert.True((File.GetAttributes(link) & FileAttributes.ReparsePoint) != 0);
        var before = f.Snapshot();
        Assert.Throws<ArgumentException>(() => Writable(p, Path.Combine(link, "escape", "new-child")));
        Assert.Throws<ArgumentException>(() => Job(p, new FissionJob { OutDir = Path.Combine(link, "escape") }));
        Assert.Equal(before, f.Snapshot());
        Assert.False(Directory.Exists(Path.Combine(outside, "escape")));
        Directory.Delete(link); // Remove only this fixture's link, never its target.
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Create_LinkedWritableOrReadOnlyRoot_Rejects(bool symbolic)
    {
        using var f = new Fixture();
        var target = Path.Combine(f.Root, "target");
        Directory.CreateDirectory(target);
        var link = Path.Combine(f.Root, symbolic ? "root-symbolic" : "root-junction");
        if (symbolic)
            Directory.CreateSymbolicLink(link, target);
        else
            MakeJunction(link, target);
        Assert.Throws<ArgumentException>(() => Create(f.ReadOnly, Path.Combine(link, "tasks")));
        Assert.Throws<ArgumentException>(() => Create(f.ReadOnly with { AssetsRoot = link }, f.Writable));
        Directory.Delete(link);
    }

    [Fact]
    public void ValidateWritablePath_LinkIntroducedAfterConstruction_IsRechecked()
    {
        using var f = new Fixture();
        var p = Create(f.ReadOnly, f.Writable);
        Directory.CreateDirectory(f.Writable);
        var target = Path.Combine(f.Root, "target-after");
        Directory.CreateDirectory(target);
        var task = Path.Combine(f.Writable, "task-a");
        MakeJunction(task, target);
        Assert.Throws<ArgumentException>(() => Writable(p, Path.Combine(Paths(p).OutRoot, "new")));
        Directory.Delete(task);
        Assert.False(Directory.Exists(Path.Combine(target, "attempt-1")));
    }

    [Fact]
    public void CaseAlias_MissingOnlyOutputLeafOrIntermediate_RejectsWithoutCreating()
    {
        using var f = new Fixture();
        var p = Create(f.ReadOnly, f.Writable);
        var output = Paths(p).OutRoot;
        var before = f.Snapshot();
        Assert.False(Directory.Exists(output));
        Assert.Equal(Path.Combine(output, "future"), Writable(p, Path.Combine(output, "future")));
        Assert.Throws<ArgumentException>(() => Writable(p, Path.Combine(output, "Future")));
        Assert.Throws<ArgumentException>(() => Job(p, new FissionJob { OutDir = Path.Combine(output, "Future") }));
        Assert.Throws<ArgumentException>(() => Writable(p, Path.Combine(output, "Future", "lower-leaf")));
        Assert.Equal(before, f.Snapshot());
    }

    [Fact]
    public void CaseAlias_MissingOnlyWritableRootLeaf_RejectsWithoutCreating()
    {
        using var f = new Fixture();
        var canonicalRoot = Path.Combine(f.Root, "managed");
        var aliasRoot = Path.Combine(f.Root, "Managed");
        var before = f.Snapshot();
        Assert.False(Directory.Exists(canonicalRoot));
        Assert.False(Directory.Exists(aliasRoot));
        var p = Create(f.ReadOnly, canonicalRoot);
        Assert.Equal(Path.Combine(canonicalRoot, "task-a", "attempt-1", "work"), Paths(p).WorkRoot);
        Assert.Throws<ArgumentException>(() => Create(f.ReadOnly, aliasRoot));
        Assert.Equal(before, f.Snapshot());
    }

    [Theory]
    [InlineData("Älias")]
    [InlineData("älias")]
    [InlineData("Kache")]
    public void CaseAlias_MissingCasedUnicodeWritableComponent_Rejects(string component)
    {
        using var f = new Fixture();
        var p = Create(f.ReadOnly, f.Writable);
        Assert.Throws<ArgumentException>(() => Writable(p, Path.Combine(Paths(p).OutRoot, component)));
    }

    [Fact]
    public void CaseAlias_ExistingTrustedCaseAndChineseManagedNames_ArePreserved()
    {
        using var f = new Fixture();
        var existingRoot = Path.Combine(f.Root, "Existing Root");
        Directory.CreateDirectory(existingRoot);
        var existingReadOnly = Path.Combine(f.Root, "Native ASSETS Ä");
        Directory.CreateDirectory(existingReadOnly);
        var approved = f.ReadOnly with { AssetsRoot = existingReadOnly };
        var before = f.Snapshot();
        var p = Create(approved, existingRoot);
        var expected = Path.Combine(existingRoot, "task-a", "attempt-1", "out", "中文 成片 lower");
        Assert.Equal(existingReadOnly, Paths(p).AssetsRoot);
        Assert.Equal(expected, Writable(p, expected));
        Assert.Equal(expected, Job(p, new FissionJob { OutDir = expected }));
        Assert.Equal(before, f.Snapshot());
    }
    private static Type PolicyType =>
        typeof(EnginePaths).Assembly.GetType("Fission.Core.Engine.EnginePathPolicy")
        ?? throw new InvalidOperationException("Missing native Core EnginePathPolicy capability; not a semantic test result.");

    private static object Create(EnginePaths approved, string root, string task = "task-a", string attempt = "attempt-1")
        => Unwrap(() => Activator.CreateInstance(PolicyType, approved, root, task, attempt)!);

    private static EnginePaths Paths(object policy) => (EnginePaths)policy.GetType().GetProperty("Paths")!.GetValue(policy)!;
    private static string Cache(object policy) => (string)policy.GetType().GetProperty("CacheRoot")!.GetValue(policy)!;
    private static string Writable(object policy, string path) => (string)Unwrap(() => policy.GetType().GetMethod("ValidateWritablePath")!.Invoke(policy, [path])!);
    private static string Job(object policy, FissionJob job) => (string)Unwrap(() => policy.GetType().GetMethod("ValidateJob")!.Invoke(policy, [job])!);

    private static T Unwrap<T>(Func<T> invoke)
    {
        try { return invoke(); }
        catch (TargetInvocationException e) when (e.InnerException is not null)
        {
            ExceptionDispatchInfo.Capture(e.InnerException).Throw();
            throw;
        }
    }

    private static void MakeJunction(string link, string target)
    {
        var command = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
        var start = new ProcessStartInfo(command)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            Arguments = $"/d /c mklink /J \"{link}\" \"{target}\"",
        };
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, $"Real Windows junction capability required: {stdout} {stderr}");
    }

    private sealed class Fixture : IDisposable
    {
        public Fixture()
        {
            var owner = Environment.GetEnvironmentVariable("FISSION_PATH_POLICY_TEST_ROOT")
                ?? throw new InvalidOperationException("Explicit owned fixture root is required.");
            Assert.True(Path.IsPathFullyQualified(owner));
            Root = Path.Combine(Path.GetFullPath(owner), "中文 空间-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Root);
            var engines = Path.Combine(Root, "只读 engines");
            var assets = Path.Combine(Root, "只读 assets");
            var local = Path.Combine(Root, "只读 local");
            var transitions = Path.Combine(Root, "只读 transitions");
            foreach (var directory in new[] { engines, assets, local, transitions })
                Directory.CreateDirectory(directory);
            string Marker(string name)
            {
                var path = Path.Combine(engines, name);
                File.WriteAllText(path, "synthetic engine; never execute");
                return path;
            }
            ReadOnly = new EnginePaths
            {
                FFmpeg = Marker("transcode-marker"), FFprobe = Marker("probe-marker"), FFmpeg6 = Marker("transition-marker"),
                AssetsRoot = assets, LocalAssetsRoot = local, TransitionsDir = transitions,
            };
            Writable = Path.Combine(Root, "可写 空间");
        }

        public string Root { get; }
        public string Writable { get; }
        public EnginePaths ReadOnly { get; }

        // Do not recurse through reparse points: snapshot only the fixture's own entries.
        public string[] Snapshot()
        {
            var names = new List<string>();
            void Visit(string directory)
            {
                foreach (var entry in Directory.EnumerateFileSystemEntries(directory).Order(StringComparer.Ordinal))
                {
                    names.Add(Path.GetRelativePath(Root, entry));
                    var attributes = File.GetAttributes(entry);
                    if ((attributes & FileAttributes.Directory) != 0 && (attributes & FileAttributes.ReparsePoint) == 0)
                        Visit(entry);
                }
            }
            Visit(Root);
            return names.ToArray();
        }

        public void Dispose()
        {
            // Preserve every fixture/attempt for independent review; no recursive cleanup.
        }
    }
}
