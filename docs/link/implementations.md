# 接続の実装

| ファイル | 内容 |
| --- | --- |
| `shared/protocol.ts` | メッセージと操作の zod スキーマ、上限、ping / pong |
| `src/hub.ts` | `DeviceHub`：`fetch`（WebSocketPair を作り `adopt`）、`adopt`、`webSocketMessage` / `Close` / `Error`、`listDevices`、`call`、`getHub` |
| `client/connection.ts` | `Link`（接続・ハートビート・再接続）、`backoffMs`、`describeError`（error イベントの理由をログ用に取り出す） |

## SQLite

attachment：`{device, connectedAt, connId, keyHash}`

```sql
devices(name PRIMARY KEY, platform, client_version, connected_at, disconnected_at, last_seen)
```

## テスト

- `test/connection.test.ts`：`describeError`（理由とコードの取り出し、切り詰め、トークンらしい文字列の伏せ字）。
- `test/hub.test.ts`：端末一覧、応答の受け渡し、エラーをそのまま返すこと、別の接続からの応答の無視（タイムアウトになる）、オフライン・未登録・失効、トークンの入れ替え、`connId` での照合、置き換え、切断、壊れたメッセージ。
