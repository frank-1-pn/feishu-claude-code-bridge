# Find the foreground terminal window that's hosting a Claude Code session
# Strategy: claude.exe is a CLI tool — windows belong to the host terminal
# (wt.exe / pwsh / WezTerm / etc.). Trigger expects the user-active session,
# so we find the foreground window and verify its process tree contains claude.exe.
#
# Returns JSON:
#   - Success: {hwnd, pid, processName, windowTitle, claudePid, claudePids}
#   - error="no_foreground"
#   - error="no_claude_in_tree" (foreground window has no claude.exe descendant)

$ErrorActionPreference = "Continue"

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@ -ErrorAction SilentlyContinue

function Get-ProcessTreeChildren {
    param([uint32]$RootPid)
    # BFS: collect all descendant PIDs
    $found = @()
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($RootPid)
    $seen = @{ "$RootPid" = $true }
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$current" -ErrorAction SilentlyContinue
        foreach ($k in $kids) {
            if (-not $seen.ContainsKey("$($k.ProcessId)")) {
                $seen["$($k.ProcessId)"] = $true
                $found += [PSCustomObject]@{
                    pid = $k.ProcessId
                    name = $k.Name
                    commandLine = $k.CommandLine
                }
                $queue.Enqueue($k.ProcessId)
            }
        }
    }
    return $found
}

$hwnd = [Win32]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
    @{ error = "no_foreground"; message = "no foreground window" } | ConvertTo-Json -Compress
    exit 1
}

$fgPidVar = 0
[Win32]::GetWindowThreadProcessId($hwnd, [ref]$fgPidVar) | Out-Null
$fgPid = [uint32]$fgPidVar

$len = [Win32]::GetWindowTextLength($hwnd)
$titleSb = New-Object System.Text.StringBuilder ($len + 1)
if ($len -gt 0) {
    [Win32]::GetWindowText($hwnd, $titleSb, $titleSb.Capacity) | Out-Null
}
$windowTitle = $titleSb.ToString()

$fgProc = Get-CimInstance Win32_Process -Filter "ProcessId=$fgPid" -ErrorAction SilentlyContinue
$processName = if ($fgProc) { $fgProc.Name } else { "unknown" }

# Walk descendants looking for claude.exe
$descendants = Get-ProcessTreeChildren -RootPid $fgPid
$claudeProcs = $descendants | Where-Object { $_.name -ieq "claude.exe" }

if ($claudeProcs.Count -eq 0) {
    @{
        error = "no_claude_in_tree"
        message = "foreground window ($processName, pid=$fgPid, title='$windowTitle') has no claude.exe descendant"
        hwnd = $hwnd.ToInt64()
        pid = $fgPid
        processName = $processName
        windowTitle = $windowTitle
        descendants = ($descendants | Select-Object -First 10)
    } | ConvertTo-Json -Depth 4 -Compress
    exit 2
}

$claudePid = $claudeProcs[0].pid
$claudePids = @($claudeProcs | ForEach-Object { $_.pid })

@{
    hwnd = $hwnd.ToInt64()
    pid = $fgPid
    processName = $processName
    windowTitle = $windowTitle
    claudePid = $claudePid
    claudePids = $claudePids
    claudeCommandLine = $claudeProcs[0].commandLine
} | ConvertTo-Json -Compress
