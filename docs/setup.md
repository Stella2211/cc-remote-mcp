# セットアップ（利用者の作業）

デプロイ・Access の設定・シークレットの登録は、利用者が自分の PC で行う。シークレットや端末トークンをチャットやリポジトリに書かない。

以下の `<MCP のホスト>` と `<link のホスト>` は自分で決めるホスト名（例：`cc-remote-mcp.example.com` と `link.cc-remote-mcp.example.com`。Cloudflare に置いた自分のゾーンの下）。

## フォークして使うときに設定するもの

ホスト名と Access の値はリポジトリに置かず、デプロイ時に差し込む。`wrangler.jsonc` の routes と vars は例の値（`bun run dev` 用）なので書き換えなくてよい。

| 置き場所 | 名前 | 中身 |
| --- | --- | --- |
| GitHub の repository variables（Settings → Secrets and variables → Actions → Variables）と、手元の `.env.local` | `CC_REMOTE_MCP_MCP_HOST` | MCP のホスト名（`<MCP のホスト>`。`https://` もパスも付けない） |
| 同上 | `CC_REMOTE_MCP_LINK_HOST` | 端末がつなぐホスト名（`<link のホスト>`） |
| 同上 | `CC_REMOTE_MCP_ACCESS_TEAM_DOMAIN` | Zero Trust のチームのドメイン（`<チーム名>.cloudflareaccess.com`） |
| 同上 | `CC_REMOTE_MCP_ACCESS_AUD` | 手順 1 で作る Access アプリの AUD タグ |
| 同上（任意） | `CC_REMOTE_MCP_WORKER_NAME` | Worker の名前。空なら `wrangler.jsonc` の `cc-remote-mcp`。別の名前でデプロイ済みの Worker を使い続けるときだけ、その名前を入れる（名前を変えると別の Worker になり、シークレットも DeviceHub の中身も引き継がず、カスタムドメインがぶつかる） |
| GitHub の repository secrets | `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | CI からデプロイするときだけ（[更新するとき](#更新するとき)） |
| Worker のシークレット（`wrangler secret put`） | `ALLOWED_EMAIL` / `DEVICE_KEYS` / `DISCORD_WEBHOOK_URL` | 手順 2・4 |
| 各 PC の `client/.env` | `CC_REMOTE_MCP_URL` | `wss://<link のホスト>/connect` |

`bun run deploy`（`scripts/deploy.ts`）は、必須の4つの `CC_REMOTE_MCP_*` で routes（2つのカスタムドメイン）と vars（`MCP_HOST`・`LINK_HOST`・`ACCESS_TEAM_DOMAIN`・`ACCESS_AUD`）を置き換えた設定を一時的に書き、`wrangler deploy` を動かす（`CC_REMOTE_MCP_WORKER_NAME` があれば name も置き換え、デプロイ先の Worker の名前を表示する）。必須の4つが1つでも空ならデプロイしない。手元では、リポジトリの直下に `.env.local`（`.gitignore` 済み。Bun が自動で読む）を置く。

```sh
# .env.local
CC_REMOTE_MCP_MCP_HOST=<MCP のホスト>
CC_REMOTE_MCP_LINK_HOST=<link のホスト>
CC_REMOTE_MCP_ACCESS_TEAM_DOMAIN=<チーム名>.cloudflareaccess.com
CC_REMOTE_MCP_ACCESS_AUD=<AUD タグ>
# CC_REMOTE_MCP_WORKER_NAME=<デプロイ済みの Worker の名前>   # 任意
```

`bun run deploy --dry-run` のように付けた引数は、そのまま `wrangler deploy` に渡る。

## 1. Cloudflare Access（MCP 側）

Zero Trust のダッシュボードで、self-hosted のアプリを新しく作る。

| 項目 | 設定 |
| --- | --- |
| アプリ | self-hosted「cc-remote-mcp」。`<MCP のホスト>`（パスなし）を保護。`<link のホスト>` は**含めない** |
| ポリシー | Allow、Include Emails に自分のメールアドレス1件 |
| IdP | 任意（GitHub、Google など） |
| Managed OAuth | 有効、DCR 有効、localhost / loopback クライアントはオフ |
| Allowed redirect URIs | `https://claude.ai/api/mcp/auth_callback`、`https://claude.com/api/mcp/auth_callback` |
| Grant session duration | 1か月（既定の「Same as session duration」だと約24時間でリフレッシュトークンが切れ、claude.ai のコネクタが毎日「再接続が必要」になる） |
| Access token lifetime | 既定（15分） |

作ったアプリの AUD タグを `CC_REMOTE_MCP_ACCESS_AUD` に、チームのドメインを `CC_REMOTE_MCP_ACCESS_TEAM_DOMAIN` に入れる（`.env.local` と repository variables。空のままではデプロイしない）。Access アプリはホスト名だけで作れるので、デプロイより先に作っておくと、AUD 入りの設定で1回でデプロイできる。

## 2. デプロイ

wrangler に複数のアカウントでログインしているときは、デプロイ先の Cloudflare アカウント ID を `CLOUDFLARE_ACCOUNT_ID` で渡す（`wrangler.jsonc` には書かない。`.env.local` に書いてもよい）。ID はダッシュボードの右側にある。

```sh
export CLOUDFLARE_ACCOUNT_ID=<Cloudflare アカウント ID>
bun install --frozen-lockfile
bun run typecheck && bun test
bun run deploy                                  # .env.local の CC_REMOTE_MCP_* を差し込む。初回は DeviceHub の migration v1 も一緒に適用される
bunx wrangler secret put ALLOWED_EMAIL          # Access で許可したメールアドレス
bunx wrangler secret put DISCORD_WEBHOOK_URL    # 任意（Discord 通知）
```

`CC_REMOTE_MCP_WORKER_NAME` を設定したときは、`wrangler secret put` に `--name <Worker の名前>` を付ける（例：`bunx wrangler secret put ALLOWED_EMAIL --name <Worker の名前>`）。付けないと、`wrangler.jsonc` の `cc-remote-mcp` という Worker にシークレットが入り、デプロイした Worker には届かない。以降の `secret put` も同じ。

カスタムドメイン（`<MCP のホスト>` と `<link のホスト>`）の DNS と証明書はデプロイ時に作られる。数分たってから確認する。

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://<MCP のホスト>/mcp       # Access が前にいれば 401 か 302
curl -s -o /dev/null -w '%{http_code}\n' https://<link のホスト>/connect  # 426（WebSocket 以外は断る）
```

`DEVICE_KEYS` は端末を登録してから入れる（手順 4）。未設定のあいだは、どの端末もつながらない。

`DISCORD_WEBHOOK_URL` を入れると、固定の書式で Discord に通知する。送るのは、rc と対話セッションの起動・停止（端末名・場所・状態）と、許可外のメールアドレスの拒否だけ。プロンプトと入力の中身は送らない。Discord の Webhook の URL 以外は設定しても使われない。

## 3. 各 PC の準備

1. Claude Code に claude.ai のアカウントでログインしておく（API キーでは Remote Control は使えない）。
2. リポジトリを置き、`bun install`。
3. `bun run device init <端末名>`（例：`mac-mini`）。`client/.env` に端末名とトークンが入り、登録用のハッシュが表示される。すでにトークンがある `client/.env` は上書きせず断る（作り直すときは `--force`。古いトークンは使えなくなるので、`device add` で登録し直す）。
4. `client/.env` の `CC_REMOTE_MCP_URL`（`wss://<link のホスト>/connect`）、`ALLOWED_ROOTS`（必須）と `BLOCKED_DIRS` を書く。項目の説明は `client/.env.example`。設定ファイルを別の場所に置くときは、`bun run client --env <パス>` で指定する（省くと `client/.env`）。
5. **遠隔で使うディレクトリで、一度だけ手で `claude rc` を実行して承認する。** 初回の「Enable Remote Control?」と、ディレクトリの「Trust <dir>?」に y で答える。クライアントはターミナルなしで起動するので、未承認のディレクトリでは rc がすぐ終了する（ツールの結果に対処が出る）。
6. Windows は `CLAUDE_BIN` に `claude.exe` のフルパスを書く（`.cmd` は使えない）。
7. 対話セッション（`start_session` / `send_input`）を使う macOS / Linux では tmux を入れる（macOS は `brew install tmux`）。launchd などで見つからないときは `client/.env` の `TMUX_BIN` にフルパスを書く。Windows は tmux の代わりに Bun の疑似端末（ConPTY）を使うので、Bun を 1.3.14 以降にする（`bun --version`、古ければ `bun upgrade`）。
8. 対話セッションを使うディレクトリは、一度 `claude` を手で起動して trust を承認し、`claude --rc` で Remote Control の初回確認も済ませておく。未承認だと確認画面で止まる。

## 4. 端末の登録

デプロイする PC で、各端末のハッシュを登録してから反映する。

```sh
bun run device add <端末名> <ハッシュ>
bunx wrangler secret put DEVICE_KEYS < devices.local.json
```

失効は `bun run device remove <端末名>` のあと同じく `secret put`。接続中の端末は次の操作で切断される。

## 5. 動作確認と自動起動

まず手で動かし、ログに `{"link":"open"}` が出るのを確認する。

```sh
bun run client
```

確認できたら Ctrl+C で止め、OS ごとに登録する。

| OS | 登録 | 解除 | ログ |
| --- | --- | --- | --- |
| macOS | `sh autostart/macos/install.sh` | `sh autostart/macos/uninstall.sh` | `~/Library/Logs/cc-remote-mcp/client.log` |
| Linux | `sh autostart/linux/install.sh` | `sh autostart/linux/uninstall.sh` | `journalctl --user -u cc-remote-mcp -f` |
| Windows | `powershell -NoProfile -ExecutionPolicy Bypass -File autostart\windows\install.ps1` | 同じく `uninstall.ps1` | `%LOCALAPPDATA%\cc-remote-mcp\client.log`（エラー出力は `client.err.log`。どちらも起動のたびに前回の分が `.1` に回る） |

- Linux でログインせずに OS 起動時から動かすには、一度だけ `sudo loginctl enable-linger "$USER"`。
- macOS / Linux の登録スクリプトは、実行したシェルの `PATH` をサービスに引き継ぐ（`claude` を見つけるため）。`PATH` を変えたら登録し直す。
- Windows はログオン時に起動する（ログオン前には動かない）。`install.ps1` は `bun` と `client\.env` が先に要る。クライアントが終わると、タスクのラッパー（`run-client.ps1`）が10秒後に起動し直す。ラッパー自身の失敗（bun を起動できないなど）は `%LOCALAPPDATA%\cc-remote-mcp\wrapper.log` に残る。
- Windows の `uninstall.ps1` はタスクを外し、クライアントを `taskkill /T /F` で子ごと止める。そのクライアントが起動した rc と対話セッションも一緒に終わる（動いているものが無ければ何もしない）。
- macOS で `~/Documents`・`~/Desktop`・`~/Downloads` の下を `ALLOWED_ROOTS` にするなら、システム設定の「プライバシーとセキュリティ」→「フルディスクアクセス」に `bun` を追加する。launchd から起動した bun はそこを読めないことがある。

## 6. claude.ai に追加

claude.ai のカスタムコネクタに `https://<MCP のホスト>/mcp` を追加し、Access に設定した IdP でログインする。

## 任意：link. ホストも Access で守る

Access に `<link のホスト>` のアプリを作り、Service Auth のポリシーとサービストークンを用意し、各 PC の `client/.env` の `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` に入れる。端末トークンの検証はそのまま残る（二重の守り）。クライアントは `CF_ACCESS_CLIENT_ID` と `CF_ACCESS_CLIENT_SECRET` の両方がそろったときだけ、接続のヘッダー `CF-Access-Client-Id` / `CF-Access-Client-Secret` に付ける（片方だけだと起動時にエラー）。名前は `client/.env` の変数名で、Worker のシークレットではない。

## 更新するとき

Worker とクライアントはどちらを先に更新してもよい。Worker だけ新しいあいだは、新しいツールが「引数が端末側の検査を通らなかった」で失敗する。

Worker は main に push（マージ）すると GitHub Actions（`.github/workflows/ci.yml` の `deploy`）がテストのあとにデプロイし、疎通も確認する。手で再実行するときは Actions の「ci」から Run workflow。リポジトリの Settings → Secrets and variables → Actions の Variables に4つの `CC_REMOTE_MCP_*`（[フォークして使うときに設定するもの](#フォークして使うときに設定するもの)）を、Secrets に次の2つを入れておく。`CC_REMOTE_MCP_*` が1つでも空ならデプロイの手順で止まる。

| シークレット | 中身 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | デプロイ先アカウントの API トークン。テンプレート「Edit Cloudflare Workers」で、対象をそのアカウントと、Worker のカスタムドメインを置くゾーンに絞る。カスタムドメインの付け替えで権限が足りないと言われたら、Zone の「DNS: Edit」を足す |
| `CLOUDFLARE_ACCOUNT_ID` | デプロイ先の Cloudflare アカウント ID |

`ALLOWED_EMAIL`・`DISCORD_WEBHOOK_URL`・`DEVICE_KEYS` は Worker のシークレットなので、これまでどおり `wrangler secret put` で入れる（デプロイし直しても消えない）。`CC_REMOTE_MCP_WORKER_NAME` を設定しているときは `--name <Worker の名前>` を付ける。

各 PC のクライアントは手で更新する。

```sh
git pull && bun install --frozen-lockfile
launchctl kickstart -k "gui/$(id -u)/io.github.stella2211.cc-remote-mcp"   # macOS のクライアントを再起動
```

Windows（PowerShell。リポジトリのフォルダで）：

```powershell
git pull
bun --version   # 1.3.14 以降でなければ bun upgrade（対話セッションに要る）
bun install --frozen-lockfile
powershell -NoProfile -ExecutionPolicy Bypass -File autostart\windows\restart.ps1   # bun を子ごと止め、タスクのラッパーが10秒後に起動し直す
```

`Stop-ScheduledTask` だけでは子の bun が残るので使わない。ログ（`%LOCALAPPDATA%\cc-remote-mcp\client.log`）の起動の行で `bun` の版を確認できる。この `bun` の欄が無ければ、古いクライアントが動いたままになっている。

クライアントを再起動すると、そのクライアントが起動した rc（サーバーモード）は止まる（Windows の `restart.ps1` と `uninstall.ps1` は子ごと止めるので同じ）。対話セッションは macOS では tmux の中で動き続けるが、Linux の systemd（`KillMode=mixed`）ではサービスと一緒に止まり、Windows ではクライアントの疑似端末と一緒に終わる（[interactive/](./interactive/README.md)）。会話はその PC のターミナルで `claude --resume` から再開できる。
