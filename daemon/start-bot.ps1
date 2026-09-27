[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$Bot,[string]$Profile='')
$ErrorActionPreference='Stop'
$env:LARK_CLI_NO_PROXY='1'
. (Join-Path $PSScriptRoot 'subscriber-health.ps1')
$pidPath=Join-Path $env:TEMP "lark-$Bot.pid"
$logPath=Join-Path $env:TEMP "lark-$Bot-events.ndjson"
$errPath=Join-Path $env:TEMP "lark-$Bot-daemon.err.log"
$binary=Join-Path $env:APPDATA 'npm/node_modules/@larksuite/cli/bin/lark-cli.exe'
$runtimePath=Join-Path $PSScriptRoot 'subscriber-runtime.json'
if(Test-Path -LiteralPath $runtimePath){
    $runtime=Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $binary=Join-Path $PSScriptRoot 'bin/lark-cli.exe'
    if((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ine $runtime.binary_sha256){throw 'subscriber binary hash mismatch'}
}
$healthPath=Join-Path $env:TEMP "lark-$Bot-ws-health.json"
# Keep the CLI per-app singleton lock; never use --force.
$mutex=New-Object Threading.Mutex($false,"Global\LarkSubscriber-$Bot")
$owned=$false
try {
    try {$owned=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$owned=$true}
    if(-not $owned){exit 1}
    $existing=0
    if(Test-Path -LiteralPath $pidPath){$existing=([IO.File]::ReadAllText($pidPath).Trim()) -as [int]}
    if($existing){
        $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$existing" -ErrorAction SilentlyContinue
        if(Test-LarkSubscriber $proc $Profile){Write-Output "subscriber already running PID=$existing";exit 0}
    }
    $candidates=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='lark-cli.exe'" | Where-Object {Test-LarkSubscriber $_ $Profile})
    # The older node launcher has one native child: adopt the parent.
    $roots=@($candidates | Where-Object {$_.ParentProcessId -notin @($candidates.ProcessId)})
    if($roots.Count -gt 1){throw 'multiple subscribers for profile; preserve for inspection'}
    if($roots.Count -eq 1){[IO.File]::WriteAllText($pidPath,[string]$roots[0].ProcessId);Write-Output 'adopted existing subscriber';exit 0}
    $networkProbe=Join-Path $PSScriptRoot "state/network-probe-$Bot.json"
    & node (Join-Path $PSScriptRoot 'start-lark-append.mjs') $binary $logPath $errPath $pidPath $healthPath $networkProbe $Profile
    if($LASTEXITCODE -ne 0){exit 1}
    Start-Sleep -Milliseconds 750
    $started=[int]([IO.File]::ReadAllText($pidPath).Trim())
    $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$started" -ErrorAction SilentlyContinue
    if(-not (Test-LarkSubscriber $proc $Profile)){throw 'subscriber exited during startup'}
} finally {if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()}
