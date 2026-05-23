# Idempotent daemon health check + auto-heal for Bot1
# Run anytime: session start, /compact, stream-ended detection
# - Verifies daemon process alive AND truly subscribing
# - Rotates log if > 50MB
# - (Re)starts daemon if needed

$ErrorActionPreference = "Continue"

$LogPath = "$env:TEMP\lark-bot1-events.ndjson"
$ErrPath = "$env:TEMP\lark-bot1-daemon.err.log"
$PidPath = "$env:TEMP\lark-bot1.pid"
$OffsetPath = "$env:TEMP\lark-bot1-monitor.offset"
$LarkCli = "<USER_HOME>\AppData\Roaming\npm\node_modules\@larksuite\cli\scripts\run.js"
$MaxLogBytes = 50MB

function Test-DaemonHealthy {
    if (-not (Test-Path $PidPath)) { return $false }
    $pidNum = (Get-Content $PidPath -ErrorAction SilentlyContinue) -as [int]
    if (-not $pidNum) { return $false }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidNum" -ErrorAction SilentlyContinue
    if (-not $proc) { return $false }
    if ($proc.CommandLine -notlike "*event*subscribe*") { return $false }
    if ($proc.CommandLine -like "*--profile*") { return $false }
    return $true
}

function Invoke-LogRotate {
    if (-not (Test-Path $LogPath)) { return }
    $size = (Get-Item $LogPath).Length
    if ($size -le $MaxLogBytes) { return }
    Write-Host "[ensure] log $($size/1MB)MB > 50MB, rotating"
    # Daemon writes via redirected stdout; we can't safely truncate without losing data.
    # Rename to .1, daemon will create new on next write attempt.
    # NOTE: This may cause brief data loss; PowerShell redirect doesn't reopen file.
    # Safer: kill daemon, rotate, restart.
    Write-Host "[ensure] killing daemon for safe rotate"
    $pidNum = (Get-Content $PidPath -ErrorAction SilentlyContinue) -as [int]
    if ($pidNum) {
        Stop-Process -Id $pidNum -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    if (Test-Path "$LogPath.1") { Remove-Item "$LogPath.1" -Force }
    Move-Item $LogPath "$LogPath.1" -Force
    "" | Out-File -FilePath $LogPath -Encoding ascii
    # Reset Monitor offset since file truncated
    if (Test-Path $OffsetPath) { Remove-Item $OffsetPath -Force }
    Write-Host "[ensure] rotated $LogPath → $LogPath.1, offset reset"
}

function Start-Daemon {
    # Kill any Bot1 orphan subscribers first
    $orphans = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*event*subscribe*' -and $_.CommandLine -notlike '*--profile*' }
    foreach ($o in $orphans) {
        Write-Host "[ensure] killing Bot1 orphan PID=$($o.ProcessId)"
        Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($orphans) { Start-Sleep -Seconds 3 }

    $args = @(
        $LarkCli, "event", "+subscribe",
        "--event-types", "im.message.receive_v1",
        "--compact", "--as", "bot", "--force"
    )
    $proc = Start-Process -FilePath "node" -ArgumentList $args `
        -WindowStyle Hidden `
        -RedirectStandardOutput $LogPath `
        -RedirectStandardError $ErrPath `
        -PassThru
    if (-not $proc) { Write-Host "[ensure] FAILED to start"; return $false }
    $proc.Id | Out-File -FilePath $PidPath -Encoding ascii -NoNewline
    Write-Host "[ensure] daemon started PID=$($proc.Id)"
    return $true
}

# Main:
Invoke-LogRotate
if (Test-DaemonHealthy) {
    $pidNum = (Get-Content $PidPath) -as [int]
    Write-Host "[ensure] daemon healthy PID=$pidNum"
} else {
    Write-Host "[ensure] daemon not healthy, (re)starting"
    Start-Daemon | Out-Null
}
