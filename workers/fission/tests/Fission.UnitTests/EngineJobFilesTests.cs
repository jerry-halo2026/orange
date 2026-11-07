using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Fission.Core.Abstractions;
using Fission.Core.Engine;
using Fission.Core.Errors;
using Fission.Core.Jobs;
using Fission.Core.Process;
using Fission.Providers.Pipeline;

namespace Fission.UnitTests;

// Real BCL file I/O and the original orchestrator. Only the codec and media probe are fake.
// Every fixture is synthetic and retained under the explicitly owned root. No media process runs.
public sealed class EngineJobFilesTests
{
    [Fact]
    public async Task CopyAudio_UsesPrivateCreateNewCopyAndNeverMovesOriginal()
    {
        var f = new Fixture();
        var files = new EngineJobFiles(f.Policy);
        var copy = await files.CopyAudioAsync(f.Audio, f.Voice);
        Assert.Equal(Path.Combine(f.Voice, "配音 one.mp3"), copy);
        Assert.Equal(Fixture.AudioBytes, await File.ReadAllBytesAsync(copy));
        f.AssertOriginal();
        Assert.False(Directory.Exists(Path.Combine(f.AudioDir, "_consumed")));
        var archived = files.ArchiveAudio(copy);
        Assert.Equal(Path.Combine(f.Policy.Paths.WorkRoot, "_consumed", "配音 one.mp3"), archived);
        Assert.False(File.Exists(copy));
        Assert.Equal(Fixture.AudioBytes, await File.ReadAllBytesAsync(archived));
        f.AssertOriginal();
        Assert.Throws<ArgumentException>(() => files.ArchiveAudio(copy));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CopyAudio_PrecreatedOrHardlinkedDestinationNeverOverwrites(bool hardlink)
    {
        var f = new Fixture();
        Directory.CreateDirectory(f.Voice);
        var destination = Path.Combine(f.Voice, Path.GetFileName(f.Audio));
        if (hardlink) MakeLink("/H", destination, f.Audio);
        else await File.WriteAllBytesAsync(destination, [9, 8, 7]);
        var before = await File.ReadAllBytesAsync(destination);
        await Assert.ThrowsAsync<IOException>(() => new EngineJobFiles(f.Policy).CopyAudioAsync(f.Audio, f.Voice));
        Assert.Equal(before, await File.ReadAllBytesAsync(destination));
        f.AssertOriginal();
    }

    [Fact]
    public async Task CopyAudio_CancelBeforeOpenNeverCreatesCopyOrChangesSource()
    {
        var f = new Fixture();
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new EngineJobFiles(f.Policy).CopyAudioAsync(f.Audio, f.Voice, cancellation.Token));
        Assert.False(Directory.Exists(f.Voice));
        f.AssertOriginal();
    }

    [Fact]
    public async Task CopyAudio_ReadFailureLeavesSourceAndNoRegisteredArchive()
    {
        var f = new Fixture();
        var files = new EngineJobFiles(f.Policy);
        using (var locked = new FileStream(f.Audio, FileMode.Open, FileAccess.Read, FileShare.None))
            await Assert.ThrowsAsync<IOException>(() => files.CopyAudioAsync(f.Audio, f.Voice));
        f.AssertOriginal();
        Assert.Throws<ArgumentException>(() => files.ArchiveAudio(Path.Combine(f.Voice, Path.GetFileName(f.Audio))));
    }

    [Theory]
    [InlineData("relative")]
    [InlineData("escape")]
    [InlineData("directory")]
    [InlineData("overlap")]
    public async Task CopyAudio_InvalidSourceRefusesBeforeCreatingVoice(string kind)
    {
        var f = new Fixture();
        var source = kind switch
        {
            "relative" => "配音 one.mp3",
            "escape" => Path.Combine(f.AudioDir, "..", "audio", "配音 one.mp3"),
            "directory" => f.AudioDir,
            _ => Path.Combine(f.Policy.Paths.OutRoot, "own.mp3"),
        };
        if (kind == "overlap") { Directory.CreateDirectory(f.Policy.Paths.OutRoot); File.WriteAllBytes(source, [7]); }
        await Assert.ThrowsAsync<ArgumentException>(() => new EngineJobFiles(f.Policy).CopyAudioAsync(source, f.Voice));
        Assert.False(Directory.Exists(f.Voice));
        f.AssertOriginal();
    }

    [Fact]
    public async Task CopyAudio_ForeignAttemptDestinationRefuses()
    {
        var f = new Fixture();
        var other = f.OtherPolicy();
        await Assert.ThrowsAsync<ArgumentException>(() => new EngineJobFiles(f.Policy).CopyAudioAsync(f.Audio, Path.Combine(other.Paths.WorkRoot, "voice")));
        Assert.False(Directory.Exists(other.Paths.WorkRoot));
        f.AssertOriginal();
    }

    [Fact]
    public async Task CopyAudio_JunctionSourceAndDestinationRefuse()
    {
        var f = new Fixture();
        var junction = Path.Combine(f.Root, "audio-junction");
        MakeLink("/J", junction, f.AudioDir);
        await Assert.ThrowsAsync<ArgumentException>(() => new EngineJobFiles(f.Policy).CopyAudioAsync(Path.Combine(junction, Path.GetFileName(f.Audio)), f.Voice));
        Directory.CreateDirectory(f.Policy.Paths.WorkRoot);
        var ownedJunction = Path.Combine(f.Policy.Paths.WorkRoot, "junction");
        MakeLink("/J", ownedJunction, f.AudioDir);
        await Assert.ThrowsAsync<ArgumentException>(() => new EngineJobFiles(f.Policy).CopyAudioAsync(f.Audio, ownedJunction));
        f.AssertOriginal();
    }

    [Fact]
    public async Task CopyAudio_TrueFileSymlinkSourceRefuses()
    {
        var f = new Fixture();
        var link = Path.Combine(f.AudioDir, "linked.mp3");
        File.CreateSymbolicLink(link, f.Audio); // Missing Windows privilege is ENV failure, never a skip/pass.
        await Assert.ThrowsAsync<ArgumentException>(() => new EngineJobFiles(f.Policy).CopyAudioAsync(link, f.Voice));
        Assert.False(Directory.Exists(f.Voice));
        f.AssertOriginal();
    }

    [Fact]
    public async Task CopyAudio_TrueFileSymlinkDestinationRefuses()
    {
        var f = new Fixture();
        Directory.CreateDirectory(f.Voice);
        var link = Path.Combine(f.Voice, Path.GetFileName(f.Audio));
        File.CreateSymbolicLink(link, f.Audio);
        await Assert.ThrowsAsync<ArgumentException>(() => new EngineJobFiles(f.Policy).CopyAudioAsync(f.Audio, f.Voice));
        f.AssertOriginal();
    }

    [Fact]
    public async Task ArchiveAudio_OriginalUnregisteredAndForeignCopiesRefuse()
    {
        var f = new Fixture();
        var files = new EngineJobFiles(f.Policy);
        Assert.Throws<ArgumentException>(() => files.ArchiveAudio(f.Audio));
        Directory.CreateDirectory(f.Voice);
        var unregistered = Path.Combine(f.Voice, "unregistered.mp3");
        await File.WriteAllBytesAsync(unregistered, [1]);
        Assert.Throws<ArgumentException>(() => files.ArchiveAudio(unregistered));
        var other = new EngineJobFiles(f.OtherPolicy());
        var copy = await files.CopyAudioAsync(f.Audio, f.Voice);
        Assert.Throws<ArgumentException>(() => other.ArchiveAudio(copy));
        Assert.True(File.Exists(copy));
        f.AssertOriginal();
    }

    [Fact]
    public async Task ArchiveAudio_PrecreatedHardlinkTargetRefusesWithoutMutatingCopyOrSource()
    {
        var f = new Fixture();
        var files = new EngineJobFiles(f.Policy);
        var copy = await files.CopyAudioAsync(f.Audio, f.Voice);
        var archiveDir = Path.Combine(f.Policy.Paths.WorkRoot, "_consumed");
        Directory.CreateDirectory(archiveDir);
        MakeLink("/H", Path.Combine(archiveDir, Path.GetFileName(copy)), f.Audio);
        Assert.Throws<IOException>(() => files.ArchiveAudio(copy));
        Assert.True(File.Exists(copy));
        f.AssertOriginal();
    }

    [Fact]
    public void GeneratedAudio_OnlyFreshReservedAndCompletedOwnedFileCanArchive()
    {
        var f = new Fixture();
        var files = new EngineJobFiles(f.Policy);
        var output = Path.Combine(f.Voice, "gen_001.mp3");
        Directory.CreateDirectory(f.Voice);
        File.WriteAllBytes(output, [1]);
        Assert.Throws<IOException>(() => files.PrepareGeneratedAudio(output));
        Assert.Throws<ArgumentException>(() => files.RegisterGeneratedAudio(output));
        var fresh = Path.Combine(f.Voice, "gen_002.mp3");
        files.PrepareGeneratedAudio(fresh);
        Assert.Throws<ArgumentException>(() => files.ArchiveAudio(fresh));
        File.WriteAllBytes(fresh, [2, 3]);
        files.RegisterGeneratedAudio(fresh);
        var archived = files.ArchiveAudio(fresh);
        Assert.Equal(new byte[] { 2, 3 }, File.ReadAllBytes(archived));
    }

    [Theory]
    [InlineData("outside")]
    [InlineData("relative")]
    [InlineData("cache")]
    public async Task RunAsync_InvalidOutDirRefusesBeforeAnyDirectoryProbeOrCodec(string kind)
    {
        var f = new Fixture();
        var job = f.Job();
        job.OutDir = kind switch { "outside" => Path.Combine(f.Root, "escape"), "relative" => "relative", _ => f.Policy.CacheRoot };
        var codec = new SyntheticCodec(f); var probe = new SyntheticProbe(f);
        await Assert.ThrowsAsync<ArgumentException>(() => new FissionEngine(f.Policy, codec, probe, false).RunAsync(job));
        Assert.Empty(codec.Requests); Assert.Empty(probe.Files);
        Assert.False(Directory.Exists(f.Policy.Paths.WorkRoot));
        Assert.False(Directory.Exists(f.Policy.Paths.OutRoot));
        Assert.False(Directory.Exists(f.Policy.CacheRoot));
        Assert.False(Directory.Exists(Path.Combine(f.Root, "escape")));
        f.AssertOriginal();
    }

    [Theory]
    [InlineData("relative")]
    [InlineData("junction")]
    [InlineData("overlap")]
    public async Task RunAsync_InvalidSourceDirectoryRefusesBeforeWritesOrProbe(string kind)
    {
        var f = new Fixture(); var job = f.Job();
        if (kind == "relative") job.AudioDir = "relative";
        else if (kind == "junction") { job.AudioDir = Path.Combine(f.Root, "linked-audio"); MakeLink("/J", job.AudioDir, f.AudioDir); }
        else { Directory.CreateDirectory(f.Policy.Paths.OutRoot); job.AudioDir = f.Policy.Paths.OutRoot; }
        var codec = new SyntheticCodec(f); var probe = new SyntheticProbe(f);
        await Assert.ThrowsAsync<ArgumentException>(() => new FissionEngine(f.Policy, codec, probe, false).RunAsync(job));
        Assert.Empty(codec.Requests); Assert.Empty(probe.Files);
        Assert.False(Directory.Exists(f.Policy.Paths.WorkRoot)); Assert.False(Directory.Exists(f.Policy.CacheRoot));
        f.AssertOriginal();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RunAsync_OriginalEntryStagesConfirmsAndArchivesOnlyOwnedCopy(bool subtitles)
    {
        var f = new Fixture(); var job = f.Job(); job.SubtitleEnabled = subtitles;
        File.WriteAllText(Path.Combine(Path.GetDirectoryName(f.AudioDir)!, "meta.json"), "{\"items\":[{\"file\":\"配音 one.mp3\",\"text\":\"synthetic line\"}]}");
        var codec = new SyntheticCodec(f); var probe = new SyntheticProbe(f);
        var report = await new FissionEngine(f.Policy, codec, probe, false).RunAsync(job);
        Assert.Equal(1, report.Succeeded); Assert.Equal(0, report.Failed); Assert.Equal("countReached", report.StopReason);
        var output = Assert.Single(report.Outputs);
        Assert.Equal("配音 one.mp4", Path.GetFileName(output.Path)); Assert.Equal("配音 one", output.Title);
        Assert.Equal(2, output.DurationSec); Assert.Equal("synthetic output", File.ReadAllText(output.Path));
        Assert.NotNull(Assert.Single(report.ConsumeLog).ConfirmedAt);
        Assert.Contains(probe.Files, p => p.StartsWith(f.Policy.Paths.WorkRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal) && Path.GetFileName(p) == "配音 one.mp3");
        Assert.DoesNotContain(f.Audio, probe.Files);
        var staged = Assert.Single(codec.MergedAudio);
        Assert.Equal("配音 one.mp3", Path.GetFileName(staged)); Assert.False(File.Exists(staged));
        var archive = Path.Combine(f.Policy.Paths.WorkRoot, "_consumed", "配音 one.mp3");
        Assert.Equal(Fixture.AudioBytes, File.ReadAllBytes(archive));
        Assert.True(File.Exists(Path.Combine(f.Policy.CacheRoot, "多场景素材缓存.ini")));
        Assert.False(File.Exists(Path.Combine(f.Policy.Paths.WorkRoot, "多场景素材缓存.ini")));
        Assert.All(codec.ConcatLists, p => { Assert.StartsWith(f.Policy.Paths.WorkRoot + Path.DirectorySeparatorChar, p, StringComparison.Ordinal); Assert.True(File.Exists(p)); });
        Assert.Single(codec.ConcatLists);
        if (subtitles) Assert.Contains("synthetic line", File.ReadAllText(Assert.Single(Directory.GetFiles(f.Policy.Paths.WorkRoot, "sub.ass", SearchOption.AllDirectories))));
        else Assert.Empty(Directory.GetFiles(f.Policy.Paths.WorkRoot, "sub.ass", SearchOption.AllDirectories));
        Assert.Equal(f.AudioDir, job.AudioDir); Assert.Null(job.OutDir);
        f.AssertOriginal(); Assert.False(Directory.Exists(Path.Combine(f.AudioDir, "_consumed")));
        Assert.False(Directory.Exists(f.LegacyWork)); Assert.False(Directory.Exists(f.LegacyOut));
    }

    [Fact]
    public async Task RunAsync_FailureBeforeConfirmNeverArchivesAndNeverChangesSource()
    {
        var f = new Fixture(); var codec = new SyntheticCodec(f) { FailMerge = true }; var probe = new SyntheticProbe(f);
        await Assert.ThrowsAsync<IOException>(() => new FissionEngine(f.Policy, codec, probe, false).RunAsync(f.Job()));
        f.AssertOriginal(); Assert.False(Directory.Exists(Path.Combine(f.Policy.Paths.WorkRoot, "_consumed")));
        Assert.Single(Directory.GetFiles(f.Policy.Paths.WorkRoot, "配音 one.mp3", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task RunAsync_CancelAtMergeNeverArchivesOrChangesSource()
    {
        var f = new Fixture(); var codec = new SyntheticCodec(f) { CancelMerge = true }; var probe = new SyntheticProbe(f);
        var report = await new FissionEngine(f.Policy, codec, probe, false).RunAsync(f.Job());
        Assert.Equal(0, report.Succeeded); Assert.Equal("userStopped", report.StopReason);
        f.AssertOriginal(); Assert.False(Directory.Exists(Path.Combine(f.Policy.Paths.WorkRoot, "_consumed")));
    }

    [Fact]
    public async Task RunAsync_GeneratedAudioIsRegisteredThenArchived()
    {
        var f = new Fixture(); var job = f.Job(); job.AudioDir = null; job.GeneratedAudioCount = 1; job.GeneratedAudioDurationSec = 2;
        var report = await new FissionEngine(f.Policy, new SyntheticCodec(f), new SyntheticProbe(f), false).RunAsync(job);
        Assert.Equal(1, report.Succeeded);
        Assert.Equal("synthetic output", File.ReadAllText(Path.Combine(f.Policy.Paths.WorkRoot, "_consumed", "gen_001.mp3")));
        f.AssertOriginal();
    }

    [Fact]
    public async Task RunAsync_TwoAttemptsKeepWorkCacheOutputDisjointAndRejectReuse()
    {
        var f = new Fixture();
        var first = new FissionEngine(f.Policy, new SyntheticCodec(f), new SyntheticProbe(f), false);
        var a = await first.RunAsync(f.Job());
        var otherPolicy = f.OtherPolicy(); var g = f.WithPolicy(otherPolicy);
        var b = await new FissionEngine(otherPolicy, new SyntheticCodec(g), new SyntheticProbe(g), false).RunAsync(g.Job());
        Assert.NotEqual(a.Outputs[0].Path, b.Outputs[0].Path);
        Assert.NotEqual(f.Policy.CacheRoot, otherPolicy.CacheRoot);
        Assert.True(File.Exists(Path.Combine(otherPolicy.CacheRoot, "多场景素材缓存.ini")));
        await Assert.ThrowsAsync<IOException>(() => first.RunAsync(f.Job()));
        f.AssertOriginal();
    }


    [Theory]
    [InlineData("cache-file")]
    [InlineData("work-file")]
    [InlineData("output-junction")]
    [InlineData("preexisting-cache")]
    public async Task RunAsync_InvalidComputedDirectoriesRefuseBeforeAnyMkdirOrProbe(string kind)
    {
        var f = new Fixture();
        Directory.CreateDirectory(Path.GetDirectoryName(f.Policy.CacheRoot)!);
        if (kind == "cache-file") File.WriteAllText(f.Policy.CacheRoot, "preexisting file");
        else if (kind == "work-file") File.WriteAllText(f.Policy.Paths.WorkRoot, "preexisting file");
        else if (kind == "preexisting-cache") Directory.CreateDirectory(f.Policy.CacheRoot);
        else { var target = Path.Combine(f.Root, "junction-target"); Directory.CreateDirectory(target); MakeLink("/J", f.Policy.Paths.OutRoot, target); }
        var options = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint };
        var before = Directory.GetFileSystemEntries(f.Root, "*", options).Order().ToArray();
        var codec = new SyntheticCodec(f); var probe = new SyntheticProbe(f);
        var engine = new FissionEngine(f.Policy, codec, probe, false);
        if (kind == "preexisting-cache") await Assert.ThrowsAsync<IOException>(() => engine.RunAsync(f.Job()));
        else await Assert.ThrowsAsync<ArgumentException>(() => engine.RunAsync(f.Job()));
        Assert.Equal(before, Directory.GetFileSystemEntries(f.Root, "*", options).Order().ToArray());
        Assert.Empty(codec.Requests); Assert.Empty(probe.Files); f.AssertOriginal();
    }



    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RunAsync_FirstTransitionConcatFailureUsesFreshFallbackAndPreservesFailedEvidence(bool partialOutput)
    {
        var f = new Fixture(); var job = f.Job();
        job.SplitMode = SplitMode.AveragePieces; job.AvgPieces = 2; job.TransitionSec = 0.25;
        File.WriteAllText(Path.Combine(f.ReadOnly.TransitionsDir, "fade.glsl"), "synthetic shader, never executed");
        var codec = new SyntheticCodec(f) { FailFirstConcat = true, LeavePartialConcat = partialOutput };
        var probe = new SyntheticProbe(f);
        var report = await new FissionEngine(f.Policy, codec, probe, false).RunAsync(job);
        Assert.Equal(1, report.Succeeded); Assert.Equal(0, report.Failed);
        Assert.Equal("synthetic output", File.ReadAllText(Assert.Single(report.Outputs).Path));
        Assert.Equal(2, codec.ConcatLists.Count); Assert.Equal(2, codec.ConcatOutputs.Count);
        Assert.NotEqual(codec.ConcatLists[0], codec.ConcatLists[1]);
        Assert.NotEqual(codec.ConcatOutputs[0], codec.ConcatOutputs[1]);
        Assert.Equal(codec.FailedConcatListText, File.ReadAllText(codec.ConcatLists[0]));
        Assert.Contains("s01.mp4", codec.FailedConcatListText);
        Assert.DoesNotContain("s01.mp4", File.ReadAllText(codec.ConcatLists[1]));
        Assert.Contains("c001.mp4", File.ReadAllText(codec.ConcatLists[1]));
        if (partialOutput) Assert.Equal("synthetic partial concat", File.ReadAllText(codec.ConcatOutputs[0]));
        else Assert.False(File.Exists(codec.ConcatOutputs[0]));
        Assert.Equal(codec.ConcatOutputs[1], Assert.Single(codec.MergedVideo));
        Assert.Contains(codec.ConcatOutputs[1], probe.Files);
        Assert.DoesNotContain(codec.ConcatOutputs[0], probe.Files);
        Assert.All(codec.ConcatOutputs.Concat(codec.ConcatLists), p => Assert.True(f.IsOwned(p)));
        Assert.NotNull(Assert.Single(report.ConsumeLog).ConfirmedAt);
        Assert.Equal(Fixture.AudioBytes, File.ReadAllBytes(Path.Combine(f.Policy.Paths.WorkRoot, "_consumed", "配音 one.mp3")));
        f.AssertOriginal(); Assert.False(Directory.Exists(Path.Combine(f.AudioDir, "_consumed")));
    }

    private static void MakeLink(string kind, string link, string target)
    {
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"))
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            Arguments = $"/d /c mklink {kind} \"{link}\" \"{target}\"" };
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEnd(); var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit(); Assert.True(process.ExitCode == 0, $"Real Windows fixture link required: {stdout} {stderr}");
    }

    private sealed class Fixture
    {
        public static readonly byte[] AudioBytes = [1, 2, 3, 4, 5, 6];
        public Fixture()
        {
            var owner = Environment.GetEnvironmentVariable("FISSION_PATH_POLICY_TEST_ROOT") ?? throw new InvalidOperationException("Explicit owned fixture root required.");
            Assert.True(Path.IsPathFullyQualified(owner));
            Root = Path.Combine(owner, Guid.NewGuid().ToString("N"));
            var read = Path.Combine(Root, "read"); Directory.CreateDirectory(read);
            var marker = Path.Combine(read, "engine.exe"); File.WriteAllText(marker, "synthetic marker, never executable");
            LegacyWork = Path.Combine(Root, "legacy-work"); LegacyOut = Path.Combine(Root, "legacy-out");
            ReadOnly = new EnginePaths { FFmpeg = marker, FFprobe = marker, FFmpeg6 = marker, AssetsRoot = read,
                LocalAssetsRoot = read, TransitionsDir = read, WorkRoot = LegacyWork, OutRoot = LegacyOut };
            Policy = new EnginePathPolicy(ReadOnly, Path.Combine(Root, "owned"), "task-a", "attempt-1");
            VideoDir = Path.Combine(Root, "input", "video"); AudioDir = Path.Combine(Root, "input", "audio");
            Directory.CreateDirectory(VideoDir); Directory.CreateDirectory(AudioDir);
            var scene = Path.Combine(VideoDir, "01-scene"); Directory.CreateDirectory(scene);
            Video = Path.Combine(scene, "video.mp4"); Audio = Path.Combine(AudioDir, "配音 one.mp3");
            File.WriteAllText(Video, "synthetic video"); File.WriteAllBytes(Audio, AudioBytes);
            OriginalHash = SHA256.HashData(AudioBytes);
        }
        private Fixture(Fixture original, EnginePathPolicy policy)
        { Root = original.Root; ReadOnly = original.ReadOnly; Policy = policy; VideoDir = original.VideoDir; AudioDir = original.AudioDir;
            Video = original.Video; Audio = original.Audio; LegacyWork = original.LegacyWork; LegacyOut = original.LegacyOut; OriginalHash = original.OriginalHash; }
        public string Root { get; }
        public EnginePaths ReadOnly { get; }
        public EnginePathPolicy Policy { get; }
        public string VideoDir { get; }
        public string AudioDir { get; }
        public string Video { get; }
        public string Audio { get; }
        public string LegacyWork { get; }
        public string LegacyOut { get; }
        public byte[] OriginalHash { get; }
        public string Voice => Path.Combine(Policy.Paths.WorkRoot, "voice");
        public EnginePathPolicy OtherPolicy() => new(ReadOnly, Path.Combine(Root, "owned"), "task-a", "attempt-2");
        public Fixture WithPolicy(EnginePathPolicy policy) => new(this, policy);
        public FissionJob Job() => new() { VideoDir = VideoDir, AudioDir = AudioDir, Count = 1, Threads = 1, AudioUses = 1,
            SplitMode = SplitMode.None, TransitionSec = 0, UseNvenc = false, RandomHFlip = false };
        public void AssertOriginal() { Assert.True(File.Exists(Audio)); Assert.Equal(AudioBytes, File.ReadAllBytes(Audio)); Assert.Equal(OriginalHash, SHA256.HashData(File.ReadAllBytes(Audio))); }
        public bool IsOwned(string path) => path.StartsWith(Policy.Paths.WorkRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            || path.StartsWith(Policy.Paths.OutRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    }

    private sealed class SyntheticProbe(Fixture fixture) : IMediaProbe
    {
        public ConcurrentBag<string> Files { get; } = [];
        public Task<MediaInfo> ProbeAsync(string file, CancellationToken ct = default)
        {
            ct.ThrowIfCancellationRequested();
            Assert.True(file == fixture.Video || fixture.IsOwned(file), "Probe must never read external source audio.");
            Assert.True(File.Exists(file)); Assert.NotEmpty(File.ReadAllBytes(file)); Files.Add(file);
            return Task.FromResult(new MediaInfo(2, 1080, 1920, 30, false, "h264", "aac", 44100, true));
        }
    }

    private sealed class SyntheticCodec(Fixture fixture) : IVideoEngine
    {
        public ConcurrentBag<VideoEngineRequest> Requests { get; } = [];
        public List<string> MergedAudio { get; } = [];
        public List<string> ConcatLists { get; } = [];
        public List<string> ConcatOutputs { get; } = [];
        public List<string> MergedVideo { get; } = [];
        public bool FailFirstConcat { get; init; }
        public bool LeavePartialConcat { get; init; }
        public string? FailedConcatListText { get; private set; }
        public bool FailMerge { get; init; }
        public bool CancelMerge { get; init; }
        public Task<ProcessResult> RunAsync(VideoEngineRequest request, Action<double>? onProgress = null, CancellationToken ct = default)
        {
            ct.ThrowIfCancellationRequested(); Assert.Equal(fixture.ReadOnly.FFmpeg, request.EngineFileName);
            var args = request.Arguments; var quoted = Regex.Matches(args, "\"([^\"]*)\"").Select(m => m.Groups[1].Value).ToArray();
            Assert.NotEmpty(quoted); var output = quoted[^1]; Assert.True(fixture.IsOwned(output));
            fixture.Policy.ValidateWritablePath(Path.GetDirectoryName(output)!);
            var inputs = Regex.Matches(args, "-i \"([^\"]*)\"").Select(m => m.Groups[1].Value).ToArray();
            var generated = args.StartsWith("-y -f lavfi -t 2.00 -i \"sine=frequency=180:sample_rate=44100\"", StringComparison.Ordinal);
            var normalize = args.StartsWith("-y -i ", StringComparison.Ordinal) && args.Contains("scale=1080:1920", StringComparison.Ordinal);
            var cut = args.StartsWith("-y -ss 0.000 -t 2.000 -accurate_seek", StringComparison.Ordinal)
                || args.StartsWith("-y -ss 0.000 -t 1.000 -accurate_seek", StringComparison.Ordinal)
                || args.StartsWith("-y -ss 1.000 -t 1.000 -accurate_seek", StringComparison.Ordinal);
            var tail = args.StartsWith("-y -sseof -0.45 -i", StringComparison.Ordinal)
                && args.Contains("-t 0.25 -an -c:v libx264 -preset ultrafast -crf 20 -pix_fmt yuv420p", StringComparison.Ordinal);
            var transition = args.Contains("[0:v][1:v]gltransition=offset=0:duration=0.25:source=", StringComparison.Ordinal)
                && inputs.Length == 2 && args.Contains("-map \"[vt]\" -an -c:v libx264", StringComparison.Ordinal);
            var concat = args.StartsWith("-y -f concat -safe 0", StringComparison.Ordinal);
            var merge = args.Contains("[1:a]volume=1.00,loudnorm", StringComparison.Ordinal);
            var subtitle = args.Contains("-vf \"ass=filename=", StringComparison.Ordinal);
            var cover = args.StartsWith("-y -ss 1.00 -i", StringComparison.Ordinal) && args.Contains("-frames:v 1 -q:v 2", StringComparison.Ordinal);
            Assert.True(generated || normalize || cut || tail || transition || concat || merge || subtitle || cover, "Unknown codec command shape.");
            if (!generated) foreach (var input in inputs) { Assert.True(input == fixture.Video || fixture.IsOwned(input)); Assert.True(File.Exists(input)); Assert.NotEmpty(File.ReadAllBytes(input)); }
            if (concat)
            {
                var list = Assert.Single(inputs); ConcatLists.Add(list); ConcatOutputs.Add(output);
                foreach (var line in File.ReadAllLines(list)) { Assert.StartsWith("file '", line); var input = line[6..^1]; Assert.True(fixture.IsOwned(input)); Assert.True(File.Exists(input)); }
            }
            if (concat && FailFirstConcat && ConcatOutputs.Count == 1)
            {
                FailedConcatListText = File.ReadAllText(ConcatLists[0]);
                if (LeavePartialConcat)
                {
                    using var partial = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                    partial.Write("synthetic partial concat"u8);
                }
                throw new EngineException("SYNTHETIC_CONCAT_FAILURE", "Synthetic first transition concat failure");
            }
            if (merge)
            {
                Assert.Equal(2, inputs.Length); Assert.Equal(".mp3", Path.GetExtension(inputs[1])); MergedAudio.Add(inputs[1]); MergedVideo.Add(inputs[0]);
                if (FailMerge) throw new IOException("synthetic merge failure");
                if (CancelMerge) throw new OperationCanceledException("synthetic codec cancellation");
            }
            Requests.Add(request);
            using (var file = new FileStream(output, generated ? FileMode.Truncate : FileMode.CreateNew, FileAccess.Write, FileShare.None))
                file.Write("synthetic output"u8);
            onProgress?.Invoke(1);
            return Task.FromResult(new ProcessResult(0, string.Empty, string.Empty, 1));
        }
    }
}
