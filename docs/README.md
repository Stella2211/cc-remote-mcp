# ドキュメント索引

cc-remote-mcp は、Claude から利用者の PC で `claude rc` や対話セッションを起動・停止し、対話セッションに入力を送るためのリモート MCP サーバーと、各 PC の常駐クライアントです。

- [architecture.md](./architecture.md)：全体の構成、リクエストの流れ、関連ファイル。
- [setup.md](./setup.md)：デプロイと各 PC の設定（利用者が手で行う作業）。

## 機能フォルダ

| フォルダ | 内容 |
| --- | --- |
| [auth/](./auth/README.md) | MCP 側の Cloudflare Access（Managed OAuth）と、端末側のトークン認証（DEVICE_KEYS）。 |
| [link/](./link/README.md) | 端末と Worker のあいだの WebSocket（Durable Object、Hibernation、プロトコル、再接続）。 |
| [mcp-tools/](./mcp-tools/README.md) | 7つの MCP ツールの入出力と、失敗時の返し方。 |
| [client/](./client/README.md) | PC 側のクライアント：設定、パスの方針、rc プロセスの管理、自動起動。 |
| [interactive/](./interactive/README.md) | 対話セッション（macOS / Linux は tmux、Windows は疑似端末）：プロンプトつきの起動、入力の送信、一覧と停止。 |

各機能フォルダは `README.md`（概要・注意点）、`requirements.md`（要件）、`implementations.md`（実装と関連ファイル）で構成する。
