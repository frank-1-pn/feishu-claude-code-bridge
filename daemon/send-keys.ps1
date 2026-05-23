# Send keys to a target window
# Usage:
#   .\send-keys.ps1 -Action text -Text "/compact" -Hwnd 197088
#   .\send-keys.ps1 -Action enter -Hwnd 197088
#   .\send-keys.ps1 -Action esc -Hwnd 197088
#   .\send-keys.ps1 -Action clear -Hwnd 197088   (Ctrl+A then Delete)
#
# Safety:
#   - Verifies $Hwnd is the foreground window before sending (unless -Force)
#   - If not foreground: aborts with error="not_foreground" + current foreground hwnd
#   - SendKeys uses System.Windows.Forms — only works when target window has focus

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("text", "enter", "esc", "clear")]
    [string]$Action,
    [string]$Text = "",
    [Int64]$Hwnd = 0,
    [switch]$Force = $false
)

$ErrorActionPreference = "Continue"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Keys {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@ -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.Windows.Forms

# Reject Hwnd=0 (must specify target to avoid sending keys to wrong window)
if ($Hwnd -eq 0) {
    @{ error = "missing_hwnd"; message = "must specify -Hwnd to avoid sending keys to unknown window" } | ConvertTo-Json -Compress
    exit 1
}

# Foreground check
$currentFg = [int64]([Win32Keys]::GetForegroundWindow().ToInt64())
if ($currentFg -ne $Hwnd) {
    if (-not $Force) {
        @{
            error = "not_foreground"
            expected = $Hwnd
            actual = $currentFg
            message = "target window is not foreground; pass -Force to override (risky)"
        } | ConvertTo-Json -Compress
        exit 1
    }
    # Force: attempt to bring to foreground
    [Win32Keys]::ShowWindow([IntPtr]::new($Hwnd), 9) | Out-Null  # SW_RESTORE
    [Win32Keys]::SetForegroundWindow([IntPtr]::new($Hwnd)) | Out-Null
    Start-Sleep -Milliseconds 200
}

# Small delay so OS settles
Start-Sleep -Milliseconds 100

switch ($Action) {
    "text" {
        if ([string]::IsNullOrEmpty($Text)) {
            @{ error = "empty_text" } | ConvertTo-Json -Compress
            exit 2
        }
        # SendKeys-escape special chars: {}+^%~()[] are reserved
        $escaped = $Text -replace '([+^%~(){}\[\]])', '{$1}'
        [System.Windows.Forms.SendKeys]::SendWait($escaped)
        @{ ok = $true; action = "text"; sent = $Text } | ConvertTo-Json -Compress
    }
    "enter" {
        [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
        @{ ok = $true; action = "enter" } | ConvertTo-Json -Compress
    }
    "esc" {
        [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
        @{ ok = $true; action = "esc" } | ConvertTo-Json -Compress
    }
    "clear" {
        # Select all then delete (works in most text inputs)
        [System.Windows.Forms.SendKeys]::SendWait("^a")
        Start-Sleep -Milliseconds 50
        [System.Windows.Forms.SendKeys]::SendWait("{DELETE}")
        @{ ok = $true; action = "clear" } | ConvertTo-Json -Compress
    }
}
