# 認証の要件

- `/mcp` は Access の JWT（署名・issuer・audience・RS256）と `email` の一致がなければ 403。設定が欠けていれば 500（fail closed）。
- `DEV_BYPASS_ACCESS=1` は localhost / 127.0.0.1 宛のときだけ効く。
- `/connect` は WebSocket のアップグレード以外を 426、認証の失敗を 401 にする。理由は返さない。
- 端末名は英小文字・数字・ハイフンの1〜32文字。トークンは base64url の43〜128文字（Worker の認証とクライアントの起動時の検査は同じ形 `DEVICE_TOKEN_RE` を使い、外れたものは拒否する。`device init` は32バイトの乱数から43文字を作る）。
- ハッシュの比較は長さ一定の時間で行い、未登録の端末名でもハッシュ計算はする。
- DO には認証済みの端末名だけを渡し、`Authorization` と `CF-Access-Client-Secret` は落とす。クライアントが送った `X-CC-Remote-MCP-Authenticated-Device` は上書きする。
- `DEVICE_KEYS` が未設定・壊れているときは、どの端末も通さない。
- GitHub Actions の secrets から Worker のシークレットを書けること。空のものは書かず（消さず）、値はログに出さず、書くものが無い・Cloudflare の secret が無いときは何もせずに終わる。デプロイのワークフローは変えない。
