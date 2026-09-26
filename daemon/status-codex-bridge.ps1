# Read-only health report for the existing lark daemons and Codex bridge.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'

$DaemonDir    = $PSScriptRoot
$WorkerPath   = Join-Path $DaemonDir 'codex-bridge-worker.mjs'
$BindingsPath = Join-Path $DaemonDir 'codex-thread-bindings.json'
$PidPath      = Join-Path $env:TEMP 'lark-codex-bridge.pid.json'
$StatusPath   = Join-Path $env:TEMP 'lark-codex-bridge.status.json'

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
    param([string]$CommandLine, [string]$Token)
    if (-not $CommandLine -or -not $Token) { return $false }
    $pattern = '(?:^|\s)"?' + [regex]::Escape($Token) + '"?(?:\s|$)'
    return [regex]::IsMatch($CommandLine, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Test-ExactBridgeProcess {
    param($Process, $Record)
    if (-not $Process -or -not $Record -or $Process.Name -ine 'node.exe') { return $false }
    if ([int]$Record.pid -ne [int]$Process.ProcessId) { return $false }
    if ([string]$Record.worker_path -ine $WorkerPath -or [string]$Record.bindings_path -ine $BindingsPath) { return $false }
    if ([string]$Record.instance -notmatch '^[0-9a-fA-F-]{36}$') { return $false }
    return (Test-CommandLineToken $Process.CommandLine $WorkerPath) -and
           (Test-CommandLineToken $Process.CommandLine $BindingsPath) -and
           (Test-CommandLineToken $Process.CommandLine ([string]$Record.instance))
}

function Test-Subscriber {
    param($Process, [string]$Profile)
    if (-not $Process -or $Process.Name -ine 'node.exe') { return $false }
    $cmd = [string]$Process.CommandLine
    if ($cmd -notlike '*event*subscribe*') { return $false }
    $profilePattern = '(?:^|\s)--profile\s+"?' + [regex]::Escape($Profile) + '"?(?:\s|$)'
    if ($Profile) { return [regex]::IsMatch($cmd, $profilePattern, 'IgnoreCase') }
    return ($cmd -notmatch '(?:^|\s)--profile(?:\s|=)')
}

function Read-Offset {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $value = (Get-Content -LiteralPath $Path -Raw -Encoding ASCII).Trim() -as [long]
    if ($null -eq $value -or $value -lt 0) { return $null }
    return $value
}

$bindings = Read-JsonFile -Path $BindingsPath
$pidRecord = Read-JsonFile -Path $PidPath
$workerStatus = Read-JsonFile -Path $StatusPath
$bridgeProcess = $null
if ($pidRecord -and $pidRecord.pid) {
    $bridgeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$pidRecord.pid)" -ErrorAction SilentlyContinue
}
$identityOk = Test-ExactBridgeProcess $bridgeProcess $pidRecord
$heartbeatAge = $null
$heartbeatFresh = $false
if ($workerStatus -and $pidRecord -and
    [int]$workerStatus.pid -eq [int]$pidRecord.pid -and
    [string]$workerStatus.instance -eq [string]$pidRecord.instance) {
    try {
        $heartbeat = [DateTimeOffset]::Parse([string]$workerStatus.heartbeat_at)
        $heartbeatAge = [math]::Round(([DateTimeOffset]::UtcNow - $heartbeat.ToUniversalTime()).TotalSeconds, 1)
        $heartbeatFresh = ($heartbeatAge -le 60)
    } catch {}
}

$botReports = @()
if ($bindings -and $bindings.bindings) {
    foreach ($property in $bindings.bindings.PSObject.Properties) {
        $bot = $property.Name
        $binding = $property.Value
        $daemonPidPath = Join-Path $env:TEMP "lark-$bot.pid"
        $daemonPid = (Get-Content -LiteralPath $daemonPidPath -ErrorAction SilentlyContinue | Select-Object -First 1) -as [int]
        $daemonProcess = $null
        if ($daemonPid) {
            $daemonProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$daemonPid" -ErrorAction SilentlyContinue
        }
        $logPath = Join-Path $env:TEMP "lark-$bot-events.ndjson"
        $offsetPath = Join-Path $env:TEMP "lark-$bot-codex.offset"
        $receiptOffsetPath = Join-Path $env:TEMP "lark-$bot-codex-receipt.offset"
        $logItem = Get-Item -LiteralPath $logPath -ErrorAction SilentlyContinue
        $botState = $null
        if ($workerStatus -and $workerStatus.bot_states) {
            $stateProperty = $workerStatus.bot_states.PSObject.Properties[$bot]
            if ($stateProperty) { $botState = $stateProperty.Value }
        }
        $botReports += [ordered]@{
            bot = $bot
            daemon_pid = if ($daemonPid) { $daemonPid } else { $null }
            daemon_healthy = [bool](Test-Subscriber $daemonProcess ([string]$binding.profile))
            profile = [string]$binding.profile
            event_log_exists = [bool]$logItem
            event_log_bytes = if ($logItem) { [long]$logItem.Length } else { $null }
            codex_offset = Read-Offset $offsetPath
            receipt_offset = Read-Offset $receiptOffsetPath
            bridge_state = if ($botState) { $botState.state } else { $null }
            current_message_id = if ($botState) { $botState.current_message_id } else { $null }
            progress_sent_count = if ($botState) { $botState.progress_sent_count } else { $null }
            last_progress_at = if ($botState) { $botState.last_progress_at } else { $null }
            queued_count = if ($botState) { $botState.queued_count } else { $null }
            awaiting_delivery_count = if ($botState) { $botState.awaiting_delivery_count } else { $null }
            awaiting_reply_count = if ($botState) { $botState.awaiting_reply_count } else { $null }
            reply_pending_count = if ($botState) { $botState.reply_pending_count } else { $null }
            failed_count = if ($botState) { $botState.failed_count } else { $null }
            completed_count = if ($botState) { $botState.completed_count } else { $null }
            oldest_pending_seconds = if ($botState) { $botState.oldest_pending_seconds } else { $null }
            last_delivered_at = if ($botState) { $botState.last_delivered_at } else { $null }
            delivery_stalled = if ($botState) { [bool]$botState.delivery_stalled } else { $null }
            thread_id = [string]$binding.codex_thread_id
            cwd_exists = [bool](Test-Path -LiteralPath ([string]$binding.cwd) -PathType Container)
        }
    }
}

$botsHealthy = ($botReports.Count -gt 0 -and @($botReports | Where-Object { -not $_.daemon_healthy -or -not $_.event_log_exists -or -not $_.cwd_exists }).Count -eq 0)
$healthy = [bool]($identityOk -and $heartbeatFresh -and $botsHealthy)
$report = [ordered]@{
    healthy = $healthy
    transport_healthy = $healthy
    delivery_healthy = [bool]($healthy -and @($botReports | Where-Object { $_.delivery_stalled -or $_.failed_count -gt 0 }).Count -eq 0)
    health_scope = 'healthy reports process/transport; delivery_healthy additionally checks queue failures and stalls; last_delivered_at is rollout evidence'
    checked_at = [DateTimeOffset]::UtcNow.ToString('o')
    bridge = [ordered]@{
        pid = if ($pidRecord) { $pidRecord.pid } else { $null }
        instance = if ($pidRecord) { $pidRecord.instance } else { $null }
        exact_identity = [bool]$identityOk
        heartbeat_fresh = [bool]$heartbeatFresh
        heartbeat_age_seconds = $heartbeatAge
        state = if ($workerStatus) { $workerStatus.state } else { $null }
        current_bot = if ($workerStatus) { $workerStatus.current_bot } else { $null }
        current_bots = if ($workerStatus) { @($workerStatus.current_bots) } else { @() }
        current_message_id = if ($workerStatus) { $workerStatus.current_message_id } else { $null }
        bot_states = if ($workerStatus) { $workerStatus.bot_states } else { $null }
        last_success_at = if ($workerStatus) { $workerStatus.last_success_at } else { $null }
        last_error = if ($workerStatus) { $workerStatus.last_error } else { $null }
    }
    bots = $botReports
}

$report | ConvertTo-Json -Depth 8
if ($healthy) { exit 0 }
exit 1
