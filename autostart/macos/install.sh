#!/bin/sh
# macOS：ログイン時に cc-remote-mcp クライアントを起動する LaunchAgent を登録する（落ちたら launchd が再起動する）
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LABEL=io.github.stella2211.cc-remote-mcp
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/cc-remote-mcp"
BUN=$(command -v bun) || { echo "bun が見つからない。先に bun を入れる" >&2; exit 1; }
[ -f "$ROOT/client/.env" ] || { echo "client/.env が無い。先に bun run device init <端末名> と設定を済ませる" >&2; exit 1; }

esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
# launchd の PATH は最小限なので、今のシェルの PATH を引き継ぐ（claude を見つけるため）
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(esc "$BUN")</string>
    <string>run</string>
    <string>$(esc "$ROOT/client/main.ts")</string>
  </array>
  <key>WorkingDirectory</key><string>$(esc "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(esc "$PATH")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(esc "$LOG_DIR/client.log")</string>
  <key>StandardErrorPath</key><string>$(esc "$LOG_DIR/client.log")</string>
</dict>
</plist>
PLIST
chmod 644 "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout は非同期で終わるので、登録できるまで少し待ってやり直す
i=0
until launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -ge 10 ] && { echo "launchctl bootstrap に失敗した。少し待ってからもう一度実行する" >&2; exit 1; }
  sleep 1
done
echo "登録した。ログ: $LOG_DIR/client.log"
echo "~/Documents や ~/Desktop の下を ALLOWED_ROOTS にするなら、システム設定の「フルディスクアクセス」に bun を追加する（launchd から起動した bun はそこを読めないことがある）"
