[English](./README.en.md)

# cc-remote-mcp

claude.ai のチャットやプロジェクトから、自分の PC で `claude rc`（Claude Code の Remote Control）や、最初のプロンプトつきの対話セッションを起動・停止し、対話セッションに入力を送るためのリモート MCP サーバーと、各 PC で常駐するクライアント。

```
claude.ai ──MCP(OAuth)──▶ <MCP のホスト>/mcp ─┐  Cloudflare Workers
                                             ├─ Durable Object（DeviceHub）
各PCのクライアント ──WebSocket(端末トークン)──▶ <link のホスト>/connect ─┘
```

ホスト名（例：`cc-remote-mcp.example.com` と `link.cc-remote-mcp.example.com`）と Cloudflare Access の値はリポジトリに置かず、デプロイ時に差し込む（[docs/setup.md](./docs/setup.md)）。

- PC 側は外から接続を受けない。クライアントが Worker へ WebSocket を張り続け、命令はその上で届く。
- クライアントができることは7つだけ（rc の一覧・停止・起動、ディレクトリ一覧、対話セッションの起動・入力・停止）。任意のコマンドは実行しない。
- 一覧・起動は `ALLOWED_ROOTS` の中だけ。`BLOCKED_DIRS` と資格情報の置き場（`~/.ssh` など）は常に対象外。

## MCP ツール

| ツール | 内容 |
| --- | --- |
| `list_devices` | 登録済みの端末と、接続中かどうか |
| `list_rc_sessions` | 端末でこのクライアントが起動した rc と対話セッションの一覧 |
| `stop_rc_session` | rc か対話セッションを止める（Ctrl+C 相当） |
| `list_directories` | 端末のディレクトリ直下のサブディレクトリ一覧（パスを省くと許可ルート） |
| `start_rc_session` | 端末のディレクトリで `claude remote-control` を起動する |
| `start_session` | 端末のディレクトリで、最初のプロンプトつきの対話セッション（`claude --remote-control`。macOS / Linux は tmux、Windows は疑似端末の中）を起動する |
| `send_input` | 対話セッションに文字かキーを送る |

対話セッションは macOS / Linux では tmux の中で動く。macOS と、手で起動した Linux（systemd を使わない場合）ではクライアントを再起動しても残るが、Linux の systemd（`KillMode=mixed`）ではサービスと一緒に止まる。Windows ではクライアントが開く疑似端末（ConPTY）の中で動くので、クライアントが止まる・落ちる・再起動すると一緒に終わる（会話はその PC のターミナルで `claude --resume` から再開できる）。詳しくは [docs/interactive/](./docs/interactive/README.md)。

## 信頼境界と前提

デプロイする前に、誰を信頼することになり、PC で何ができるようになるかを確認しておく。

- **PC を操作できるのは**、MCP ホストで Cloudflare Access を通り、メールアドレスが `ALLOWED_EMAIL` と一致した人と、その人の代わりにツールを呼ぶ MCP クライアント（claude.ai など）。登録した PC の許可ルートの中で `claude remote-control` を起動・停止し、任意のプロンプトで対話セッションを起動して入力を送れる。つまり、その PC で Claude Code（コマンドも実行できる）を動かせるのと実質的に同じ。
- **クライアントが絞っているのは**次のとおり。受け付けるのは7つの操作だけで、シェルや任意のコマンドは実行しない。起動する場所は `resolveDir` を通して `ALLOWED_ROOTS` の中（`BLOCKED_DIRS` と資格情報の置き場を除く）に限る。子プロセスにはクライアント自身の設定（端末トークンなど）を環境変数から外して渡す。同時に動かせるのは `MAX_SESSIONS` 個まで。tmux は専用ソケット（`-L cc-remote-mcp`）で動かす。
- **絞るのは起動する場所まで**で、起動した Claude Code が何に触れ、どこで確認を求めるかは、その PC の Claude Code 自身の権限設定と、起動時の権限モードで決まる。選べる権限モードは `default` / `acceptEdits` / `plan` / `auto` だけで、確認を飛ばすフラグ（`--dangerously-skip-permissions` など）は渡さない。
- **端末トークンが漏れると**、その PC になりすまして Worker につなげる。本物の接続は閉じられ、その PC あての命令（プロンプト・入力・パスを含む）を受け取り、偽の結果を返せる。漏れたトークンで PC を操作したり、ほかの端末に命令を送ったりはできない。失効は `DEVICE_KEYS` から外して `secret put` する（[docs/auth/](./docs/auth/README.md)）。
- **Cloudflare アカウントを持つ人**は Worker のコードとシークレットを変えられるので、上の操作をすべてできる（プロンプトや入力も Worker を通る）。Worker のログに残るのは操作名・端末名・所要時間・結果の種別などで、プロンプトや入力の中身は残らない。PC のクライアントのログにも、プロンプトや入力は長さだけを残し、中身は残さない。
- **Discord の Webhook の受け手**（設定したとき）には、rc と対話セッションの起動・停止（日時・端末名・場所。起動には状態も）と、拒否したメールアドレスが届く。プロンプトや入力の中身は送らない。
- このプロジェクトは Anthropic の公式ツールではなく、Anthropic とは関係がない。

## セットアップ

手順は [docs/setup.md](./docs/setup.md)。設計と実装の説明は [docs/README.md](./docs/README.md)。

## 開発

```sh
bun install
bun run typecheck
bun test
bun run dev        # wrangler dev（DEV_BYPASS_ACCESS=1 なら localhost で Access を省ける。--local-upstream で Host を localhost のままにする）
bun run client     # クライアントを手元で動かす（client/.env を読む。別の設定ファイルは `--env <パス>`）
bun run cf-typegen # wrangler.jsonc を変えたあと、worker-configuration.d.ts を作り直す
bun run deploy     # 本番の値（.env.local の CC_REMOTE_MCP_*）を差し込んでデプロイする
```

`bun run dev` のシークレットは、`.dev.vars.example` を `.dev.vars` にコピーして書く（`ALLOWED_EMAIL`・`DEVICE_KEYS`・`DEV_BYPASS_ACCESS`・`DISCORD_WEBHOOK_URL`。`.dev.vars` はコミットしない）。

`src/` は Cloudflare Workers で動くので Bun 固有の API は使わない。`client/` と `scripts/` は Bun で動く。

## ライセンス

MIT（[LICENSE](LICENSE)）
