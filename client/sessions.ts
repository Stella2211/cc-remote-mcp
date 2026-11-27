import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import nodePath from "node:path";
import { MAX_LINE_CHARS, MAX_SESSION_NAME_CHARS, MAX_OUTPUT_LINES, MAX_URL_CHARS } from "../shared/protocol";
import type { PERMISSION_MODES, SPAWN_MODES, SessionInfo } from "../shared/protocol";
import type { Platform } from "./paths";

// このクライアントが起動した `claude remote-control`（別名 `claude rc`）のプロセスだけを管理する。
// 他で起動された rc は見ない・止めない。コマンドは固定で、引数は配列で渡す（シェルを通さない）。

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; windowsHide: boolean; stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcess;

// プロセスツリーを止める。graceful=true は Ctrl+C 相当（rc のセッションは約4時間 --continue で戻せる）
export type KillFn = (pid: number, graceful: boolean) => void;

export type SessionManagerOptions = {
  platform: Platform;
  deviceName: string;
  claudeBin: string;
  maxSessions: number;
  // 対話セッションなど、同時実行数の上限に合算するほかのセッションの数
  othersActive?: () => Promise<number>;
  // 起動の検査と登録を、対話セッションの起動とも順番に行うための錠（上限を合算するので共有する）
  startLock?: StartLock;
  defaultPermissionMode: (typeof PERMISSION_MODES)[number] | null;
  spawn?: SpawnFn;
  kill?: KillFn;
  now?: () => number;
  // 起動直後の失敗（trust 未承認など）を待つ時間
  startupWaitMs?: number;
  // SIGINT のあと強制終了するまでの猶予
  killGraceMs?: number;
};

type Entry = {
  info: SessionInfo;
  child: ChildProcess | null;
  lines: string[];
  partial: string;
  waiters: (() => void)[];
  killTimer?: ReturnType<typeof setTimeout>;
};

const KEEP_EXITED_MS = 30 * 60_000;
const MAX_EXITED = 20;

// ANSI のエスケープ列と、それ以外の制御文字を除く
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
export function cleanLine(line: string): string {
  return line
    .replace(ANSI, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LINE_CHARS);
}

const SESSION_URL = /https:\/\/claude\.ai\/code[^\s"'<>()\[\]]*/;
export function findSessionUrl(line: string): string | null {
  const m = SESSION_URL.exec(line);
  return m ? m[0].slice(0, MAX_URL_CHARS) : null;
}

// 子プロセスに渡さない環境変数（このクライアント自身の設定）
const STRIP_ENV = /^(DEVICE_TOKEN|DEVICE_NAME|CF_ACCESS_CLIENT_ID|CF_ACCESS_CLIENT_SECRET|CC_REMOTE_MCP_.*|ALLOWED_ROOTS|BLOCKED_DIRS|TMUX_BIN)$/;
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(env)) if (!STRIP_ENV.test(k)) out[k] = v;
  return out;
}

export function defaultKill(platform: Platform, spawn: SpawnFn = nodeSpawn as unknown as SpawnFn): KillFn {
  return (pid, graceful) => {
    if (platform === "win32") {
      // Windows には Ctrl+C を別プロセスへ送る簡単な手段がないので、ツリーごと終了する（固定の引数）
      const p = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        cwd: process.cwd(),
        env: process.env,
        detached: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      p.on("error", () => {});
      return;
    }
    // detached で起動しているので -pid はそのプロセスグループ全体
    try {
      process.kill(-pid, graceful ? "SIGINT" : "SIGKILL");
    } catch {
      // すでに終わっている
    }
  };
}

export class SessionError extends Error {
  constructor(
    readonly code: "limit" | "spawn_failed" | "not_found" | "forbidden",
    message: string,
  ) {
    super(message);
  }
}

// 起動を1つずつ通す錠。要求は並行に処理されるので、上限と同じディレクトリの検査から登録までを
// この中で行わないと、同時に来た2つの起動が両方とも検査を通ってしまう
export class StartLock {
  private tail: Promise<void> = Promise.resolve();
  // 錠を持っているものと待っているものの数
  private count = 0;

  run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    // 誰も持っていなければ、その場で始める（最初の await までは同期のまま進む）
    let result: Promise<T>;
    try {
      result = this.count++ === 0 ? fn() : prev.then(fn);
    } catch (err) {
      result = Promise.reject(err);
    }
    return result.finally(() => {
      this.count--;
      release();
    });
  }
}

export class SessionManager {
  private entries = new Map<string, Entry>();
  private readonly spawnFn: SpawnFn;
  private readonly killFn: KillFn;
  private readonly now: () => number;
  private readonly startLock: StartLock;

  constructor(private readonly opts: SessionManagerOptions) {
    this.spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
    this.killFn = opts.kill ?? defaultKill(opts.platform);
    this.now = opts.now ?? Date.now;
    this.startLock = opts.startLock ?? new StartLock();
  }

  list(): SessionInfo[] {
    this.prune();
    return [...this.entries.values()].map((e) => this.snapshot(e));
  }

  private snapshot(e: Entry): SessionInfo {
    return { ...e.info, lastOutput: [...e.lines] };
  }

  private prune(): void {
    const exited = [...this.entries.values()].filter((e) => e.info.status === "exited");
    const cutoff = this.now() - KEEP_EXITED_MS;
    exited
      .filter((e, i) => (e.info.exitedAt ?? 0) < cutoff || i < exited.length - MAX_EXITED)
      .forEach((e) => this.entries.delete(e.info.id));
  }

  // 動いている rc の数（対話セッションと同時実行数の上限を合算するため）
  activeCount(): number {
    return this.active().length;
  }

  private active(): Entry[] {
    return [...this.entries.values()].filter((e) => e.info.status !== "exited");
  }

  async start(realPath: string, params: { name?: string; spawn?: (typeof SPAWN_MODES)[number]; permissionMode?: (typeof PERMISSION_MODES)[number] }): Promise<SessionInfo> {
    // 検査から登録までを錠の中で行う。起動直後の待ちは錠の外
    const entry = await this.startLock.run(() => this.spawnChecked(realPath, params));

    // 起動直後に落ちたか（trust 未承認・未ログインなど）、URL が出たか、待ち時間が過ぎるまで待つ
    // （錠を出るまでの間にもう落ちたり URL が出たりしていれば待たない）
    if (entry.info.status === "starting") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, this.opts.startupWaitMs ?? 8_000);
        function done() {
          clearTimeout(timer);
          resolve();
        }
        entry.waiters.push(done);
      });
    }
    if (entry.info.status === "starting") entry.info.status = "running";
    return this.snapshot(entry);
  }

  private async spawnChecked(
    realPath: string,
    params: { name?: string; spawn?: (typeof SPAWN_MODES)[number]; permissionMode?: (typeof PERMISSION_MODES)[number] },
  ): Promise<Entry> {
    const fold = (p: string) => (this.opts.platform === "linux" ? p : p.toLowerCase());
    const others = this.opts.othersActive ? await this.opts.othersActive() : 0;
    const running = this.active();
    if (running.length + others >= this.opts.maxSessions) {
      throw new SessionError("limit", `この端末で同時に動かせるセッションは ${this.opts.maxSessions} 個まで（MAX_SESSIONS。rc と対話セッションの合計）`);
    }
    if (running.some((e) => fold(e.info.path) === fold(realPath))) {
      throw new SessionError("limit", "同じディレクトリで rc がすでに動いている");
    }

    const base = (this.opts.platform === "win32" ? nodePath.win32 : nodePath.posix).basename(realPath);
    const name = (params.name ?? `${this.opts.deviceName}-${base}`).slice(0, MAX_SESSION_NAME_CHARS);
    const args = ["remote-control", "--name", name, "--spawn", params.spawn ?? "same-dir"];
    const mode = params.permissionMode ?? this.opts.defaultPermissionMode;
    if (mode) args.push("--permission-mode", mode);

    const id = `rc_${randomBytes(12).toString("base64url")}`;
    const entry: Entry = {
      info: {
        id,
        path: realPath,
        name,
        status: "starting",
        pid: null,
        startedAt: this.now(),
        exitedAt: null,
        exitCode: null,
        url: null,
        lastOutput: [],
      },
      child: null,
      lines: [],
      partial: "",
      waiters: [],
    };

    let child: ChildProcess;
    try {
      child = this.spawnFn(this.opts.claudeBin, args, {
        cwd: realPath,
        env: childEnv(process.env),
        // POSIX では新しいプロセスグループにして、止めるときにツリーごと送れるようにする（端末も切り離す）
        detached: this.opts.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new SessionError("spawn_failed", "claude を起動できなかった（CLAUDE_BIN を確認）");
    }
    // 実行ファイルが無い・実行できない（ENOENT / EACCES）とき、spawn は同期では投げず、pid の無い子を返して
    // あとから error イベントで知らせる。錠の中で pid の有無を見て、登録せずに失敗させる
    // （error を待ってからだと、錠を出たあとも一瞬だけ上限と同じディレクトリの検査に数えられてしまう）
    if (child.pid === undefined) {
      child.on("error", () => {});
      throw new SessionError("spawn_failed", "claude コマンドを起動できなかった（CLAUDE_BIN を確認）");
    }
    entry.child = child;
    entry.info.pid = child.pid;
    this.entries.set(id, entry);

    const onData = (chunk: Buffer | string) => this.onOutput(entry, chunk.toString());
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", () => this.onExit(entry, null));
    child.on("exit", (code) => this.onExit(entry, code));
    return entry;
  }

  private wake(entry: Entry): void {
    const waiters = entry.waiters.splice(0);
    for (const w of waiters) w();
  }

  private onOutput(entry: Entry, text: string): void {
    const parts = (entry.partial + text).split(/\r?\n|\r/);
    entry.partial = (parts.pop() ?? "").slice(-4096);
    for (const raw of parts) {
      const line = cleanLine(raw);
      if (!line) continue;
      entry.lines.push(line);
      if (entry.lines.length > MAX_OUTPUT_LINES) entry.lines.shift();
      if (!entry.info.url) {
        const url = findSessionUrl(line);
        if (url) {
          entry.info.url = url;
          if (entry.info.status === "starting") entry.info.status = "running";
          this.wake(entry);
        }
      }
    }
  }

  private onExit(entry: Entry, code: number | null): void {
    if (entry.info.status === "exited") return;
    if (entry.partial) this.onOutput(entry, "\n");
    entry.info.status = "exited";
    entry.info.exitedAt = this.now();
    entry.info.exitCode = code;
    if (entry.killTimer) clearTimeout(entry.killTimer);
    entry.child = null;
    // POSIX では rc 本体が終わってもグループに子が残ることがあるので、一度だけ強制終了を送る
    // （グループに誰もいなければ何も起きない）
    if (this.opts.platform !== "win32" && entry.info.pid !== null) this.killFn(entry.info.pid, false);
    this.wake(entry);
  }

  stop(id: string): SessionInfo {
    const entry = this.entries.get(id);
    if (!entry) throw new SessionError("not_found", "その ID の rc はこのクライアントの管理下にない");
    if (entry.info.status === "exited") return this.snapshot(entry);
    const pid = entry.info.pid;
    if (pid === null) throw new SessionError("not_found", "プロセスIDが不明");
    if (entry.info.status === "stopping") {
      // 止まりきらないまま再び頼まれたら、強制終了を送り直す
      this.killFn(pid, false);
      return this.snapshot(entry);
    }
    entry.info.status = "stopping";
    this.killFn(pid, true);
    entry.killTimer = setTimeout(() => {
      if (entry.info.status !== "exited") this.killFn(pid, false);
    }, this.opts.killGraceMs ?? 10_000);
    entry.killTimer.unref?.();
    return this.snapshot(entry);
  }

  // クライアント終了時に、起動した rc をすべて止める（Ctrl+C 相当のあと、graceMs で強制終了）
  stopAll(graceMs = 2_500): void {
    const pids = this.active()
      .map((e) => e.info.pid)
      .filter((p): p is number => p !== null);
    for (const pid of pids) this.killFn(pid, true);
    setTimeout(() => {
      for (const e of this.active()) if (e.info.pid !== null) this.killFn(e.info.pid, false);
    }, graceMs).unref?.();
  }
}
