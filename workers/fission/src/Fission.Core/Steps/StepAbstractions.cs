namespace Fission.Core.Steps;

/// <summary>Step 自描述契约（ADR-001：注册即用，schema minor 向后兼容）。</summary>
/// <param name="Id">稳定标识（如 normalize / scene-split / tts-doubao）。</param>
/// <param name="Version">语义化版本。</param>
/// <param name="Title">人读名（中文）。</param>
/// <param name="Capabilities">能力标签（transcode/split/assemble/tts…）。</param>
/// <param name="InputSchema">输入 JSON Schema（文档化字符串）。</param>
/// <param name="OutputSchema">输出 JSON Schema。</param>
public sealed record StepContract(
    string Id,
    string Version,
    string Title,
    IReadOnlyList<string> Capabilities,
    string InputSchema,
    string OutputSchema);

/// <summary>Step 执行上下文。</summary>
/// <param name="JobId">任务标识。</param>
/// <param name="OutputIndex">第几条成片（0 起）。</param>
/// <param name="WorkDir">本条成片工作目录（已创建）。</param>
/// <param name="Seed">随机种子（同种子同参数 ⇒ 同输出，PRD §7.3）。</param>
/// <param name="CancellationToken">取消令牌。</param>
public sealed record StepContext(
    string JobId,
    int OutputIndex,
    string WorkDir,
    int Seed,
    CancellationToken CancellationToken);

/// <summary>声明式滤镜片段（可与其他视觉 Step 融合为单次编码 —— PRD §7.4）。</summary>
/// <param name="FilterChain">ffmpeg 滤镜串（如 hflip,lut3d=file=...）。</param>
/// <param name="Inputs">滤镜引用的附加输入（如 overlay 的贴纸文件，按出现序）。</param>
/// <param name="OrderHint">融合排序提示（小者先）。</param>
public sealed record FilterFragment(string FilterChain, IReadOnlyList<string> Inputs, int OrderHint) : StepOutput;

/// <summary>文件产物（独立调用产物，如转场合成 mp3/mp4）。</summary>
/// <param name="Path">产物绝对路径。</param>
/// <param name="DurationSec">时长（音视频产物必填，其他可空）。</param>
/// <param name="KindHint">产物类别（video/audio/image/data）。</param>
public sealed record FileArtifact(string Path, double? DurationSec, string KindHint) : StepOutput;

/// <summary>Step 输出联合基类（序列化带 kind 判别字段，PRD §7.3）。</summary>
public abstract record StepOutput;

/// <summary>最小处理单元（ADR-001：Steps 依赖 Core 抽象，可独立 CLI 调用）。</summary>
public interface IStep
{
    /// <summary>自描述契约。</summary>
    StepContract Contract { get; }

    /// <summary>执行（必须响应取消；失败抛 FissionException 族）。</summary>
    Task<StepOutput> RunAsync(object input, StepContext ctx);
}

/// <summary>Step 注册表（组合根反射填充；CLI `fission step` 由它生成）。</summary>
public interface IStepRegistry
{
    /// <summary>按 Id 取 Step（不存在返回 null）。</summary>
    IStep? Find(string id);

    /// <summary>全部已注册 Step 契约。</summary>
    IReadOnlyList<StepContract> All();
}
