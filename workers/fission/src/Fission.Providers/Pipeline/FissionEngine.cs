using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Security.Cryptography;
using Fission.Core.Abstractions;
using Fission.Core.Engine;
using Fission.Core.Errors;
using Fission.Core.Jobs;
using Fission.Core.Materials;
using Fission.Core.Pipeline;
using Fission.Core.Util;
using Fission.Providers.Media;

namespace Fission.Providers.Pipeline;

/// <summary>单条成片产物。</summary>
/// <param name="Index">序号。</param>
/// <param name="Path">成片绝对路径。</param>
/// <param name="DurationSec">成片时长。</param>
/// <param name="Title">命名标题。</param>
/// <param name="WallMs">耗时。</param>
public sealed record OutputResult(int Index, string Path, double DurationSec, string Title, long WallMs)
{
    /// <summary>Actual decision receipt; null for legacy, explicitly unisolated runs.</summary>
    public string? EditPlanPath { get; init; }
}

/// <summary>失败记录。</summary>
public sealed record FailureRecord(int Index, string Code, string Message);

/// <summary>任务报告。</summary>
public sealed record JobReport(
    string JobId,
    int Succeeded,
    int Failed,
    IReadOnlyList<OutputResult> Outputs,
    IReadOnlyList<FailureRecord> Failures,
    string StopReason,
    long TotalWallMs,
    IReadOnlyList<ConsumeLog> ConsumeLog)
{
    /// <summary>报告序列化选项（缓存复用，CA1869）。</summary>
    private static readonly JsonSerializerOptions Opts = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>JSON 序列化（report.json 脱敏：不含任何 key/token）。</summary>
    public string ToJson() => JsonSerializer.Serialize(this, Opts);
}

/// <summary>
/// 裂变主循环引擎（PRD §2.1 状态机；ADR-002 消耗事务；v1.3 并发 1–64）。
/// 并发模型：成片级并行（Semaphore=Threads）+ NVENC 会话闸门（R9）+ 归一化缓存（跨成片复用，同键单执行）。
/// 故障隔离：单条失败回滚预留并继续批次；素材损坏入池时跳过（契约文案）；nvenc 会话失败自动回退 x264。
/// </summary>
public sealed class FissionEngine
{
    private static readonly string[] VideoExt = [".mp4", ".mov", ".mkv", ".m4v"];
    private static readonly string[] ImageExt = [".jpg", ".jpeg", ".png", ".bmp"];
    private static readonly string[] AudioExt = [".mp3", ".wav", ".m4a"];
    private readonly EnginePaths _paths;
    private readonly EnginePathPolicy? _policy;
    private readonly EngineJobFiles? _files;
    private readonly IVideoEngine _engine;
    private readonly IMediaProbe _probe;
    private readonly IJobEventBus? _bus;
    private readonly bool _hasNvenc;

    /// <summary>Legacy, explicitly unisolated entry. Not admitted for controlled hosts.</summary>
    public FissionEngine(EnginePaths paths, IVideoEngine engine, IMediaProbe probe, bool hasNvenc, IJobEventBus? bus = null)
    {
        _paths = paths;
        _engine = engine;
        _probe = probe;
        _bus = bus;
        _hasNvenc = hasNvenc;
    }

    /// <summary>Explicit controlled entry; binds exactly the supplied policy paths.</summary>
    public FissionEngine(EnginePathPolicy policy, IVideoEngine engine, IMediaProbe probe, bool hasNvenc, IJobEventBus? bus = null)
        : this(policy.Paths, engine, probe, hasNvenc, bus)
    {
        _policy = policy;
        _files = new EngineJobFiles(policy);
    }

    /// <summary>运行整个裂变任务直至终止条件。</summary>
    public async Task<JobReport> RunAsync(FissionJob job, CancellationToken ct = default)
    {
        // Policy/input checks precede original validation and every mkdir/probe.
        var controlledOut = _policy?.ValidateJob(job);
        _files?.ValidateJobInputs(job);
        ct.ThrowIfCancellationRequested();
        job.Validate();
        var jobId = $"job{DateTime.Now:yyyyMMdd_HHmmss}";
        var swTotal = Stopwatch.StartNew();
        var workRoot = Path.Combine(_paths.WorkRoot, jobId);
        var normDir = Path.Combine(workRoot, "norm");
        var voiceDir = Path.Combine(workRoot, "voice");
        var tmpDir = Path.Combine(workRoot, "temp");
        var coverDir = Path.Combine(workRoot, "fengmian");
        var outRoot = controlledOut ?? (!string.IsNullOrWhiteSpace(job.OutDir) ? Path.GetFullPath(job.OutDir) : _paths.OutRoot); // 任务级输出目录（FR-8.4）
        _files?.PrepareRun(job, jobId);
        foreach (var d in new[] { normDir, voiceDir, tmpDir, coverDir, Path.Combine(outRoot, jobId) })
        {
            CreateOwnedDirectory(d);
        }

        Emit(jobId, -1, JobStage.Validating, null, $"[多场景裂变]开始校验 素材目录 {job.VideoDir}");

        // ── 素材入池（损坏跳过，契约文案）──
        var voiceSources = new Dictionary<string, string>(StringComparer.Ordinal);
        using var versions = new RunSourceVersions(_policy, _files);
        var pool = await BuildPoolAsync(job, voiceDir, voiceSources, versions, ct).ConfigureAwait(false);
        var videoByGroup = pool.VideosByGroup();
        var audios = pool.AudioList();
        var totalVoiceUses = audios.Count * Math.Max(job.AudioUses, 1);
        var planned = job.Count == 0 ? totalVoiceUses : Math.Min(job.Count, job.AudioUses == 0 ? job.Count : totalVoiceUses);
        var totalVideo = videoByGroup.SelectMany(g => g).Count(v => !v.IsImage);
        var totalImage = videoByGroup.SelectMany(g => g).Count(v => v.IsImage);
        var groupCount = videoByGroup.Count(g => g.Key.Length > 0);
        Emit(jobId, -1, JobStage.Validating, null, $"池就绪：视频 {totalVideo}（{groupCount} 场景组）· 图片 {totalImage} · 配音 {audios.Count}（总可用 {totalVoiceUses}）· 计划 {planned} 条");

        // ── 场景组选择上下文（启用配置 + 顺序游标 + 可复用组；任务级共享）──
        var configs = new Dictionary<string, SceneGroupConfig>(StringComparer.OrdinalIgnoreCase);
        foreach (var c in job.SceneGroups ?? [])
        {
            if (c.Enabled && !string.IsNullOrWhiteSpace(c.Name) && !configs.ContainsKey(c.Name))
            {
                configs[c.Name] = c;
            }
        }

        var sel = new GroupSelection(configs, new ConcurrentDictionary<string, StrongBox<int>>(StringComparer.OrdinalIgnoreCase));

        // 原版告警原文（重复抽取×随机×用过不删除 组合；本引擎受生成数量封顶，仅提示）
        if (configs.Values.Any(c => c.AllowReuse && !c.UseThenDelete && c.Rule == GroupRule.Random))
        {
            Emit(jobId, -1, JobStage.Validating, null, "提示：当选择重复抽取且随机模式且用过不删除 同时 如果添加了音频且使用规则为随机时则会生产无数视频（本引擎受生成数量封顶，不受影响）");
        }

        var outputs = new ConcurrentBag<OutputResult>();
        var failures = new ConcurrentBag<FailureRecord>();
        var normCache = new ConcurrentDictionary<string, Lazy<Task<string>>>(StringComparer.OrdinalIgnoreCase);
        var normSeq = new StrongBox<int>(0); // 任务级共享序号：产物名全局唯一（教训：每输出独立计数器 → 不同素材同名双写）
        using var nvencGate = new SemaphoreSlim(job.UseNvenc && _hasNvenc ? Math.Max(job.NvencGate, 1) : int.MaxValue);
        var encThreads = Math.Clamp((int)Math.Ceiling(16.0 / Math.Max(job.Threads, 1)), 1, 8);
        using var workerGate = new SemaphoreSlim(Math.Clamp(job.Threads, 1, 64));
        var audioCursor = -1;
        var stopReason = "countReached";

        var workers = new List<Task>(planned);
        for (var i = 0; i < planned; i++)
        {
            var index = i;
            await workerGate.WaitAsync(ct).ConfigureAwait(false);
            workers.Add(Task.Run(async () =>
            {
                try
                {
                    var produced = await ProduceOneAsync(job, jobId, index, pool, videoByGroup, sel, normCache, normSeq, nvencGate, encThreads,
                        tmpDir, coverDir, outRoot, voiceSources, versions, () => Interlocked.Increment(ref audioCursor), ct).ConfigureAwait(false);
                    if (produced is not null)
                    {
                        outputs.Add(produced);
                    }
                }
                catch (OperationCanceledException)
                {
                    Interlocked.Exchange(ref stopReason, "userStopped");
                }
                catch (MaterialException ex) when (ex.Code is "MAT_AUDIO_EXHAUSTED")
                {
                    Interlocked.CompareExchange(ref stopReason, "audioExhausted", "countReached");
                }
                catch (MaterialException ex) when (ex.Code is "MAT_VIDEO_NOT_ENOUGH")
                {
                    Interlocked.CompareExchange(ref stopReason, "materialShort", "countReached");
                    failures.Add(new FailureRecord(index, ex.Code, ex.Message));
                }
                catch (FissionException ex)
                {
                    failures.Add(new FailureRecord(index, ex.Code, ex.Message));
                    Emit(jobId, index, JobStage.Failed, null, $"[{ex.Code}] 第 {index + 1} 条失败（已回滚素材，批次继续）：{Short(ex.Message)}");
                }
                finally
                {
                    workerGate.Release();
                }
            }, ct));
        }

        await Task.WhenAll(workers).ConfigureAwait(false);
        pool.ReleaseAll();
        swTotal.Stop();

        var report = new JobReport(jobId, outputs.Count, failures.Count, outputs.OrderBy(o => o.Index).ToList(), failures.OrderBy(f => f.Index).ToList(), stopReason, swTotal.ElapsedMilliseconds, pool.Log);
        await File.WriteAllTextAsync(NewOutput(Path.Combine(outRoot, jobId, "report.json")), report.ToJson(), ct).ConfigureAwait(false);
        Emit(jobId, -1, JobStage.Done, 1, $"所有任务全部执行完毕：成功 {outputs.Count} / 失败 {failures.Count} / 停止原因 {stopReason} / 总耗时 {swTotal.ElapsedMilliseconds / 1000.0:F1}s");
        return report;
    }

    private async Task<OutputResult?> ProduceOneAsync(
        FissionJob job, string jobId, int index, MaterialPool pool, ILookup<string, MaterialItem> videoByGroup, GroupSelection sel,
        ConcurrentDictionary<string, Lazy<Task<string>>> normCache, StrongBox<int> normSeq, SemaphoreSlim nvencGate, int encThreads,
        string tmpDir, string coverDir, string outRoot, IReadOnlyDictionary<string, string> voiceSources, RunSourceVersions versions, Func<int> nextAudioCursor, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var workDir = Path.Combine(tmpDir, $"o{index}");
        CreateOwnedDirectory(workDir);
        var rng = new SeededRandom(jobId.GetHashCode() ^ (index * 7919));
        var captured = new DecisionCapture(_files, voiceSources, versions);

        // SELECT：配音 + 画面（预留事务；组合去重/并发同选同一配音 → 自动换下一个重试）
        MaterialItem? audio;
        List<MaterialItem> videos;
        Reservation res;
        for (var attempt = 0; ; attempt++)
        {
            audio = PickAudio(pool, nextAudioCursor);
            if (audio is null)
            {
                throw new MaterialException("MAT_AUDIO_EXHAUSTED", ErrorMessageSource.Get("MAT_AUDIO_EXHAUSTED"));
            }

            var target = job.TargetDurationSec ?? audio.DurationSec;
            videos = PickVideos(job, videoByGroup, target, rng, pool, attempt, sel);

            // 重复抽取组：预留时跳过占用/已用检查（一条预留内允许重复出现）
            var reusable = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var v in videos)
            {
                if (sel.ReusableGroups.Contains(v.Group))
                {
                    reusable.Add(v.Path);
                }
            }

            try
            {
                res = job.AllowVideoReuse ? pool.Reserve(audio, []) : pool.Reserve(audio, videos, 1, reusable);
                if (job.AllowVideoReuse)
                {
                    res = res with { Videos = videos }; // 复用模式：仅记流水
                }

                break;
            }
            catch (MaterialException ex) when (ex.Code is "MAT_COMBINATION_DUP" && attempt < 3)
            {
                continue; // 换一组画面重试
            }
            catch (MaterialException ex) when (ex.Code is "MAT_AUDIO_EXHAUSTED" && attempt < 64)
            {
                continue; // 该配音已被并发占走/用尽 → 光标推进换下一个
            }
            catch (MaterialException ex) when (ex.Code is "MAT_VIDEO_NOT_ENOUGH" && attempt < 8)
            {
                continue; // 并发同选画面被先占（不可复用组真实场景）→ 扰动重选
            }
        }

        var targetSec = job.TargetDurationSec ?? audio!.DurationSec;
        var title = NameFor(job, audio, index, rng);
        Emit(jobId, index, JobStage.Selecting, null, $"开始选取第 {index + 1} 批（配音 {Path.GetFileName(audio.Path)} · 画面 {videos.Count} 段 · 目标 {targetSec:F1}s）");

        // NORMALIZE / IMG2VID（视频走跨成片缓存；图片按区间随机时长现场转视频——原版「图片转视频持续时长随机」）
        var normFiles = new List<(MaterialItem Src, string Norm, int Source)>(videos.Count);
        var imgSeq = 0;
        foreach (var v in videos)
        {
            if (v.IsImage)
            {
                var lo = Math.Min(job.ImageDurMinSec, job.ImageDurMaxSec);
                var hi = Math.Max(job.ImageDurMinSec, job.ImageDurMaxSec);
                var dur = Math.Abs(hi - lo) < 0.001 ? lo : rng.Between(lo, hi); // 同数=固定时长
                Emit(jobId, index, JobStage.Normalizing, null, $"图片转视频持续时长随机：{dur:F1}s（{Path.GetFileName(v.Path)}）");
                var source = await captured.SourceAsync(v.Path, "still", dur, ct).ConfigureAwait(false);
                var imgClip = NewOutput(Path.Combine(workDir, $"img{imgSeq++}.mp4"));
                await RunEncodeGuardedAsync(
                    nvenc => (new VideoEngineRequest(_paths.FFmpeg, CommandBuilders.ImageToVideo(v.Path, imgClip, dur, job.OutWidth, job.OutHeight, job.OutFps, nvenc && job.UseNvenc, encThreads), dur), job.UseNvenc && nvenc),
                    nvencGate, jobId, index, ct).ConfigureAwait(false);
                normFiles.Add((v, imgClip, source));
                continue;
            }

            var sourceIndex = await captured.SourceAsync(v.Path, "video", v.DurationSec, ct).ConfigureAwait(false);
            var norm = await normCache.GetOrAddAsync(v.Path, async p =>
            {
                var dst = NewOutput(Path.Combine(NormDir(jobId), $"n{Interlocked.Increment(ref normSeq.Value):D3}.mp4"));
                await RunEncodeGuardedAsync(
                    nvenc => (new VideoEngineRequest(_paths.FFmpeg, FFmpegProvider.BuildNormalizeArgs(p, dst, job.OutWidth, job.OutHeight, job.OutFps, nvenc && job.UseNvenc, hwDecode: false), v.DurationSec), job.UseNvenc && nvenc),
                    nvencGate, jobId, index, ct).ConfigureAwait(false);
                return dst;
            }).ConfigureAwait(false);
            normFiles.Add((v, norm, sourceIndex));
        }

        // SPLIT → 切段（hflip 差异化随切做，省一遍编码）
        Emit(jobId, index, JobStage.Splitting, null, $"开始分割（{job.SplitMode}）");
        var cutFiles = new List<string>();
        var detector = new SceneDetector(_paths, _engine);
        foreach (var (src, norm, sourceIndex) in normFiles)
        {
            // 组变速（原版网格列；下限 0.5——低于即舍弃该文件，原版报错原文）
            var speed = sel.Configs.TryGetValue(src.Group, out var cfg) ? cfg.Speed : 1.0;
            if (speed < 0.5)
            {
                Emit(jobId, index, JobStage.Splitting, null, $"[{src.Group}] {Path.GetFileName(src.Path)} 变速 {speed:0.##}× 失败！原因：低于变速最低0.5范围，舍弃该文件");
                continue;
            }

            var normInfo = await _probe.ProbeAsync(norm, ct).ConfigureAwait(false);
            var cuts = job.SplitMode switch
            {
                SplitMode.Scene => src.IsImage
                    ? [new CutSpan(0, normInfo.DurationSec)] // 静图无镜头差分，整段即一片
                    : await detector.DetectAsync(norm, normInfo.DurationSec, job.SceneThreshold, 0.8, 6.0, ct).ConfigureAwait(false),
                SplitMode.AveragePieces => SplitPlanner.AveragePieces(normInfo.DurationSec, job.AvgPieces),
                SplitMode.BySeconds => SplitPlanner.BySeconds(normInfo.DurationSec, job.BySeconds),
                SplitMode.RandomRange => SplitPlanner.RandomRange(normInfo.DurationSec, job.RandomMinSec, job.RandomMaxSec, rng),
                SplitMode.None => [new CutSpan(0, normInfo.DurationSec)],
                _ => SplitPlanner.AveragePieces(normInfo.DurationSec, job.AvgPieces),
            };

            foreach (var cut in cuts)
            {
                var dst = NewOutput(Path.Combine(workDir, $"c{cutFiles.Count:D3}.mp4"));
                var flip = job.RandomHFlip && rng.CoinFlip(0.35);
                var decision = new VisualDecision(sourceIndex, "main", src.Group, cut.StartSec, cut.DurationSec, speed, flip);
                captured.Visuals.Add(decision);
                await RunEncodeGuardedAsync(
                    nvenc => (new VideoEngineRequest(_paths.FFmpeg, CommandBuilders.Cut(norm, dst, new CutSpan(decision.StartSec, decision.DurationSec), decision.Hflip, nvenc && job.UseNvenc, encThreads, decision.Speed), decision.DurationSec / decision.Speed), job.UseNvenc && nvenc),
                    nvencGate, jobId, index, ct).ConfigureAwait(false);
                cutFiles.Add(dst);
            }
        }

        if (cutFiles.Count == 0)
        {
            pool.Release(res);
            throw new MaterialException("MAT_VIDEO_NOT_ENOUGH", ErrorMessageSource.Get("MAT_VIDEO_NOT_ENOUGH"));
        }

        // 片头/片尾（FR-5.5：随机剪取开头区间 2.5–4s 拼入首/尾；音轨在 AV_MERGE 阶段整体替换=「音频覆盖片头片尾」语义）
        await AttachIntroOutroAsync(job, jobId, workDir, cutFiles, normCache, normSeq, nvencGate, rng, captured, ct).ConfigureAwait(false);

        Emit(jobId, index, JobStage.Splitting, 1, $"分析得出总镜头数：{cutFiles.Count}，个镜头片段");

        // ASSEMBLE：转场链（ffmpeg6 gltransition·66 GLSL）或统一规格 concat copy
        var transition = new TransitionDecision(job.TransitionName, job.TransitionSec, null, null, "none");
        var assembled = NewOutput(Path.Combine(workDir, "assembled.mp4"));
        if (job.TransitionSec > 0 && cutFiles.Count >= 2)
        {
            var (glsl, tname, fellBack) = TransitionCatalog.Resolve(_paths.TransitionsDir, job.TransitionName, rng);
            if (fellBack)
            {
                Emit(jobId, index, JobStage.Assembling, null, $"转场 [{job.TransitionName}] 不存在，回落 {tname}");
            }

            transition = new TransitionDecision(job.TransitionName, job.TransitionSec, tname,
                await captured.ShaderAsync(glsl, ct).ConfigureAwait(false), "applied");
            Emit(jobId, index, JobStage.Assembling, null, $"开始加转场合成所有片段（{tname} {transition.DurationSec:0.##}s × {cutFiles.Count - 1} 处）");
            try
            {
                // 入片转场（实测语义：gltransition 输出=第二输入时长）——每段开头从上一段尾渐变，之后 concat 精确拼接
                var segs = new List<string>(cutFiles.Count) { cutFiles[0] };
                for (var i = 1; i < cutFiles.Count; i++)
                {
                    var tail = NewOutput(Path.Combine(workDir, $"tail{i:D2}.mp4"));
                    await _engine.RunAsync(new VideoEngineRequest(_paths.FFmpeg, CommandBuilders.TakeTail(segs[^1], tail, transition.DurationSec), transition.DurationSec * 3), ct: ct).ConfigureAwait(false);
                    var segIn = NewOutput(Path.Combine(workDir, $"s{i:D2}.mp4"));
                    await _engine.RunAsync(new VideoEngineRequest(_paths.FFmpeg6, CommandBuilders.EntryTransition(tail, cutFiles[i], segIn, transition.DurationSec, transition.Shader?.Path ?? glsl), Math.Max(targetSec, 20)), ct: ct).ConfigureAwait(false);
                    TryDeleteFile(tail);
                    segs.Add(segIn);
                }

                await _engine.RunAsync(new VideoEngineRequest(_paths.FFmpeg, BuildConcat(segs, assembled)), ct: ct).ConfigureAwait(false);
            }
            catch (EngineException)
            {
                transition = transition with { Outcome = "fallback-no-transition" };
                Emit(jobId, index, JobStage.Assembling, null, ErrorMessageSource.Get("RUN_TRANSITION_FALLBACK"));
                // Concat writes its list before codec execution. Preserve that list and any
                // partial failed output; controlled fallback must use a fresh owned pair.
                if (_files is not null) assembled = NewOutput(Path.Combine(workDir, "assembled-fallback.mp4"));
                await _engine.RunAsync(new VideoEngineRequest(_paths.FFmpeg, BuildConcat(cutFiles, assembled)), ct: ct).ConfigureAwait(false);
            }
        }
        else
        {
            await _engine.RunAsync(new VideoEngineRequest(_paths.FFmpeg, BuildConcat(cutFiles, assembled)), ct: ct).ConfigureAwait(false);
        }

        var assembledInfo = await _probe.ProbeAsync(assembled, ct).ConfigureAwait(false);

        // ALLOCATE：八策略对齐
        Emit(jobId, index, JobStage.Allocating, null, $"时长对齐：画面 {assembledInfo.DurationSec:F1}s → 目标 {targetSec:F1}s（策略 {(int)job.Align}）");
        var plan = AlignPlanner.Plan((int)job.Align, assembledInfo.DurationSec, targetSec);
        var alignment = new AlignmentDecision(plan.Action.ToString().ToLowerInvariant(), assembledInfo.DurationSec,
            plan.OutDurationSec, plan.Tempo, plan.Loops);
        plan = plan with { OutDurationSec = alignment.OutputDurationSec, Tempo = alignment.Tempo, Loops = alignment.Loops };
        var aligned = NewOutput(Path.Combine(workDir, "aligned.mp4"));
        if (Math.Abs(assembledInfo.DurationSec - targetSec) > AlignPlanner.FrameToleranceSec(job.OutFps) || plan.Action != AlignAction.Trim)
        {
            await RunEncodeGuardedAsync(
                nvenc => (new VideoEngineRequest(_paths.FFmpeg, CommandBuilders.Align(assembled, aligned, plan, nvenc && job.UseNvenc, encThreads), plan.OutDurationSec), job.UseNvenc && nvenc),
                nvencGate, jobId, index, ct).ConfigureAwait(false);
        }
        else
        {
            aligned = assembled; // 已在容差内且无需动作
        }

        // AV_MERGE：配音 + 可选 BGM
        Emit(jobId, index, JobStage.AvMerging, null, "音频正在合成");
        var bgm = PickBgm(job, rng);
        var voiceSource = await captured.SourceAsync(audio!.Path, "sound", audio.DurationSec, ct).ConfigureAwait(false);
        var musicSource = -1;
        if (bgm is not null && _files is not null)
        {
            await captured.PinAsync(bgm, ct).ConfigureAwait(false);
            var musicInfo = await _probe.ProbeAsync(bgm, ct).ConfigureAwait(false);
            musicSource = await captured.SourceAsync(bgm, "sound", musicInfo.DurationSec, ct).ConfigureAwait(false);
        }
        var audioDecision = new AudioDecision(new AudioTrackDecision(voiceSource, job.VoiceVolume),
            bgm is null ? null : new AudioTrackDecision(musicSource, job.BgmVolume, true), new LoudnormDecision());
        var mixJob = new FissionJob { VoiceVolume = audioDecision.Voice.Volume, BgmVolume = audioDecision.Music?.Volume ?? 0 };
        var finalName = FileNameSanitizer.Sanitize(title) + ".mp4";
        var finalTmp = NewOutput(Path.Combine(workDir, finalName));
        await _engine.RunAsync(new VideoEngineRequest(_paths.FFmpeg, CommandBuilders.AvMerge(aligned, audio!.Path, bgm, finalTmp, mixJob), targetSec), ct: ct).ConfigureAwait(false);

        // SUBTITLE：口播文案烧录（文本取配音目录 meta.json 的 items[].text——AIGC 链自带）
        var subtitle = new SubtitleDecision(job.SubtitleEnabled, job.SubtitleEnabled ? "missing-text" : "disabled",
            "sentence-weighted-approximation", Array.Empty<SubtitleCue>(), null);
        if (job.SubtitleEnabled)
        {
            var scriptText = FindScriptText(job, audio);
            if (scriptText is null)
            {
                Emit(jobId, index, JobStage.AvMerging, null, "未找到文案文本（配音目录无 meta.json），本条跳过字幕");
            }
            else
            {
                Emit(jobId, index, JobStage.AvMerging, null, "正在添加字幕");
                subtitle = new SubtitleDecision(true, "applied", "sentence-weighted-approximation",
                    SubtitlePlanner.BuildCues(scriptText, targetSec), new SubtitleStyleDecision(job.SubtitleStyle,
                        job.SubtitlePos, job.SubtitleFontSize, SubtitlePlanner.StyleLine(job.SubtitleStyle, job.SubtitlePos, job.SubtitleFontSize)));
                var ass = NewOutput(Path.Combine(workDir, "sub.ass"));
                await File.WriteAllTextAsync(ass, SubtitlePlanner.BuildAss(subtitle.Cues, subtitle.Style!.Preset, subtitle.Style.Position, subtitle.Style.FontSize), new System.Text.UTF8Encoding(false), ct).ConfigureAwait(false);
                var subTmp = NewOutput(Path.Combine(workDir, "subbed.mp4"));
                await RunEncodeGuardedAsync(
                    nvenc => (new VideoEngineRequest(_paths.FFmpeg, CommandBuilders.BurnSubtitle(finalTmp, subTmp, ass, nvenc && job.UseNvenc, encThreads, Environment.GetFolderPath(Environment.SpecialFolder.Fonts)), targetSec), job.UseNvenc && nvenc),
                    nvencGate, jobId, index, ct).ConfigureAwait(false);
                finalTmp = subTmp;
                Emit(jobId, index, JobStage.AvMerging, 1, "字幕添加完毕");
            }
        }

        // EXPORT：移动到输出目录（Uniquify 防重名）
        var outPath = FileNameSanitizer.Uniquify(Path.Combine(outRoot, jobId, finalName));
        _files?.ValidateOwnedFile(finalTmp);
        NewOutput(outPath);
        File.Move(finalTmp, outPath);
        Emit(jobId, index, JobStage.AvMerging, 1, "音频合成完毕");

        // COVER（最后加；失败回退不判失败）
        var cover = NewOutput(Path.ChangeExtension(outPath, ".jpg"));
        try
        {
            await _engine.RunAsync(new VideoEngineRequest(_paths.FFmpeg, CommandBuilders.Cover(outPath, cover, job.CoverAtSec)), ct: ct).ConfigureAwait(false);
        }
        catch (EngineException)
        {
            Emit(jobId, index, JobStage.Covering, null, ErrorMessageSource.Get("RUN_COVER_FALLBACK"));
        }

        // CONSUME：确认消耗（计次/删；「用过是否删除=是」且未开重复抽取的组 → 视频转 Consumed 落跨批次缓存）
        var finalInfo = await _probe.ProbeAsync(outPath, ct).ConfigureAwait(false);
        var consumeVideos = new List<string>();
        foreach (var v in videos)
        {
            if (sel.Configs.TryGetValue(v.Group, out var cfg) && cfg is { UseThenDelete: true, AllowReuse: false })
            {
                consumeVideos.Add(v.Path);
            }
        }

        pool.Confirm(res, Path.GetFileName(outPath), consumeVideos);
        if (consumeVideos.Count > 0)
        {
            Emit(jobId, index, JobStage.Consuming, null, $"用过的素材正在删除（{consumeVideos.Count} 个入跨批次缓存，后续批次不再选取）");
        }

        if (audio is not null && job.AudioUses == 1)
        {
            Emit(jobId, index, JobStage.Consuming, null, "用过的音频正在删除");
            if (_files is not null)
            {
                var archived = _files.ArchiveAudio(audio.Path);
                captured.ArchivedGenerated(audio.Path, archived);
            }
            else TryArchiveAudio(audio.Path);
        }


        string? editPlanPath = null;
        if (_files is not null)
        {
            var editPlan = new FissionEditPlan(1, jobId, index, new FissionStage(job.OutWidth, job.OutHeight), job.OutFps,
                finalInfo.DurationSec, captured.Sources.AsReadOnly(), captured.Visuals.AsReadOnly(), alignment,
                audioDecision, transition, subtitle);
            editPlanPath = NewOutput(Path.ChangeExtension(outPath, ".edit-plan.json"));
            await File.WriteAllTextAsync(editPlanPath, editPlan.ToJson(), ct).ConfigureAwait(false);
        }
        sw.Stop();
        Emit(jobId, index, JobStage.Done, 1, $"第 {index + 1} 条完成：{Path.GetFileName(outPath)} {finalInfo.DurationSec:F1}s（{sw.ElapsedMilliseconds / 1000.0:F1}s）");
        return new OutputResult(index, outPath, finalInfo.DurationSec, title, sw.ElapsedMilliseconds) { EditPlanPath = editPlanPath };
    }

    /// <summary>片头/片尾拼装（FR-5.5）：目录有素材才启用；随机抽文件、随机剪取开头 2.5–4s，归一化走任务级缓存。</summary>
    private async Task AttachIntroOutroAsync(
        FissionJob job, string jobId, string workDir, List<string> cutFiles,
        ConcurrentDictionary<string, Lazy<Task<string>>> normCache, StrongBox<int> normSeq, SemaphoreSlim nvencGate, SeededRandom rng, DecisionCapture captured, CancellationToken ct)
    {
        foreach (var (dir, isIntro) in new[] { (job.IntroDir, true), (job.OutroDir, false) })
        {
            if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir))
            {
                continue;
            }

            var candidates = Directory.EnumerateFiles(dir, "*.*", SearchOption.TopDirectoryOnly)
                .Where(f => VideoExt.Contains(Path.GetExtension(f).ToLowerInvariant())).ToList();
            if (candidates.Count == 0)
            {
                continue;
            }

            var pick = candidates[rng.Next(candidates.Count)];
            await captured.PinAsync(pick, ct).ConfigureAwait(false);
            var info = await _probe.ProbeAsync(pick, ct).ConfigureAwait(false);
            var norm = await normCache.GetOrAddAsync(pick, async p =>
            {
                var dst = NewOutput(Path.Combine(NormDir(jobId), $"n{Interlocked.Increment(ref normSeq.Value):D3}.mp4"));
                await RunEncodeGuardedAsync(
                    nvenc => (new VideoEngineRequest(_paths.FFmpeg, FFmpegProvider.BuildNormalizeArgs(p, dst, job.OutWidth, job.OutHeight, job.OutFps, nvenc && job.UseNvenc, hwDecode: false), info.DurationSec), job.UseNvenc && nvenc),
                    nvencGate, jobId, 0, ct).ConfigureAwait(false);
                return dst;
            }).ConfigureAwait(false);

            var take = Math.Min(rng.Between(2.5, 4.0), info.DurationSec);
            var sourceIndex = await captured.SourceAsync(pick, "video", info.DurationSec, ct).ConfigureAwait(false);
            var decision = new VisualDecision(sourceIndex, isIntro ? "intro" : "outro", "", 0, take, 1, false);
            var dstCut = NewOutput(Path.Combine(workDir, isIntro ? "intro.mp4" : "outro.mp4"));
            await RunEncodeGuardedAsync(
                nvenc => (new VideoEngineRequest(_paths.FFmpeg, CommandBuilders.Cut(norm, dstCut, new CutSpan(decision.StartSec, decision.DurationSec), decision.Hflip, nvenc && job.UseNvenc, 2, decision.Speed), decision.DurationSec), job.UseNvenc && nvenc),
                nvencGate, jobId, 0, ct).ConfigureAwait(false);
            if (isIntro)
            {
                cutFiles.Insert(0, dstCut);
                captured.Visuals.Insert(0, decision);
            }
            else
            {
                cutFiles.Add(dstCut);
                captured.Visuals.Add(decision);
            }
        }
    }

    private async Task<MaterialPool> BuildPoolAsync(FissionJob job, string voiceDir, Dictionary<string, string> voiceSources, RunSourceVersions versions, CancellationToken ct)
    {
        var items = new ConcurrentBag<MaterialItem>();
        var skips = new ConcurrentBag<string>();

        var videoFiles = EnumerateByExt(job.VideoDir, VideoExt, recursive: false).ToList();
        var imageFiles = EnumerateByExt(job.VideoDir, ImageExt, recursive: false).ToList();
        var subDirs = Directory.EnumerateDirectories(job.VideoDir).OrderBy(NumberPrefix).ToList();
        var all = new List<(string Path, string Group, bool IsImage)>();
        if (subDirs.Count > 0)
        {
            foreach (var d in subDirs)
            {
                var g = Path.GetFileName(d);
                all.AddRange(EnumerateByExt(d, VideoExt, false).Select(f => (f, g, false)));
                all.AddRange(EnumerateByExt(d, ImageExt, false).Select(f => (f, g, true)));
            }
        }

        all.AddRange(videoFiles.Select(f => (f, string.Empty, false)));
        all.AddRange(imageFiles.Select(f => (f, string.Empty, true)));
        if (all.Count == 0)
        {
            throw new MaterialException("MAT_VIDEO_DIR_EMPTY", ErrorMessageSource.Get("MAT_VIDEO_DIR_EMPTY"));
        }

        await Parallel.ForEachAsync(all, new ParallelOptions { CancellationToken = ct, MaxDegreeOfParallelism = 8 }, async (vf, token) =>
        {
            await versions.PinAsync(vf.Path, token).ConfigureAwait(false);
            if (vf.IsImage)
            {
                items.Add(new MaterialItem(vf.Path, vf.Group, 0, IsImage: true)); // 无需 probe；时长在 IMG2VID 随机定
                return;
            }

            try
            {
                var info = await _probe.ProbeAsync(vf.Path, token).ConfigureAwait(false);
                items.Add(new MaterialItem(vf.Path, vf.Group, info.DurationSec));
            }
            catch (MaterialException)
            {
                skips.Add(vf.Path);
            }
        }).ConfigureAwait(false);

        foreach (var s in skips)
        {
            Emit("-", -1, JobStage.Validating, null, $"{ErrorMessageSource.Get("MAT_CORRUPT_FILE_PREFIX")}{s}（跳过）");
        }

        // 配音：目录 or 离线合成
        var audioItems = new List<MaterialItem>();
        if (job.AudioDir is not null)
        {
            var audioFiles = EnumerateByExt(job.AudioDir, AudioExt, false).Order().ToList();
            if (audioFiles.Count == 0)
            {
                throw new MaterialException("MAT_AUDIO_DIR_EMPTY", ErrorMessageSource.Get("MAT_AUDIO_DIR_EMPTY"));
            }

            foreach (var f in audioFiles)
            {
                await versions.PinAsync(f, ct).ConfigureAwait(false);
                var staged = _files is null ? f : await _files.CopyAudioAsync(f, voiceDir, ct).ConfigureAwait(false);
                voiceSources.Add(staged, f);
                var info = await _probe.ProbeAsync(staged, ct).ConfigureAwait(false);
                audioItems.Add(new MaterialItem(staged, string.Empty, info.DurationSec));
            }
        }
        else
        {
            for (var i = 0; i < job.GeneratedAudioCount; i++)
            {
                var dst = Path.Combine(voiceDir, $"gen_{i + 1:D3}.mp3");
                _files?.PrepareGeneratedAudio(dst);
                await _engine.RunAsync(new VideoEngineRequest(_paths.FFmpeg, CommandBuilders.MakeVoice(dst, job.GeneratedAudioDurationSec, 180 + (i % 5) * 60), job.GeneratedAudioDurationSec), ct: ct).ConfigureAwait(false);
                _files?.RegisterGeneratedAudio(dst);
                await versions.PinAsync(dst, ct).ConfigureAwait(false);
                audioItems.Add(new MaterialItem(dst, string.Empty, job.GeneratedAudioDurationSec));
            }
        }

        var cacheIni = NewOutput(Path.Combine(_policy?.CacheRoot ?? _paths.WorkRoot, "多场景素材缓存.ini"));
        var pool = new MaterialPool(items.Concat(audioItems), cacheIni);
        foreach (var a in audioItems)
        {
            pool.SetAudioUses(a.Path, job.AudioUses);
        }

        return pool;
    }

    /// <summary>场景组选择上下文（任务级共享：启用配置 / 顺序游标 / 可复用组名集）。</summary>
    private sealed record GroupSelection(
        IReadOnlyDictionary<string, SceneGroupConfig> Configs,
        ConcurrentDictionary<string, StrongBox<int>> Cursor)
    {
        /// <summary>重复抽取=是 的组名（预留跳过占用检查；与配置字典同比较器）。</summary>
        public HashSet<string> ReusableGroups { get; } = new(Configs.Values.Where(c => c.AllowReuse).Select(c => c.Name), StringComparer.OrdinalIgnoreCase);
    }

    private static MaterialItem? PickAudio(MaterialPool pool, Func<int> cursor)
    {
        var list = pool.AudioList();
        if (list.Count == 0)
        {
            return null;
        }

        return list[Math.Abs(cursor()) % list.Count];
    }

    private static List<MaterialItem> PickVideos(FissionJob job, ILookup<string, MaterialItem> byGroup, double targetSec, SeededRandom rng, MaterialPool pool, int attempt, GroupSelection sel)
    {
        var picked = new List<MaterialItem>();
        var acc = 0.0;
        var configs = sel.Configs;

        var groups = byGroup.Where(g => g.Key.Length > 0).Select(g => g.Key)
            .OrderBy(NumberPrefix) // 叙事序 = 子文件夹数字前缀（枚举序不可靠，实测教训）
            .ThenBy(g => g, StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (job.Pick == PickRule.SceneOrderRandomWithin && groups.Count > 0)
        {
            foreach (var g in groups)
            {
                if (configs.Count > 0 && !configs.ContainsKey(g))
                {
                    continue; // 板块里未启用/未列出的组不参与
                }

                _ = configs.TryGetValue(g, out var cfg);
                var allowReuse = (cfg is { AllowReuse: true }) || job.AllowVideoReuse;
                var avail = byGroup[g].Where(v => allowReuse || pool.IsAvailable(v.Path)).ToList();
                if (avail.Count == 0)
                {
                    continue;
                }

                // 每组抽取数：显式 TakePerOutput（≥1）优先且必抽满；0=按时长动态补足（85% 即停，不回跳已跳过的动态组）
                var take = cfg is { TakePerOutput: >= 1 } ? cfg.TakePerOutput : int.MaxValue;
                if (take == int.MaxValue && acc >= targetSec * 0.85)
                {
                    continue; // 动态组达标后跳过；显式抽取组不受时长累计影响（实测教训：外层 break 会吞掉后续显式组）
                }

                var taken = 0;
                if (cfg is { Rule: GroupRule.Sequential })
                {
                    // 顺序或随机=顺序：文件名序，原子游标跨成片推进，组内耗尽循环
                    var ordered = avail.OrderBy(v => v.Path, StringComparer.OrdinalIgnoreCase).ToList();
                    var box = sel.Cursor.GetOrAdd(g, _ => new StrongBox<int>(0));
                    var start = Interlocked.Increment(ref box.Value) - 1;
                    for (var k = 0; k < ordered.Count && taken < take; k++)
                    {
                        var v = ordered[(start + k) % ordered.Count];
                        if (picked.Contains(v))
                        {
                            continue; // 同一条成片内不重复（组合差异化交给组合去重）
                        }

                        picked.Add(v);
                        taken++;
                        acc += v.DurationSec;
                        if (take == int.MaxValue && acc >= targetSec * 0.85)
                        {
                            break;
                        }
                    }
                }
                else
                {
                    while (taken < take && avail.Count > 0)
                    {
                        var v = avail[rng.Next(avail.Count)];
                        avail.Remove(v);
                        picked.Add(v);
                        taken++;
                        acc += v.DurationSec;
                        if (take == int.MaxValue && acc >= targetSec * 0.85)
                        {
                            break;
                        }
                    }
                }
            }
        }
        else
        {
            // 非场景序模式：场景组配置存在时仅从启用组取（根目录散文件仅无配置时参与）
            var availAll = byGroup.SelectMany(g => g)
                .Where(v => configs.Count == 0 || configs.ContainsKey(v.Group))
                .Where(v => sel.ReusableGroups.Contains(v.Group) || job.AllowVideoReuse || pool.IsAvailable(v.Path)).ToList();
            if (job.Pick == PickRule.Sequential)
            {
                foreach (var v in availAll)
                {
                    picked.Add(v);
                    acc += v.DurationSec;
                    if (acc >= targetSec * 0.85)
                    {
                        break;
                    }
                }
            }
            else
            {
                for (var tries = 0; tries < availAll.Count && acc < targetSec * 0.85; tries++)
                {
                    var v = availAll[rng.Next(availAll.Count)];
                    if (picked.Contains(v))
                    {
                        continue;
                    }

                    picked.Add(v);
                    acc += v.DurationSec;
                }
            }
        }

        if (picked.Count == 0)
        {
            throw new MaterialException("MAT_VIDEO_NOT_ENOUGH", ErrorMessageSource.Get("MAT_VIDEO_NOT_ENOUGH"));
        }

        // 组合去重碰撞时的扰动：旋转一位
        if (attempt > 0 && picked.Count > 1)
        {
            picked = [.. picked.Skip(1), picked[0]];
        }

        return picked;
    }

    /// <summary>取口播文案文本：配音目录上级的 meta.json（AIGC 生成时带 items[].text）。</summary>
    private string? FindScriptText(FissionJob job, MaterialItem? audio)
    {
        if (audio is null || string.IsNullOrWhiteSpace(job.AudioDir))
        {
            return null;
        }

        var metaPath = Path.Combine(Directory.GetParent(job.AudioDir.TrimEnd(Path.DirectorySeparatorChar))?.FullName ?? string.Empty, "meta.json");
        _files?.ValidateOptionalReadOnlyFile(metaPath);
        if (!File.Exists(metaPath))
        {
            return null;
        }

        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(metaPath));
            var name = Path.GetFileName(audio.Path);
            foreach (var it in doc.RootElement.GetProperty("items").EnumerateArray())
            {
                if (it.TryGetProperty("file", out var f) && f.GetString() == name && it.TryGetProperty("text", out var t))
                {
                    return t.GetString();
                }
            }
        }
        catch (System.Text.Json.JsonException)
        {
            // meta 损坏=无字幕，不阻断
        }

        return null;
    }


    // Pin before the first actual probe/copy/normalize. The existing per-run norm
    // cache and every output then refer to the SAME held original version, rather
    // than rehashing a changed path after a private copy or cached normalization.
    private sealed class RunSourceVersions(EnginePathPolicy? policy, EngineJobFiles? files) : IDisposable
    {
        private readonly ConcurrentDictionary<string, Lazy<Task<string>>> versions = new(StringComparer.Ordinal);
        private readonly List<FileStream> handles = [];
        private readonly object gate = new();
        private bool stopped;
        public Task<string> PinAsync(string source, CancellationToken ct)
        {
            lock (gate) ObjectDisposedException.ThrowIf(stopped, this);
            if (files is null || policy is null) return Task.FromResult(string.Empty);
            return versions.GetOrAdd(source, key => new Lazy<Task<string>>(() => ReadAsync(key, ct), true)).Value;
        }
        private async Task<string> ReadAsync(string source, CancellationToken ct)
        {
            var generated = source.StartsWith(policy!.Paths.WorkRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal);
            if (generated) files!.ValidateOwnedFile(source); else files!.ValidateReadOnlyFile(source);
            var stream = new FileStream(source, FileMode.Open, FileAccess.Read,
                generated ? FileShare.Read | FileShare.Delete : FileShare.Read, 81920, FileOptions.Asynchronous | FileOptions.SequentialScan);
            lock (gate)
            {
                if (stopped) { stream.Dispose(); throw new ObjectDisposedException(nameof(RunSourceVersions)); }
                handles.Add(stream);
            }
            return Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, ct).ConfigureAwait(false));
        }
        public void Dispose()
        {
            lock (gate)
            {
                if (stopped) return;
                stopped = true;
                foreach (var handle in handles) handle.Dispose();
            }
        }
    }

    private sealed class DecisionCapture(EngineJobFiles? files, IReadOnlyDictionary<string, string> voiceSources, RunSourceVersions versions)
    {
        private readonly Dictionary<string, int> indexes = new(StringComparer.Ordinal);
        public List<FissionSource> Sources { get; } = [];
        public List<VisualDecision> Visuals { get; } = [];
        public Task<string> PinAsync(string file, CancellationToken ct) => versions.PinAsync(file, ct);
        public async Task<int> SourceAsync(string usedPath, string kind, double durationSec, CancellationToken ct)
        {
            if (files is null) return -1;
            var source = voiceSources.TryGetValue(usedPath, out var original) ? original : usedPath;
            if (indexes.TryGetValue(source, out var existing)) return existing;
            var hash = await versions.PinAsync(source, ct).ConfigureAwait(false);
            var index = Sources.Count; Sources.Add(new FissionSource(source, hash, kind, durationSec)); indexes.Add(source, index);
            return index;
        }
        public async Task<ShaderDecision?> ShaderAsync(string file, CancellationToken ct)
            => files is null ? null : new ShaderDecision(file, await versions.PinAsync(file, ct).ConfigureAwait(false));
        public void ArchivedGenerated(string from, string to)
        {
            if (!voiceSources.ContainsKey(from) && indexes.TryGetValue(from, out var index)) Sources[index] = Sources[index] with { Path = to };
        }
    }

    private static string? PickBgm(FissionJob job, SeededRandom rng)
    {
        if (job.BgmDir is null || !Directory.Exists(job.BgmDir) || job.BgmVolume <= 0)
        {
            return null;
        }

        var files = EnumerateByExt(job.BgmDir, AudioExt, false).ToList();
        return files.Count == 0 ? null : files[rng.Next(files.Count)];
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException)
        {
            // 删除失败不阻断（work 目录任务后整体可清）
        }
    }

    private static void TryArchiveAudio(string path)
    {
        try
        {
            var consumed = Path.Combine(Path.GetDirectoryName(path)!, "_consumed");
            Directory.CreateDirectory(consumed);
            File.Move(path, Path.Combine(consumed, Path.GetFileName(path)));
        }
        catch (IOException)
        {
            // 移动失败不阻断（默认策略=移动而非删除，PRD FR-6.4 安全语义）
        }
    }

    private static string NameFor(FissionJob job, MaterialItem? audio, int index, SeededRandom rng)
    {
        switch (job.Naming)
        {
            case NamingRule.AudioFileName:
                var stem = audio is null ? $"gen_{index + 1:D3}" : Path.GetFileNameWithoutExtension(audio.Path);
                return FileNameSanitizer.Sanitize(stem);
            case NamingRule.Sequence:
                return $"{index + 1:D3}";
            default:
                return TitlePool[rng.Next(TitlePool.Length)];
        }
    }

    private static readonly string[] TitlePool =
    [
        "这个方法太绝了", "行家都这样选", "老师傅的手艺", "一看就懂的做法", "行内人才知道",
        "老手艺新玩法", "行家教你一招", "这个细节很关键", "行内标准做法", "值得收藏的做法",
    ];

    private string NewOutput(string path) => _files?.ValidateNewOutput(path) ?? path;

    private void CreateOwnedDirectory(string path)
    {
        if (_files is not null) _files.CreateDirectory(path);
        else Directory.CreateDirectory(path);
    }

    private string BuildConcat(IReadOnlyList<string> inputs, string output)
    {
        NewOutput(output);
        NewOutput(Path.ChangeExtension(output, ".txt"));
        return CommandBuilders.Concat(inputs, output);
    }

    private string NormDir(string jobId) => Path.Combine(_paths.WorkRoot, jobId, "norm");

    private static IEnumerable<string> EnumerateByExt(string dir, string[] exts, bool recursive)
    {
        if (!Directory.Exists(dir))
        {
            return [];
        }

        var opts = recursive ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly;
        return Directory.EnumerateFiles(dir, "*.*", opts).Where(f => exts.Contains(Path.GetExtension(f).ToLowerInvariant()));
    }

    private static int NumberPrefix(string dirName)
    {
        var digits = new string(dirName.TakeWhile(char.IsDigit).ToArray());
        return int.TryParse(digits, out var n) ? n : int.MaxValue;
    }

    private static string Short(string msg) => msg.Length > 160 ? msg[..160] + "…" : msg;

    private static async Task<IDisposable> AcquireAsync(SemaphoreSlim sem)
    {
        await sem.WaitAsync().ConfigureAwait(false);
        return new Releaser(sem);
    }

    /// <summary>
    /// 带闸门与回退的编码执行：nvenc 会话获取失败（OpenEncodeSessionEx OOM / No capable devices，
    /// R9 实测）或编码初始化失败时，出闸门自动降级 libx264 重试一次（PRD §12.5 ENC-001）。
    /// </summary>
    /// <param name="build">入参=是否尝试 nvenc，出参=(请求, 本轮是否真用 nvenc)。</param>
    /// <param name="gate">nvenc 会话闸门。</param>
    /// <param name="jobId">事件归属。</param>
    /// <param name="index">成片序号。</param>
    /// <param name="ct">取消。</param>
    private async Task RunEncodeGuardedAsync(Func<bool, (VideoEngineRequest Request, bool UseNvenc)> build, SemaphoreSlim gate, string jobId, int index, CancellationToken ct)
    {
        var (req, useNvenc) = build(true);
        if (!useNvenc)
        {
            await _engine.RunAsync(req, ct: ct).ConfigureAwait(false);
            return;
        }

        using (var _ = await AcquireAsync(gate).ConfigureAwait(false))
        {
            try
            {
                await _engine.RunAsync(req, ct: ct).ConfigureAwait(false);
                return;
            }
            catch (EngineException ex) when (IsNvencSessionFailure(ex))
            {
                Emit(jobId, index, JobStage.Normalizing, null, "nvenc 会话不可用（显存/会话上限），本段自动回退 x264");
            }
        }

        var (fallback, _) = build(false);
        await _engine.RunAsync(fallback, ct: ct).ConfigureAwait(false);
    }

    private static bool IsNvencSessionFailure(EngineException ex) =>
        ex.Message.Contains("OpenEncodeSessionEx", StringComparison.Ordinal) ||
        ex.Message.Contains("No capable devices found", StringComparison.Ordinal) ||
        ex.Message.Contains("InitializeEncoder failed", StringComparison.Ordinal);

    private sealed class Releaser(SemaphoreSlim sem) : IDisposable
    {
        public void Dispose() => sem.Release();
    }

    private void Emit(string jobId, int index, JobStage stage, double? progress, string detail) =>
        _bus?.Emit(new JobEvent(jobId, index, stage, progress, detail, Environment.TickCount64));
}

/// <summary>MaterialPool 查询扩展（引擎用）。</summary>
public static class MaterialPoolEngineExtensions
{
    /// <summary>视频按场景组索引。</summary>
    public static ILookup<string, MaterialItem> VideosByGroup(this MaterialPool pool) => pool.ListVideos().ToLookup(v => v.Group);

    /// <summary>视频清单。</summary>
    public static IReadOnlyList<MaterialItem> ListVideos(this MaterialPool pool) => pool.List(false);

    /// <summary>配音清单。</summary>
    public static IReadOnlyList<MaterialItem> AudioList(this MaterialPool pool) => pool.List(true);

    /// <summary>是否仍可选取（未消耗且未占满）。</summary>
    public static bool IsAvailable(this MaterialPool pool, string path) => pool.CheckAvailable(path);
}

/// <summary>ConcurrentDictionary 异步 GetOrAdd（归一化缓存：同源跨成片并发只编一次）。
/// Lazy&lt;Task&gt; 记忆化保证同键工厂只执行一次——防止并发双写同一产物文件（压测教训：双 ffmpeg 写同文件 → NAL 损坏）。</summary>
file static class ConcurrentDictionaryExt
{
    public static Task<TValue> GetOrAddAsync<TKey, TValue>(
        this ConcurrentDictionary<TKey, Lazy<Task<TValue>>> dict, TKey key, Func<TKey, Task<TValue>> factory)
        where TKey : notnull
        => dict.GetOrAdd(key, k => new Lazy<Task<TValue>>(() => factory(k), LazyThreadSafetyMode.ExecutionAndPublication)).Value;
}
