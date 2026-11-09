using System.Text.Json;
using System.Diagnostics;
using Fission.Core.Errors;
using System.Runtime.Versioning;
using Fission.Cli;
using Fission.Core.Jobs;

namespace Fission.UnitTests;

[SupportedOSPlatform("windows7.0")]
public sealed class EngineRunConfigurationTests
{
    [Fact]
    public void Load_ExplicitOriginalJob_DerivesAttemptPathsWithoutCreatingThem()
    {
        var f = new Fixture();
        var loaded = EngineRunConfiguration.Load(f.Args());
        Assert.Equal(Path.Combine(f.Workspace, "task-a", "attempt-1", "work"), loaded.Policy.Paths.WorkRoot);
        Assert.Equal(Path.Combine(f.Workspace, "task-a", "attempt-1", "out"), loaded.Policy.Paths.OutRoot);
        Assert.Equal(Path.Combine(f.Workspace, "task-a", "attempt-1", "cache"), loaded.Policy.CacheRoot);
        Assert.Equal(f.VideoDir, loaded.Job.VideoDir);
        Assert.Equal(f.AudioDir, loaded.Job.AudioDir);
        Assert.Equal(SplitMode.None, loaded.Job.SplitMode);
        Assert.Equal(1, loaded.Job.Count);
        Assert.False(Directory.Exists(f.Workspace));
    }

    [Fact]
    public void NativePrepareCommand_UsesOriginalFiveArgsAndDerivedSnapshotWithoutWriting()
    {
        var f = new Fixture(); var args = f.Args(); args[0] = "prepare";
        var config = EngineRunConfiguration.LoadCommand(args);
        Assert.Equal("prepare", config.Mode); Assert.Equal(Path.Combine(config.Policy.Paths.WorkRoot, "prepared.json"), config.SnapshotPath);
        Assert.False(Directory.Exists(f.Workspace));
        Assert.Equal("run", EngineRunConfiguration.LoadCommand(f.Args()).Mode);
    }

    [Fact]
    public void ExecutePrepared_RequiresDigestAndExistingOwnedSnapshotBeforePoolOrHardware()
    {
        var f = new Fixture(); var args = f.Args(); args[0] = "execute-prepared";
        AssertSafeRejection(f, () => EngineRunConfiguration.LoadCommand(args));
        AssertSafeRejection(f, () => EngineRunConfiguration.LoadCommand([..args, "--prepared", Path.Combine(f.Workspace, "missing.json"), "--digest", new string('0', 64)]));
        var prepare = f.Args(); prepare[0] = "prepare";
        AssertSafeRejection(f, () => EngineRunConfiguration.LoadCommand([..prepare, "--out", f.Workspace]));
    }

    [Theory]
    [InlineData("--paths")]
    [InlineData("--workspace")]
    [InlineData("--task")]
    [InlineData("--attempt")]
    [InlineData("--job")]
    public void Load_MissingRequiredOption_RejectsWithoutFallback(string option)
    {
        var f = new Fixture(); var args = f.Args().ToList(); var index = args.IndexOf(option);
        args.RemoveRange(index, 2);
        AssertSafeRejection(f, () => EngineRunConfiguration.Load(args.ToArray()));
    }

    [Theory]
    [InlineData("--paths")]
    [InlineData("--workspace")]
    [InlineData("--task")]
    [InlineData("--attempt")]
    [InlineData("--job")]
    public void Load_DuplicateRequiredOption_RejectsInsteadOfChoosingOne(string option)
    {
        var f = new Fixture(); var args = f.Args(); var value = args[Array.IndexOf(args, option) + 1];
        AssertSafeRejection(f, () => EngineRunConfiguration.Load([.. args, option, value]));
    }

    [Theory]
    [InlineData("--video")]
    [InlineData("--out")]
    [InlineData("--unknown")]
    public void Load_UnknownOrLegacyOption_Rejects(string option)
    {
        var f = new Fixture();
        AssertSafeRejection(f, () => EngineRunConfiguration.Load([.. f.Args(), option, f.VideoDir]));
    }

    [Fact]
    public void Load_MissingValue_RejectsWithSafeConfigurationError()
    {
        var f = new Fixture();
        AssertSafeRejection(f, () => EngineRunConfiguration.Load(f.Args()[..^1]));
    }

    [Fact]
    public void Load_NotRunCommand_RejectsWithoutReadingDefaults()
    {
        var f = new Fixture(); var args = f.Args(); args[0] = "doctor";
        AssertSafeRejection(f, () => EngineRunConfiguration.Load(args));
    }

    [Theory]
    [InlineData("FFmpeg")]
    [InlineData("FFprobe")]
    [InlineData("FFmpeg6")]
    [InlineData("TransitionsDir")]
    [InlineData("AssetsRoot")]
    [InlineData("LocalAssetsRoot")]
    public void Load_MissingReadOnlyField_RejectsRatherThanUsingLegacyDefaults(string field)
    {
        var f = new Fixture(); f.Paths.Remove(field); f.WritePaths();
        AssertSafeRejection(f, () => EngineRunConfiguration.Load(f.Args()));
    }

    [Theory]
    [InlineData("WorkRoot")]
    [InlineData("OutRoot")]
    [InlineData("ApiKey")]
    public void Load_UnapprovedConfigurationField_CannotGrantWritesOrBeIgnored(string field)
    {
        var f = new Fixture(); f.Paths[field] = Path.Combine(f.Root, "not-authorized"); f.WritePaths();
        AssertSafeRejection(f, () => EngineRunConfiguration.Load(f.Args()));
    }

    [Fact]
    public void Load_DuplicateReadOnlyField_RejectsAmbiguousConfiguration()
    {
        var f = new Fixture(); var json = File.ReadAllText(f.PathsFile);
        File.WriteAllText(f.PathsFile, "{\"FFmpeg\":" + JsonSerializer.Serialize(f.Paths["FFmpeg"]) + "," + json[1..]);
        AssertSafeRejection(f, () => EngineRunConfiguration.Load(f.Args()));
    }

    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("{malformed")]
    public void Load_InvalidPathsJson_RejectsWithoutRawJsonOrPath(string json)
    {
        var f = new Fixture(); File.WriteAllText(f.PathsFile, json);
        AssertSafeRejection(f, () => EngineRunConfiguration.Load(f.Args()));
    }

    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("{malformed")]
    public void Load_InvalidOriginalJobJson_RejectsWithoutRawJsonOrPath(string json)
    {
        var f = new Fixture(); File.WriteAllText(f.JobFile, json);
        AssertSafeRejection(f, () => EngineRunConfiguration.Load(f.Args()));
    }

    [Fact]
    public void Load_OutputEscape_RejectsBeforeCreatingWorkOrOutput()
    {
        var f = new Fixture(); f.WriteJob(Path.Combine(f.Root, "escaped"));
        AssertSafeRejection(f, () => EngineRunConfiguration.Load(f.Args()));
        Assert.False(Directory.Exists(Path.Combine(f.Root, "escaped")));
    }

    [Fact]
    public void Load_InputInsideWritableRoot_RejectsWithoutCreatingRuntimeDirectories()
    {
        var f = new Fixture(); var input = Path.Combine(f.Workspace, "source"); Directory.CreateDirectory(input);
        File.WriteAllText(f.JobFile, JsonSerializer.Serialize(new FissionJob { VideoDir = input, AudioDir = f.AudioDir }));
        AssertSafeRejection(f, () => EngineRunConfiguration.Load(f.Args()));
    }

    [Fact]
    public void Load_RealJunctionInput_RejectsBeforeRuntimeWrites()
    {
        var f = new Fixture(); var link = Path.Combine(f.Root, "linked-input");
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"))
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in new[] { "/d", "/c", "mklink", "/J", link, f.VideoDir }) start.ArgumentList.Add(argument);
        using (var process = Process.Start(start)!)
        {
            var stdout = process.StandardOutput.ReadToEnd(); var stderr = process.StandardError.ReadToEnd();
            process.WaitForExit(); Assert.True(process.ExitCode == 0, $"Real junction required: {stdout} {stderr}");
        }
        File.WriteAllText(f.JobFile, JsonSerializer.Serialize(new FissionJob { VideoDir = link, AudioDir = f.AudioDir }));
        AssertSafeRejection(f, () => EngineRunConfiguration.Load(f.Args()));
    }

    [Fact]
    public async Task Main_NoArguments_ExplainsTheExplicitRunInputs()
    {
        var original = Console.Out; using var output = new StringWriter();
        try
        {
            Console.SetOut(output);
            Assert.Equal(2, await Program.Main([]));
            foreach (var option in new[] { "--paths", "--workspace", "--task", "--attempt", "--job" })
                Assert.Contains(option, output.ToString());
        }
        finally { Console.SetOut(original); }
    }

    [Theory]
    [InlineData("missing-paths")]
    [InlineData("missing-job")]
    [InlineData("invalid-job")]
    [InlineData("incomplete-run")]
    [InlineData("legacy-run")]
    public async Task Main_InvalidControlledRun_ReturnsTwoWithoutPathLeakOrRuntimeWrites(string kind)
    {
        var f = new Fixture(); var args = f.Args();
        switch (kind)
        {
            case "missing-paths": args[2] = Path.Combine(f.Root, "private-paths-missing.json"); break;
            case "missing-job": args[^1] = Path.Combine(f.Root, "private-job-missing.json"); break;
            case "invalid-job": File.WriteAllText(f.JobFile, "{private-invalid-json"); break;
            case "incomplete-run": args = ["run"]; break;
            case "legacy-run": args = ["run", "--video", f.VideoDir]; break;
        }
        var original = Console.Error; using var output = new StringWriter();
        try
        {
            Console.SetError(output);
            Assert.Equal(2, await Program.Main(args));
            Assert.Contains("CFG_ARGS", output.ToString());
            Assert.DoesNotContain(f.Root, output.ToString());
            Assert.DoesNotContain("private", output.ToString());
            Assert.False(Directory.Exists(f.Workspace));
        }
        finally { Console.SetError(original); }
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    public void Load_EmptyReadOnlyValue_RejectsWithoutFallback(string value)
    {
        var f = new Fixture(); f.Paths["FFmpeg"] = value; f.WritePaths();
        AssertSafeRejection(f, () => EngineRunConfiguration.Load(f.Args()));
    }

    [Fact]
    public void Load_OriginalJobStringEnumsAndCaseInsensitiveFields_ArePreserved()
    {
        var f = new Fixture();
        File.WriteAllText(f.JobFile, "{\"videoDir\":" + JsonSerializer.Serialize(f.VideoDir)
            + ",\"audioDir\":" + JsonSerializer.Serialize(f.AudioDir)
            + ",\"count\":2,\"threads\":1,\"splitMode\":\"None\"}");
        var configuration = EngineRunConfiguration.Load(f.Args());
        Assert.Equal(2, configuration.Job.Count);
        Assert.Equal(SplitMode.None, configuration.Job.SplitMode);
        Assert.False(Directory.Exists(f.Workspace));
    }
    [Fact]
    public void Load_OriginalRunAndPrepareDoNotImplicitlyRequestSubsetExecution()
    {
        var f = new Fixture(); Assert.Null(EngineRunConfiguration.Load(f.Args()).OutputIndices);
        var args = f.Args(); args[0] = "prepare"; Assert.Null(EngineRunConfiguration.LoadCommand(args).OutputIndices);
    }

    [Theory]
    [InlineData("threads")]
    [InlineData("speed")]
    [InlineData("image")]
    [InlineData("transition")]
    [InlineData("subtitle")]
    public void OriginalPureConfigurationRetainsScalarRejectionsWithoutChangingJobBytes(string kind)
    {
        var f = new Fixture(); var job = EngineRunConfiguration.Load(f.Args()).Job;
        switch (kind) { case "threads": job.Threads = 65; break; case "speed": job.SceneGroups = [new("x", Speed: .4)]; break;
            case "image": job.ImageDurMinSec = 0; break; case "transition": job.TransitionSec = 3; break;
            case "subtitle": job.SubtitleEnabled = true; job.SubtitleStyle = "invalid"; break; }
        var before = JsonSerializer.Serialize(job); var hash = Fission.Core.Pipeline.FissionPreparedDecisions.HashJob(job);
        Assert.Throws<ConfigException>(job.Validate); Assert.Throws<ConfigException>(job.ValidateConfiguration);
        Assert.Equal(before, JsonSerializer.Serialize(job)); Assert.Equal(hash, Fission.Core.Pipeline.FissionPreparedDecisions.HashJob(job));
    }

    private static void AssertSafeRejection(Fixture fixture, Action action)
    {
        var error = Assert.Throws<ConfigException>(action);
        Assert.Equal("CFG_ARGS", error.Code);
        Assert.DoesNotContain(fixture.Root, error.Message);
        Assert.Null(error.InnerException);
        foreach (var directory in new[] { "work", "out", "cache" })
            Assert.False(Directory.Exists(Path.Combine(fixture.Workspace, "task-a", "attempt-1", directory)));
    }
    private sealed class Fixture
    {
        public Fixture()
        {
            var owner = Environment.GetEnvironmentVariable("FISSION_PATH_POLICY_TEST_ROOT")
                ?? throw new InvalidOperationException("Explicit owned fixture root required.");
            Root = Path.Combine(owner, "cli-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Root);
            var read = Path.Combine(Root, "read"); Directory.CreateDirectory(read);
            var marker = Path.Combine(read, "engine.exe"); File.WriteAllText(marker, "synthetic marker, never executed");
            Paths = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["FFmpeg"] = marker, ["FFprobe"] = marker, ["FFmpeg6"] = marker,
                ["TransitionsDir"] = read, ["AssetsRoot"] = read, ["LocalAssetsRoot"] = read,
            };
            VideoDir = Path.Combine(Root, "video"); AudioDir = Path.Combine(Root, "audio");
            Directory.CreateDirectory(VideoDir); Directory.CreateDirectory(AudioDir);
            File.WriteAllText(Path.Combine(VideoDir, "video.mp4"), "synthetic video");
            File.WriteAllText(Path.Combine(AudioDir, "voice.mp3"), "synthetic audio");
            Workspace = Path.Combine(Root, "owned");
            PathsFile = Path.Combine(Root, "paths.json"); JobFile = Path.Combine(Root, "job.json");
            WritePaths(); WriteJob();
        }
        public string Root { get; }
        public string Workspace { get; }
        public string PathsFile { get; }
        public string JobFile { get; }
        public string VideoDir { get; }
        public string AudioDir { get; }
        public Dictionary<string, string> Paths { get; }
        public void WritePaths() => File.WriteAllText(PathsFile, JsonSerializer.Serialize(Paths));
        public void WriteJob(string? output = null) => File.WriteAllText(JobFile,
            JsonSerializer.Serialize(new FissionJob { VideoDir = VideoDir, AudioDir = AudioDir,
                Count = 1, Threads = 1, SplitMode = SplitMode.None, OutDir = output }));
        public string[] Args() => ["run", "--paths", PathsFile, "--workspace", Workspace,
            "--task", "task-a", "--attempt", "attempt-1", "--job", JobFile];
    }
}