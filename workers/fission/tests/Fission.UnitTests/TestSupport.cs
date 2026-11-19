// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using System.Diagnostics;
using System.Text.Json;

namespace Fission.UnitTests;

/// <summary>
/// 测试夹具的显式注入环境。
/// 新契约下 <c>EnginePaths</c> 没有任何默认值（引擎/资产路径必须由调用方注入），单测同样不能依赖
/// 开发机默认路径，所以夹具必须自己**提供一个已注入的环境**：
/// 1. 隔离根：优先用外部注入的 <c>FISSION_PATH_POLICY_TEST_ROOT</c>；未注入时在本机规范临时目录下
///    自建 <c>fission-unit-tests</c> 根。根路径必须满足 <c>EnginePathPolicy</c> 的规范约束
///    （绝对路径、大写盘符、无 8.3 短名 <c>~</c>、新建段全小写 ASCII）。
/// 2. 真实子进程前置：node / dotnet 宿主 / Fission.Cli 程序集；优先环境变量，其次 PATH 与本目录发现。
/// 3. 证据文件：优先环境变量，否则在隔离根下生成唯一路径。
/// 缺任何真实前置都抛带修复说明的异常；不静默跳过、不猜默认开发机路径。
/// </summary>
internal static class TestEnvironment
{
    /// <summary>隔离根的环境变量名（外部注入时优先于自建根）。</summary>
    public const string RootVariable = "FISSION_PATH_POLICY_TEST_ROOT";

    private static readonly Lazy<string> LazyRoot = new(CreateOwnedRoot);
    private static readonly Lazy<string> LazyNode = new(() => Locate(
        "FISSION_TEST_NODE", "node", "安装 Node.js 或注入 FISSION_TEST_NODE=<node 绝对路径>", ["node.exe"]));
    private static readonly Lazy<string> LazyDotnetHost = new(() => Locate(
        "DOTNET_HOST_PATH", "dotnet", "安装 .NET SDK 或注入 DOTNET_HOST_PATH=<dotnet 绝对路径>", ["dotnet.exe"]));
    private static readonly Lazy<string> LazyCliAssembly = new(LocateCliAssembly);

    /// <summary>本进程独占的测试根（所有夹具目录都建在它下面）。</summary>
    public static string Root => LazyRoot.Value;

    /// <summary>真实 node 可执行文件（受控 CLI/进程池用例用）。</summary>
    public static string Node => LazyNode.Value;

    /// <summary>运行 Fission.Cli 的 dotnet 宿主。</summary>
    public static string DotnetHost => LazyDotnetHost.Value;

    /// <summary>Fission.Cli.dll 路径（测试输出目录里由 ProjectReference 带入）。</summary>
    public static string CliAssembly => LazyCliAssembly.Value;

    /// <summary>在隔离根下新建一个唯一目录。</summary>
    /// <param name="prefix">目录前缀（小写 ASCII，不含分隔符）。</param>
    public static string NewRoot(string prefix)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(prefix);
        var path = Path.Combine(Root, prefix + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    /// <summary>
    /// 证据/样例输出路径：外部注入的变量优先（必须绝对路径的父目录），否则在隔离根下取唯一文件名。
    /// 用例使用 <c>overwrite: false</c>，因此路径必须每次运行唯一。
    /// </summary>
    /// <param name="variable">环境变量名。</param>
    /// <param name="fileName">自建路径时使用的文件名。</param>
    public static string SampleOutput(string variable, string fileName)
    {
        var configured = Environment.GetEnvironmentVariable(variable);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            if (!Path.IsPathFullyQualified(configured))
                throw new InvalidOperationException($"{variable} 必须是绝对路径：{configured}");
            Directory.CreateDirectory(Path.GetDirectoryName(configured)!);
            return configured;
        }

        return Path.Combine(NewRoot("samples"), fileName);
    }

    private static string CreateOwnedRoot()
    {
        var configured = Environment.GetEnvironmentVariable(RootVariable);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            if (!Path.IsPathFullyQualified(configured))
                throw new InvalidOperationException($"{RootVariable} 必须是绝对路径：{configured}");
            if (configured.Contains('~', StringComparison.Ordinal))
                throw new InvalidOperationException(
                    $"{RootVariable} 不能是 8.3 短名（含 `~`，如 C:\\Users\\ADMINI~1\\...）：EnginePathPolicy 拒绝歧义路径，请改用长名绝对路径。");
            Directory.CreateDirectory(configured);
            return Path.GetFullPath(configured);
        }

        // 自建根：只接受规范的候选目录，缺一段就换下一个，绝不猜 D:\dev 之类的开发机路径。
        foreach (var candidate in new[]
                 {
                     Path.GetTempPath(),
                     Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                 })
        {
            if (string.IsNullOrWhiteSpace(candidate) || !Path.IsPathFullyQualified(candidate)
                || candidate.Contains('~', StringComparison.Ordinal)) continue;
            var root = Path.Combine(Path.GetFullPath(candidate), "fission-unit-tests");
            Directory.CreateDirectory(root);
            return root;
        }

        throw new InvalidOperationException($"没有可用的规范临时目录：请注入 {RootVariable}=<长名绝对路径>。");
    }

    private static string Locate(string variable, string command, string repair, string[] fileNames)
    {
        var configured = Environment.GetEnvironmentVariable(variable);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            if (!Path.IsPathFullyQualified(configured) || !File.Exists(configured))
                throw new InvalidOperationException($"{variable} 必须是存在文件的绝对路径：{configured}");
            return configured;
        }

        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
                     .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!Path.IsPathFullyQualified(directory)) continue;
            foreach (var fileName in fileNames)
            {
                var candidate = Path.Combine(directory, fileName);
                if (File.Exists(candidate)) return candidate;
            }
        }

        throw new InvalidOperationException($"找不到 {command}：{repair}（用例需要真实子进程，不做静默跳过）。");
    }

    private static string LocateCliAssembly()
    {
        var configured = Environment.GetEnvironmentVariable("FISSION_TEST_CLI");
        var candidate = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(AppContext.BaseDirectory, "Fission.Cli.dll")
            : configured;
        if (!Path.IsPathFullyQualified(candidate) || !File.Exists(candidate))
            throw new InvalidOperationException(
                $"找不到 Fission.Cli.dll：请先构建解决方案，或注入 FISSION_TEST_CLI=<绝对路径>。当前：{candidate}");
        return candidate;
    }
}

/// <summary>
/// 假引擎路径夹具：在隔离目录里建出可检查的「引擎/资产」文件，供 <c>EnginePaths</c>、
/// <c>EnginePathPolicy</c> 与 <c>EnginePathsSource</c> 的注入契约测试共用（永不执行）。
/// </summary>
internal sealed class FakeEnginePaths
{
    private FakeEnginePaths(string root, bool withOptionalTransitionEngine)
    {
        Root = root;
        Read = Path.Combine(root, "read");
        Directory.CreateDirectory(Read);
        FFmpeg = Marker("ffmpeg.exe");
        FFprobe = Marker("ffprobe.exe");
        TransitionEngine = withOptionalTransitionEngine ? Marker("ffmpeg6.exe") : string.Empty;
        File.WriteAllText(Path.Combine(Read, "fade.glsl"), "synthetic shader never executed");
        HasOptionalTransitionEngine = withOptionalTransitionEngine;
    }

    /// <summary>夹具根目录。</summary>
    public string Root { get; }

    /// <summary>只读引擎/资产目录（同时充当 TransitionsDir/AssetsRoot/LocalAssetsRoot）。</summary>
    public string Read { get; }

    /// <summary>转码引擎标记文件。</summary>
    public string FFmpeg { get; }

    /// <summary>探测引擎标记文件。</summary>
    public string FFprobe { get; }

    /// <summary>可选 gltransition 引擎标记文件；未启用时为空串。</summary>
    public string TransitionEngine { get; }

    /// <summary>是否启用可选 FFmpeg6。</summary>
    public bool HasOptionalTransitionEngine { get; }

    /// <summary>在隔离根下建立假引擎路径。</summary>
    /// <param name="prefix">隔离目录前缀。</param>
    /// <param name="withOptionalTransitionEngine">是否注入可选 FFmpeg6。</param>
    public static FakeEnginePaths Create(string prefix = "fake-engines", bool withOptionalTransitionEngine = true)
        => new(TestEnvironment.NewRoot(prefix), withOptionalTransitionEngine);

    /// <summary>写成 <c>EnginePaths</c>（受控运行由 EnginePathPolicy 派生写根）。</summary>
    public Fission.Core.Engine.EnginePaths ToEnginePaths() => new()
    {
        FFmpeg = FFmpeg,
        FFprobe = FFprobe,
        FFmpeg6 = TransitionEngine,
        TransitionsDir = Read,
        AssetsRoot = Read,
        LocalAssetsRoot = Read,
    };

    /// <summary>
    /// 把本夹具序列化成 <c>EnginePathsSource</c> 认的配置 JSON。
    /// 省略可选 FFmpeg6 键表示"未启用 gltransition"；写空串是配置错误，因此默认跟随夹具是否注入。
    /// </summary>
    /// <param name="includeOptionalTransitionEngine">是否写入 FFmpeg6 键；null 跟随夹具注入情况。</param>
    /// <param name="includeHostWriteRoots">是否写入非受控宿主的 WorkRoot/OutRoot。</param>
    public string ToConfigJson(bool? includeOptionalTransitionEngine = null, bool includeHostWriteRoots = false)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["FFmpeg"] = FFmpeg,
            ["FFprobe"] = FFprobe,
            ["TransitionsDir"] = Read,
            ["AssetsRoot"] = Read,
            ["LocalAssetsRoot"] = Read,
        };
        if (includeOptionalTransitionEngine ?? HasOptionalTransitionEngine) values["FFmpeg6"] = TransitionEngine;
        if (includeHostWriteRoots)
        {
            values["WorkRoot"] = Path.Combine(Root, "work");
            values["OutRoot"] = Path.Combine(Root, "out");
        }

        return JsonSerializer.Serialize(values);
    }

    /// <summary>把配置 JSON 落到磁盘并返回绝对路径（<c>EnginePathsSource.Load</c> 的入参）。</summary>
    /// <param name="json">配置内容；null 用本夹具默认内容。</param>
    /// <param name="fileName">文件名。</param>
    public string WriteConfig(string? json = null, string fileName = "engine-paths.json")
    {
        var path = Path.Combine(Root, fileName);
        File.WriteAllText(path, json ?? ToConfigJson());
        return path;
    }

    private string Marker(string name)
    {
        var path = Path.Combine(Read, name);
        File.WriteAllText(path, "synthetic engine marker; never executed");
        return path;
    }
}

/// <summary>环境变量临时改写：用例结束后恢复原值（进程级，用例内串行使用）。</summary>
internal sealed class TemporaryEnvironmentVariable : IDisposable
{
    private readonly string name;
    private readonly string? original;

    private TemporaryEnvironmentVariable(string name)
    {
        this.name = name;
        original = Environment.GetEnvironmentVariable(name);
    }

    /// <summary>设置变量并登记恢复。</summary>
    /// <param name="name">变量名。</param>
    /// <param name="value">新值；null 表示删除。</param>
    public static TemporaryEnvironmentVariable Set(string name, string? value)
    {
        var scope = new TemporaryEnvironmentVariable(name);
        Environment.SetEnvironmentVariable(name, value);
        return scope;
    }

    /// <inheritdoc />
    public void Dispose() => Environment.SetEnvironmentVariable(name, original);
}
