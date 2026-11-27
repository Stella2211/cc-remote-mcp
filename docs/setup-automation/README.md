# セットアップの自動化（Access アプリ）

[setup.md](../setup.md) の手順 1（Cloudflare Access のアプリ作成と AUD の写し取り）を、Cloudflare API で行う。要件は [requirements.md](./requirements.md)、実装は [implementations.md](./implementations.md)。手でダッシュボードを操作する手順（setup.md 手順 1）もそのまま使える。

## 使い方

GitHub Actions の `setup` ワークフロー（手動実行だけ）が `bun run setup` を動かす。API トークンは GitHub の secret にだけ置けば足りる（値は誰も読めない）。手元の `.env.local` にトークンがあるなら、手元で `bun run setup` を動かしてもよい。

1. 前提（人間が1回だけ）：Zero Trust を始める（チーム名・Free プラン・支払い情報。API ではできない）。API トークンを作って `gh secret set CLOUDFLARE_API_TOKEN` で登録する（下の「API トークンの権限」）。
2. 値を入れる：`gh variable set CC_REMOTE_MCP_MCP_HOST --body <MCP のホスト>`、`gh variable set CC_REMOTE_MCP_LINK_HOST --body <link のホスト>`、`gh secret set CC_REMOTE_MCP_ALLOWED_EMAIL --body <許可するメールアドレス>`。アカウントが複数見えるトークンなら `gh secret set CLOUDFLARE_ACCOUNT_ID --body <アカウント ID>` も。
3. まず読むだけで試す：`gh workflow run setup.yml --ref main`（入力 `dry_run` の既定は true）。
4. 本番：`gh workflow run setup.yml --ref main -f dry_run=false`。ログとジョブの要約に、次の値と、Claude Code が実行する `gh` のコマンドが出る。

```sh
gh secret set CLOUDFLARE_ACCOUNT_ID --body <アカウント ID>
gh variable set CC_REMOTE_MCP_ACCESS_TEAM_DOMAIN --body <チーム名>.cloudflareaccess.com
gh variable set CC_REMOTE_MCP_ACCESS_AUD --body <AUD>
```

5. 4つの `CC_REMOTE_MCP_*` の variables と `CLOUDFLARE_*` の secrets がそろえば、main への push か ci の手動実行でデプロイされる（[setup.md](../setup.md) の「更新するとき」）。

## 既存のアプリがあるとき

`domain` が `<MCP のホスト>` の self-hosted アプリがすでにあれば、**そのまま使い、AUD を読むだけ**にする（何も書き換えない）。ダッシュボードで作ったアプリの設定をスクリプトの値に揃えたいときだけ、入力 `update_existing: true`（手元では `--update-existing`）を付ける。揃えるのは OAuth の設定とポリシーだけで、ほかのフィールドは GET した値のまま PUT する。先に `dry_run` で差分を確かめる。

## API トークンの権限

カスタムトークン（対象はそのアカウントと、使うゾーンだけ）。setup を使わずデプロイだけなら、Access の2行は要らない。

| 範囲 | 権限（ダッシュボードの表記） | 使う処理 |
| --- | --- | --- |
| Account | Workers Scripts: Edit | デプロイ、カスタムドメイン |
| Account | Account Settings: Read | アカウントの一覧（setup）、wrangler |
| Account | Access: Apps and Policies: Edit | Access アプリと再利用ポリシーの作成・更新（setup） |
| Account | Access: Organizations, Identity Providers, and Groups: Read | チームのドメインと IdP の確認（setup） |
| Zone | Workers Routes: Edit、DNS: Edit | wrangler の routes、カスタムドメインの付け替え |

テンプレート「Edit Cloudflare Workers」を使うときは、これに Access の2つを足す。足りない権限は、setup が 403 のときに API と権限の名前を挙げて止まる。

## 注意点

- **Managed OAuth は Cloudflare 側で Beta**。`oauth_configuration` のフィールド名は公式 API リファレンスの記載に従ったが、実機での確認はまだ（実装の「未確認」を参照）。
- IdP は作らない。Zero Trust を始めると One-time PIN が入る想定だが、それで Managed OAuth のログインが通るかは未確認。通らなければ、ダッシュボードで GitHub や Google などの IdP を足す。setup は IdP が0件のときに警告だけ出す。
- API トークンとメールアドレスは出力しない。メールアドレスは Actions のログで伏せ字になる。
- `link.` のホストを含む Access アプリがあれば警告する（`link.` は Access の対象に含めない設計。[auth/](../auth/README.md)）。
