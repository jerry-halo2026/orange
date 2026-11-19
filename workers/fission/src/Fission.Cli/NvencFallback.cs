// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using System.Diagnostics;
using System.Text.RegularExpressions;

namespace Fission.Cli;

/// <summary>
/// 只识别一种失败：显卡驱动支持的 nvenc API 版本低于编码器要求的版本。
/// 命中时由调用方改用 CPU 编码一次；任何其它错误一律不降级，避免掩盖真实故障。
/// </summary>
public static partial class NvencFallback
{
    [GeneratedRegex(@"Driver does not support the required nvenc API version\.\s*Required:\s*(?<required>[\d.]+)\s*Found:\s*(?<found>[\d.]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Signature();

    /// <summary>纯分类：判定给定的 stderr 是否就是“驱动 nvenc API 过低”。</summary>
    public static bool TryClassify(string? stderr, out string detail)
    {
        detail = string.Empty;
        if (string.IsNullOrEmpty(stderr)) return false;
        var match = Signature().Match(stderr);
        if (!match.Success) return false;
        detail = $"driver={match.Groups["found"].Value} required={match.Groups["required"].Value}";
        return true;
    }

    /// <summary>
    /// 用一次极小尺寸的空编码探测当前驱动能否真的用 h264_nvenc。
    /// 只把签名匹配的失败当作“需要回退”；探测本身出错（找不到 ffmpeg 等）不改变原行为。
    /// </summary>
    public static (bool Fallback, string Detail) Probe(string ffmpeg)
    {
        try
        {
            var info = new ProcessStartInfo(ffmpeg)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var argument in new[]
            {
                "-hide_banner", "-loglevel", "error", "-nostdin",
                "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.04",
                "-c:v", "h264_nvenc", "-frames:v", "1", "-f", "null", "-",
            }) info.ArgumentList.Add(argument);

            using var process = Process.Start(info);
            if (process is null) return (false, string.Empty);
            var stderr = process.StandardError.ReadToEnd();
            if (!process.WaitForExit(15000))
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                return (false, string.Empty);
            }

            return TryClassify(stderr, out var detail) ? (true, detail) : (false, string.Empty);
        }
        catch (Exception) { return (false, string.Empty); }
    }
}
