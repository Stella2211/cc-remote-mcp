# セットアップの自動化：実装

| ファイル | 内容 |
| --- | --- |
| `scripts/setup.ts` | `runSetup`（本体。`fetch` と `log` を差し込める）、`readSetupInput`、`parseArgs`、`OAUTH_CONFIGURATION`。`import.meta.main` のときだけ実際の `fetch` で動き、`GITHUB_STEP_SUMMARY` に書く |
| `.github/workflows/setup.yml` | `workflow_dispatch`（入力 `dry_run`、`update_existing`）。`environment: production`、`contents: read` |
| `test/setup.test.ts` | 偽の `fetch` で、作成・再利用（書き込みなし）・更新・dry-run・Zero Trust 未開始・複数アカウント・403・入力の検査を確かめる |

## 呼ぶ API（すべて `https://api.cloudflare.com/client/v4`）

| 処理 | API |
| --- | --- |
| アカウントの一覧 | `GET /accounts` |
| チームのドメイン | `GET /accounts/{id}/access/organizations`（`auth_domain`） |
| IdP の有無 | `GET /accounts/{id}/access/identity_providers` |
| アプリの一覧・取得 | `GET /accounts/{id}/access/apps`、`GET …/apps/{app_id}`（`aud` を読む） |
| アプリの作成・更新 | `POST /accounts/{id}/access/apps`、`PUT …/apps/{app_id}` |
| 再利用ポリシー | `GET` / `POST /accounts/{id}/access/policies`、`PUT …/policies/{policy_id}` |

一覧は `per_page=50` でページを辿る。

## 更新のしかた

PUT は GET したアプリの全フィールドを含めて送る（含めないと既存の設定が消える。公式の手順）。上書きするのは `oauth_configuration` と `policies` だけ。違いが無ければ PUT しない。

## 未確認のこと（実機で確かめる）

- `oauth_configuration` のフィールド名と値（Beta。公式 API リファレンスの記載による）。
- `GET /accounts` に要る権限（Account Settings: Read のはず）。
- 再利用ポリシーの PUT が `name` / `decision` / `include` だけで通るか。
- アプリの PUT で `id` / `aud` / `created_at` / `updated_at` を外してよいか（setup は外して送る）。
- Zero Trust を始めたときの既定の IdP（One-time PIN）で、Managed OAuth のログインが通るか。
- ポリシーが `policies: [{ id, precedence }]` の形でアプリに付くか（API リファレンスの記載による）。

実機で形が違えば、`scripts/setup.ts` の該当箇所（コメントに「未確認」と書いてある）を直す。
