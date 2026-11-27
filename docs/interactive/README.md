# 対話セッション

`start_session` で、端末のディレクトリに Claude Code の対話セッションを最初のプロンプトつきで起動し、`send_input` であとから入力を送る。要件は [requirements.md](./requirements.md)、実装は [implementations.md](./implementations.md)。

MCP のツールと引数・返り値は OS によらず同じ。端末の中の作りだけを OS で切り替える。

| OS | `claude --remote-control` を動かす場所 | 要るもの |
| --- | --- | --- |
| macOS / Linux | 専用ソケットの tmux の中 | tmux（macOS は `brew install tmux`） |
| Windows | クライアントが開く疑似端末（ConPTY。Bun 組み込みの `Bun.spawn` の `terminal`）の中 | Bun 1.3.14 以降（`bun upgrade`） |

## rc（サーバーモード）との違い

| | `start_rc_session` | `start_session` |
| --- | --- | --- |
| 端末で動くもの | `claude remote-control`（接続を待つサーバー） | 端末の中の `claude --remote-control`（対話セッション） |
| claude.ai/code のセッション | 誰かが開くまでできない | 起動した時点でできる |
| 最初のプロンプト | 渡せない | `prompt` で渡せる |
| あとからの入力 | claude.ai/code からだけ | `send_input` でも送れる |
| クライアントを再起動したとき | rc は止まる | macOS は tmux の中で動き続け、一覧にも出る。Linux の systemd と Windows は止まる（下記） |

## クライアントが止まったとき・落ちたとき

- **macOS（tmux）**：状態は tmux 側にある。クライアントを再起動しても、セッションは動き続け、一覧にも出る。
- **Linux（tmux）**：macOS と同じく状態は tmux 側にあり、クライアントを手で起動しているときは再起動しても残る。systemd のサービスで動かしているときは、`KillMode=mixed` で tmux もサービスと一緒に止まる。
- **Windows（疑似端末）**：状態はクライアントのメモリにだけある。tmux と違い、セッションはクライアントのプロセスに紐づく。
  - クライアントが SIGINT / SIGTERM で正しく止まるときは、動いている対話セッションに Ctrl+C を2回送り、2秒後に `taskkill /T /F` で止める。
  - Windows では外からの停止はシグナルにならず、上の片付けは走らない。更新のときに使う `autostart\windows\restart.ps1` は `taskkill /T /F` で bun を子ごと止めるので、claude も一緒に止まる。クライアントが落ちたときは、疑似端末（ConPTY）が閉じるので claude も一緒に終わるはずだが、この動きは実機で確かめていない。残っていたらタスク マネージャーで `claude.exe` を止める。
  - どちらの場合も、再起動したクライアントの一覧には出ない。claude.ai/code のセッションは切断の表示になる。会話は、端末でそのディレクトリの `claude --resume` から戻せる。
  - クライアントを更新・再起動すると、その端末の対話セッションは終わる。作業の途中なら、終わってから更新する。

## 注意点

- tmux も新しい Bun も無い端末では、対話セッションだけが使えない。rc はそのまま使える。
- macOS / Linux：tmux は専用のソケット（`tmux -L cc-remote-mcp`）と空の設定で動かす。利用者自身の tmux とは混ざらない。端末で様子を見るときは `tmux -L cc-remote-mcp ls` と `tmux -L cc-remote-mcp attach -t <id>`（抜けるときは Ctrl+B のあと D）。
- Windows：疑似端末の画面は端末で直接は見られない（`list_rc_sessions` で終了後の画面の末尾、claude.ai/code で会話を見る）。claude には `CLAUDE_BIN` の `claude.exe` を、引数の配列で直接渡す（cmd や PowerShell を通さない）。
- ディレクトリが未承認（workspace trust）だと、claude は確認画面で止まる。承認は利用者が端末で行う（ツールの結果に対処が出る）。`send_input` で確認画面に答えることは想定しない。
- 送ったプロンプトと入力は、端末のクライアントのログには文字数だけ残し、中身は残さない（Worker のログと Discord 通知にも残さない）。
- `stop_rc_session` に `cc_` の id を渡すと、Ctrl+C を2回送ってから10秒後にセッションごと消す（tmux は `kill-session`、Windows はプロセスツリーの強制終了）。会話は端末で `claude --resume` から戻せる。
- セッションの URL は画面（tmux 3.4 以降は `/rc active` のリンク先も。Windows は生の出力の中のリンク先も）から拾う。拾えなければ claude.ai/code の一覧で名前を探す。
- 権限モードの `default` は、対話モードの claude には `manual`（同じ意味）として渡す。古い Claude Code が `manual` を知らないと起動に失敗するので、そのときは `claude update`。
