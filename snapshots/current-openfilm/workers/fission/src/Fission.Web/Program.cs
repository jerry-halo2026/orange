using System.Collections.Concurrent;
using System.Runtime.Versioning;
using System.Text.Json;
using Fission.AI;
using Fission.Core.Abstractions;
using Fission.Core.Engine;
using Fission.Core.Jobs;
using Fission.Core.Process;
using Fission.Providers.Hardware;
using Fission.Providers.Media;
using Fission.Providers.Pipeline;

// 产品仅支持 Windows（PRD §6.4）
[assembly: SupportedOSPlatform("windows7.0")]

// Fission 工作台（PRD FR-9 / v1.3 使用便捷性）。仅 127.0.0.1 + 启动 token（§13.1 B7）。
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { ContentRootPath = AppContext.BaseDirectory, WebRootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot") });
var app = builder.Build();

// ── 安全（B7）：Host 白名单 + 启动随机 token ──
var token = Guid.NewGuid().ToString("N")[..16];
var port = 8090;
while (IsPortTaken(port))
{
    port++;
}

app.Use(async (ctx, next) =>
{
    var host = ctx.Request.Host.Host;
    if (host is not ("127.0.0.1" or "localhost" or "[::1]"))
    {
        ctx.Response.StatusCode = 403;
        await ctx.Response.WriteAsync("forbidden host").ConfigureAwait(false);
        return;
    }

    var t = ctx.Request.Query["t"].FirstOrDefault() ?? ctx.Request.Headers["X-Fission-Token"].FirstOrDefault();
    if (t != token)
    {
        ctx.Response.StatusCode = 401;
        await ctx.Response.WriteAsync("invalid token").ConfigureAwait(false);
        return;
    }

    await next().ConfigureAwait(false);
});

app.UseDefaultFiles();
app.UseStaticFiles();

// ── 引擎单实例任务管理 ──
var paths = new EnginePaths();
using var pool = new ProcessPool();
var bus = new JobEventBus();
var jsonOpts = new JsonSerializerOptions
{
    PropertyNameCaseInsensitive = true,
    Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
};
var running = new RunningJobState();

app.MapGet("/api/health", () => Results.Json(new { ok = true, running = running.JobId is not null, poolBusy = pool.RunningCount }));

// ── 目录浏览（仅列子目录；token 内网本机使用，B7 边界内）──
app.MapGet("/api/fs/list", (string? path) =>
{
    if (string.IsNullOrWhiteSpace(path))
    {
        // 根：盘符列表
        var drives = System.IO.DriveInfo.GetDrives().Where(d => d.IsReady).Select(d => d.RootDirectory.FullName.TrimEnd('\\')).ToList();
        return Results.Json(new { current = "", parent = null as string, dirs = drives });
    }

    if (!Directory.Exists(path))
    {
        return Results.BadRequest(new { error = "目录不存在" });
    }

    var full = Path.GetFullPath(path);
    var dirs = Directory.EnumerateDirectories(full, "*", new EnumerationOptions
    {
        IgnoreInaccessible = true,
        AttributesToSkip = FileAttributes.System | FileAttributes.Hidden,
    }).Select(d => Path.GetFileName(d.TrimEnd(Path.DirectorySeparatorChar))).Order().ToList();
    var parent = Directory.GetParent(full)?.FullName;
    return Results.Json(new { current = full, parent, dirs });
});

// ── 池统计（FR-1.2：选目录即时刷新各池数量；视频/图片分列——原版网格「视频数/图片数」）──
app.MapGet("/api/pools/scan", (string? video, string? audio, string? bgm, string? intro, string? outro) =>
    Results.Json(new
    {
        videos = FsCount.CountByExt(video, FsCount.VideoExt, recursive: true),
        images = FsCount.CountByExt(video, FsCount.ImageExt, recursive: true),
        audios = FsCount.CountByExt(audio, FsCount.AudioExt),
        bgms = FsCount.CountByExt(bgm, FsCount.AudioExt),
        intros = FsCount.CountByExt(intro, FsCount.VideoExt),
        outros = FsCount.CountByExt(outro, FsCount.VideoExt),
    }));

// ── 场景组板块（原版子文件夹网格：名称/数字序/视频数/图片数）──
app.MapGet("/api/scene-groups", (string? path) =>
{
    if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path))
    {
        return Results.Json(new { groups = Array.Empty<object>() });
    }

    var groups = Directory.EnumerateDirectories(path, "*", new EnumerationOptions { IgnoreInaccessible = true })
        .Select(d =>
        {
            var name = Path.GetFileName(d.TrimEnd(Path.DirectorySeparatorChar));
            var digits = new string(name.TakeWhile(char.IsDigit).ToArray());
            return new
            {
                name,
                order = int.TryParse(digits, out var n) ? n : (int?)null,
                files = FsCount.CountByExt(d, FsCount.VideoExt),
                images = FsCount.CountByExt(d, FsCount.ImageExt),
            };
        })
        .OrderBy(g => g.order ?? int.MaxValue)
        .ThenBy(g => g.name, StringComparer.OrdinalIgnoreCase)
        .ToList();
    return Results.Json(new { groups });
});

// ── 打开文件夹（本机资源管理器；仅目录存在时）──
app.MapPost("/api/open-folder", (DirPayload payload) =>
{
    var dir = payload.Path;
    if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir))
    {
        return Results.BadRequest(new { error = "目录不存在" });
    }

    using var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("explorer.exe", $"\"{Path.GetFullPath(dir)}\"") { UseShellExecute = true });
    return Results.Json(new { opened = true });
});

// ── AIGC 段（板块⑥：DeepSeek 文案 → 豆包/MiniMax TTS；无 key 离线兜底，全链不受阻）──
var keyStore = new AiKeyStore(Path.Combine(paths.WorkRoot, "ai-keys.json"));
var promptStore = new PromptTemplateStore(Path.Combine(paths.WorkRoot, "prompt-template.json"));
var voiceCatalogFile = Path.Combine(paths.WorkRoot, "voice-catalog.json");
var previewCacheDir = Path.Combine(paths.WorkRoot, "voice-preview-cache");
var ffmpegEngine = new FFmpegProvider(pool);
var ffprobe = new FFprobeProvider(paths, pool);

// ── 文案模板（自由编辑；表单字段=占位符，保存即生效）──
app.MapGet("/api/ai/prompt", () => Results.Json(new
{
    template = promptStore.Load(),
    placeholders = PromptTemplates.Placeholders,
    isDefault = !File.Exists(Path.Combine(paths.WorkRoot, "prompt-template.json")),
}));

app.MapPost("/api/ai/prompt", (PromptPayload payload) =>
{
    if (string.IsNullOrWhiteSpace(payload.System) || string.IsNullOrWhiteSpace(payload.User))
    {
        return Results.BadRequest(new { error = "系统提示与用户提示都不能为空" });
    }

    promptStore.Save(new PromptTemplate(payload.System.Trim(), payload.User.Trim()));
    return Results.Json(new { saved = true });
});

app.MapPost("/api/ai/prompt/reset", () =>
{
    promptStore.Reset();
    return Results.Json(new { reset = true, template = promptStore.Load() });
});

// ── 音色目录（内置；work/voice-catalog.json 存在则整体覆盖，同事可自行扩充音色表）──
app.MapGet("/api/ai/voices", () => Results.Json(new
{
    voices = VoiceCatalog.Load(voiceCatalogFile).Select(v => new { v.Provider, v.Id, v.Label, v.Tags }),
    catalogFile = voiceCatalogFile,
    overridden = File.Exists(voiceCatalogFile),
}));

// ── 音色试听：官方 API 现场合成（固定试听句）+ 磁盘缓存；需对应厂商 key ──
app.MapPost("/api/ai/preview", async (PreviewPayload payload) =>
{
    var keys = keyStore.Load();
    var voiceId = payload.VoiceId ?? string.Empty;
    Directory.CreateDirectory(previewCacheDir);
    var cache = Path.Combine(previewCacheDir, $"{payload.Provider}_{voiceId.Replace("/", "_")}.mp3");
    if (File.Exists(cache))
    {
        return Results.File(cache, "audio/mpeg");
    }

    const string audition = "大家好，欢迎来到我的频道，今天这条视频带你看看这款产品到底值不值得买。";
    try
    {
        var audio = payload.Provider switch
        {
            "doubao" => keys.Doubao is { Length: > 0 }
                ? await new DoubaoTtsProvider(keys.Doubao, keys.DoubaoResourceId ?? AiKeyStore.DoubaoResourceId)
                    .SynthesizeAsync(new TtsRequest(audition, voiceId)).ConfigureAwait(false)
                : throw new AiException("AI_TTS_AUTH", "试听需要豆包 key（Key 配置里填好并测试通过）"),
            "minimax" => keys.MiniMax is { Length: > 0 }
                ? await new MiniMaxTtsProvider(keys.MiniMax).SynthesizeAsync(new TtsRequest(audition, voiceId)).ConfigureAwait(false)
                : throw new AiException("AI_TTS_AUTH", "试听需要 MiniMax key（Key 配置里填好并测试通过）"),
            _ => throw new AiException("AI_ARGS", "未知厂商（doubao / minimax）"),
        };
        await File.WriteAllBytesAsync(cache, audio.Audio).ConfigureAwait(false);
        return Results.File(cache, "audio/mpeg");
    }
    catch (AiException ex)
    {
        return Results.BadRequest(new { error = $"[{ex.Code}] {ex.Message}" });
    }
});

app.MapGet("/api/ai/keys", () =>
{
    var k = keyStore.Load();
    return Results.Json(new
    {
        deepseek = AiKeyStore.Mask(k.DeepSeek),
        doubao = AiKeyStore.Mask(k.Doubao),
        doubaoResourceId = k.DoubaoResourceId ?? AiKeyStore.DoubaoResourceId,
        minimax = AiKeyStore.Mask(k.MiniMax),
        hasDeepSeek = !string.IsNullOrWhiteSpace(k.DeepSeek),
        hasDoubao = !string.IsNullOrWhiteSpace(k.Doubao),
        hasMinimax = !string.IsNullOrWhiteSpace(k.MiniMax),
    });
});

app.MapPost("/api/ai/keys", (KeyPayload payload) =>
{
    if (payload.Slot is not ("deepseek" or "doubao" or "minimax" or "doubaoResourceId"))
    {
        return Results.BadRequest(new { error = "未知槽位" });
    }

    keyStore.Save(payload.Slot, payload.Value);
    return Results.Json(new { saved = true });
});

// 连通性测试：DeepSeek 走 1 条文案；TTS 走 2 字合成
app.MapPost("/api/ai/test", async (TestPayload payload) =>
{
    try
    {
        switch (payload.Provider)
        {
            case "deepseek":
                var k1 = keyStore.Load().DeepSeek ?? throw new AiException("AI_TTS_AUTH", "未配置 DeepSeek key");
                _ = await new DeepSeekProvider(k1).GenerateAsync(
                    new ScriptRequest("测试", "品质", string.Empty, string.Empty, ScriptStyle.SalesPitch, 1, 5)).ConfigureAwait(false);
                break;
            case "doubao":
                var k2 = keyStore.Load();
                if (string.IsNullOrWhiteSpace(k2.Doubao)) { throw new AiException("AI_TTS_AUTH", "未配置豆包 key"); }
                _ = await new DoubaoTtsProvider(k2.Doubao, k2.DoubaoResourceId ?? AiKeyStore.DoubaoResourceId)
                    .SynthesizeAsync(new TtsRequest("测试", DoubaoTtsProvider.Voices[0])).ConfigureAwait(false);
                break;
            case "minimax":
                var k3 = keyStore.Load().MiniMax ?? throw new AiException("AI_TTS_AUTH", "未配置 MiniMax key");
                _ = await new MiniMaxTtsProvider(k3).SynthesizeAsync(new TtsRequest("测试", MiniMaxTtsProvider.Voices[0])).ConfigureAwait(false);
                break;
            default:
                return Results.BadRequest(new { error = "未知提供者" });
        }

        return Results.Json(new { ok = true });
    }
    catch (AiException ex)
    {
        return Results.Json(new { ok = false, error = $"{ex.Code}：{ex.Message}" });
    }
});

// 文案生成（板块⑥；drafts 由前端持有，TTS 时回传——服务端无会话态）
app.MapPost("/api/ai/script", async (HttpRequest http) =>
{
    ScriptFormPayload? form;
    try
    {
        form = await JsonSerializer.DeserializeAsync<ScriptFormPayload>(http.Body, jsonOpts).ConfigureAwait(false);
    }
    catch (JsonException)
    {
        return Results.BadRequest(new { error = "JSON 解析失败" });
    }

    if (form is null || (form.Count ?? 0) is < 1 or > 50)
    {
        return Results.BadRequest(new { error = "数量需在 1–50" });
    }

    var req = new ScriptRequest(
        form.Product ?? string.Empty,
        form.SellingPoints ?? string.Empty,
        form.Scenes ?? string.Empty,
        form.Audience ?? string.Empty,
        form.Style ?? ScriptStyle.SalesPitch,
        form.Count!.Value,
        Math.Clamp(form.TargetDurationSec ?? 12, 3, 120),
        form.ExtraNotes);

    ILLMProvider llm = keyStore.Load().DeepSeek is { Length: > 0 } key
        ? new DeepSeekProvider(key, template: promptStore.Load())
        : new OfflineScriptProvider();
    try
    {
        var drafts = await llm.GenerateAsync(req, http.HttpContext.RequestAborted).ConfigureAwait(false);
        return Results.Json(new { provider = llm.Provider, drafts });
    }
    catch (AiException ex)
    {
        return Results.Json(new { error = $"[{ex.Code}] {ex.Message}（可先用离线模板生成）" });
    }
});

// 配音生成：drafts → TTS → work/aigc/{stamp}/voice/*.mp3 + meta.json（目录可直接作裂变配音目录）
app.MapPost("/api/ai/voice", async (HttpRequest http) =>
{
    VoiceFormPayload? form;
    try
    {
        form = await JsonSerializer.DeserializeAsync<VoiceFormPayload>(http.Body, jsonOpts).ConfigureAwait(false);
    }
    catch (JsonException)
    {
        return Results.BadRequest(new { error = "JSON 解析失败" });
    }

    if (form?.Drafts is not { Count: > 0 })
    {
        return Results.BadRequest(new { error = "没有文案——先生成文案" });
    }

    var keys = keyStore.Load();
    var choice = form.Tts ?? "auto";
    ITTSProvider? real = choice switch
    {
        "doubao" when keys.Doubao is { Length: > 0 } => new DoubaoTtsProvider(keys.Doubao, keys.DoubaoResourceId ?? AiKeyStore.DoubaoResourceId),
        "minimax" when keys.MiniMax is { Length: > 0 } => new MiniMaxTtsProvider(keys.MiniMax),
        "auto" when keys.Doubao is { Length: > 0 } => new DoubaoTtsProvider(keys.Doubao, keys.DoubaoResourceId ?? AiKeyStore.DoubaoResourceId),
        "auto" when keys.MiniMax is { Length: > 0 } => new MiniMaxTtsProvider(keys.MiniMax),
        _ => null, // 显式选了厂商但无 key / auto 无任何 key → 离线
    };

    var dir = Path.Combine(paths.WorkRoot, "aigc", DateTime.Now.ToString("yyyyMMdd_HHmmss"), "voice");
    Directory.CreateDirectory(dir);
    var voiceId = form.VoiceId ?? (real is DoubaoTtsProvider ? DoubaoTtsProvider.Voices[0] : MiniMaxTtsProvider.Voices[0]);
    var speed = Math.Clamp(form.Speed ?? 1.0, 0.5, 2.0);
    var volume = Math.Clamp(form.Volume ?? 1.0, 0.1, 10);
    var items = new List<object>(form.Drafts.Count);
    var providerName = real?.Provider ?? "offline";

    foreach (var d in form.Drafts)
    {
        var file = Path.Combine(dir, Fission.Core.Util.FileNameSanitizer.Sanitize(d.Title) + ".mp3");
        if (real is not null)
        {
            var audio = await real.SynthesizeAsync(new TtsRequest(d.Text, voiceId, speed, volume), http.HttpContext.RequestAborted).ConfigureAwait(false);
            await File.WriteAllBytesAsync(file, audio.Audio, http.HttpContext.RequestAborted).ConfigureAwait(false);
        }
        else
        {
            // 离线合成：字数→时长（4.5 字/秒），音高按标题散列走 5 档（听感区分）
            var dur = Math.Clamp(d.Text.Length / PromptTemplates.CharsPerSecond, 3, 90);
            var tone = 160 + (Math.Abs(StringComparer.OrdinalIgnoreCase.GetHashCode(d.Title)) % 5) * 40;
            await ffmpegEngine.RunAsync(new VideoEngineRequest(paths.FFmpeg, CommandBuilders.MakeVoice(file, dur, tone), dur), ct: http.HttpContext.RequestAborted).ConfigureAwait(false);
        }

        var info = await ffprobe.ProbeAsync(file, http.HttpContext.RequestAborted).ConfigureAwait(false);
        items.Add(new { file = Path.GetFileName(file), title = d.Title, durationSec = Math.Round(info.DurationSec, 1), text = d.Text });
    }

    var meta = new { generatedAt = DateTime.Now, provider = providerName, voiceId, speed, volume, items };
    await File.WriteAllTextAsync(Path.Combine(Path.GetDirectoryName(dir)!, "meta.json"),
        JsonSerializer.Serialize(meta, new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }),
        http.HttpContext.RequestAborted).ConfigureAwait(false);
    return Results.Json(new { dir, provider = providerName, voiceId, items });
});

// ── 转场目录（66 GLSL，lib 目录扫描）──
app.MapGet("/api/transitions", () => Results.Json(new
{
    transitions = TransitionCatalog.List(paths.TransitionsDir),
    dir = paths.TransitionsDir,
}));

app.MapPost("/api/job/start", async (HttpRequest http) =>
{
    if (running.JobId is not null)
    {
        return Results.Conflict(new { error = "已有任务运行中", jobId = running.JobId });
    }

    FissionJob? job;
    try
    {
        job = await JsonSerializer.DeserializeAsync<FissionJob>(http.Body, jsonOpts).ConfigureAwait(false);
    }
    catch (JsonException)
    {
        return Results.BadRequest(new { error = "JSON 解析失败" });
    }

    if (job is null)
    {
        return Results.BadRequest(new { error = "空任务" });
    }

    var hw = new HardwareDetector(paths, pool);
    var hwInfo = await hw.DetectAsync(http.HttpContext.RequestAborted).ConfigureAwait(false);
    var engine = new FissionEngine(paths, new FFmpegProvider(pool), new FFprobeProvider(paths, pool), hwInfo.HasNvencH264 && job.UseNvenc, bus);
    var cts = new CancellationTokenSource();
    var assigned = running.Begin("web", cts, string.IsNullOrWhiteSpace(job.OutDir) ? null : Path.GetFullPath(job.OutDir));
    _ = Task.Run(async () =>
    {
        try
        {
            var report = await engine.RunAsync(job, cts.Token).ConfigureAwait(false);
            running.Finish(report.JobId, report.ToJson());
        }
        catch (OperationCanceledException)
        {
            running.Finish(assigned, "{\"cancelled\":true}");
        }
        catch (Fission.Core.Errors.FissionException ex)
        {
            running.Finish(assigned, JsonSerializer.Serialize(new { error = ex.Code, message = ex.Message }));
        }
        finally
        {
            cts.Dispose();
        }
    });

    return Results.Json(new { started = true });
});

app.MapPost("/api/job/stop", () =>
{
    running.Cancel();
    return Results.Json(new { stopping = true });
});

app.MapGet("/api/status", () => Results.Json(new { running = running.JobId is not null, jobId = running.JobId, lastReport = running.LastReport, poolBusy = pool.RunningCount }));

app.MapGet("/api/events", async (HttpContext ctx) =>
{
    ctx.Response.Headers.ContentType = "text/event-stream";
    ctx.Response.Headers.CacheControl = "no-cache";

    // 立即下发连接注释并冲刷：否则首事件前不下发响应头，EventSource 永远停在 CONNECTING（实测教训）
    await ctx.Response.WriteAsync(": connected\n\n", ctx.RequestAborted).ConfigureAwait(false);
    await ctx.Response.Body.FlushAsync(ctx.RequestAborted).ConfigureAwait(false);

    var queue = new ConcurrentQueue<JobEvent>();
    var signal = new SemaphoreSlim(0);
    var sub = bus.Subscribe(e => { queue.Enqueue(e); signal.Release(); });
    try
    {
        while (!ctx.RequestAborted.IsCancellationRequested)
        {
            // 事件驱动 + 15s 心跳（防空闲断开）
            var got = await signal.WaitAsync(TimeSpan.FromSeconds(15), ctx.RequestAborted).ConfigureAwait(false);
            if (!got)
            {
                await ctx.Response.WriteAsync(": ping\n\n", ctx.RequestAborted).ConfigureAwait(false);
            }

            while (queue.TryDequeue(out var evt))
            {
                var payload = JsonSerializer.Serialize(new { evt.Stage, evt.OutputIndex, evt.Progress, evt.Detail }, jsonOpts);
                await ctx.Response.WriteAsync($"data: {payload}\n\n", ctx.RequestAborted).ConfigureAwait(false);
            }

            await ctx.Response.Body.FlushAsync(ctx.RequestAborted).ConfigureAwait(false);
        }
    }
    catch (OperationCanceledException)
    {
        // 客户端断开
    }
    finally
    {
        sub.Dispose();
        signal.Dispose();
    }
});

app.MapGet("/api/outputs/{jobId}", (string jobId, string? dir) =>
{
    var root = string.IsNullOrWhiteSpace(dir) ? paths.OutRoot : Path.GetFullPath(dir);
    var outDir = Path.Combine(root, jobId);
    if (!Directory.Exists(outDir))
    {
        return Results.NotFound(new { error = "任务不存在" });
    }

    var files = Directory.EnumerateFiles(outDir, "*.mp4").Order().Select(f => new
    {
        name = Path.GetFileName(f),
        cover = File.Exists(Path.ChangeExtension(f, ".jpg")) ? Path.GetFileName(Path.ChangeExtension(f, ".jpg")) : null,
        sizeMb = Math.Round(new FileInfo(f).Length / 1024.0 / 1024.0, 1),
    }).ToList();
    return Results.Json(new { jobId, outputs = files });
});

// 封面图（token 走 query；dir=任务自定义输出根）
app.MapGet("/covers/{jobId}/{file}", (string jobId, string file, string? dir) =>
{
    var root = string.IsNullOrWhiteSpace(dir) ? paths.OutRoot : Path.GetFullPath(dir);
    var path = Path.Combine(root, jobId, Path.GetFileName(file));
    return File.Exists(path) ? Results.File(path, "image/jpeg") : Results.NotFound();
});

Console.WriteLine();
Console.WriteLine("════════ Fission 工作台 ════════");
Console.WriteLine($"访问: http://127.0.0.1:{port}/?t={token}");
Console.WriteLine("════════════════════════════════");
app.Run($"http://127.0.0.1:{port}");

return;

static bool IsPortTaken(int p)
{
    try
    {
        using var listener = System.Net.Sockets.TcpListener.Create(0);
        _ = listener;
        using var probe = new System.Net.Sockets.TcpClient();
        probe.Connect("127.0.0.1", p);
        return true;
    }
    catch (System.Net.Sockets.SocketException)
    {
        return false;
    }
}

/// <summary>运行中任务状态（单任务互斥）。</summary>
internal sealed class RunningJobState
{
    private readonly object _sync = new();

    public string? JobId { get; private set; }

    public string? LastReport { get; private set; }

    public string? OutDir { get; private set; }

    private CancellationTokenSource? _cts;

    public string Begin(string id, CancellationTokenSource cts, string? outDir = null)
    {
        lock (_sync)
        {
            JobId = id;
            _cts = cts;
            LastReport = null;
            OutDir = outDir;
            return id;
        }
    }

    public void Cancel()
    {
        lock (_sync)
        {
            _cts?.Cancel();
        }
    }

    public void Finish(string id, string report)
    {
        lock (_sync)
        {
            JobId = null;
            _cts = null;
            LastReport = report;
        }
    }
}

/// <summary>目录载荷。</summary>
internal sealed record DirPayload(string Path);

/// <summary>AIGC 文案表单载荷。</summary>
internal sealed record ScriptFormPayload(
    string? Product, string? SellingPoints, string? Scenes, string? Audience,
    ScriptStyle? Style, int? Count, double? TargetDurationSec, string? ExtraNotes);

/// <summary>文案模板载荷（自由编辑保存）。</summary>
internal sealed record PromptPayload(string? System, string? User);

/// <summary>音色试听载荷。</summary>
internal sealed record PreviewPayload(string? Provider, string? VoiceId);

/// <summary>AIGC 配音载荷（drafts 回传 + 厂商/音色/语速/音量）。</summary>
internal sealed record VoiceFormPayload(IReadOnlyList<ScriptDraft>? Drafts, string? Tts, string? VoiceId, double? Speed, double? Volume);

/// <summary>key 槽位载荷。</summary>
internal sealed record KeyPayload(string? Slot, string? Value);

/// <summary>连通性测试载荷。</summary>
internal sealed record TestPayload(string? Provider);

/// <summary>按扩展名统计目录文件数（目录缺失=0；视频/图片分列，图片=图转视频预备）。</summary>
internal static class FsCount
{
    public static readonly string[] VideoExt = [".mp4", ".mov", ".mkv", ".m4v"];
    public static readonly string[] ImageExt = [".jpg", ".jpeg", ".png", ".bmp"];
    public static readonly string[] AudioExt = [".mp3", ".wav", ".m4a"];

    public static int CountByExt(string? dir, string[] exts, bool recursive = false)
    {
        if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir))
        {
            return 0;
        }

        var opts = recursive ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly;
        try
        {
            return Directory.EnumerateFiles(dir, "*.*", opts).Count(f => exts.Contains(Path.GetExtension(f).ToLowerInvariant()));
        }
        catch (UnauthorizedAccessException)
        {
            return 0;
        }
    }
}
