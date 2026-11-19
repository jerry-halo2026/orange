// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using Fission.Core.Errors;

namespace Fission.Cli;

/// <summary>Holds the parent-selected private workspace namespace while its original CLI runs.</summary>
public sealed class WorkspaceNamespaceLease : IDisposable
{
    private readonly SafeFileHandle handle;

    private WorkspaceNamespaceLease(SafeFileHandle handle) => this.handle = handle;

    /// <summary>Open the already-created ordinary lock file without delete sharing.</summary>
    public static WorkspaceNamespaceLease Acquire(string workspace)
    {
        if (!OperatingSystem.IsWindows()) throw Invalid();
        try
        {
            if (!Path.IsPathFullyQualified(workspace) || !string.Equals(workspace, Path.GetFullPath(workspace), StringComparison.OrdinalIgnoreCase)) throw Invalid();
            var file = Path.Combine(workspace, ".fission-namespace.lock");
            var handle = CreateFile(file, 0x80000000, 3, IntPtr.Zero, 3, 0x00200080, IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); throw Invalid(); }
            try
            {
                if (!GetFileInformationByHandle(handle, out var info) || info.Links != 1 || (info.Attributes & 0x410) != 0) throw Invalid();
                var resolved = new char[32768];
                var size = GetFinalPathNameByHandle(handle, resolved, resolved.Length, 0);
                if (size == 0 || size >= resolved.Length) throw Invalid();
                var final = new string(resolved, 0, checked((int)size));
                if (!final.StartsWith(@"\\?\", StringComparison.Ordinal)) throw Invalid();
                if (!string.Equals(final[4..], file, StringComparison.OrdinalIgnoreCase)) throw Invalid();
                for (var at = workspace; ; at = Path.GetDirectoryName(at)!)
                {
                    if ((File.GetAttributes(at) & FileAttributes.ReparsePoint) != 0) throw Invalid();
                    if (at == Path.GetPathRoot(at)) break;
                }
                return new WorkspaceNamespaceLease(handle);
            }
            catch { handle.Dispose(); throw; }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        { throw Invalid(); }
    }

    public void Dispose() => handle.Dispose();

    private static ConfigException Invalid() => new("CFG_ARGS", "混剪工作目录无法安全固定。");

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern SafeFileHandle CreateFile(string file, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);

    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, [Out] char[] filePath, int filePathSize, uint flags);
}
