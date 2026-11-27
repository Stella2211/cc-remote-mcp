# bootstrap の実装

| ファイル | 内容 |
| --- | --- |
| `scripts/bootstrap.ts` | `parseArgs`（引数と環境変数）、`buildGithubPlan` / `buildWorkerSecretPlan`（登録する一覧）、`validateDeviceKeys`（`src/device-auth.ts` の `parseDeviceKeys` を使った `devices.local.json` の検査）、`describeStep`（伏せ字つきの表示）、`commandFor`（`gh` / `wrangler` の引数と標準入力）、`findAppsForHost` / `findAppsCovering` / `oauthWarnings`（Access アプリの照合と点検）、`accessAppBody` / `accessPolicyBody`（作るときの中身）、`github` / `workerSecrets`（実行） |
| `scripts/deploy.ts` | `readWorkerName`（Worker の名前の検査）を共用する |

## 作る Access アプリ（`--create-access-app`）

| 項目 | 値 |
| --- | --- |
| `type` / `domain` / `destinations` | `self_hosted` / MCP のホスト / `[{type:"public", uri: MCP のホスト}]` |
| `policies` | 作った再利用ポリシー（Allow、Include の email に `--email`）1件 |
| `oauth_configuration` | `enabled`、DCR `enabled`、`allow_any_on_localhost` / `allow_any_on_loopback` は false、`allowed_uris` は claude.ai と claude.com の callback、`grant.session_duration` は `720h` |

IdP は指定しない（Zero Trust で使えるものがそのまま出る）。

## テスト

- `test/bootstrap.test.ts`：引数の読み取りと拒否、環境変数での補い、登録する一覧、表示と引数にシークレットの値が出ないこと（値は標準入力だけ）、Access アプリの照合（パス・大文字・destinations）、警告、作るアプリが手順 1 と合うこと。
