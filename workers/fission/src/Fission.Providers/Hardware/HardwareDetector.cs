using System.Text.RegularExpressions;
using System.Runtime.Versioning;
using Fission.Core.Engine;
using Fission.Core.Process;

namespace Fission.Providers.Hardware;

/// <summary>硬件能力探测结果（doctor 呈现 + bench 环境指纹组成部分 —— ADR-004）。</summary>
/// <param name="GpuName">显卡名（无则 null）。</param>
/// <param name="DriverVersion">驱动版本。</param>
/// <param name="CudaVersion">CUDA 版本。</param>
/// <param name="VramMiB">显存 MiB。</param>
/// <param name="HasNvencH264">ffmpeg 是否具备 h264_nvenc 编码器。</param>
/// <param name="HasNvencHevc">ffmpeg 是否具备 hevc_nvenc 编码器。</param>
/// <param name="CpuName">CPU 型号。</param>
/// <param name="LogicalCores">逻辑核数。</param>
/// <param name="TotalRamGb">内存 GB。</param>
public sealed record HardwareInfo(
    string? GpuName,
    string? DriverVersion,
    string? CudaVersion,
    long VramMiB,
    bool HasNvencH264,
    bool HasNvencHevc,
    string CpuName,
    int LogicalCores,
    double TotalRamGb);

/// <summary>硬件探测（PRD FR-9.5「检测本机显卡」；nvidia-smi + ffmpeg -encoders）。仅支持 Windows。</summary>
[SupportedOSPlatform("windows7.0")]
public sealed partial class HardwareDetector(EnginePaths paths, ProcessPool pool)
{
    /// <summary>探测全部硬件能力（nvidia-smi 缺失时 GPU 相关字段为默认值，不抛错）。</summary>
    public async Task<HardwareInfo> DetectAsync(CancellationToken ct = default)
    {
        var (gpuName, driver, cuda, vram) = await DetectGpuAsync(ct).ConfigureAwait(false);
        var encoders = await DetectEncodersAsync(ct).ConfigureAwait(false);
        var (cpu, cores) = DetectCpu();
        var ram = DetectRamGb();

        return new HardwareInfo(gpuName, driver, cuda, vram,
            encoders.Contains("h264_nvenc"), encoders.Contains("hevc_nvenc"),
            cpu, cores, ram);
    }

    private async Task<(string? Name, string? Driver, string? Cuda, long Vram)> DetectGpuAsync(CancellationToken ct)
    {
        const string smi = @"C:\Windows\System32\nvidia-smi.exe";
        if (!File.Exists(smi))
        {
            return (null, null, null, 0);
        }

        var r = await pool.RunAsync(new ProcessRequest(smi, "--query-gpu=name,driver_version,vbios_version --format=csv,noheader", TimeoutSec: 15), ct: ct).ConfigureAwait(false);
        if (r.ExitCode != 0)
        {
            return (null, null, null, 0);
        }

        var line = r.Stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (line.Length == 0)
        {
            return (null, null, null, 0);
        }

        var cols = line[0].Split(',').Select(c => c.Trim()).ToArray();
        // CUDA 版本在 nvidia-smi 全量输出的表头（--query 模式不返回），补一次全量调用解析
        var full = await pool.RunAsync(new ProcessRequest(smi, string.Empty, TimeoutSec: 15), ct: ct).ConfigureAwait(false);
        var cudaMatch = NvidiaCudaRegex().Match(full.Stdout);
        var cudaVer = cudaMatch.Success ? cudaMatch.Groups[1].Value : null;
        var vram = await DetectVramAsync(ct).ConfigureAwait(false);
        return (cols[0], cols.Length > 1 ? cols[1] : null, cudaVer, vram);
    }

    private async Task<long> DetectVramAsync(CancellationToken ct)
    {
        const string smi = @"C:\Windows\System32\nvidia-smi.exe";
        var r = await pool.RunAsync(new ProcessRequest(smi, "--query-gpu=memory.total --format=csv,noheader,nounits", TimeoutSec: 15), ct: ct).ConfigureAwait(false);
        return r.ExitCode == 0 && long.TryParse(r.Stdout.Trim(), out var vram) ? vram : 0;
    }

    private async Task<HashSet<string>> DetectEncodersAsync(CancellationToken ct)
    {
        var r = await pool.RunAsync(new ProcessRequest(paths.FFmpeg, "-hide_banner -encoders", TimeoutSec: 30), ct: ct).ConfigureAwait(false);
        var set = new HashSet<string>(StringComparer.Ordinal);
        foreach (var rawLine in r.Stdout.Split('\n'))
        {
            var line = rawLine.Trim();
            // 编码器行形如 "V....D h264_nvenc  NVIDIA NVENC H.264 ..."：6 个标志位 + 空格 + 名称
            var sp = line.IndexOf(' ');
            if (sp is > 0 and < 8)
            {
                var name = line[(sp + 1)..].Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
                if (!string.IsNullOrEmpty(name))
                {
                    set.Add(name);
                }
            }
        }

        return set;
    }

    private static (string Cpu, int Cores) DetectCpu()
    {
        using var searcher = new System.Management.ManagementObjectSearcher("SELECT Name, NumberOfLogicalProcessors FROM Win32_Processor");
        foreach (var mo in searcher.Get().Cast<System.Management.ManagementObject>())
        {
            var name = mo["Name"]?.ToString() ?? "unknown";
            var cores = Convert.ToInt32(mo["NumberOfLogicalProcessors"]);
            return (name, cores);
        }

        return ("unknown", Environment.ProcessorCount);
    }

    private static double DetectRamGb()
    {
        using var searcher = new System.Management.ManagementObjectSearcher("SELECT TotalPhysicalMemory FROM Win32_ComputerSystem");
        foreach (var mo in searcher.Get().Cast<System.Management.ManagementObject>())
        {
            return Math.Round(Convert.ToDouble(mo["TotalPhysicalMemory"]) / 1024 / 1024 / 1024, 1);
        }

        return 0;
    }

    [GeneratedRegex(@"CUDA Version:\s*([\d.]+)")]
    private static partial Regex NvidiaCudaRegex();
}
