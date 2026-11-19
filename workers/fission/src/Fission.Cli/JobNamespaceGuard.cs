// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Fission.Core.Errors;
using Fission.Core.Pipeline;
using Microsoft.Win32.SafeHandles;

namespace Fission.Cli;

/// <summary>
/// 持有一条任务命名空间：任务根与 inputs/worker/records 四个目录内各持一个「不带 DELETE 共享」的锁文件句柄。
/// NTFS 在子树内存在此类句柄时拒绝改名/删除该目录及其祖先，因此父进程的素材复制、结果记录与恢复阶段
/// 都发生在不可被替换的路径上。目录句柄本身实测不阻止改名，因此固定必须靠目录内文件句柄。
/// 调用方必须自己保证 workspaceRoot 可信且已规范化；本类型不判断归属或许可。
/// </summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows7.0")]
public sealed class JobNamespaceGuard : IDisposable
{
    /// <summary>与既有 WorkspaceNamespaceLease 相同的哨兵文件名。</summary>
    public const string LockName = ".fission-namespace.lock";

    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly List<(string Dir, string Lock, FileStream Stream, string DirVolume, string DirIndex)> held = [];
    private readonly object gate = new();
    private bool disposed;

    private JobNamespaceGuard(string root, string jobId, string jobRoot)
    {
        Root = root;
        JobId = jobId;
        JobRoot = jobRoot;
        Inputs = System.IO.Path.Combine(jobRoot, "inputs");
        Worker = System.IO.Path.Combine(jobRoot, "worker");
        Records = System.IO.Path.Combine(jobRoot, "records");
    }

    public string Root { get; }

    public string JobId { get; }

    public string JobRoot { get; }

    public string Inputs { get; }

    public string Worker { get; }

    public string Records { get; }

    /// <summary>交给父进程的确认内容：每级目录路径 + 锁文件路径 + 锁文件身份（volume 与 file index 十进制）。</summary>
    public string Receipt()
    {
        var entries = held
            .Select(entry => Identified(entry.Dir, entry.Lock, SafeIdentity(entry.Stream), entry.DirVolume, entry.DirIndex))
            .ToArray();
        return JsonSerializer.Serialize(new ReceiptDocument(1, JobId, Root, entries), Json);
    }

    /// <summary>建立并固定任务命名空间；已存在且非空的同名任务目录一律拒绝。</summary>
    public static JobNamespaceGuard Acquire(string workspaceRoot, string jobId, string? intentJson = null, IReadOnlyList<string>? roles = null, string? task = null, string? attempt = null, bool takeover = false)
    {
        if (!OperatingSystem.IsWindows()) throw Invalid();
        if (!TryCanonicalRoot(workspaceRoot, out var root)) throw Invalid();
        if (!ValidJobId(jobId)) throw Invalid();
        var jobRoot = System.IO.Path.Combine(root, jobId);
        // 任何已存在的任务目录都不接管：预置的空目录/ junction 都可以把后续写入引到别处。
        if (Directory.Exists(jobRoot) || File.Exists(jobRoot))
        {
            if (!takeover) throw Invalid();
            ReclaimFromCrashedRun(jobRoot, intentJson, roles, task, attempt);
        }

        var guard = new JobNamespaceGuard(root, jobId, jobRoot);
        try
        {
            var pinned = new List<string> { jobRoot, guard.Inputs, guard.Worker, guard.Records };
            foreach (var role in roles ?? []) pinned.Add(System.IO.Path.Combine(guard.Inputs, role));
            if (task is not null) pinned.Add(System.IO.Path.Combine(guard.Worker, task));
            if (task is not null && attempt is not null) pinned.Add(System.IO.Path.Combine(guard.Worker, task, attempt));
            foreach (var directory in pinned)
            {
                if (!Directory.Exists(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                guard.Hold(directory);
            }

            if (intentJson is not null)
            {
                var intent = System.IO.Path.Combine(jobRoot, "intent.json");
                if (File.Exists(intent)) throw Invalid();
                using var stream = new FileStream(intent, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                var bytes = new UTF8Encoding(false).GetBytes(intentJson);
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }

            return guard;
        }
        catch
        {
            guard.Dispose();
            throw;
        }
    }

    /// <summary>在目录内建立并持有不带 DELETE 共享的锁文件句柄，并核对句柄指向的确实是该目录内的锁文件。</summary>
    /// <summary>
    /// 只接管“上一轮已死”的同名任务：意图必须完全一致，且每个锁文件都能被独占打开（证明没有存活的持有者）。
    /// 任何一项不满足都拒绝，宁可不可用也不误接管。
    /// </summary>
    private static void ReclaimFromCrashedRun(string jobRoot, string? intentJson, IReadOnlyList<string>? roles, string? task, string? attempt)
    {
        if (intentJson is null) throw Invalid();
        var recorded = System.IO.Path.Combine(jobRoot, "intent.json");
        if (!File.Exists(recorded)) throw Invalid();
        if (!SameIdentity(File.ReadAllText(recorded), intentJson)) throw Invalid();

        var locks = new List<string> { System.IO.Path.Combine(jobRoot, LockName) };
        foreach (var child in new[] { "inputs", "worker", "records" }) locks.Add(System.IO.Path.Combine(jobRoot, child, LockName));
        foreach (var role in roles ?? []) locks.Add(System.IO.Path.Combine(jobRoot, "inputs", role, LockName));
        if (task is not null) locks.Add(System.IO.Path.Combine(jobRoot, "worker", task, LockName));
        if (task is not null && attempt is not null) locks.Add(System.IO.Path.Combine(jobRoot, "worker", task, attempt, LockName));

        foreach (var lockPath in locks)
        {
            if (!File.Exists(lockPath)) continue;
            try
            {
                using var exclusive = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            }
            catch (IOException) { throw Invalid(); }
            catch (UnauthorizedAccessException) { throw Invalid(); }
        }

        foreach (var lockPath in locks)
        {
            try
            {
                if (!File.Exists(lockPath)) continue;
                var attributes = File.GetAttributes(lockPath);
                if ((attributes & FileAttributes.ReadOnly) != 0) File.SetAttributes(lockPath, attributes & ~FileAttributes.ReadOnly);
                File.Delete(lockPath);
            }
            catch (IOException) { throw Invalid(); }
            catch (UnauthorizedAccessException) { throw Invalid(); }
        }
        // 上一轮留下的 intent.json 也是“我们的”，删掉以便重新写入
        try { if (File.Exists(recorded)) File.Delete(recorded); }
        catch (IOException) { throw Invalid(); }
        catch (UnauthorizedAccessException) { throw Invalid(); }
    }

    /// <summary>比较两份意图里的归属与请求标识；不看时间戳等易变字段。</summary>
    private static bool SameIdentity(string recorded, string incoming)
    {
        try
        {
            using var left = System.Text.Json.JsonDocument.Parse(recorded);
            using var right = System.Text.Json.JsonDocument.Parse(incoming);
            foreach (var name in new[] { "ownerKey", "requestId" })
            {
                var a = left.RootElement.TryGetProperty(name, out var av) ? av.ToString() : string.Empty;
                var b = right.RootElement.TryGetProperty(name, out var bv) ? bv.ToString() : string.Empty;
                if (!string.Equals(a, b, StringComparison.Ordinal)) return false;
            }

            return true;
        }
        catch (System.Text.Json.JsonException) { return false; }
    }

    /// <summary>运行期新建的可写根系（引擎 work/out/cache）在创建后立即补固定；已固定则忽略。</summary>
    public void PinCreatedRoot(string directory)
    {
        if (!System.IO.Path.IsPathFullyQualified(directory)) throw Invalid();
        if (!string.Equals(System.IO.Path.GetFullPath(directory), directory, StringComparison.OrdinalIgnoreCase)) throw Invalid();
        lock (gate)
        {
            if (disposed) throw Invalid();
            if (held.Any(entry => string.Equals(entry.Dir, directory, StringComparison.OrdinalIgnoreCase))) return;
            Hold(directory);
        }
    }

    private void Hold(string directory)
    {
        var path = System.IO.Path.Combine(directory, LockName);
        FileStream stream;
        try
        {
            stream = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read | FileShare.Write);
        }
        catch (IOException) { throw Invalid(); }

        try
        {
            if (!string.Equals(stream.Name, path, StringComparison.OrdinalIgnoreCase)) throw Invalid();
            RequireHandlePath(stream.SafeFileHandle, path);
            _ = PreparedFileIdentity.Read(stream.SafeFileHandle);
            // 句柄级校验：锁文件真实父目录必须等于期望目录（防“先建后被指向别处”）
            if (!string.Equals(System.IO.Path.GetDirectoryName(path)!, directory, StringComparison.OrdinalIgnoreCase)) throw Invalid();
            var (dirVolume, dirIndex) = DirectoryIdentity(directory);
            held.Add((directory, path, stream, dirVolume, dirIndex));
        }
        catch
        {
            stream.Dispose();
            throw;
        }
    }

    /// <summary>用句柄自身解析出的最终路径核对，而不是相信传入的字符串。</summary>
    private static void RequireHandlePath(SafeFileHandle handle, string expected)
    {
        var buffer = new char[32768];
        var size = GetFinalPathNameByHandle(handle, buffer, buffer.Length, 0);
        if (size == 0 || size >= buffer.Length) throw Invalid();
        var final = new string(buffer, 0, checked((int)size));
        if (!final.StartsWith(@"\\?\", StringComparison.Ordinal)) throw Invalid();
        if (!string.Equals(final[4..], expected, StringComparison.OrdinalIgnoreCase)) throw Invalid();
    }

    /// <summary>释放所有句柄并尽力清除自己建立的锁文件；目录与 intent.json 保留给恢复流程核对。</summary>
    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        // 先记下每个锁的身份，再释放句柄；清理时只删“还是同一个文件”的锁，并在删除前清掉只读属性。
        var fingerprints = held.Select(entry => (entry.Lock, Identity: TryIdentity(entry.Stream))).Where(x => x.Identity is not null).Select(x => (x.Lock, Identity: x.Identity!)).ToArray();
        foreach (var entry in held) entry.Stream.Dispose();
        held.Clear();
        foreach (var (lockPath, identity) in fingerprints)
        {
            try
            {
                if (!File.Exists(lockPath)) continue;
                using (var probe = new FileStream(lockPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    if (!string.Equals(PreparedFileIdentity.Read(probe.SafeFileHandle), identity, StringComparison.Ordinal)) continue;
                var attributes = File.GetAttributes(lockPath);
                if ((attributes & FileAttributes.ReadOnly) != 0) File.SetAttributes(lockPath, attributes & ~FileAttributes.ReadOnly);
                File.Delete(lockPath);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    /// <summary>身份读取失败（硬链接、被替换等）一律收敛为受控配置错误，不抛出未处理异常。</summary>
    private static string SafeIdentity(FileStream stream)
    {
        try { return PreparedFileIdentity.Read(stream.SafeFileHandle); }
        catch (IOException) { throw Invalid(); }
    }

    /// <summary>Dispose 用：身份读不到就放弃这条，不阻断其余清理。</summary>
    private static string? TryIdentity(FileStream stream)
    {
        try { return PreparedFileIdentity.Read(stream.SafeFileHandle); }
        catch (IOException) { return null; }
    }

    private static ReceiptEntry Identified(string directory, string lockPath, string identity, string dirVolume, string dirIndex)
    {
        var parts = identity.Split(':');
        var volume = Convert.ToUInt32(parts[0], 16);
        var index = Convert.ToUInt64(parts[1], 16);
        return new ReceiptEntry(
            directory,
            lockPath,
            volume.ToString(System.Globalization.CultureInfo.InvariantCulture),
            index.ToString(System.Globalization.CultureInfo.InvariantCulture),
            identity,
            dirVolume,
            dirIndex);
    }


    /// <summary>读取目录对象自身的 volume/file-index 十进制表示（用于父进程逐写比对）。</summary>
    private static (string Volume, string Index) DirectoryIdentity(string directory)
    {
        using var handle = CreateFile(directory, 0x80, 0x1 | 0x2, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
        if (handle.IsInvalid) throw Invalid();
        var parts = PreparedFileIdentity.Read(handle).Split(':');
        return (Convert.ToUInt32(parts[0], 16).ToString(System.Globalization.CultureInfo.InvariantCulture),
                Convert.ToUInt64(parts[1], 16).ToString(System.Globalization.CultureInfo.InvariantCulture));
    }
    private static bool ValidJobId(string jobId)
        => jobId.Length == 36
            && jobId.All(c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f') or '-')
            && jobId[8] == '-' && jobId[13] == '-' && jobId[18] == '-' && jobId[23] == '-';

    /// <summary>目录必须完全限定、与自身规范化形式一致，且到盘根为止没有重解析点。</summary>
    private static bool TryCanonicalRoot(string workspaceRoot, out string root)
    {
        root = string.Empty;
        if (string.IsNullOrEmpty(workspaceRoot)) return false;
        try
        {
            if (!System.IO.Path.IsPathFullyQualified(workspaceRoot)) return false;
            var full = System.IO.Path.GetFullPath(workspaceRoot);
            if (!string.Equals(full, workspaceRoot, StringComparison.OrdinalIgnoreCase)) return false;
            if (full.Length > 3 && (full.EndsWith(System.IO.Path.DirectorySeparatorChar) || full.EndsWith(System.IO.Path.AltDirectorySeparatorChar))) return false;
            if (!Directory.Exists(full)) return false;
            for (var at = full; ; at = System.IO.Path.GetDirectoryName(at)!)
            {
                if ((File.GetAttributes(at) & FileAttributes.ReparsePoint) != 0) return false;
                if (string.Equals(at, System.IO.Path.GetPathRoot(at), StringComparison.OrdinalIgnoreCase)) break;
            }

            root = full;
            return true;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return false;
        }
    }

    private static ConfigException Invalid() => new("CFG_NAMESPACE", "混剪任务工作目录无法安全固定。");

    private sealed record ReceiptDocument(int Version, string JobId, string Root, ReceiptEntry[] Entries);

    private sealed record ReceiptEntry(string Path, string Lock, string Volume, string Index, string Identity, string DirVolume, string DirIndex);
    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, [Out] char[] path, int size, uint flags);

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
}
