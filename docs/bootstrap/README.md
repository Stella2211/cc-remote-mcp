# フォークのセットアップ（bootstrap）

フォークしたリポジトリを Claude Code に渡して、デプロイに要る値の登録まで進めてもらうためのスクリプト `scripts/bootstrap.ts`（`bun run bootstrap`）。人が作るのは Cloudflare の API トークンと、ダッシュボードにしかない設定だけ。手順は [setup.md](../setup.md#claude-code-にまかせるbootstrap)、要件は [requirements.md](./requirements.md)、実装は [implementations.md](./implementations.md)。

- `bun run bootstrap github`：Cloudflare の API でアカウント ID・Zero Trust のチームのドメイン・Access アプリの AUD を調べ、GitHub Actions の variables と secrets に `gh` で入れる。
- `bun run bootstrap worker-secrets`：Worker のシークレット（`ALLOWED_EMAIL`・`DEVICE_KEYS`・`DISCORD_WEBHOOK_URL`）を `wrangler secret put` で入れる。初回のデプロイのあとで動かす。
- どちらも `--dry-run` を付けると、Cloudflare の読み取りだけ行い、登録する名前と登録先を表示して何も書かない。

## 注意点

- シークレットの値は画面に出さず、`gh` と `wrangler` には標準入力で渡す（引数に置かない）。表示するのは repository variables の値（ホスト名・チームのドメイン・AUD）だけ。
- Access アプリは既定では探すだけで、書き換えない。設定が [setup.md](../setup.md#1-cloudflare-accessmcp-側) の手順 1 と違えば警告を出す。`--create-access-app` を付けたときだけ、見つからなければ作る。
- `gh` の登録先は `--repo` か、`gh repo view` が返すリポジトリ。最初に表示するので、フォーク先になっているかを確かめる。
