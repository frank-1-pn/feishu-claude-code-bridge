[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$ThreadId,

    [Parameter(Mandatory = $true)]
    [string]$CodexHome,

    [Parameter(Mandatory = $true)]
    [string]$RpcScript
)

$ErrorActionPreference = 'Stop'

if (-not ('CodexWriterLockProbe' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class CodexWriterLockProbe {
    private const int SessionKeyLength = 32;
    private const int MaxAppName = 255;
    private const int MaxServiceName = 63;

    [StructLayout(LayoutKind.Sequential)]
    public struct UniqueProcess {
        public int ProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct ProcessInfo {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MaxAppName + 1)] public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MaxServiceName + 1)] public string ServiceShortName;
        public uint ApplicationType;
        public uint AppStatus;
        public uint TerminalSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint handle, int flags, string sessionKey);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(uint handle, uint fileCount, string[] filenames,
        uint applicationCount, UniqueProcess[] applications, uint serviceCount, string[] serviceNames);
    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(uint handle, out uint needed, ref uint count,
        [In, Out] ProcessInfo[] affectedApps, ref uint rebootReasons);
    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint handle);

    public static int[] GetLockingProcessIds(string filename) {
        uint handle;
        string key = Guid.NewGuid().ToString("N").Substring(0, SessionKeyLength);
        int result = RmStartSession(out handle, 0, key);
        if (result != 0) throw new InvalidOperationException("RmStartSession=" + result);
        try {
            result = RmRegisterResources(handle, 1, new[] { filename }, 0, null, 0, null);
            if (result != 0) throw new InvalidOperationException("RmRegisterResources=" + result);
            uint needed = 0, count = 0, reasons = 0;
            result = RmGetList(handle, out needed, ref count, null, ref reasons);
            if (result == 0) return new int[0];
            if (result != 234) throw new InvalidOperationException("RmGetList=" + result);
            var data = new ProcessInfo[needed];
            count = needed;
            result = RmGetList(handle, out needed, ref count, data, ref reasons);
            if (result != 0) throw new InvalidOperationException("RmGetList=" + result);
            var ids = new int[count];
            for (int index = 0; index < count; index++) ids[index] = data[index].Process.ProcessId;
            return ids;
        } finally {
            RmEndSession(handle);
        }
    }
}
'@
}

$resolvedHome = [IO.Path]::GetFullPath($CodexHome)
$lockDirectory = Join-Path $resolvedHome 'thread-writer-locks'
$lockPath = [IO.Path]::GetFullPath((Join-Path $lockDirectory "$ThreadId.lock"))
if (-not $lockPath.StartsWith(([IO.Path]::GetFullPath($lockDirectory) + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Resolved writer lock escaped the expected directory.'
}

if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
    @{ ok = $true; active_writer = $false; thread_id = $ThreadId } | ConvertTo-Json -Compress
    exit 0
}

$writerPids = @([CodexWriterLockProbe]::GetLockingProcessIds($lockPath))
if ($writerPids.Count -eq 0) {
    @{ ok = $true; active_writer = $false; thread_id = $ThreadId } | ConvertTo-Json -Compress
    exit 0
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$sessionsResult = & $nodePath $RpcScript --mode list | ConvertFrom-Json
$sessions = @($sessionsResult.sessions)
$processes = @(Get-CimInstance Win32_Process)
$byPid = @{}
foreach ($process in $processes) { $byPid[[int]$process.ProcessId] = $process }

$matches = @()
foreach ($writerPid in $writerPids) {
    $writer = $byPid[[int]$writerPid]
    if (-not $writer -or $writer.Name -ne 'codex.exe') { continue }
    $ancestors = @{}
    $cursor = $writer
    for ($depth = 0; $depth -lt 24 -and $cursor; $depth++) {
        $ancestors[[int]$cursor.ProcessId] = $true
        $parentPid = [int]$cursor.ParentProcessId
        if ($parentPid -le 0 -or -not $byPid.ContainsKey($parentPid)) { break }
        $cursor = $byPid[$parentPid]
    }
    foreach ($session in $sessions) {
        $ptyPid = [int]$session.pid
        if ($ancestors.ContainsKey($ptyPid)) {
            $matches += [pscustomobject]@{
                writer_pid = [int]$writerPid
                pty_pid = $ptyPid
                pty_session_id = [string]$session.sessionId
            }
        }
    }
}

if ($matches.Count -ne 1) {
    @{
        ok = $false
        error = if ($matches.Count -eq 0) { 'writer_pty_not_found' } else { 'writer_pty_ambiguous' }
        thread_id = $ThreadId
        writer_count = $writerPids.Count
        match_count = $matches.Count
    } | ConvertTo-Json -Compress
    exit 2
}

@{
    ok = $true
    active_writer = $true
    thread_id = $ThreadId
    writer_pid = $matches[0].writer_pid
    pty_pid = $matches[0].pty_pid
    pty_session_id = $matches[0].pty_session_id
} | ConvertTo-Json -Compress
