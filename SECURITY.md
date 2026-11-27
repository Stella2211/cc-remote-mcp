# Security Policy / セキュリティポリシー

## English

### Supported versions

Only the latest `main` is supported. Fixes are made on `main`; please check that the problem still reproduces there before reporting.

### Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub private vulnerability reporting instead: open this repository's **Security** tab and choose **Report a vulnerability**.

Please include:

- The affected component (Worker / Durable Objects, client, setup) and the commit or version
- Steps to reproduce, and the expected and actual behavior
- The impact you expect (for example, what an attacker needs and what they could do)
- Logs or output, with tokens, device keys, hostnames and email addresses removed

We handle reports on a best-effort basis and make no promise about response or fix times.

### Scope

Reports about the following are welcome (see [README.en.md](./README.en.md) for the trust boundaries):

- The MCP Worker and its Durable Object (`DeviceHub`): access control, handling of the `ALLOWED_EMAIL` check, and the `/mcp` and `/connect` endpoints
- Cloudflare Access setup (Managed OAuth) as described in [docs/setup.md](./docs/setup.md), where the documented steps leave a gap
- The per-PC client and device tokens: token handling and revocation, and anything that exposes a token
- The fixed allowlist of client operations (the seven in `shared/protocol.ts`): any way to run arbitrary commands, pass free arguments to `claude` or `tmux`, or reach a directory outside `ALLOWED_ROOTS` (paths must go through `resolveDir`)

Out of scope: the security of your own Cloudflare account, your own PC, or Claude Code's own permission settings; and behavior that follows from the documented trust boundaries (anyone allowed through Cloudflare Access can run Claude Code on a registered PC within its allowed roots).

---

## 日本語

### サポートするバージョン

サポートするのは最新の `main` だけです。修正は `main` に入れます。報告する前に、`main` でも再現するか確認してください。

### 脆弱性の報告

脆弱性は公開の issue に書かないでください。GitHub の Private vulnerability reporting を使います。このリポジトリの **Security** タブを開き、**Report a vulnerability** を選んでください。

次の内容を書いてください。

- 影響を受けるコンポーネント（Worker / Durable Objects、クライアント、セットアップ）と、コミットまたはバージョン
- 再現手順と、期待した動作・実際の動作
- 想定する影響（攻撃者に必要な条件と、できてしまうこと）
- ログや出力（トークン・端末キー・ホスト名・メールアドレスは消してください）

対応はベストエフォートです。返信や修正の時期はお約束できません。

### 対象の範囲

次に関する報告を歓迎します（信頼境界は [README.md](./README.md) を参照）。

- MCP の Worker と Durable Object（`DeviceHub`）：アクセス制御、`ALLOWED_EMAIL` の照合、`/mcp` と `/connect`
- [docs/setup.md](./docs/setup.md) にある Cloudflare Access（Managed OAuth）の設定のうち、手順どおりでも穴が残る点
- 各 PC のクライアントと端末トークン：トークンの扱いと失効、トークンが漏れる経路
- クライアントの操作の固定リスト（`shared/protocol.ts` の7つ）：任意のコマンドの実行、`claude` や `tmux` への自由な引数、`ALLOWED_ROOTS` の外のディレクトリへの到達（パスは必ず `resolveDir` を通す）

対象外：利用者自身の Cloudflare アカウントや PC、Claude Code 自体の権限設定の安全性。また、ドキュメントに書いた信頼境界のとおりの動作（Cloudflare Access を通った人は、登録した PC の許可ルートの中で Claude Code を動かせる）。
