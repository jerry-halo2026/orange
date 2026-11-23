// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using Fission.Core.Errors;

namespace Fission.Core.Engine;

/// <summary>
/// 引擎与资产路径配置（唯一入口，禁止在业务代码硬编码绝对路径 —— PRD §10.2）。
/// 本类型不携带任何开发机默认值：路径必须由调用方显式注入（受控 CLI 的 --paths、
/// 宿主配置或 <see cref="EnginePathsSource"/>）；未注入即配置错误，绝不猜测路径。
/// FFmpeg6 是可选能力（gltransition GLSL 转场引擎）：缺省时引擎只用 FFmpeg，
/// 转场按 docs/transitions-ffmpeg9.md 的 xfade 映射降级，映射不到时显式回落。
/// </summary>
public sealed record EnginePaths
{
    /// <summary>转码/探测/合成引擎（9.x 单引擎）。空 = 未注入。</summary>
    public string FFmpeg { get; init; } = string.Empty;

    /// <summary>探测引擎。空 = 未注入。</summary>
    public string FFprobe { get; init; } = string.Empty;

    /// <summary>可选 gltransition 转场引擎。空 = 不启用 gltransition（不再是必需引擎）。</summary>
    public string FFmpeg6 { get; init; } = string.Empty;

    /// <summary>GLSL 转场着色器目录（转场定义的唯一来源；空 = 未注入）。</summary>
    public string TransitionsDir { get; init; } = string.Empty;

    /// <summary>原厂资产根（LUT/贴纸/蒙层/字体/特效视频）。空 = 未注入。</summary>
    public string AssetsRoot { get; init; } = string.Empty;

    /// <summary>自建资产根（BGM 预设/自产库、配音库）。空 = 未注入。</summary>
    public string LocalAssetsRoot { get; init; } = string.Empty;

    /// <summary>
    /// 字幕字体目录（libass 的 fontsdir）。空 = 未注入，由引擎回落到平台字体目录
    /// （Windows <see cref="Environment.SpecialFolder.Fonts"/>；macOS 该目录无效，必须显式给出）。
    /// </summary>
    public string FontsDir { get; init; } = string.Empty;

    /// <summary>工作目录根（受控运行由 EnginePathPolicy 按 task/attempt 派生）。空 = 未注入。</summary>
    public string WorkRoot { get; init; } = string.Empty;

    /// <summary>输出目录根（受控运行由 EnginePathPolicy 按 task/attempt 派生）。空 = 未注入。</summary>
    public string OutRoot { get; init; } = string.Empty;

    /// <summary>调用方是否注入可选 gltransition 引擎。</summary>
    public bool HasFFmpeg6 => !string.IsNullOrWhiteSpace(FFmpeg6);

    /// <summary>调用方是否注入字体目录（空 = 由引擎回落平台字体目录）。</summary>
    public bool HasFontsDir => !string.IsNullOrWhiteSpace(FontsDir);

    /// <summary>调用方必须注入的引擎/资产键（不含可选 FFmpeg6 与派生写根）。</summary>
    public static IReadOnlyList<string> RequiredKeys { get; } = ["FFmpeg", "FFprobe", "TransitionsDir", "AssetsRoot", "LocalAssetsRoot"];

    /// <summary>调用方可选注入的键；缺省即"未启用该能力"，不报配置错误。</summary>
    public static IReadOnlyList<string> OptionalKeys { get; } = ["FFmpeg6", "FontsDir"];

    /// <summary>非受控宿主（doctor/normalize/Web）额外必须注入的写根。</summary>
    public static IReadOnlyList<string> HostWriteRootKeys { get; } = ["WorkRoot", "OutRoot"];

    /// <summary>本次运行需要固定的引擎可执行（FFmpeg6 仅在注入后加入，缺少时不影响单引擎路径）。</summary>
    public IReadOnlyList<string> EngineExecutables()
        => HasFFmpeg6 ? [FFmpeg, FFprobe, FFmpeg6] : [FFmpeg, FFprobe];

    /// <summary>返回未注入的必需键名（空 = 全部注入）。</summary>
    public IReadOnlyList<string> UnconfiguredRequiredKeys()
    {
        var missing = new List<string>();
        foreach (var (key, value) in RequiredValues())
        {
            if (string.IsNullOrWhiteSpace(value)) missing.Add(key);
        }

        return missing;
    }

    /// <summary>必需键缺省即配置错误（CFG_ENGINE_PATHS）；不读任何默认路径。</summary>
    public void ValidateConfiguration()
    {
        var missing = UnconfiguredRequiredKeys();
        if (missing.Count == 0) return;
        throw new ConfigException("CFG_ENGINE_PATHS",
            $"引擎路径未注入：{string.Join("、", missing)}。必须由调用方提供（FISSION_ENGINE_PATHS 指向的 JSON 或宿主配置），不猜测默认路径。");
    }

    /// <summary>逐一校验引擎文件存在性，返回 缺失/未注入 列表（空 = 全部就绪）。可选 FFmpeg6 缺省不算缺失。</summary>
    public IReadOnlyList<string> ValidateEngines()
    {
        var missing = new List<string>();
        foreach (var key in UnconfiguredRequiredKeys())
        {
            missing.Add($"{key}（未注入）");
        }

        if (!string.IsNullOrWhiteSpace(FFmpeg) && !File.Exists(FFmpeg)) missing.Add(FFmpeg);
        if (!string.IsNullOrWhiteSpace(FFprobe) && !File.Exists(FFprobe)) missing.Add(FFprobe);
        if (HasFFmpeg6 && !File.Exists(FFmpeg6)) missing.Add(FFmpeg6);
        if (!string.IsNullOrWhiteSpace(TransitionsDir) && !Directory.Exists(TransitionsDir)) missing.Add(TransitionsDir);
        return missing;
    }

    private IEnumerable<(string Key, string Value)> RequiredValues()
    {
        yield return (nameof(FFmpeg), FFmpeg);
        yield return (nameof(FFprobe), FFprobe);
        yield return (nameof(TransitionsDir), TransitionsDir);
        yield return (nameof(AssetsRoot), AssetsRoot);
        yield return (nameof(LocalAssetsRoot), LocalAssetsRoot);
    }
}
