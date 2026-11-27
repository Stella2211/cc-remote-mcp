import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { PassThrough } from "node:stream";
import { InteractiveManager, findScreenUrl, interactiveModeArg, promptArg, screenTail } from "../client/interactive";
import { TmuxBackend, type TmuxRunner, defaultTmuxRunner, tmuxEnv } from "../client/interactive-tmux";
import { SessionManager, StartLock } from "../client/sessions";

type Session = { id: string; path: string; name: string; created: number; dead: boolean; status: number | null; deadTime: number | null; screen: string };

// tmux の代役。セッションの表を持ち、使われたコマンドを記録する。本物と同じく、-c が無ければ起動した場所をセッションの場所にする
function fakeTmux(sessions: Session[] = []) {
  const calls: { args: string[]; input?: string; cwd?: string }[] = [];
  const run: TmuxRunner = async (all, input, cwd) => {
    calls.push({ args: all, input, cwd });
    const args = all.slice(5); // -u -L cc-remote-mcp -f /dev/null
    const target = (args[args.indexOf("-t") + 1] ?? "").replace(/^=/, "").replace(/:$/, "");
    const find = () => sessions.find((s) => s.id === target);
    switch (args[0]) {
      case "list-sessions":
        if (sessions.length === 0) return { code: 1, stdout: "", stderr: "no server running" };
        return {
          code: 0,
          stdout: sessions.map((s) => [s.id, s.created, s.dead ? 1 : 0, s.status ?? "", s.deadTime ?? ""].join(" ")).join("\n") + "\n",
          stderr: "",
        };
      case "display-message": {
        const s = find();
        if (!s) return { code: 1, stdout: "", stderr: "can't find session" };
        return { code: 0, stdout: `${args.at(-1) === "#{session_path}" ? s.path : s.name}\n`, stderr: "" };
      }
      case "capture-pane":
        return find() ? { code: 0, stdout: find()!.screen, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      case "kill-session":
        sessions.splice(sessions.findIndex((s) => s.id === target), 1);
        return { code: 0, stdout: "", stderr: "" };
      case "new-session": {
        const id = args[args.indexOf("-s") + 1]!;
        sessions.push({ id, path: args.includes("-c") ? args[args.indexOf("-c") + 1]! : (cwd ?? "/"), name: args.at(-1)!, created: 1_700_000_000, dead: false, status: null, deadTime: null, screen: "Welcome\n\x1b]8;;https://claude.ai/code/session_01abc\x1b\\/rc active\x1b]8;;\x1b\\\n" });
        return { code: 0, stdout: "", stderr: "" };
      }
      default:
        return { code: 0, stdout: "", stderr: "" };
    }
  };
  return { run, calls, sessions };
}

function setup(over: Partial<ConstructorParameters<typeof InteractiveManager>[0]> = {}, sessions: Session[] = []) {
  const tmux = fakeTmux(sessions);
  const logs: Record<string, unknown>[] = [];
  const backend = new TmuxBackend(tmux.run);
  const manager = new InteractiveManager({
    platform: "darwin",
    deviceName: "box",
    claudeBin: "/opt/homebrew/bin/claude",
    backend,
    defaultPermissionMode: null,
    activeRc: () => 0,
    maxSessions: 2,
    log: (e) => logs.push(e),
    now: () => 1_700_000_100_000,
    sleep: async () => {},
    startupWaitMs: 0,
    ...over,
  });
  return { manager, backend, logs, ...tmux };
}

const alive = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  path: "/Users/me/dev/app",
  name: "box-app",
  created: 1_700_000_000,
  dead: false,
  status: null,
  deadTime: null,
  screen: "",
  ...over,
});

describe("helpers", () => {
  test("promptArg never ends with ; and never equals a bare subcommand", () => {
    for (const p of ["install", "x;", "a\\;", ";"]) {
      expect(promptArg(p).endsWith(";")).toBe(false);
      expect(promptArg(p).trim()).toBe(p);
    }
  });

  test("interactiveModeArg maps default to manual", () => {
    expect(interactiveModeArg("default")).toBe("manual");
    expect(interactiveModeArg("plan")).toBe("plan");
  });

  test("findScreenUrl reads OSC 8 links and stops at control characters", () => {
    expect(findScreenUrl("x \x1b]8;;https://claude.ai/code/session_01abc\x1b\\/rc active")).toBe("https://claude.ai/code/session_01abc");
    expect(findScreenUrl("https://claude.ai/code/session_x?y=1 more")).toBe("https://claude.ai/code/session_x?y=1");
    expect(findScreenUrl("https://example.com/claude.ai/code")).toBeNull();
  });

  test("screenTail drops ANSI and empty lines", () => {
    expect(screenTail("\x1b[1mhello\x1b[0m\n\n\nworld\n")).toEqual(["hello", "world"]);
  });

  test("tmuxEnv strips the client's own settings and the outer tmux", () => {
    const env = tmuxEnv({ PATH: "/bin", DEVICE_TOKEN: "x", TMUX: "/tmp/s,1,0", TMUX_PANE: "%1", TMUX_BIN: "/t", CF_ACCESS_CLIENT_SECRET: "s" } as unknown as NodeJS.ProcessEnv);
    expect(env as unknown).toEqual({ PATH: "/bin" });
  });
});

describe("InteractiveManager", () => {
  test("start creates a tmux session on the dedicated socket and returns the url", async () => {
    const { manager, calls, logs } = setup({ defaultPermissionMode: "acceptEdits" });
    const s = await manager.start("/Users/me/dev/app", { prompt: "テストを直して\n2行目", name: "修正", worktree: true });
    expect(s).toMatchObject({ status: "running", path: "/Users/me/dev/app", name: "修正", url: "https://claude.ai/code/session_01abc" });
    expect(s.id).toMatch(/^cc_/);
    const create = calls.find((c) => c.args.includes("new-session"))!.args;
    expect(create.slice(0, 5)).toEqual(["-u", "-L", "cc-remote-mcp", "-f", "/dev/null"]);
    expect(create.slice(create.indexOf("/opt/homebrew/bin/claude"))).toEqual([
      "/opt/homebrew/bin/claude",
      "--remote-control=修正",
      "--name",
      "修正",
      "--permission-mode",
      "acceptEdits",
      "--worktree",
      "--",
      "テストを直して\n2行目 ",
      ";",
      "set-option",
      "-t",
      `=${s.id}:`,
      "remain-on-exit",
      "on",
      ";",
      "set-option",
      "-t",
      `=${s.id}:`,
      "@cc_remote_mcp_name",
      "修正",
    ]);
    expect(logs[0]).toMatchObject({ interactive: "start", device: "box", session: s.id, promptChars: "テストを直して\n2行目".length });
    expect(JSON.stringify(logs)).not.toContain("テストを直して");
  });

  test("start passes the directory as the tmux working directory, never as a -c value", async () => {
    // tmux は -c の値を書式として展開する（#(…) はシェルで実行、#{…} は置き換え）。末尾の ; は区切りになる
    for (const dir of ["/Users/me/a#(touch pwned)b", "/Users/me/h#{host}x", "/Users/me/semi;", "/Users/me/##;"]) {
      const { manager, calls } = setup();
      const s = await manager.start(dir, { prompt: "hi", name: "n" });
      expect(s).toMatchObject({ status: "running", path: dir });
      const create = calls.find((c) => c.args.includes("new-session"))!;
      expect(create.cwd).toBe(dir);
      expect(create.args).not.toContain("-c");
      expect(create.args.some((a) => a.includes(dir))).toBe(false);
      expect(create.args.filter((a) => a !== ";" && a.endsWith(";"))).toEqual([]);
      expect(calls.filter((c) => c.cwd !== undefined).length).toBe(1);
    }
  });

  test("start kills the session and fails when tmux started it somewhere else", async () => {
    const { manager, backend, sessions, calls } = setup();
    const run = backend.run;
    (backend as unknown as { run: TmuxRunner }).run = async (args, input, cwd) => {
      const r = await run(args, input, cwd);
      if (args.includes("new-session")) sessions.at(-1)!.path = "/Users/me";
      return r;
    };
    await expect(manager.start("/Users/me/dev/app", { prompt: "hi" })).rejects.toMatchObject({ code: "spawn_failed", message: "tmux のセッションが指定の場所で始まらなかった" });
    expect(calls.some((c) => c.args.includes("kill-session"))).toBe(true);
    expect(sessions).toEqual([]);
  });

  test("start reports an immediate exit with the screen", async () => {
    const { manager, backend, sessions } = setup({ startupWaitMs: 1000 });
    const run = backend.run;
    // 作った直後に終了したことにする
    (backend as unknown as { run: TmuxRunner }).run = async (args, input, cwd) => {
      const r = await run(args, input, cwd);
      if (args.includes("new-session")) Object.assign(sessions.at(-1)!, { dead: true, status: 1, deadTime: 1_700_000_050, screen: "error: Unknown option\n" });
      return r;
    };
    const s = await manager.start("/Users/me/dev/app", { prompt: "hi" });
    expect(s).toMatchObject({ status: "exited", exitCode: 1, screen: ["error: Unknown option"] });
  });

  test("start counts rc and interactive sessions against MAX_SESSIONS", async () => {
    const { manager, calls } = setup({ activeRc: () => 1 }, [alive("cc_aaaaaaaa")]);
    await expect(manager.start("/Users/me/dev/app", { prompt: "hi" })).rejects.toMatchObject({ code: "limit" });
    expect(calls.some((c) => c.args.includes("new-session"))).toBe(false);
  });

  // 要求は並行に処理される。tmux の一覧を待つ間に別の起動が割り込んでも、上限をすり抜けない
  test("concurrent starts at the limit create no more than MAX_SESSIONS", async () => {
    const { manager, calls } = setup({}, [alive("cc_aaaaaaaa")]);
    const results = await Promise.allSettled([
      manager.start("/Users/me/dev/app", { prompt: "a" }),
      manager.start("/Users/me/dev/app", { prompt: "b" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "limit" });
    expect(calls.filter((c) => c.args.includes("new-session"))).toHaveLength(1);
  });

  test("a concurrent rc and interactive start share the limit through one lock", async () => {
    const startLock = new StartLock();
    let interactive: InteractiveManager;
    let spawned = 0;
    const rc = new SessionManager({
      platform: "darwin",
      deviceName: "box",
      claudeBin: "/opt/homebrew/bin/claude",
      maxSessions: 2,
      othersActive: () => interactive.activeCount(),
      defaultPermissionMode: null,
      startLock,
      spawn: () => {
        spawned++;
        return Object.assign(new EventEmitter(), { pid: 300, stdout: new PassThrough(), stderr: new PassThrough() }) as never;
      },
      kill: () => {},
      startupWaitMs: 10,
    });
    const setupResult = setup({ activeRc: () => rc.activeCount(), startLock }, [alive("cc_aaaaaaaa")]);
    interactive = setupResult.manager;
    const results = await Promise.allSettled([
      rc.start("/Users/me/dev/other", {}),
      interactive.start("/Users/me/dev/app", { prompt: "hi" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "limit" });
    expect(spawned + setupResult.calls.filter((c) => c.args.includes("new-session")).length).toBe(1);
  });

  test("a failed create releases the slot for a concurrent start", async () => {
    let first = true;
    const { manager, backend } = setup({ maxSessions: 1 });
    const create = backend.create.bind(backend);
    backend.create = async (...args) => {
      if (first) {
        first = false;
        return "tmux でセッションを作れなかった: boom";
      }
      return create(...args);
    };
    const results = await Promise.allSettled([
      manager.start("/Users/me/dev/app", { prompt: "a" }),
      manager.start("/Users/me/dev/app", { prompt: "b" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
    expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ code: "spawn_failed" });
  });

  test("dead sessions do not count against the limit", async () => {
    const { manager } = setup({ activeRc: () => 1 }, [alive("cc_aaaaaaaa", { dead: true, status: 0, deadTime: 1_700_000_090 })]);
    await expect(manager.start("/Users/me/dev/app", { prompt: "hi" })).resolves.toMatchObject({ status: "running" });
  });

  test("without a backend (no tmux, or an old Bun on Windows), interactive sessions fail cleanly", async () => {
    const none = setup({ backend: null, unavailable: "tmux が見つからない" }).manager;
    await expect(none.start("/x", { prompt: "hi" })).rejects.toMatchObject({ code: "spawn_failed", message: "tmux が見つからない" });
    await expect(none.send("cc_running1", { text: "hi" })).rejects.toMatchObject({ code: "spawn_failed" });
    expect(await none.list()).toEqual([]);
    expect(await none.activeCount()).toBe(0);
  });

  test("list ignores other tmux sessions and prunes long-dead ones", async () => {
    const { manager, sessions } = setup({}, [
      alive("cc_running1"),
      alive("mine", { name: "not ours" }),
      alive("cc_recentdead", { dead: true, status: 0, deadTime: 1_700_000_000, screen: "bye\n" }),
      alive("cc_olddead1", { dead: true, status: 0, deadTime: 1_699_990_000 }),
    ]);
    const list = await manager.list();
    expect(list.map((s) => [s.id, s.status])).toEqual([
      ["cc_running1", "running"],
      ["cc_recentdead", "exited"],
    ]);
    expect(list[1]!.screen).toEqual(["bye"]);
    expect(sessions.map((s) => s.id)).not.toContain("cc_olddead1");
  });

  test("send pastes text through stdin and then presses Enter", async () => {
    const { manager, calls, logs } = setup({}, [alive("cc_running1")]);
    await manager.send("cc_running1", { text: "a\r\nb $(rm -rf ~);" });
    const tail = calls.slice(-3);
    expect(tail[0]!.args.slice(5, 7)).toEqual(["load-buffer", "-b"]);
    expect(tail[0]!.args.at(-1)).toBe("-");
    expect(tail[0]!.input).toBe("a\nb $(rm -rf ~);");
    expect(tail[1]!.args.slice(5)).toEqual(["paste-buffer", "-p", "-d", "-b", tail[0]!.args[7]!, "-t", "=cc_running1:"]);
    expect(tail[2]!.args.slice(5)).toEqual(["send-keys", "-t", "=cc_running1:", "Enter"]);
    expect(logs.at(-1)).toMatchObject({ interactive: "input", session: "cc_running1", textChars: "a\nb $(rm -rf ~);".length, submit: true });
    expect(JSON.stringify(logs)).not.toContain("rm -rf");
  });

  test("send with submit false does not press Enter", async () => {
    const { manager, calls } = setup({}, [alive("cc_running1")]);
    await manager.send("cc_running1", { text: "draft", submit: false });
    expect(calls.at(-1)!.args.slice(5, 6)).toEqual(["paste-buffer"]);
  });

  test("send a key", async () => {
    const { manager, calls } = setup({}, [alive("cc_running1")]);
    await manager.send("cc_running1", { key: "Escape" });
    expect(calls.at(-1)!.args.slice(5)).toEqual(["send-keys", "-t", "=cc_running1:", "Escape"]);
  });

  test("send refuses unknown or finished sessions", async () => {
    const { manager } = setup({}, [alive("cc_deadsess", { dead: true, status: 0, deadTime: 1_700_000_090 })]);
    await expect(manager.send("cc_unknown1", { text: "hi" })).rejects.toMatchObject({ code: "not_found" });
    await expect(manager.send("cc_deadsess", { text: "hi" })).rejects.toMatchObject({ code: "not_found" });
  });

  test("stop sends Ctrl+C twice and then kills the session", async () => {
    const { manager, calls, sessions } = setup({ killGraceMs: 5 }, [alive("cc_running1")]);
    const s = await manager.stop("cc_running1");
    expect(s.status).toBe("stopping");
    expect(calls.filter((c) => c.args.includes("C-c")).length).toBe(2);
    await Bun.sleep(30);
    expect(sessions).toEqual([]);
  });
});

// 実物の tmux があれば、偽の claude（引数を表示して標準入力を読むだけのスクリプト）で通しを確かめる
const tmuxBin = Bun.which("tmux");
describe.skipIf(!tmuxBin || process.platform === "win32")("with a real tmux", () => {
  test("start, send and stop", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "cc-remote-mcp-tmux-"));
    const fake = nodePath.join(dir, "claude");
    const out = nodePath.join(dir, "args.txt");
    fs.writeFileSync(
      fake,
      `#!/bin/sh\nfor a in "$@"; do printf '[%s]\\n' "$a"; done | tee "${out}"\nprintf 'https://claude.ai/code/session_test\\n'\nwhile IFS= read -r line; do printf 'GOT<%s>\\n' "$line"; done\n`,
    );
    fs.chmodSync(fake, 0o755);
    const socket = `cc-remote-mcp-test-${process.pid}`;
    const base = defaultTmuxRunner(tmuxBin!, tmuxEnv(process.env));
    // 本番の cc-remote-mcp ソケットと混ざらないよう、テスト用のソケットに差し替える
    const run: TmuxRunner = (args, input, cwd) => base(args.map((a) => (a === "cc-remote-mcp" ? socket : a)), input, cwd);
    const manager = new InteractiveManager({
      platform: "linux",
      deviceName: "box",
      claudeBin: fake,
      backend: new TmuxBackend(run),
      defaultPermissionMode: null,
      activeRc: () => 0,
      maxSessions: 4,
      log: () => {},
      startupWaitMs: 3000,
      pollMs: 100,
      killGraceMs: 200,
    });
    try {
      const s = await manager.start(dir, { prompt: "fix it; then `id` $HOME", name: "名前 テスト" });
      expect(s).toMatchObject({ status: "running", name: "名前 テスト", url: "https://claude.ai/code/session_test" });
      expect(fs.readFileSync(out, "utf8")).toBe("[--remote-control=名前 テスト]\n[--name]\n[名前 テスト]\n[--]\n[fix it; then `id` $HOME ]\n");
      await manager.send(s.id, { text: "hello" });
      await Bun.sleep(300);
      const screen = await base(["-u", "-L", socket, "capture-pane", "-p", "-t", `=${s.id}:`]);
      expect(screen.stdout).toContain("GOT<hello>");
      expect((await manager.list()).map((x) => x.id)).toEqual([s.id]);
      await manager.stop(s.id);
      await Bun.sleep(600);
      expect(await manager.list()).toEqual([]);
    } finally {
      await base(["-L", socket, "kill-server"]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("directories with tmux format characters or a trailing ; start exactly there", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "cc-remote-mcp-tmux-")));
    const fake = nodePath.join(dir, "claude");
    fs.writeFileSync(fake, "#!/bin/sh\nprintf 'https://claude.ai/code/session_test\\n'\nsleep 30\n");
    fs.chmodSync(fake, 0o755);
    const socket = `cc-remote-mcp-test-cwd-${process.pid}`;
    const base = defaultTmuxRunner(tmuxBin!, tmuxEnv(process.env));
    const run: TmuxRunner = (args, input, cwd) => base(args.map((a) => (a === "cc-remote-mcp" ? socket : a)), input, cwd);
    const manager = new InteractiveManager({
      platform: "linux",
      deviceName: "box",
      claudeBin: fake,
      backend: new TmuxBackend(run),
      defaultPermissionMode: null,
      activeRc: () => 0,
      maxSessions: 8,
      log: () => {},
      startupWaitMs: 3000,
      pollMs: 100,
    });
    try {
      for (const name of ["a#(touch PWNED)b", "h#{host}x", "semi;"]) {
        const target = nodePath.join(dir, name);
        fs.mkdirSync(target);
        const s = await manager.start(target, { prompt: "hi", name: "n" });
        expect(s).toMatchObject({ status: "running", path: target });
        const shown = await base(["-u", "-L", socket, "display-message", "-p", "-t", `=${s.id}:`, "#{pane_current_path}"]);
        expect(shown.stdout.replace(/\n$/, "")).toBe(target);
      }
      // #(…) が実行されると、tmux を呼んだ側の作業ディレクトリに PWNED ができる
      await Bun.sleep(200);
      expect(fs.existsSync(nodePath.join(process.cwd(), "PWNED"))).toBe(false);
      expect(fs.readdirSync(dir).sort()).toEqual(["a#(touch PWNED)b", "claude", "h#{host}x", "semi;"]);
      for (const name of ["a#(touch PWNED)b", "h#{host}x", "semi;"]) expect(fs.readdirSync(nodePath.join(dir, name))).toEqual([]);
    } finally {
      await base(["-L", socket, "kill-server"]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
