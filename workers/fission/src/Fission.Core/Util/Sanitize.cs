namespace Fission.Core.Util;

/// <summary>导出文件名清洗（PRD FR-8.5：非法字符→_；≤80 字符；重名追加序号；空回退）。</summary>
public static class FileNameSanitizer
{
    private static readonly char[] Invalid = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

    /// <summary>清洗单名（不含扩展名）。</summary>
    public static string Sanitize(string name, int maxLen = 80)
    {
        var clean = new string(name.Select(c => Invalid.Contains(c) ? '_' : c).ToArray()).Trim();
        if (clean.Length == 0)
        {
            clean = "未命名";
        }

        foreach (var c in Path.GetInvalidFileNameChars())
        {
            clean = clean.Replace(c, '_');
        }

        return clean.Length <= maxLen ? clean : clean[..maxLen];
    }

    /// <summary>确保目标不重名：存在则追加 _2/_3…。</summary>
    public static string Uniquify(string path)
    {
        if (!File.Exists(path))
        {
            return path;
        }

        var dir = Path.GetDirectoryName(path)!;
        var stem = Path.GetFileNameWithoutExtension(path);
        var ext = Path.GetExtension(path);
        for (var i = 2; ; i++)
        {
            var candidate = Path.Combine(dir, $"{stem}_{i}{ext}");
            if (!File.Exists(candidate))
            {
                return candidate;
            }
        }
    }
}

/// <summary>种子化随机（PRD §7.3：同种子同参数 ⇒ 同输出）。输出索引即种子，保证并发各自独立且可复现。</summary>
public sealed class SeededRandom(int seed) : Random(seed)
{
    /// <summary>从序列随机取一个。</summary>
    public T PickOne<T>(IReadOnlyList<T> list) => list[Next(list.Count)];

    /// <summary>随机左右翻转（默认 50% 概率）。</summary>
    public bool CoinFlip(double p = 0.5) => NextDouble() < p;

    /// <summary>区间随机。</summary>
    public double Between(double lo, double hi) => lo + (NextDouble() * (hi - lo));
}
