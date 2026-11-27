# クライアント

各 PC で常駐し、Worker から届いた操作を実行する Bun のプログラム。要件は [requirements.md](./requirements.md)、実装は [implementations.md](./implementations.md)。設定は `client/.env`（`client/.env.example` を参照）。

## 注意点

- できる操作は7つだけ（rc の一覧・停止・起動、ディレクトリ一覧、対話セッションの起動・入力・停止）。`claude` と `tmux` 以外のコマンドは起動しない（Windows の強制終了に使う `taskkill` を除く。Windows の対話セッションは tmux の代わりに Bun の疑似端末の中で `claude` を直接起動する）。どれも引数の配列で起動し、シェルを通さない。対話セッションは [interactive/](../interactive/README.md)。
- 管理するのは自分が起動した rc だけ。手で起動した rc は一覧にも出ず、止めもしない。
- rc はターミナル（TTY）なしで起動するので、ディレクトリの trust と Remote Control の初回確認は、その PC で一度だけ手で済ませておく必要がある（[setup.md](../setup.md)）。ホームディレクトリは trust が保存されないので起動を拒否する。
- POSIX では rc を別のプロセスグループで起動し、止めるときはグループに SIGINT（Ctrl+C 相当）、10秒で終わらなければ SIGKILL。Ctrl+C で止めた rc は約4時間 `claude rc --continue` で再開できる。
- Windows は Ctrl+C を送れないので `taskkill /T /F` で止める。
- rc の本体が終わったら、POSIX ではグループに一度 SIGKILL を送り、取り残された子を片付ける。止めている最中にもう一度止めると、すぐ強制終了する。クライアント自身が終わるときは SIGINT のあと2.5秒で強制終了する。
- クライアントが異常終了すると、起動済みの rc は管理から外れて残ることがある（systemd は cgroup ごと止めるので残らない）。
- rc は cwd の外にあるファイルでも、リンクやパスを書けば読めてしまう。ブロックはあくまで「どこで起動できるか」の制限。
- 非対話で動く rc が stdout にセッション URL を出すとは限らない。出なければ URL は空で返るので、claude.ai/code の一覧で名前を探す。
