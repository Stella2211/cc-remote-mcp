# 構成

## ホスト

| ホスト | 役割 | 保護 |
| --- | --- | --- |
| `<MCP のホスト>/mcp` | MCP（Streamable HTTP）。claude.ai のカスタムコネクタが呼ぶ | Cloudflare Access の Managed OAuth ＋ Worker での JWT 検証 |
| `<link のホスト>/connect` | 各 PC のクライアントの WebSocket | Access の対象外。端末トークンを Worker が検証（任意で Access サービストークンも） |

それ以外のホスト・パスはすべて 404。ホスト名は Worker の vars `MCP_HOST` / `LINK_HOST`（`wrangler.jsonc` は例の値で、本番の値は `scripts/deploy.ts` がデプロイ時に routes と一緒に差し込む）。どちらかが空なら、localhost の開発用を除き、すべてのリクエストに 500 を返す（fail closed）。

## リクエストの流れ

1. クライアントが起動し、`link.` に WebSocket を張る（`Authorization: Bearer <端末トークン>`、`X-CC-Remote-MCP-Device: <端末名>`）。
2. Worker（`src/index.ts`）がトークンを `DEVICE_KEYS` のハッシュと照合し、通れば Durable Object `DeviceHub`（`idFromName("hub")`、1個）に渡す。トークンは DO に渡さない。
3. DO は `acceptWebSocket(ws, [端末名])` で受け入れる。同じ端末名の古い接続は閉じる。以後は Hibernation で、ping は auto-response が返す。
4. claude.ai がツールを呼ぶと、Worker が Access の JWT を検証し、MCP ハンドラが `DeviceHub.call(端末名, 操作, 引数)` を RPC で呼ぶ。
5. DO は `{type:"request", id, action, params}` を送り、同じ接続から同じ id の応答が来るまで待つ（20秒で打ち切り）。
6. クライアントは操作をホワイトリストで振り分け、パスを検査してから実行し、応答を返す。
7. Worker は応答をスキーマで検証し、ツール結果の文章に整える。起動・停止は Discord に通知する（設定時）。

## ファイル

| パス | 内容 |
| --- | --- |
| `src/index.ts` | ホストとパスの振り分け、端末接続の認証 |
| `src/access.ts` | Access の JWT 検証 |
| `src/device-auth.ts` | 端末トークンの検証、`DEVICE_KEYS` の読み取り |
| `src/hub.ts` | Durable Object `DeviceHub` |
| `src/mcp/` | MCP サーバー、ツール、結果の整形 |
| `src/notify.ts` | Discord 通知 |
| `shared/protocol.ts` | WebSocket のメッセージと操作のスキーマ（Worker とクライアントで共有） |
| `client/` | PC 側のクライアント |
| `scripts/device.ts` | 端末トークンの発行と `devices.local.json` の管理 |
| `scripts/deploy.ts` | 環境変数 `CC_REMOTE_MCP_*` の値で routes と vars（任意の `CC_REMOTE_MCP_WORKER_NAME` があれば name も）を置き換えた設定を一時的に書き、`wrangler deploy` を動かす（必須の値が空ならデプロイしない） |
| `autostart/` | macOS（launchd）・Linux（systemd --user）・Windows（タスク スケジューラ）の登録スクリプト |

## 無料枠

Durable Object は SQLite 版（無料プランで使える）。接続中の WebSocket は Hibernation で課金時間に数えられにくく、ping も DO を起こさない。
