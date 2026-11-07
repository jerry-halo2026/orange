using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using Fission.Core.Abstractions;
using Fission.Core.Engine;
using Fission.Core.Process;
using Fission.Providers.Hardware;
using Fission.Providers.Media;

// 产品仅支持 Windows（PRD §6.4）
[assembly: SupportedOSPlatform("windows7.0")]

namespace Fission.Bench;

/// <summary>
/// M1 归一化基准（ADR-004：环境指纹 + 同机同 fixture 比较）。
/// 生产形态 = 逐文件归一化（M2 引擎对素材池每个文件各跑一次），故基准按同形状执行：
/// 逐文件 4K HEVC → 1080x1920 H264 CFR30 无音轨，含每文件引擎启动开销（真实成本）。
/// 产物：docs/bench/m1-normalize.md（入库）。
/// </summary>
public static class Program
{
    private const string SucaiDir = @"D:\dev\sucai\1筛果";
    private const string WorkDir = @"D:\dev\7d-rebuild\work\bench";
    private const string OutMd = @"D:\dev\7d-rebuild\docs\bench\m1-normalize.md";

    /// <summary>main。</summary>
    public static async Task<int> Main()
    {
        Directory.CreateDirectory(WorkDir);
        Directory.CreateDirectory(Path.GetDirectoryName(OutMd)!);

        var paths = new EnginePaths();
        using var pool = new ProcessPool();
        var probe = new FFprobeProvider(paths, pool);
        var engine = new FFmpegProvider(pool);
        var hw = new HardwareDetector(paths, pool);
        var hwInfo = await hw.DetectAsync().ConfigureAwait(false);

        Console.WriteLine("== Fission bench M1: normalize（逐文件，生产形态）==");
        Console.WriteLine($"环境: {hwInfo.CpuName} / {hwInfo.GpuName} 驱动{hwInfo.DriverVersion} / {hwInfo.TotalRamGb}GB / nvenc:{hwInfo.HasNvencH264}");

        var files = Directory.EnumerateFiles(SucaiDir, "*.MOV", SearchOption.TopDirectoryOnly).Order().ToList();
        if (files.Count == 0)
        {
            Console.Error.WriteLine($"素材目录为空：{SucaiDir}");
            return 4;
        }

        var infos = await Task.WhenAll(files.Select(f => probe.ProbeAsync(f))).ConfigureAwait(false);
        var contentSec = infos.Sum(i => i.DurationSec);
        var srcHash = Sha256List(files);
        Console.WriteLine($"素材: {files.Count} 个 / 内容合计 {contentSec:F1}s / 清单哈希 {srcHash[..12]}…");

        // 三配置 × 逐文件（顺序执行避免抢资源；每配置 2 轮取总时长最短一轮）
        var configs = new (string Name, bool Nvenc, bool HwDec)[]
        {
            ("nvenc+cuda解码", true, true),
            ("nvenc+软解", true, false),
            ("x264软编软解", false, false),
        };

        var results = new List<(string Name, double TotalSec, double Ratio, double PerFileSec)>();
        foreach (var (name, nvenc, hwDec) in configs)
        {
            if (nvenc && !hwInfo.HasNvencH264)
            {
                Console.WriteLine($"{name}: N/A（无 nvenc）");
                results.Add((name, double.NaN, double.NaN, double.NaN));
                continue;
            }

            double bestRound = double.MaxValue;
            for (var round = 1; round <= 2; round++)
            {
                var roundSec = 0.0;
                for (var i = 0; i < files.Count; i++)
                {
                    var outp = Path.Combine(WorkDir, $"out_{name.Replace('+', '_')}_{round}_{i}.mp4");
                    var args = FFmpegProvider.BuildNormalizeArgs(files[i], outp, 1080, 1920, 30, nvenc, hwDec);
                    var r = await engine.RunAsync(new VideoEngineRequest(paths.FFmpeg, args, infos[i].DurationSec)).ConfigureAwait(false);
                    roundSec += r.DurationMs / 1000.0;
                }

                bestRound = Math.Min(bestRound, roundSec);
            }

            results.Add((name, bestRound, contentSec / bestRound, bestRound / files.Count));
            Console.WriteLine($"{name}: 总墙钟 {bestRound:F1}s → {contentSec / bestRound:F1}x 实时（均 {bestRound / files.Count:F2}s/文件）");
        }

        // 写基准表（ADR-004：环境指纹随表入库）
        var md = new StringBuilder();
        _ = md.AppendLine("# M1 基准 · 归一化（4K HEVC 竖版 → 1080x1920 H264 CFR30 无音轨，逐文件）");
        _ = md.AppendLine();
        _ = md.AppendLine($"- 日期：{DateTime.Now:yyyy-MM-dd HH:mm}");
        _ = md.AppendLine($"- 基准机：{hwInfo.CpuName} · {hwInfo.LogicalCores} 线程 · {hwInfo.TotalRamGb}GB RAM");
        _ = md.AppendLine($"- GPU：{hwInfo.GpuName} {hwInfo.VramMiB / 1024.0:F1}GB · 驱动 {hwInfo.DriverVersion} · CUDA {hwInfo.CudaVersion}");
        _ = md.AppendLine("- ffmpeg：gyan 2022-05-16 git-e3580f6077（libavcodec 59.28.100）");
        _ = md.AppendLine($"- 素材：sucai 1筛果 {files.Count}×MOV（4K HEVC，单文件 3.7–15.5s）· 内容合计 {contentSec:F1}s · 清单 sha256:{srcHash[..16]}");
        _ = md.AppendLine("- 形状：逐文件归一化（= M2 生产形态），含每文件引擎启动开销；每配置 2 轮取最好");
        _ = md.AppendLine("- 注：日常桌面负载环境（GPU 常时约 35% 占用），属指纹一部分");
        _ = md.AppendLine();
        _ = md.AppendLine("| 配置 | 总墙钟(s) | 实时倍率 | 均/文件(s) |");
        _ = md.AppendLine("|---|---|---|---|");
        foreach (var (name, total, ratio, perFile) in results)
        {
            _ = md.AppendLine(double.IsNaN(total)
                ? $"| {name} | N/A | N/A | N/A |"
                : $"| {name} | {total:F1} | {ratio:F1}x | {perFile:F2} |");
        }

        _ = md.AppendLine();
        _ = md.AppendLine("回归阈值：同机同素材下版本间劣化 >10% 阻断（ADR-004）。复跑：`dotnet run --project tests/Fission.Bench`（M4 接入 `fission bench`）。");
        await File.WriteAllTextAsync(OutMd, md.ToString(), new UTF8Encoding(false)).ConfigureAwait(false);
        Console.WriteLine($"已写入: {OutMd}");
        return 0;
    }

    private static string Sha256List(List<string> files)
    {
        using var sha = SHA256.Create();
        var buffer = new byte[64 * 1024];
        foreach (var f in files)
        {
            using var fs = File.OpenRead(f);
            int read;
            while ((read = fs.Read(buffer, 0, buffer.Length)) > 0)
            {
                _ = sha.TransformBlock(buffer, 0, read, null, 0);
            }
        }

        _ = sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
        return Convert.ToHexString(sha.Hash!);
    }
}
