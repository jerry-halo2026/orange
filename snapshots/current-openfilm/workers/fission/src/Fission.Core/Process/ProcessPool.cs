using System.Diagnostics;
using Fission.Core.Errors;

namespace Fission.Core.Process;

/// <summary>子进程运行请求。</summary>
/// <param name="FileName">可执行文件绝对路径。</param>
/// <param name="Arguments">命令行参数（已拼接）。</param>
/// <param name="TotalDurationSec">产物总时长（用于进度解析；null 则不推进度）。</param>
/// <param name="TimeoutSec">超时秒数（超时 kill）。</param>
public sealed record ProcessRequest(
    string FileName,
    string Arguments,
    double? TotalDurationSec = null,
    int TimeoutSec = 3600);

/// <summary>子进程运行结果。</summary>
/// <param name="ExitCode">进程退出码。</param>
/// <param name="Stdout">标准输出（截尾保留 8KB）。</param>
/// <param name="StderrTail">标准错误尾部（保留 16KB，ffmpeg 的日志通道）。</param>
/// <param name="DurationMs">墙钟耗时。</param>
public sealed record ProcessResult(int ExitCode, string Stdout, string StderrTail, long DurationMs);

/// <summary>
/// 子进程统一管理器（PRD §8.3：禁止裸 Process.Start）。
/// 全局并发上限 = max(线程数×2, 6)（PRD §6.1）；支持取消（进程树 kill）与超时。
/// </summary>
public sealed class ProcessPool : IDisposable
{
    private readonly SemaphoreSlim _slots;
    readonly object _sync = new();
    readonly List<System.Diagnostics.Process> _running = [];
    private bool _disposed;

    /// <summary>创建进程池。</summary>
    /// <param name="maxConcurrent">全局进程并发上限（默认 6）。</param>
    public ProcessPool(int maxConcurrent = 6) => _slots = new SemaphoreSlim(Math.Max(1, maxConcurrent), Math.Max(1, maxConcurrent));

    /// <summary>当前运行中的进程数。</summary>
    public int RunningCount { get { lock (_sync) { return _running.Count; } } }

    /// <summary>
    /// 运行一个子进程直至退出。stderr 持续解析 <c>time=HH:MM:SS.xx</c> 推进度（PRD §6.3）。
    /// </summary>
    /// <param name="request">运行请求。</param>
    /// <param name="ct">取消令牌：触发即 kill 进程树并抛 <see cref="OperationCanceledException"/>。</param>
    /// <param name="onProgress">进度回调（0–1）。</param>
    /// <exception cref="EngineException">进程启动失败。</exception>
    public async Task<ProcessResult> RunAsync(ProcessRequest request, Action<double>? onProgress = null, CancellationToken ct = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _slots.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            return await RunCoreAsync(request, onProgress, ct).ConfigureAwait(false);
        }
        finally
        {
            _slots.Release();
        }
    }

    private async Task<ProcessResult> RunCoreAsync(ProcessRequest request, Action<double>? onProgress, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var psi = new ProcessStartInfo
        {
            FileName = request.FileName,
            Arguments = request.Arguments,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
        };

        using var proc = new System.Diagnostics.Process { StartInfo = psi, EnableRaisingEvents = true };
        // stdout 尾巴 256KB：-encoders/-filters 类一次性列表约 20KB，全量保留；stderr 16KB（time= 进度流防撑）
        var stdoutTail = new TailBuffer(256 * 1024);
        var stderrTail = new TailBuffer(16 * 1024);
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        proc.OutputDataReceived += (_, e) => { if (e.Data is not null) { stdoutTail.Append(e.Data); } };
        proc.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is null)
            {
                return;
            }

            stderrTail.Append(e.Data);
            if (onProgress is not null && request.TotalDurationSec is > 0)
            {
                var t = ParseFfmpegTime(e.Data);
                if (t is not null)
                {
                    onProgress(Math.Clamp(t.Value / request.TotalDurationSec.Value, 0, 1));
                }
            }
        };
        proc.Exited += (_, _) => tcs.TrySetResult(true);

        try
        {
            if (!proc.Start())
            {
                throw new EngineException("CFG_ENGINE_NOT_FOUND", $"引擎进程启动失败（Start 返回 false）：{request.FileName}");
            }
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            throw new EngineException("CFG_ENGINE_NOT_FOUND", $"引擎不可执行或不存在：{request.FileName}", false, ex);
        }

        lock (_sync)
        {
            _running.Add(proc);
        }

        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(request.TimeoutSec));
        await using (timeoutCts.Token.Register(() => tcs.TrySetCanceled(timeoutCts.Token), useSynchronizationContext: false).ConfigureAwait(false))
        {
            try
            {
                await tcs.Task.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                await KillTreeAsync(proc).ConfigureAwait(false);
                ct.ThrowIfCancellationRequested();
                throw new EngineException("ENC_TIMEOUT", $"引擎执行超时（>{request.TimeoutSec}s）被终止：{Path.GetFileName(request.FileName)}", retryable: true);
            }
        }

        await proc.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
        lock (_sync)
        {
            _running.Remove(proc);
        }

        return new ProcessResult(proc.ExitCode, stdoutTail.ToString(), stderrTail.ToString(), sw.ElapsedMilliseconds);
    }

    /// <summary>Kill 进程树（Windows: taskkill /T /F），2s 宽限后强制。</summary>
    internal static async Task KillTreeAsync(System.Diagnostics.Process proc)
    {
        try
        {
            if (proc.HasExited)
            {
                return;
            }

            var killPsi = new ProcessStartInfo("taskkill", $"/PID {proc.Id} /T /F")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var killer = System.Diagnostics.Process.Start(killPsi);
            if (killer is not null)
            {
                await killer.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
            }
        }
        catch (InvalidOperationException)
        {
            // 进程已退出，无需处理
        }
    }

    /// <summary>解析 ffmpeg stderr 的 time=HH:MM:SS.xx（PRD §6.3 进度来源）。</summary>
    internal static double? ParseFfmpegTime(string line)
    {
        var idx = line.IndexOf("time=", StringComparison.Ordinal);
        if (idx < 0)
        {
            return null;
        }

        var start = idx + 5;
        var end = start;
        while (end < line.Length && (char.IsDigit(line[end]) || line[end] is ':' or '.' or '-'))
        {
            end++;
        }

        var span = line.AsSpan(start, end - start);
        var parts = span.ToString().Split(':');
        if (parts.Length is < 2 or > 3)
        {
            return null;
        }

        if (!double.TryParse(parts[^1], out var sec) ||
            !double.TryParse(parts[^2], out var min))
        {
            return null;
        }

        var hrs = parts.Length == 3 && double.TryParse(parts[0], out var h) ? h : 0;
        var total = hrs * 3600 + min * 60 + sec;
        return total < 0 ? null : total;
    }

    /// <summary>定长尾部缓冲（防大日志撑内存）。</summary>
    private sealed class TailBuffer(int capacity)
    {
        private readonly Queue<string> _lines = new();
        private int _size;

        internal void Append(string line)
        {
            var len = line.Length + 1;
            _lines.Enqueue(line);
            _size += len;
            while (_size > capacity && _lines.Count > 1)
            {
                _size -= _lines.Dequeue().Length + 1;
            }
        }

        public override string ToString() => string.Join(Environment.NewLine, _lines);
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        lock (_sync)
        {
            foreach (var p in _running)
            {
                _ = KillTreeAsync(p);
            }

            _running.Clear();
        }

        _slots.Dispose();
    }
}
