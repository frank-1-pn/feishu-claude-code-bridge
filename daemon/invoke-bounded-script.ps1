# Run a short-lived supervisor, never wait for inherited stdout pipe EOF.
# Timeout terminates only the wrapper we own, never its daemon descendants.
function Invoke-BoundedScript {
    param(
        [Parameter(Mandatory=$true)][string]$ScriptPath,
        [string[]]$ScriptArguments = @(),
        [ValidateRange(1,120)][int]$TimeoutSeconds = 45
    )
    $runId = [guid]::NewGuid().ToString('N')
    $outPath = Join-Path $env:TEMP "lark-supervisor-$runId.out.log"
    $errPath = Join-Path $env:TEMP "lark-supervisor-$runId.err.log"
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $ScriptArguments
    $quoted = @($arguments | ForEach-Object {
        if ($_ -match '["\r\n]') { throw 'Unsupported argument characters' }
        '"' + $_ + '"'
    })
    $child = Start-Process -FilePath "$PSHOME/powershell.exe" -ArgumentList $quoted -WindowStyle Hidden -RedirectStandardOutput $outPath -RedirectStandardError $errPath -PassThru
    # Cache the handle before exit (Windows PowerShell otherwise loses ExitCode).
    $null = $child.Handle
    $finished = $child.WaitForExit($TimeoutSeconds * 1000)
    if (-not $finished) {
        $child.Kill()
        $null = $child.WaitForExit(2000)
    }
    $child.Refresh()
    $code = if ($finished) { $child.ExitCode } else { 124 }
    [pscustomobject]@{ ExitCode=$code; TimedOut=(-not $finished); OutputPath=$outPath; ErrorPath=$errPath }
    $child.Dispose()
}
