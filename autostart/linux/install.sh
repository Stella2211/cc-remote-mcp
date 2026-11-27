#!/bin/sh
# Linux：systemd のユーザーサービスとして登録する（ログイン時に起動、落ちたら再起動）。
# ログインしなくても OS 起動時に動かすには、一度だけ `sudo loginctl enable-linger "$USER"` を実行する
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/cc-remote-mcp.service"
BUN=$(command -v bun) || { echo "bun が見つからない。先に bun を入れる" >&2; exit 1; }
[ -f "$ROOT/client/.env" ] || { echo "client/.env が無い。先に bun run device init <端末名> と設定を済ませる" >&2; exit 1; }
case "$ROOT$BUN$PATH" in *'"'*|*'%'*|*'\'*) echo "パスに \" % \\ を含む場所には置けない" >&2; exit 1 ;; esac

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<UNIT
[Unit]
Description=cc-remote-mcp client (claude rc remote launcher)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart="$BUN" run "$ROOT/client/main.ts"
WorkingDirectory=$ROOT
Environment="PATH=$PATH"
Restart=always
RestartSec=10
# 本体にだけ SIGTERM を送る。本体が rc に Ctrl+C 相当を送って片付け、残りは最後に止める
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now cc-remote-mcp.service
echo "登録した。状態: systemctl --user status cc-remote-mcp / ログ: journalctl --user -u cc-remote-mcp -f"
