#!/bin/sh
# macOS：LaunchAgent を外す（クライアントが起動した rc も止まる）
set -eu
LABEL=io.github.stella2211.cc-remote-mcp
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "外した。"
