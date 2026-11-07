using System.Text;
using System.Text.Json;

namespace Fission.AI;

/// <summary>可编辑文案模板（系统 + 用户提示双段，{{占位符}} 替换表单字段）。</summary>
/// <param name="System">系统提示（含 {{风格提示}}）。</param>
/// <param name="User">用户提示骨架。</param>
public sealed record PromptTemplate(string System, string User);

/// <summary>
/// 文案提示模板（默认=带货口播族；work/prompt-template.json 可自由编辑覆盖）。
/// 口播语速基准 ≈ 4.5 字/秒——字数预算 = 时长×4.5（±15% 容差写进模板变量）。
/// </summary>
public static class PromptTemplates
{
    /// <summary>口播语速（字/秒），决定字数预算。</summary>
    public const double CharsPerSecond = 4.5;

    /// <summary>占位符清单（UI 变量说明与点击插入用）。</summary>
    public static readonly string[] Placeholders =
    [
        "{{产品}}", "{{卖点}}", "{{场景}}", "{{人群}}", "{{条数}}", "{{目标时长}}",
        "{{字数下限}}", "{{字数上限}}", "{{补充要求}}", "{{风格提示}}",
    ];

    /// <summary>默认模板（与初始硬编码版等价）。</summary>
    public static PromptTemplate Default() => new(
        "你是{{风格提示}}。开头 3 秒强钩子，卖点说人话，结尾行动号召，口语化短句。",
        """
        请为以下产品创作 {{条数}} 条彼此差异明显的短视频口播文案，输出 json。
        产品：{{产品}}
        卖点：
        {{卖点}}
        画面场景（成片镜头顺序）：{{场景}}
        目标人群：{{人群}}
        单条口播时长约 {{目标时长}} 秒，正文控制在 {{字数下限}}-{{字数上限}} 字（语速约 4.5 字/秒）。
        要求：
        1. 每条含 title（10-18 字导出标题，可直接当文件名）与 text（口播正文）。
        2. 正文按镜头场景顺序推进，不出现"首先/其次"式书面连接词。
        3. 各条钩子角度、卖点排序、收尾话术必须不同。
        {{补充要求}}
        输出 json：{"scripts":[{"title":"…","text":"…"},…]}，数组长度={{条数}}，除 json 外不要输出任何内容。
        """);

    /// <summary>风格人设片段（填入 {{风格提示}}）。</summary>
    public static string StyleHint(ScriptStyle style) => style switch
    {
        ScriptStyle.Seeding => "抖音种草文案作者，写真实体验感口播，第一人称，口语化，有画面感，禁书面腔",
        ScriptStyle.Knowledge => "短视频知识讲解作者，把卖点讲成普通人秒懂的小知识，节奏干脆，结论先行",
        ScriptStyle.Story => "短视频剧情文案作者，用三幕微剧情（起-冲突-反转）带出卖点，台词化短句",
        _ => "短视频带货口播文案作者",
    };

    /// <summary>默认渲染（等价旧版 Build；无自定义模板时走这条）。</summary>
    public static (string System, string User) Build(ScriptRequest req) => Render(req, Default());

    /// <summary>模板渲染：表单字段替换 {{占位符}}；未出现的占位符保留原文，未使用的字段忽略。</summary>
    public static (string System, string User) Render(ScriptRequest req, PromptTemplate template)
    {
        var (minChars, maxChars) = CharBudget(req.TargetDurationSec);
        var map = new Dictionary<string, string>
        {
            ["{{产品}}"] = string.IsNullOrWhiteSpace(req.Product) ? "（未填，按通用好物写）" : req.Product,
            ["{{卖点}}"] = Bullets(req.SellingPoints),
            ["{{场景}}"] = string.IsNullOrWhiteSpace(req.Scenes) ? "（未填）" : req.Scenes,
            ["{{人群}}"] = string.IsNullOrWhiteSpace(req.Audience) ? "泛人群" : req.Audience,
            ["{{条数}}"] = req.Count.ToString(),
            ["{{目标时长}}"] = req.TargetDurationSec.ToString("0"),
            ["{{字数下限}}"] = minChars.ToString(),
            ["{{字数上限}}"] = maxChars.ToString(),
            ["{{补充要求}}"] = string.IsNullOrWhiteSpace(req.ExtraNotes) ? string.Empty : req.ExtraNotes.Trim(),
            ["{{风格提示}}"] = StyleHint(req.Style),
        };

        var sys = Substitute(template.System, map);
        var user = Substitute(template.User, map);
        return (sys, user);
    }

    /// <summary>字数预算区间（±15%）。</summary>
    public static (int min, int max) CharBudget(double targetDurationSec)
    {
        var mid = (int)Math.Round(targetDurationSec * CharsPerSecond);
        return ((int)(mid * 0.85), (int)(mid * 1.15));
    }

    private static string Substitute(string text, Dictionary<string, string> map)
    {
        var sb = new StringBuilder(text);
        foreach (var (key, value) in map)
        {
            _ = sb.Replace(key, value);
        }

        return sb.ToString();
    }

    private static string Bullets(string multiline)
    {
        var lines = multiline.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToList();
        return lines.Count == 0 ? "-（未填，自行提炼）" : string.Join('\n', lines.Select(l => "- " + l));
    }
}

/// <summary>模板持久化（work/prompt-template.json；原子写；损坏回落默认）。</summary>
public sealed class PromptTemplateStore(string file)
{
    private static readonly JsonSerializerOptions Opts = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    /// <summary>当前模板（文件缺失/损坏=默认）。</summary>
    public PromptTemplate Load()
    {
        if (!File.Exists(file))
        {
            return PromptTemplates.Default();
        }

        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            var r = doc.RootElement;
            var sys = r.TryGetProperty("system", out var s) ? s.GetString() : null;
            var user = r.TryGetProperty("user", out var u) ? u.GetString() : null;
            return string.IsNullOrWhiteSpace(sys) || string.IsNullOrWhiteSpace(user)
                ? PromptTemplates.Default()
                : new PromptTemplate(sys, user);
        }
        catch (JsonException)
        {
            return PromptTemplates.Default();
        }
    }

    /// <summary>保存模板（原子替换）。</summary>
    public void Save(PromptTemplate template)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var json = JsonSerializer.Serialize(template, Opts);
        var tmp = file + ".tmp";
        File.WriteAllText(tmp, json);
        File.Move(tmp, file, overwrite: true);
    }

    /// <summary>恢复默认（删文件）。</summary>
    public void Reset()
    {
        if (File.Exists(file))
        {
            File.Delete(file);
        }
    }
}
