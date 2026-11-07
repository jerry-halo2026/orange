using Fission.Core.Engine;

namespace Fission.Providers.Assets;

/// <summary>资产类目（对齐原版目录语义，PRD FR-7）。</summary>
public enum AssetKind
{
    Lut,
    Sticker,
    EffectVideo,
    EffectGif,
    Border,
    Mask,
    Font,
    Transition,
    BgmPreset,
    BgmLibrary,
}

/// <summary>资产清单项。</summary>
/// <param name="Kind">类目。</param>
/// <param name="Name">显示名（去扩展名）。</param>
/// <param name="Path">绝对路径。</param>
/// <param name="Group">分组（LUT 系列/贴纸包/转场名）。</param>
public sealed record AssetItem(AssetKind Kind, string Name, string Path, string Group);

/// <summary>
/// 资产注册表：扫描原厂资产目录 + 自建资产目录（PRD §7.1）。
/// 只读扫描、启动/刷新时执行；上传入库流水（hash/LUFS）属 BgmRegistry/VoiceRegistry，二批的 M3/M4 接入。
/// </summary>
public sealed class AssetRegistry(EnginePaths paths)
{
    /// <summary>扫描全部类目并返回清单（目录缺失的类目跳过不报错）。</summary>
    public IReadOnlyList<AssetItem> ScanAll()
    {
        var items = new List<AssetItem>();
        items.AddRange(ScanLuts(Path.Combine(paths.AssetsRoot, "智能滤镜")));
        items.AddRange(ScanLuts(Path.Combine(paths.AssetsRoot, "探店美食滤镜")));
        items.AddRange(ScanGifDir(Path.Combine(paths.AssetsRoot, "特效动图"), AssetKind.EffectGif));
        items.AddRange(ScanVideos(Path.Combine(paths.AssetsRoot, "更多特效视频"), AssetKind.EffectVideo));
        items.AddRange(ScanStickerPacks(Path.Combine(paths.AssetsRoot, "更多贴纸")));
        items.AddRange(ScanPlain(Path.Combine(paths.AssetsRoot, "图片边框"), AssetKind.Border, "*.png"));
        items.AddRange(ScanPlain(Path.Combine(paths.AssetsRoot, "fonts"), AssetKind.Font, "*.tt?;*.otf;*.ttc"));
        items.AddRange(ScanTransitions(paths.TransitionsDir));
        items.AddRange(ScanAudio(Path.Combine(paths.LocalAssetsRoot, "bgm", "preset"), AssetKind.BgmPreset));
        items.AddRange(ScanAudio(Path.Combine(paths.LocalAssetsRoot, "bgm", "library"), AssetKind.BgmLibrary));
        return items;
    }

    /// <summary>类目统计（池卡片/doctor 呈现）。</summary>
    public IReadOnlyDictionary<AssetKind, int> Summary()
    {
        var all = ScanAll();
        return all.GroupBy(i => i.Kind).ToDictionary(g => g.Key, g => g.Count());
    }

    private static IEnumerable<AssetItem> ScanLuts(string dir)
    {
        if (!Directory.Exists(dir))
        {
            return [];
        }

        return Directory.EnumerateFiles(dir, "*.cube", SearchOption.AllDirectories)
            .Select(f => new AssetItem(AssetKind.Lut, Path.GetFileNameWithoutExtension(f), f,
                Path.GetFileName(Path.GetDirectoryName(f)!)));
    }

    private static IEnumerable<AssetItem> ScanGifDir(string dir, AssetKind kind)
    {
        if (!Directory.Exists(dir))
        {
            return [];
        }

        return Directory.EnumerateFiles(dir, "*.gif", SearchOption.TopDirectoryOnly)
            .Select(f => new AssetItem(kind, Path.GetFileNameWithoutExtension(f), f, string.Empty));
    }

    private static IEnumerable<AssetItem> ScanVideos(string dir, AssetKind kind)
    {
        if (!Directory.Exists(dir))
        {
            return [];
        }

        return Directory.EnumerateFiles(dir, "*.mp4", SearchOption.TopDirectoryOnly)
            .Select(f => new AssetItem(kind, Path.GetFileNameWithoutExtension(f), f, string.Empty));
    }

    private static IEnumerable<AssetItem> ScanStickerPacks(string dir)
    {
        if (!Directory.Exists(dir))
        {
            return [];
        }

        return Directory.EnumerateDirectories(dir)
            .SelectMany(pack => Directory.EnumerateFiles(pack, "*.*", SearchOption.TopDirectoryOnly)
                .Where(f => ExtensionOf(f) is ".gif" or ".png" or ".jpg")
                .Select(f => new AssetItem(AssetKind.Sticker, Path.GetFileNameWithoutExtension(f), f, Path.GetFileName(pack))));
    }

    private static IEnumerable<AssetItem> ScanPlain(string dir, AssetKind kind, string pattern)
    {
        if (!Directory.Exists(dir))
        {
            return [];
        }

        var exts = pattern.Split(';');
        var files = Directory.EnumerateFiles(dir, "*.*", SearchOption.TopDirectoryOnly)
            .Where(f => exts.Contains(ExtensionOf(f), StringComparer.OrdinalIgnoreCase));
        return files.Select(f => new AssetItem(kind, Path.GetFileNameWithoutExtension(f), f, string.Empty));
    }

    private static IEnumerable<AssetItem> ScanTransitions(string dir)
    {
        if (!Directory.Exists(dir))
        {
            return [];
        }

        return Directory.EnumerateFiles(dir, "*.glsl", SearchOption.TopDirectoryOnly)
            .Select(f => new AssetItem(AssetKind.Transition, Path.GetFileNameWithoutExtension(f), f, "gltransition"));
    }

    private static IEnumerable<AssetItem> ScanAudio(string dir, AssetKind kind)
    {
        if (!Directory.Exists(dir))
        {
            return [];
        }

        return Directory.EnumerateFiles(dir, "*.mp3", SearchOption.TopDirectoryOnly)
            .Concat(Directory.EnumerateFiles(dir, "*.wav", SearchOption.TopDirectoryOnly))
            .Concat(Directory.EnumerateFiles(dir, "*.m4a", SearchOption.TopDirectoryOnly))
            .Select(f => new AssetItem(kind, Path.GetFileNameWithoutExtension(f), f, string.Empty));
    }

    private static string ExtensionOf(string file) => Path.GetExtension(file).ToLowerInvariant();
}
