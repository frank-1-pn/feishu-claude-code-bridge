' wscript.exe is a GUI host: no console is allocated for the task entrypoint.
' Wait for completion so Task Scheduler retains overlap control and exit status.
Option Explicit
Dim shell, files, script, powershell, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
script = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "feishu-watchdog.ps1")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
If Not files.FileExists(script) Then WScript.Quit 2
command = Chr(34) & powershell & Chr(34) & " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & script & Chr(34)
result = shell.Run(command, 0, True)
WScript.Quit result
