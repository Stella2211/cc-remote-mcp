# 対話セッションの実装

| ファイル | 内容 |
| --- | --- |
| `shared/protocol.ts` | `interactiveIdSchema`、`interactiveNameSchema`、`promptSchema`、`inputTextSchema`、`INPUT_KEYS`、`interactiveInfoSchema`、操作 `start_interactive` / `send_input` / `stop_interactive` |
| `client/interactive.ts` | `InteractiveManager`（OS によらない手順：上限、名前と ID、claude の引数、起動の待ち、ログ、停止の段階、30分後の片付け）、`InteractiveBackend`（OS ごとのバックエンドの取り決め）、`promptArg`、`interactiveModeArg`、`findScreenUrl`、`screenTail` |
| `client/interactive-tmux.ts` | macOS / Linux の `TmuxBackend`、`defaultTmuxRunner`、`tmuxEnv` |
| `client/interactive-pty.ts` | Windows の `PtyBackend`（Bun の疑似端末と `@xterm/headless`）、`bunPtySpawn`、`bunSupportsConpty`、`ptyEnv` |
| `client/actions.ts` | 3操作の振り分けと、起動前のパスの検査 |
| `client/main.ts` | `interactiveBackend`（OS でバックエンドを選ぶ。Windows は Bun の版も見る）、`resolveTmux`（`TMUX_BIN`、PATH、`/opt/homebrew/bin`・`/usr/local/bin`・`/usr/bin` の順に探す）、終了時の `interactive.shutdown()` |
| `client/sessions.ts` | `othersActive` と `activeCount`（rc と対話セッションの上限の合算）、`StartLock`（上限の検査からバックエンドにセッションができるまでを、rc の起動とも1つずつ通す。起動直後の待ちはロックの外）、`defaultKill`（Windows の強制終了にも使う） |
| `src/mcp/tools.ts` | `start_session`、`send_input`、`list_rc_sessions` と `stop_rc_session` の対話セッション対応 |
| `src/mcp/format.ts` | `interactiveLines`、`interactiveHint`（trust の確認画面、Remote Control の初回確認、ログイン、古い CLI） |
| `src/notify.ts` | `session_started` / `session_stopped` |

## バックエンドの取り決め（`InteractiveBackend`）

`rows`（`cc_` のセッションの一覧。終了済みも含む）、`create`（引数配列で起動。失敗は理由の文字列）、`capture`（URL を探す生の文字列と、表示用の末尾20行）、`paste`（括弧付き貼り付け）、`key`（Enter / Escape / Up / Down / Ctrl+C）、`remove`（セッションごと消す）、`shutdown`（クライアント終了時。tmux は何もしない）。バックエンドが無いとき（tmux が無い、Windows の Bun が古い）は `backend: null` と理由を渡し、操作は `spawn_failed`、一覧は空になる。

## 状態の持ち方

- tmux：状態は tmux 側にだけ持つ。一覧は `list-sessions -F "#{session_name} #{session_created} #{pane_dead} #{pane_dead_status} #{pane_dead_time}"`（tmux は `-F` の出力のタブを `_` にするので空白で区切る）で取り、パスと名前は区切り文字を含みうるので `display-message -p` で1欄ずつ取る。tmux は `-u` で動かし、LANG の無い launchd でも日本語の名前を崩さない。
- Windows：状態はクライアントのメモリ（`Map`）に持つ。セッションごとに疑似端末・端末エミュレーター・生の出力の末尾・拾った URL・終了コードを持つ。終了コードは `proc.exited` から取る（`terminal` の `exit` コールバックは疑似端末の状態で、終了コードではない）。終了直前の出力を受け取りきるよう、疑似端末は終了の1秒後に閉じる。

## テスト

- `test/interactive.test.ts`：tmux の引数配列（専用ソケット、`--` の後ろのプロンプト、`manual`、`--worktree`）、起動場所を `-c` ではなく tmux の作業ディレクトリで渡すこと（`#(…)`・`#{…}`・末尾の `;` を含む場所）と場所が違ったときの片付け、早期終了、上限の合算（同時に来た起動、rc との同時の起動、作成失敗のあとの空き）、バックエンドなし、一覧の絞り込みと片付け、貼り付けと Enter、キー、終了済みへの送信の拒否、停止の段階。tmux があれば偽の claude で起動・入力・停止と、書式の文字や末尾の `;` を含む場所での起動を通しで確認する。
- `test/interactive-pty.test.ts`：疑似端末の代役で、引数配列・環境変数・起動失敗・早期終了・貼り付け（CR、括弧付きは claude が有効にしたときだけ）・キー（カーソルキーのモード）・問い合わせへの返事・停止の段階・上限・終了時の片付け・Bun の版の判定。本物の疑似端末（`Bun.Terminal`）で偽の claude（`test/fixtures/fake-claude.ts`、Bun で動く）を動かし、引数（`"`・`%`・`\`・改行・日本語）がそのまま届くこと、入力のバイト列、URL、終了コード、停止を通しで確認する。Windows 機では `bun test test/interactive-pty.test.ts` で ConPTY での動きを確認できる。
- `test/actions.test.ts`：方針外のパス・ホーム・不正なプロンプトや名前・禁止の権限モード・余計な引数で tmux を呼ばないこと、`cc_` 以外の id と text/key の両方・どちらも無しの拒否。
- `test/format.test.ts`：画面の末尾を文字列リテラルにすること、`interactiveHint` の判定。
