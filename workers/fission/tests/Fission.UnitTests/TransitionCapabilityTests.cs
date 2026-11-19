// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using Fission.Core.Engine;
using Fission.Providers.Media;

namespace Fission.UnitTests;

// 转场后端选择/映射/命令的纯逻辑测试：不执行任何引擎、不触碰真实资产。
public sealed class TransitionCapabilityTests
{
    private static EnginePaths Paths(bool withFfmpeg6) => new()
    {
        FFmpeg = @"C:\engines\ffmpeg.exe",
        FFprobe = @"C:\engines\ffprobe.exe",
        FFmpeg6 = withFfmpeg6 ? @"C:\engines\ffmpeg6.exe" : string.Empty,
        TransitionsDir = @"C:\assets\glsl",
        AssetsRoot = @"C:\assets",
        LocalAssetsRoot = @"C:\assets-local",
    };

    [Fact]
    public void HasFilter_MatchesTheNameColumnNotProse()
    {
        const string listing = "Filters:\n TSC blend             VV->V      Blend two video frames into each other.\n"
            + " .S. xfade             VV->V      Cross fade one video with another video.\n"
            + " TSC gltransition      VV->V      GLSL transition.\n";
        Assert.True(TransitionEngineProbe.HasFilter(listing, "xfade"));
        Assert.True(TransitionEngineProbe.HasFilter(listing, "gltransition"));
        Assert.False(TransitionEngineProbe.HasFilter(listing, "blendx"));
        Assert.False(TransitionEngineProbe.HasFilter(string.Empty, "xfade"));
    }

    [Fact]
    public void SelectBackend_PrefersGlTransitionWhenAvailable()
    {
        var capability = new TransitionCapability(true, true, "both");
        var backend = TransitionCatalog.SelectBackend(capability, "fade", @"C:\assets\glsl\fade.glsl", Paths(true));
        Assert.NotNull(backend);
        Assert.Equal(TransitionBackendKind.GlTransition, backend!.Kind);
        Assert.Equal(@"C:\engines\ffmpeg6.exe", backend.Engine);
        Assert.Equal("applied", backend.Outcome);
    }

    [Fact]
    public void SelectBackend_WithoutGlTransition_DegradesToMappedXfade()
    {
        // 单引擎 9.0.2：无 gltransition、有 xfade，且转场可映射 → 降级到内置 xfade。
        var capability = new TransitionCapability(false, true, "未注入 FFmpeg6：gltransition 可选能力缺失；xfade 可用");
        var backend = TransitionCatalog.SelectBackend(capability, "wipeLeft", string.Empty, Paths(false));
        Assert.NotNull(backend);
        Assert.Equal(TransitionBackendKind.Xfade, backend!.Kind);
        Assert.Equal(@"C:\engines\ffmpeg.exe", backend.Engine);
        Assert.Equal("wipeleft", backend.Filter);
        Assert.Equal("applied-xfade", backend.Outcome);
        Assert.Contains("可选能力缺失", backend.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void SelectBackend_UnmappedOrUnsupported_ReturnsNullForExplicitFallback()
    {
        var xfadeOnly = new TransitionCapability(false, true, "xfade only");
        Assert.Null(TransitionCatalog.SelectBackend(xfadeOnly, "GlitchMemories", string.Empty, Paths(false)));
        Assert.Null(TransitionCatalog.SelectBackend(xfadeOnly, "luma", string.Empty, Paths(false)));
        Assert.Null(TransitionCatalog.SelectBackend(new TransitionCapability(false, false, "none"), "fade", string.Empty, Paths(false)));
        // gltransition 可用但没有着色器路径时不能生成 gltransition 命令，继续降级。
        Assert.Equal(TransitionBackendKind.Xfade,
            TransitionCatalog.SelectBackend(new TransitionCapability(true, true, "both"), "fade", string.Empty, Paths(true))!.Kind);
    }

    [Theory]
    [InlineData("fade", "fade")]
    [InlineData("fadegrayscale", "fadegrays")]
    [InlineData("circleopen", "circleopen")]
    [InlineData("CircleCrop", "circlecrop")]
    [InlineData("RectangleCrop", "rectcrop")]
    [InlineData("wipeUp", "wipeup")]
    [InlineData("squeeze", "squeezev")]
    [InlineData("scale-in", "zoomin")]
    public void TryMapToXfade_MapsKnownNames(string name, string expected)
    {
        Assert.True(TransitionCatalog.TryMapToXfade(name, out var xfade));
        Assert.Equal(expected, xfade);
    }

    [Fact]
    public void XfadeMap_OnlyContainsNamesThatExistInFfmpeg9()
    {
        // FFmpeg 9.0.2（gyan essentials）xfade 的全部转场名，实测自 -h filter=xfade。
        var ffmpeg9 = new HashSet<string>(StringComparer.Ordinal)
        {
            "fade", "wipeleft", "wiperight", "wipeup", "wipedown", "slideleft", "slideright", "slideup", "slidedown",
            "circlecrop", "rectcrop", "distance", "fadeblack", "fadewhite", "radial", "smoothleft", "smoothright",
            "smoothup", "smoothdown", "circleopen", "circleclose", "vertopen", "vertclose", "horzopen", "horzclose",
            "dissolve", "pixelize", "diagtl", "diagtr", "diagbl", "diagbr", "hlslice", "hrslice", "vuslice", "vdslice",
            "hblur", "fadegrays", "wipetl", "wipetr", "wipebl", "wipebr", "squeezeh", "squeezev", "zoomin", "fadefast",
            "fadeslow", "hlwind", "hrwind", "vuwind", "vdwind", "coverleft", "coverright", "coverup", "coverdown",
            "revealleft", "revealright", "revealup", "revealdown",
        };
        Assert.All(TransitionCatalog.XfadeMap, pair => Assert.Contains(pair.Value, ffmpeg9));
    }

    [Fact]
    public void EntryTransitionXfade_KeepsSecondInputDurationSemantics()
    {
        var args = CommandBuilders.EntryTransitionXfade("tail.mp4", "seg.mp4", "out.mp4", 0.3, "circleopen");
        Assert.Contains("xfade=transition=circleopen:duration=0.3:offset=0", args, StringComparison.Ordinal);
        Assert.Contains("[0:v]settb=AVTB,setpts=PTS-STARTPTS[a]", args, StringComparison.Ordinal);
        Assert.Contains("[1:v]settb=AVTB,setpts=PTS-STARTPTS[b]", args, StringComparison.Ordinal);
        Assert.DoesNotContain("gltransition", args, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidateConfiguration_WithoutInjectedPaths_ReportsMissingKeysNotDefaults()
    {
        var error = Assert.Throws<Fission.Core.Errors.ConfigException>(() => new EnginePaths().ValidateConfiguration());
        Assert.Equal("CFG_ENGINE_PATHS", error.Code);
        Assert.Contains("FFmpeg", error.Message, StringComparison.Ordinal);
        var injected = Paths(false);
        injected.ValidateConfiguration();
        Assert.DoesNotContain(injected.ValidateEngines(), m => m.Contains("未注入", StringComparison.Ordinal));
    }
}
