using System.Text.Json;

namespace Fission.AI;

/// <summary>音色目录条目（厂商音色带中文名，供下拉与试听）。</summary>
/// <param name="Provider">doubao / minimax。</param>
/// <param name="Id">音色 ID（API 调用值）。</param>
/// <param name="Label">中文名（如 灿灿 · 甜美女声）。</param>
/// <param name="Tags">风格标签。</param>
public sealed record VoiceCatalogEntry(string Provider, string Id, string Label, string Tags);

/// <summary>
/// 音色目录：默认内置（豆包 seed-tts-2.0 / MiniMax 系统音色），可被 work/voice-catalog.json 覆盖扩展
/// （同事拿到新音色表贴进去即生效，无需改码）。
/// </summary>
public static class VoiceCatalog
{
    /// <summary>内置目录（官方音色列表的常用子集；Label 为官方中文名）。</summary>
    public static readonly VoiceCatalogEntry[] Defaults =
    [
        new("doubao", "zh_female_vv_uranus_bigtts", "灿灿 · 通用甜美女声", "通用/口播"),
        new("doubao", "zh_female_bolang_moon_bigtts", "波浪 · 温柔女声", "温柔/种草"),
        new("doubao", "zh_female_wanwanxiaoheiyao_bigtts", "万万 · 活泼女声", "活泼/带货"),
        new("doubao", "zh_male_chunhui_mars_bigtts", "春晖 · 沉稳男声", "新闻/讲解"),
        new("doubao", "zh_male_qingxin_jupiter_bigtts", "清新 · 阳光男声", "年轻/种草"),
        new("doubao", "zh_male_rap_mars_bigtts", "说唱男声", "节奏/卡点"),
        new("minimax", "female-tianmei", "甜美女性", "通用/种草"),
        new("minimax", "female-yujie", "御姐女声", "气场/剧情"),
        new("minimax", "female-shaonv", "少女音", "活泼/种草"),
        new("minimax", "female-chengshu", "成熟女性", "信任感/讲解"),
        new("minimax", "male-qn-qingse", "青涩青年", "学生感/种草"),
        new("minimax", "male-qn-jingying", "精英青年", "商务/讲解"),
        new("minimax", "audiobook_female_1", "有声书女声", "长文本"),
        new("minimax", "audiobook_male_2", "有声书男声", "长文本"),
    ];

    private static readonly JsonSerializerOptions Opts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    /// <summary>加载目录（catalogFile 存在则整体覆盖内置；格式 [{provider,id,label,tags}]）。</summary>
    public static IReadOnlyList<VoiceCatalogEntry> Load(string? catalogFile = null)
    {
        if (catalogFile is null || !File.Exists(catalogFile))
        {
            return Defaults;
        }

        try
        {
            return JsonSerializer.Deserialize<List<VoiceCatalogEntry>>(File.ReadAllText(catalogFile), Opts) ?? [.. Defaults];
        }
        catch (JsonException)
        {
            return Defaults; // 目录损坏回落内置
        }
    }
}
