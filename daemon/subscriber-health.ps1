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
    # Legacy fallback only. Quiet chats and handler errors do not prove a loss.
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

function Get-LarkSocketHealth {
    param([string]$Path, $Process, [string]$Profile='', [bool]$Required=$true,
          [long]$NowMs=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()))
    $result=[ordered]@{signal='heartbeat_missing';verified=$false;needs_restart=$false;
        pong_age_seconds=$null;ping_interval_seconds=$null;pending_ping_age_seconds=$null;
        generation=$null;detection_bound_seconds=$null}
    if(-not $Process){$result.signal='process_missing';$result.needs_restart=$true;return [pscustomobject]$result}
    $created=0L
    try {$created=([DateTimeOffset]$Process.CreationDate).ToUnixTimeMilliseconds()} catch {}
    # Missing/invalid snapshots are allowed only during a bounded startup grace.
    $expired=($created -le 0 -or $NowMs-$created -gt 60000)
    $result.needs_restart=($Required -and $expired)
    $snapshot=$null
    try {
        $stream=[IO.File]::Open($Path,'Open','Read',([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        $reader=New-Object IO.StreamReader($stream,[Text.Encoding]::UTF8)
        try {$snapshot=$reader.ReadToEnd() | ConvertFrom-Json} finally {$reader.Dispose();$stream.Dispose()}
    } catch {return [pscustomobject]$result}
    if($snapshot.schema -ne 1 -or $snapshot.pid -ne $Process.ProcessId -or
       [string]$snapshot.profile -cne $Profile -or $created -le 0 -or
       [math]::Abs([long]$snapshot.started_at_ms-$created) -gt 10000 -or
       $snapshot.updated_at_ms -gt $NowMs+1000 -or $snapshot.started_at_ms -gt $NowMs+1000 -or
       $snapshot.last_pong_at_ms -gt $NowMs+1000 -or $snapshot.ping_interval_ms -lt 1000 -or
       $snapshot.ping_interval_ms -gt 3600000){
        $result.signal='heartbeat_identity_invalid';return [pscustomobject]$result
    }
    $interval=[long]$snapshot.ping_interval_ms
    $freshness=$interval*2+30000
    $result.ping_interval_seconds=$interval/1000
    $result.generation=$snapshot.generation
    # Includes the scheduled supervisor's one-minute polling interval.
    $result.detection_bound_seconds=($freshness+60000)/1000
    if($snapshot.last_pong_at_ms -gt 0){$result.pong_age_seconds=[math]::Round(($NowMs-$snapshot.last_pong_at_ms)/1000,1)}
    if($snapshot.pending_ping_since_ms -gt 0){$result.pending_ping_age_seconds=[math]::Round(($NowMs-$snapshot.pending_ping_since_ms)/1000,1)}
    $result.needs_restart=$false
    $result.signal=[string]$snapshot.state
    if($snapshot.recovering_since_ms -gt 0){
        $result.needs_restart=($NowMs-$snapshot.recovering_since_ms -gt 60000)
    } elseif($snapshot.pending_ping_since_ms -gt 0 -and $NowMs-$snapshot.pending_ping_since_ms -gt 30000){
        $result.signal='pong_timeout';$result.needs_restart=$true
    } elseif($snapshot.last_pong_at_ms -gt 0 -and $NowMs-$snapshot.last_pong_at_ms -gt $freshness){
        $result.signal='heartbeat_stale';$result.needs_restart=$true
    } elseif($snapshot.last_pong_at_ms -le 0){
        # The SDK's ping goroutine can be sleeping through a reconnect.
        $since=if($snapshot.unverified_since_ms -gt 0){$snapshot.unverified_since_ms}elseif($snapshot.connected_at_ms -gt 0){$snapshot.connected_at_ms}else{$snapshot.started_at_ms}
        $result.needs_restart=($NowMs-$since -gt $interval+30000)
        if($result.needs_restart){$result.signal='first_pong_timeout'}
    } else {
        $result.verified=($snapshot.state -eq 'connected' -and $snapshot.connected_at_ms -gt 0)
    }
    return [pscustomobject]$result
}
