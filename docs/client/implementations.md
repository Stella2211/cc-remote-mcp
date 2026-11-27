# クライアントの実装

| ファイル | 内容 |
| --- | --- |
| `client/main.ts` | 起動、`claude` と `tmux` の場所の解決（Windows の `.cmd` / `.bat` は拒否）、対話セッションのバックエンドの選択（tmux か疑似端末）、シグナルでの片付け |
| `client/config.ts` | `.env` の読み取り（`parseEnv`）、`buildConfig`、`realFs` |
| `client/paths.ts` | `validateShape`、`resolveDir`、`checkReal`、`listRoots`、`listSubdirs`、`fitName`、`isHome`、`ALWAYS_BLOCKED` |
| `client/actions.ts` | `handleRequest`：リクエストの検証と7操作への振り分け |
| `client/interactive.ts` | `InteractiveManager`（[interactive/](../interactive/implementations.md)） |
| `client/sessions.ts` | `SessionManager`（起動・停止・一覧）、`StartLock`（rc と対話セッションの起動の検査と登録を1つずつ通すロック。`main.ts` で1つ作って両方に渡す）、`defaultKill`、`childEnv`、`cleanLine`、`findSessionUrl` |
| `client/connection.ts` | `Link`（[link/](../link/README.md)） |
| `autostart/macos/` | LaunchAgent `io.github.stella2211.cc-remote-mcp`（RunAtLoad、KeepAlive。bootout が終わるまで bootstrap をやり直す） |
| `autostart/linux/` | `systemd --user` の `cc-remote-mcp.service`（Restart=always、KillMode=mixed） |
| `autostart/windows/` | タスク「cc-remote-mcp」（ログオン時）と、再起動とログ（`Start-Process` でファイルへ直接、起動ごとに1世代回す）を受け持つ `run-client.ps1`、bun を子ごと（`taskkill /T /F`）止めてラッパーに起動し直させる `restart.ps1`（更新のあとに使う）。どの `.ps1` も BOM 付き UTF-8（Windows PowerShell 5.1 は BOM なしだと ANSI で読み、日本語の文字列で構文エラーになる。`test/autostart.test.ts` で確認する） |

## テスト

- `test/paths.test.ts`：形の検査（POSIX / Windows）、`isWithin`、シンボリックリンクでの脱出、ブロック対象、`.` ディレクトリ、大文字小文字、一覧の絞り込みと上限（件数・バイト数・長すぎるパス・長い名前）、`isHome`。
- `test/actions.test.ts`：許可外の操作・余計な引数・禁止の権限モード・フラグに見える名前の拒否、方針外のパスで起動しないこと、ホームの拒否、実体パスでの起動。
- `test/sessions.test.ts`：固定の引数配列、URL の取得、早期終了、起動できない実行ファイル（セッションを残さず `spawn_failed`）、上限、同時に来た起動（同じディレクトリ・上限・起動失敗のあとの空き）、子に渡す環境変数、停止の段階（猶予後の強制終了、終了後のグループの片付け、止めている最中の再停止）。
- `test/config.test.ts`：`.env` の読み取り、必須項目と不正値の拒否。
