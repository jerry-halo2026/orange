using System.Text.Json;
using Fission.Core.Abstractions;
using Fission.Core.Engine;
using Fission.Core.Errors;
using Fission.Core.Process;

namespace Fission.Providers.Media;

/// <summary>ffprobe JSON 探测实现（IVideoEngine 同伴，供损坏检测与池统计）。</summary>
public sealed class FFprobeProvider(EnginePaths paths, ProcessPool pool) : IMediaProbe
{
    /// <inheritdoc/>
    public async Task<MediaInfo> ProbeAsync(string file, CancellationToken ct = default)
    {
        if (!File.Exists(file))
        {
            throw new MaterialException("MAT_CORRUPT_FILE_PREFIX", $"检测到损坏文件：{file}（不存在）");
        }

        var args = $"-v error -print_format json -show_format -show_streams \"{file}\"";
        var result = await pool.RunAsync(new ProcessRequest(paths.FFprobe, args, TimeoutSec: 60), ct: ct).ConfigureAwait(false);
        if (result.ExitCode != 0)
        {
            throw new MaterialException("MAT_CORRUPT_FILE_PREFIX", $"检测到损坏文件：{file}（ffprobe 退出码 {result.ExitCode}）{result.StderrTail}");
        }

        return Parse(result.Stdout, file);
    }

    /// <summary>解析 ffprobe JSON 输出为 <see cref="MediaInfo"/>（internal 供单测）。</summary>
    internal static MediaInfo Parse(string json, string fileForError)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        double duration = 0;
        if (root.TryGetProperty("format", out var fmt) && fmt.TryGetProperty("duration", out var dur) && dur.ValueKind == JsonValueKind.String)
        {
            duration = double.Parse(dur.GetString()!, System.Globalization.CultureInfo.InvariantCulture);
        }

        int width = 0, height = 0, sampleRate = 0;
        string vcodec = "none";
        string? acodec = null;
        double rFps = 0, avgFps = 0;
        var hasAudio = false;

        foreach (var stream in root.GetProperty("streams").EnumerateArray())
        {
            var codecType = stream.GetProperty("codec_type").GetString();
            if (codecType == "video" && width == 0)
            {
                vcodec = stream.GetProperty("codec_name").GetString() ?? "none";
                width = stream.TryGetProperty("width", out var w) ? w.GetInt32() : 0;
                height = stream.TryGetProperty("height", out var h) ? h.GetInt32() : 0;
                rFps = ParseRate(stream, "r_frame_rate");
                avgFps = ParseRate(stream, "avg_frame_rate");
            }
            else if (codecType == "audio" && !hasAudio)
            {
                hasAudio = true;
                acodec = stream.GetProperty("codec_name").GetString();
                if (stream.TryGetProperty("sample_rate", out var sr) && sr.ValueKind == JsonValueKind.String)
                {
                    sampleRate = int.Parse(sr.GetString()!, System.Globalization.CultureInfo.InvariantCulture);
                }
            }
        }

        if (width == 0 && !hasAudio)
        {
            throw new MaterialException("MAT_CORRUPT_FILE_PREFIX", $"检测到损坏文件：{fileForError}（无有效音视频流）");
        }

        // VFR 判定：名义帧率与平均帧率偏差 >1%（iPhone 素材典型）
        var isVfr = rFps > 0 && avgFps > 0 && Math.Abs(rFps - avgFps) / rFps > 0.01;
        return new MediaInfo(duration, width, height, avgFps > 0 ? avgFps : rFps, isVfr, vcodec, acodec, sampleRate, hasAudio);
    }

    private static double ParseRate(JsonElement stream, string prop)
    {
        if (!stream.TryGetProperty(prop, out var rate) || rate.ValueKind != JsonValueKind.String)
        {
            return 0;
        }

        var parts = rate.GetString()!.Split('/');
        if (parts.Length != 2 ||
            !double.TryParse(parts[0], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var num) ||
            !double.TryParse(parts[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var den) ||
            den == 0)
        {
            return 0;
        }

        return num / den;
    }
}
