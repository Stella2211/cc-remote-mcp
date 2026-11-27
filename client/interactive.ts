import { randomBytes } from "node:crypto";
import nodePath from "node:path";
import { INTERACTIVE_ID_RE, MAX_SESSION_NAME_CHARS, MAX_OUTPUT_LINES, MAX_PATH_CHARS, MAX_URL_CHARS } from "../shared/protocol";
import type { INPUT_KEYS, InteractiveInfo, PERMISSION_MODES } from "../shared/protocol";
import type { Platform } from "./paths";
import { SessionError, StartLock, cleanLine } from "./sessions";

// 対話セッション：端末の中で `claude --remote-control` を起動し、最初のプロンプトを渡す。
// サーバーモードの rc（sessions.ts）と違って、起動した時点で claude.ai にセッションができ、あとから入力も送れる。
//
// 端末の用意は OS ごとのバックエンドに任せ、ここでは共通の手順（上限、名前と ID、引数、起動の待ち、ログ、停止の段階）だけを持つ。
// - macOS / Linux：tmux（interactive-tmux.ts）。状態は tmux 側にあり、クライアントを再起動しても動き続ける（Linux の systemd は KillMode=mixed でサービスの cgroup ごと止めるので、tmux も一緒に止まる）
// - Windows：Bun の疑似端末（ConPTY。interactive-pty.ts）。状態はクライアントのメモリにあり、クライアントと一緒に終わる

export type InputKey = (typeof INPUT_KEYS)[number];

// バックエンドが返すセッションの1行
export type Row = { id: string; path: string; name: string; createdAt: number; dead: boolean; deadStatus: number | null; deadAt: number | null };

export interface InteractiveBackend {
  // このバックエンドが持つ cc_ のセッション（終了済みも含む）
  rows(): Promise<Row[]>;
  // argv[0] は claude の実行ファイル。失敗したら理由の文字列を返す
  create(id: string, cwd: string, name: string, argv: string[]): Promise<string | null>;
  // raw は URL を探すための生の文字列、lines は表示用の画面の末尾
  capture(id: string): Promise<{ raw: string; lines: string[] }>;
  // 括弧付き貼り付けとして流す（途中の改行で確定させない）
  paste(id: string, text: string): Promise<boolean>;
  key(id: string, key: InputKey | "C-c"): Promise<boolean>;
  // セッションごと消す（生きていれば強制終了する）
  remove(id: string): Promise<void>;
  // クライアントが止まるときの片付け（tmux は何もしない）
  shutdown?(): void;
}

export const isInteractiveId = (id: string) => INTERACTIVE_ID_RE.test(id);

// 画面の取り込みからセッションURLを探す。OSC 8 のリンク（tmux の capture-pane -e や生の出力）の中も見る
const SCREEN_URL = /https:\/\/claude\.ai\/code[^\s"'<>()[\]\x00-\x1f\x7f]*/;
export function findScreenUrl(raw: string): string | null {
  const m = SCREEN_URL.exec(raw);
  return m ? m[0].slice(0, MAX_URL_CHARS) : null;
}

export function screenTail(raw: string, max = MAX_OUTPUT_LINES): string[] {
  return raw
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean)
    .slice(-max);
}

// tmux は「; で終わる引数」を区切りとして読む。また claude（commander）は最初の位置引数が
// サブコマンド名（install など）と同じだとサブコマンドとして実行する。末尾に空白を1つ足すと、どちらも起きない
export function promptArg(prompt: string): string {
  return `${prompt} `;
}

// 遠隔から選べる権限モードを、対話モードの claude の引数に直す。対話モードの選択肢に default は無く、同じ意味の manual を使う
export function interactiveModeArg(mode: (typeof PERMISSION_MODES)[number]): string {
  return mode === "default" ? "manual" : mode;
}

export type InteractiveOptions = {
  platform: Platform;
  deviceName: string;
  claudeBin: string;
  // null は対話セッションを使えない（unavailable にその理由）
  backend: InteractiveBackend | null;
  unavailable?: string;
  defaultPermissionMode: (typeof PERMISSION_MODES)[number] | null;
  // 起動中のサーバーモード rc の数（同時実行数の上限を合算するため）
  activeRc: () => number;
  maxSessions: number;
  // 起動の検査と登録を、rc の起動とも順番に行うための錠（上限を合算するので共有する）
  startLock?: StartLock;
  log: (event: Record<string, unknown>) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  startupWaitMs?: number;
  pollMs?: number;
  killGraceMs?: number;
};

const KEEP_EXITED_MS = 30 * 60_000;

export class InteractiveManager {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly startLock: StartLock;

  constructor(private readonly opts: InteractiveOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.startLock = opts.startLock ?? new StartLock();
  }

  private backend(): InteractiveBackend {
    if (!this.opts.backend) throw new SessionError("spawn_failed", this.opts.unavailable ?? "この端末では対話セッションを使えない");
    return this.opts.backend;
  }

  private async rows(): Promise<Row[]> {
    if (!this.opts.backend) return [];
    return (await this.opts.backend.rows()).filter((r) => isInteractiveId(r.id));
  }

  private info(row: Row, screen: string[] = [], url: string | null = null): InteractiveInfo {
    return {
      id: row.id,
      path: row.path.slice(0, MAX_PATH_CHARS),
      name: row.name.slice(0, MAX_SESSION_NAME_CHARS),
      status: row.dead ? "exited" : "running",
      startedAt: row.createdAt,
      exitCode: row.dead ? row.deadStatus : null,
      url,
      screen,
    };
  }

  async activeCount(): Promise<number> {
    return (await this.rows()).filter((r) => !r.dead).length;
  }

  async list(): Promise<InteractiveInfo[]> {
    const rows = await this.rows();
    const cutoff = this.now() - KEEP_EXITED_MS;
    const out: InteractiveInfo[] = [];
    for (const row of rows) {
      if (row.dead && row.deadAt !== null && row.deadAt < cutoff) {
        // 終わってから30分たったものは片付ける
        await this.backend().remove(row.id);
        continue;
      }
      // 終了したものだけ、原因を見られるよう画面の末尾を付ける
      out.push(this.info(row, row.dead ? (await this.backend().capture(row.id)).lines : []));
    }
    return out;
  }

  private async find(id: string): Promise<Row> {
    const row = (await this.rows()).find((r) => r.id === id);
    if (!row) throw new SessionError("not_found", "その ID の対話セッションはこのクライアントの管理下にない");
    return row;
  }

  async start(
    realPath: string,
    params: { prompt: string; name?: string; permissionMode?: (typeof PERMISSION_MODES)[number]; worktree?: boolean },
  ): Promise<InteractiveInfo> {
    const backend = this.backend();
    const base = (this.opts.platform === "win32" ? nodePath.win32 : nodePath.posix).basename(realPath);
    // 自動で付ける名前も tmux の区切りにならないよう、末尾の ; を除く
    const name = (params.name ?? `${this.opts.deviceName}-${base}`).slice(0, MAX_SESSION_NAME_CHARS).replace(/;+$/, "") || this.opts.deviceName;
    const id = `cc_${randomBytes(12).toString("base64url")}`;

    const argv = [this.opts.claudeBin, `--remote-control=${name}`, "--name", name];
    const mode = params.permissionMode ?? this.opts.defaultPermissionMode;
    if (mode) argv.push("--permission-mode", interactiveModeArg(mode));
    if (params.worktree) argv.push("--worktree");
    // -- の後ろは位置引数（プロンプトが - で始まってもフラグとして読まれない）
    argv.push("--", promptArg(params.prompt));

    // 上限の検査から、入れ物にセッションができる（一覧に出る）までを錠の中で行う。起動直後の待ちは錠の外
    await this.startLock.run(async () => {
      const active = this.opts.activeRc() + (await this.activeCount());
      if (active >= this.opts.maxSessions) {
        throw new SessionError("limit", `この端末で同時に動かせるセッションは ${this.opts.maxSessions} 個まで（MAX_SESSIONS。rc と対話セッションの合計）`);
      }
      const failed = await backend.create(id, realPath, name, argv);
      this.opts.log({ interactive: "start", device: this.opts.deviceName, session: id, path: realPath, name, promptChars: params.prompt.length, ok: failed === null });
      if (failed !== null) throw new SessionError("spawn_failed", failed);
    });

    // 終了したか、URL が出たか、待ち時間が過ぎるまで画面を見る
    const deadline = this.now() + (this.opts.startupWaitMs ?? 8_000);
    let row: Row | null = null;
    let shot = { raw: "", lines: [] as string[] };
    let url: string | null = null;
    for (;;) {
      row = (await this.rows()).find((x) => x.id === id) ?? null;
      shot = await backend.capture(id);
      url = findScreenUrl(shot.raw);
      if (!row || row.dead || url || this.now() >= deadline) break;
      await this.sleep(this.opts.pollMs ?? 500);
    }
    if (!row) {
      return { id, path: realPath, name, status: "exited", startedAt: this.now(), exitCode: null, url: null, screen: shot.lines };
    }
    return this.info(row, shot.lines, url);
  }

  async send(id: string, input: { text?: string; key?: InputKey; submit?: boolean }): Promise<InteractiveInfo> {
    const backend = this.backend();
    const row = await this.find(id);
    if (row.dead) throw new SessionError("not_found", "その対話セッションはもう終了している");

    if (input.key) {
      this.opts.log({ interactive: "input", device: this.opts.deviceName, session: id, key: input.key });
      if (!(await backend.key(id, input.key))) throw new SessionError("spawn_failed", "キーを送れなかった");
      return this.info(row);
    }

    const text = (input.text ?? "").replace(/\r\n?/g, "\n");
    const submit = input.submit ?? true;
    this.opts.log({ interactive: "input", device: this.opts.deviceName, session: id, textChars: text.length, submit });
    if (!(await backend.paste(id, text))) throw new SessionError("spawn_failed", "入力を貼り付けられなかった");
    if (submit) {
      // 貼り付けの直後に Enter を送ると貼り付けの一部と見なされることがあるので、少し待つ
      await this.sleep(300);
      if (!(await backend.key(id, "Enter"))) throw new SessionError("spawn_failed", "Enter を送れなかった");
    }
    return this.info(row);
  }

  // Ctrl+C を2回送って claude を終わらせ、猶予のあとセッションごと消す（会話は端末で claude --resume で戻せる）
  async stop(id: string): Promise<InteractiveInfo> {
    const backend = this.backend();
    const row = await this.find(id);
    this.opts.log({ interactive: "stop", device: this.opts.deviceName, session: id });
    if (row.dead) {
      await backend.remove(id);
      return this.info(row);
    }
    await backend.key(id, "C-c");
    await this.sleep(300);
    await backend.key(id, "C-c");
    const timer = setTimeout(() => {
      void backend.remove(id).catch(() => {});
    }, this.opts.killGraceMs ?? 10_000);
    timer.unref?.();
    return { ...this.info(row), status: "stopping" };
  }

  // クライアントが止まるとき。tmux のセッションは残し、クライアントと一緒に終わるもの（Windows）は Ctrl+C で片付ける
  shutdown(): void {
    this.opts.backend?.shutdown?.();
  }
}
