import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { MAX_SESSION_NAME_CHARS } from "../shared/protocol";
import type { InputKey, InteractiveBackend, Row } from "./interactive";
import { isInteractiveId, screenTail } from "./interactive";
import { childEnv, cleanLine } from "./sessions";

// 対話セッションの macOS / Linux 版：tmux の中で claude を動かす。
//
// - tmux は専用のソケット（-L cc-remote-mcp）と空の設定（-f /dev/null）で動かす。利用者自身の tmux とは混ざらない
// - 状態は tmux 側にだけある。クライアントを再起動しても、セッションは tmux の中で動き続け、一覧にも出る（Linux の systemd は KillMode=mixed でサービスの cgroup ごと止めるので、tmux も一緒に止まる）
// - コマンドは固定で、引数は配列で渡す（シェルを通さない）。入力は tmux の貼り付けバッファへ標準入力で渡す
// - 起動場所は -c で渡さない（tmux は -c の値を書式として展開し、#(…) でコマンドを動かしてしまう）。tmux 自体をその場所で起動する

export const TMUX_SOCKET = "cc-remote-mcp";

export type TmuxResult = { code: number | null; stdout: string; stderr: string };
// tmux を引数配列で実行する。input があれば標準入力に流し、cwd があればそこで起動する
export type TmuxRunner = (args: string[], input?: string, cwd?: string) => Promise<TmuxResult>;

export function defaultTmuxRunner(tmuxBin: string, env: NodeJS.ProcessEnv): TmuxRunner {
  return (args, input, cwd) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let child: ReturnType<typeof nodeSpawn>;
      try {
        // tmux は PWD が同じ場所を指すと PWD をそのまま使う（シンボリックリンクの名前が残る）ので、実体パスに揃える
        child = nodeSpawn(tmuxBin, args, { cwd, env: cwd ? { ...env, PWD: cwd } : env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch {
        resolve({ code: null, stdout: "", stderr: "spawn failed" });
        return;
      }
      child.stdout?.on("data", (c: Buffer) => {
        if (stdout.length < 1_000_000) stdout += c.toString();
      });
      child.stderr?.on("data", (c: Buffer) => {
        if (stderr.length < 10_000) stderr += c.toString();
      });
      child.on("error", () => resolve({ code: null, stdout, stderr: stderr || "spawn failed" }));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin?.on("error", () => {});
      child.stdin?.end(input ?? "");
    });
}

// tmux に渡す環境変数。クライアント自身の設定を除き、外側の tmux の変数も外す
export function tmuxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = childEnv(env);
  delete out.TMUX;
  delete out.TMUX_PANE;
  return out;
}

const KEY_NAMES: Record<InputKey | "C-c", string> = { Enter: "Enter", Escape: "Escape", Up: "Up", Down: "Down", "C-c": "C-c" };
const FORMAT = ["#{session_name}", "#{session_created}", "#{pane_dead}", "#{pane_dead_status}", "#{pane_dead_time}"].join(" ");

export class TmuxBackend implements InteractiveBackend {
  constructor(readonly run: TmuxRunner) {}

  private exec(args: string[], input?: string, cwd?: string): Promise<TmuxResult> {
    // -u: 環境変数のロケールに関わらず UTF-8 として扱う（launchd などで LANG が無いと日本語が _ になる）
    return this.run(["-u", "-L", TMUX_SOCKET, "-f", "/dev/null", ...args], input, cwd);
  }

  async rows(): Promise<Row[]> {
    const r = await this.exec(["list-sessions", "-F", FORMAT]);
    // サーバーが動いていない（セッションが1つもない）ときは失敗で返ってくる
    if (r.code !== 0) return [];
    const num = (v: string | undefined) => (v && /^-?\d+$/.test(v) ? Number(v) : null);
    const rows: Row[] = [];
    for (const line of r.stdout.split("\n")) {
      // 数値の欄だけを空白区切りで並べる（tmux は -F の出力のタブを _ に置き換えるので、区切りに使えない）
      const [id, created, dead, status, deadTime] = line.split(" ");
      if (!id || !isInteractiveId(id)) continue;
      const deadAt = num(deadTime);
      rows.push({
        id,
        // 場所と名前は区切り文字を含みうるので、1欄ずつ取る
        path: await this.field(id, "#{session_path}"),
        name: (await this.field(id, "#{@cc_remote_mcp_name}")).slice(0, MAX_SESSION_NAME_CHARS),
        createdAt: (num(created) ?? 0) * 1000,
        dead: dead === "1",
        deadStatus: num(status),
        deadAt: deadAt === null ? null : deadAt * 1000,
      });
    }
    return rows;
  }

  private async field(id: string, format: string): Promise<string> {
    const r = await this.exec(["display-message", "-p", "-t", `=${id}:`, format]);
    return r.code === 0 ? r.stdout.replace(/\n$/, "") : "";
  }

  async create(id: string, cwd: string, name: string, argv: string[]): Promise<string | null> {
    // 1回の tmux 呼び出しで、作成と設定をまとめて行う（claude がすぐ終わっても画面を残せるように）
    // 起動場所は -c ではなく tmux を起動する場所で渡す。-c の値は書式として展開され（#(…) はコマンドの実行、#{…} は置き換え）、
    // 末尾の ; は区切りとして読まれるため。-c が無いと、tmux は呼び出した側の作業ディレクトリを新しいセッションの場所にする
    const r = await this.exec(
      [
        "new-session", "-d", "-s", id, "-x", "200", "-y", "50", "--", ...argv,
        ";", "set-option", "-t", `=${id}:`, "remain-on-exit", "on",
        ";", "set-option", "-t", `=${id}:`, "@cc_remote_mcp_name", name,
      ],
      undefined,
      cwd,
    );
    if (r.code !== 0) return `tmux でセッションを作れなかった: ${cleanLine(r.stderr).slice(0, 200) || "原因不明"}`;
    // 検査済みの場所で始まったかを確かめる。違えば消して失敗にする
    const path = await this.field(id, "#{session_path}");
    if (path === cwd) return null;
    await this.remove(id);
    return "tmux のセッションが指定の場所で始まらなかった";
  }

  async capture(id: string): Promise<{ raw: string; lines: string[] }> {
    // -e で取り込むと OSC 8 のリンク先も入る（tmux の版による）。表示用の行は ANSI を除いて作る
    const r = await this.exec(["capture-pane", "-p", "-e", "-J", "-t", `=${id}:`]);
    if (r.code !== 0) return { raw: "", lines: [] };
    return { raw: r.stdout, lines: screenTail(r.stdout) };
  }

  async paste(id: string, text: string): Promise<boolean> {
    // 標準入力で貼り付けバッファに入れて、括弧付き貼り付け（-p）で流す。複数行でも途中で確定されない
    const buffer = `cc_remote_mcp_${randomBytes(6).toString("hex")}`;
    const loaded = await this.exec(["load-buffer", "-b", buffer, "-"], text);
    if (loaded.code !== 0) return false;
    const pasted = await this.exec(["paste-buffer", "-p", "-d", "-b", buffer, "-t", `=${id}:`]);
    if (pasted.code !== 0) {
      await this.exec(["delete-buffer", "-b", buffer]);
      return false;
    }
    return true;
  }

  async key(id: string, key: InputKey | "C-c"): Promise<boolean> {
    return (await this.exec(["send-keys", "-t", `=${id}:`, KEY_NAMES[key]])).code === 0;
  }

  async remove(id: string): Promise<void> {
    await this.exec(["kill-session", "-t", `=${id}`]);
  }
}
