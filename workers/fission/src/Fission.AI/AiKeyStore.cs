using System.Text.Json;

namespace Fission.AI;

/// <summary>
/// API key 三槽位存取（DeepSeek / 豆包 / MiniMax）。
/// 落盘 work/ai-keys.json（本机明文——与原版 软件参数.ini 存阿里云密钥同信任边界）；GET 一律脱敏。
/// </summary>
public sealed class AiKeyStore
{
    /// <summary>豆包侧 X-Api-Resource-Id（seed-tts-2.0 官方资源标识，随 key 一并保存）。</summary>
    public const string DoubaoResourceId = "volc.megatron.tts.alpha";

    private static readonly JsonSerializerOptions SerializeOpts = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private readonly string _file;
    private readonly object _sync = new();

    /// <summary>创建存取器。</summary>
    /// <param name="file">持久化 JSON 路径（work/ai-keys.json）。</param>
    public AiKeyStore(string file)
    {
        _file = file;
    }

    /// <summary>三槽位 key 快照（null=未配置）。</summary>
    public sealed record Keys(string? DeepSeek, string? Doubao, string? DoubaoResourceId, string? MiniMax);

    /// <summary>读取全部 key。</summary>
    public Keys Load()
    {
        lock (_sync)
        {
            if (!File.Exists(_file))
            {
                return new Keys(null, null, null, null);
            }

            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(_file));
                var r = doc.RootElement;
                return new Keys(
                    r.TryGetProperty("deepseek", out var d) ? d.GetString() : null,
                    r.TryGetProperty("doubao", out var b) ? b.GetString() : null,
                    r.TryGetProperty("doubaoResourceId", out var br) ? br.GetString() ?? DoubaoResourceId : DoubaoResourceId,
                    r.TryGetProperty("minimax", out var m) ? m.GetString() : null);
            }
            catch (JsonException)
            {
                return new Keys(null, null, null, null); // 文件损坏视为未配置
            }
        }
    }

    /// <summary>写入单槽（null/空=清除）。原子替换。</summary>
    public void Save(string slot, string? value)
    {
        lock (_sync)
        {
            var k = Load();
            var updated = slot switch
            {
                "deepseek" => k with { DeepSeek = Clean(value) },
                "doubao" => k with { Doubao = Clean(value) },
                "doubaoResourceId" => k with { DoubaoResourceId = string.IsNullOrWhiteSpace(value) ? DoubaoResourceId : value.Trim() },
                "minimax" => k with { MiniMax = Clean(value) },
                _ => throw new ArgumentException($"未知槽位：{slot}", nameof(slot)),
            };

            Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
            var json = JsonSerializer.Serialize(new Dictionary<string, string?>
            {
                ["deepseek"] = updated.DeepSeek,
                ["doubao"] = updated.Doubao,
                ["doubaoResourceId"] = updated.DoubaoResourceId,
                ["minimax"] = updated.MiniMax,
            }, SerializeOpts);
            var tmp = _file + ".tmp";
            File.WriteAllText(tmp, json);
            File.Move(tmp, _file, overwrite: true);
        }
    }

    /// <summary>脱敏（GET 返回用；不足 8 位全遮）。</summary>
    public static string? Mask(string? key)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            return null;
        }

        return key.Length <= 8 ? new string('*', key.Length) : key[..4] + new string('*', 6) + key[^4..];
    }

    private static string? Clean(string? v) => string.IsNullOrWhiteSpace(v) ? null : v.Trim();
}
