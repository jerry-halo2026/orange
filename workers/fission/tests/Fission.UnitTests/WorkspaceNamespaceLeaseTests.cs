// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using Fission.Cli;
using Fission.Core.Errors;

namespace Fission.UnitTests;

[System.Runtime.Versioning.SupportedOSPlatform("windows7.0")]
public sealed class WorkspaceNamespaceLeaseTests
{
    [Fact]
    public void HeldWorkspace_RefusesReplacement_UntilActualLeaseIsClosed()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7)) return;
        var baseRoot = TestEnvironment.Root;
        var root = Path.Combine(baseRoot, "namespace-" + Guid.NewGuid().ToString("N"));
        var work = Path.Combine(root, "worker");
        var moved = Path.Combine(root, "worker-moved");
        Directory.CreateDirectory(work);
        File.WriteAllText(Path.Combine(work, ".fission-namespace.lock"), string.Empty);
        using (WorkspaceNamespaceLease.Acquire(work))
        {
            var failure = Record.Exception(() => Directory.Move(work, moved));
            Assert.NotNull(failure);
            Assert.True(failure is IOException or UnauthorizedAccessException);
            Assert.True(Directory.Exists(work));
            Assert.False(Directory.Exists(moved));
        }
        Directory.Move(work, moved);
        Assert.True(Directory.Exists(moved));
    }

    [Fact]
    public void MissingWorkspaceSentinel_IsRefused()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(7)) return;
        var baseRoot = TestEnvironment.Root;
        var work = Path.Combine(baseRoot, "missing-sentinel-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        Assert.Throws<ConfigException>(() => WorkspaceNamespaceLease.Acquire(work));
    }
}
