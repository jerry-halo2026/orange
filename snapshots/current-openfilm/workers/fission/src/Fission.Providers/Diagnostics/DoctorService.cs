using System.Runtime.Versioning;
using Fission.Core.Engine;
using Fission.Core.Process;
using Fission.Providers.Assets;
using Fission.Providers.Hardware;

namespace Fission.Providers.Diagnostics;

/// <summary>doctor 单项检查结果。</summary>
/// <param name="Name">检查名。</param>
/// <param name="Ok">是否通过。</param>
/// <param name="Detail">详情（失败时含修复指引）。</param>
public sealed record DoctorItem(string Name, bool Ok, string Detail);

/// <summary>doctor 报告。</summary>
/// <param name="Items">检查项。</param>
/// <param name="Hardware">硬件指纹（ADR-004 组成部分）。</param>
public sealed record DoctorReport(IReadOnlyList<DoctorItem> Items, HardwareInfo Hardware)
{
    /// <summary>是否全部通过。</summary>
    public bool AllOk => Items.All(i => i.Ok);
}

/// <summary>环境体检：引擎存在性、引擎版本、硬件、资产扫描（PRD §6.2 / FR-10 doctor）。仅支持 Windows。</summary>
[SupportedOSPlatform("windows7.0")]
public sealed class DoctorService(EnginePaths paths, ProcessPool pool, HardwareDetector hw, AssetRegistry assets)
{
    /// <summary>执行全部检查。</summary>
    public async Task<DoctorReport> RunAsync(CancellationToken ct = default)
    {
        var items = new List<DoctorItem>();

        // 1) 引擎文件
        var missing = paths.ValidateEngines();
        items.Add(new DoctorItem("引擎文件", missing.Count == 0,
            missing.Count == 0
                ? $"ffmpeg / ffprobe / ffmpeg6 / 转场目录 均就绪（{paths.FFmpeg}）"
                : "缺失：" + string.Join("；", missing) + "。修复：确认 D:\\dev\\7d 完整或修改 config/appsettings.json 引擎路径"));

        // 2) 引擎可执行（取版本号顺带验证）
        items.Add(await CheckEngineVersionAsync("ffmpeg", paths.FFmpeg, "ffmpeg version", ct).ConfigureAwait(false));
        items.Add(await CheckEngineVersionAsync("ffmpeg6(gl)", paths.FFmpeg6, "ffmpeg version", ct).ConfigureAwait(false));

        // 3) 转场滤镜（ffmpeg6 -filters 含 gltransition —— 契约 §6 转场模板前提）
        var glOk = false;
        var glDetail = "ffmpeg6 无 gltransition 滤镜";
        if (File.Exists(paths.FFmpeg6))
        {
            var r = await pool.RunAsync(new ProcessRequest(paths.FFmpeg6, "-hide_banner -filters", TimeoutSec: 30), ct: ct).ConfigureAwait(false);
            glOk = r.Stdout.Contains("gltransition", StringComparison.Ordinal);
            glDetail = glOk ? "gltransition 滤镜就绪（66 GLSL 通道可用）" : glDetail;
        }

        items.Add(new DoctorItem("转场滤镜", glOk, glDetail));

        // 4) 硬件（缺 GPU 不算失败——条件化 ADR-004）
        var hwInfo = await hw.DetectAsync(ct).ConfigureAwait(false);
        var gpuDetail = hwInfo.GpuName is null
            ? "未检测到 NVIDIA GPU（nvenc 指标将记 N/A，软编兜底）"
            : $"{hwInfo.GpuName} {hwInfo.VramMiB / 1024.0:F1}GB · 驱动 {hwInfo.DriverVersion} · CUDA {hwInfo.CudaVersion}";
        items.Add(new DoctorItem("显卡", hwInfo.GpuName is not null, gpuDetail));
        items.Add(new DoctorItem("硬编可用", hwInfo.HasNvencH264,
            hwInfo.HasNvencH264 ? $"h264_nvenc 可用 / hevc_nvenc {(hwInfo.HasNvencHevc ? "可用" : "不可用")}" : "ffmpeg 无 nvenc 编码器，使用 x264 veryfast"));
        items.Add(new DoctorItem("CPU/内存", true, $"{hwInfo.CpuName} · {hwInfo.LogicalCores} 线程 · {hwInfo.TotalRamGb}GB"));

        // 5) 资产
        var summary = assets.Summary();
        var assetDetail = string.Join(" · ", summary.OrderBy(kv => kv.Key)
            .Select(kv => $"{Translate(kv.Key)} {kv.Value}"));
        items.Add(new DoctorItem("资产扫描", summary.Count > 0, assetDetail.Length > 0 ? assetDetail : "未发现任何资产（检查 D:\\dev\\7d 资产目录）"));

        return new DoctorReport(items, hwInfo);
    }

    private async Task<DoctorItem> CheckEngineVersionAsync(string name, string exe, string prefix, CancellationToken ct)
    {
        if (!File.Exists(exe))
        {
            return new DoctorItem($"引擎·{name}", false, $"文件不存在：{exe}");
        }

        var r = await pool.RunAsync(new ProcessRequest(exe, "-hide_banner -version", TimeoutSec: 30), ct: ct).ConfigureAwait(false);
        var firstLine = (r.Stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault() ?? string.Empty);
        return new DoctorItem($"引擎·{name}", r.ExitCode == 0 && firstLine.Contains(prefix, StringComparison.Ordinal), firstLine);
    }

    private static string Translate(AssetKind kind) => kind switch
    {
        AssetKind.Lut => "LUT",
        AssetKind.Sticker => "贴纸",
        AssetKind.EffectVideo => "特效视频",
        AssetKind.EffectGif => "特效动图",
        AssetKind.Border => "边框",
        AssetKind.Mask => "蒙层",
        AssetKind.Font => "字体",
        AssetKind.Transition => "转场",
        AssetKind.BgmPreset => "BGM预设",
        AssetKind.BgmLibrary => "BGM自产",
        _ => kind.ToString(),
    };
}
