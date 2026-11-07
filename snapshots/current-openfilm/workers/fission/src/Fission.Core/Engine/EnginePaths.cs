namespace Fission.Core.Engine;

/// <summary>
/// 引擎与资产路径配置（唯一入口，禁止在业务代码硬编码绝对路径 —— PRD §10.2）。
/// 默认值指向本机原厂安装（D:\dev\7d），可被 config/appsettings.json 覆盖。
/// </summary>
public sealed record EnginePaths
{
    /// <summary>转码引擎（gyan full build，nvenc/qsv/amf/libplacebo）。</summary>
    public string FFmpeg { get; init; } = @"D:\dev\7d\bin\ffmpeg.exe";

    /// <summary>探测引擎。</summary>
    public string FFprobe { get; init; } = @"D:\dev\7d\bin\ffprobe.exe";

    /// <summary>转场引擎（4.1 msvc 定制版，gltransition GLSL 通道）。</summary>
    public string FFmpeg6 { get; init; } = @"D:\dev\7d\lib\ffmpeg6.exe";

    /// <summary>66 个 GLSL 转场着色器目录。</summary>
    public string TransitionsDir { get; init; } = @"D:\dev\7d\lib";

    /// <summary>原厂资产根（LUT/贴纸/蒙层/字体/特效视频）。</summary>
    public string AssetsRoot { get; init; } = @"D:\dev\7d";

    /// <summary>自建资产根（BGM 预设/自产库、配音库）。</summary>
    public string LocalAssetsRoot { get; init; } = @"D:\dev\7d-rebuild\assets";

    /// <summary>工作目录根（任务中间产物）。</summary>
    public string WorkRoot { get; init; } = @"D:\dev\7d-rebuild\work";

    /// <summary>输出目录根（成片）。</summary>
    public string OutRoot { get; init; } = @"D:\dev\7d-rebuild\out";

    /// <summary>逐一校验引擎文件存在性，返回 缺失路径列表（空 = 全部就绪）。</summary>
    public IReadOnlyList<string> ValidateEngines()
    {
        var missing = new List<string>();
        foreach (var p in new[] { FFmpeg, FFprobe, FFmpeg6 })
        {
            if (!File.Exists(p))
            {
                missing.Add(p);
            }
        }

        if (!Directory.Exists(TransitionsDir))
        {
            missing.Add(TransitionsDir);
        }

        return missing;
    }
}
