# Windows：クライアント（bun）だけを止める。タスクのラッパー（run-client.ps1）が10秒後に起動し直す。git pull と bun install のあとに使う
# 実行: powershell -NoProfile -ExecutionPolicy Bypass -File autostart\windows\restart.ps1
# 注意：このクライアントが起動した rc と対話セッション（start_session）も一緒に終わる
$ErrorActionPreference = "Continue"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Main = Join-Path $Root "client\main.ts"
# パスは大文字小文字を区別せずに比べる（打ち方が登録時と違っても見つけられるように）
$Key = $Main.ToLowerInvariant()
$Clients = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($Key) -and -not $_.CommandLine.Contains("run-client.ps1") })
if ($Clients.Count -eq 0) {
  # ラッパーが動いていなければタスクを起動する（動いていて起動し直しを待っているところなら、何も起きない）
  Start-ScheduledTask -TaskName "cc-remote-mcp" -ErrorAction SilentlyContinue
  Write-Host "クライアントが動いていなかったので、タスクを起動した。ログ: $env:LOCALAPPDATA\cc-remote-mcp\client.log"
} else {
  # taskkill /T で子（対話セッションの claude.exe など）ごと止める。Stop-Process だと子が残ることがある
  $Clients | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F | Out-Null }
  Write-Host "クライアントを止めた。10秒ほどでラッパーが起動し直す。ログ: $env:LOCALAPPDATA\cc-remote-mcp\client.log"
}
