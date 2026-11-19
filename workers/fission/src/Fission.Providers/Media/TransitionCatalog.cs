// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using Fission.Core.Util;

namespace Fission.Providers.Media;

/// <summary>
/// 66 个 GLSL 转场目录（gl-transitions 着色器集；RE 实测 filter 参数 duration/offset/source）。
/// 名单 = 注入目录里的文件名（不含扩展）；缺失名回落 fade（契约 RUN_TRANSITION_FALLBACK 语义）。
/// 单引擎（FFmpeg 9.x）下 gltransition 缺失时，按 <see cref="XfadeMap"/> 映射到内置 xfade 转场；
/// 映射表逐条依据见 docs/transitions-ffmpeg9.md。
/// </summary>
public static class TransitionCatalog
{
    /// <summary>
    /// gltransition 名 → FFmpeg 9.x xfade 转场名。只收进视觉族一致、可自动降级的条目；
    /// 需预渲染/不支持的转场不进此表，运行时按"能力探测 + 显式回落"处理。
    /// </summary>
    public static IReadOnlyDictionary<string, string> XfadeMap { get; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["fade"] = "fade",
        ["fadecolor"] = "fadeblack",
        ["fadegrayscale"] = "fadegrays",
        ["circle"] = "circleopen",
        ["circleopen"] = "circleopen",
        ["CircleCrop"] = "circlecrop",
        ["RectangleCrop"] = "rectcrop",
        ["Rectangle"] = "rectcrop",
        ["Radial"] = "radial",
        ["HorizontalClose"] = "vertclose",
        ["HorizontalOpen"] = "vertopen",
        ["VerticalClose"] = "horzclose",
        ["VerticalOpen"] = "horzopen",
        ["wipeLeft"] = "wipeleft",
        ["wipeUp"] = "wipeup",
        ["wipeDown"] = "wipedown",
        ["LeftRight"] = "slideleft",
        ["TopBottom"] = "slidedown",
        ["Slides"] = "slideleft",
        ["squeeze"] = "squeezev",
        ["scale-in"] = "zoomin",
        ["SimpleZoom"] = "zoomin",
        ["x_axis_translation"] = "slideleft",
    };

    /// <summary>列出全部转场名（目录缺失=仅 fade）。</summary>
    public static IReadOnlyList<string> List(string transitionsDir)
    {
        if (!Directory.Exists(transitionsDir))
        {
            return ["fade"];
        }

        var names = Directory.EnumerateFiles(transitionsDir, "*.glsl")
            .Select(Path.GetFileNameWithoutExtension)
            .Where(n => n is not null)
            .Cast<string>()
            .Order(StringComparer.OrdinalIgnoreCase)
            .ToList();
        return names.Count > 0 ? names : ["fade"];
    }

    /// <summary>解析转场：random=按 rng 随机；显式名存在→路径；不存在→fade 回落（out fallback=true）。</summary>
    /// <param name="transitionsDir">GLSL 目录。</param>
    /// <param name="name">转场名或 "random"。</param>
    /// <param name="rng">随机源（SeededRandom）。</param>
    /// <param name="fallback">true=名未命中回落 fade。</param>
    public static (string Path, string Name, bool Fallback) Resolve(string transitionsDir, string name, SeededRandom rng)
    {
        var names = List(transitionsDir);
        if (string.Equals(name, "random", StringComparison.OrdinalIgnoreCase))
        {
            var pick = names[rng.Next(names.Count)];
            return (System.IO.Path.Combine(transitionsDir, pick + ".glsl"), pick, false);
        }

        var want = names.FirstOrDefault(n => string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) ?? "fade";
        return (System.IO.Path.Combine(transitionsDir, want + ".glsl"), want, !string.Equals(want, name, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>该转场名能否映射到 FFmpeg 9.x 内置 xfade。</summary>
    /// <param name="name">gltransition 名（可为 null）。</param>
    /// <param name="xfade">映射到的 xfade 转场名。</param>
    public static bool TryMapToXfade(string? name, out string xfade)
    {
        if (name is not null && XfadeMap.TryGetValue(name, out var mapped))
        {
            xfade = mapped;
            return true;
        }

        xfade = string.Empty;
        return false;
    }

    /// <summary>
    /// 按探测到的能力选择转场后端：gltransition（注入且滤镜可用）→ xfade 映射 → null（显式回落，绝不静默）。
    /// </summary>
    /// <param name="capability">能力探测结果。</param>
    /// <param name="name">已解析的转场名。</param>
    /// <param name="shaderPath">GLSL 着色器绝对路径（仅 gltransition 用）。</param>
    /// <param name="paths">引擎路径（决定 FFmpeg6/FFmpeg 谁执行）。</param>
    public static TransitionBackend? SelectBackend(TransitionCapability capability, string? name, string shaderPath, Fission.Core.Engine.EnginePaths paths)
    {
        ArgumentNullException.ThrowIfNull(capability);
        ArgumentNullException.ThrowIfNull(paths);
        if (capability.GlTransition && !string.IsNullOrEmpty(shaderPath))
        {
            return new TransitionBackend(TransitionBackendKind.GlTransition, paths.FFmpeg6, shaderPath, "applied",
                $"gltransition 后端（{name ?? "fade"}）");
        }

        if (capability.Xfade && TryMapToXfade(name, out var xfade))
        {
            return new TransitionBackend(TransitionBackendKind.Xfade, paths.FFmpeg, xfade, "applied-xfade",
                $"gltransition 可选能力缺失，降级 xfade={xfade}（{name}）");
        }

        return null;
    }
}
