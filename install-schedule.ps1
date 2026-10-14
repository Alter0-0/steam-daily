$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction Stop).Source
$collector = Join-Path $project 'collector.mjs'
$server = Join-Path $project 'server.mjs'
$serverLoop = Join-Path $project 'server-loop.cmd'
$runner = Join-Path $project 'run-collector.cmd'
$taskRun = 'cmd.exe /d /c ""' + $runner + '""'
& schtasks.exe /Create /TN 'SteamDailyCollector' /TR $taskRun /SC DAILY /ST 04:00 /F /HRESULT | Out-Null
if ($LASTEXITCODE -ne 0) { throw "无法更新 SteamDailyCollector 任务，错误码：$LASTEXITCODE" }
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -RestartCount 8 -RestartInterval (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
Set-ScheduledTask -TaskName 'SteamDailyCollector' -Settings $settings | Out-Null
$hiddenRunner = Join-Path $project 'scheduled-collector.ps1'
$hiddenAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $hiddenRunner + '" -NodePath "' + $node + '"') -WorkingDirectory $project
Set-ScheduledTask -TaskName 'SteamDailyCollector' -Action $hiddenAction | Out-Null
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'SteamDailyServer.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $serverLoop
$shortcut.Arguments = ''
$shortcut.WorkingDirectory = $project
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Host 'SteamDailyCollector installed; it runs daily at 04:00 and retries failed runs every 30 minutes.'
Write-Host 'SteamDailyServer added to the current user Startup folder.'
Write-Host 'Open http://127.0.0.1:4173/steam-daily.html'
