# Rate-limited, bot-aware Feishu notifier for Claude Code hooks.
# Prevents bombardment if the calling hook re-fires in a tight loop, and
# routes the notification to the correct feishu bot for the current session.
#
# Usage:
#   # Explicit bot:
#   notify-once.ps1 -ChatId <oc_xxx> [-Profile <name>] -Text <msg> [-Tag <key>] [-MinIntervalSec 30]
#
#   # Auto-resolve bot from current session (preferred for global hooks):
#   notify-once.ps1 -AutoBot -Text <msg> [-Tag <key>] [-MinIntervalSec 30]
#
# Auto-resolution order:
#   1. Walk parent process chain to find claude.exe; if
#      ~/.lark-cli/daemon/binding-<claude_pid>.json exists, use it.
#   2. Look up ~/.lark-cli/daemon/bot-registry.json by $env:CLAUDE_PROJECT_DIR
#      (fallback Get-Location) substring match.
#   3. Fall back to registry.default (Bot1).
param(
    [string]$ChatId,
    [string]$Profile = '',
    [switch]$AutoBot,
    [Parameter(Mandatory = $true)][string]$Text,
    [string]$Tag = 'default',
    [int]$MinIntervalSec = 30
)

$ErrorActionPreference = 'SilentlyContinue'
$env:PATH = $env:PATH + ';<USER_HOME>\AppData\Roaming\npm'
$env:LARK_CLI_NO_PROXY = '1'

$daemonDir = "$env:USERPROFILE\.lark-cli\daemon"
$logDir = "$env:USERPROFILE\.lark-cli\logs"
$null = New-Item -ItemType Directory -Path $logDir -Force
$log = Join-Path $logDir 'notify-once.log'

function Write-Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [pid=$PID tag=$Tag] $msg" |
        Out-File -FilePath $log -Append -Encoding utf8
}

function Find-ClaudePid {
    $cur = $PID
    $hops = 0
    while ($cur -and $cur -ne 0 -and $hops -lt 10) {
        $hops++
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
        if (-not $proc) { return $null }
        if ($proc.Name -like 'claude*') { return $proc.ProcessId }
        if ($proc.ParentProcessId -eq $cur -or $proc.ParentProcessId -eq 0) { return $null }
        $cur = $proc.ParentProcessId
    }
    return $null
}

function Resolve-Bot {
    # 1. Per-session binding file
    $claudePid = Find-ClaudePid
    if ($claudePid) {
        $bindingFile = Join-Path $daemonDir "binding-$claudePid.json"
        if (Test-Path $bindingFile) {
            try {
                $b = Get-Content -LiteralPath $bindingFile -Raw -Encoding utf8 | ConvertFrom-Json
                if ($b.chat_id) {
                    return @{ChatId = $b.chat_id; Profile = $b.profile; Source = "binding-$claudePid"; Alias = $b.alias}
                }
            } catch { Write-Log "binding read err: $($_.Exception.Message)" }
        }
    }
    # 2. Project-dir registry match
    $registry = Join-Path $daemonDir 'bot-registry.json'
    $dir = $env:CLAUDE_PROJECT_DIR
    if (-not $dir) { $dir = (Get-Location).Path }
    $dirLower = $dir.ToString().ToLower()
    if (Test-Path $registry) {
        try {
            $reg = Get-Content -LiteralPath $registry -Raw -Encoding utf8 | ConvertFrom-Json
            foreach ($p in $reg.projects) {
                if ($dirLower.Contains($p.match_dir_contains.ToLower())) {
                    return @{ChatId = $p.chat_id; Profile = $p.profile; Source = "registry/$($p.match_dir_contains)"; Alias = $p.alias}
                }
            }
            if ($reg.default) {
                return @{ChatId = $reg.default.chat_id; Profile = $reg.default.profile; Source = 'registry/default'; Alias = $reg.default.alias}
            }
        } catch { Write-Log "registry read err: $($_.Exception.Message)" }
    }
    # 3. Last-resort hardcoded Bot1
    return @{ChatId = '<CHAT_ID_BOT_PRIMARY>'; Profile = ''; Source = 'hardcoded'; Alias = 'Bot1 fallback'}
}

if ($AutoBot) {
    $bot = Resolve-Bot
    $ChatId = $bot.ChatId
    $Profile = $bot.Profile
    Write-Log "auto-bot resolved: chat=$ChatId profile=$Profile via=$($bot.Source)"
}

if (-not $ChatId) {
    Write-Log 'abort: no chat-id (neither explicit nor auto-resolved)'
    exit 1
}

# Dedup window keyed by chat_id + tag
$lockDir = "$env:TEMP\lark-notify-once"
$null = New-Item -ItemType Directory -Path $lockDir -Force
$safeChat = $ChatId -replace '[^A-Za-z0-9_]', '_'
$safeTag = $Tag -replace '[^A-Za-z0-9_]', '_'
$lockFile = "$lockDir\$safeChat.$safeTag.last"

$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
if (Test-Path $lockFile) {
    $last = [int64](Get-Content -LiteralPath $lockFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($null -ne $last -and ($now - $last) -lt $MinIntervalSec) {
        Write-Log "skip dedup: delta=$($now - $last)s < $MinIntervalSec s chat=$ChatId"
        exit 0
    }
}
Set-Content -LiteralPath $lockFile -Value $now -Encoding ASCII

$cliArgs = @('im', '+messages-send', '--chat-id', $ChatId, '--text', $Text, '--as', 'bot')
if ($Profile) { $cliArgs = @('--profile', $Profile) + $cliArgs }
& lark-cli @cliArgs 2>&1 | Out-Null
Write-Log "sent: chat=$ChatId profile=$Profile text=$($Text.Substring(0, [Math]::Min(60, $Text.Length)))"
exit 0
