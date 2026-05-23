# Write per-session bot binding file for notify-once.ps1 -AutoBot routing.
# Walks parent process chain to find claude.exe, looks up bot config (from
# explicit args or bot-registry.json), writes binding-<claude_pid>.json.
#
# Usage:
#   write-binding.ps1 -Bot bot1
#       (looks up registry.default for chat_id/profile/alias)
#   write-binding.ps1 -Bot finance -ChatId oc_xxx -Profile finance-agent -Alias 'finance-agent'
#       (explicit; no registry lookup needed)
#
# Returns JSON: {ok, claude_pid, path, chat_id, profile, alias, source}

param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-zA-Z0-9_-]+$')]
    [string]$Bot,
    [string]$ChatId,
    [string]$Profile = '',
    [string]$Alias,
    [string]$MonitorTaskId = ''
)

$ErrorActionPreference = 'Stop'

$daemonDir  = "$env:USERPROFILE\.lark-cli\daemon"
$registry   = Join-Path $daemonDir 'bot-registry.json'

function Find-ClaudePid {
    $cur = $PID
    $hops = 0
    while ($cur -and $cur -ne 0 -and $hops -lt 15) {
        $hops++
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
        if (-not $p) { return $null }
        if ($p.Name -like 'claude*') { return $p.ProcessId }
        if ($p.ParentProcessId -eq 0 -or $p.ParentProcessId -eq $cur) { return $null }
        $cur = $p.ParentProcessId
    }
    return $null
}

function Resolve-FromRegistry {
    param([string]$BotName)
    if (-not (Test-Path $registry)) { return $null }
    try {
        $reg = Get-Content -LiteralPath $registry -Raw -Encoding utf8 | ConvertFrom-Json
    } catch { return $null }

    # Try optional 'bots' map first (forward-compat shape)
    if ($reg.PSObject.Properties.Name -contains 'bots') {
        $hit = $reg.bots.PSObject.Properties | Where-Object { $_.Name -eq $BotName }
        if ($hit) {
            $b = $hit.Value
            return @{ChatId = $b.chat_id; Profile = $b.profile; Alias = $b.alias; Source = "registry.bots.$BotName"}
        }
    }

    # Fall back: match against projects[] by bot name in alias, then default
    foreach ($p in $reg.projects) {
        if ($p.alias -eq $BotName -or $p.profile -eq $BotName) {
            return @{ChatId = $p.chat_id; Profile = $p.profile; Alias = $p.alias; Source = "registry.projects/$($p.match_dir_contains)"}
        }
    }
    if ($reg.default -and -not ($reg.default -is [string])) {
        return @{ChatId = $reg.default.chat_id; Profile = $reg.default.profile; Alias = $reg.default.alias; Source = 'registry.default'}
    }
    return $null
}

$claudePid = Find-ClaudePid
if (-not $claudePid) {
    @{ ok = $false; error = 'no_claude_in_parent_chain' } | ConvertTo-Json -Compress
    exit 2
}

# Decide chat_id / profile / alias
if (-not $ChatId) {
    $resolved = Resolve-FromRegistry -BotName $Bot
    if ($resolved) {
        $ChatId = $resolved.ChatId
        if (-not $PSBoundParameters.ContainsKey('Profile')) { $Profile = $resolved.Profile }
        if (-not $Alias) { $Alias = $resolved.Alias }
        $source = $resolved.Source
    }
}
if (-not $ChatId) {
    @{ ok = $false; error = 'no_chat_id'; message = "supply -ChatId or add '$Bot' to bot-registry.json" } | ConvertTo-Json -Compress
    exit 3
}
if (-not $Alias) { $Alias = $Bot }
if (-not $source) { $source = 'explicit-args' }

$path = Join-Path $daemonDir "binding-$claudePid.json"
$payload = [pscustomobject]@{
    claude_pid       = $claudePid
    bot              = $Bot
    bot_alias        = $Alias
    chat_id          = $ChatId
    profile          = $Profile
    bound_at         = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')
    monitor_task_id  = $MonitorTaskId
    source           = $source
}
$payload | ConvertTo-Json -Depth 5 | Out-File -FilePath $path -Encoding utf8 -NoNewline

@{
    ok = $true
    claude_pid = $claudePid
    path = $path
    chat_id = $ChatId
    profile = $Profile
    alias = $Alias
    source = $source
} | ConvertTo-Json -Compress
