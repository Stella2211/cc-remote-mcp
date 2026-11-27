# MCP ツールの要件

- 引数は zod で検査する（端末名、絶対パス 1024 文字まで・制御文字なし、`session_id` は `rc_` 形式（`stop_rc_session` は `cc_` も、`send_input` は `cc_` だけ）、`name` は64文字まで・`-` で始まらない。`start_session` の `name` は、さらに `;` で終わらない）。
- 端末の応答は `actionResults` のスキーマで検証し、合わなければ「応答の形が不正」で失敗にする。
- 失敗は `isError` と固定の文言（`offline` / `timeout` / `unknown_device` / `bad_request` / `forbidden` / `not_found` / `limit` / `spawn_failed` / `internal`）に対処を添えて返す。
- ログは操作名・端末名・結果の種別・所要時間だけ。パスや出力は残さない。
- 日時は JST の固定書式。
- 起動と停止は Discord に通知する（`DISCORD_WEBHOOK_URL` 設定時）。プロンプトと入力の中身は Worker のログにも通知にも出さない。
