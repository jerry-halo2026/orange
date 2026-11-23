// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using Fission.Core.Engine;
using Fission.Core.Errors;

namespace Fission.UnitTests;

/// <summary>
/// 新契约：引擎/资产路径没有任何默认值，非受控宿主必须由 <c>FISSION_ENGINE_PATHS</c> 指向的
/// 显式 JSON 注入。<c>FFmpeg6</c> 是可选能力（缺省即"未启用 gltransition"），
/// <c>WorkRoot/OutRoot</c> 是宿主必需写根；所有错误收敛为 CFG_ENGINE_PATHS 且不泄露绝对路径。
/// </summary>
public sealed class EnginePathsSourceTests
{
    [Fact]
    public void Load_InjectedJsonWithoutOptionalFFmpeg6_KeepsSingleEnginePath()
    {
        var fake = FakeEnginePaths.Create("paths-single", withOptionalTransitionEngine: false);
        var paths = EnginePathsSource.Load(fake.WriteConfig(fake.ToConfigJson(includeHostWriteRoots: true)));
        Assert.False(paths.HasFFmpeg6);
        Assert.Equal(string.Empty, paths.FFmpeg6);
        Assert.Equal(new[] { fake.FFmpeg, fake.FFprobe }, paths.EngineExecutables());
        paths.ValidateConfiguration();
        Assert.Empty(paths.UnconfiguredRequiredKeys());
    }

    [Fact]
    public void Load_InjectedJsonWithOptionalFFmpeg6_AddsTheThirdEngine()
    {
        var fake = FakeEnginePaths.Create("paths-with6");
        var paths = EnginePathsSource.Load(fake.WriteConfig(fake.ToConfigJson(includeHostWriteRoots: true)));
        Assert.True(paths.HasFFmpeg6);
        Assert.Equal(fake.TransitionEngine, paths.FFmpeg6);
        Assert.Equal(new[] { fake.FFmpeg, fake.FFprobe, fake.TransitionEngine }, paths.EngineExecutables());
    }

    [Fact]
    public void Load_OptionalFontsDir_IsParsedInsteadOfDropped()
    {
        /* macOS 的随包字体目录：OptionalKeys 里已经有了，Parse 必须真的映射进 EnginePaths，否则"接受但静默丢弃"。 */
        var fake = FakeEnginePaths.Create("paths-fontsdir");
        var values = System.Text.Json.Nodes.JsonNode.Parse(fake.ToConfigJson(includeHostWriteRoots: true))!.AsObject();
        values["FontsDir"] = fake.Read;
        var paths = EnginePathsSource.Load(fake.WriteConfig(values.ToJsonString()));
        Assert.True(paths.HasFontsDir);
        Assert.Equal(fake.Read, paths.FontsDir);
    }

    [Fact]
    public void Load_MissingHostWriteRoots_RejectsNamingTheRequiredKey()
    {
        var fake = FakeEnginePaths.Create("paths-nowriteroots");
        var file = fake.WriteConfig(fake.ToConfigJson(includeHostWriteRoots: false));
        var error = Assert.Throws<ConfigException>(() => EnginePathsSource.Load(file));
        Assert.Equal("CFG_ENGINE_PATHS", error.Code);
        Assert.Contains("WorkRoot", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(fake.Root, error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("FFmpeg")]
    [InlineData("FFprobe")]
    [InlineData("TransitionsDir")]
    [InlineData("AssetsRoot")]
    [InlineData("LocalAssetsRoot")]
    public void Load_MissingRequiredEngineKey_RejectsInsteadOfSubstitutingADefault(string key)
    {
        var fake = FakeEnginePaths.Create("paths-missing-" + key.ToLowerInvariant());
        var values = System.Text.Json.Nodes.JsonNode.Parse(fake.ToConfigJson(includeHostWriteRoots: true))!.AsObject();
        values.Remove(key);
        var error = Assert.Throws<ConfigException>(() => EnginePathsSource.Load(fake.WriteConfig(values.ToJsonString())));
        Assert.Equal("CFG_ENGINE_PATHS", error.Code);
        Assert.Contains(key, error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Load_RelativeOrNonExistentConfigurationPath_RejectsWithoutLeakingPaths()
    {
        var relative = Assert.Throws<ConfigException>(() => EnginePathsSource.Load("engine-paths.json"));
        Assert.Equal("CFG_ENGINE_PATHS", relative.Code);
        Assert.Contains("绝对路径", relative.Message, StringComparison.Ordinal);

        var missing = Path.Combine(TestEnvironment.NewRoot("paths-missing-file"), "absent.json");
        var error = Assert.Throws<ConfigException>(() => EnginePathsSource.Load(missing));
        Assert.Equal("CFG_ENGINE_PATHS", error.Code);
        Assert.DoesNotContain(missing, error.Message, StringComparison.Ordinal);
        Assert.Null(error.InnerException);
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{\"FFmpeg\":42}")]
    [InlineData("{\"FFmpeg\":\"C:\\\\engines\\\\ffmpeg.exe\",\"Unknown\":\"C:\\\\engines\\\\x.exe\"}")]
    public void Load_NonObjectUnknownKeyOrNonStringValue_Rejects(string json)
    {
        var fake = FakeEnginePaths.Create("paths-bad-shape");
        var error = Assert.Throws<ConfigException>(() => EnginePathsSource.Load(fake.WriteConfig(json, "bad.json")));
        Assert.Equal("CFG_ENGINE_PATHS", error.Code);
    }

    [Fact]
    public void Load_ExplicitEmptyOptionalValue_RejectsInsteadOfSilentlyDisabling()
    {
        // 可选 != 可以写空值：省略 FFmpeg6 表示"未启用"；写空串是配置错误。
        var fake = FakeEnginePaths.Create("paths-empty6");
        var values = System.Text.Json.Nodes.JsonNode.Parse(fake.ToConfigJson(includeHostWriteRoots: true))!.AsObject();
        values["FFmpeg6"] = " ";
        var error = Assert.Throws<ConfigException>(() => EnginePathsSource.Load(fake.WriteConfig(values.ToJsonString(), "empty.json")));
        Assert.Equal("CFG_ENGINE_PATHS", error.Code);
    }

    [Fact]
    public void Load_RelativeEngineValue_Rejects()
    {
        var fake = FakeEnginePaths.Create("paths-relative-value");
        var values = System.Text.Json.Nodes.JsonNode.Parse(fake.ToConfigJson(includeHostWriteRoots: true))!.AsObject();
        values["FFmpeg"] = "ffmpeg.exe";
        var error = Assert.Throws<ConfigException>(() => EnginePathsSource.Load(fake.WriteConfig(values.ToJsonString(), "relative.json")));
        Assert.Equal("CFG_ENGINE_PATHS", error.Code);
    }

    [Fact]
    public void Load_OversizedConfiguration_Rejects()
    {
        var fake = FakeEnginePaths.Create("paths-oversized");
        var file = Path.Combine(fake.Root, "huge.json");
        File.WriteAllText(file, new string(' ', 300 * 1024));
        var error = Assert.Throws<ConfigException>(() => EnginePathsSource.Load(file));
        Assert.Equal("CFG_ENGINE_PATHS", error.Code);
    }

    [Fact]
    public void LoadConfigured_WithoutEnvironmentVariable_RejectsInsteadOfGuessingDefaults()
    {
        using var scope = TemporaryEnvironmentVariable.Set(EnginePathsSource.EnvironmentVariable, null);
        var error = Assert.Throws<ConfigException>(EnginePathsSource.LoadConfigured);
        Assert.Equal("CFG_ENGINE_PATHS", error.Code);
        Assert.Contains(EnginePathsSource.EnvironmentVariable, error.Message, StringComparison.Ordinal);
        Assert.Contains("不猜测默认路径", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadConfigured_RelativeEnvironmentValue_Rejects()
    {
        using var scope = TemporaryEnvironmentVariable.Set(EnginePathsSource.EnvironmentVariable, "engine-paths.json");
        var error = Assert.Throws<ConfigException>(EnginePathsSource.LoadConfigured);
        Assert.Equal("CFG_ENGINE_PATHS", error.Code);
    }

    [Fact]
    public void LoadConfigured_FromEnvironment_FeedsTheSingleEngineControlledPolicy()
    {
        // 端到端注入链：环境变量 -> EnginePathsSource -> EnginePathPolicy（假 ffmpeg，永不执行）。
        var fake = FakeEnginePaths.Create("paths-e2e", withOptionalTransitionEngine: false);
        using var scope = TemporaryEnvironmentVariable.Set(
            EnginePathsSource.EnvironmentVariable, fake.WriteConfig(fake.ToConfigJson(includeHostWriteRoots: true)));

        var injected = EnginePathsSource.LoadConfigured();
        var policy = new EnginePathPolicy(injected, Path.Combine(fake.Root, "owned"), "task-a", "attempt-1");

        Assert.False(policy.Paths.HasFFmpeg6);
        Assert.Equal(new[] { fake.FFmpeg, fake.FFprobe }, policy.Paths.EngineExecutables());
        Assert.Equal(fake.Read, policy.Paths.TransitionsDir);
        Assert.StartsWith(Path.Combine(fake.Root, "owned"), policy.Paths.WorkRoot, StringComparison.Ordinal);
        Assert.Empty(policy.Paths.UnconfiguredRequiredKeys());
        Assert.Empty(policy.Paths.ValidateEngines());
    }

    [Fact]
    public void LoadConfigured_InjectedJson_IsTheOnlySourceOfEnginePaths()
    {
        // 新契约的"无默认值"事实：未注入任何内容时，EnginePaths 的每个引擎/资产键都为空。
        var defaults = new EnginePaths();
        Assert.Equal(string.Empty, defaults.FFmpeg);
        Assert.Equal(string.Empty, defaults.FFprobe);
        Assert.Equal(string.Empty, defaults.FFmpeg6);
        Assert.Equal(string.Empty, defaults.TransitionsDir);
        Assert.Equal(string.Empty, defaults.AssetsRoot);
        Assert.Equal(string.Empty, defaults.LocalAssetsRoot);
        Assert.Equal(EnginePaths.RequiredKeys, defaults.UnconfiguredRequiredKeys());
    }
}
