using System.Text;
using Fission.Core.Jobs;
using Fission.Core.Pipeline;

namespace Fission.Providers.Media;

/// <summary>
/// ffmpeg 命令构建器（阶段级；全部经 IVideoEngine 执行）。
/// 并发约束：threads 钳制 16/并发数，防 20+ 路时 CPU 超售。
/// </summary>
public static class CommandBuilders
{
    /// <summary>精确切段（归一化源上 re-encode 切，保证帧精度；hflip 差异化与组变速在此一并做，减少一遍编码）。</summary>
    /// <param name="speed">组变速倍率（1=不变；&gt;1 加速；原版下限 0.5，低于由引擎舍弃该文件）。</param>
    public static string Cut(string src, string dst, CutSpan span, bool hflip, bool nvenc, int encThreads, double speed = 1.0)
    {
        var vcodec = nvenc ? $"h264_nvenc -preset p4 -rc vbr -cq 23" : $"libx264 -preset veryfast -crf 23 -threads {encThreads}";
        var parts = new List<string>(3);
        if (hflip)
        {
            parts.Add("hflip");
        }

        if (Math.Abs(speed - 1.0) > 0.001)
        {
            parts.Add($"setpts=PTS/{speed:0.####}");
        }

        parts.Add("format=yuv420p");
        return
            $"-y -ss {span.StartSec:F3} -t {span.DurationSec:F3} -accurate_seek -i \"{src}\" " +
            $"-vf \"{string.Join(",", parts)}\" -map 0:v:0 -an -c:v {vcodec} " +
            $"-pix_fmt yuv420p -avoid_negative_ts make_zero \"{dst}\"";
    }

    /// <summary>图转视频（IMG2VID：loop 静图→定长视频；黑边 pad 到输出规格；时长由调用方按区间随机或固定——原版「可设置相同的两个数 即不随机时长」）。</summary>
    public static string ImageToVideo(string src, string dst, double durSec, int width, int height, int fps, bool nvenc, int encThreads)
    {
        var vcodec = nvenc ? "h264_nvenc -preset p4 -rc vbr -cq 23" : $"libx264 -preset veryfast -crf 23 -threads {encThreads}";
        var vf = $"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,fps={fps},format=yuv420p";
        return
            $"-y -loop 1 -i \"{src}\" -t {durSec:F2} -vf \"{vf}\" -map 0:v:0 -an " +
            $"-c:v {vcodec} -pix_fmt yuv420p -r {fps} \"{dst}\"";
    }

    /// <summary>concat demuxer 无损拼接（统一规格前提：全部产物来自 Cut/Normalize 同参）。</summary>
    public static string Concat(IReadOnlyList<string> files, string dst)
    {
        var list = Path.ChangeExtension(dst, ".txt");
        File.WriteAllLines(list, files.Select(f => $"file '{f.Replace("'", "'\\''")}'"), new System.Text.UTF8Encoding(false));
        return $"-y -f concat -safe 0 -i \"{list}\" -c copy -movflags +faststart \"{dst}\"";
    }

    /// <summary>
    /// 取片段尾部（转场素材；-sseof 免 probe）。
    /// </summary>
    /// <param name="src">源片段。</param>
    /// <param name="dst">尾段产物。</param>
    /// <param name="durSec">尾段时长。</param>
    public static string TakeTail(string src, string dst, double durSec)
    {
        var seek = -(durSec + 0.2);
        return
            $"-y -sseof {seek:0.###} -i \"{src}\" -t {durSec:0.###} -an " +
            $"-c:v libx264 -preset ultrafast -crf 20 -pix_fmt yuv420p \"{dst}\"";
    }

    /// <summary>
    /// 入片转场（ffmpeg6 gltransition；实测语义：输出=第二输入时长，[0,offset] 显示 a，[offset,offset+D] a→b 渐变）。
    /// 拼接用法=逐段做入片转场（a=上一段尾）再 concat——总时长精确不缩（实测教训：该构建多实例链/成对拼接会塌成单段时长）。
    /// </summary>
    /// <param name="tail">上一段尾部素材（渐变起点）。</param>
    /// <param name="seg">当前段（保全长）。</param>
    /// <param name="dst">产物。</param>
    /// <param name="durSec">转场时长。</param>
    /// <param name="glslPath">GLSL 着色器绝对路径。</param>
    public static string EntryTransition(string tail, string seg, string dst, double durSec, string glslPath)
    {
        var src = FilterPath(glslPath);
        return
            $"-y -i \"{tail}\" -i \"{seg}\" " +
            $"-filter_complex \"[0:v][1:v]gltransition=offset=0:duration={durSec:0.###}:source='{src}'[vt]\" -map \"[vt]\" -an " +
            $"-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +faststart \"{dst}\"";
    }

    /// <summary>字幕烧录（ass 滤镜；libass + fontsdir 显式指系统字体目录——静态构建 fontconfig 不扫系统字体，缺省静默空渲染）。</summary>
    public static string BurnSubtitle(string src, string dst, string assPath, bool nvenc, int encThreads, string fontsDir)
    {
        var vcodec = nvenc ? "h264_nvenc -preset p4 -rc vbr -cq 23" : $"libx264 -preset veryfast -crf 23 -threads {encThreads}";
        return
            $"-y -i \"{src}\" -vf \"ass=filename='{FilterPath(assPath)}':fontsdir='{FilterPath(fontsDir)}'\" -map 0:v:0 -map 0:a:0? " +
            $"-c:v {vcodec} -c:a copy -movflags +faststart \"{dst}\"";
    }

    /// <summary>滤镜内路径转义（正斜杠 + 冒号转义，filtergraph 安全）。</summary>
    public static string FilterPath(string path) => path.Replace('\\', '/').Replace(":", "\\:");

    /// <summary>时长对齐（三动作；Loop 用 stream_loop 垫底后 -t 截断）。</summary>
    public static string Align(string src, string dst, AlignPlan plan, bool nvenc, int encThreads)
    {
        var vcodec = nvenc ? "h264_nvenc -preset p4 -rc vbr -cq 23" : $"libx264 -preset veryfast -crf 23 -threads {encThreads}";
        return plan.Action switch
        {
            AlignAction.Trim =>
                $"-y -i \"{src}\" -t {plan.OutDurationSec:F3} -c:v copy -an \"{dst}\"",
            AlignAction.Speed =>
                $"-y -i \"{src}\" -vf \"{plan.AtempoChain}\" -map 0:v:0 -an -c:v {vcodec} -pix_fmt yuv420p \"{dst}\"",
            AlignAction.Loop =>
                $"-y -stream_loop {Math.Max(plan.Loops - 1, 0)} -i \"{src}\" -t {plan.OutDurationSec:F3} -map 0:v:0 -an -c:v copy \"{dst}\"",
            _ => throw new ArgumentOutOfRangeException(nameof(plan), "未知对齐动作"),
        };
    }

    /// <summary>音视频合并：配音（音量倍率+响度归一）+ 可选 BGM（循环垫底+音量）。</summary>
    public static string AvMerge(string video, string voice, string? bgm, string dst, FissionJob job)
    {
        var voiceInput = $"-i \"{voice}\"";
        var bgmInput = bgm is null ? string.Empty : $"-stream_loop -1 -i \"{bgm}\"";
        var bgmMap = bgm is null ? string.Empty : $"-map 2:a:0";
        var mix = bgm is null
            ? $"[1:a]volume={job.VoiceVolume:F2},loudnorm=I=-14:TP=-1.5:LRA=11[v]"
            : $"[1:a]volume={job.VoiceVolume:F2}[v0];[2:a]volume={job.BgmVolume:F2}[b0];[v0][b0]amix=inputs=2:duration=first:dropout_transition=3,loudnorm=I=-14:TP=-1.5:LRA=11[v]";
        return
            $"-y -i \"{video}\" {voiceInput} {bgmInput} " +
            $"-filter_complex \"{mix}\" -map 0:v:0 {bgmMap} -map \"[v]\" " +
            $"-c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart \"{dst}\"";
    }

    /// <summary>封面截图（PRD FR-8.6：-ss 定点 -q:v 2；封面最后加）。</summary>
    public static string Cover(string video, string jpg, double atSec) =>
        $"-y -ss {Math.Max(atSec, 0):F2} -i \"{video}\" -frames:v 1 -q:v 2 \"{jpg}\"";

    /// <summary>离线合成配音（lavfi；stress/无 key 模式）：正弦+调幅包络模拟口播节奏。</summary>
    public static string MakeVoice(string dst, double durationSec, int toneHz) =>
        $"-y -f lavfi -t {durationSec:F2} -i \"sine=frequency={toneHz}:sample_rate=44100\" " +
        $"-af \"volume=0.4,tremolo=f=2.5:d=0.7\" -c:a libmp3lame -b:a 128k \"{dst}\"";
}
