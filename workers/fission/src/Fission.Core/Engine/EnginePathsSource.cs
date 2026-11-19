// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using System.Text.Json;
using Fission.Core.Errors;

namespace Fission.Core.Engine;

/// <summary>
/// 非受控宿主（doctor / normalize / Web）唯一取引擎路径的入口：由调用方注入一个
/// 显式 JSON 文件（环境变量 <see cref="EnvironmentVariable"/>），不含任何内置默认路径。
/// 文件必须给出 <see cref="EnginePaths.RequiredKeys"/> 与 <see cref="EnginePaths.HostWriteRootKeys"/>；
/// FFmpeg6 是可选键，缺省即"未启用 gltransition"，不算配置错误。
/// 错误一律收敛为 CFG_ENGINE_PATHS，消息不含绝对路径。
/// </summary>
public static class EnginePathsSource
{
    /// <summary>指向引擎/资产路径 JSON 的环境变量名。</summary>
    public const string EnvironmentVariable = "FISSION_ENGINE_PATHS";

    private const long MaxBytes = 256 * 1024;

    private static readonly string[] AllowedKeys =
        [.. EnginePaths.RequiredKeys, .. EnginePaths.OptionalKeys, .. EnginePaths.HostWriteRootKeys];

    /// <summary>读取 <see cref="EnvironmentVariable"/> 指向的配置；未设置即配置错误。</summary>
    public static EnginePaths LoadConfigured()
    {
        var file = Environment.GetEnvironmentVariable(EnvironmentVariable);
        if (string.IsNullOrWhiteSpace(file))
        {
            throw Invalid($"未注入引擎配置：请设置 {EnvironmentVariable} 指向引擎/资产路径 JSON"
                + $"（必需：{string.Join("/", EnginePaths.RequiredKeys)}/{string.Join("/", EnginePaths.HostWriteRootKeys)}；"
                + $"可选：{string.Join("/", EnginePaths.OptionalKeys)}），不猜测默认路径。");
        }

        return Load(file);
    }

    /// <summary>从显式文件读取引擎路径。</summary>
    /// <param name="file">配置 JSON 的绝对路径。</param>
    public static EnginePaths Load(string file)
    {
        if (string.IsNullOrWhiteSpace(file) || !Path.IsPathFullyQualified(file)) throw Invalid("引擎配置路径必须是绝对路径。");
        try
        {
            if (new FileInfo(file).Length > MaxBytes) throw Invalid("引擎配置文件过大。");
            return Parse(File.ReadAllText(file));
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            // 配置文件内容与底层 I/O 消息不外泄。
            throw Invalid("引擎配置无法读取或格式非法。");
        }
    }

    private static EnginePaths Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw Invalid("引擎配置必须是 JSON 对象。");
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var property in document.RootElement.EnumerateObject())
        {
            if (!AllowedKeys.Contains(property.Name, StringComparer.Ordinal) || property.Value.ValueKind != JsonValueKind.String)
                throw Invalid("引擎配置含未授权键或非字符串值。");
            var value = property.Value.GetString();
            if (string.IsNullOrWhiteSpace(value) || !Path.IsPathFullyQualified(value) || !values.TryAdd(property.Name, value))
                throw Invalid("引擎配置的路径必须是唯一的绝对路径。");
        }

        foreach (var key in EnginePaths.RequiredKeys.Concat(EnginePaths.HostWriteRootKeys))
        {
            if (!values.ContainsKey(key)) throw Invalid($"引擎配置缺少必需键：{key}。");
        }

        return new EnginePaths
        {
            FFmpeg = values["FFmpeg"],
            FFprobe = values["FFprobe"],
            FFmpeg6 = values.GetValueOrDefault("FFmpeg6", string.Empty),
            TransitionsDir = values["TransitionsDir"],
            AssetsRoot = values["AssetsRoot"],
            LocalAssetsRoot = values["LocalAssetsRoot"],
            WorkRoot = values["WorkRoot"],
            OutRoot = values["OutRoot"],
        };
    }

    private static ConfigException Invalid(string message) => new("CFG_ENGINE_PATHS", message);
}
