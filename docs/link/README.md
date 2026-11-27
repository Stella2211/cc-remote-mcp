# 端末との接続（link）

各 PC のクライアントは `wss://<link のホスト>/connect` に WebSocket を張り続ける。Worker 側は Durable Object `DeviceHub` が1個ですべての端末の接続を持つ。要件は [requirements.md](./requirements.md)、実装は [implementations.md](./implementations.md)。

## 注意点

- WebSocket Hibernation API を使う。何も起きていないあいだ DO はメモリから降りるので、接続ごとの情報は `serializeAttachment` と SQLite に置き、メモリには置かない。
- 待ち合わせ中のリクエスト（`pending`）だけはメモリに持つ。RPC の `call` が応答を待っているあいだは DO が降りないので、これで足りる。
- ping / pong は `setWebSocketAutoResponse` が返すので、ハートビートでは DO が起きない。
- PC 側はポートを開けない。NAT やファイアウォールの内側でも動く。
