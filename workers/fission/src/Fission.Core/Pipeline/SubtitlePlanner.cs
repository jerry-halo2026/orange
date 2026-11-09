using System.Globalization;
using System.Text;

namespace Fission.Core.Pipeline;

/// <summary>
/// 口播文案 → ASS 字幕（烧录进成片）。
/// 时间轴无字级时间戳时的近似：按句号/叹号/问号/分号/换行切句，每句时长 ∝ 字数（总长=成片时长）。
/// 样式预设对齐原版「随机字幕样式」族的常用四款；字级时间戳入库后可升级精确卡拉OK。
/// </summary>
public static class SubtitlePlanner
{
    /// <summary>生成完整 ASS 文本。</summary>
    /// <param name="text">口播全文。</param>
    /// <param name="totalSec">成片总时长（字幕铺满）。</param>
    /// <param name="style">样式预设（white-outline / yellow-outline / white-box / center-bold）。</param>
    /// <param name="pos">位置（top / middle / bottom）。</param>
    /// <param name="fontSize">字号。</param>
    public static string BuildAss(string text, double totalSec, string style, string pos, int fontSize)
        => BuildAss(BuildCues(text, totalSec), style, pos, fontSize);

    /// <summary>Render exactly the cues stored in the edit decision receipt.</summary>
    public static string BuildAss(IReadOnlyList<SubtitleCue> cues, string style, string pos, int fontSize)
    {
        var sb = new StringBuilder();
        _ = sb.Append("[Script Info]\n");
        _ = sb.Append("ScriptType: v4.00+\n");
        _ = sb.Append("PlayResX: 1080\nPlayResY: 1920\n");
        _ = sb.Append("WrapStyle: 0\nScaledBorderAndShadow: yes\n\n");
        _ = sb.Append("[V4+ Styles]\n");
        _ = sb.Append("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n");
        _ = sb.Append(StyleLine(style, pos, fontSize)).Append('\n');
        _ = sb.Append("\n[Events]\n");
        _ = sb.Append("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

        foreach (var cue in cues)
        {
            _ = sb.Append("Dialogue: 0,").Append(Ts(cue.StartSec)).Append(',').Append(Ts(cue.EndSec))
                .Append(",Default,,0,0,0,,{\\fad(120,120)}").Append(Escaped(cue.Text)).Append('\n');
        }

        return sb.ToString();
    }

    /// <summary>The original sentence-weighted timings, shared by ASS and edit receipts; not ASR.</summary>
    public static IReadOnlyList<SubtitleCue> BuildCues(string text, double totalSec)
    {
        var sentences = Split(text);
        var cues = new List<SubtitleCue>();
        var totalChars = sentences.Sum(s => s.Length);
        var t = 0.0;
        for (var i = 0; i < sentences.Count; i++)
        {
            var share = totalChars == 0 ? 1.0 / sentences.Count : (double)sentences[i].Length / totalChars;
            var dur = Math.Max(share * totalSec, 0.6);
            var start = t;
            var end = i == sentences.Count - 1 ? totalSec : Math.Min(start + dur, totalSec);
            if (end - start < 0.2) continue;
            cues.Add(new SubtitleCue(start, end, sentences[i]));
            t = end;
            if (t >= totalSec - 0.05) break;
        }
        return cues.AsReadOnly();
    }
    /// <summary>切句（保留标点；空句丢弃）。</summary>
    public static IReadOnlyList<string> Split(string text)
    {
        var parts = new List<string>();
        var buf = new StringBuilder();
        foreach (var ch in text)
        {
            _ = buf.Append(ch);
            if (ch is '。' or '！' or '？' or '!' or '?' or ';' or '；' or '\n')
            {
                var s = buf.ToString().Trim();
                if (s.Length > 0)
                {
                    parts.Add(s);
                }

                _ = buf.Clear();
            }
        }

        var tail = buf.ToString().Trim();
        if (tail.Length > 0)
        {
            parts.Add(tail);
        }

        return parts;
    }

    /// <summary>ASS Style 行（预设 × 位置）。</summary>
    public static string StyleLine(string style, string pos, int fontSize)
    {
        var (primary, borderStyle, outline, bold) = style switch
        {
            "yellow-outline" => ("&H0000D7FF", 1, 3, 0), // 金黄字+黑边
            "white-box" => ("&H00FFFFFF", 3, 2, 0),      // 白字+半透明底盒
            "center-bold" => ("&H00FFFFFF", 1, 2, -1),   // 加粗大号
            _ => ("&H00FFFFFF", 1, 3, 0),                // white-outline 默认
        };

        var size = style == "center-bold" ? (int)(fontSize * 1.2) : fontSize;
        var (alignment, marginV) = pos switch
        {
            "top" => (8, 120),
            "middle" => (5, 0),
            _ => (2, 140),
        };

        return $"Style: Default,Microsoft YaHei,{size},{primary},&H000000FF,&H00000000,&H66000000,{bold},0,0,0,100,100,0,0,{borderStyle},{outline},1,{alignment},40,40,{marginV},1";
    }

    private static string Ts(double sec)
    {
        var s = Math.Max(sec, 0);
        var h = (int)(s / 3600);
        var m = (int)(s % 3600 / 60);
        var sec2 = s % 60;
        return $"{h}:{m:D2}:{sec2.ToString("00.00", CultureInfo.InvariantCulture)}";
    }

    private static string Escaped(string s) => s.Replace("{", "｛").Replace("}", "｝").Replace("\n", "\\N");
}
