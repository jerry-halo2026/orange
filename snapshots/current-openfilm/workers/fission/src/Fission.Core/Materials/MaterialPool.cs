using System.Collections.Concurrent;
using System.Text;
using Fission.Core.Errors;
using Fission.Core.Jobs;

namespace Fission.Core.Materials;

/// <summary>素材状态（ADR-002 四态机）。</summary>
public enum MaterialState
{
    Available,
    Reserved,
    Consumed,
}

/// <summary>池内素材条目。</summary>
/// <param name="Path">绝对路径。</param>
/// <param name="Group">场景组名（视频池；音频为空串）。</param>
/// <param name="DurationSec">时长（probe 结果；图片=0，转视频时才定时长）。</param>
/// <param name="IsImage">图片素材（场景组文件夹内；IMG2VID 阶段转视频后参与选取）。</param>
public sealed record MaterialItem(string Path, string Group, double DurationSec, bool IsImage = false);

/// <summary>一次成片的预留凭证。</summary>
/// <param name="BatchId">预留批次号。</param>
/// <param name="Audio">预留的配音（可空=离线合成配音不入池）。</param>
/// <param name="Videos">预留的视频素材。</param>
public sealed record Reservation(Guid BatchId, MaterialItem? Audio, IReadOnlyList<MaterialItem> Videos);

/// <summary>消耗流水行（report.json）。</summary>
public sealed record ConsumeLog(string Output, string? Audio, int AudioUseIndex, IReadOnlyList<string> Videos, DateTime ReservedAt, DateTime? ConfirmedAt, DateTime? ReleasedAt);

/// <summary>
/// 素材池消耗事务（ADR-002）：预留→确认→回滚；配音按 usePolicy 计次；组合去重（配音+画面组合）。
/// 唯一权威状态在内存；磁盘态（缓存 ini + 流水）仅在确认时原子落盘。
/// </summary>
public sealed class MaterialPool : IDisposable
{
    private readonly object _sync = new();
    private readonly Dictionary<string, PoolEntry> _items = [];
    private readonly Dictionary<Guid, Reservation> _open = [];
    private readonly ConcurrentDictionary<string, ConsumeLog> _log = new();
    private readonly List<string> _combinationSeen = [];
    private readonly List<string> _externalConsumed = []; // 缓存 ini 中不属于本池的已消耗路径（回写时保留，防跨批次历史被抹）
    private readonly string _cacheIni;
    private bool _disposed;


    private sealed class PoolEntry(MaterialItem item)
    {
        public MaterialItem Item { get; } = item;

        public MaterialState State { get; set; } = MaterialState.Available;

        public int UsesRemaining { get; set; }

        public int ReservedCount { get; set; }
    }

    /// <summary>创建池。cacheIni=跨批次缓存文件（原版 多场景素材缓存.ini 同义，读入排除已消耗）。</summary>
    public MaterialPool(IEnumerable<MaterialItem> items, string? cacheIni = null)
    {
        foreach (var it in items)
        {
            _items[it.Path] = new PoolEntry(it);
        }

        _cacheIni = cacheIni ?? string.Empty;
        LoadCache();
    }

    /// <summary>可用配音数（计剩余使用次数）。</summary>
    public int AudioAvailable => AvailableCount(a: true);

    /// <summary>可用视频数。</summary>
    public int VideoAvailable => AvailableCount(a: false);

    private int AvailableCount(bool a) { lock (_sync) { return _items.Values.Count(e => (e.Item.Group.Length == 0) == a && e.State == MaterialState.Available); } }

    /// <summary>开放预留数（并发监控）。</summary>
    public int OpenReservations { get { lock (_sync) { return _open.Count; } } }

    /// <summary>素材清单（a=true 配音 / false 视频）。</summary>
    public IReadOnlyList<MaterialItem> List(bool a)
    {
        lock (_sync)
        {
            return _items.Values.Where(e => (e.Item.Group.Length == 0) == a).Select(e => e.Item).ToList();
        }
    }

    /// <summary>是否仍可选取（未消耗；配音还剩次数）。</summary>
    public bool CheckAvailable(string path)
    {
        lock (_sync)
        {
            if (!_items.TryGetValue(path, out var e))
            {
                return false;
            }

            if (e.Item.Group.Length == 0)
            {
                return e.State != MaterialState.Consumed && (e.UsesRemaining == 0 || e.ReservedCount < e.UsesRemaining);
            }

            return e.State == MaterialState.Available;
        }
    }

    /// <summary>是否仍可选取（可复用集合内恒真：重复抽取=是 的组，已用/占用素材仍可再抽）。</summary>
    public bool CheckAvailable(string path, IReadOnlySet<string>? reusable)
        => reusable is not null && reusable.Contains(path) || CheckAvailable(path);

    /// <summary>流水快照。</summary>
    public IReadOnlyList<ConsumeLog> Log => _log.Values.ToList();

    /// <summary>
    /// 原子预留：一条配音 + 一组视频。任一不可用即抛 <see cref="MaterialException"/>（不部分预留）。
    /// 组合去重：同配音+同画面组合不允许二次预留（防整条重复，ADR-007）。
    /// </summary>
    /// <param name="audio">配音（null=离线合成，不入池）。</param>
    /// <param name="videos">视频素材集。</param>
    /// <param name="audioUses">配音可用次数（池构造后单条覆盖）。</param>
    /// <param name="reusableVideos">重复抽取=是 的素材（跳过占用/已用检查；允许一条预留内重复出现）。</param>
    public Reservation Reserve(MaterialItem? audio, IReadOnlyList<MaterialItem> videos, int audioUses = 1, IReadOnlySet<string>? reusableVideos = null)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        lock (_sync)
        {
            var comboKey = (audio?.Path ?? "gen") + "|" + string.Join("|", videos.Select(v => v.Path).Order());
            if (_combinationSeen.Contains(comboKey))
            {
                throw new MaterialException("MAT_COMBINATION_DUP", "配音+画面组合已产出过（组合去重），请更换组合或素材");
            }

            PoolEntry? audioEntry = null;
            if (audio is not null)
            {
                audioEntry = GetEntry(audio.Path);
                if (audioEntry.State == MaterialState.Consumed)
                {
                    throw new MaterialException("MAT_AUDIO_EXHAUSTED", ErrorMessageSource.Get("MAT_AUDIO_EXHAUSTED"));
                }

                if (audioEntry.UsesRemaining > 0 && audioEntry.ReservedCount >= audioEntry.UsesRemaining)
                {
                    throw new MaterialException("MAT_AUDIO_EXHAUSTED", ErrorMessageSource.Get("MAT_AUDIO_EXHAUSTED"));
                }
            }

            var videoEntries = new List<PoolEntry>(videos.Count);
            foreach (var v in videos)
            {
                var e = GetEntry(v.Path);
                var reusable = reusableVideos is not null && reusableVideos.Contains(v.Path);
                if (!reusable && e.State != MaterialState.Available)
                {
                    throw new MaterialException("MAT_VIDEO_NOT_ENOUGH", ErrorMessageSource.Get("MAT_VIDEO_NOT_ENOUGH"));
                }

                videoEntries.Add(e);
            }

            // 全部可得 —— 提交预留
            if (audioEntry is not null)
            {
                audioEntry.ReservedCount++;
                audioEntry.State = MaterialState.Reserved;
            }

            foreach (var e in videoEntries)
            {
                e.ReservedCount++;
                e.State = MaterialState.Reserved;
            }

            var res = new Reservation(Guid.NewGuid(), audio, videos);
            _open[res.BatchId] = res;
            _combinationSeen.Add(comboKey);
            _log[res.BatchId.ToString()] = new ConsumeLog(
                string.Empty, audio?.Path, (audioEntry?.ReservedCount ?? 0) + 0, videos.Select(v => v.Path).ToList(), DateTime.Now, null, null);
            return res;
        }
    }

    /// <summary>确认消耗：配音计次（到 0 转 Consumed）；视频默认耐用品，consumeVideos 内条目转 Consumed（原版「用过是否删除=是」）并落跨批次缓存。</summary>
    /// <param name="res">预留凭证。</param>
    /// <param name="output">成片文件名。</param>
    /// <param name="consumeVideos">需标记已用（删除语义）的视频/图片路径集。</param>
    public void Confirm(Reservation res, string output, IReadOnlyCollection<string>? consumeVideos = null)
    {
        lock (_sync)
        {
            if (!_open.Remove(res.BatchId))
            {
                return; // 已回滚，幂等
            }

            if (res.Audio is not null && _items.TryGetValue(res.Audio.Path, out var a))
            {
                a.ReservedCount--;
                if (a.UsesRemaining > 0 && --a.UsesRemaining == 0)
                {
                    a.State = MaterialState.Consumed;
                }
                else if (a.ReservedCount == 0)
                {
                    a.State = MaterialState.Available;
                }
                else
                {
                    a.State = MaterialState.Reserved;
                }
            }

            foreach (var v in res.Videos)
            {
                if (_items.TryGetValue(v.Path, out var e))
                {
                    e.ReservedCount--;
                    var consume = consumeVideos is not null && consumeVideos.Contains(v.Path);
                    e.State = e.ReservedCount > 0
                        ? MaterialState.Reserved
                        : (consume ? MaterialState.Consumed : MaterialState.Available);
                }
            }

            if (_log.TryGetValue(res.BatchId.ToString(), out var row))
            {
                _log[res.BatchId.ToString()] = row with { Output = output, ConfirmedAt = DateTime.Now };
            }

            SaveCacheLocked();
        }
    }

    /// <summary>回滚预留（失败/取消/崩溃恢复）。</summary>
    public void Release(Reservation res)
    {
        lock (_sync)
        {
            if (!_open.Remove(res.BatchId))
            {
                return;
            }

            if (res.Audio is not null && _items.TryGetValue(res.Audio.Path, out var a))
            {
                a.ReservedCount = Math.Max(0, a.ReservedCount - 1);
                a.State = a.ReservedCount > 0 ? MaterialState.Reserved : (a.UsesRemaining == 0 || a.UsesRemaining > 0 ? MaterialState.Available : MaterialState.Consumed);
            }

            foreach (var v in res.Videos)
            {
                if (_items.TryGetValue(v.Path, out var e))
                {
                    e.ReservedCount = Math.Max(0, e.ReservedCount - 1);
                    e.State = e.ReservedCount > 0 ? MaterialState.Reserved : MaterialState.Available;
                }
            }

            if (_log.TryGetValue(res.BatchId.ToString(), out var row) && row.ConfirmedAt is null)
            {
                _log[res.BatchId.ToString()] = row with { ReleasedAt = DateTime.Now };
            }
        }
    }

    /// <summary>回滚全部残留预留（任务启动时的崩溃恢复，ADR-002）。</summary>
    public void ReleaseAll()
    {
        lock (_sync)
        {
            foreach (var res in _open.Values.ToList())
            {
                Release(res);
            }
        }
    }

    /// <summary>标记配音使用策略（uses：1=用后即删原版语义；0=不限）。</summary>
    public void SetAudioUses(string path, int uses)
    {
        lock (_sync)
        {
            if (_items.TryGetValue(path, out var e))
            {
                e.UsesRemaining = uses;
            }
        }
    }

    private PoolEntry GetEntry(string path)
    {
        if (!_items.TryGetValue(path, out var e))
        {
            throw new MaterialException("MAT_VIDEO_NOT_ENOUGH", $"素材不在池内：{path}");
        }

        return e;
    }

    private void LoadCache()
    {
        if (_cacheIni.Length == 0 || !File.Exists(_cacheIni))
        {
            return;
        }

        foreach (var line in File.ReadAllLines(_cacheIni))
        {
            var p = line.Trim();
            if (p.Length == 0 || p.StartsWith('[') || p.StartsWith(';'))
            {
                continue;
            }

            var eq = p.IndexOf('=');
            var path = eq > 0 ? p[..eq].Trim() : p;
            if (_items.TryGetValue(path, out var e))
            {
                e.State = MaterialState.Consumed;
                e.UsesRemaining = 0;
            }
            else
            {
                // 池外历史（此前批次消耗、本任务素材清单外的路径）——保留回写
                _externalConsumed.Add(path);
            }
        }
    }

    private void SaveCacheLocked()
    {
        if (_cacheIni.Length == 0)
        {
            return;
        }

        var sb = new StringBuilder("; 多场景素材缓存（Fission 生成，与原版同义）\r\n[已用]\r\n");
        foreach (var path in _externalConsumed)
        {
            _ = sb.Append(path).Append('=').Append(DateTime.Now.ToString("yyyy-MM-dd")).Append("\r\n");
        }

        foreach (var e in _items.Values.Where(e => e.State == MaterialState.Consumed))
        {
            _ = sb.Append(e.Item.Path).Append('=').Append(DateTime.Now.ToString("yyyy-MM-dd")).Append("\r\n");
        }

        var tmp = _cacheIni + ".tmp";
        File.WriteAllText(tmp, sb.ToString());
        File.Move(tmp, _cacheIni, overwrite: true); // 原子替换（ADR-002）
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        ReleaseAll();
    }
}
