# クライアントの要件

## 設定

- 必須：`CC_REMOTE_MCP_URL`（`wss://`。`ws://` は localhost のみ）、`DEVICE_NAME`、`DEVICE_TOKEN`、`ALLOWED_ROOTS`（1つ以上、存在するディレクトリ）。
- 任意：`BLOCKED_DIRS`、`HIDE_DOT_DIRS`（既定 true）、`MAX_SESSIONS`（1〜16、既定4）、`DEFAULT_PERMISSION_MODE`、`CLAUDE_BIN`、`TMUX_BIN`、`CF_ACCESS_CLIENT_ID` / `SECRET`（両方そろえる）。
- 設定ファイルは `client/.env`。別の場所は起動引数 `--env <パス>` で指定する。
- パスの並びは PATH と同じ区切り。`~` を展開し、相対パスは拒否する。
- `~/.ssh`・`~/.gnupg`・`~/.aws`・`~/.azure`・`~/.kube`・`~/.docker`・`~/.claude`・`~/.config/gcloud`・`~/.config/gh`・`~/Library/Keychains`・`~/AppData` は常にブロック。
- 設定の誤りは30秒待ってから終了コード 78 で終わる（サービスが再起動を繰り返すのを避ける）。

## パスの方針（一覧と起動の両方）

- 絶対パスだけ（1024文字まで）。`.` と `..` の要素、制御文字・不可視文字を拒否。macOS / Linux は `/` から始まることだけを見て、空白や記号など、ほかの文字は拒否しない（Linux は大文字小文字を区別する）。Windows は UNC・デバイスパス・ドライブ相対・使えない文字を拒否。
- realpath（シンボリックリンクを解決した実体）で、許可ルートの内側・ブロック対象の外・（既定で）`.` で始まる要素なしを確認する。
- Windows と macOS は大文字小文字を区別せずに比べる。
- 一覧は直下のディレクトリのみ、名前順、最大500件。条件を満たさないもの（ルート外へのリンク、ブロック対象、ファイル）は出さない。
- 一覧は応答1通（256KB）に収まるよう、件数に加えてバイト数（`MAX_LIST_BYTES`、外側の分として 8KB を残す）でも打ち切る。どちらの場合も `truncated` にする。パスが1024文字を超えるものは出さず、一覧するディレクトリ自体の実体のパスが1024文字を超えるとき（シンボリックリンクの先が長いとき）は `bad_request` で断る。名前は255文字に収め（超えたら末尾を `…` にする）、許可ルートの一覧で名前（ルートのパス）が長すぎるときは末尾の要素を名前にする。

## rc の起動と停止

- `claude remote-control --name <名前> --spawn <same-dir|worktree> [--permission-mode <モード>]` を、対象ディレクトリを cwd にして起動する。stdin は閉じる。
- 子プロセスにはクライアント自身の設定を渡さない。除く環境変数は `DEVICE_TOKEN`・`DEVICE_NAME`・`CF_ACCESS_CLIENT_ID`・`CF_ACCESS_CLIENT_SECRET`・`ALLOWED_ROOTS`・`BLOCKED_DIRS`・`TMUX_BIN` と、`CC_REMOTE_MCP_` で始まるもの（`client/sessions.ts` の `STRIP_ENV`）。それ以外は引き継ぐ。
- 同時に `MAX_SESSIONS` 個まで（対話セッションと合計）。同じディレクトリで2つ目の rc は起動しない。要求は並行に処理されるが、同時に来た起動でもこの2つの制限は回避できない（検査から登録までを、対話セッションの起動とも1つずつ行う）。
- `CLAUDE_BIN` が無い・実行できないときは、StartLock の内側（検査から登録までの間）で起動できなかったこと（pid が無いこと）を検知し、セッションを残さず、上限にも数えずに `spawn_failed`（「claude コマンドを起動できなかった」）にする。
- 起動後、セッション URL が出るか、終了するか、8秒たつまで待って状態を返す。
- 出力は ANSI と制御文字を除き、末尾20行（1行300文字）だけ持つ。終了したものは30分（最大20件）残す。
- クライアントが SIGINT / SIGTERM を受けたら、起動した rc をすべて止めてから終わる。対話セッションは、tmux の中のものは止めず、Windows の疑似端末のものは Ctrl+C を2回送って2秒後に強制終了する。
- 応答が 256KB を超えるときは、代わりに `internal` のエラーを返す（Worker 側で捨てられて待たせないため）。
