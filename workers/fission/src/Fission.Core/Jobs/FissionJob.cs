using System.Text.Json.Serialization;

namespace Fission.Core.Jobs;

/// <summary>分割模式（PRD FR-3；v1.3 实装四路：镜头/平均N片/按秒/随机区间，静音与SRT在 M2 尾补）。</summary>
public enum SplitMode
{
    /// <summary>镜头差分（ffmpeg scene 阈值）。</summary>
    Scene,
    /// <summary>每个视频平均分为 N 片。</summary>
    AveragePieces,
    /// <summary>按秒平均分割。</summary>
    BySeconds,
    /// <summary>a–b 秒随机区间（a==b 为固定时长）。</summary>
    RandomRange,
    /// <summary>不分割（整段使用）。</summary>
    None,
}

/// <summary>素材选取规则（PRD FR-1.3）。</summary>
public enum PickRule
{
    /// <summary>场景组按目录序，组内随机。</summary>
    SceneOrderRandomWithin,
    /// <summary>全池随机。</summary>
    Random,
    /// <summary>顺序循环（组与文件均按序）。</summary>
    Sequential,
}

/// <summary>时长对齐八策略（docs/contracts/align-strategies.json）。</summary>
public enum AlignStrategy
{
    TrimLonger = 1,
    RightTrimLeftSpeed = 2,
    RightTrimLeftLoop = 3,
    AlwaysSpeed = 4,
    LoopSpeedMix = 5,
    LeftTrimRightSpeed = 6,
    LeftTrimRightLoop = 7,
    AlwaysLoop = 8,
}

/// <summary>成片命名规则（PRD FR-8.5）。</summary>
public enum NamingRule
{
    /// <summary>按替换的音频的文件名。</summary>
    AudioFileName,
    /// <summary>数字序号。</summary>
    Sequence,
    /// <summary>随机标题（内置标题池）。</summary>
    RandomTitle,
}

/// <summary>场景组内选取规则（原版网格列「顺序或随机」）。</summary>
public enum GroupRule
{
    /// <summary>文件夹顺序（文件名序，用后跳过；批内耗尽循环）。</summary>
    Sequential,
    /// <summary>组内随机。</summary>
    Random,
}

/// <summary>
/// 场景组配置（原版子文件夹板块网格列：启用/序号/文件夹名/视频数/图片数/顺序或随机/每次抽取几个/视频变速/用过是否删除/重复抽取）。
/// 证据：dump 0x014ff945「每次抽取几个」0x014ff975「用过是否删除」+ 批量键 0x00a5678f–0x00a567ff。
/// </summary>
/// <param name="Name">子文件夹名（与 VideoDir 下的一级目录名精确匹配）。</param>
/// <param name="Enabled">是否参与选取。</param>
/// <param name="TakePerOutput">每次成片从本组抽取的片段数（0=按时长动态补足，默认行为）。</param>
/// <param name="Rule">组内选取规则（顺序或随机）。</param>
/// <param name="Speed">本组视频变速倍率（0.5–4.0；原版下限 0.5：低于 0.5 舍弃该文件）。</param>
/// <param name="UseThenDelete">用过是否删除（true=确认后入跨批次缓存，后续批次不再选取）。</param>
/// <param name="AllowReuse">重复抽取（true=已用/占用素材仍可再抽；优先级高于 UseThenDelete）。</param>
public sealed record SceneGroupConfig(
    string Name,
    bool Enabled = true,
    int TakePerOutput = 0,
    GroupRule Rule = GroupRule.Random,
    double Speed = 1.0,
    bool UseThenDelete = false,
    bool AllowReuse = false);

/// <summary>裂变任务参数（JSON 载体；⇄ 多场景裂变.ini 的 P0 映射见 docs/contracts/ini-mapping-spec.md）。</summary>
public sealed class FissionJob
{
    /// <summary>视频素材目录（子文件夹数字前缀=场景组；组内视为无序镜头池）。</summary>
    public string VideoDir { get; set; } = string.Empty;

    /// <summary>场景组配置（空=目录下全部子文件夹参与、每组动态补足时长）。</summary>
    public List<SceneGroupConfig>? SceneGroups { get; set; }

    /// <summary>图片转视频时长区间 a（秒；a==b 即固定时长——原版「可设置相同的两个数 即不随机时长，用固定时长」）。</summary>
    public double ImageDurMinSec { get; set; } = 2.0;

    /// <summary>图片转视频时长区间 b（秒）。</summary>
    public double ImageDurMaxSec { get; set; } = 4.0;

    /// <summary>配音目录（离线模式；为空则必须提供 GeneratedAudioCount + AudioDurationSec）。</summary>
    public string? AudioDir { get; set; }

    /// <summary>背景音乐目录（可空=不加 BGM）。</summary>
    public string? BgmDir { get; set; }

    /// <summary>片头视频目录（FR-5.5：随机剪取开头区间拼入）。</summary>
    public string? IntroDir { get; set; }

    /// <summary>片尾视频目录。</summary>
    public string? OutroDir { get; set; }

    /// <summary>输出根目录（空=默认 OutRoot；任务产物落 {OutDir}/{jobId}/，PRD FR-8.4）。</summary>
    public string? OutDir { get; set; }

    /// <summary>生成数量上限（与配音池耗尽先到先停；0=不限）。</summary>
    public int Count { get; set; } = 3;

    /// <summary>成片级并发（1–64；目标指令要求稳定支持 ≥20）。</summary>
    public int Threads { get; set; } = 4;

    /// <summary>目标时长（秒）；null=以配音时长为准。</summary>
    public double? TargetDurationSec { get; set; }

    /// <summary>离线合成配音数量（无 AudioDir 时）。</summary>
    public int GeneratedAudioCount { get; set; }

    /// <summary>离线合成配音时长（秒）。</summary>
    public double GeneratedAudioDurationSec { get; set; } = 15;

    /// <summary>每个配音最多应用的成片数（usePolicy count；1=用后即删原版语义，0=不限）。</summary>
    public int AudioUses { get; set; } = 1;

    /// <summary>输出宽。</summary>
    public int OutWidth { get; set; } = 1080;

    /// <summary>输出高。</summary>
    public int OutHeight { get; set; } = 1920;

    /// <summary>输出帧率（CFR）。</summary>
    public int OutFps { get; set; } = 30;

    /// <summary>视频音量倍率（0.0–2.0，配音轨）。</summary>
    public double VoiceVolume { get; set; } = 1.0;

    /// <summary>BGM 音量（0=不加 BGM 即便有目录）。</summary>
    public double BgmVolume { get; set; } = 0.35;

    /// <summary>分割模式。</summary>
    public SplitMode SplitMode { get; set; } = SplitMode.Scene;

    /// <summary>镜头分割精度阈值（0.01–0.99，值越小越精细）。</summary>
    public double SceneThreshold { get; set; } = 0.3;

    /// <summary>平均 N 片的 N。</summary>
    public int AvgPieces { get; set; } = 4;

    /// <summary>按秒分割的秒数。</summary>
    public double BySeconds { get; set; } = 3.0;

    /// <summary>随机区间 a（秒）。</summary>
    public double RandomMinSec { get; set; } = 2.0;

    /// <summary>随机区间 b（秒）。</summary>
    public double RandomMaxSec { get; set; } = 4.0;

    /// <summary>对齐策略（1–8）。</summary>
    public AlignStrategy Align { get; set; } = AlignStrategy.TrimLonger;

    /// <summary>选取规则。</summary>
    public PickRule Pick { get; set; } = PickRule.SceneOrderRandomWithin;

    /// <summary>可重复抽取视频（不足即停 vs 允许重复）。</summary>
    public bool AllowVideoReuse { get; set; }

    /// <summary>随机左右翻转差异化。</summary>
    public bool RandomHFlip { get; set; } = true;

    /// <summary>转场时长（秒；0=不加转场。原版 100–400ms 常用）。</summary>
    public double TransitionSec { get; set; }

    /// <summary>转场名（66 GLSL 之一；"random"=每条成片随机抽；渲染失败自动回退无转场）。</summary>
    public string TransitionName { get; set; } = "fade";

    /// <summary>字幕开关（口播文案烧录进成片；文本取配音目录 meta.json 或同名 .srt）。</summary>
    public bool SubtitleEnabled { get; set; }

    /// <summary>字幕样式预设（white-outline / yellow-outline / white-box / center-bold）。</summary>
    public string SubtitleStyle { get; set; } = "white-outline";

    /// <summary>字幕位置（top / middle / bottom）。</summary>
    public string SubtitlePos { get; set; } = "bottom";

    /// <summary>字幕字号（ASS PlayY 基准，20–160）。</summary>
    public int SubtitleFontSize { get; set; } = 64;

    /// <summary>封面截图时间（秒）。</summary>
    public double CoverAtSec { get; set; } = 1.0;

    /// <summary>命名规则。</summary>
    public NamingRule Naming { get; set; } = NamingRule.AudioFileName;

    /// <summary>硬编（nvenc；无卡自动回退）。</summary>
    public bool UseNvenc { get; set; } = true;

    /// <summary>NVENC 并发会话闸门（GeForce 驱动上限≈8；实测 8GB 卡桌面占用下 8 路会 OOM，默认 4）。</summary>
    public int NvencGate { get; set; } = 4;

    /// <summary>校验（报错文案走契约 error-messages.zh.json）。</summary>
    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(VideoDir) || !Directory.Exists(VideoDir))
        {
            ThrowContract("MAT_VIDEO_DIR_EMPTY");
        }

        if (string.IsNullOrWhiteSpace(AudioDir) && GeneratedAudioCount <= 0)
        {
            ThrowContract("MAT_AUDIO_DIR_EMPTY");
        }

        if (AudioDir is not null && !Directory.Exists(AudioDir))
        {
            ThrowContract("MAT_AUDIO_DIR_EMPTY");
        }

        if (IntroDir is not null && !Directory.Exists(IntroDir))
        {
            ThrowContract("MAT_INTRO_DIR_EMPTY");
        }

        if (OutroDir is not null && !Directory.Exists(OutroDir))
        {
            ThrowContract("MAT_OUTRO_DIR_EMPTY");
        }

        ValidateConfiguration();
    }

    /// <summary>Directory-independent original configuration checks; frozen execution validates only its selected file dependencies.</summary>
    public void ValidateConfiguration()
    {
        if (Threads is < 1 or > 64)
        {
            ThrowContract("CFG_THREAD_LIMIT2");
        }

        // 场景组网格参数域（原版：变速下限 0.5）
        foreach (var g in SceneGroups ?? [])
        {
            if (g.Speed is < 0.5 or > 4.0)
            {
                ThrowContract("CFG_ARGS");
            }
        }

        if (ImageDurMinSec <= 0 || ImageDurMaxSec <= 0)
        {
            ThrowContract("CFG_ARGS");
        }

        if (TransitionSec is < 0 or > 2)
        {
            ThrowContract("CFG_ARGS");
        }

        if (SubtitleEnabled)
        {
            if (SubtitleStyle is not ("white-outline" or "yellow-outline" or "white-box" or "center-bold")
                || SubtitlePos is not ("top" or "middle" or "bottom")
                || SubtitleFontSize is < 20 or > 160)
            {
                ThrowContract("CFG_ARGS");
            }
        }

        if (TargetDurationSec is <= 0 && AudioDir is null && GeneratedAudioCount > 0 && GeneratedAudioDurationSec <= 0)
        {
            ThrowContract("CFG_ARGS");
        }
    }

    private static void ThrowContract(string code) => throw new Fission.Core.Errors.ConfigException(code, ErrorMessageSource.Get(code));
}

/// <summary>契约文案读取器（docs/contracts/error-messages.zh.json 的内嵌副本；运行时若文件存在则优先读文件）。</summary>
public static class ErrorMessageSource
{
    private static readonly Dictionary<string, string> BuiltIn = new()
    {
        ["MAT_VIDEO_DIR_EMPTY"] = "视频素材目录为空，请添加视频素材！",
        ["MAT_AUDIO_DIR_EMPTY"] = "音频目录为空/音频目录里没素材！",
        ["MAT_BGM_DIR_EMPTY"] = "勾选了加背景音乐，但是背景音乐目录为空…",
        ["MAT_INTRO_DIR_EMPTY"] = "勾选了加片头视频，但是片头目录为空…",
        ["MAT_OUTRO_DIR_EMPTY"] = "勾选了加片尾视频，但是片尾目录为空…",
        ["MAT_AUDIO_EXHAUSTED"] = "音频素材已用完，合成停止！",
        ["MAT_VIDEO_NOT_ENOUGH"] = "[裂变合成]：视频素材不足以拼接，请添加视频素材，或开启 [可重复抽取视频] 选项。",
        ["CFG_THREAD_LIMIT2"] = "线程数最大只能设置为64",
        ["CFG_ARGS"] = "参数不合法",
        ["MAT_CORRUPT_FILE_PREFIX"] = "检测到损坏文件：",
        ["RUN_TRANSITION_FALLBACK"] = "转场渲染失败，本条成片已回退为无转场",
        ["RUN_COVER_FALLBACK"] = "封面截取失败，已回退为首帧封面",
    };

    /// <summary>取文案（文件优先）。</summary>
    public static string Get(string code)
    {
        var file = Path.Combine(AppContext.BaseDirectory, "contracts", "error-messages.zh.json");
        if (File.Exists(file))
        {
            try
            {
                using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(file));
                if (doc.RootElement.TryGetProperty("messages", out var msgs) && msgs.TryGetProperty(code, out var v))
                {
                    return v.GetString() ?? code;
                }
            }
            catch (System.Text.Json.JsonException)
            {
                // 文件损坏回落内置
            }
        }

        return BuiltIn.TryGetValue(code, out var s) ? s : code;
    }
}
