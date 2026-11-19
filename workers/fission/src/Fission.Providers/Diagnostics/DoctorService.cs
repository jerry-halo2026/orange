// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using System.Runtime.Versioning;
using Fission.Core.Engine;
using Fission.Core.Process;
using Fission.Providers.Assets;
using Fission.Providers.Hardware;
using Fission.Providers.Media;

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

/// <summary>
/// 环境体检：引擎存在性、引擎版本、转场能力、硬件、资产扫描（PRD §6.2 / FR-10 doctor）。仅支持 Windows。
/// 单引擎（FFmpeg 9.x）下 gltransition 是可选能力：缺失只报"可选能力缺失"，不判失败；
/// 转场是否会回落取决于 xfade 是否存在（见 docs/transitions-ffmpeg9.md）。
/// </summary>
[SupportedOSPlatform("windows7.0")]
public sealed class DoctorService(EnginePaths paths, ProcessPool pool, HardwareDetector hw, AssetRegistry assets)
{
    /// <summary>执行全部检查。</summary>
    public async Task<DoctorReport> RunAsync(CancellationToken ct = default)
    {
        var items = new List<DoctorItem>();

        // 1) 引擎文件（路径必须由调用方注入；缺失即配置错误，不猜默认路径）
        var missing = paths.ValidateEngines();
        items.Add(new DoctorItem("引擎文件", missing.Count == 0,
            missing.Count == 0
                ? $"ffmpeg / ffprobe / 转场目录 就绪（{paths.FFmpeg}{(paths.HasFFmpeg6 ? $"；可选 gltransition 引擎 {paths.FFmpeg6}" : "；未启用可选 gltransition 引擎")}）"
                : "缺失/未注入：" + string.Join("；", missing) + "。修复：由宿主注入引擎路径（FISSION_ENGINE_PATHS 指向的 JSON 或受控 --paths），不猜测默认路径"));

        // 2) 引擎可执行（取版本号顺带验证）
        items.Add(await CheckEngineVersionAsync("ffmpeg", paths.FFmpeg, "ffmpeg version", ct).ConfigureAwait(false));
        items.Add(string.IsNullOrWhiteSpace(paths.FFmpeg6)
            ? new DoctorItem("引擎·ffmpeg6(gl)", true, "可选能力缺失：未注入 FFmpeg6（gltransition 不可用；单引擎 9.x 路径照常，转场走 xfade 或明示回落）")
            : await CheckEngineVersionAsync("ffmpeg6(gl)", paths.FFmpeg6, "ffmpeg version", ct).ConfigureAwait(false));

        // 3) 转场能力：gltransition（可选，FFmpeg6）→ xfade（9.x 内置，降级路径）
        var glOk = paths.HasFFmpeg6 && await HasFilterAsync(paths.FFmpeg6, "gltransition", ct).ConfigureAwait(false);
        var xfadeOk = await HasFilterAsync(paths.FFmpeg, "xfade", ct).ConfigureAwait(false);
        var transitionDetail = glOk
            ? "gltransition 就绪（66 GLSL 通道可用）"
            : xfadeOk
                ? $"gltransition 可选能力缺失；xfade 可用，{TransitionCatalog.XfadeMap.Count} 个转场可自动降级，其余按 docs/transitions-ffmpeg9.md 回落"
                : "gltransition 缺失且 FFmpeg 无 xfade：转场将回落为直切（见 docs/transitions-ffmpeg9.md）";
        items.Add(new DoctorItem("转场能力", glOk || xfadeOk, transitionDetail));

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
        items.Add(new DoctorItem("资产扫描", summary.Count > 0, assetDetail.Length > 0 ? assetDetail : "未发现任何资产（检查注入的 AssetsRoot / LocalAssetsRoot 目录）"));

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

    private async Task<bool> HasFilterAsync(string exe, string filter, CancellationToken ct)
    {
        if (!File.Exists(exe)) return false;
        var r = await pool.RunAsync(new ProcessRequest(exe, "-hide_banner -filters", TimeoutSec: 30), ct: ct).ConfigureAwait(false);
        return TransitionEngineProbe.HasFilter(r.Stdout, filter);
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
