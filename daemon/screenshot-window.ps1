# Screenshot a target window by HWND or PID
# Usage:
#   .\screenshot-window.ps1 -Hwnd <int>
#   .\screenshot-window.ps1 -Pid <int>   (uses foreground window if PID matches)
# Output: path to saved PNG on stdout (or JSON {error: ...})

param(
    [Int64]$Hwnd = 0,
    [string]$Tag = "compact"
)

$ErrorActionPreference = "Continue"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public class Win32Screenshot {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
"@ -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.Drawing

if ($Hwnd -eq 0) {
    $Hwnd = [int64]([Win32Screenshot]::GetForegroundWindow().ToInt64())
}

if ($Hwnd -eq 0) {
    @{ error = "no_window" } | ConvertTo-Json -Compress
    exit 1
}

$hwndPtr = [IntPtr]::new($Hwnd)
$rect = New-Object RECT
$ok = [Win32Screenshot]::GetWindowRect($hwndPtr, [ref]$rect)
if (-not $ok) {
    @{ error = "get_rect_failed" } | ConvertTo-Json -Compress
    exit 2
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
    @{ error = "zero_size"; rect = @{l=$rect.Left;t=$rect.Top;r=$rect.Right;b=$rect.Bottom} } | ConvertTo-Json -Compress
    exit 3
}

$ts = (Get-Date -Format "yyyyMMdd-HHmmss")
$outPath = "$env:TEMP\compact-${Tag}-${ts}.png"

$bmp = New-Object System.Drawing.Bitmap $width, $height
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
    $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, [System.Drawing.Size]::new($width, $height))
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $g.Dispose()
    $bmp.Dispose()
}

@{
    path = $outPath
    hwnd = $Hwnd
    width = $width
    height = $height
    rect = @{ l = $rect.Left; t = $rect.Top; r = $rect.Right; b = $rect.Bottom }
} | ConvertTo-Json -Compress
