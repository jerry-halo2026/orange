// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using Fission.Cli;
using Fission.Core.Errors;

namespace Fission.UnitTests;

/// <summary>
/// 任务命名空间的受控测试。锁文件句柄决定「哪些目录不可被改名」：
/// 裸 WorkspaceNamespaceLease 只固定锁文件所在子树，任务命名空间必须由 JobNamespaceGuard 固定。
/// 全部用例要求 FISSION_PATH_POLICY_TEST_ROOT 指向隔离根（未注入时 TestEnvironment 在规范临时目录下自建），不触碰用户目录。
/// </summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows7.0")]
public sealed class JobNamespaceGuardTests
{
    [Fact]
    public void BareWorkspaceLease_LeavesSiblingDirectoriesReplaceable()
    {
        // 特征化事实（不是通过标准）：锁文件在 worker 内时，worker 与 job 被固定，
        // 但同级的 inputs/ 与 records/ 仍可改名 —— 因此产品必须使用 JobNamespaceGuard。
        if (!OperatingSystem.IsWindowsVersionAtLeast(7)) return;
        var job = FreshDirectory("defect");
        var work = Path.Combine(job, "worker");
        var inputs = Path.Combine(job, "inputs");
        var records = Path.Combine(job, "records");
        Directory.CreateDirectory(work);
        Directory.CreateDirectory(inputs);
        Directory.CreateDirectory(records);
        File.WriteAllText(Path.Combine(work, JobNamespaceGuard.LockName), string.Empty);
        using (WorkspaceNamespaceLease.Acquire(work))
        {
            Directory.Move(records, records + "-moved");
            Directory.Move(inputs, inputs + "-moved");
            Assert.True(Directory.Exists(records + "-moved"));
            Assert.True(Directory.Exists(inputs + "-moved"));
            Assert.True(Record.Exception(() => Directory.Move(job, job + "-moved")) is IOException or UnauthorizedAccessException);
            Assert.True(Directory.Exists(job));
        }
    }

    [Fact]
    public void Guard_BlocksReplacementOfJobAndEveryChildDirectory()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7)) return;
        var root = FreshDirectory("guard");
        using var guard = JobNamespaceGuard.Acquire(root, NewJobId());
        foreach (var directory in new[] { guard.JobRoot, guard.Inputs, guard.Worker, guard.Records })
        {
            var moved = directory + "-moved";
            var failure = Record.Exception(() => Directory.Move(directory, moved));
            Assert.True(failure is IOException or UnauthorizedAccessException, $"{Path.GetFileName(directory)} 未被固定");
            Assert.True(Directory.Exists(directory));
            Assert.False(Directory.Exists(moved));
        }

        Assert.True(Record.Exception(() => Directory.Move(root, root + "-moved")) is IOException or UnauthorizedAccessException);
        Assert.True(Directory.Exists(root));
    }

    [Fact]
    public void Guard_HoldsOneLockPerDirectory_AndLeavesMediaDirectoriesOtherwiseEmpty()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7)) return;
        var root = FreshDirectory("guard-files");
        var jobId = NewJobId();
        using (var guard = JobNamespaceGuard.Acquire(root, jobId, "{\"version\":2}"))
        {
            Assert.Equal("{\"version\":2}", File.ReadAllText(Path.Combine(guard.JobRoot, "intent.json")));
            foreach (var directory in new[] { guard.JobRoot, guard.Inputs, guard.Worker, guard.Records })
            {
                var entries = Directory.EnumerateFileSystemEntries(directory).ToArray();
                Assert.Contains(entries, entry => entry.EndsWith(JobNamespaceGuard.LockName, StringComparison.OrdinalIgnoreCase));
            }

            // 素材目录除锁文件外不得有其它条目
            foreach (var directory in new[] { guard.Inputs, guard.Worker, guard.Records })
                Assert.Single(Directory.EnumerateFileSystemEntries(directory));
        }

        // 已持有期间第二次获取必须拒绝
        var other = NewJobId();
        using (JobNamespaceGuard.Acquire(root, other))
            Assert.ThrowsAny<ConfigException>(() => JobNamespaceGuard.Acquire(root, other));

        // 已跑过任务（保留 intent.json 供恢复核对）的任务目录不得被当作新命名空间复用
        Assert.ThrowsAny<ConfigException>(() => JobNamespaceGuard.Acquire(root, jobId));

        // 有他人内容的任务目录不得被接管
        var foreign = Path.Combine(root, NewJobId());
        Directory.CreateDirectory(foreign);
        File.WriteAllText(Path.Combine(foreign, "someone-else.json"), "{}");
        Assert.ThrowsAny<ConfigException>(() => JobNamespaceGuard.Acquire(root, Path.GetFileName(foreign)));
    }

    [Fact]
    public void Guard_RefusesAncestorJunction_WithoutCreatingAnythingOutside()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7)) return;
        var baseRoot = FreshDirectory("junction");
        var outside = Path.Combine(baseRoot, "outside");
        Directory.CreateDirectory(outside);
        var link = Path.Combine(baseRoot, "linkroot");
        var start = new System.Diagnostics.ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true };
        foreach (var argument in new[] { "/c", "mklink", "/J", link, outside }) start.ArgumentList.Add(argument);
        using (var process = System.Diagnostics.Process.Start(start)!)
        {
            Assert.True(process.WaitForExit(10000));
            Assert.Equal(0, process.ExitCode);
        }

        Assert.ThrowsAny<ConfigException>(() => JobNamespaceGuard.Acquire(link, NewJobId()));
        Assert.Empty(Directory.EnumerateFileSystemEntries(outside));
    }

    [Fact]
    public void Guard_ReleasesOnDispose_AndRefusesAStaleClaim()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7)) return;
        var root = FreshDirectory("guard-release");
        var jobId = NewJobId();
        var guard = JobNamespaceGuard.Acquire(root, jobId);
        var jobRoot = guard.JobRoot;
        guard.Dispose();
        Assert.False(File.Exists(Path.Combine(jobRoot, JobNamespaceGuard.LockName)));

        Directory.Move(jobRoot, jobRoot + "-moved");
        Assert.True(Directory.Exists(jobRoot + "-moved"));

        using var again = JobNamespaceGuard.Acquire(root, NewJobId());
        Assert.True(Directory.Exists(root));
    }

    [Fact]
    public void Guard_RejectsNonCanonicalRootAndMalformedJobId()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7)) return;
        var root = FreshDirectory("guard-root");
        var jobId = NewJobId();
        Assert.ThrowsAny<ConfigException>(() => JobNamespaceGuard.Acquire(root + Path.DirectorySeparatorChar, jobId));
        // 只有同盘才有稳定的“相对路径”语义；跨盘时 GetRelativePath 会给出绝对路径，断言不适用
        var relative = Path.GetRelativePath(Directory.GetCurrentDirectory(), root);
        if (!Path.IsPathFullyQualified(relative)) Assert.ThrowsAny<ConfigException>(() => JobNamespaceGuard.Acquire(relative, jobId));
        Assert.ThrowsAny<ConfigException>(() => JobNamespaceGuard.Acquire(root, "..\\escape"));
        Assert.ThrowsAny<ConfigException>(() => JobNamespaceGuard.Acquire(root, "../escape"));
        Assert.ThrowsAny<ConfigException>(() => JobNamespaceGuard.Acquire(root, jobId.ToUpperInvariant()));
        Assert.ThrowsAny<ConfigException>(() => JobNamespaceGuard.Acquire(root, jobId[..35]));
        Assert.ThrowsAny<ConfigException>(() => JobNamespaceGuard.Acquire(Path.Combine(root, "missing"), jobId));
    }

    private static string NewJobId() => Guid.NewGuid().ToString();

    private static string FreshDirectory(string prefix)
    {
        var baseRoot = TestEnvironment.Root;
        var root = Path.Combine(baseRoot, prefix + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    [Fact]
    public void Takeover_OnlyForMatchingIntent_AndOnlyWhenNoLockIsHeld()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7)) return;
        var root = FreshDirectory("guard-takeover");
        var jobId = NewJobId();
        var intent = "{\"version\":2,\"ownerKey\":\"owner-a\",\"requestId\":\"req-1\"}";
        var stale = Path.Combine(root, jobId);
        foreach (var child in new[] { string.Empty, "inputs", "worker", "records" })
        {
            var directory = child.Length == 0 ? stale : Path.Combine(stale, child);
            Directory.CreateDirectory(directory);
            File.WriteAllText(Path.Combine(directory, JobNamespaceGuard.LockName), string.Empty);
        }

        File.WriteAllText(Path.Combine(stale, "intent.json"), intent);

        // 1) 未声明接管：拒绝
        Assert.ThrowsAny<ConfigException>(() => JobNamespaceGuard.Acquire(root, jobId, intent));
        // 2) 意图不一致：拒绝
        Assert.ThrowsAny<ConfigException>(() => JobNamespaceGuard.Acquire(root, jobId, "{\"version\":2,\"ownerKey\":\"owner-b\",\"requestId\":\"req-1\"}", null, null, null, true));
        // 3) 锁被另一持有者占用：拒绝
        using (var held = new FileStream(Path.Combine(stale, "worker", JobNamespaceGuard.LockName), FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite))
            Assert.ThrowsAny<ConfigException>(() => JobNamespaceGuard.Acquire(root, jobId, intent, null, null, null, true));
        // 4) 一致且无人持有：接管成功
        using (var guard = JobNamespaceGuard.Acquire(root, jobId, intent, null, null, null, true))
        {
            Assert.Equal(jobId, guard.JobId);
            Assert.True(Record.Exception(() => Directory.Move(stale, stale + "-moved")) is IOException or UnauthorizedAccessException);
        }
    }


    [Fact]
    public void PinCreatedRoot_IsSafeUnderConcurrency()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7)) return;
        var root = FreshDirectory("guard-concurrent");
        using var guard = JobNamespaceGuard.Acquire(root, NewJobId());
        var extra = Path.Combine(guard.Worker, "extra");
        Directory.CreateDirectory(extra);
        var failures = new System.Collections.Concurrent.ConcurrentBag<Exception>();
        Parallel.For(0, 320, _ =>
        {
            try { guard.PinCreatedRoot(extra); }
            catch (Exception error) { failures.Add(error); }
        });
        Assert.Empty(failures);
        Assert.True(File.Exists(Path.Combine(extra, JobNamespaceGuard.LockName)));
    }

    [Fact]
    public void ReceiptAndDispose_StayControlled_WhenTheLockIsHardLinked()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7)) return;
        var root = FreshDirectory("guard-hardlink");
        var guard = JobNamespaceGuard.Acquire(root, NewJobId());
        var lockPath = Path.Combine(guard.Worker, JobNamespaceGuard.LockName);
        var linked = Path.Combine(root, "linked.lock");
        var start = new System.Diagnostics.ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true };
        foreach (var argument in new[] { "/c", "mklink", "/H", linked, lockPath }) start.ArgumentList.Add(argument);
        using (var process = System.Diagnostics.Process.Start(start)!)
        {
            Assert.True(process.WaitForExit(10000));
            Assert.Equal(0, process.ExitCode);
        }

        // 硬链接（Links != 1）会让身份读取失败：必须是受控配置错误，且清理不抛
        Assert.ThrowsAny<ConfigException>(() => guard.Receipt());
        var failure = Record.Exception(() => guard.Dispose());
        Assert.True(failure is null || failure is ConfigException, failure?.ToString());
    }


    [Fact]
    public void NvencFallback_ClassifiesOnlyTheDriverApiVersionFailure()
    {
        const string signature = "[h264_nvenc @ 000001] Driver does not support the required nvenc API version. Required: 13.1 Found: 12.1";
        Assert.True(Fission.Cli.NvencFallback.TryClassify(signature, out var detail));
        Assert.Contains("driver=12.1", detail);
        Assert.Contains("required=13.1", detail);

        // 相似但不同的错误不得触发回退
        Assert.False(Fission.Cli.NvencFallback.TryClassify("InitializeEncoder failed: invalid param (8): Frame Dimension less than the minimum supported value.", out _));
        Assert.False(Fission.Cli.NvencFallback.TryClassify("Cannot load libcuda.so.1", out _));
        Assert.False(Fission.Cli.NvencFallback.TryClassify("", out _));
        Assert.False(Fission.Cli.NvencFallback.TryClassify(null, out _));
    }

}
