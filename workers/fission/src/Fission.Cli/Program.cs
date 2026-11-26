// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using System.Globalization;
using System.Runtime.Versioning;
using System.Text.Json;
using Fission.Core.Abstractions;
using Fission.Core.Engine;
using Fission.Core.Errors;
using Fission.Core.Jobs;
using Fission.Core.Process;
using Fission.Providers.Assets;
using Fission.Providers.Diagnostics;
using Fission.Providers.Hardware;
using Fission.Providers.Media;
using Fission.Providers.Pipeline;

// 产品仅支持 Windows（PRD §6.4）
[assembly: SupportedOSPlatform("windows7.0")]

namespace Fission.Cli;

/// <summary>CLI 入口（PRD FR-10）。退出码：0 成功 / 2 参数 / 3 引擎 / 4 素材 / 5 AI。</summary>
public static class Program
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
    };

    /// <summary>main。</summary>
    public static async Task<int> Main(string[] args)
    {
        if (args.Length == 0)
        {
            PrintUsage();
            return 2;
        }

        var controlledRun = args[0].ToLowerInvariant() is "run" or "prepare" or "execute-prepared";
        using var parentCancelled = new CancellationTokenSource();
        using var parentReaderStopped = new CancellationTokenSource();
        try
        {
            if (controlledRun)
            {
                JobNamespaceGuard? namespaceGuard = null;
                try
                {
                    // 受信父进程先交出意图，CLI 在同一步里建立并固定任务命名空间；
                    // 之后父进程的素材复制、结果记录与恢复都发生在不可被改名的路径上。
                    var guardRoot = Environment.GetEnvironmentVariable("FISSION_NAMESPACE_ROOT");
                    var guardJob = Environment.GetEnvironmentVariable("FISSION_NAMESPACE_JOB");
                    if (guardRoot is not null || guardJob is not null)
                    {
                        if (string.IsNullOrEmpty(guardRoot) || string.IsNullOrEmpty(guardJob))
                            throw new ConfigException("CFG_ARGS", "混剪工作目录无法安全固定。");
                        var startup = Console.In.ReadLine()
                            ?? throw new ConfigException("CFG_NAMESPACE", "父进程在命名空间建立前退出。");
                        namespaceGuard = JobNamespaceGuard.Acquire(guardRoot, guardJob, startup, StartupRoles(startup), ControlledOption(args, "--task"), ControlledOption(args, "--attempt"), Environment.GetEnvironmentVariable("FISSION_NAMESPACE_TAKEOVER") == "1");
                        Console.Error.WriteLine("[Fission:NAMESPACE-HELD] " + namespaceGuard.Receipt());
                        Console.Error.Flush();
                    }

                    using var workspaceLease = namespaceGuard is null && Environment.GetEnvironmentVariable("FISSION_HOLD_WORKSPACE_NAMESPACE") == "1"
                        ? WorkspaceNamespaceLease.Acquire(ControlledWorkspace(args)) : null;
                    if (workspaceLease is not null) Console.Error.WriteLine("[Fission:WORKSPACE-HELD]");
                    EngineRunConfiguration configuration;
                    if (namespaceGuard is not null)
                    {
                        // 父进程在 ack 之后才写 paths/job；因此必须先等到 START 再读命令，顺序不可交换。
                        if (!await AwaitNamespaceStartAsync(parentReaderStopped, parentCancelled).ConfigureAwait(false)) return 130;
                        configuration = EngineRunConfiguration.LoadCommand(args);
                    }
                    else
                    {
                        configuration = EngineRunConfiguration.LoadCommand(args);
                        if (Environment.GetEnvironmentVariable("FISSION_PARENT_STDIN_EOF") == "1")
                        {
                            // Opt-in trusted parent pipe only; normal standalone CLI is unchanged.
                            _ = Task.Run(async () =>
                            {
                                try
                                {
                                    var buffer = new char[1];
                                    while (await Console.In.ReadAsync(buffer.AsMemory(), parentReaderStopped.Token).ConfigureAwait(false) != 0) { }
                                    if (!parentReaderStopped.IsCancellationRequested) parentCancelled.Cancel();
                                }
                                catch (OperationCanceledException) when (parentReaderStopped.IsCancellationRequested) { }
                                catch (Exception) { if (!parentReaderStopped.IsCancellationRequested) parentCancelled.Cancel(); }
                            }, CancellationToken.None);
                        }
                    }
                    using var runPool = new ProcessPool();
                    var releaseSignal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                    if (namespaceGuard is not null) WatchParentPipe(parentReaderStopped, parentCancelled, releaseSignal);
                    var pinCreatedRoot = namespaceGuard is null ? (Action<string>?)null : namespaceGuard.PinCreatedRoot;
                    var exitCode = await RunFissionAsync(configuration, runPool, parentCancelled.Token, pinCreatedRoot).ConfigureAwait(false);
                    if (namespaceGuard is not null)
                    {
                        // 运行结果先通知父进程；父进程写完结果记录再发 DONE，命名空间在此期间保持固定。
                        Console.Error.WriteLine("[Fission:JOB-FINISHED] " + exitCode.ToString(System.Globalization.CultureInfo.InvariantCulture));
                        Console.Error.Flush();
                        try { await releaseSignal.Task.WaitAsync(TimeSpan.FromMinutes(2)).ConfigureAwait(false); }
                        catch (TimeoutException) { Console.Error.WriteLine("[Fission:NAMESPACE-RELEASED-UNCONFIRMED]"); }
                    }
                    return exitCode;
                }
                finally { namespaceGuard?.Dispose(); }
            }

            var paths = LoadPaths();
            using var pool = new ProcessPool();
            return args[0].ToLowerInvariant() switch
            {
                "doctor" => await RunDoctorAsync(paths, pool).ConfigureAwait(false),
                "normalize" => await RunNormalizeAsync(paths, pool, args).ConfigureAwait(false),
                "mkaudio" => await RunMkaudioAsync(paths, pool, args).ConfigureAwait(false),
                "stress" => await RunStressAsync(paths, pool, args).ConfigureAwait(false),
                _ => Unknown(args[0]),
            };
        }
        catch (OperationCanceledException) when (controlledRun && parentCancelled.IsCancellationRequested)
        {
            Console.Error.WriteLine("[Fission:STOPPED] Parent requested cancellation; owned engines have drained.");
            return 130;
        }
        catch (ConfigException ex) when (controlledRun)
        {
            // 内层异常才是"哪条路径/哪个字段"的答案：只报一句"配置无效"会让人以为问题在调用方
            // 由外向内走到底：LoadCommand 会再包一次 LoadCore 的失败，只取一层会得到同一句话
            var inner = string.Empty;
            for (var cause = ex.InnerException; cause is not null; cause = cause.InnerException)
                if (!string.IsNullOrWhiteSpace(cause.Message) && cause.Message != ex.Message) inner = cause.Message;
            Console.Error.WriteLine($"[Fission:{ex.Code}] 混剪配置或任务无效；请提供完整的显式隔离参数。" + (string.IsNullOrWhiteSpace(inner) ? string.Empty : " 原因：" + inner));
            return 2;
        }
        catch (FissionException ex)
        {
            Console.Error.WriteLine($"[Fission:{ex.Code}] {ex.Message}");
            return ex is EngineException or ConfigException ? 3 : ex is MaterialException ? 4 : 5;
        }
        finally { parentReaderStopped.Cancel(); }
    }

    private static string ControlledWorkspace(string[] args)
    {
        string? workspace = null;
        for (var i = 1; i + 1 < args.Length; i += 2)
            if (args[i] == "--workspace")
            {
                if (workspace is not null) throw new ConfigException("CFG_ARGS", "混剪工作目录无效。");
                workspace = args[i + 1];
            }
        return workspace ?? throw new ConfigException("CFG_ARGS", "混剪工作目录无效。");
    }

    /// <summary>从父进程交来的意图里取角色列表；角色只能是短的纯小写字母名。</summary>
    private static string[] StartupRoles(string intentJson)
    {
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(intentJson);
            if (!document.RootElement.TryGetProperty("roles", out var roles) || roles.ValueKind != System.Text.Json.JsonValueKind.Array) return [];
            var names = new List<string>();
            foreach (var role in roles.EnumerateArray())
            {
                if (role.ValueKind != System.Text.Json.JsonValueKind.String) throw new ConfigException("CFG_NAMESPACE", "混剪任务命名空间参数无效。");
                var name = role.GetString()!;
                if (name.Length is 0 or > 16 || !name.All(char.IsAsciiLetterLower)) throw new ConfigException("CFG_NAMESPACE", "混剪任务命名空间参数无效。");
                names.Add(name);
            }

            return [.. names];
        }
        catch (System.Text.Json.JsonException) { throw new ConfigException("CFG_NAMESPACE", "混剪任务命名空间参数无效。"); }
    }

    /// <summary>读取受控运行的单个显式选项值（不读默认配置）。</summary>
    private static string? ControlledOption(string[] args, string name)
    {
        string? value = null;
        for (var i = 1; i + 1 < args.Length; i += 2)
            if (args[i] == name)
            {
                if (value is not null) throw new ConfigException("CFG_ARGS", "混剪工作目录无效。");
                value = args[i + 1];
            }

        return value;
    }
    /// <summary>等父进程在命名空间固定之后发出 START；父进程退出按取消处理，超时按协议失败处理。</summary>
    private static async Task<bool> AwaitNamespaceStartAsync(CancellationTokenSource stopped, CancellationTokenSource cancelled)
    {
        var read = Task.Run(() => Console.In.ReadLine());
        var deadline = DateTime.UtcNow + TimeSpan.FromMinutes(5);
        while (true)
        {
            try { await read.WaitAsync(TimeSpan.FromMilliseconds(500)).ConfigureAwait(false); break; }
            catch (TimeoutException) { }
            if (stopped.IsCancellationRequested) return false;
            if (DateTime.UtcNow >= deadline) throw new ConfigException("CFG_NAMESPACE", "父进程未在约定时间内启动混剪任务。");
        }

        var line = await read.ConfigureAwait(false);
        if (line is null) { cancelled.Cancel(); return false; }
        if (!string.Equals(line.Trim(), "START", StringComparison.Ordinal))
            throw new ConfigException("CFG_NAMESPACE", "父进程未按协议启动混剪任务。");
        return true;
    }

    /// <summary>运行期间同时看住父进程管道：EOF 表示父进程消失（取消），DONE 表示可以释放命名空间。</summary>
    private static void WatchParentPipe(CancellationTokenSource stopped, CancellationTokenSource cancelled, TaskCompletionSource<bool> released)
        => _ = Task.Run(async () =>
        {
            try
            {
                string? line;
                while ((line = await Console.In.ReadLineAsync().ConfigureAwait(false)) is not null)
                {
                    if (!string.Equals(line.Trim(), "DONE", StringComparison.Ordinal)) continue;
                    released.TrySetResult(true);
                    return;
                }

                if (!stopped.IsCancellationRequested) cancelled.Cancel();
            }
            catch (OperationCanceledException) when (stopped.IsCancellationRequested) { }
            catch (Exception) { if (!stopped.IsCancellationRequested) cancelled.Cancel(); }
        }, CancellationToken.None);

    private static EnginePaths LoadPaths() => EnginePathsSource.LoadConfigured();

    private static async Task<int> RunDoctorAsync(EnginePaths paths, ProcessPool pool)
    {
        var doctor = new DoctorService(paths, pool, new HardwareDetector(paths, pool), new AssetRegistry(paths));
        var report = await doctor.RunAsync().ConfigureAwait(false);

        Console.WriteLine("=== Fission doctor ===");
        foreach (var item in report.Items)
        {
            Console.WriteLine($"{(item.Ok ? "[OK]" : "[!!]")} {item.Name,-10} {item.Detail}");
        }

        Console.WriteLine(report.AllOk ? "结论：全部就绪" : "结论：存在未通过项（按详情修复后重跑）");
        return report.AllOk ? 0 : 3;
    }

    private static async Task<int> RunNormalizeAsync(EnginePaths paths, ProcessPool pool, string[] args)
    {
        string? input = null, output = null;
        var width = 1080;
        var height = 1920;
        var fps = 30;
        var cpu = false;
        var hwdec = false;

        for (var i = 1; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--in": input = Arg(args, ref i); break;
                case "--out": output = Arg(args, ref i); break;
                case "--w": width = int.Parse(Arg(args, ref i)); break;
                case "--h": height = int.Parse(Arg(args, ref i)); break;
                case "--fps": fps = int.Parse(Arg(args, ref i)); break;
                case "--cpu": cpu = true; break;
                case "--hwdec": hwdec = true; break;
                default:
                    Console.Error.WriteLine($"未知参数：{args[i]}");
                    return 2;
            }
        }

        if (input is null || output is null)
        {
            Console.Error.WriteLine("用法: fission normalize --in <源> --out <产物> [--w 1080 --h 1920 --fps 30] [--cpu] [--hwdec]");
            return 2;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);

        var hw = new HardwareDetector(paths, pool);
        var hwInfo = await hw.DetectAsync().ConfigureAwait(false);
        // M1 基准实测（docs/bench/m1-normalize.md）：本 gyan 构建上 cuda 解码无 hw 帧直通反慢 14%，
        // 默认 = nvenc 编码 + 软件解码；--hwdec 可选开启
        var useNvenc = !cpu && hwInfo.HasNvencH264;
        var hwDecode = hwdec && useNvenc;

        var engineArgs = FFmpegProvider.BuildNormalizeArgs(input, output, width, height, fps, useNvenc, hwDecode);
        Console.WriteLine($"引擎: {Path.GetFileName(paths.FFmpeg)}  编码: {(useNvenc ? "h264_nvenc" : "libx264 veryfast")}  解码: {(hwDecode ? "cuda" : "软件")}");

        var probe = new FFprobeProvider(paths, pool);
        var srcInfo = await probe.ProbeAsync(input).ConfigureAwait(false);

        var engine = new FFmpegProvider(pool);
        var lastProgress = 0.0;
        var result = await engine.RunAsync(
            new VideoEngineRequest(paths.FFmpeg, engineArgs, srcInfo.DurationSec),
            onProgress: p =>
            {
                if (p - lastProgress >= 0.1)
                {
                    lastProgress = p;
                    Console.Error.WriteLine($"  进度 {p:P0}");
                }
            }).ConfigureAwait(false);

        var outInfo = await probe.ProbeAsync(output).ConfigureAwait(false);
        Console.WriteLine($"完成: {output}");
        Console.WriteLine($"  源   {srcInfo.Width}x{srcInfo.Height} {srcInfo.VCodec} {(srcInfo.IsVfr ? "VFR" : "CFR")} {srcInfo.DurationSec:F1}s");
        Console.WriteLine($"  产物 {outInfo.Width}x{outInfo.Height} {outInfo.VCodec} CFR{outInfo.Fps:F0} 无音轨 {outInfo.DurationSec:F1}s");
        Console.WriteLine($"  墙钟 {(result.DurationMs / 1000.0):F1}s → 实时倍率 {outInfo.DurationSec / (result.DurationMs / 1000.0):F1}x");
        return 0;
    }

    private static string Arg(string[] args, ref int i)
    {
        if (i + 1 >= args.Length)
        {
            throw new ConfigException("CFG_ARGS", $"参数 {args[i]} 缺值");
        }

        i++;
        return args[i];
    }

    private static async Task<int> RunFissionAsync(EngineRunConfiguration configuration, ProcessPool pool, CancellationToken ct, Action<string>? pinCreatedRoot = null)
    {
        var paths = configuration.Policy.Paths;
        var job = configuration.Job;
        var runtimeOwner = new FissionEngine(configuration.Policy, new FFmpegProvider(pool), new FFprobeProvider(paths, pool), false, null, pinCreatedRoot);
        using var runtimePins = configuration.Mode == "run" ? null
            : configuration.OutputIndices is null
                ? await runtimeOwner.HoldPreparedRuntimeAsync(job, configuration.Prepared, ct).ConfigureAwait(false)
                : await runtimeOwner.HoldPreparedRuntimeAsync(job, configuration.Prepared!, configuration.OutputIndices, ct).ConfigureAwait(false);
        var hw = new HardwareDetector(paths, pool);
        var hasNvenc = false;
        if (configuration.Mode == "run" || job.UseNvenc) hasNvenc = (await hw.DetectAsync(ct).ConfigureAwait(false)).HasNvencH264;
        var engine = new FissionEngine(configuration.Policy, new FFmpegProvider(pool), new FFprobeProvider(paths, pool), hasNvenc && job.UseNvenc, null, pinCreatedRoot);
        if (configuration.Mode == "prepare")
        {
            var prepared = await engine.PrepareAsync(job, ct).ConfigureAwait(false);
            var files = new EngineJobFiles(configuration.Policy); var snapshot = files.ValidateNewOutput(configuration.SnapshotPath!);
            await using (var stream = new FileStream(snapshot, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, FileOptions.Asynchronous))
                await stream.WriteAsync(System.Text.Encoding.UTF8.GetBytes(prepared.ToJson()), ct).ConfigureAwait(false);
            files.ValidateOwnedFile(snapshot);
            Console.WriteLine(JsonSerializer.Serialize(new { preparedPath = snapshot, digest = prepared.Digest, authorizesBusiness = false, measuredAssemblyClock = false }));
            return 0;
        }
        // 只针对“驱动 nvenc API 过低”这一种失败改用 CPU 编码一次；其它失败保持原样。
        if (job.UseNvenc)
        {
            var probe = NvencFallback.Probe(paths.FFmpeg);
            if (probe.Fallback)
            {
                job.UseNvenc = false;
                Console.Error.WriteLine("[Fission:NVENC-FALLBACK] " + probe.Detail);
                Console.Error.Flush();
            }
        }

        var report = configuration.Mode == "execute-prepared"
            ? configuration.OutputIndices is null
                ? await engine.ExecutePreparedAsync(job, configuration.Prepared!, ct).ConfigureAwait(false)
                : await engine.ExecutePreparedAsync(job, configuration.Prepared!, configuration.OutputIndices, ct).ConfigureAwait(false)
            : await engine.RunAsync(job, ct).ConfigureAwait(false);

        Console.WriteLine($"═══ 任务完成 ═══");
        Console.WriteLine($"成功 {report.Succeeded} / 失败 {report.Failed} / 停止原因 {report.StopReason} / 总耗时 {report.TotalWallMs / 1000.0:F1}s");
        foreach (var o in report.Outputs)
        {
            Console.WriteLine($"  [{o.Index + 1:D2}] {o.Title} → {o.Path}（{o.DurationSec:F1}s / {o.WallMs / 1000.0:F1}s）");
        }

        foreach (var f in report.Failures)
        {
            Console.WriteLine($"  [失败 {f.Index + 1:D2}] {f.Code}: {f.Message}");
        }

        if (pinCreatedRoot is not null) EmitOutputManifest(report);
        return report.StopReason == "userStopped" ? 130 : report.Failed == 0 ? 0 : 4;
    }

    /// <summary>把本次真正写出的产物（路径、打开身份、SHA-256）交给父进程核对，防被替换的“产物”。</summary>
    private static void EmitOutputManifest(JobReport report)
    {
        var items = new List<object>();
        foreach (var output in report.Outputs)
        {
            using var stream = new FileStream(output.Path, FileMode.Open, FileAccess.Read, FileShare.Read);
            var parts = Fission.Core.Pipeline.PreparedFileIdentity.Read(stream.SafeFileHandle).Split(':');
            var volume = Convert.ToUInt32(parts[0], 16).ToString(System.Globalization.CultureInfo.InvariantCulture);
            var index = Convert.ToUInt64(parts[1], 16).ToString(System.Globalization.CultureInfo.InvariantCulture);
            stream.Position = 0;
            using var sha = System.Security.Cryptography.SHA256.Create();
            var hash = Convert.ToHexStringLower(sha.ComputeHash(stream));
            items.Add(new { index = output.Index, path = output.Path, volume, fileIndex = index, sha256 = hash });
        }

        Console.Error.WriteLine("[Fission:OUTPUTS] " + JsonSerializer.Serialize(items));
        Console.Error.Flush();
    }

    private static async Task<int> RunMkaudioAsync(EnginePaths paths, ProcessPool pool, string[] args)
    {
        var count = 3;
        var dur = 15.0;
        string? outDir = null;
        for (var i = 1; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--count": count = int.Parse(Arg(args, ref i)); break;
                case "--dur": dur = double.Parse(Arg(args, ref i), CultureInfo.InvariantCulture); break;
                case "--out": outDir = Arg(args, ref i); break;
                default:
                    Console.Error.WriteLine($"未知参数：{args[i]}");
                    return 2;
            }
        }

        outDir ??= Path.Combine(paths.WorkRoot, "mkaudio");
        Directory.CreateDirectory(outDir);
        var engine = new FFmpegProvider(pool);
        for (var i = 0; i < count; i++)
        {
            var dst = Path.Combine(outDir, $"voice_{i + 1:D3}.mp3");
            await engine.RunAsync(new VideoEngineRequest(paths.FFmpeg, CommandBuilders.MakeVoice(dst, dur, 160 + (i % 6) * 40), dur)).ConfigureAwait(false);
            Console.WriteLine($"  {dst}（{dur:F0}s）");
        }

        Console.WriteLine($"完成：{count} 条合成配音 → {outDir}");
        return 0;
    }

    private static async Task<int> RunStressAsync(EnginePaths paths, ProcessPool pool, string[] args)
    {
        var count = 24;
        var threads = 20;
        double dur = 12;
        for (var i = 1; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--count": count = int.Parse(Arg(args, ref i)); break;
                case "--threads": threads = int.Parse(Arg(args, ref i)); break;
                case "--dur": dur = double.Parse(Arg(args, ref i), CultureInfo.InvariantCulture); break;
                default:
                    Console.Error.WriteLine($"未知参数：{args[i]}");
                    return 2;
            }
        }

        Console.WriteLine($"═══ 压测：{count} 条成片 @ {threads} 并发（含故障注入）═══");

        // 素材：junction 指向 sucai（只读保护源目录）+ 注入 1 个损坏文件（跳过逻辑）+ 合成配音
        var stressRoot = Path.Combine(paths.WorkRoot, "stress");
        var videoDir = Path.Combine(stressRoot, "scenes");
        if (Directory.Exists(videoDir))
        {
            // junction 安全清理：链接（ReparsePoint）只摘不进；真实目录才递归删——防穿越伤及 sucai 源目录
            foreach (var child in Directory.EnumerateFileSystemEntries(videoDir))
            {
                var attr = File.GetAttributes(child);
                if ((attr & FileAttributes.Directory) != 0)
                {
                    Directory.Delete(child, recursive: (attr & FileAttributes.ReparsePoint) == 0);
                }
                else
                {
                    File.Delete(child);
                }
            }

            Directory.Delete(videoDir, false);
        }

        Directory.CreateDirectory(videoDir);
        foreach (var d in Directory.EnumerateDirectories(@"D:\dev\sucai"))
        {
            var link = Path.Combine(videoDir, Path.GetFileName(d));
            _ = RunCmd("cmd", $"/c mklink /J \"{link}\" \"{d}\"");
        }

        var poison = Path.Combine(videoDir, "0损坏注入", "poison.mov");
        Directory.CreateDirectory(Path.GetDirectoryName(poison)!);
        await File.WriteAllTextAsync(poison, "this is not a video - corrupt file for stress skip test").ConfigureAwait(false);

        var audioDir = Path.Combine(stressRoot, "audio");
        if (Directory.Exists(audioDir))
        {
            Directory.Delete(audioDir, true);
        }

        // stress=全新批次语义：清跨批次缓存（同名配音每轮重新生成，旧缓存条目会误标已消耗）
        var cacheIni = Path.Combine(paths.WorkRoot, "多场景素材缓存.ini");
        if (File.Exists(cacheIni))
        {
            File.Delete(cacheIni);
        }

        var mkaudio = await RunMkaudioAsync(paths, pool, ["mkaudio", "--count", (count + 4).ToString(), "--dur", dur.ToString("F0", CultureInfo.InvariantCulture), "--out", audioDir]).ConfigureAwait(false);
        if (mkaudio != 0)
        {
            return mkaudio;
        }

        var hw = new HardwareDetector(paths, pool);
        var hwInfo = await hw.DetectAsync().ConfigureAwait(false);
        var job = new FissionJob
        {
            VideoDir = videoDir,
            AudioDir = audioDir,
            Count = count,
            Threads = threads,
            TargetDurationSec = dur,
            AudioUses = 1,
            SplitMode = SplitMode.Scene,
            AllowVideoReuse = true, // 33 素材对 24 输出，开复用保证供给（组合去重仍防整条重复）
        };
        var engine = new FissionEngine(paths with { OutRoot = Path.Combine(stressRoot, "out") }, new FFmpegProvider(pool), new FFprobeProvider(paths, pool), hwInfo.HasNvencH264 && job.UseNvenc);
        var report = await engine.RunAsync(job).ConfigureAwait(false);

        // ── 断言区（稳定性验收）──
        var failures = new List<string>();
        if (report.Succeeded != count)
        {
            failures.Add($"成功数 {report.Succeeded} ≠ 计划 {count}");
        }

        // 消耗唯一性：uses=1 时同一配音不得确认两次
        var dupAudio = report.ConsumeLog.Where(l => l.ConfirmedAt is not null).GroupBy(l => l.Audio).Any(g => g.Count() > 1 && job.AudioUses == 1);
        if (dupAudio)
        {
            failures.Add("同一配音被确认消耗超过一次（uses=1 语义破坏）");
        }

        // 开放预留清零（无悬挂事务）
        if (report.ConsumeLog.Any(l => l.ConfirmedAt is null && l.ReleasedAt is null))
        {
            failures.Add("存在既未确认也未回滚的预留（事务悬挂）");
        }

        // 产物有效性：全部可探测、时长在容差内
        var probe = new FFprobeProvider(paths, pool);
        foreach (var o in report.Outputs)
        {
            try
            {
                var info = await probe.ProbeAsync(o.Path).ConfigureAwait(false);
                if (Math.Abs(info.DurationSec - dur) > 1.0)
                {
                    failures.Add($"{o.Path} 时长 {info.DurationSec:F1}s 偏离目标 {dur:F1}s 超容差");
                }

                if (!info.HasAudio)
                {
                    failures.Add($"{o.Path} 缺音轨");
                }
            }
            catch (FissionException)
            {
                failures.Add($"{o.Path} 产物探测失败（损坏）");
            }
        }

        // 孤儿进程：池空闲
        if (pool.RunningCount != 0)
        {
            failures.Add($"进程池残留 {pool.RunningCount} 个运行中进程（孤儿）");
        }

        Console.WriteLine($"═══ 压测结果 ═══");
        Console.WriteLine($"成功 {report.Succeeded} / 失败 {report.Failed} / 停止 {report.StopReason} / 墙钟 {report.TotalWallMs / 1000.0:F1}s（吞吐 {report.Outputs.Count / (report.TotalWallMs / 1000.0):F2} 条/s）");
        Console.WriteLine(failures.Count == 0
            ? "结论：PASS —— 全部稳定性断言通过（零重复消耗 / 零悬挂事务 / 产物全有效 / 零孤儿进程）"
            : $"结论：FAIL —— {failures.Count} 项断言失败：\n  - " + string.Join("\n  - ", failures));
        return failures.Count == 0 ? 0 : 5;
    }

    private static int RunCmd(string exe, string args)
    {
        using var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true });
        p?.WaitForExit();
        return p?.ExitCode ?? -1;
    }

    private static int Unknown(string cmd)
    {
        Console.Error.WriteLine($"未知命令：{cmd}");
        PrintUsage();
        return 2;
    }

    private static void PrintUsage()
    {
        Console.WriteLine("  prepare: same five explicit isolation/job options; produces native non-authorizing decisions only.");
        Console.WriteLine("  execute-prepared: same options plus --prepared <owned snapshot> --digest <native digest>; optional --outputs <JSON integer array> selects original frozen indices, not permission; caller still needs business admission.");

        Console.WriteLine("""
            Fission CLI
              fission run --paths <只读引擎配置.json> --workspace <隔离根目录> --task <任务ID> --attempt <尝试ID> --job <任务.json>
              fission doctor
              fission normalize --in <源> --out <产物> [--w 1080 --h 1920 --fps 30] [--cpu] [--hwdec]
            run 必须显式提供上述五项参数，不读取旧目录默认配置。
            """);
    }
}
