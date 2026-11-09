using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Fission.Core.Abstractions;
using Fission.Core.Engine;
using Fission.Core.Errors;
using Fission.Core.Jobs;
using Fission.Core.Process;
using Fission.Providers.Pipeline;

namespace Fission.UnitTests;

// Real original RunAsync and BCL files; codecs/probe are explicitly synthetic.
public sealed class FissionEditPlanTests
{
    [Fact]
    public async Task RunAsync_ActualChoicesBecomeEditableRecord_WithOriginalVoiceAndSharedCues()
    {
        var f = new Fixture(); var job = f.Job(); job.SubtitleEnabled = true;
        var report = await f.Engine.RunAsync(job);
        var output = Assert.Single(report.Outputs);
        Assert.NotNull(output.EditPlanPath);
        using var plan = JsonDocument.Parse(File.ReadAllText(output.EditPlanPath)); var p = plan.RootElement;
        Assert.Equal(1, p.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(report.JobId, p.GetProperty("jobId").GetString());
        Assert.Equal(0, p.GetProperty("outputIndex").GetInt32()); Assert.Equal(4, p.GetProperty("durationSec").GetDouble());
        Assert.Equal(1080, p.GetProperty("stage").GetProperty("w").GetInt32());
        var visuals = p.GetProperty("visuals").EnumerateArray().ToArray();
        Assert.Equal(2, visuals.Length);
        Assert.Equal("1开场", visuals[0].GetProperty("group").GetString()); Assert.Equal("2产品", visuals[1].GetProperty("group").GetString());
        Assert.All(visuals, v => { Assert.Equal(0, v.GetProperty("startSec").GetDouble()); Assert.Equal(2, v.GetProperty("durationSec").GetDouble()); Assert.Equal(1, v.GetProperty("speed").GetDouble()); });
        var sources = p.GetProperty("sources").EnumerateArray().ToArray();
        var voice = sources[p.GetProperty("audio").GetProperty("voice").GetProperty("source").GetInt32()];
        Assert.Equal(f.Audio, voice.GetProperty("path").GetString());
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(f.Audio))), voice.GetProperty("sha256").GetString());
        Assert.All(sources, source => Assert.True(File.Exists(source.GetProperty("path").GetString())));
        Assert.Equal("sentence-weighted-approximation", p.GetProperty("subtitles").GetProperty("timingSource").GetString());
        var cues = p.GetProperty("subtitles").GetProperty("cues").EnumerateArray().ToArray();
        Assert.Equal(2, cues.Length); Assert.Equal(0, cues[0].GetProperty("startSec").GetDouble()); Assert.Equal(1.6, cues[0].GetProperty("endSec").GetDouble()); Assert.Equal(4, cues[1].GetProperty("endSec").GetDouble());
        Assert.False(p.GetProperty("exportReady").GetBoolean()); Assert.False(p.GetProperty("equivalenceVerified").GetBoolean());
        Assert.Contains("fission-postmix-loudnorm", p.GetProperty("blockingCapabilities").EnumerateArray().Select(v => v.GetString()));
        var sample = Environment.GetEnvironmentVariable("FISSION_HANDOFF_SAMPLE_OUT") ?? throw new InvalidOperationException("Explicit unique sample output required.");
        File.Copy(output.EditPlanPath, sample, overwrite: false);
        Assert.True(File.Exists(f.Audio)); Assert.False(Directory.Exists(Path.Combine(f.AudioDir, "_consumed")));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RunAsync_ActualTransitionOutcomeAndBgm_AreNotGuessed(bool fallback)
    {
        var f = new Fixture(fallback); var job = f.Job(); job.TransitionSec = 0.25; job.BgmDir = f.BgmDir;
        var report = await f.Engine.RunAsync(job);
        using var doc = JsonDocument.Parse(File.ReadAllText(Assert.Single(report.Outputs).EditPlanPath!));
        var p = doc.RootElement; var transition = p.GetProperty("transitions");
        Assert.Equal(fallback ? "fallback-no-transition" : "applied", transition.GetProperty("outcome").GetString());
        Assert.Equal("fade", transition.GetProperty("selectedName").GetString());
        Assert.Equal(0.25, transition.GetProperty("durationSec").GetDouble());
        Assert.Equal(0.2, transition.GetProperty("tailPaddingSec").GetDouble());
        var music = p.GetProperty("audio").GetProperty("music");
        Assert.Equal(0.35, music.GetProperty("volume").GetDouble()); Assert.True(music.GetProperty("loop").GetBoolean());
        Assert.False(p.GetProperty("exportReady").GetBoolean());
    }

    [Fact]
    public async Task RunAsync_PlanWriteFailure_DoesNotReturnSuccessfulHandoff()
    {
        var f = new Fixture(blockPlanWrite: true);
        await Assert.ThrowsAsync<IOException>(() => f.Engine.RunAsync(f.Job()));
        Assert.DoesNotContain(f.Bus.Events, e => e.OutputIndex == 0 && e.Stage == JobStage.Done);
    }

    [Fact]
    public async Task RunAsync_LoopDecisionAndGeneratedVoiceReference_SurviveOriginalArchive()
    {
        var f = new Fixture(); var job = f.Job(); job.AudioDir = null; job.GeneratedAudioCount = 1;
        job.GeneratedAudioDurationSec = 6; job.TargetDurationSec = 6; job.Align = AlignStrategy.AlwaysLoop;
        var report = await f.Engine.RunAsync(job); var output = Assert.Single(report.Outputs);
        using var doc = JsonDocument.Parse(File.ReadAllText(output.EditPlanPath!)); var p = doc.RootElement;
        Assert.Equal("loop", p.GetProperty("alignment").GetProperty("action").GetString());
        Assert.Equal(2, p.GetProperty("alignment").GetProperty("loops").GetInt32());
        Assert.Equal(6, p.GetProperty("durationSec").GetDouble());
        var voice = p.GetProperty("sources")[p.GetProperty("audio").GetProperty("voice").GetProperty("source").GetInt32()];
        var source = voice.GetProperty("path").GetString()!;
        Assert.Contains("_consumed", source); Assert.True(File.Exists(source));
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(source))), voice.GetProperty("sha256").GetString());
        var sample = Environment.GetEnvironmentVariable("FISSION_HANDOFF_LOOP_SAMPLE_OUT") ?? throw new InvalidOperationException("Explicit unique sample output required.");
        File.Copy(output.EditPlanPath!, sample, overwrite: false);
    }

    [Fact]
    public async Task RunAsync_ImageSpeedAndIntroOutro_AreCapturedAtTheirActualPositions()
    {
        var f = new Fixture(); var job = f.Job();
        var intro = Path.Combine(f.Root, "intro"); var outro = Path.Combine(f.Root, "outro");
        Directory.CreateDirectory(intro); Directory.CreateDirectory(outro);
        File.WriteAllText(Path.Combine(intro, "intro.mp4"), "synthetic intro"); File.WriteAllText(Path.Combine(outro, "outro.mp4"), "synthetic outro");
        File.WriteAllText(Path.Combine(f.VideoDir, "1开场", "a.png"), "synthetic still");
        job.IntroDir = intro; job.OutroDir = outro; job.ImageDurMinSec = 2; job.ImageDurMaxSec = 2;
        job.SceneGroups = [new("1开场", TakePerOutput: 1, Rule: GroupRule.Sequential, Speed: 2), new("2产品", TakePerOutput: 1)];
        var output = Assert.Single((await f.Engine.RunAsync(job)).Outputs);
        using var doc = JsonDocument.Parse(File.ReadAllText(output.EditPlanPath!)); var p = doc.RootElement;
        var visual = p.GetProperty("visuals");
        Assert.Equal(4, visual.GetArrayLength());
        Assert.Equal("intro", visual[0].GetProperty("role").GetString()); Assert.Equal("outro", visual[3].GetProperty("role").GetString());
        Assert.Equal(2, visual[1].GetProperty("speed").GetDouble());
        Assert.Equal("still", p.GetProperty("sources")[visual[1].GetProperty("source").GetInt32()].GetProperty("kind").GetString());
    }
    [Fact]
    public async Task RunAsync_VoiceVersionIsBoundBeforeOriginalCopy_NotRehashedAfterSourceChange()
    {
        var f = new Fixture(); var expected = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(f.Audio))); var attempted = false;
        f.AfterNormalizationRead = source =>
        {
            if (attempted) return; attempted = true;
            try { File.WriteAllText(f.Audio, "changed after private staging"); } catch (IOException) { }
        };
        var output = Assert.Single((await f.Engine.RunAsync(f.Job())).Outputs);
        using var doc = JsonDocument.Parse(File.ReadAllText(output.EditPlanPath!)); var p = doc.RootElement;
        var voice = p.GetProperty("sources")[p.GetProperty("audio").GetProperty("voice").GetProperty("source").GetInt32()];
        Assert.True(attempted); Assert.Equal(expected, voice.GetProperty("sha256").GetString());
    }

    [Fact]
    public async Task RunAsync_IntroVersionIsBoundBeforeNormalize_NotRehashedAfterCodecRead()
    {
        var f = new Fixture(); var job = f.Job(); var intro = Path.Combine(f.Root, "intro"); Directory.CreateDirectory(intro);
        var source = Path.Combine(intro, "intro.mp4"); File.WriteAllText(source, "original intro version"); job.IntroDir = intro;
        var expected = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(source))); var attempted = false;
        f.AfterNormalizationRead = file =>
        {
            if (file != source) return; attempted = true;
            try { File.WriteAllText(source, "changed after normalized intro"); } catch (IOException) { }
        };
        var output = Assert.Single((await f.Engine.RunAsync(job)).Outputs);
        using var doc = JsonDocument.Parse(File.ReadAllText(output.EditPlanPath!)); var p = doc.RootElement;
        var visual = p.GetProperty("visuals")[0]; var version = p.GetProperty("sources")[visual.GetProperty("source").GetInt32()];
        Assert.True(attempted); Assert.Equal(expected, version.GetProperty("sha256").GetString());
        Assert.Contains(f.NormalizationReads, read => read.Source == source && read.Hash == expected);
    }

    [Fact]
    public async Task RunAsync_NormalizedCacheAndLaterOutput_KeepTheSameVersionAcrossTheWholeRun()
    {
        var f = new Fixture(); var job = f.Job(); job.Count = 2;
        File.WriteAllText(Path.Combine(f.AudioDir, "voice2.mp3"), "second original voice");
        var source = Path.Combine(f.VideoDir, "1开场", "scene.mp4");
        var expected = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(source))); var attempted = false;
        f.Bus.OnEmit = evt =>
        {
            if (evt.Stage != JobStage.Selecting || evt.OutputIndex != 1) return; attempted = true;
            try { File.WriteAllText(source, "changed between cached outputs"); } catch (IOException) { }
        };
        var report = await f.Engine.RunAsync(job); Assert.Equal(2, report.Outputs.Count); Assert.True(attempted);
        foreach (var output in report.Outputs)
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(output.EditPlanPath!));
            var version = Assert.Single(doc.RootElement.GetProperty("sources").EnumerateArray(), v => v.GetProperty("path").GetString() == source);
            Assert.Equal(expected, version.GetProperty("sha256").GetString());
        }
        Assert.Single(f.NormalizationReads, read => read.Source == source);
    }
    private sealed class Fixture
    {
        public Fixture(bool fallback = false, bool blockPlanWrite = false)
        {
            var owner = Environment.GetEnvironmentVariable("FISSION_PATH_POLICY_TEST_ROOT") ?? throw new InvalidOperationException("Explicit owned fixtures required.");
            Root = Path.Combine(owner, "plan-" + Guid.NewGuid().ToString("N")); var read = Path.Combine(Root, "read"); Directory.CreateDirectory(read);
            var marker = Path.Combine(read, "engine.exe"); File.WriteAllText(marker, "synthetic marker never executed"); File.WriteAllText(Path.Combine(read, "fade.glsl"), "synthetic shader never executed");
            var paths = new EnginePaths { FFmpeg = marker, FFprobe = marker, FFmpeg6 = marker, TransitionsDir = read, AssetsRoot = read, LocalAssetsRoot = read };
            Policy = new EnginePathPolicy(paths, Path.Combine(Root, "owned"), "task-plan", "attempt-1");
            VideoDir = Path.Combine(Root, "video"); AudioDir = Path.Combine(Root, "audio"); BgmDir = Path.Combine(Root, "music");
            foreach (var directory in new[] { "1开场", "2产品" }) { var d = Path.Combine(VideoDir, directory); Directory.CreateDirectory(d); File.WriteAllText(Path.Combine(d, "scene.mp4"), "synthetic original " + directory); }
            Directory.CreateDirectory(AudioDir); Audio = Path.Combine(AudioDir, "voice.mp3"); File.WriteAllText(Audio, "synthetic original voice");
            Directory.CreateDirectory(BgmDir); File.WriteAllText(Path.Combine(BgmDir, "bed.mp3"), "synthetic original music");
            File.WriteAllText(Path.Combine(Root, "meta.json"), "{\"items\":[{\"file\":\"voice.mp3\",\"text\":\"甲。乙乙。\"}]}");
            var codec = new Codec(this, fallback, blockPlanWrite); Engine = new FissionEngine(Policy, codec, new Probe(this, codec), false, Bus);
        }
        public Action<string>? AfterNormalizationRead { get; set; }
        public ConcurrentBag<(string Source, string Hash)> NormalizationReads { get; } = [];
        public EventsBus Bus { get; } = new();
        public string Root { get; }
        public string VideoDir { get; }
        public string AudioDir { get; }
        public string Audio { get; }
        public string BgmDir { get; }
        public EnginePathPolicy Policy { get; }
        public FissionEngine Engine { get; }
        public FissionJob Job() => new() { VideoDir = VideoDir, AudioDir = AudioDir, Count = 1, Threads = 1, SplitMode = SplitMode.None,
            UseNvenc = false, RandomHFlip = false, SceneGroups = [new("1开场", TakePerOutput: 1), new("2产品", TakePerOutput: 1)] };
    }
    private sealed class EventsBus : IJobEventBus
    {
        public ConcurrentBag<JobEvent> Events { get; } = [];
        public Action<JobEvent>? OnEmit { get; set; }
        public void Emit(JobEvent evt) { Events.Add(evt); OnEmit?.Invoke(evt); }
        public IDisposable Subscribe(Action<JobEvent> handler) => throw new NotSupportedException();
    }
    private sealed class Probe(Fixture fixture, Codec codec) : IMediaProbe
    {
        public Task<MediaInfo> ProbeAsync(string file, CancellationToken ct = default)
        {
            ct.ThrowIfCancellationRequested(); Assert.True(File.Exists(file));
            var seconds = codec.Durations.TryGetValue(file, out var d) ? d : Path.GetExtension(file) == ".mp3" ? 4 : 2;
            if (file.StartsWith(fixture.Policy.Paths.OutRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            {
                using var metadata = JsonDocument.Parse(File.ReadAllText(file));
                seconds = metadata.RootElement.GetProperty("durationSec").GetDouble();
            }
            Assert.StartsWith(fixture.Root + Path.DirectorySeparatorChar, file, StringComparison.Ordinal);
            return Task.FromResult(new MediaInfo(seconds, 1080, 1920, 30, false, "h264", "aac", 44100, true));
        }
    }
    private sealed class Codec(Fixture fixture, bool fallback, bool blockPlanWrite) : IVideoEngine
    {
        public ConcurrentDictionary<string, double> Durations { get; } = new(StringComparer.Ordinal);
        public Task<ProcessResult> RunAsync(VideoEngineRequest request, Action<double>? onProgress = null, CancellationToken ct = default)
        {
            ct.ThrowIfCancellationRequested(); Assert.Equal(fixture.Policy.Paths.FFmpeg, request.EngineFileName);
            var args = request.Arguments; var inputs = Regex.Matches(args, "-i \"([^\"]*)\"").Select(m => m.Groups[1].Value).ToArray();
            var output = Regex.Matches(args, "\"([^\"]*)\"").Last().Groups[1].Value;
            Assert.True(output.StartsWith(fixture.Policy.Paths.WorkRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal) || output.StartsWith(fixture.Policy.Paths.OutRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal));
            if (args.Contains("-f lavfi", StringComparison.Ordinal)) Assert.Equal("sine=frequency=180:sample_rate=44100", Assert.Single(inputs));
            else foreach (var input in inputs) Assert.True(File.Exists(input));
            if (args.Contains("force_original_aspect_ratio", StringComparison.Ordinal) && inputs.Length == 1)
            {
                fixture.NormalizationReads.Add((inputs[0], Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(inputs[0])))));
                fixture.AfterNormalizationRead?.Invoke(inputs[0]);
            }
            if (fallback && args.Contains("gltransition=", StringComparison.Ordinal)) throw new EngineException("SYNTHETIC_TRANSITION_FAILURE", "synthetic transition failure");
            var seconds = request.TotalDurationSec ?? 4;
            if (args.StartsWith("-y -f concat", StringComparison.Ordinal)) seconds = File.ReadAllLines(Assert.Single(inputs)).Sum(line => Durations[line[6..^1]]);
            if (args.Contains("-frames:v 1", StringComparison.Ordinal) && blockPlanWrite) File.WriteAllText(Path.ChangeExtension(Assert.Single(inputs), ".edit-plan.json"), "preserved collision");
            using (var file = new FileStream(output, args.Contains("-f lavfi", StringComparison.Ordinal) ? FileMode.Truncate : FileMode.CreateNew, FileAccess.Write, FileShare.None)) file.Write(JsonSerializer.SerializeToUtf8Bytes(new { durationSec = seconds }));
            Durations[output] = seconds; onProgress?.Invoke(1); return Task.FromResult(new ProcessResult(0, "", "", 1));
        }
    }
}