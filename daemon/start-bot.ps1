# lark-cli daemon for Bot1 (<APP_ID_BOT_PRIMARY>)
# Independent of any Claude session - survives /compact, session restart, etc.
# Writes NDJSON events to %TEMP%\lark-bot1-events.ndjson

$ErrorActionPreference = "Stop"

$LogPath = "$env:TEMP\lark-bot1-events.ndjson"
$ErrPath = "$env:TEMP\lark-bot1-daemon.err.log"
$PidPath = "$env:TEMP\lark-bot1.pid"
$LarkCli = "<USER_HOME>\AppData\Roaming\npm\node_modules\@larksuite\cli\scripts\run.js"

# 1. Check if daemon already running and healthy
if (Test-Path $PidPath) {
    $existingPid = (Get-Content $PidPath -ErrorAction SilentlyContinue) -as [int]
    if ($existingPid) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
        if ($proc -and $proc.CommandLine -like "*event*subscribe*" -and $proc.CommandLine -notlike "*--profile*") {
            Write-Host "[daemon] already running PID=$existingPid"
            exit 0
        }
    }
}

# 2. Kill any orphan Bot1 subscribers (no --profile = Bot1 default config)
$orphans = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*event*subscribe*' -and $_.CommandLine -notlike '*--profile*' }
foreach ($o in $orphans) {
    Write-Host "[daemon] killing orphan PID=$($o.ProcessId)"
    Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($orphans) { Start-Sleep -Seconds 3 }

# 3. Start fresh daemon: node lark-cli event +subscribe ... --force
$args = @(
    $LarkCli,
    "event",
    "+subscribe",
    "--event-types", "im.message.receive_v1",
    "--compact",
    "--as", "bot",
    "--force"
)

$proc = Start-Process -FilePath "node" `
    -ArgumentList $args `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogPath `
    -RedirectStandardError $ErrPath `
    -PassThru

if (-not $proc) {
    Write-Host "[daemon] FAILED to start"
    exit 1
}

$proc.Id | Out-File -FilePath $PidPath -Encoding ascii -NoNewline
Write-Host "[daemon] started PID=$($proc.Id)"
Write-Host "[daemon] log: $LogPath"
Write-Host "[daemon] err: $ErrPath"
Write-Host "[daemon] pid: $PidPath"
