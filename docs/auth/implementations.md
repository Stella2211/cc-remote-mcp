# 認証の実装

| ファイル | 内容 |
| --- | --- |
| `src/access.ts` | `checkAccess`（Access の JWT 検証と `ALLOWED_EMAIL` の照合）。不一致の拒否は Discord に通知（`email_rejected`） |
| `src/device-auth.ts` | `parseDeviceKeys`（名前とハッシュの形を検査）、`sha256Hex`、`constantTimeEqual`、`authenticateDevice` |
| `src/index.ts` | `handleLink`：アップグレードの確認 → `authenticateDevice` → ヘッダーを整えて DO へ |
| `scripts/worker-secrets.ts` | `CC_REMOTE_MCP_ALLOWED_EMAIL` / `_DEVICE_KEYS` / `_DISCORD_WEBHOOK_URL` のうち空でないものを `wrangler secret put`（値は stdin）で書く。`planSecrets` が書く対象を決め、`DEVICE_KEYS` は JSON のオブジェクトか検査する。`CC_REMOTE_MCP_WORKER_NAME` があれば `--name` を付ける |
| `.github/workflows/worker-secrets.yml` | 上を動かす手動実行だけのワークフロー（`main` のみ、`contents: read`、`production` の environment） |
| `scripts/device.ts` | `init`（PC 側でトークンを作り `client/.env` に書く）、`add` / `remove` / `show`（`devices.local.json` の管理） |

## 設定値

| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `MCP_HOST` / `LINK_HOST` | vars | MCP と端末接続のホスト名。空なら localhost の開発用を除いて 500 |
| `ACCESS_TEAM_DOMAIN` | vars | Zero Trust のチームのドメイン（`<チーム名>.cloudflareaccess.com`） |
| `ACCESS_AUD` | vars | Access アプリの AUD タグ |
| `ALLOWED_EMAIL` | secret | 許可するメールアドレス |
| `DEVICE_KEYS` | secret | `{"端末名":"SHA-256 の16進"}` の JSON |
| `DISCORD_WEBHOOK_URL` | secret | 任意 |

vars の本番の値はリポジトリに置かない（`wrangler.jsonc` は例の値か空）。`scripts/deploy.ts` が環境変数 `CC_REMOTE_MCP_*` から差し込む（[setup.md](../setup.md)）。

## テスト

- `test/device-auth.test.ts`：正しいトークン、違うトークン、未登録の端末、ヘッダー欠け、Basic、不正な端末名、`DEVICE_KEYS` 未設定。
- `test/index.test.ts`：ホストとパスの振り分け、426 / 401、DO に渡るヘッダー、`/mcp` の 403 / 500、ホスト名の vars が空のときの 500、本番ホストで `DEV_BYPASS_ACCESS` が効かないこと。
- `test/deploy.test.ts`：必須の `CC_REMOTE_MCP_*` が1つでも空ならデプロイしないこと、routes と vars の置き換え、任意の `CC_REMOTE_MCP_WORKER_NAME` による name の置き換えとその形の検査。
- `test/worker-secrets.test.ts`：空でない secret だけを書くこと、全部空なら何も書かないこと、`DEVICE_KEYS` が JSON のオブジェクトでなければ（値を出さずに）止めること。
