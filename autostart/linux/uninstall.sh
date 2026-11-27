#!/bin/sh
# Linux：ユーザーサービスを外す（クライアントが起動した rc も止まる）
set -eu
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/cc-remote-mcp.service"
systemctl --user disable --now cc-remote-mcp.service 2>/dev/null || true
rm -f "$UNIT"
systemctl --user daemon-reload
echo "外した。"
