# Update the existing task, retaining its principal and one-minute recovery.
[CmdletBinding()]
param([string]$TaskName = 'FeishuBotWatchdog')
$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName
$launcher=Join-Path $PSScriptRoot 'run-watchdog-hidden.vbs'
if(-not (Test-Path -LiteralPath $launcher)){throw 'Hidden watchdog launcher missing'}
$action=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32/wscript.exe') -Argument ('//B //NoLogo "'+$launcher+'"') -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$null = Set-ScheduledTask -TaskName $TaskName -TaskPath $task.TaskPath -Action $action -Trigger $trigger -Settings $settings
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
