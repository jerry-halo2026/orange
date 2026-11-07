using Fission.Core.Util;

namespace Fission.Providers.Media;

/// <summary>
/// 66 GLSL 转场目录（D:\dev\7d\lib\*.glsl；RE 实测 filter 参数 duration/offset/source）。
/// 名单 = 目录文件名（不含扩展）；缺失名回落 fade（契约 RUN_TRANSITION_FALLBACK 语义）。
/// </summary>
public static class TransitionCatalog
{
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
}
