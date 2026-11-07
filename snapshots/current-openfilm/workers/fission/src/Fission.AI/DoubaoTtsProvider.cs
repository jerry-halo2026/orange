using System.Net.Http.Json;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Fission.AI;

/// <summary>
/// 豆包 TTS 适配器（seed-tts-2.0 单向流式端点；官方 2026-11 文档钉死）。
/// POST openspeech.bytedance.com/api/v3/tts/unidirectional；
/// 鉴权 X-Api-Key + X-Api-Resource-Id + X-Api-Request-Id(uuid)；音频 base64。
/// </summary>
public sealed class DoubaoTtsProvider : ITTSProvider
{
    private const string Endpoint = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";

    /// <summary>预设音色（seed-tts-2.0 大模型音色族）。</summary>
    public static readonly string[] Voices =
    [
        "zh_female_vv_uranus_bigtts",   // 灿灿 · 甜美
        "zh_male_chunhui_mars_bigtts",  // 春晖 · 沉稳男
        "zh_female_bolang_moon_bigtts", // 波浪 · 清亮女
        "zh_male_qingxin_jupiter_bigtts",
        "zh_female_wanwanxiaoheiyao_bigtts",
        "zh_male_rap_mars_bigtts",
    ];

    private readonly HttpClient _http;
    private readonly string _key;
    private readonly string _resourceId;

    /// <summary>创建适配器。</summary>
    /// <param name="key">X-Api-Key。</param>
    /// <param name="resourceId">X-Api-Resource-Id（seed-tts-2.0 资源标识）。</param>
    /// <param name="http">注入 HttpClient（可测）。</param>
    public DoubaoTtsProvider(string key, string resourceId, HttpClient? http = null)
    {
        _http = http ?? new HttpClient();
        _key = key;
        _resourceId = resourceId;
    }

    /// <inheritdoc/>
    public string Provider => "doubao";

    /// <inheritdoc/>
    public async Task<TtsAudio> SynthesizeAsync(TtsRequest request, CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, Endpoint);
        req.Headers.Add("X-Api-Key", _key);
        req.Headers.Add("X-Api-Resource-Id", _resourceId);
        req.Headers.Add("X-Api-Request-Id", Guid.NewGuid().ToString("N"));
        req.Content = JsonContent.Create(BuildPayload(request, voice: request.VoiceId));

        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            throw new AiException("AI_TTS_HTTP", $"豆包 TTS HTTP {(int)resp.StatusCode}：{Short(body)}");
        }

        return Parse(body, request.VoiceId);
    }

    /// <summary>构造请求体（纯函数，可测）。</summary>
    public static Dictionary<string, object> BuildPayload(TtsRequest request, string voice) => new()
    {
        ["user"] = new Dictionary<string, string> { ["uid"] = "fission" },
        ["req_params"] = new Dictionary<string, object>
        {
            ["text"] = request.Text,
            ["speaker"] = voice,
            ["audio_params"] = new Dictionary<string, object>
            {
                ["format"] = "mp3",
                ["sample_rate"] = 32000,
                ["speech_rate"] = Math.Round(request.Speed, 2),   // 0.2–3.0（1=原速）
                ["loudness_rate"] = Math.Round(request.Volume, 2), // 0.1–10.0
            },
        },
    };

    /// <summary>解析响应（code=0，data=base64 mp3）。</summary>
    public static TtsAudio Parse(string body, string voiceId)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var code = root.TryGetProperty("code", out var c) ? c.GetInt32() : 0;
            if (code != 0)
            {
                var msg = root.TryGetProperty("message", out var m) ? m.GetString() : "未知错误";
                throw new AiException("AI_TTS_PROVIDER", $"豆包 TTS code={code}：{msg}");
            }

            var b64 = root.GetProperty("data").GetString() ?? throw new AiException("AI_TTS_PARSE", "豆包 TTS 响应缺少 data 音频");
            return new TtsAudio(Convert.FromBase64String(b64), ".mp3", "doubao", voiceId);
        }
        catch (JsonException ex)
        {
            throw new AiException("AI_TTS_PARSE", $"豆包 TTS 响应非 JSON：{ex.Message}");
        }
    }

    private static string Short(string s) => s.Length > 200 ? s[..200] : s;
}

/// <summary>
/// MiniMax TTS 适配器（t2a_v2；speech-2.8-hd/turbo；音频 hex 编码）。
/// base_resp.status_code：0=成功，1002=限流，1004=鉴权失败（照表分类抛错）。
/// </summary>
public sealed class MiniMaxTtsProvider : ITTSProvider
{
    /// <summary>国内域名（境外 api.minimax.io）。</summary>
    public const string EndpointCn = "https://api.minimaxi.com/v1/t2a_v2";

    /// <summary>预设音色。</summary>
    public static readonly string[] Voices =
    [
        "female-tianmei",      // 甜美女
        "female-yujie",        // 御姐
        "male-qn-qingse",      // 青涩男
        "male-qn-jingying",    // 精英男
        "audiobook_female_1",  // 有声书女
        "audiobook_male_2",
    ];

    private readonly HttpClient _http;
    private readonly string _endpoint;

    /// <summary>创建适配器。</summary>
    /// <param name="key">Bearer key。</param>
    /// <param name="useOversea">境外端点（默认国内）。</param>
    /// <param name="http">注入 HttpClient（可测）。</param>
    public MiniMaxTtsProvider(string key, bool useOversea = false, HttpClient? http = null)
    {
        _http = http ?? new HttpClient();
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", key);
        _endpoint = useOversea ? "https://api.minimax.io/v1/t2a_v2" : EndpointCn;
    }

    /// <inheritdoc/>
    public string Provider => "minimax";

    /// <inheritdoc/>
    public async Task<TtsAudio> SynthesizeAsync(TtsRequest request, CancellationToken ct = default)
    {
        using var resp = await _http.PostAsJsonAsync(_endpoint, BuildPayload(request), JsonOpts, ct).ConfigureAwait(false);
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            throw new AiException("AI_TTS_HTTP", $"MiniMax TTS HTTP {(int)resp.StatusCode}：{(body.Length > 200 ? body[..200] : body)}");
        }

        return Parse(body, request.VoiceId);
    }

    /// <summary>构造请求体（纯函数，可测）。</summary>
    public static Dictionary<string, object> BuildPayload(TtsRequest request) => new()
    {
        ["model"] = "speech-2.8-hd",
        ["text"] = request.Text,
        ["stream"] = false,
        ["voice_setting"] = new Dictionary<string, object>
        {
            ["voice_id"] = request.VoiceId,
            ["speed"] = Math.Round(request.Speed, 2), // 0.5–2
            ["vol"] = Math.Round(Math.Clamp(request.Volume, 0, 10), 2),
            ["pitch"] = 0,
        },
        ["audio_setting"] = new Dictionary<string, object>
        {
            ["sample_rate"] = 32000,
            ["format"] = "mp3",
        },
    };

    /// <summary>解析响应（data.audio.hex；base_resp 分类报错）。</summary>
    public static TtsAudio Parse(string body, string voiceId)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.TryGetProperty("base_resp", out var br) && br.TryGetProperty("status_code", out var sc) && sc.GetInt32() != 0)
            {
                var code = sc.GetInt32();
                var msg = br.TryGetProperty("status_msg", out var m) ? m.GetString() : "未知错误";
                throw code switch
                {
                    1002 => new AiException("AI_TTS_LIMIT", $"MiniMax 限流（1002）：{msg}——稍后重试或降速生成"),
                    1004 => new AiException("AI_TTS_AUTH", $"MiniMax 鉴权失败（1004）：{msg}——检查 key"),
                    _ => new AiException("AI_TTS_PROVIDER", $"MiniMax code={code}：{msg}"),
                };
            }

            var hex = root.GetProperty("data").GetProperty("audio").GetProperty("hex").GetString()
                ?? throw new AiException("AI_TTS_PARSE", "MiniMax 响应缺少 hex 音频");
            return new TtsAudio(HexDecode(hex), ".mp3", "minimax", voiceId);
        }
        catch (JsonException ex)
        {
            throw new AiException("AI_TTS_PARSE", $"MiniMax 响应非 JSON：{ex.Message}");
        }
    }

    private static byte[] HexDecode(string hex)
    {
        var bytes = new byte[hex.Length / 2];
        for (var i = 0; i < bytes.Length; i++)
        {
            bytes[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
        }

        return bytes;
    }

    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
}
