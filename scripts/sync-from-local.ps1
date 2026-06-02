# Sync the Feishu/Lark Claude Code bridge from canonical local locations
# into this repo, sanitizing secrets via the per-host mapping file.
#
# Run from anywhere; the script resolves its own repo root:
#   powershell -ExecutionPolicy Bypass -File scripts/sync-from-local.ps1
#
# REQUIRED: $HOME\.lark-cli\sync-secrets.local.json must exist, with shape:
#   {
#     "replacements": [
#       {"from": "<live-secret-string>", "to": "<placeholder>"},
#       ...
#     ]
#   }
# This file is intentionally OUTSIDE the repo so the real values never get
# committed even if the sync script is. Without it, the script aborts.
#
# Source locations (overridable via env vars):
#   LARK_DAEMON_DIR   default $HOME\.lark-cli\daemon
#   CLAUDE_HOME       default $HOME\.claude
#   VAULT_GUIDE_PATH  default $HOME\Documents\knowledge-vault\wiki\sources\工作流与工具\Feishu CLI Integration Guide.md
#   SECRETS_MAP       default $HOME\.lark-cli\sync-secrets.local.json
#
# Files explicitly EXCLUDED from sync:
#   binding-*.json      per-session runtime, contains live claude PID + chat
#   *.log *.ndjson      runtime streams
#   *.offset *.pid *.last  runtime state

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-RepoRoot {
    $scriptDir = Split-Path -Parent $PSCommandPath
    return (Resolve-Path (Join-Path $scriptDir '..')).Path
}

$RepoRoot   = Resolve-RepoRoot
$LarkDaemon = if ($env:LARK_DAEMON_DIR)  { $env:LARK_DAEMON_DIR }  else { Join-Path $HOME '.lark-cli\daemon' }
$ClaudeHome = if ($env:CLAUDE_HOME)      { $env:CLAUDE_HOME }      else { Join-Path $HOME '.claude' }
$VaultGuide = if ($env:VAULT_GUIDE_PATH) { $env:VAULT_GUIDE_PATH } else { Join-Path $HOME 'Documents\knowledge-vault\wiki\sources\工作流与工具\Feishu CLI Integration Guide.md' }
$SecretsMap = if ($env:SECRETS_MAP)      { $env:SECRETS_MAP }      else { Join-Path $HOME '.lark-cli\sync-secrets.local.json' }

Write-Host "Repo:         $RepoRoot"
Write-Host "Lark daemon:  $LarkDaemon"
Write-Host "Claude home:  $ClaudeHome"
Write-Host "Vault guide:  $VaultGuide"
Write-Host "Secrets map:  $SecretsMap"
Write-Host ""

if (-not (Test-Path -LiteralPath $SecretsMap)) {
    Write-Host "ERROR: secrets map missing at $SecretsMap" -ForegroundColor Red
    Write-Host "Create it with shape: { replacements: [ { from, to }, ... ] }"
    Write-Host "See README.md > 'Per-host secrets mapping' for details."
    exit 2
}

$raw = Get-Content -LiteralPath $SecretsMap -Raw -Encoding utf8
$map = $raw | ConvertFrom-Json
if (-not $map.replacements -or $map.replacements.Count -eq 0) {
    Write-Host "ERROR: secrets map has no replacements" -ForegroundColor Red
    exit 2
}
$pairs = @($map.replacements | ForEach-Object { @{ From = $_.from; To = $_.to } })
Write-Host "Loaded $($pairs.Count) replacement rules from secrets map." -ForegroundColor Cyan
Write-Host ""

function Invoke-Sanitize {
    param([string]$Text)
    foreach ($p in $pairs) { $Text = $Text.Replace($p.From, $p.To) }
    return $Text
}

function Copy-Sanitized {
    param([string]$From, [string]$To)
    if (-not (Test-Path -LiteralPath $From)) {
        Write-Host "  skip (missing): $From"
        return $false
    }
    $text = Get-Content -LiteralPath $From -Raw -Encoding utf8
    $clean = Invoke-Sanitize $text
    $dir = Split-Path -Parent $To
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($To, $clean, [System.Text.UTF8Encoding]::new($false))
    $rel = $To.Substring($RepoRoot.Length).TrimStart('\', '/')
    Write-Host "  copied: $rel"
    return $true
}

$Files = [ordered]@{
    # parametrized daemon scripts (v4 post-2026-05-23)
    "$LarkDaemon\start-bot.ps1"         = 'daemon\start-bot.ps1'
    "$LarkDaemon\ensure-bot.ps1"        = 'daemon\ensure-bot.ps1'
    "$LarkDaemon\monitor-bot.sh"        = 'daemon\monitor-bot.sh'
    "$LarkDaemon\write-binding.ps1"     = 'daemon\write-binding.ps1'

    # backward-compat shims (call parametrized scripts with -Bot bot1)
    "$LarkDaemon\start-bot1.ps1"        = 'daemon\start-bot1.shim.ps1'
    "$LarkDaemon\ensure-bot1.ps1"       = 'daemon\ensure-bot1.shim.ps1'
    "$LarkDaemon\monitor-bot1.sh"       = 'daemon\monitor-bot1.shim.sh'

    # compact orchestration helpers
    "$LarkDaemon\find-claude.ps1"       = 'daemon\find-claude.ps1'
    "$LarkDaemon\screenshot-window.ps1" = 'daemon\screenshot-window.ps1'
    "$LarkDaemon\send-keys.ps1"         = 'daemon\send-keys.ps1'

    # router / notifier
    "$LarkDaemon\notify-once.ps1"       = 'daemon\notify-once.ps1'
    "$LarkDaemon\bot-registry.json"     = 'daemon\bot-registry.example.json'

    # 7-fix plan doc (committed for posterity)
    "$LarkDaemon\PLAN.md"               = 'daemon\PLAN.md'

    # Claude Code config
    "$ClaudeHome\CLAUDE.md"             = 'claude-config\CLAUDE.md'

    # compact model-switch hooks (general harness; referenced by Pre/PostCompact
    # in settings.hooks.example.json — bundled so a fresh clone is not dangling)
    "$ClaudeHome\scripts\pre-compact-model-switch.py"   = 'claude-config\scripts\pre-compact-model-switch.py'
    "$ClaudeHome\scripts\post-compact-model-restore.py" = 'claude-config\scripts\post-compact-model-restore.py'

    # vault note
    "$VaultGuide"                       = 'docs\integration-guide.md'
}

Write-Host "Syncing files (sanitized)..." -ForegroundColor Cyan
$count = 0
foreach ($pair in $Files.GetEnumerator()) {
    $target = Join-Path $RepoRoot $pair.Value
    if (Copy-Sanitized -From $pair.Key -To $target) { $count++ }
}

# settings.json: extract only hooks section to keep things minimal
$settingsSrc = Join-Path $ClaudeHome 'settings.json'
$settingsDst = Join-Path $RepoRoot 'claude-config\settings.hooks.example.json'
if (Test-Path -LiteralPath $settingsSrc) {
    try {
        $full = Get-Content -LiteralPath $settingsSrc -Raw -Encoding utf8 | ConvertFrom-Json
        $hookOnly = [pscustomobject]@{ hooks = $full.hooks }
        $json = ($hookOnly | ConvertTo-Json -Depth 20)
        $clean = Invoke-Sanitize $json
        [System.IO.File]::WriteAllText($settingsDst, $clean, [System.Text.UTF8Encoding]::new($false))
        Write-Host "  copied: claude-config\settings.hooks.example.json (hooks only, sanitized)"
        $count++
    } catch {
        Write-Host "  skip settings.json: $($_.Exception.Message)"
    }
}

Write-Host ""
Write-Host "Sync complete: $count file(s) written." -ForegroundColor Green

# Leak guard: scan for known live tokens in the output. Bail loud if any leak.
$tokens = @($pairs | Where-Object { $_.From -match '^(cli_|oc_|ou_)' } | ForEach-Object { $_.From })
if ($tokens.Count -gt 0) {
    $leaked = @()
    Get-ChildItem -Path $RepoRoot -Recurse -File -Exclude '.git' |
        Where-Object { $_.FullName -notmatch '\\\.git\\' } |
        ForEach-Object {
            $content = Get-Content -LiteralPath $_.FullName -Raw -Encoding utf8 -ErrorAction SilentlyContinue
            if ($null -eq $content) { return }
            foreach ($t in $tokens) {
                if ($content.Contains($t)) {
                    $leaked += [pscustomobject]@{ File = $_.FullName; Token = $t.Substring(0, [Math]::Min(12, $t.Length)) + '...' }
                }
            }
        }
    if ($leaked.Count -gt 0) {
        Write-Host ""
        Write-Host "LEAK GUARD: detected un-sanitized tokens. Add a replacement rule and re-run." -ForegroundColor Red
        $leaked | Format-Table -AutoSize
        exit 3
    } else {
        Write-Host "Leak guard: clean (no live tokens in repo)." -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Next: cd $RepoRoot && git diff && git commit -am '...' && git push"
