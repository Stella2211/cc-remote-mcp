import { Terminal as Screen } from "@xterm/headless";
import type { InputKey, InteractiveBackend, Row } from "./interactive";
import { findScreenUrl, screenTail } from "./interactive";
import type { Platform } from "./paths";
import { type KillFn, childEnv, defaultKill } from "./sessions";

// 対話セッションの Windows 版：Bun の疑似端末（Bun.spawn の terminal。Windows では ConPTY）の中で claude を動かす。
// macOS / Linux でも動く（テストはこちらでも通す）が、本番の macOS / Linux は tmux を使う。
//
// - 疑似端末の出力は、端末エミュレーター（@xterm/headless）に流して画面として持つ。ConPTY は出力を描き直して送るので、
//   出力をそのまま行に切っても画面にならない。端末への問い合わせ（カーソル位置など）には、エミュレーターの返事を書き戻す
// - 状態はこのクライアントのメモリにだけある。クライアントが終わると疑似端末が閉じ、claude も終わる（tmux と違う）
// - claude は引数の配列で直接起動する（cmd や PowerShell を通さない）。環境変数からクライアント自身の設定を除く

export const COLS = 200;
export const ROWS = 50;
const KEEP_RAW = 4_000;
const KEEP_EXITED_MS = 30 * 60_000;

export type PtyChild = {
  pid: number;
  write(data: string): void;
  // 終了コード（シグナルで終わったなど、取れなければ null）
  exited: Promise<number | null>;
  close(): void;
};
export type PtySpawn = (
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; data: (chunk: Uint8Array) => void },
) => PtyChild;

export const bunPtySpawn: PtySpawn = (argv, opts) => {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
    terminal: { cols: opts.cols, rows: opts.rows, data: (_t, chunk) => opts.data(chunk) },
  });
  const terminal = proc.terminal!;
  return {
    pid: proc.pid,
    write: (data) => {
      if (!terminal.closed) terminal.write(data);
    },
    // terminal の exit コールバックは疑似端末の状態で、終了コードではない
    exited: proc.exited.then(() => proc.exitCode),
    close: () => {
      if (!terminal.closed) terminal.close();
    },
  };
};

// Bun.Terminal が ConPTY に対応したのは 1.3.14 から
export function bunSupportsConpty(version: string): boolean {
  const [a = 0, b = 0, c = 0] = version.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  return a > 1 || (a === 1 && (b > 3 || (b === 3 && c >= 14)));
}

// 疑似端末で動かす claude の環境変数。POSIX では端末の種類を伝える（Windows の端末は TERM を使わない）
export function ptyEnv(env: NodeJS.ProcessEnv, platform: Platform): NodeJS.ProcessEnv {
  const out = childEnv(env);
  delete out.TMUX;
  delete out.TMUX_PANE;
  if (platform !== "win32") out.TERM = "xterm-256color";
  return out;
}

type Entry = Row & { child: PtyChild; screen: Screen; decoder: TextDecoder; raw: string; url: string | null };

export type PtyBackendOptions = {
  platform: Platform;
  spawn?: PtySpawn;
  kill?: KillFn;
  now?: () => number;
  // クライアントが止まるときに、Ctrl+C のあと強制終了するまでの猶予
  shutdownGraceMs?: number;
  // 終了してから「終了」として扱うまでの待ち（遅れて届く出力を受け取るため）
  exitSettleMs?: number;
  // 強制終了のあと、疑似端末を閉じる前に終了を待つ上限
  killWaitMs?: number;
};

export class PtyBackend implements InteractiveBackend {
  private readonly entries = new Map<string, Entry>();
  private readonly spawn: PtySpawn;
  private readonly kill: KillFn;
  private readonly now: () => number;

  constructor(private readonly opts: PtyBackendOptions) {
    this.spawn = opts.spawn ?? bunPtySpawn;
    this.kill = opts.kill ?? defaultKill(opts.platform);
    this.now = opts.now ?? Date.now;
  }

  async rows(): Promise<Row[]> {
    return [...this.entries.values()].map(({ id, path, name, createdAt, dead, deadStatus, deadAt }) => ({ id, path, name, createdAt, dead, deadStatus, deadAt }));
  }

  async create(id: string, cwd: string, name: string, argv: string[]): Promise<string | null> {
    const screen = new Screen({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true });
    let entry: Entry | null = null;
    const pending: Uint8Array[] = [];
    const onData = (chunk: Uint8Array) => {
      if (!entry) {
        pending.push(chunk);
        return;
      }
      this.onOutput(entry, chunk);
    };
    let child: PtyChild;
    try {
      child = this.spawn(argv, { cwd, env: ptyEnv(process.env, this.opts.platform), cols: COLS, rows: ROWS, data: onData });
    } catch (err) {
      screen.dispose();
      const reason = err instanceof Error ? err.message.replace(/\s+/g, " ").slice(0, 160) : "原因不明";
      return `claude を起動できなかった（CLAUDE_BIN を確認）: ${reason}`;
    }
    const e: Entry = { id, path: cwd, name, createdAt: this.now(), dead: false, deadStatus: null, deadAt: null, child, screen, decoder: new TextDecoder(), raw: "", url: null };
    entry = e;
    this.entries.set(id, e);
    // 端末への問い合わせ（カーソル位置・色など）への返事を claude に返す。本物の端末と同じふるまいにする
    screen.onData((reply) => {
      if (!e.dead) e.child.write(reply);
    });
    for (const chunk of pending.splice(0)) this.onOutput(e, chunk);
    void child.exited.then(
      (code) => this.onExit(e, code),
      () => this.onExit(e, null),
    );
    return null;
  }

  private onOutput(e: Entry, chunk: Uint8Array): void {
    e.screen.write(chunk);
    if (e.url) return;
    // 画面の描き直しで消えても拾えるよう、生の出力からも URL を探す（チャンクの境目をまたいでもよいよう、末尾を持ち越す）
    // URL が出力の末尾で切れているかもしれないときは、次のチャンクを待つ
    e.raw = (e.raw + e.decoder.decode(chunk, { stream: true })).slice(-KEEP_RAW);
    const url = findScreenUrl(e.raw);
    if (url && !e.raw.endsWith(url)) {
      e.url = url;
      e.raw = "";
    }
  }

  private onExit(e: Entry, code: number | null): void {
    // ConPTY は終了より遅れて出力を届けることがある。終了直前の出力（trust の確認やエラーの表示など）を
    // 画面に入れてから「終了」にする（起動の待ちが、空の画面で終わらないように）
    setTimeout(() => {
      if (e.dead) return;
      e.dead = true;
      e.deadStatus = code;
      e.deadAt = this.now();
      setTimeout(() => e.child.close(), 1_000).unref?.();
      // 一覧が呼ばれなくても、終了したものが溜まり続けないよう片付ける（一覧での片付けと同じ30分）
      setTimeout(() => {
        if (this.entries.get(e.id) === e) void this.remove(e.id);
      }, KEEP_EXITED_MS + 60_000).unref?.();
    }, this.opts.exitSettleMs ?? 300).unref?.();
  }

  // 画面の表示部分を、折り返しをつないだ文字列にする（tmux の capture-pane -J と同じ）
  private async text(e: Entry): Promise<string> {
    await new Promise<void>((resolve) => e.screen.write("", resolve));
    const buf = e.screen.buffer.active;
    const lines: string[] = [];
    for (let i = buf.baseY; i < buf.baseY + e.screen.rows; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const s = line.translateToString(true);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += s;
      else lines.push(s);
    }
    return lines.join("\n");
  }

  async capture(id: string): Promise<{ raw: string; lines: string[] }> {
    const e = this.entries.get(id);
    if (!e) return { raw: "", lines: [] };
    const text = await this.text(e);
    return { raw: `${e.url ?? ""}\n${text}`, lines: screenTail(text) };
  }

  async paste(id: string, text: string): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e || e.dead) return false;
    await new Promise<void>((resolve) => e.screen.write("", resolve));
    // tmux の paste-buffer と同じく改行は CR で送る。claude が括弧付き貼り付けを有効にしていれば、その印で囲む
    const body = text.replace(/\n/g, "\r");
    e.child.write(e.screen.modes.bracketedPasteMode ? `\x1b[200~${body}\x1b[201~` : body);
    return true;
  }

  async key(id: string, key: InputKey | "C-c"): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e || e.dead) return false;
    await new Promise<void>((resolve) => e.screen.write("", resolve));
    const app = e.screen.modes.applicationCursorKeysMode;
    const seq = { Enter: "\r", Escape: "\x1b", Up: app ? "\x1bOA" : "\x1b[A", Down: app ? "\x1bOB" : "\x1b[B", "C-c": "\x03" }[key];
    // Esc は単独で書く（後ろの入力とつながると、エスケープ列の始まりと読まれる）
    e.child.write(seq);
    return true;
  }

  async remove(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    // 動いていれば先にプロセスツリーを止め、終わるのを待ってから疑似端末を閉じる。
    // 古い Windows（11 24H2 より前）は、子が動いたまま閉じると close が戻らないことがある
    if (!e.dead) {
      this.kill(e.child.pid, false);
      await Promise.race([e.child.exited.catch(() => null), new Promise((r) => setTimeout(r, this.opts.killWaitMs ?? 3_000).unref?.())]);
    }
    e.child.close();
    e.screen.dispose();
  }

  // クライアントが止まるとき：Ctrl+C を2回送って会話を保存させ、猶予のあと強制終了する
  shutdown(): void {
    const live = [...this.entries.values()].filter((e) => !e.dead);
    for (const e of live) e.child.write("\x03");
    setTimeout(() => {
      for (const e of live) if (!e.dead) e.child.write("\x03");
    }, 300).unref?.();
    setTimeout(() => {
      for (const e of live) if (!e.dead) this.kill(e.child.pid, false);
    }, this.opts.shutdownGraceMs ?? 2_000).unref?.();
  }
}
