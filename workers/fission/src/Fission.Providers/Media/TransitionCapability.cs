// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using Fission.Core.Abstractions;
using Fission.Core.Engine;
using Fission.Core.Errors;

namespace Fission.Providers.Media;

/// <summary>转场后端能力探测结果（一次运行内缓存）。</summary>
/// <param name="GlTransition">FFmpeg6 的 gltransition 滤镜是否可用。</param>
/// <param name="Xfade">主引擎的 xfade 滤镜是否可用（FFmpeg 9.x 均有）。</param>
/// <param name="Detail">面向操作员的探测说明（含"可选能力缺失"措辞）。</param>
public sealed record TransitionCapability(bool GlTransition, bool Xfade, string Detail)
{
    /// <summary>两种后端都不可用。</summary>
    public static TransitionCapability None(string detail) => new(false, false, detail);

    /// <summary>是否至少有一条可用后端。</summary>
    public bool Any => GlTransition || Xfade;
}

/// <summary>
/// 转场能力探测：只读执行 <c>ffmpeg -filters</c>，不写产物、不消耗 RNG。
/// gltransition 缺失是"可选能力缺失"而非失败；xfade 缺失才代表 9.x 单引擎也接不住转场。
/// </summary>
public static class TransitionEngineProbe
{
    private const int ProbeTimeoutSec = 30;

    /// <summary>探测当前配置下的转场后端。</summary>
    /// <param name="paths">已注入的引擎路径。</param>
    /// <param name="engine">唯一执行通道（IVideoEngine）。</param>
    /// <param name="ct">取消令牌。</param>
    public static async Task<TransitionCapability> DetectAsync(EnginePaths paths, IVideoEngine engine, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(paths);
        ArgumentNullException.ThrowIfNull(engine);
        var notes = new List<string>(2);
        var gl = false;
        if (paths.HasFFmpeg6)
        {
            var listing = await FiltersAsync(engine, paths.FFmpeg6, ct).ConfigureAwait(false);
            gl = listing is not null && HasFilter(listing, "gltransition");
            notes.Add(gl ? "gltransition 可用（FFmpeg6）" : "FFmpeg6 未提供 gltransition 滤镜");
        }
        else
        {
            notes.Add("未注入 FFmpeg6：gltransition 可选能力缺失");
        }

        var xfadeListing = await FiltersAsync(engine, paths.FFmpeg, ct).ConfigureAwait(false);
        var xfade = xfadeListing is not null && HasFilter(xfadeListing, "xfade");
        notes.Add(xfade ? $"xfade 可用（{TransitionCatalog.XfadeMap.Count} 个转场可映射）" : "FFmpeg 无 xfade 滤镜");
        return new TransitionCapability(gl, xfade, string.Join("；", notes));
    }

    /// <summary>在 <c>ffmpeg -filters</c> 输出里按滤镜名精确匹配（列 2 为滤镜名）。</summary>
    /// <param name="listing">-filters 的标准输出。</param>
    /// <param name="name">滤镜名（如 xfade / gltransition）。</param>
    public static bool HasFilter(string listing, string name)
    {
        if (string.IsNullOrEmpty(listing)) return false;
        foreach (var line in listing.Split('\n'))
        {
            var tokens = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (tokens.Length >= 3 && string.Equals(tokens[1], name, StringComparison.Ordinal)) return true;
        }

        return false;
    }

    private static async Task<string?> FiltersAsync(IVideoEngine engine, string executable, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(executable)) return null;
        try
        {
            var result = await engine.RunAsync(
                new VideoEngineRequest(executable, "-hide_banner -filters", TimeoutSec: ProbeTimeoutSec), ct: ct).ConfigureAwait(false);
            return result.ExitCode == 0 ? result.Stdout : null;
        }
        catch (FissionException)
        {
            // 引擎不可执行/被取消：按"能力缺失"处理，由调用方走显式降级路径。
            return null;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }
}

/// <summary>转场后端种类。</summary>
public enum TransitionBackendKind
{
    /// <summary>FFmpeg6 + gltransition GLSL 着色器（原路径）。</summary>
    GlTransition,

    /// <summary>FFmpeg 9.x xfade（单引擎降级路径）。</summary>
    Xfade,
}

/// <summary>一次转场执行所选后端。</summary>
/// <param name="Kind">后端种类。</param>
/// <param name="Engine">执行该后端的可执行文件。</param>
/// <param name="Filter">gltransition 用着色器路径；xfade 用转场名。</param>
/// <param name="Outcome">编辑回执里的转场 outcome。</param>
/// <param name="Detail">面向操作员的原因说明。</param>
public sealed record TransitionBackend(TransitionBackendKind Kind, string Engine, string Filter, string Outcome, string Detail);
