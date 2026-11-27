# Windows：ログオン時に cc-remote-mcp クライアントを起動するタスクを登録する。
# 実行: powershell -NoProfile -ExecutionPolicy Bypass -File autostart\windows\install.ps1
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw "bun が見つからない。先に bun を入れる" }
if (-not (Test-Path (Join-Path $Root "client\.env"))) { throw "client\.env が無い。先に bun run device init <端末名> と設定を済ませる" }

$Wrapper = Join-Path $PSScriptRoot "run-client.ps1"
$Action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Wrapper`"" `
  -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName "cc-remote-mcp" -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null
Start-ScheduledTask -TaskName "cc-remote-mcp"
Write-Host "登録した。ログ: $env:LOCALAPPDATA\cc-remote-mcp\client.log（エラー出力は client.err.log）"
