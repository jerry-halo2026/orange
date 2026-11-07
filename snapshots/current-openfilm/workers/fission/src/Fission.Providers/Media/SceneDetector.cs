using System.Globalization;
using System.Text.RegularExpressions;
using Fission.Core.Abstractions;
using Fission.Core.Engine;
using Fission.Core.Pipeline;
using Fission.Core.Process;

namespace Fission.Providers.Media;

/// <summary>镜头分割检测：ffmpeg scene 差分（低分辨率加速）+ showinfo 时间戳解析（PRD FR-3.1）。</summary>
public sealed partial class SceneDetector(EnginePaths paths, IVideoEngine engine)
{
    /// <summary>检测镜头边界，返回切片段（含 minDur/maxDur 合并规则）。</summary>
    /// <param name="file">归一化后的素材（CFR）。</param>
    /// <param name="durationSec">时长（避免二次探测）。</param>
    /// <param name="threshold">精度阈值 0.01–0.99（默认 0.3，越小越精细）。</param>
    /// <param name="minSec">最短场景时长。</param>
    /// <param name="maxSec">最长场景时长。</param>
    /// <param name="ct">取消令牌。</param>
    public async Task<IReadOnlyList<CutSpan>> DetectAsync(string file, double durationSec, double threshold, double minSec, double maxSec, CancellationToken ct = default)
    {
        // 1/4 面积解码做差分（阈值检测不需要全分辨率，约 4x 快）；showinfo 在 select 之后，仅场景切换帧打点（stderr 捕获）
        var args =
            $"-i \"{file}\" -vf \"scale=iw/2:ih/2,select='gt(scene,{threshold.ToString("F2", CultureInfo.InvariantCulture)})',showinfo\" " +
            $"-an -f null -";
        var result = await engine.RunAsync(new VideoEngineRequest(paths.FFmpeg, args, durationSec), ct: ct).ConfigureAwait(false);

        var bounds = new List<double> { 0 };
        foreach (var m in PtsTimeRegex().Matches(result.StderrTail).Cast<Match>())
        {
            if (double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var t) && t > 0.3 && t < durationSec - 0.3)
            {
                bounds.Add(t);
            }
        }

        bounds.Add(durationSec);

        var cuts = new List<CutSpan>();
        for (var i = 0; i < bounds.Count - 1; i++)
        {
            var d = bounds[i + 1] - bounds[i];
            if (d > 0.05)
            {
                cuts.Add(new CutSpan(bounds[i], d));
            }
        }

        return SplitPlanner.ApplyMinMax(cuts, minSec, maxSec);
    }

    [GeneratedRegex(@"pts_time:([\d.]+)")]
    private static partial Regex PtsTimeRegex();
}
