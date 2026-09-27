# One bounded recovery owner. The Lark subscriber owns socket reconnection;
# this task only invokes the existing idempotent launchers for failed processes.
[CmdletBinding()]
param([string]$RuntimeDir = $PSScriptRoot, [switch]$NoAlert)
$ErrorActionPreference = 'Stop'
$env:LARK_CLI_NO_PROXY = '1'
$env:PATH += ';' + (Join-Path $env:APPDATA 'npm')
. (Join-Path $RuntimeDir 'invoke-bounded-script.ps1')
$mutex = New-Object System.Threading.Mutex($false, 'Global\LarkCodexWatchdog-v2')
$owned = $false
$statePath = Join-Path $RuntimeDir 'state/watchdog.json'
function Read-Json([string]$File) {
    try { return [System.IO.File]::ReadAllText($File) | ConvertFrom-Json } catch { return $null }
}
function Invoke-Runtime([string]$Name, [string[]]$Arguments = @()) {
    $result = Invoke-BoundedScript -ScriptPath (Join-Path $RuntimeDir $Name) -ScriptArguments $Arguments -TimeoutSeconds 30
    try {
        $data = if ($Name -eq 'status-codex-bridge.ps1') { Read-Json $result.OutputPath } else { $null }
        return [pscustomobject]@{ Code=$result.ExitCode; Data=$data }
    } finally {
        Remove-Item -LiteralPath $result.OutputPath,$result.ErrorPath -Force -ErrorAction SilentlyContinue
    }
}
try {
    try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { exit 0 }
    $previous = Read-Json $statePath
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $check = Invoke-Runtime 'status-codex-bridge.ps1'
    $attempts = 0
    # Read-only probes still run during cooldown, so natural recovery is noticed.
    if (-not $check.Data.healthy -and $previous.next_retry_at -gt $now) { exit 1 }
    $bindings = Read-Json (Join-Path $RuntimeDir 'codex-thread-bindings.json')
    while (-not $check.Data.healthy -and $attempts -lt 3) {
        if ($attempts -gt 0) { Start-Sleep -Milliseconds (1000 * [math]::Pow(2, $attempts) + (Get-Random -Minimum 0 -Maximum 500)) }
        $attempts++
        if (-not $check.Data.bridge.exact_identity -or -not $check.Data.bridge.heartbeat_fresh) {
            $null = Invoke-Runtime 'start-codex-bridge.ps1'
        }
        foreach ($binding in $bindings.bindings.PSObject.Properties) {
            $bot = @($check.Data.bots | Where-Object bot -eq $binding.Name)
            if ($bot.Count -eq 1 -and $bot[0].daemon_healthy) { continue }
            $arguments = @('-Bot', $binding.Name, '-SkipSessionBinding')
            if ($binding.Value.profile) { $arguments += @('-Profile', [string]$binding.Value.profile) }
            $null = Invoke-Runtime 'ensure-bot.ps1' $arguments
        }
        # Verify after recovery, and also catch failure between the first probe
        # and the final probe. A successful launcher alone is not success.
        $check = Invoke-Runtime 'status-codex-bridge.ps1'
    }
    if ($check.Data.healthy) {
        Start-Sleep -Milliseconds 750
        $check = Invoke-Runtime 'status-codex-bridge.ps1'
        if (-not $check.Data.healthy -and $attempts -lt 3) {
            $null = Invoke-Runtime 'start-codex-bridge.ps1'
            $attempts++
            $check = Invoke-Runtime 'status-codex-bridge.ps1'
        }
    }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $healthy = [bool]$check.Data.healthy
    $failures = if ($healthy) { 0 } else { [int]$previous.consecutive_failures + 1 }
    $delay = if ($healthy) { 0 } else { [int][math]::Min(600, 60 * [math]::Pow(2, [math]::Min($failures - 1, 4))) }
    $state = [ordered]@{
        checked_at = [DateTimeOffset]::UtcNow.ToString('o')
        healthy = $healthy
        delivery_healthy = [bool]$check.Data.delivery_healthy
        recovery_attempts = $attempts
        consecutive_failures = $failures
        next_retry_at = if ($healthy) { 0 } else { $now + $delay }
        last_alert_at = [long]$previous.last_alert_at
        bridge_identity_ok = [bool]$check.Data.bridge.exact_identity
        bridge_heartbeat_fresh = [bool]$check.Data.bridge.heartbeat_fresh
    }
    if (-not $healthy -and -not $NoAlert -and $now - $state.last_alert_at -ge 1800) {
        # Use the configured primary binding; never copy chat identifiers here.
        $target = $bindings.bindings.bot1
        if ($target.chat_id) {
            $textPath = Join-Path $env:TEMP "lark-watchdog-alert-$PID.txt"
            try {
                $text = 'Feishu/Codex recovery still unhealthy. Check status-codex-bridge.ps1 and state/watchdog.json. Automatic retries remain enabled.'
                [System.IO.File]::WriteAllText($textPath, $text, (New-Object System.Text.UTF8Encoding($false)))
                $arguments = @('-TextFile', $textPath, '-ChatId', [string]$target.chat_id)
                if ($target.profile) { $arguments += @('-Profile', [string]$target.profile) }
                $sent = Invoke-Runtime 'lark-send.ps1' $arguments
                if ($sent.Code -eq 0) { $state.last_alert_at = $now }
            } finally { Remove-Item -LiteralPath $textPath -Force -ErrorAction SilentlyContinue }
        }
    }
    $null = New-Item -ItemType Directory -Force (Split-Path $statePath)
    $tempPath = "$statePath.$PID.tmp"
    try {
        [System.IO.File]::WriteAllText($tempPath, ($state | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $statePath) { [System.IO.File]::Replace($tempPath, $statePath, "$statePath.previous") }
        else { [System.IO.File]::Move($tempPath, $statePath) }
    } finally { Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue }
    if ($healthy) { exit 0 }; exit 1
} finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
