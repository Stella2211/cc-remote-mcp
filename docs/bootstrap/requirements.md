# bootstrap の要件

## github

- 入力：`--mcp-host` / `--link-host`（なければ環境変数 `CC_REMOTE_MCP_MCP_HOST` / `CC_REMOTE_MCP_LINK_HOST`）。ホスト名だけ（英小文字、`https://` もパスも付けない）で、2つは別のもの。
- `CLOUDFLARE_API_TOKEN` は環境変数（`.env.local` でもよい）から読む。空なら止める。
- アカウント ID：`--account-id`、環境変数 `CLOUDFLARE_ACCOUNT_ID`、`GET /accounts` の順。トークンで見えるアカウントが複数なら、一覧を出して止める。
- チームのドメイン：`GET /accounts/{id}/access/organizations` の `auth_domain`。取れなければ、ダッシュボードで Zero Trust を有効にするよう伝えて止める。
- Access アプリ：`GET /accounts/{id}/access/apps` から、MCP のホストをパスなしで守るアプリを探して `aud` を読む。複数あれば止める。link のホストにかかるアプリがあれば警告する。
- 見つけたアプリの Managed OAuth・DCR・localhost / loopback・Allowed redirect URIs・Grant session duration が手順 1 と違えば警告する（書き換えない）。
- `--create-access-app --email <メールアドレス>`：アプリが無いときだけ、`--email` を許可する再利用ポリシー（`POST /accounts/{id}/access/policies`）と、手順 1 の設定のアプリ（`POST /accounts/{id}/access/apps`）を作る。
- 登録：variables に `CC_REMOTE_MCP_MCP_HOST`・`CC_REMOTE_MCP_LINK_HOST`・`CC_REMOTE_MCP_ACCESS_TEAM_DOMAIN`・`CC_REMOTE_MCP_ACCESS_AUD`（`--worker-name` があれば `CC_REMOTE_MCP_WORKER_NAME` も）、secrets に `CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`。1件でも失敗したらそこで止める。

## worker-secrets

- `ALLOWED_EMAIL` は `--email`、`DEVICE_KEYS` はリポジトリ直下の `devices.local.json`、`DISCORD_WEBHOOK_URL` は同名の環境変数。あるものだけ入れ、どれも無ければ止める。`devices.local.json` は入れる前に Worker の `parseDeviceKeys` と同じ規則で調べ、JSON として読めない・オブジェクトでない・端末が0件・Worker が捨てる項目がある、のどれかなら止める（全端末が切れるのを防ぐ。中身は表示しない）。
- 入れる先の Worker は `--worker-name`、環境変数 `CC_REMOTE_MCP_WORKER_NAME`、`wrangler.jsonc` の `name` の順。`wrangler secret put` には必ず `--name` を付ける。

## 共通

- `gh` と `wrangler` はシェルを通さず、引数の配列で起動する。シークレットの値は標準入力で渡し、画面にもエラーにも出さない。
- `--dry-run` は Cloudflare と `gh repo view` の読み取りだけ行い、作成・登録をしない。
