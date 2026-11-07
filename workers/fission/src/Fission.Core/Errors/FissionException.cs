namespace Fission.Core.Errors;

/// <summary>统一对外错误模型（PRD §8.4 / 总纲 §3）。所有 Provider 失败必须转义为本模型。</summary>
/// <param name="Code">错误码（稳定标识，如 MAT_VIDEO_DIR_EMPTY，见 docs/contracts/error-messages.zh.json）。</param>
/// <param name="Message">面向操作员的消息（原版措辞或可操作指引）。</param>
/// <param name="Retryable">是否可自动重试（限流/超时类为 true；鉴权/参数类为 false）。</param>
public sealed record ProviderError(string Code, string Message, bool Retryable);

/// <summary>Fission 异常基类（PRD §8.4）。</summary>
public abstract class FissionException(string code, string message, bool retryable, Exception? inner = null)
    : Exception(message, inner)
{
    /// <summary>稳定错误码，对应契约文件 error-messages.zh.json 的键。</summary>
    public string Code { get; } = code;

    /// <summary>是否可自动重试。</summary>
    public bool Retryable { get; } = retryable;

    /// <summary>转义为统一错误模型。</summary>
    public ProviderError ToProviderError() => new(Code, Message, Retryable);
}

/// <summary>引擎层错误（ffmpeg 探测/执行/产物校验失败）。</summary>
public sealed class EngineException(string code, string message, bool retryable = false, Exception? inner = null)
    : FissionException(code, message, retryable, inner);

/// <summary>素材层错误（目录空/损坏/不足）。</summary>
public sealed class MaterialException(string code, string message, bool retryable = false, Exception? inner = null)
    : FissionException(code, message, retryable, inner);

/// <summary>AIGC 层错误（LLM/TTS 调用失败）。</summary>
public sealed class AiException(string code, string message, bool retryable, Exception? inner = null)
    : FissionException(code, message, retryable, inner);

/// <summary>配置层错误（路径/key/参数非法）。</summary>
public sealed class ConfigException(string code, string message, bool retryable = false, Exception? inner = null)
    : FissionException(code, message, retryable, inner);
