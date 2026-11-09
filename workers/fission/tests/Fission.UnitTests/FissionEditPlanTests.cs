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

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PrepareAsync_RootVisualsRemainVisuals_WithSeparateVoiceAndUnchangedGroup(bool images)
    {
        var f = new Fixture();
        var rootVisuals = Path.Combine(f.Root, "root-visuals"); Directory.CreateDirectory(rootVisuals);
        var extension = images ? ".png" : ".mp4";
        File.WriteAllText(Path.Combine(rootVisuals, "a" + extension), "synthetic root visual A");
        File.WriteAllText(Path.Combine(rootVisuals, "b" + extension), "synthetic root visual B");
        var job = f.Job(); job.VideoDir = rootVisuals; job.SceneGroups = null; job.Pick = PickRule.Sequential;
        job.TransitionSec = 0; job.SubtitleEnabled = false; job.ImageDurMinSec = 2; job.ImageDurMaxSec = 2;
        var prepared = await f.Engine.PrepareAsync(job);
        var output = Assert.Single(prepared.Outputs);
        Assert.Equal(f.Audio, output.Sources[output.Audio.Voice.Source].Path);
        Assert.Equal(2, output.SelectedVideos.Count);
        Assert.All(output.SelectedVideos, visual => { Assert.Equal(string.Empty, visual.Group); Assert.Equal(images, visual.IsImage); });
        Assert.All(output.Cuts, cut => Assert.Equal(string.Empty, cut.Decision.Group));
        var serialized = prepared.ToJson();
        var report = await f.FreshEngine().ExecutePreparedAsync(job, prepared);
        var delivered = Assert.Single(report.Outputs);
        Assert.Equal(0, delivered.Index);
        Assert.Equal(serialized, prepared.ToJson());
        using var plan = JsonDocument.Parse(File.ReadAllText(delivered.EditPlanPath!));
        var value = plan.RootElement;
        var voice = value.GetProperty("sources")[value.GetProperty("audio").GetProperty("voice").GetProperty("source").GetInt32()];
        Assert.Equal(f.Audio, voice.GetProperty("path").GetString());
        Assert.All(value.GetProperty("visuals").EnumerateArray(), visual => Assert.Equal(string.Empty, visual.GetProperty("group").GetString()));
    }

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
    [Fact]
    public async Task RunAsync_CancelDuringDispatch_DrainsLaunchedCodecBeforeReleasingSourcePins()
    {
        var f = new Fixture(); var job = f.Job(); job.Count = 2; job.AudioUses = 0;
        var started = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        f.BeforeNormalize = async () => { started.TrySetResult(true); await release.Task; };
        using var cancel = new CancellationTokenSource(); var work = f.Engine.RunAsync(job, cancel.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5)); cancel.Cancel();
        try
        {
            await Task.Delay(30);
            Assert.False(work.IsCompleted, "dispatch cancellation must drain the already-launched actual codec before returning");
            Assert.Throws<IOException>(() => File.WriteAllText(f.Audio, "must stay version-pinned"));
        }
        finally { release.TrySetResult(true); try { await work; } catch (OperationCanceledException) { } }
        Assert.Equal("userStopped", (await work).StopReason);
        File.WriteAllText(f.Audio, "released only after codec drain");
    }
    [Fact]
    public async Task Prepare_FreezesRealChoicesBeforeAnyFinalWork_ExecuteConsumesWithoutSelection()
    {
        var f = new Fixture(); var job = f.Job(); job.SubtitleEnabled = true;
        var prepared = await f.Engine.PrepareAsync(job);
        var output = Assert.Single(prepared.Outputs); Assert.Equal(2, output.Cuts.Count);
        Assert.All(f.CodecRequests, request => Assert.Contains("force_original_aspect_ratio", request.Arguments));
        Assert.Empty(Directory.GetFiles(f.Policy.Paths.OutRoot, "*", SearchOption.AllDirectories));
        var json = prepared.ToJson(); Assert.DoesNotContain("synthetic original voice", json);
        // Candidate additions after preparation may not enter execution selection.
        File.WriteAllText(Path.Combine(f.VideoDir, "1开场", "new-candidate.mp4"), "not selected");
        var report = await f.Engine.ExecutePreparedAsync(job, Fission.Core.Pipeline.FissionPreparedDecisions.Parse(json));
        Assert.Equal(1, report.Succeeded); Assert.Empty(report.Failures);
        using var receipt = JsonDocument.Parse(File.ReadAllText(Assert.Single(report.Outputs).EditPlanPath!));
        Assert.Equal(output.Cuts.Count, receipt.RootElement.GetProperty("visuals").GetArrayLength());
        Assert.DoesNotContain(f.CodecRequests, r => r.Arguments.Contains("new-candidate", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ExecutePrepared_ChangedSourceRefusesBeforeAnyCodec()
    {
        var f = new Fixture(); var job = f.Job(); var prepared = await f.Engine.PrepareAsync(job);
        File.WriteAllText(f.Audio, "changed after prepare closed its held pins"); var before = f.CodecRequests.Count;
        await Assert.ThrowsAnyAsync<FissionException>(() => f.Engine.ExecutePreparedAsync(job, prepared));
        Assert.Equal(before, f.CodecRequests.Count);
    }

    [Fact]
    public async Task ExecutePrepared_ClockDeviationRefusesWithoutChangingTheDecision()
    {
        var f = new Fixture(); var job = f.Job(); var prepared = await f.Engine.PrepareAsync(job);
        f.AssemblyClockOffset = 1;
        await Assert.ThrowsAnyAsync<FissionException>(() => f.Engine.ExecutePreparedAsync(job, prepared));
        Assert.DoesNotContain(f.CodecRequests, r => r.Arguments.Contains("loudnorm=", StringComparison.Ordinal));
    }
    [Fact]
    public async Task PreparedGeneratedVoice_ReopensInNewNativeOwner_WithVersionAndOriginEvidence()
    {
        var f = new Fixture(); var job = f.Job(); job.AudioDir = null; job.GeneratedAudioCount = 1; job.GeneratedAudioDurationSec = 4;
        var prepared = await f.Engine.PrepareAsync(job); var output = Assert.Single(prepared.Outputs);
        Assert.NotNull(output.GeneratedVoice); Assert.Equal("native-offline-lavfi-voice/v1", output.GeneratedVoice.Purpose);
        var reopened = Fission.Core.Pipeline.FissionPreparedDecisions.Parse(prepared.ToJson());
        var report = await f.FreshEngine().ExecutePreparedAsync(job, reopened);
        Assert.Equal(1, report.Succeeded); Assert.True(File.Exists(Assert.Single(report.Outputs).EditPlanPath));
    }

    [Fact]
    public async Task PreparedGeneratedVoice_ProofReplacementRefusesBeforeAnyCodec()
    {
        var f = new Fixture(); var job = f.Job(); job.AudioDir = null; job.GeneratedAudioCount = 1; job.GeneratedAudioDurationSec = 4;
        var prepared = await f.Engine.PrepareAsync(job); var proof = Assert.Single(prepared.Outputs).GeneratedVoice!;
        File.WriteAllText(proof.ProofPath, "forged generated-origin marker"); var before = f.CodecRequests.Count;
        await Assert.ThrowsAnyAsync<FissionException>(() => f.FreshEngine().ExecutePreparedAsync(job, prepared));
        Assert.Equal(before, f.CodecRequests.Count);
    }
    [Fact]
    public async Task Prepare_StillPhysicalDurationZero_IsSeparateFromSelectedHold()
    {
        var f = new Fixture(); File.Delete(Path.Combine(f.VideoDir, "1开场", "scene.mp4"));
        File.WriteAllText(Path.Combine(f.VideoDir, "1开场", "still.png"), "owned synthetic still");
        var job = f.Job(); job.ImageDurMinSec = 2; job.ImageDurMaxSec = 2;
        var prepared = await f.Engine.PrepareAsync(job); var output = Assert.Single(prepared.Outputs);
        var cut = Assert.Single(output.Cuts, c => output.Sources[c.Decision.Source].Kind == "still");
        Assert.Equal(0, output.Sources[cut.Decision.Source].DurationSec); Assert.Equal(2, cut.Normalization.ImageHoldSec);
        Assert.Equal(2, cut.Decision.DurationSec); Assert.DoesNotContain(f.CodecRequests, r => r.Arguments.StartsWith("-y -ss", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ExecutePrepared_AnalysisReplacementWithIdenticalBytesStillRefusesIdentityChange()
    {
        var f = new Fixture(); var job = f.Job(); var prepared = await f.Engine.PrepareAsync(job);
        var path = Assert.Single(prepared.Outputs).Cuts[0].Normalization.Path; var bytes = File.ReadAllBytes(path);
        File.Move(path, path + ".old"); File.WriteAllBytes(path, bytes); var before = f.CodecRequests.Count;
        await Assert.ThrowsAnyAsync<FissionException>(() => f.FreshEngine().ExecutePreparedAsync(job, prepared));
        Assert.Equal(before, f.CodecRequests.Count);
    }

    [Fact]
    public async Task PreparedSnapshot_AlteredOrMissingFactsAreNotRecipesToReplay()
    {
        var f = new Fixture(); var prepared = await f.Engine.PrepareAsync(f.Job());
        var json = prepared.ToJson();
        Assert.Throws<ConfigException>(() => Fission.Core.Pipeline.FissionPreparedDecisions.Parse(json.Replace(prepared.JobId, "tampered", StringComparison.Ordinal)));
        Assert.Throws<ConfigException>(() => Fission.Core.Pipeline.FissionPreparedDecisions.Parse("{}"));
    }

    [Fact]
    public async Task ExecutePrepared_SelectedFxFailureDoesNotFallbackOrReselect()
    {
        var f = new Fixture(true); var job = f.Job(); job.TransitionSec = .25;
        var prepared = await f.Engine.PrepareAsync(job);
        Assert.Equal("prepared-intent", Assert.Single(prepared.Outputs).TransitionIntent.Outcome);
        await Assert.ThrowsAnyAsync<EngineException>(() => f.Engine.ExecutePreparedAsync(job, prepared));
        Assert.DoesNotContain(f.CodecRequests, r => r.Arguments.Contains("assembled-fallback", StringComparison.Ordinal));
        Assert.DoesNotContain(f.CodecRequests, r => r.Arguments.Contains("loudnorm=", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Prepare_CancelledNormalizationDrainsBeforeReleasingTheSourceNamespace()
    {
        var f = new Fixture(); var started = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        f.BeforeNormalize = async () => { started.TrySetResult(true); await release.Task; };
        using var cancel = new CancellationTokenSource(); var work = f.Engine.PrepareAsync(f.Job(), cancel.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5)); cancel.Cancel();
        try { await Task.Delay(20); Assert.False(work.IsCompleted); Assert.Throws<IOException>(() => File.WriteAllText(f.Audio, "must remain pinned")); }
        finally { release.TrySetResult(true); }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => work);
        File.WriteAllText(f.Audio, "released after actual admitted work drained");
    }
    [Fact]
    public async Task ExecutePrepared_MissingNormalizationIsSafeRefusalBeforeCodec()
    {
        var f = new Fixture(); var job = f.Job(); var prepared = await f.Engine.PrepareAsync(job);
        File.Delete(Assert.Single(prepared.Outputs).Cuts[0].Normalization.Path); var before = f.CodecRequests.Count;
        await Assert.ThrowsAnyAsync<FissionException>(() => f.Engine.ExecutePreparedAsync(job, prepared));
        Assert.Equal(before, f.CodecRequests.Count);
    }

    [Fact]
    public async Task ExecutePrepared_ChangedConfiguredCodecBindingIsNotPartOfTheFrozenProducer()
    {
        var f = new Fixture(); var job = f.Job(); var prepared = await f.Engine.PrepareAsync(job);
        var extra = Path.Combine(f.Root, "read", "other-engine.exe"); File.WriteAllText(extra, "other synthetic codec never run");
        var policy = new EnginePathPolicy(f.Policy.Paths with { FFmpeg6 = extra }, Path.Combine(f.Root, "owned"), "task-plan", "attempt-1");
        var codec = new Codec(f, false, false); var engine = new FissionEngine(policy, codec, new Probe(f, codec), false); var before = f.CodecRequests.Count;
        await Assert.ThrowsAnyAsync<FissionException>(() => engine.ExecutePreparedAsync(job, prepared));
        Assert.Equal(before, f.CodecRequests.Count);
    }
    [Fact]
    public async Task DefaultGeneratedRunDoesNotCreatePreparedOriginSeal()
    {
        var f = new Fixture(); var job = f.Job(); job.AudioDir = null; job.GeneratedAudioCount = 1; job.GeneratedAudioDurationSec = 4;
        var report = await f.Engine.RunAsync(job); Assert.Equal(1, report.Succeeded);
        Assert.False(File.Exists(Path.Combine(f.Policy.CacheRoot, ".native-prepared-generated.key")));
    }
    [Theory]
    [InlineData("missing-key")]
    [InlineData("wrong-purpose")]
    [InlineData("forged-mac")]
    public async Task PreparedGeneratedVoice_ValidLocalDigestCannotReplaceOriginEvidence(string tamper)
    {
        var f = new Fixture(); var job = f.Job(); job.AudioDir = null; job.GeneratedAudioCount = 1; job.GeneratedAudioDurationSec = 4;
        var prepared = await f.Engine.PrepareAsync(job); var output = Assert.Single(prepared.Outputs); var evidence = output.GeneratedVoice!;
        if (tamper == "missing-key") File.Delete(Path.Combine(f.Policy.CacheRoot, ".native-prepared-generated.key"));
        if (tamper == "wrong-purpose") output = output with { GeneratedVoice = evidence with { Purpose = "copied-input-is-not-native-generated" } };
        var versions = prepared.Versions.ToArray();
        if (tamper == "forged-mac")
        {
            var proof = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(evidence.ProofPath))!; proof["mac"] = new string('0', 64);
            File.WriteAllText(evidence.ProofPath, proof.ToJsonString());
            var sha = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(evidence.ProofPath)));
            using var held = new FileStream(evidence.ProofPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            var identity = Fission.Core.Pipeline.PreparedFileIdentity.Read(held.SafeFileHandle);
            versions = versions.Select(v => v.Path == evidence.ProofPath ? v with { Sha256 = sha, Identity = identity } : v).ToArray();
            output = output with { GeneratedVoice = evidence with { ProofSha256 = sha } };
        }
        prepared = Fission.Core.Pipeline.FissionPreparedDecisions.Create(job, prepared.JobId, prepared.WorkRoot, prepared.OutRoot,
            prepared.CacheRoot, f.Policy.Paths, [output], versions);
        var before = f.CodecRequests.Count;
        await Assert.ThrowsAnyAsync<FissionException>(() => f.FreshEngine().ExecutePreparedAsync(job, prepared));
        Assert.Equal(before, f.CodecRequests.Count);
    }

    [Fact]
    public async Task PreparedGeneratedVoice_ConsumedOutputCannotBeReopenedOrUsedTwice()
    {
        var f = new Fixture(); var job = f.Job(); job.AudioDir = null; job.GeneratedAudioCount = 1; job.GeneratedAudioDurationSec = 4;
        var prepared = await f.Engine.PrepareAsync(job); var report = await f.FreshEngine().ExecutePreparedAsync(job, prepared);
        Assert.Equal(1, report.Succeeded); var before = f.CodecRequests.Count;
        await Assert.ThrowsAnyAsync<FissionException>(() => f.FreshEngine().ExecutePreparedAsync(job, prepared));
        Assert.Equal(before, f.CodecRequests.Count);
    }
    [Fact]
    public async Task Prepare_SubtitleIsOnlyIntent_AndReceiptAppliedOnlyAfterBurn()
    {
        var f = new Fixture(); var job = f.Job(); job.SubtitleEnabled = true;
        var prepared = await f.Engine.PrepareAsync(job);
        Assert.Equal("prepared-intent", Assert.Single(prepared.Outputs).SubtitleIntent.Outcome);
        Assert.DoesNotContain(f.CodecRequests, r => r.Arguments.Contains("ass=", StringComparison.Ordinal));
        var report = await f.FreshEngine().ExecutePreparedAsync(job, prepared);
        using var receipt = JsonDocument.Parse(File.ReadAllText(Assert.Single(report.Outputs).EditPlanPath!));
        Assert.Equal("applied", receipt.RootElement.GetProperty("subtitles").GetProperty("outcome").GetString());
    }

    [Fact]
    public async Task ExecutePrepared_FinalClockDeviationRefusesBeforeExportOrConsumption()
    {
        var f = new Fixture(); var job = f.Job(); var prepared = await f.Engine.PrepareAsync(job); f.FinalClockOffset = -2;
        await Assert.ThrowsAnyAsync<FissionException>(() => f.FreshEngine().ExecutePreparedAsync(job, prepared));
        Assert.Empty(Directory.GetFiles(f.Policy.Paths.OutRoot, "*", SearchOption.AllDirectories));
        Assert.True(File.Exists(Assert.Single(prepared.Outputs).VoicePath));
    }

    [Fact]
    public async Task ExecutePrepared_ReusedOriginalVoiceUsesOneNativePoolKeyAndCounter()
    {
        var f = new Fixture(); foreach (var group in new[] { "1开场", "2产品" }) File.WriteAllText(Path.Combine(f.VideoDir, group, "second.mp4"), "owned extra candidate");
        var job = f.Job(); job.Count = 2; job.AudioUses = 2;
        var prepared = await f.Engine.PrepareAsync(job); Assert.Equal(2, prepared.Outputs.Count);
        var report = await f.FreshEngine().ExecutePreparedAsync(job, prepared); Assert.Equal(2, report.Succeeded);
        Assert.Single(report.ConsumeLog.Select(row => row.Audio).Distinct());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task NativeCli_PreparedNvencRequestRejectsChangedRuntimeBeforeAnyHardwareOrCodec(bool changeBytes)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7, 0)) throw new PlatformNotSupportedException("Original CLI targets Windows.");
        var f = new Fixture(); var job = f.Job(); job.UseNvenc = true; var prepared = await f.Engine.PrepareAsync(job);
        var paths = f.Policy.Paths;
        if (changeBytes) File.WriteAllText(paths.FFmpeg, "changed invalid executable must never be started");
        else { var alternate = Path.Combine(f.Root, "read", "alternate.exe"); File.WriteAllText(alternate, "invalid executable must never be started"); paths = paths with { FFmpeg = alternate }; }
        var snapshot = Path.Combine(f.Policy.Paths.WorkRoot, "prepared.json"); File.WriteAllText(snapshot, prepared.ToJson());
        var config = Path.Combine(f.Root, "cli-paths.json"); var file = Path.Combine(f.Root, "cli-job.json");
        File.WriteAllText(config, JsonSerializer.Serialize(new { paths.FFmpeg, paths.FFprobe, paths.FFmpeg6, paths.TransitionsDir, paths.AssetsRoot, paths.LocalAssetsRoot }));
        File.WriteAllText(file, JsonSerializer.Serialize(job));
        var status = await Fission.Cli.Program.Main(["execute-prepared", "--paths", config, "--workspace", Path.Combine(f.Root, "owned"),
            "--task", "task-plan", "--attempt", "attempt-1", "--job", file, "--prepared", snapshot, "--digest", prepared.Digest]);
        Assert.Equal(2, status); Assert.Empty(Directory.GetFiles(f.Policy.Paths.OutRoot, "*", SearchOption.AllDirectories));
    }
    [Fact]
    public async Task PreparedRuntimeLeaseHoldsTheActualToolAndNamespaceUntilDispose()
    {
        var f = new Fixture(); var job = f.Job(); var prepared = await f.Engine.PrepareAsync(job);
        using (await f.FreshEngine().HoldPreparedRuntimeAsync(job, prepared))
        {
            Assert.Throws<IOException>(() => File.WriteAllText(f.Policy.Paths.FFmpeg, "must not change under hardware/codec"));
            var read = Path.GetDirectoryName(f.Policy.Paths.FFmpeg)!;
            Assert.Throws<IOException>(() => Directory.Move(read, read + "-replaced"));
        }
        using var writable = new FileStream(f.Policy.Paths.FFmpeg, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        Assert.True(writable.CanWrite);
    }

    [Fact]
    public async Task PreparedGeneratedVoice_TwoNativeUsesShareOneSealedVersionWithoutOverwrite()
    {
        var f = new Fixture(); foreach (var group in new[] { "1开场", "2产品" }) File.WriteAllText(Path.Combine(f.VideoDir, group, "second.mp4"), "owned extra candidate");
        var job = f.Job(); job.AudioDir = null; job.GeneratedAudioCount = 1; job.GeneratedAudioDurationSec = 4; job.AudioUses = 2; job.Count = 2;
        var prepared = await f.Engine.PrepareAsync(job); Assert.Equal(2, prepared.Outputs.Count);
        Assert.Equal(prepared.Outputs[0].GeneratedVoice, prepared.Outputs[1].GeneratedVoice);
        var proof = prepared.Outputs[0].GeneratedVoice!; var proofBytes = File.ReadAllBytes(proof.ProofPath);
        var report = await f.FreshEngine().ExecutePreparedAsync(job, prepared); Assert.Equal(2, report.Succeeded);
        Assert.Single(report.ConsumeLog.Select(row => row.Audio).Distinct());
        Assert.Equal(proofBytes, File.ReadAllBytes(proof.ProofPath));
    }

    private static readonly int[] SubsetRequested = [2, 0];
    private static readonly int[] SubsetOrdered = [0, 2];
    private static readonly int[] SubsetFirst = [0];
    [Fact]
    public async Task ExecutePrepared_SubsetKeepsOriginalSnapshotAndOnlyExecutesActualNoncontiguousIndices()
    {
        var f = new Fixture(); foreach (var group in new[] { "1开场", "2产品" }) foreach (var name in new[] { "second.mp4", "third.mp4" })
            File.WriteAllText(Path.Combine(f.VideoDir, group, name), "owned extra candidate " + name);
        var job = f.Job(); job.Count = 3; job.AudioUses = 3;
        var prepared = await f.Engine.PrepareAsync(job); Assert.Equal(3, prepared.Outputs.Count); var original = prepared.ToJson();
        var report = await f.FreshEngine().ExecutePreparedAsync(job, prepared, SubsetRequested);
        Assert.Equal(SubsetOrdered, report.Outputs.Select(o => o.Index)); Assert.Equal(2, report.Succeeded); Assert.Empty(report.Failures);
        Assert.Equal(2, report.ConsumeLog.Count); Assert.Single(report.ConsumeLog.Select(row => row.Audio).Distinct());
        Assert.Equal(original, prepared.ToJson()); Assert.Equal(3, job.Count);
        Assert.Empty(Directory.GetFiles(Path.Combine(f.Policy.Paths.WorkRoot, prepared.JobId, "temp", "o1")));
        Assert.False(Directory.Exists(Path.Combine(f.Policy.Paths.WorkRoot, prepared.JobId, "execute-voice-1")));
    }

    [Fact]
    public async Task NativeCli_SubsetParserKeepsFullOriginalProducerSnapshotAndNativeIndices()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7, 0)) throw new PlatformNotSupportedException("Original CLI targets Windows.");
        var f = new Fixture(); foreach (var group in new[] { "1开场", "2产品" }) foreach (var name in new[] { "second.mp4", "third.mp4" })
            File.WriteAllText(Path.Combine(f.VideoDir, group, name), "owned extra candidate " + name);
        var job = f.Job(); job.Count = 3; job.AudioUses = 3; var prepared = await f.Engine.PrepareAsync(job);
        var config = Path.Combine(f.Root, "subset-paths.json"); var jobFile = Path.Combine(f.Root, "subset-job.json"); var paths = f.Policy.Paths;
        File.WriteAllText(config, JsonSerializer.Serialize(new { paths.FFmpeg, paths.FFprobe, paths.FFmpeg6, paths.TransitionsDir, paths.AssetsRoot, paths.LocalAssetsRoot }));
        File.WriteAllText(jobFile, JsonSerializer.Serialize(job)); var snapshot = Path.Combine(paths.WorkRoot, "prepared.json"); File.WriteAllText(snapshot, prepared.ToJson());
        var loaded = Fission.Cli.EngineRunConfiguration.LoadCommand(["execute-prepared", "--paths", config, "--workspace", Path.Combine(f.Root, "owned"),
            "--task", "task-plan", "--attempt", "attempt-1", "--job", jobFile, "--prepared", snapshot, "--digest", prepared.Digest, "--outputs", "[2,0]"]);
        Assert.Equal(SubsetRequested, loaded.OutputIndices); Assert.Equal(3, loaded.Prepared!.Outputs.Count); Assert.Equal(prepared.Digest, loaded.Prepared.Digest);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PreparedSubset_OnlySelectedDependencyClosureAndOriginalVoiceUsesApply(bool generated)
    {
        var f = new Fixture(); foreach (var group in new[] { "1开场", "2产品" }) foreach (var name in new[] { "second.mp4", "third.mp4" })
            File.WriteAllText(Path.Combine(f.VideoDir, group, name), "owned extra candidate " + name);
        var job = f.Job(); job.Count = 3; job.AudioUses = 3; job.BgmDir = f.BgmDir; job.BgmVolume = 0;
        if (generated) { job.AudioDir = null; job.GeneratedAudioCount = 1; job.GeneratedAudioDurationSec = 4; }
        var prepared = await f.Engine.PrepareAsync(job); var rejected = Assert.Single(prepared.Outputs, o => o.Index == 1);
        File.WriteAllText(rejected.Sources[rejected.Cuts[0].Decision.Source].Path, "changed rejected-only original");
        File.Delete(rejected.Cuts[0].Normalization.Path);
        File.Delete(Path.Combine(f.BgmDir, "bed.mp3")); Directory.Delete(f.BgmDir); // This unused root is deliberately no longer enumerable.
        using (await f.FreshEngine().HoldPreparedRuntimeAsync(job, prepared, SubsetOrdered)) { }
        var report = await f.FreshEngine().ExecutePreparedAsync(job, prepared, SubsetRequested);
        Assert.Equal(SubsetOrdered, report.Outputs.Select(o => o.Index)); Assert.Equal(2, report.ConsumeLog.Count);
        Assert.Single(report.ConsumeLog.Select(row => row.Audio).Distinct());
        Assert.Empty(Directory.GetFiles(Path.Combine(f.Policy.Paths.WorkRoot, prepared.JobId, "temp", "o1")));
    }

    [Theory]
    [InlineData("source")]
    [InlineData("normalization")]
    [InlineData("text")]
    [InlineData("shader")]
    [InlineData("proof")]
    [InlineData("key")]
    public async Task PreparedSubset_SelectedDependencyMutationRefusesBeforeCopyOrFinalCodec(string kind)
    {
        var f = new Fixture(); var job = f.Job(); job.SubtitleEnabled = kind == "text";
        if (kind == "shader") { job.TransitionName = "fade"; job.TransitionSec = .3; }
        if (kind is "proof" or "key") { job.AudioDir = null; job.GeneratedAudioCount = 1; job.GeneratedAudioDurationSec = 4; }
        var prepared = await f.Engine.PrepareAsync(job); var output = Assert.Single(prepared.Outputs);
        var file = kind switch { "source" => output.Sources[output.Cuts[0].Decision.Source].Path,
            "normalization" => output.Cuts[0].Normalization.Path, "text" => Path.Combine(f.Root, "meta.json"),
            "shader" => output.TransitionIntent.Shader!.Path, "proof" => output.GeneratedVoice!.ProofPath,
            _ => Path.Combine(f.Policy.CacheRoot, ".native-prepared-generated.key") };
        File.WriteAllText(file, "changed selected evidence"); var before = f.CodecRequests.Count;
        await Assert.ThrowsAnyAsync<FissionException>(() => f.FreshEngine().ExecutePreparedAsync(job, prepared, SubsetFirst));
        Assert.Equal(before, f.CodecRequests.Count); Assert.False(Directory.Exists(Path.Combine(f.Policy.Paths.WorkRoot, prepared.JobId, "execute-voice-0")));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("[0,0]")]
    [InlineData("[99]")]
    [InlineData("[-1]")]
    [InlineData("[0.5]")]
    [InlineData("null")]
    public async Task NativeCli_InvalidSubsetRefusesBeforeHardwareOrAnyExecutionWrites(string json)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7, 0)) throw new PlatformNotSupportedException("Original CLI targets Windows.");
        var f = new Fixture(); var job = f.Job(); job.UseNvenc = true; var prepared = await f.Engine.PrepareAsync(job); var paths = f.Policy.Paths;
        var config = Path.Combine(f.Root, "bad-subset-paths.json"); var jobFile = Path.Combine(f.Root, "bad-subset-job.json");
        File.WriteAllText(config, JsonSerializer.Serialize(new { paths.FFmpeg, paths.FFprobe, paths.FFmpeg6, paths.TransitionsDir, paths.AssetsRoot, paths.LocalAssetsRoot }));
        File.WriteAllText(jobFile, JsonSerializer.Serialize(job)); var snapshot = Path.Combine(paths.WorkRoot, "prepared.json"); File.WriteAllText(snapshot, prepared.ToJson());
        var files = Directory.GetFiles(paths.WorkRoot, "*", SearchOption.AllDirectories).Order().ToArray();
        Assert.Equal(2, await Fission.Cli.Program.Main(["execute-prepared", "--paths", config, "--workspace", Path.Combine(f.Root, "owned"),
            "--task", "task-plan", "--attempt", "attempt-1", "--job", jobFile, "--prepared", snapshot, "--digest", prepared.Digest, "--outputs", json]));
        Assert.Equal(files, Directory.GetFiles(paths.WorkRoot, "*", SearchOption.AllDirectories).Order());
        Assert.Empty(Directory.GetFiles(paths.OutRoot, "*", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task NativeCli_SubsetDoesNotRevalidateUnusedEmptyIntroDirectory()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7, 0)) throw new PlatformNotSupportedException("Original CLI targets Windows.");
        var f = new Fixture(); var job = f.Job(); job.IntroDir = Path.Combine(f.Root, "empty-intro"); Directory.CreateDirectory(job.IntroDir);
        var prepared = await f.Engine.PrepareAsync(job); Directory.Delete(job.IntroDir);
        var paths = f.Policy.Paths; var config = Path.Combine(f.Root, "unused-paths.json"); var jobFile = Path.Combine(f.Root, "unused-job.json");
        File.WriteAllText(config, JsonSerializer.Serialize(new { paths.FFmpeg, paths.FFprobe, paths.FFmpeg6, paths.TransitionsDir, paths.AssetsRoot, paths.LocalAssetsRoot }));
        File.WriteAllText(jobFile, JsonSerializer.Serialize(job)); var snapshot = Path.Combine(paths.WorkRoot, "prepared.json"); File.WriteAllText(snapshot, prepared.ToJson());
        var loaded = Fission.Cli.EngineRunConfiguration.LoadCommand(["execute-prepared", "--paths", config, "--workspace", Path.Combine(f.Root, "owned"),
            "--task", "task-plan", "--attempt", "attempt-1", "--job", jobFile, "--prepared", snapshot, "--digest", prepared.Digest, "--outputs", "[0]"]);
        Assert.Equal(prepared.JobSha256, loaded.Prepared!.JobSha256); Assert.Equal(job.IntroDir, loaded.Job.IntroDir);
    }

    [Theory]
    [InlineData("empty")]
    [InlineData("null")]
    [InlineData("duplicate")]
    [InlineData("unknown")]
    public async Task PreparedSubset_InvalidDirectSelectionHasNoCopyOrCodecSideEffects(string kind)
    {
        var f = new Fixture(); var job = f.Job(); var prepared = await f.Engine.PrepareAsync(job);
        int[]? indices = kind switch { "empty" => [], "null" => null, "duplicate" => [0,0], _ => [999] };
        var files = Directory.GetFiles(f.Policy.Paths.WorkRoot, "*", SearchOption.AllDirectories).Order().ToArray(); var before = f.CodecRequests.Count;
        await Assert.ThrowsAnyAsync<FissionException>(() => f.Engine.ExecutePreparedAsync(job, prepared, indices!));
        await Assert.ThrowsAnyAsync<FissionException>(() => f.Engine.HoldPreparedRuntimeAsync(job, prepared, indices!));
        Assert.Equal(before, f.CodecRequests.Count); Assert.Equal(files, Directory.GetFiles(f.Policy.Paths.WorkRoot, "*", SearchOption.AllDirectories).Order());
    }

    [Fact]
    public async Task PreparedSubset_CancelledGeneratedExecutionHoldsSourceProofAndKeyUntilProducerDrains()
    {
        var f = new Fixture(); var job = f.Job(); job.AudioDir = null; job.GeneratedAudioCount = 1; job.GeneratedAudioDurationSec = 4;
        var prepared = await f.Engine.PrepareAsync(job); var output = Assert.Single(prepared.Outputs); var key = Path.Combine(f.Policy.CacheRoot, ".native-prepared-generated.key");
        var started = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously); var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        f.BeforeCodec = async _ => { started.TrySetResult(true); await release.Task; };
        using var cancel = new CancellationTokenSource(); var task = f.FreshEngine().ExecutePreparedAsync(job, prepared, SubsetFirst, cancel.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5)); cancel.Cancel();
        try
        {
            Assert.False(task.IsCompleted);
            Assert.Throws<IOException>(() => File.WriteAllText(key, "must remain pinned"));
            Assert.Throws<IOException>(() => File.WriteAllText(output.GeneratedVoice!.ProofPath, "must remain pinned"));
            Assert.Throws<IOException>(() => File.WriteAllText(output.VoicePath, "must remain pinned"));
        }
        finally { release.TrySetResult(true); }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => task);
        foreach (var file in new[] { key, output.GeneratedVoice!.ProofPath, output.VoicePath }) { using var writable = new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None); Assert.True(writable.CanWrite); }
        Assert.Empty(Directory.GetFiles(f.Policy.Paths.OutRoot, "*", SearchOption.AllDirectories));
    }

    [Fact]
    [System.Runtime.Versioning.SupportedOSPlatform("windows7.0")]
    public async Task NativeCli_ExplicitNullSelectorCannotFallBackToWholeExecution()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7, 0)) throw new PlatformNotSupportedException("Original CLI targets Windows.");
        var f = new Fixture(); var job = f.Job(); var prepared = await f.Engine.PrepareAsync(job); var paths = f.Policy.Paths;
        var config = Path.Combine(f.Root, "null-paths.json"); var jobFile = Path.Combine(f.Root, "null-job.json");
        File.WriteAllText(config, JsonSerializer.Serialize(new { paths.FFmpeg, paths.FFprobe, paths.FFmpeg6, paths.TransitionsDir, paths.AssetsRoot, paths.LocalAssetsRoot }));
        File.WriteAllText(jobFile, JsonSerializer.Serialize(job)); var snapshot = Path.Combine(paths.WorkRoot, "prepared.json"); File.WriteAllText(snapshot, prepared.ToJson());
        Assert.Throws<ConfigException>(() => Fission.Cli.EngineRunConfiguration.LoadCommand(["execute-prepared", "--paths", config, "--workspace", Path.Combine(f.Root, "owned"),
            "--task", "task-plan", "--attempt", "attempt-1", "--job", jobFile, "--prepared", snapshot, "--digest", prepared.Digest, "--outputs", null!]));
    }

    [Fact]
    public async Task NativeCli_SelectedExecutionParentEofRetiresActualProcessWithoutStartingCodec()
    {
        var f = new Fixture(); var job = f.Job(); var prepared = await f.Engine.PrepareAsync(job); var paths = f.Policy.Paths;
        var config = Path.Combine(f.Root, "eof-paths.json"); var jobFile = Path.Combine(f.Root, "eof-job.json");
        File.WriteAllText(config, JsonSerializer.Serialize(new { paths.FFmpeg, paths.FFprobe, paths.FFmpeg6, paths.TransitionsDir, paths.AssetsRoot, paths.LocalAssetsRoot }));
        File.WriteAllText(jobFile, JsonSerializer.Serialize(job)); var snapshot = Path.Combine(paths.WorkRoot, "prepared.json"); File.WriteAllText(snapshot, prepared.ToJson());
        var start = new System.Diagnostics.ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH")!)
        { WorkingDirectory = f.Root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in new[] { Environment.GetEnvironmentVariable("FISSION_TEST_CLI")!, "execute-prepared", "--paths", config, "--workspace", Path.Combine(f.Root, "owned"),
            "--task", "task-plan", "--attempt", "attempt-1", "--job", jobFile, "--prepared", snapshot, "--digest", prepared.Digest, "--outputs", "[0]" }) start.ArgumentList.Add(arg);
        start.Environment["FISSION_PARENT_STDIN_EOF"] = "1";
        using var child = System.Diagnostics.Process.Start(start)!; var pid = child.Id;
        var stdout = child.StandardOutput.ReadToEndAsync(); var stderr = child.StandardError.ReadToEndAsync(); child.StandardInput.Close();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        try { await child.WaitForExitAsync(timeout.Token); await Task.WhenAll(stdout, stderr).WaitAsync(timeout.Token); }
        finally { if (!child.HasExited) { child.Kill(entireProcessTree: true); await child.WaitForExitAsync(); } }
        var exit = child.ExitCode; child.Dispose();
        var evidence = Environment.GetEnvironmentVariable("FISSION_SUBSET_EOF_EVIDENCE_OUT") ?? Path.Combine(f.Root, "child-eof.json");
        File.WriteAllText(evidence, JsonSerializer.Serialize(new { pid, exit, processExited = true, stdoutEof = stdout.IsCompletedSuccessfully, stderrEof = stderr.IsCompletedSuccessfully, disposed = true, stdinExplicitlyClosed = true }));
        Assert.Equal(130, exit); Assert.Contains("STOPPED", await stderr);
        Assert.False(Directory.Exists(Path.Combine(paths.WorkRoot, prepared.JobId, "execute-voice-0")));
        Assert.Empty(Directory.GetFiles(paths.OutRoot, "*", SearchOption.AllDirectories));
        using var held = new FileStream(paths.FFmpeg, FileMode.Open, FileAccess.ReadWrite, FileShare.None); Assert.True(held.CanWrite);
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
        public ConcurrentBag<VideoEngineRequest> CodecRequests { get; } = [];
        public double AssemblyClockOffset { get; set; }
        public double FinalClockOffset { get; set; }
        public Func<Task>? BeforeNormalize { get; set; }
        public Func<VideoEngineRequest, Task>? BeforeCodec { get; set; }
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
        public FissionEngine FreshEngine() { var codec = new Codec(this, false, false); return new FissionEngine(Policy, codec, new Probe(this, codec), false, Bus); }
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
            if (Path.GetFileName(file).StartsWith("assembled", StringComparison.Ordinal)) seconds += fixture.AssemblyClockOffset;
            Assert.StartsWith(fixture.Root + Path.DirectorySeparatorChar, file, StringComparison.Ordinal);
            return Task.FromResult(new MediaInfo(seconds, 1080, 1920, 30, false, "h264", "aac", 44100, true));
        }
    }
    private sealed class Codec(Fixture fixture, bool fallback, bool blockPlanWrite) : IVideoEngine
    {
        public ConcurrentDictionary<string, double> Durations { get; } = new(StringComparer.Ordinal);
        public async Task<ProcessResult> RunAsync(VideoEngineRequest request, Action<double>? onProgress = null, CancellationToken ct = default)
        {
            ct.ThrowIfCancellationRequested(); Assert.Equal(fixture.Policy.Paths.FFmpeg, request.EngineFileName);
            fixture.CodecRequests.Add(request);
            if (fixture.BeforeCodec is not null) { await fixture.BeforeCodec(request); ct.ThrowIfCancellationRequested(); }
            var args = request.Arguments; var inputs = Regex.Matches(args, "-i \"([^\"]*)\"").Select(m => m.Groups[1].Value).ToArray();
            var output = Regex.Matches(args, "\"([^\"]*)\"").Last().Groups[1].Value;
            Assert.True(output.StartsWith(fixture.Policy.Paths.WorkRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal) || output.StartsWith(fixture.Policy.Paths.OutRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal));
            if (args.Contains("-f lavfi", StringComparison.Ordinal)) Assert.Equal("sine=frequency=180:sample_rate=44100", Assert.Single(inputs));
            else foreach (var input in inputs) Assert.True(File.Exists(input));
            if (args.Contains("force_original_aspect_ratio", StringComparison.Ordinal) && inputs.Length == 1)
            {
                if (fixture.BeforeNormalize is not null) { await fixture.BeforeNormalize(); ct.ThrowIfCancellationRequested(); }
                fixture.NormalizationReads.Add((inputs[0], Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(inputs[0])))));
                fixture.AfterNormalizationRead?.Invoke(inputs[0]);
            }
            if (fallback && args.Contains("gltransition=", StringComparison.Ordinal)) throw new EngineException("SYNTHETIC_TRANSITION_FAILURE", "synthetic transition failure");
            var seconds = request.TotalDurationSec ?? 4;
            if (args.Contains("loudnorm=", StringComparison.Ordinal)) seconds += fixture.FinalClockOffset;
            if (args.StartsWith("-y -f concat", StringComparison.Ordinal)) seconds = File.ReadAllLines(Assert.Single(inputs)).Sum(line => Durations[line[6..^1]]);
            if (args.Contains("-frames:v 1", StringComparison.Ordinal) && blockPlanWrite) File.WriteAllText(Path.ChangeExtension(Assert.Single(inputs), ".edit-plan.json"), "preserved collision");
            using (var file = new FileStream(output, args.Contains("-f lavfi", StringComparison.Ordinal) ? FileMode.Truncate : FileMode.CreateNew, FileAccess.Write, FileShare.None)) file.Write(JsonSerializer.SerializeToUtf8Bytes(new { durationSec = seconds }));
            Durations[output] = seconds; onProgress?.Invoke(1); return new ProcessResult(0, "", "", 1);
        }
    }
}
/// <summary>Actual owned Node process: termination request is not actual retirement.</summary>
public sealed class FissionProcessRetirementTests
{
    [Fact]
    public async Task ControlledCli_OptedInParentEof_CancelsBeforeHardwareOrCodecAndReturnsStopped()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7, 0)) throw new PlatformNotSupportedException("Original CLI targets Windows.");
        var root = Path.Combine(Environment.GetEnvironmentVariable("FISSION_PATH_POLICY_TEST_ROOT")!, "eof-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        var read = Path.Combine(root, "read"); var video = Path.Combine(root, "video"); var audio = Path.Combine(root, "audio");
        foreach (var dir in new[] { read, video, audio }) Directory.CreateDirectory(dir);
        var exe = Path.Combine(read, "never-executed.exe"); File.WriteAllText(exe, "not an executable");
        var config = Path.Combine(root, "paths.json");
        File.WriteAllText(config, JsonSerializer.Serialize(new { FFmpeg = exe, FFprobe = exe, FFmpeg6 = exe, TransitionsDir = read, AssetsRoot = read, LocalAssetsRoot = read }));
        var job = Path.Combine(root, "job.json"); File.WriteAllText(job, JsonSerializer.Serialize(new FissionJob { VideoDir = video, AudioDir = audio, Count = 1, Threads = 1, UseNvenc = false }));
        var input = Console.In; var flag = Environment.GetEnvironmentVariable("FISSION_PARENT_STDIN_EOF");
        try
        {
            Console.SetIn(new StringReader("")); Environment.SetEnvironmentVariable("FISSION_PARENT_STDIN_EOF", "1");
            Assert.Equal(130, await Fission.Cli.Program.Main(["run", "--paths", config, "--workspace", Path.Combine(root, "owned"), "--task", "test", "--attempt", "eof", "--job", job]));
            Assert.False(Directory.Exists(Path.Combine(root, "owned")), "known parent EOF must stop before runtime mkdir and hardware/codec use");
        }
        finally { Console.SetIn(input); Environment.SetEnvironmentVariable("FISSION_PARENT_STDIN_EOF", flag); }
    }

    [Fact]
    public async Task Cancel_KillRequestReturningBeforeActualExit_DoesNotReleaseOwnedProcess()
    {
        var root = Path.Combine(Environment.GetEnvironmentVariable("FISSION_PATH_POLICY_TEST_ROOT")!, "retire-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        var ready = Path.Combine(root, "ready"); var script = Path.Combine(root, "child.mjs");
        File.WriteAllText(script, "import fs from 'node:fs';fs.writeFileSync(process.argv[2],'ready');setInterval(()=>{},1000);");
        var requested = new TaskCompletionSource<System.Diagnostics.Process>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var pool = new ProcessPool(1, process => { requested.TrySetResult(System.Diagnostics.Process.GetProcessById(process.Id)); return Task.CompletedTask; });
        using var cancel = new CancellationTokenSource();
        var work = pool.RunAsync(new ProcessRequest(Environment.GetEnvironmentVariable("FISSION_TEST_NODE")!, $"\"{script}\" \"{ready}\"", TimeoutSec: 20), ct: cancel.Token);
        for (var i = 0; !File.Exists(ready) && i < 1000; i++) await Task.Delay(5);
        Assert.True(File.Exists(ready)); cancel.Cancel(); var child = await requested.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            await Task.Yield(); Assert.False(work.IsCompleted, "requesting a kill is not the actual codec exit"); Assert.Equal(1, pool.RunningCount);
        }
        finally { if (!child.HasExited) child.Kill(entireProcessTree: true); }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => work);
        Assert.True(child.HasExited); Assert.Equal(0, pool.RunningCount);
    }

    [Fact]
    public async Task Dispose_WaitsActualOwnedExitInsteadOfClearingTheRegistry()
    {
        var root = Path.Combine(Environment.GetEnvironmentVariable("FISSION_PATH_POLICY_TEST_ROOT")!, "dispose-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        var ready = Path.Combine(root, "ready"); var script = Path.Combine(root, "child.mjs");
        File.WriteAllText(script, "import fs from 'node:fs';fs.writeFileSync(process.argv[2],'ready');setInterval(()=>{},1000);");
        var requested = new TaskCompletionSource<System.Diagnostics.Process>(TaskCreationOptions.RunContinuationsAsynchronously);
        var pool = new ProcessPool(1, process => { requested.TrySetResult(System.Diagnostics.Process.GetProcessById(process.Id)); return Task.CompletedTask; });
        var work = pool.RunAsync(new ProcessRequest(Environment.GetEnvironmentVariable("FISSION_TEST_NODE")!, $"\"{script}\" \"{ready}\"", TimeoutSec: 20));
        for (var i = 0; !File.Exists(ready) && i < 1000; i++) await Task.Delay(5);
        Assert.True(File.Exists(ready)); var disposing = Task.Run(pool.Dispose); var child = await requested.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try { await Task.Yield(); Assert.False(disposing.IsCompleted); Assert.Equal(1, pool.RunningCount); }
        finally { if (!child.HasExited) child.Kill(entireProcessTree: true); }
        await disposing; await work; Assert.True(child.HasExited); Assert.Equal(0, pool.RunningCount); pool.Dispose();
    }
}