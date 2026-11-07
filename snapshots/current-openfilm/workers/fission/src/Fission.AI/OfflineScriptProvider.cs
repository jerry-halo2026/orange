namespace Fission.AI;

/// <summary>
/// 离线文案兜底（无 DeepSeek key 时；PRD「无 key 引擎降级离线模式，全链不受阻」）。
/// 模板句式族 + 卖点轮换组合，保证 N 条互异；不联网。
/// </summary>
public sealed class OfflineScriptProvider : ILLMProvider
{
    private static readonly string[] Hooks =
    [
        "别再乱买了，", "同行不会告诉你的，", "三分钟教会你，", "老手都是这样挑的：", "这个细节九成人忽略——",
        "买之前先看这条：", "为什么你买回去总翻车？", "记住这几点，",
    ];

    private static readonly string[] Openers =
    [
        "今天直接说结论。", "先看画面。", "上手第一件事。", "从头到尾给你捋一遍。", "不绕弯子。",
    ];

    private static readonly string[] Closers =
    [
        "学会了吗？评论区扣个 1。", "这条存下来，下次照着买。", "关注我，少踩一半坑。", "现在你知道该怎么选了。", "转给要买的朋友。",
    ];

    private readonly Random _rng = new();

    /// <inheritdoc/>
    public string Provider => "offline";

    /// <inheritdoc/>
    public Task<IReadOnlyList<ScriptDraft>> GenerateAsync(ScriptRequest request, CancellationToken ct = default)
    {
        var points = request.SellingPoints.Split('\n').Select(p => p.Trim()).Where(p => p.Length > 0).ToList();
        if (points.Count == 0)
        {
            points = ["品质看得见", "上手零门槛", "性价比拉满"];
        }

        var product = string.IsNullOrWhiteSpace(request.Product) ? "这个好物" : request.Product;
        var sceneWords = request.Scenes.Split('、', ',', '，', '\n').Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
        var (minChars, maxChars) = PromptTemplates.CharBudget(request.TargetDurationSec);
        var drafts = new List<ScriptDraft>(request.Count);
        for (var i = 0; i < request.Count; i++)
        {
            var hook = Hooks[(i + _rng.Next(Hooks.Length)) % Hooks.Length];
            var opener = Openers[(i + _rng.Next(Openers.Length)) % Openers.Length];
            var closer = Closers[(i + _rng.Next(Closers.Length)) % Closers.Length];
            var rotation = Enumerable.Range(0, points.Count).Select(k => points[(k + i) % points.Count]).ToList();
            var scene = sceneWords.Count > 0 ? $"（{sceneWords[i % sceneWords.Count]}）" : string.Empty;

            // 拼装至字数预算中值附近：卖点逐条吃掉预算，不足再补一句人群话术
            var sb = new System.Text.StringBuilder();
            _ = sb.Append(hook).Append(product).Append(scene).Append(opener);
            foreach (var p in rotation)
            {
                if (sb.Length >= minChars)
                {
                    break;
                }

                _ = sb.Append(p).Append('。');
            }

            var audience = string.IsNullOrWhiteSpace(request.Audience) ? "你" : request.Audience;
            if (sb.Length < minChars)
            {
                _ = sb.Append(audience).Append("闭眼入不吃亏。");
            }

            _ = sb.Append(closer);
            if (sb.Length > maxChars + 20)
            {
                _ = sb.Remove(maxChars + 20, sb.Length - maxChars - 20);
                _ = sb.Append('…').Append(closer[..^1]).Append('。');
            }

            var title = $"{hook.TrimEnd('，', ':', '：', '。')}{product}"[..Math.Min(16, ($"{hook.TrimEnd('，', ':', '：', '。')}{product}").Length)];
            drafts.Add(new ScriptDraft(title, sb.ToString()));
        }

        return Task.FromResult<IReadOnlyList<ScriptDraft>>(drafts);
    }
}
