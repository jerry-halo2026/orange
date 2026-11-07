namespace Fission.Core.Pipeline;

/// <summary>切片段：源文件内的起点与时长。</summary>
/// <param name="StartSec">起点（秒，含）。</param>
/// <param name="DurationSec">时长（秒）。</param>
public sealed record CutSpan(double StartSec, double DurationSec);

/// <summary>
/// 分割规划（纯数学，ffmpeg 无关 —— 单测友好；镜头差分的检测在 Providers/SceneDetector）。
/// </summary>
public static class SplitPlanner
{
    /// <summary>平均 N 片。</summary>
    public static IReadOnlyList<CutSpan> AveragePieces(double durationSec, int pieces)
    {
        if (pieces < 1 || durationSec <= 0)
        {
            return [];
        }

        var per = durationSec / pieces;
        return Enumerable.Range(0, pieces).Select(i => new CutSpan(i * per, per)).ToList();
    }

    /// <summary>按秒平均（尾段不足即短）。</summary>
    public static IReadOnlyList<CutSpan> BySeconds(double durationSec, double sec)
    {
        if (sec <= 0 || durationSec <= 0)
        {
            return [];
        }

        var list = new List<CutSpan>();
        for (var s = 0.0; s < durationSec; s += sec)
        {
            list.Add(new CutSpan(s, Math.Min(sec, durationSec - s)));
        }

        return list;
    }

    /// <summary>随机区间 a–b 秒（a==b 固定；a&gt;b 自动交换）。</summary>
    public static IReadOnlyList<CutSpan> RandomRange(double durationSec, double minSec, double maxSec, Random rng)
    {
        var (lo, hi) = minSec <= maxSec ? (minSec, maxSec) : (maxSec, minSec);
        if (durationSec <= 0 || hi <= 0)
        {
            return [];
        }

        var list = new List<CutSpan>();
        var s = 0.0;
        while (s < durationSec)
        {
            var seg = lo >= hi ? lo : lo + (rng.NextDouble() * (hi - lo));
            list.Add(new CutSpan(s, Math.Min(seg, durationSec - s)));
            s += seg;
        }

        return list;
    }

    /// <summary>最短场景合并（PRD FR-3.1：不足 minDur 并入下一片段，尾段并入前段）与最长场景内切。</summary>
    public static IReadOnlyList<CutSpan> ApplyMinMax(IReadOnlyList<CutSpan> cuts, double minSec, double maxSec)
    {
        if (cuts.Count == 0)
        {
            return [];
        }

        // 最长内切
        var expanded = new List<CutSpan>();
        foreach (var c in cuts)
        {
            if (maxSec > 0 && c.DurationSec > maxSec)
            {
                var n = (int)Math.Ceiling(c.DurationSec / maxSec);
                expanded.AddRange(AveragePieces(c.DurationSec, n).Select(p => new CutSpan(c.StartSec + p.StartSec, p.DurationSec)));
            }
            else
            {
                expanded.Add(c);
            }
        }

        // 最短合并
        if (minSec <= 0)
        {
            return expanded;
        }

        var merged = new List<CutSpan> { expanded[0] };
        foreach (var c in expanded.Skip(1))
        {
            if (merged[^1].DurationSec < minSec)
            {
                merged[^1] = merged[^1] with { DurationSec = merged[^1].DurationSec + c.DurationSec };
            }
            else
            {
                merged.Add(c);
            }
        }

        if (merged.Count > 1 && merged[^1].DurationSec < minSec)
        {
            merged[^2] = merged[^2] with { DurationSec = merged[^2].DurationSec + merged[^1].DurationSec };
            merged.RemoveAt(merged.Count - 1);
        }

        return merged;
    }
}
