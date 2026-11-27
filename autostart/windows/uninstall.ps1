# Windows：タスクを外し、動いているクライアントを止める
$ErrorActionPreference = "Continue"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Stop-ScheduledTask -TaskName "cc-remote-mcp" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "cc-remote-mcp" -Confirm:$false -ErrorAction SilentlyContinue
# タスクを止めてもラッパーの子の bun は残るので、コマンドラインで見分けて止める
# taskkill /T /F で子（rc や対話セッションの claude.exe など）ごと止める。Stop-Process だと子が残る。
# 先に止めた親の子はもういないことがあり、taskkill が失敗するのは正常なので、出力は捨てる
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Root) -and ($_.CommandLine.Contains("run-client.ps1") -or $_.CommandLine.Contains("main.ts")) } |
  ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F 2>&1 | Out-Null }
Write-Host "外した。クライアントと、それが起動した rc・対話セッションも子ごと止めた。"
