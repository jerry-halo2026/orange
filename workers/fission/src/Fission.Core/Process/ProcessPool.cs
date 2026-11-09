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
    private readonly HashSet<Task> _calls = [];
    private readonly Dictionary<System.Diagnostics.Process, Task> _retirements = [];
    private readonly Func<System.Diagnostics.Process, Task> _terminate;
    readonly object _sync = new();
    readonly List<System.Diagnostics.Process> _running = [];
    private bool _disposed;

    /// <summary>创建进程池。</summary>
    /// <param name="maxConcurrent">全局进程并发上限（默认 6）。</param>
    public ProcessPool(int maxConcurrent = 6, Func<System.Diagnostics.Process, Task>? terminate = null)
    {
        _slots = new SemaphoreSlim(Math.Max(1, maxConcurrent), Math.Max(1, maxConcurrent));
        _terminate = terminate ?? KillTreeAsync;
    }

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
        var finished = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_sync) { ObjectDisposedException.ThrowIf(_disposed, this); _calls.Add(finished.Task); }
        var acquired = false;
        try
        {
            await _slots.WaitAsync(ct).ConfigureAwait(false); acquired = true;
            return await RunCoreAsync(request, onProgress, ct).ConfigureAwait(false);
        }
        finally
        {
            if (acquired) _slots.Release();
            lock (_sync) _calls.Remove(finished.Task);
            finished.TrySetResult(true);
        }
    }

    private async Task<ProcessResult> RunCoreAsync(ProcessRequest request, Action<double>? onProgress, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var psi = new ProcessStartInfo { FileName = request.FileName, Arguments = request.Arguments, UseShellExecute = false,
            CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8, StandardErrorEncoding = System.Text.Encoding.UTF8 };
        var proc = new System.Diagnostics.Process { StartInfo = psi, EnableRaisingEvents = true };
        var stdoutTail = new TailBuffer(256 * 1024); var stderrTail = new TailBuffer(16 * 1024);
        var stopped = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var exited = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var stdoutClosed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var stderrClosed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        Exception? callbackFailure = null;
        proc.OutputDataReceived += (_, e) => { if (e.Data is null) stdoutClosed.TrySetResult(true); else stdoutTail.Append(e.Data); };
        proc.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is null) { stderrClosed.TrySetResult(true); return; }
            stderrTail.Append(e.Data);
            if (onProgress is not null && request.TotalDurationSec is > 0)
            {
                var t = ParseFfmpegTime(e.Data);
                if (t is not null) try { onProgress(Math.Clamp(t.Value / request.TotalDurationSec.Value, 0, 1)); }
                    catch (Exception error) { Interlocked.CompareExchange(ref callbackFailure, error, null); stopped.TrySetException(error); }
            }
        };
        proc.Exited += (_, _) => { exited.TrySetResult(true); stopped.TrySetResult(true); };
        var retired = Task.WhenAll(exited.Task, stdoutClosed.Task, stderrClosed.Task);
        try
        {
            lock (_sync)
            {
                ObjectDisposedException.ThrowIf(_disposed, this); ct.ThrowIfCancellationRequested();
                if (!proc.Start()) throw new EngineException("CFG_ENGINE_NOT_FOUND", "Engine process did not start.");
                _running.Add(proc); _retirements.Add(proc, retired);
            }
        }
        catch (System.ComponentModel.Win32Exception error) { proc.Dispose(); throw new EngineException("CFG_ENGINE_NOT_FOUND", "Engine cannot be started.", false, error); }
        catch { proc.Dispose(); throw; }
        proc.BeginOutputReadLine(); proc.BeginErrorReadLine();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(request.TimeoutSec));
        Exception? interruption = null, terminationFailure = null;
        using (timeout.Token.Register(() => stopped.TrySetCanceled(timeout.Token), useSynchronizationContext: false))
        {
            try { await stopped.Task.ConfigureAwait(false); }
            catch (Exception error) { interruption = error; }
        }
        if (interruption is not null)
            try { await _terminate(proc).ConfigureAwait(false); } catch (Exception error) { terminationFailure = error; }
        // A successful kill helper is ONLY a request. Keep the actual process and
        // both redirected readers owned until their actual exit/EOF events.
        await retired.ConfigureAwait(false);
        var code = proc.ExitCode;
        lock (_sync) { _running.Remove(proc); _retirements.Remove(proc); }
        proc.Dispose();
        if (terminationFailure is not null) throw new EngineException("ENC_RETIREMENT_FAILED", "Owned engine retirement encountered a termination failure.", false, terminationFailure);
        if (callbackFailure is not null) throw new EngineException("ENC_PROGRESS_FAILED", "Engine progress callback failed after owned retirement.", false, callbackFailure);
        if (interruption is OperationCanceledException)
        {
            ct.ThrowIfCancellationRequested();
            throw new EngineException("ENC_TIMEOUT", "Engine timed out after actual owned retirement.", retryable: true);
        }
        return new ProcessResult(code, stdoutTail.ToString(), stderrTail.ToString(), sw.ElapsedMilliseconds);
    }

    /// <summary>Request termination of exactly the owned tree; caller separately awaits actual exit and stream EOF.</summary>
    internal static async Task KillTreeAsync(System.Diagnostics.Process proc)
    {
        try
        {
            if (proc.HasExited) return;
            if (!OperatingSystem.IsWindows()) { proc.Kill(entireProcessTree: true); return; }
            var psi = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe"), $"/PID {proc.Id} /T /F")
                { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            using var killer = System.Diagnostics.Process.Start(psi) ?? throw new EngineException("ENC_RETIREMENT_FAILED", "Owned tree termination did not start.");
            var output = killer.StandardOutput.ReadToEndAsync(); var error = killer.StandardError.ReadToEndAsync();
            await killer.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
            await Task.WhenAll(output, error).ConfigureAwait(false);
            if (killer.ExitCode != 0 && !proc.HasExited) throw new EngineException("ENC_RETIREMENT_FAILED", "Owned tree termination was refused.");
        }
        catch (InvalidOperationException) { /* an already-retired/disposed owned handle */ }
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
        KeyValuePair<System.Diagnostics.Process, Task>[] owned; Task[] calls;
        lock (_sync)
        {
            if (_disposed) return;
            _disposed = true; owned = _retirements.ToArray(); calls = _calls.ToArray();
        }
        var failures = new List<Exception>();
        foreach (var entry in owned)
        {
            if (!entry.Value.IsCompleted)
                try { _terminate(entry.Key).GetAwaiter().GetResult(); } catch (Exception error) { if (!entry.Value.IsCompleted) failures.Add(error); }
            entry.Value.GetAwaiter().GetResult();
        }
        Task.WhenAll(calls).GetAwaiter().GetResult();
        _slots.Dispose();
        // Do not clear _running: only the actual owner removes it after exit+EOF.
        if (failures.Count > 0) throw new AggregateException("Owned engine retirement failed.", failures);
    }

}
