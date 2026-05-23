# Parametrized lark-cli daemon launcher.
# Idempotent: skip if a healthy daemon for this -Bot already runs.
# Kills only orphans matching this bot's --profile (Bot1 = no --profile).
#
# Usage:
#   start-bot.ps1 -Bot bot1
#   start-bot.ps1 -Bot coding   -Profile coding-assistant-claude
#   start-bot.ps1 -Bot finance  -Profile finance-agent
#
# File layout under %TEMP% (one set per -Bot):
#   lark-<bot>-events.ndjson         stdout from subscribe (the event stream)
#   lark-<bot>-daemon.err.log        stderr (banner + SDK noise)
#   lark-<bot>.pid                   current daemon PID
#   lark-<bot>-monitor.offset        per-session Monitor read position

param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-zA-Z0-9_-]+$')]
    [string]$Bot,
    [string]$Profile = ''
)

$ErrorActionPreference = 'Stop'
$env:LARK_CLI_NO_PROXY = '1'   # B5: never let the bot secret transit a local proxy

$LogPath = "$env:TEMP\lark-$Bot-events.ndjson"
$ErrPath = "$env:TEMP\lark-$Bot-daemon.err.log"
$PidPath = "$env:TEMP\lark-$Bot.pid"
$LarkCli = "<USER_HOME>\AppData\Roaming\npm\node_modules\@larksuite\cli\scripts\run.js"

function Test-IsThisBotsSubscribe {
    param([string]$CmdLine)
    if ($CmdLine -notlike '*event*subscribe*') { return $false }
    if ($Profile) {
        return ($CmdLine -like "*--profile $Profile*")
    } else {
        # Bot1 = default config = no --profile flag
        return ($CmdLine -notlike '*--profile*')
    }
}

# 1. Healthy already?
if (Test-Path $PidPath) {
    $existingPid = (Get-Content $PidPath -ErrorAction SilentlyContinue) -as [int]
    if ($existingPid) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
        if ($proc -and (Test-IsThisBotsSubscribe -CmdLine $proc.CommandLine)) {
            Write-Host "[daemon $Bot] already running PID=$existingPid"
            exit 0
        }
    }
}

# 2. Kill orphan subscribers for THIS bot (don't touch other bots)
$orphans = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { Test-IsThisBotsSubscribe -CmdLine $_.CommandLine }
foreach ($o in $orphans) {
    Write-Host "[daemon $Bot] killing orphan PID=$($o.ProcessId)"
    Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($orphans) { Start-Sleep -Seconds 3 }   # service-side connection cooldown

# 3. Spawn fresh detached daemon
$cliArgs = @(
    $LarkCli,
    'event', '+subscribe',
    '--event-types', 'im.message.receive_v1',
    '--compact',
    '--as', 'bot',
    '--force'
)
if ($Profile) {
    $cliArgs += @('--profile', $Profile)
}

$proc = Start-Process -FilePath 'node' `
    -ArgumentList $cliArgs `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogPath `
    -RedirectStandardError $ErrPath `
    -PassThru

if (-not $proc) {
    Write-Host "[daemon $Bot] FAILED to start"
    exit 1
}

# Start-Process -RedirectStandardOutput TRUNCATES $LogPath. Any live Monitor's
# offset file now points past EOF — reset it so the next Monitor restart starts
# from 0 (a brief duplicate is acceptable; missing events is not).
$OffsetPath = "$env:TEMP\lark-$Bot-monitor.offset"
if (Test-Path $OffsetPath) { Remove-Item $OffsetPath -Force -ErrorAction SilentlyContinue }

$proc.Id | Out-File -FilePath $PidPath -Encoding ascii -NoNewline
Write-Host "[daemon $Bot] started PID=$($proc.Id) profile=$Profile"
Write-Host "[daemon $Bot] log: $LogPath"
Write-Host "[daemon $Bot] err: $ErrPath"
Write-Host "[daemon $Bot] pid: $PidPath"
