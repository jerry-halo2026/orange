namespace Fission.Core.Jobs;

/// <summary>任务阶段（总纲 §4 语义，PRD §2.1 状态机）。</summary>
public enum JobStage
{
    Queued,
    Validating,
    Selecting,
    Img2Vid,
    Normalizing,
    Splitting,
    Allocating,
    Assembling,
    AvMerging,
    Visual,
    Exporting,
    Covering,
    Consuming,
    Done,
    Failed,
}

/// <summary>任务终态（PRD §2.2）。</summary>
public enum JobTerminalState
{
    Succeeded,
    Failed,
    Cancelled,
    /// <summary>中止时已有成片导出成功。</summary>
    Partial,
}

/// <summary>实际停止原因（PRD §2.2，写入 report.json 并在 UI 明示）。</summary>
public enum StopReason
{
    AudioExhausted,
    CountReached,
    MaterialShort,
    UserStopped,
    Error,
}

/// <summary>任务事件（SSE 推送体，双时间戳供延迟断言 —— PRD §6.1/B8）。</summary>
/// <param name="JobId">任务标识。</param>
/// <param name="OutputIndex">第几条成片（0 起）。</param>
/// <param name="Stage">当前阶段。</param>
/// <param name="Progress">阶段内进度 0–1（可空）。</param>
/// <param name="Detail">人类可读明细（原版措辞日志走此通道）。</param>
/// <param name="EmittedAtMs">事件生成单调毫秒（性能计数器）。</param>
public sealed record JobEvent(
    string JobId,
    int OutputIndex,
    JobStage Stage,
    double? Progress,
    string? Detail,
    long EmittedAtMs);
