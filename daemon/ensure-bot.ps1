[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$Bot,[string]$Profile='', [switch]$SkipSessionBinding)
$ErrorActionPreference='Stop'
$env:LARK_CLI_NO_PROXY='1'
. (Join-Path $PSScriptRoot 'subscriber-health.ps1')
. (Join-Path $PSScriptRoot 'invoke-bounded-script.ps1')
$pidPath=Join-Path $env:TEMP "lark-$Bot.pid"
$errPath=Join-Path $env:TEMP "lark-$Bot-daemon.err.log"
$current=0
if(Test-Path -LiteralPath $pidPath){$current=([IO.File]::ReadAllText($pidPath).Trim()) -as [int]}
$proc=if($current){Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue}else{$null}
$healthy=Test-LarkSubscriber $proc $Profile
if($healthy -and (Get-LarkSocketSignal $errPath) -eq 'reconnect_exhausted'){
    # Exact process/profile check; unread events and all offsets stay intact.
    & taskkill.exe /PID $current /T /F | Out-Null
    if($LASTEXITCODE -ne 0){exit 1}
    $healthy=$false
}
if(-not $healthy){
    $argsList=@('-Bot',$Bot);if($Profile){$argsList+=@('-Profile',$Profile)}
    $result=Invoke-BoundedScript -ScriptPath (Join-Path $PSScriptRoot 'start-bot.ps1') -ScriptArguments $argsList -TimeoutSeconds 20
    try {if($result.ExitCode -ne 0){exit 1}}
    finally {Remove-Item -LiteralPath $result.OutputPath,$result.ErrorPath -Force -ErrorAction SilentlyContinue}
}
if(-not $SkipSessionBinding){
    $bindingScript=Join-Path $PSScriptRoot 'write-binding.ps1'
    if(Test-Path -LiteralPath $bindingScript){
        $argsList=@('-Bot',$Bot);if($Profile){$argsList+=@('-Profile',$Profile)}
        $result=Invoke-BoundedScript -ScriptPath $bindingScript -ScriptArguments $argsList -TimeoutSeconds 10
        Remove-Item -LiteralPath $result.OutputPath,$result.ErrorPath -Force -ErrorAction SilentlyContinue
    }
}
Write-Output "subscriber checked: $Bot; append stream and offsets preserved"
