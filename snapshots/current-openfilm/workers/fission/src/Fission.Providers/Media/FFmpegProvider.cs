using Fission.Core.Abstractions;
using Fission.Core.Engine;
using Fission.Core.Errors;
using Fission.Core.Process;

namespace Fission.Providers.Media;

/// <summary>视频引擎执行器：一切 ffmpeg/ffmpeg6 调用的唯一实现通道（PRD §8.3）。</summary>
public sealed class FFmpegProvider(ProcessPool pool) : IVideoEngine
{
    /// <inheritdoc/>
    public async Task<ProcessResult> RunAsync(VideoEngineRequest request, Action<double>? onProgress = null, CancellationToken ct = default)
    {
        var pr = new ProcessRequest(request.EngineFileName, request.Arguments, request.TotalDurationSec, request.TimeoutSec);
        var result = await pool.RunAsync(pr, onProgress, ct).ConfigureAwait(false);
        if (result.ExitCode != 0)
        {
            throw new EngineException(
                "ENC_FFMPEG_EXIT",
                $"引擎退出码 {result.ExitCode}（{Path.GetFileName(request.EngineFileName)}）{Environment.NewLine}{result.StderrTail}",
                retryable: false);
        }

        return result;
    }

    /// <summary>构建归一化命令（PRD 源归一化段：统一分辨率/编码/CFR/像素格式/丢原音轨）。</summary>
    /// <summary>构建归一化命令（PRD 源归一化段：统一分辨率/编码/CFR/像素格式/丢原音轨）。
    /// 分辨率锁盒：等比内接缩放 + 黑边 pad 居中——横版/异比例源也统一到 WxH（实测教训：只锁高会把横版源缩成 3414×1920，破坏等规格拼接与转场链）。</summary>
    /// <param name="input">源文件。</param>
    /// <param name="output">产物 mp4。</param>
    /// <param name="width">目标宽。</param>
    /// <param name="height">目标高。</param>
    /// <param name="useNvenc">true=h264_nvenc（硬编），false=libx264 veryfast。</param>
    /// <param name="hwDecode">true=CUDA 硬解码（帧回系统内存做滤镜，规避本 gyan 构建无 libnpp 的 hw 滤镜格式协商问题），false=纯软解。</param>
    public static string BuildNormalizeArgs(string input, string output, int width, int height, int fps, bool useNvenc, bool hwDecode)
    {
        var vcodec = useNvenc ? "h264_nvenc -preset p4 -rc vbr -cq 23" : "libx264 -preset veryfast -crf 23";
        var hw = hwDecode ? "-hwaccel cuda " : string.Empty;
        return
            $"-y {hw}-i \"{input}\" " +
            $"-vf \"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,fps={fps},format=yuv420p\" " +
            $"-map 0:v:0 -an -c:v {vcodec} " +
            $"-pix_fmt yuv420p -movflags +faststart \"{output}\"";
    }
}
