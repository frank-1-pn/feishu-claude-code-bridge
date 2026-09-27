# Update the existing scheduled task, preserving its principal and action.
[CmdletBinding()]
param([string]$TaskName = 'FeishuBotWatchdog')
$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$null = Set-ScheduledTask -TaskName $TaskName -TaskPath $task.TaskPath -Trigger $trigger -Settings $settings
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
