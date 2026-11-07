using System.Collections.Concurrent;
using System.Threading.Channels;
using Fission.Core.Abstractions;

namespace Fission.Core.Jobs;

/// <summary>进程内事件总线（CLI 控制台 / Web SSE 各自订阅）。</summary>
public sealed class JobEventBus : IJobEventBus, IDisposable
{
    private readonly Channel<JobEvent> _channel = Channel.CreateBounded<JobEvent>(new BoundedChannelOptions(4096)
    {
        SingleReader = false,
        SingleWriter = false,
        FullMode = BoundedChannelFullMode.DropOldest, // 日志事件可丢旧，进度不阻塞引擎
    });

    private readonly List<Action<JobEvent>> _subscribers = [];
    private readonly object _subLock = new();
    private readonly Task _pump;
    private readonly System.Diagnostics.Stopwatch _clock = System.Diagnostics.Stopwatch.StartNew();

    /// <summary>新建总线（内部泵任务分发）。</summary>
    public JobEventBus()
    {
        _pump = Task.Run(async () =>
        {
            await foreach (var evt in _channel.Reader.ReadAllAsync().ConfigureAwait(false))
            {
                lock (_subLock)
                {
                    foreach (var s in _subscribers)
                    {
                        try
                        {
                            s(evt);
                        }
                        catch
                        {
                            // 订阅方异常不阻断总线
                        }
                    }
                }
            }
        });
    }

    /// <inheritdoc/>
    public void Emit(JobEvent evt) => _channel.Writer.TryWrite(evt);

    /// <summary>事件生成单调毫秒。</summary>
    public long NowMs => _clock.ElapsedMilliseconds;

    /// <inheritdoc/>
    public IDisposable Subscribe(Action<JobEvent> handler)
    {
        lock (_subLock)
        {
            _subscribers.Add(handler);
        }

        return new Unsub(this, handler);
    }

    private void Unsubscribe(Action<JobEvent> handler)
    {
        lock (_subLock)
        {
            _subscribers.Remove(handler);
        }
    }

    /// <summary>等待分发完毕（取消场景下的排空）。</summary>
    public Task FlushAsync() => _channel.Reader.Completion.IsCompleted ? Task.CompletedTask : Task.Delay(50);

    /// <inheritdoc/>
    public void Dispose()
    {
        _channel.Writer.TryComplete();
        try
        {
            _pump.Wait(TimeSpan.FromSeconds(2));
        }
        catch (AggregateException)
        {
            // 泵已退出
        }
    }

    private sealed class Unsub(JobEventBus bus, Action<JobEvent> handler) : IDisposable
    {
        public void Dispose() => bus.Unsubscribe(handler);
    }
}

/// <summary>全局单写多读进度字典（Web 轮询兜底）。</summary>
public sealed class JobStatusStore
{
    private readonly ConcurrentDictionary<string, string> _latest = new();

    /// <summary>记录任务最新状态（JSON 字符串）。</summary>
    public void Set(string jobId, string json) => _latest[jobId] = json;

    /// <summary>读取。</summary>
    public string? Get(string jobId) => _latest.TryGetValue(jobId, out var v) ? v : null;
}
