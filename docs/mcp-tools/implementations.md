# MCP ツールの実装

| ファイル | 内容 |
| --- | --- |
| `src/mcp/server.ts` | `createServer`：`McpServer` を作り、ツールを登録する |
| `src/mcp/tools.ts` | 7ツールの登録、`ask`（DO の `call` → スキーマ検証 → 失敗の文言） |
| `src/mcp/format.ts` | `literal`（JSON 文字列化と `<>`・書式文字のエスケープ）、`sessionLines`、`exitHint`、`interactiveLines`、`interactiveHint` |
| `src/notify.ts` | `rc_started` / `rc_stopped` / `session_started` / `session_stopped` / `email_rejected` の Discord 通知 |

## テスト

- `test/format.test.ts`：`literal`、稼働中は出力を出さないこと、`exitHint` と `interactiveHint` の判定、対話セッションの画面の引用。
