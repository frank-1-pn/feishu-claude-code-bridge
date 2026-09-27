function Test-LarkSubscriber {
    param($Process, [string]$Profile)
    if (-not $Process -or $Process.Name -notin @('node.exe','lark-cli.exe')) { return $false }
    $cmd = [string]$Process.CommandLine
    if ($cmd -notmatch '(?:^|\s)event\s+\+subscribe(?:\s|$)') { return $false }
    if ($Process.Name -eq 'node.exe' -and $cmd -notmatch '[\\/]@larksuite[\\/]cli[\\/]scripts[\\/]run\.js') { return $false }
    $match = [regex]::Match($cmd, '(?:^|\s)--profile(?:=|\s+)(?:"([^"]+)"|([^\s]+))')
    if (-not $Profile) { return -not $match.Success }
    if (-not $match.Success) { return $false }
    $actual = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    return $actual -ceq $Profile
}

function Get-LarkSocketSignal {
    param([string]$Path)
    # No structured socket heartbeat exists in this CLI. A quiet chat or generic
    # event-handler error is NOT evidence of disconnect.
    if (-not (Test-Path -LiteralPath $Path)) { return 'unknown' }
    try {
        $stream=[IO.File]::Open($Path,'Open','Read',([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            $null=$stream.Seek([Math]::Max(0,$stream.Length-65536),[IO.SeekOrigin]::Begin)
            $reader=New-Object IO.StreamReader($stream,[Text.Encoding]::UTF8)
            $tail=$reader.ReadToEnd()
        } finally { $stream.Dispose() }
        $signal='unknown'
        foreach($line in ($tail -split "`n")) {
            if($line -match 'bridge-subscriber-start|ws.*\bconnected\b|connect(ed)? (to server )?success|ws client ready') {$signal='connected_or_starting'}
            if($line -match 'reconnect exhausted|unable to connect to the server after trying|autoReconnect is disabled') {$signal='reconnect_exhausted'}
        }
        return $signal
    } catch { return 'unknown' }
}
