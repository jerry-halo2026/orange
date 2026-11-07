namespace Fission.Core.Abstractions;

/// <summary>媒体探测结果（总纲 §3.1 MediaInfo）。</summary>
/// <param name="DurationSec">时长（秒）。</param>
/// <param name="Width">视频宽（px，无视频轨为 0）。</param>
/// <param name="Height">视频高（px）。</param>
/// <param name="Fps">名义帧率（VFR 源为平均帧率）。</param>
/// <param name="IsVfr">是否检测到可变帧率（r_frame_rate 与 avg_frame_rate 偏差 >1%）。</param>
/// <param name="VCodec">视频编码器名（hevc/h264…）。</param>
/// <param name="ACodec">音频编码器名，无音轨为 null。</param>
/// <param name="SampleRateHz">音频采样率，无音轨为 0。</param>
/// <param name="HasAudio">是否有音轨。</param>
public sealed record MediaInfo(
    double DurationSec,
    int Width,
    int Height,
    double Fps,
    bool IsVfr,
    string VCodec,
    string? ACodec,
    int SampleRateHz,
    bool HasAudio)
{
    /// <summary>是否竖版画面。</summary>
    public bool IsPortrait => Height > Width;
}

/// <summary>媒体探测抽象（Core 定义，Providers 实现 —— ADR-001）。</summary>
public interface IMediaProbe
{
    /// <summary>探测媒体文件；文件不可读/损坏抛 <c>EngineException</c>（调用方按 损坏文件跳过 处理）。</summary>
    Task<MediaInfo> ProbeAsync(string file, CancellationToken ct = default);
}
