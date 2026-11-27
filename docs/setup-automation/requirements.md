# セットアップの自動化：要件

- `scripts/setup.ts` は、何度動かしても同じ結果になる（冪等）。
- 入力は環境変数：`CLOUDFLARE_API_TOKEN`（必須）、`CLOUDFLARE_ACCOUNT_ID`（任意）、`CC_REMOTE_MCP_MCP_HOST`・`CC_REMOTE_MCP_LINK_HOST`・`CC_REMOTE_MCP_ALLOWED_EMAIL`（必須）。引数は `--dry-run`（読むだけ）と `--update-existing`（既存のアプリを揃える）。
- アカウント ID：`CLOUDFLARE_ACCOUNT_ID` があればそれを使う。無ければ `GET /accounts` が1件のときだけそれを使い、複数ならアカウント名を並べて止まる。
- チームのドメイン：`GET /accounts/{id}/access/organizations` の `auth_domain`。Zero Trust が始まっていなければ、ダッシュボードでの1回だけの作業（人間）が要ると明示して止まる。
- Access アプリ：`domain` が MCP のホストの self-hosted アプリを探す。
  - 無ければ作る：Managed OAuth（DCR 有効、許可する redirect URI は claude.ai と claude.com の `/api/mcp/auth_callback`、localhost / loopback クライアントはオフ、grant session duration は 720h、access token lifetime は 15m）と、メールアドレス1件を許可する再利用ポリシー「cc-remote-mcp」。
  - あれば再利用して AUD を読むだけ。`--update-existing` のときだけ OAuth 設定とポリシーを合わせる。
- 出力は秘密ではない値だけ：アカウント ID、チームのドメイン、AUD、`gh` のコマンド。API トークンとメールアドレスは出さない。`GITHUB_STEP_SUMMARY` があれば同じ内容を書く。
- 権限不足（403）は、どの API にどの権限が要るかを出して止まる。
- `MCP_HOST` と `LINK_HOST` が同じならエラー。ホスト名に `https://` やパスが付いていてもエラー。
- IdP は作らない。ほかのポリシー（IP 制限、デバイス姿勢など）は足さない。
- `setup` ワークフローは `workflow_dispatch` だけ。`dry_run` の既定は true（誤って本番に書かないため）。
