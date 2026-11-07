namespace Fission.AI;

/// <summary>文案风格（提示模板族；PRD §2 AIGC 生产段）。</summary>
public enum ScriptStyle
{
    /// <summary>带货口播（默认）。</summary>
    SalesPitch,
    /// <summary>种草推荐。</summary>
    Seeding,
    /// <summary>知识讲解。</summary>
    Knowledge,
    /// <summary>剧情短句。</summary>
    Story,
}

/// <summary>文案生成请求（板块「② 文案与配音」表单）。</summary>
/// <param name="Product">产品名。</param>
/// <param name="SellingPoints">卖点（多行原文）。</param>
/// <param name="Scenes">场景描述（默认带场景组目录名）。</param>
/// <param name="Audience">目标人群。</param>
/// <param name="Style">文案风格。</param>
/// <param name="Count">生成条数 N。</param>
/// <param name="TargetDurationSec">单条目标时长（秒）——口播字数≈时长×4.5。</param>
/// <param name="ExtraNotes">补充要求（自由文本，进模板 {{补充要求}}）。</param>
public sealed record ScriptRequest(
    string Product,
    string SellingPoints,
    string Scenes,
    string Audience,
    ScriptStyle Style,
    int Count,
    double TargetDurationSec,
    string? ExtraNotes = null);

/// <summary>一条文案草稿。</summary>
/// <param name="Title">导出标题（兼作配音文件名/成片名）。</param>
/// <param name="Text">口播正文。</param>
public sealed record ScriptDraft(string Title, string Text);

/// <summary>TTS 合成请求。</summary>
/// <param name="Text">口播文本。</param>
/// <param name="VoiceId">音色 ID（厂商各自体系）。</param>
/// <param name="Speed">语速倍率（0.5–2.0）。</param>
/// <param name="Volume">音量倍率（0–10，厂商语义）。</param>
public sealed record TtsRequest(string Text, string VoiceId, double Speed = 1.0, double Volume = 1.0);

/// <summary>TTS 合成产物（音频字节；文件落盘与时长探测由组合根负责）。</summary>
/// <param name="Audio">音频字节。</param>
/// <param name="Ext">扩展名（含点，如 .mp3）。</param>
/// <param name="Provider">厂商标识。</param>
/// <param name="VoiceId">实际音色。</param>
public sealed record TtsAudio(byte[] Audio, string Ext, string Provider, string VoiceId);

/// <summary>文案生成提供者（DeepSeek 主 / 离线模板兜底）。</summary>
public interface ILLMProvider
{
    /// <summary>提供商标识（deepseek / offline）。</summary>
    string Provider { get; }

    /// <summary>批量生成差异化文案（数量=请求 N）。</summary>
    /// <param name="request">文案请求。</param>
    /// <param name="ct">取消。</param>
    Task<IReadOnlyList<ScriptDraft>> GenerateAsync(ScriptRequest request, CancellationToken ct = default);
}

/// <summary>TTS 提供者（豆包 seed-tts-2.0 主 / MiniMax 备 / 离线合成兜底）。</summary>
public interface ITTSProvider
{
    /// <summary>提供商标识（doubao / minimax / offline）。</summary>
    string Provider { get; }

    /// <summary>合成单条配音。</summary>
    /// <param name="request">合成请求。</param>
    /// <param name="ct">取消。</param>
    Task<TtsAudio> SynthesizeAsync(TtsRequest request, CancellationToken ct = default);
}
