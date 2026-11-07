using Fission.Core.Errors;
using Fission.Core.Jobs;
using Fission.Core.Process;

namespace Fission.Core.Abstractions;

/// <summary>视频引擎调用请求（统一入参，具体引擎由 Provider 决定）。</summary>
/// <param name="EngineFileName">引擎可执行（ffmpeg/ffmpeg6，由 Provider 填或调用方指定）。</param>
/// <param name="Arguments">完整参数串。</param>
/// <param name="TotalDurationSec">产物预计时长（进度解析用，可空）。</param>
/// <param name="TimeoutSec">超时秒。</param>
public sealed record VideoEngineRequest(
    string EngineFileName,
    string Arguments,
    double? TotalDurationSec = null,
    int TimeoutSec = 3600)
{
    /// <summary>构造默认请求（无进度）。</summary>
    public static VideoEngineRequest Of(string engine, string args) => new(engine, args);
}

/// <summary>视频引擎抽象：一切 ffmpeg/ffmpeg6 调用唯一通道（PRD §8.3）。</summary>
public interface IVideoEngine
{
    /// <summary>执行并等待退出；退出码非 0 抛 <see cref="EngineException"/>（含 stderr 尾部）。</summary>
    /// <param name="request">请求。</param>
    /// <param name="onProgress">进度回调 0–1（解析 time=）。</param>
    /// <param name="ct">取消令牌（触发即 kill 进程树）。</param>
    /// <returns>运行结果（含墙钟耗时，bench 用）。</returns>
    Task<ProcessResult> RunAsync(VideoEngineRequest request, Action<double>? onProgress = null, CancellationToken ct = default);
}

/// <summary>任务事件总线（引擎 → Web SSE / CLI 输出）。</summary>
public interface IJobEventBus
{
    /// <summary>发布事件（实现方保证非阻塞；双时间戳见 <see cref="JobEvent"/>）。</summary>
    void Emit(JobEvent evt);

    /// <summary>订阅事件流。</summary>
    IDisposable Subscribe(Action<JobEvent> handler);
}
