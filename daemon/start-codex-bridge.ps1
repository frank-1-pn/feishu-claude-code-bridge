# Hidden, idempotent launcher for the thin Feishu -> Codex bridge.
#
# The worker consumes the existing lark-<bot>-events.ndjson streams; this
# launcher never starts a second lark event subscription.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$DaemonDir   = $PSScriptRoot
$WorkerPath  = Join-Path $DaemonDir 'codex-bridge-worker.mjs'
$BindingsPath = Join-Path $DaemonDir 'codex-thread-bindings.json'
$PidPath     = Join-Path $env:TEMP 'lark-codex-bridge.pid.json'
$StatusPath  = Join-Path $env:TEMP 'lark-codex-bridge.status.json'
$LockPath    = Join-Path $env:TEMP 'lark-codex-bridge.lock'
$OutLogPath  = Join-Path $env:TEMP 'lark-codex-bridge.log'
$ErrLogPath  = Join-Path $env:TEMP 'lark-codex-bridge.err.log'
$NodePath    = (Get-Command node.exe -ErrorAction Stop).Source
$StartMutex  = New-Object System.Threading.Mutex($false, 'Global\LarkCodexBridgeStart-ke')

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Test-CommandLineToken {
    param(
        [string]$CommandLine,
        [string]$Token
    )
    if (-not $CommandLine -or -not $Token) { return $false }
    $pattern = '(?:^|\s)"?' + [regex]::Escape($Token) + '"?(?:\s|$)'
    return [regex]::IsMatch($CommandLine, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Test-ExactBridgeProcess {
    param(
        $Process,
        $Record
    )
    if (-not $Process -or -not $Record) { return $false }
    if ($Process.Name -ine 'node.exe') { return $false }
    if ([int]$Record.pid -ne [int]$Process.ProcessId) { return $false }
    if ([string]$Record.worker_path -ine $WorkerPath) { return $false }
    if ([string]$Record.bindings_path -ine $BindingsPath) { return $false }
    if ([string]$Record.instance -notmatch '^[0-9a-fA-F-]{36}$') { return $false }
    return (Test-CommandLineToken $Process.CommandLine $WorkerPath) -and
           (Test-CommandLineToken $Process.CommandLine $BindingsPath) -and
           (Test-CommandLineToken $Process.CommandLine ([string]$Record.instance))
}

function Test-HeartbeatFresh {
    param($Record)
    $status = Read-JsonFile -Path $StatusPath
    if (-not $status) { return $false }
    if ([int]$status.pid -ne [int]$Record.pid -or [string]$status.instance -ne [string]$Record.instance) {
        return $false
    }
    try {
        $heartbeat = [DateTimeOffset]::Parse([string]$status.heartbeat_at)
        return (([DateTimeOffset]::UtcNow - $heartbeat.ToUniversalTime()).TotalSeconds -le 60)
    } catch {
        return $false
    }
}

function Get-ExactWorkerProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            (Test-CommandLineToken $_.CommandLine $WorkerPath) -and
            (Test-CommandLineToken $_.CommandLine $BindingsPath)
        })
}

function Remove-StaleBridgeState {
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $StatusPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
}

$mutexAcquired = $false
try {
    $mutexAcquired = $StartMutex.WaitOne(10000)
} catch [System.Threading.AbandonedMutexException] {
    # The previous launcher died in the critical section; this caller now owns
    # the abandoned mutex and can recover the worker state safely.
    $mutexAcquired = $true
}
if (-not $mutexAcquired) {
    $StartMutex.Dispose()
    throw 'timed out waiting for the Codex bridge start mutex'
}

try {
    if (-not (Test-Path -LiteralPath $WorkerPath)) { throw "worker not found: $WorkerPath" }
    if (-not (Test-Path -LiteralPath $BindingsPath)) { throw "bindings not found: $BindingsPath" }

    # Static configuration validation does not acquire the worker lock or touch offsets.
    & $NodePath $WorkerPath --bindings $BindingsPath --check-config | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "bridge config validation failed (exit=$LASTEXITCODE)" }

    $record = Read-JsonFile -Path $PidPath
    $process = $null
    if ($record -and $record.pid) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$record.pid)" -ErrorAction SilentlyContinue
    }
    if (Test-ExactBridgeProcess $process $record) {
        if (-not (Test-HeartbeatFresh $record)) {
            # Avoid restarting during the tiny replace window of the atomically
            # refreshed status file.
            Start-Sleep -Milliseconds 500
        }
        if (Test-HeartbeatFresh $record) {
            Write-Host "[codex bridge] already healthy PID=$($record.pid) instance=$($record.instance)"
            exit 0
        }
    }

    # PID reuse cannot cause a kill: only a node process carrying the exact
    # worker, bindings, and per-launch instance token is eligible.
    if (Test-ExactBridgeProcess $process $record) {
        Write-Host "[codex bridge] exact worker heartbeat stale; restarting PID=$($record.pid)"
        Stop-Process -Id ([int]$record.pid) -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    } else {
        $exactWorkers = Get-ExactWorkerProcesses
        if ($exactWorkers.Count -gt 1) {
            throw "multiple exact bridge workers found; refusing an ambiguous restart: $($exactWorkers.ProcessId -join ',')"
        }
        if ($exactWorkers.Count -eq 1) {
            # A worker without trustworthy identity metadata must not be killed
            # or duplicated. Surface it for manual inspection.
            throw "exact bridge worker PID=$($exactWorkers[0].ProcessId) exists but identity metadata is missing or invalid"
        }
    }

    Remove-StaleBridgeState
    $instance = [guid]::NewGuid().ToString()
    $argumentList = @(
        $WorkerPath,
        '--bindings', $BindingsPath,
        '--instance', $instance
    )
    $started = Start-Process -FilePath $NodePath `
        -ArgumentList $argumentList `
        -WindowStyle Hidden `
        -RedirectStandardOutput $OutLogPath `
        -RedirectStandardError $ErrLogPath `
        -PassThru
    if (-not $started) { throw 'Start-Process returned no process' }

    $ready = $false
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        Start-Sleep -Milliseconds 200
        $started.Refresh()
        if ($started.HasExited) { break }
        $newRecord = Read-JsonFile -Path $PidPath
        if ($newRecord -and [int]$newRecord.pid -eq $started.Id -and [string]$newRecord.instance -eq $instance) {
            $newProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($started.Id)" -ErrorAction SilentlyContinue
            if (Test-ExactBridgeProcess $newProcess $newRecord) {
                $ready = $true
                break
            }
        }
    }
    if (-not $ready) {
        if (-not $started.HasExited) { Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue }
        throw "bridge did not publish valid identity metadata; see $ErrLogPath"
    }

    Write-Host "[codex bridge] started PID=$($started.Id) instance=$instance"
    Write-Host "[codex bridge] metadata log: $OutLogPath"
    Write-Host "[codex bridge] error log: $ErrLogPath"
    exit 0
} finally {
    try { $StartMutex.ReleaseMutex() } catch {}
    $StartMutex.Dispose()
}
