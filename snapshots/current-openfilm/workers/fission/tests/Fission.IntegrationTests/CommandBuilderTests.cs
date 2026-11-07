using Fission.Core.Pipeline;
using Fission.Providers.Media;
using Xunit;

namespace Fission.IntegrationTests;

/// <summary>命令构建器参数面（组变速 setpts / 图转视频 loop+pad；原版网格「视频变速」「图片数」列的命令级语义）。</summary>
public class CommandBuilderTests
{
    [Fact]
    public void Cut_SpeedAppendsSetpts()
    {
        var args = CommandBuilders.Cut("in.mp4", "out.mp4", new CutSpan(0, 5), hflip: false, nvenc: false, encThreads: 4, speed: 2.0);
        Assert.Contains("setpts=PTS/2", args);
        Assert.DoesNotContain("hflip", args);
    }

    [Fact]
    public void Cut_SpeedOne_OmitsSetpts()
    {
        var args = CommandBuilders.Cut("in.mp4", "out.mp4", new CutSpan(0, 5), hflip: false, nvenc: false, encThreads: 4);
        Assert.DoesNotContain("setpts", args);
    }

    [Fact]
    public void Cut_FlipAndSpeed_ChainOrder()
    {
        var args = CommandBuilders.Cut("in.mp4", "out.mp4", new CutSpan(0, 5), hflip: true, nvenc: false, encThreads: 4, speed: 1.5);
        Assert.Contains("\"hflip,setpts=PTS/1.5,format=yuv420p\"", args);
    }

    [Fact]
    public void ImageToVideo_LoopPadDuration()
    {
        var args = CommandBuilders.ImageToVideo("img.jpg", "clip.mp4", durSec: 3.5, width: 1080, height: 1920, fps: 30, nvenc: false, encThreads: 4);
        Assert.StartsWith("-y -loop 1 -i \"img.jpg\" -t 3.50", args);
        Assert.Contains("scale=1080:1920:force_original_aspect_ratio=decrease", args);
        Assert.Contains("pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black", args);
        Assert.Contains("fps=30", args);
        Assert.DoesNotContain("-an -an", args); // 无重复参数拼接
    }

    [Fact]
    public void NormalizeArgs_BoxScaledAndPadded()
    {
        var args = FFmpegProvider.BuildNormalizeArgs("in.mov", "n.mp4", 1080, 1920, 30, useNvenc: false, hwDecode: false);
        Assert.Contains("scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,fps=30", args);
        Assert.DoesNotContain("scale=-2", args); // 只锁高会把横版源放大成异规格（实测 3414×1920）
    }

    [Fact]
    public void TransitionPair_SinglePairShapeAndPathEscaping()
    {
        var args = CommandBuilders.EntryTransition("tail.mp4", "b.mp4", "out.mp4", 0.3, @"D:\dev\7d\lib\crosswarp.glsl");
        Assert.Contains("-i \"tail.mp4\" -i \"b.mp4\"", args);
        Assert.Contains("[0:v][1:v]gltransition=offset=0:duration=0.3:source='D\\:/dev/7d/lib/crosswarp.glsl'[vt]", args);
        Assert.Contains("-map \"[vt]\" -an", args);
        Assert.DoesNotContain("[v1]", args); // 单实例（多实例链在该构建塌时长，实测教训）
    }

    [Fact]
    public void TakeTail_SseofFromEnd()
    {
        var args = CommandBuilders.TakeTail("c0.mp4", "tail.mp4", 0.3);
        Assert.StartsWith("-y -sseof -0.5 -i \"c0.mp4\" -t 0.3 -an", args);
        Assert.Contains("libx264", args);
    }

    [Fact]
    public void BurnSubtitle_AssFilterEscaping()
    {
        var args = CommandBuilders.BurnSubtitle("in.mp4", "out.mp4", @"D:\w\sub.ass", nvenc: false, encThreads: 4, fontsDir: @"C:\Windows\Fonts");
        Assert.Contains("ass=filename='D\\:/w/sub.ass':fontsdir='C\\:/Windows/Fonts'", args);
        Assert.Contains("-c:a copy", args); // 字幕烧录不重编音频
    }

    [Fact]
    public void TransitionCatalog_RealLibHas66AndFallsBack()
    {
        var dir = @"D:\dev\7d\lib";
        if (!Directory.Exists(dir))
        {
            return; // 非 D 盘开发机跳过（CI 不依赖原厂资产）
        }

        var names = TransitionCatalog.List(dir);
        Assert.True(names.Count >= 60, $"GLSL 目录应 ≥60 个，实际 {names.Count}");
        var rng = new Fission.Core.Util.SeededRandom(7);
        var (path, name, fellBack) = TransitionCatalog.Resolve(dir, "不存在的东西", rng);
        Assert.True(fellBack);
        Assert.Equal("fade", name);
        var (rPath, rName, rFell) = TransitionCatalog.Resolve(dir, "random", rng);
        Assert.False(rFell);
        Assert.True(File.Exists(rPath));
    }
}
