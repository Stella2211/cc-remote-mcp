# 認証

2つの入口を別々の方法で守る。要件は [requirements.md](./requirements.md)、実装は [implementations.md](./implementations.md)。

- **MCP（`cc-remote-mcp.` の `/mcp`）**：Cloudflare Access の Managed OAuth。Worker は `Cf-Access-Jwt-Assertion` を検証し、`email` を `ALLOWED_EMAIL` と比べる（Access の検証に加えて、Worker 側でもメールアドレスを確認する二重チェック）。
- **端末（`link.` の `/connect`）**：端末ごとのトークン。Worker は SHA-256 のハッシュだけを `DEVICE_KEYS` に持つ。

## 注意点

- `link.` は Access の対象外にする。対象に含めるとクライアントの WebSocket が OAuth のログイン画面に飛ばされてつながらない（サービストークンを使う場合を除く）。
- トークンは発行した PC の `client/.env` にだけ置く。`device init` はトークンを画面に出さず、ハッシュだけを表示する。ハッシュは秘密ではない。
- 失効は `DEVICE_KEYS` から外して `secret put`。DO は `listDevices` / `call` のたびに `DEVICE_KEYS` を読み直し、外れた端末の接続を閉じる（コード 4003）。
- 同じ端末名で2つ目の接続が来たら古い方を閉じる（コード 4000）。クライアントは 4000 で閉じられたら5分待ってからつなぎ直す（取り合いを避ける）。
- Worker のシークレット（`ALLOWED_EMAIL` / `DEVICE_KEYS` / `DISCORD_WEBHOOK_URL`）は、手元の `wrangler secret put` のほか、手動実行のワークフロー `worker-secrets` でも入れられる（[setup.md](../setup.md)）。空の secret は書かず、消さない。
