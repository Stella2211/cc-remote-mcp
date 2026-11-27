## プロジェクト概要

cc-remote-mcp は、利用者の PC で `claude remote-control`（`claude rc`）や対話セッション（macOS / Linux は tmux、Windows は Bun の疑似端末）を遠隔で起動・停止し、対話セッションに入力を送るリモート MCP サーバー（Cloudflare Workers + Durable Objects）と、各 PC の常駐クライアント（Bun）。claude.ai のカスタムコネクタとして使う。認証は Cloudflare Access の Managed OAuth（MCP 側）と、端末ごとのトークン（端末側）。

- ドキュメントの索引：`docs/README.md`（構成は `docs/architecture.md`、利用者の作業は `docs/setup.md`）
- 主要コマンド：`bun run typecheck`、`bun test`、`bun run dev`、`bun run client`、`bun run device`、`bun run deploy`、`bun run bootstrap`
- 注意：`src/` は Workers 上で動く。Bun 固有の API（`Bun.file` など）を使わない。`shared/` は Worker とクライアントの両方から読むので zod 以外に依存しない。
- 注意：クライアントの操作は `shared/protocol.ts` の7つ（list_sessions / stop_session / list_dirs / start_session / start_interactive / send_input / stop_interactive）だけ。任意コマンドの実行、シェル経由の起動、`claude` や `tmux` への自由な引数を足さない。tmux は必ず専用ソケット（`-L cc-remote-mcp`）で動かし、tmux に渡す引数が `;` で終わらないようにする。パスは必ず `client/paths.ts` の `resolveDir` を通す。
- 注意：Windows の対話セッションは、`CLAUDE_BIN`（claude.exe）を `Bun.spawn` に引数の配列で渡して直接起動する。cmd や PowerShell を通さない（`client/interactive-pty.ts`）。
- 注意：シークレット・端末トークン・メールアドレス・識別子をコードやドキュメントに書かない。`client/.env` と `devices.local.json` はコミットしない。

## フォークしてデプロイする（Claude Code 向け）

利用者からフォークのセットアップを頼まれたときの分担。詳しくは `docs/setup.md` の「Claude Code にまかせる（bootstrap）」、スクリプトは `scripts/bootstrap.ts`。ホスト名・AUD・アカウント ID・メールアドレスはコミットしない（シークレットと端末トークンはチャットにも書かない）。

- 人がやること：フォークの Actions を有効にする、`gh auth login`、Zero Trust の初回の有効化、API トークンの作成（権限は `docs/setup.md` の表）と `CLOUDFLARE_API_TOKEN` への設定、ホスト名2つと許可するメールアドレスを決める、任意で Discord の Webhook、最後に claude.ai へのコネクタの追加と各 PC での `claude rc` の初回の承認。
- Claude Code がやること：
  1. `bun install --frozen-lockfile`、`bun run typecheck`、`bun test`
  2. `bun run bootstrap github --mcp-host <MCP のホスト> --link-host <link のホスト> --dry-run` で登録するものを確かめてから、`--dry-run` なしで実行する（Access アプリをダッシュボードで作っていなければ `--create-access-app --email <メールアドレス>` を足す）
  3. `gh workflow run ci --repo <owner/name> --ref main` でデプロイし、`gh run watch` で終わるまで待つ
  4. 各 PC で `bun run device init <端末名>`、デプロイする PC で `bun run device add <端末名> <ハッシュ>`
  5. `bun run bootstrap worker-secrets --email <メールアドレス>`（`DEVICE_KEYS` は `devices.local.json`、`DISCORD_WEBHOOK_URL` は環境変数から）
- 確認：`gh run list --repo <owner/name> --workflow ci`、`curl` で `/mcp` が 401 か 302、`/connect` が 426（`docs/setup.md` の手順 2）、`bun run client` のログに `{"link":"open"}`。

## 実装手順

1. 指示に不明点があれば確認する
2. `docs/` を読み、要件を整理してドキュメントを更新する（各機能フォルダは README / requirements / implementations、1ファイル200行以内）
3. 実装後に `bun run typecheck` と `bun test` を通す
4. パスの検査とホワイトリストに関わる変更には、`test/paths.test.ts`・`test/actions.test.ts` にテストを足す（tmux の引数は `test/interactive.test.ts`、疑似端末の引数は `test/interactive-pty.test.ts`）
5. ドキュメントを実装に合わせて更新し、既存の流儀に合わせてコミットする
