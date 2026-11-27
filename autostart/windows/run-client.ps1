# Windows：タスク スケジューラから起動されるラッパー。クライアントが終わったら10秒待って起動し直し、出力をログに残す
# 出力は Start-Process でファイルへ直接流す（PowerShell の *>> を通すと UTF-16 になり、実行中はファイルを切り替えられないため）
$ErrorActionPreference = "Continue"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$LogDir = Join-Path $env:LOCALAPPDATA "cc-remote-mcp"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Out = Join-Path $LogDir "client.log"
$Err = Join-Path $LogDir "client.err.log"
$Bun = (Get-Command bun -ErrorAction Stop).Source
# フルパスで渡す（uninstall.ps1 がコマンドラインの $Root で見分けるため）
$Main = Join-Path $Root "client\main.ts"

function Rotate([string]$Path) {
  # 起動のたびに前回の分を .1 に回す（1世代だけ残す）
  if (Test-Path $Path) { Move-Item -Force $Path "$Path.1" }
}

while ($true) {
  Rotate $Out
  Rotate $Err
  try {
    $p = Start-Process -FilePath $Bun -ArgumentList @("run", "`"$Main`"") -WorkingDirectory $Root `
      -NoNewWindow -PassThru -RedirectStandardOutput $Out -RedirectStandardError $Err
    $p.WaitForExit()
  } catch {
    Add-Content -Path (Join-Path $LogDir "wrapper.log") -Value "$(Get-Date -Format o) $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 10
}
