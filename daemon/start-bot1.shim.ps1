# Backward-compat shim. Use start-bot.ps1 -Bot bot1 directly.
$script = Join-Path $PSScriptRoot 'start-bot.ps1'
& powershell -ExecutionPolicy Bypass -File $script -Bot bot1 @args
exit $LASTEXITCODE
