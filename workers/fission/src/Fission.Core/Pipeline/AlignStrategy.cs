using System.Diagnostics;

namespace Fission.Core.Pipeline;

/// <summary>对齐动作。</summary>
public enum AlignAction
{
    /// <summary>裁掉（-t 截断到目标）。</summary>
    Trim,
    /// <summary>变速（atempo 链，变速不变调）。</summary>
    Speed,
    /// <summary>循环垫底（-stream_loop + -t）。</summary>
    Loop,
}

/// <summary>对齐决策结果。</summary>
/// <param name="Action">动作。</param>
/// <param name="OutDurationSec">结果时长（=目标）。</param>
/// <param name="Tempo">atempo 总倍速（Speed 时 L/R）。</param>
/// <param name="AtempoChain">ffmpeg atempo 滤镜串（如 atempo=2.0,atempo=1.5）。</param>
/// <param name="Loops">Loop 时循环次数。</param>
public sealed record AlignPlan(AlignAction Action, double OutDurationSec, double Tempo, string AtempoChain, int Loops);

/// <summary>
/// 八策略对齐（docs/contracts/align-strategies.json 真值表的代码实现；单测表驱动对齐契约）。
/// atempo 单次有效域 [0.5,2.0]，超界自动链。
/// 类名 AlignPlanner（避免与 Jobs.AlignStrategy 枚举歧义）。
/// </summary>
public static class AlignPlanner
{
    /// <summary>按策略号与 L/R 计算动作（契约示例同源）。</summary>
    public static AlignPlan Plan(int strategy, double videoSec, double targetSec)
    {
        if (videoSec <= 0 || targetSec <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(videoSec), "时长必须为正");
        }

        var lgt = videoSec > targetSec;
        var action = (strategy, lgt) switch
        {
            (1, _) => AlignAction.Trim,
            (2, true) => AlignAction.Speed,
            (2, false) => AlignAction.Trim,
            (3, true) => AlignAction.Loop,
            (3, false) => AlignAction.Trim,
            (4, _) => AlignAction.Speed,
            (5, true) => AlignAction.Loop,
            (5, false) => AlignAction.Speed,
            (6, true) => AlignAction.Trim,
            (6, false) => AlignAction.Speed,
            (7, true) => AlignAction.Trim,
            (7, false) => AlignAction.Loop,
            (8, true) => AlignAction.Speed,
            (8, false) => AlignAction.Loop,
            _ => throw new ArgumentOutOfRangeException(nameof(strategy), "策略号 1–8"),
        };

        return action switch
        {
            AlignAction.Trim => new AlignPlan(AlignAction.Trim, Math.Min(videoSec, targetSec), 1, string.Empty, 1),
            AlignAction.Speed => BuildSpeed(videoSec, targetSec),
            AlignAction.Loop => new AlignPlan(AlignAction.Loop, targetSec, 1, string.Empty, (int)Math.Ceiling(targetSec / videoSec)),
            _ => throw new UnreachableException(),
        };
    }

    /// <summary>atempo 链构造（PRD FR-4.3）。</summary>
    public static AlignPlan BuildSpeed(double videoSec, double targetSec)
    {
        var tempo = videoSec / targetSec;
        var chain = AtempoChain(tempo);
        return new AlignPlan(AlignAction.Speed, targetSec, tempo, chain, 1);
    }

    /// <summary>x 超出 [0.5,2.0] 时拆链：x&gt;2 → [2, x/2]；x&lt;0.5 → [0.5, x/0.5]（递归）。</summary>
    public static string AtempoChain(double tempo)
    {
        var parts = new List<string>();
        double t = tempo;
        while (t > 2.0)
        {
            parts.Add("atempo=2.0");
            t /= 2.0;
        }

        while (t < 0.5)
        {
            parts.Add("atempo=0.5");
            t /= 0.5;
        }

        parts.Add($"atempo={t.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture)}");
        return string.Join(',', parts);
    }

    /// <summary>帧级对齐断言容差（PRD FR-7.2 AC：目标 ±1 帧）。</summary>
    public static double FrameToleranceSec(int fps) => 1.0 / Math.Max(fps, 1);
}
