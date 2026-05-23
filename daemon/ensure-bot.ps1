# Parametrized daemon health check + auto-heal + housekeeping.
# Safe to run on every session start, /compact, or stream-ended detection.
#
# Usage:
#   ensure-bot.ps1 -Bot bot1
#   ensure-bot.ps1 -Bot coding   -Profile coding-assistant-claude
#   ensure-bot.ps1 -Bot finance  -Profile finance-agent
#
# Responsibilities:
#   1. NDJSON log rotation when > $MaxLogBytes (kills daemon, rotates, restarts)
#   2. ERR  log rotation when > $MaxErrBytes (truncate-in-place, no kill)   <- B2
#   3. Verify daemon process alive + truly subscribing for THIS bot
#   4. (Re)start via start-bot.ps1 if unhealthy
#   5. Prune stale binding-<pid>.json files (PID gone)                       <- B6
#   6. Prune notify-once *.last files older than $LockMaxAgeDays             <- B7

param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-zA-Z0-9_-]+$')]
    [string]$Bot,
    [string]$Profile = ''
)

$ErrorActionPreference = 'Continue'
$env:LARK_CLI_NO_PROXY = '1'

$LogPath    = "$env:TEMP\lark-$Bot-events.ndjson"
$ErrPath    = "$env:TEMP\lark-$Bot-daemon.err.log"
$PidPath    = "$env:TEMP\lark-$Bot.pid"
$OffsetPath = "$env:TEMP\lark-$Bot-monitor.offset"
$DaemonDir  = "$env:USERPROFILE\.lark-cli\daemon"
$LockDir    = "$env:TEMP\lark-notify-once"

$MaxLogBytes = 50MB
$MaxErrBytes = 10MB
$LockMaxAgeDays = 7

function Test-IsThisBotsSubscribe {
    param([string]$CmdLine)
    if ($CmdLine -notlike '*event*subscribe*') { return $false }
    if ($Profile) { return ($CmdLine -like "*--profile $Profile*") }
    return ($CmdLine -notlike '*--profile*')
}

function Test-DaemonHealthy {
    if (-not (Test-Path $PidPath)) { return $false }
    $pidNum = (Get-Content $PidPath -ErrorAction SilentlyContinue) -as [int]
    if (-not $pidNum) { return $false }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidNum" -ErrorAction SilentlyContinue
    if (-not $proc) { return $false }
    return (Test-IsThisBotsSubscribe -CmdLine $proc.CommandLine)
}

function Invoke-NdjsonRotate {
    if (-not (Test-Path $LogPath)) { return }
    $size = (Get-Item $LogPath).Length
    if ($size -le $MaxLogBytes) { return }
    Write-Host "[ensure $Bot] ndjson $($size/1MB)MB > 50MB, rotating (kill+rotate+restart)"
    $pidNum = (Get-Content $PidPath -ErrorAction SilentlyContinue) -as [int]
    if ($pidNum) {
        Stop-Process -Id $pidNum -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    if (Test-Path "$LogPath.1") { Remove-Item "$LogPath.1" -Force }
    Move-Item $LogPath "$LogPath.1" -Force
    '' | Out-File -FilePath $LogPath -Encoding ascii
    if (Test-Path $OffsetPath) { Remove-Item $OffsetPath -Force }   # reset monitor read pos
    Write-Host "[ensure $Bot] ndjson rotated -> $LogPath.1, offset reset"
}

# B2: ERR log rotation. Truncate-in-place doesn't work because daemon holds an
#     exclusive write lock on the file (Start-Process -RedirectStandardError).
#     So when err exceeds the cap, we fall through and let the next ndjson
#     rotation cycle handle it — OR explicitly request a daemon restart by
#     returning a flag. Cleaner: piggyback on the existing kill+rotate path
#     used by ndjson rotation.
function Invoke-ErrLogRotate {
    if (-not (Test-Path $ErrPath)) { return $false }
    $size = (Get-Item $ErrPath).Length
    if ($size -le $MaxErrBytes) { return $false }
    Write-Host "[ensure $Bot] err log $($size/1MB)MB > 10MB, rotating (kill+rotate+restart)"
    $pidNum = (Get-Content $PidPath -ErrorAction SilentlyContinue) -as [int]
    if ($pidNum) {
        Stop-Process -Id $pidNum -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    if (Test-Path "$ErrPath.1") { Remove-Item "$ErrPath.1" -Force }
    Move-Item $ErrPath "$ErrPath.1" -Force
    '' | Out-File -FilePath $ErrPath -Encoding ascii -NoNewline
    Write-Host "[ensure $Bot] err log rotated -> $ErrPath.1"
    return $true   # signals "daemon was killed, needs restart"
}

# B6: prune binding-<pid>.json files whose PID is no longer alive.
function Invoke-BindingPrune {
    if (-not (Test-Path $DaemonDir)) { return }
    $bindings = Get-ChildItem -Path $DaemonDir -Filter 'binding-*.json' -ErrorAction SilentlyContinue
    if (-not $bindings) { return }
    $alive = @{}
    Get-CimInstance Win32_Process -Filter "Name='claude.exe'" -ErrorAction SilentlyContinue |
        ForEach-Object { $alive["$($_.ProcessId)"] = $true }
    $pruned = 0
    foreach ($b in $bindings) {
        if ($b.Name -match '^binding-(\d+)\.json$') {
            $bindPid = $matches[1]
            if (-not $alive.ContainsKey($bindPid)) {
                Remove-Item -LiteralPath $b.FullName -Force -ErrorAction SilentlyContinue
                $pruned++
            }
        }
    }
    if ($pruned -gt 0) {
        Write-Host "[ensure $Bot] pruned $pruned stale binding-*.json"
    }
}

# B7: prune notify-once dedup locks older than $LockMaxAgeDays.
function Invoke-LockPrune {
    if (-not (Test-Path $LockDir)) { return }
    $cutoff = (Get-Date).AddDays(-$LockMaxAgeDays)
    $locks = Get-ChildItem -Path $LockDir -Filter '*.last' -ErrorAction SilentlyContinue |
             Where-Object { $_.LastWriteTime -lt $cutoff }
    if (-not $locks) { return }
    foreach ($l in $locks) {
        Remove-Item -LiteralPath $l.FullName -Force -ErrorAction SilentlyContinue
    }
    Write-Host "[ensure $Bot] pruned $($locks.Count) stale notify-once locks (>${LockMaxAgeDays}d)"
}

function Start-Daemon {
    $script = Join-Path $DaemonDir 'start-bot.ps1'
    if ($Profile) {
        & powershell -ExecutionPolicy Bypass -File $script -Bot $Bot -Profile $Profile
    } else {
        & powershell -ExecutionPolicy Bypass -File $script -Bot $Bot
    }
    return ($LASTEXITCODE -eq 0)
}

# --- main ----------------------------------------------------------------

Invoke-NdjsonRotate
$errKilled = Invoke-ErrLogRotate
Invoke-BindingPrune
Invoke-LockPrune

if ($errKilled -or -not (Test-DaemonHealthy)) {
    Write-Host "[ensure $Bot] daemon not healthy, (re)starting"
    Start-Daemon | Out-Null
} else {
    $pidNum = (Get-Content $PidPath) -as [int]
    Write-Host "[ensure $Bot] daemon healthy PID=$pidNum"
}
