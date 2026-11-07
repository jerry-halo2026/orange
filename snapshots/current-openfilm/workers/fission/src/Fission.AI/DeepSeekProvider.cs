using System.Net.Http.Json;
using System.Text.Json;

namespace Fission.AI;

/// <summary>
/// DeepSeek 文案适配器（官方 chat/completions；模型 deepseek-flash / deepseek-v4-pro）。
/// 鉴权 Authorization: Bearer；response_format=json_object；429/5xx 指数退避重试 3 次。
/// </summary>
public sealed class DeepSeekProvider : ILLMProvider
{
    private const string Endpoint = "https://api.deepseek.com/chat/completions";
    private readonly HttpClient _http;
    private readonly PromptTemplate? _template;

    /// <summary>创建适配器。</summary>
    /// <param name="key">API key。</param>
    /// <param name="model">模型名（deepseek-flash 默认）。</param>
    /// <param name="template">自定义文案模板（null=内置默认模板）。</param>
    /// <param name="http">注入 HttpClient（可测）。</param>
    public DeepSeekProvider(string key, string model = "deepseek-flash", PromptTemplate? template = null, HttpClient? http = null)
    {
        _http = http ?? new HttpClient();
        _http.DefaultRequestHeaders.Authorization = new("Bearer", key);
        _template = template;
        Model = model;
    }

    /// <summary>模型名。</summary>
    public string Model { get; }

    /// <inheritdoc/>
    public string Provider => "deepseek";

    /// <inheritdoc/>
    public async Task<IReadOnlyList<ScriptDraft>> GenerateAsync(ScriptRequest request, CancellationToken ct = default)
    {
        var prompt = _template is null ? PromptTemplates.Build(request) : PromptTemplates.Render(request, _template);
        var payload = BuildPayload(prompt, request.Count);
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                using var resp = await _http.PostAsJsonAsync(Endpoint, payload, JsonOpts, ct).ConfigureAwait(false);
                if ((int)resp.StatusCode is 429 or >= 500)
                {
                    if (attempt >= 3)
                    {
                        throw new AiException("AI_LLM_HTTP", $"DeepSeek 服务繁忙（HTTP {(int)resp.StatusCode}），重试 3 次仍失败");
                    }

                    await Task.Delay(TimeSpan.FromSeconds(1 << attempt), ct).ConfigureAwait(false);
                    continue;
                }

                resp.EnsureSuccessStatusCode();
                using var doc = await JsonDocument.ParseAsync(await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false), cancellationToken: ct).ConfigureAwait(false);
                var content = doc.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString() ?? string.Empty;
                return ParseScripts(content);
            }
            catch (HttpRequestException ex) when (attempt < 3)
            {
                await Task.Delay(TimeSpan.FromSeconds(1 << attempt), ct).ConfigureAwait(false);
                _ = ex; // 网络抖动退避重试
            }
        }
    }

    /// <summary>构造请求体（纯函数，可测）。</summary>
    public static Dictionary<string, object> BuildPayload((string System, string User) prompt, int count) => new()
    {
        ["model"] = "deepseek-flash",
        ["messages"] = new object[]
        {
            new Dictionary<string, string> { ["role"] = "system", ["content"] = prompt.System },
            new Dictionary<string, string> { ["role"] = "user", ["content"] = prompt.User },
        },
        ["response_format"] = new Dictionary<string, string> { ["type"] = "json_object" },
        ["temperature"] = Math.Min(0.7 + count * 0.1, 1.3), // 条数越多越需要发散
        ["max_tokens"] = 4096,
    };

    /// <summary>解析模型输出（content 为 json 字符串；容错：剥 ```json 围栏）。</summary>
    public static IReadOnlyList<ScriptDraft> ParseScripts(string content)
    {
        var json = content.Trim();
        if (json.StartsWith("```", StringComparison.Ordinal))
        {
            var first = json.IndexOf('\n');
            var last = json.LastIndexOf("```", StringComparison.Ordinal);
            json = first >= 0 && last > first ? json[(first + 1)..last] : json.Trim('`');
        }

        try
        {
            using var doc = JsonDocument.Parse(json);
            var arr = doc.RootElement.GetProperty("scripts");
            var list = new List<ScriptDraft>();
            foreach (var e in arr.EnumerateArray())
            {
                var title = e.TryGetProperty("title", out var t) ? t.GetString() : null;
                var text = e.TryGetProperty("text", out var x) ? x.GetString() : null;
                if (!string.IsNullOrWhiteSpace(title) && !string.IsNullOrWhiteSpace(text))
                {
                    list.Add(new ScriptDraft(title.Trim(), text.Trim()));
                }
            }

            return list.Count > 0 ? list : throw new AiException("AI_LLM_PARSE", "DeepSeek 返回为空（scripts 数组无有效条目）");
        }
        catch (JsonException ex)
        {
            throw new AiException("AI_LLM_PARSE", $"DeepSeek 输出不是合法 JSON：{ex.Message}");
        }
    }

    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
}

/// <summary>AIGC 段异常（报错码进 SSE 日志，不中断裂变主链）。</summary>
public sealed class AiException(string code, string message) : Exception(message)
{
    /// <summary>错误码。</summary>
    public string Code { get; } = code;
}
