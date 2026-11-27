import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { InteractiveManager } from "../client/interactive";
import { PtyBackend, type PtyChild, type PtySpawn, bunPtySpawn, bunSupportsConpty, ptyEnv } from "../client/interactive-pty";
import type { Platform } from "../client/paths";

// Windows の対話セッション（疑似端末）のテスト。疑似端末の部分は Bun.Terminal なので macOS / Linux / Windows のどこでも通す

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(25);
  }
};

// 疑似端末の代役。書き込みを記録し、出力と終了を外から起こせる
function fakePty() {
  const spawned: { argv: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const children: { written: string[]; emit: (s: string) => void; exit: (code: number | null) => void; closed: boolean; pid: number }[] = [];
  const spawn: PtySpawn = (argv, opts) => {
    spawned.push({ argv, cwd: opts.cwd, env: opts.env });
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    const c = { written: [] as string[], emit: (s: string) => opts.data(new TextEncoder().encode(s)), exit, closed: false, pid: 4242 + children.length };
    children.push(c);
    const child: PtyChild = { pid: c.pid, write: (d) => c.written.push(d), exited, close: () => (c.closed = true) };
    return child;
  };
  return { spawn, spawned, children };
}

function setup(over: { spawn?: PtySpawn; platform?: Platform; startupWaitMs?: number } = {}) {
  const pty = fakePty();
  const killed: { pid: number; graceful: boolean }[] = [];
  const backend = new PtyBackend({
    platform: over.platform ?? "win32",
    spawn: over.spawn ?? pty.spawn,
    // 強制終了したら、その疑似端末の子が終わったことにする
    kill: (pid, graceful) => {
      killed.push({ pid, graceful });
      pty.children.find((c) => c.pid === pid)?.exit(null);
    },
    shutdownGraceMs: 400,
    exitSettleMs: 10,
  });
  const manager = new InteractiveManager({
    platform: over.platform ?? "win32",
    deviceName: "win-pc",
    claudeBin: "C:\\Users\\me\\.local\\bin\\claude.exe",
    backend,
    defaultPermissionMode: null,
    activeRc: () => 0,
    maxSessions: 2,
    log: () => {},
    sleep: async () => {},
    startupWaitMs: over.startupWaitMs ?? 0,
    pollMs: 20,
    killGraceMs: 5,
  });
  return { manager, backend, killed, ...pty };
}

describe("helpers", () => {
  test("bunSupportsConpty needs Bun 1.3.14 or later", () => {
    expect(bunSupportsConpty("1.3.13")).toBe(false);
    expect(bunSupportsConpty("1.2.99")).toBe(false);
    expect(bunSupportsConpty("1.3.14")).toBe(true);
    expect(bunSupportsConpty("1.4.0-canary.1")).toBe(true);
    expect(bunSupportsConpty("2.0.0")).toBe(true);
  });

  test("ptyEnv strips the client's own settings and sets TERM only on POSIX", () => {
    const env = { PATH: "/bin", DEVICE_TOKEN: "x", TMUX: "/tmp/s", CF_ACCESS_CLIENT_SECRET: "s" } as unknown as NodeJS.ProcessEnv;
    expect(ptyEnv(env, "win32") as unknown).toEqual({ PATH: "/bin" });
    expect(ptyEnv(env, "darwin") as unknown).toEqual({ PATH: "/bin", TERM: "xterm-256color" });
  });
});

describe("PtyBackend with a fake terminal", () => {
  test("start runs claude directly with the argument array and finds the url", async () => {
    const { manager, spawned, children } = setup({ startupWaitMs: 2_000 });
    const saved = process.env.DEVICE_TOKEN;
    process.env.DEVICE_TOKEN = "secret-token";
    const pending = manager.start("C:\\Users\\me\\dev\\app", { prompt: 'fix "it" %PATH% \\\n2行目', permissionMode: "default", worktree: true });
    await waitFor(() => children.length === 1);
    children[0]!.emit("\x1b[?9001h\x1b[?1004hWelcome\r\n\x1b]8;;https://claude.ai/code/session_");
    children[0]!.emit("01abc\x1b\\/rc active\x1b]8;;\x1b\\\r\n");
    const s = await pending;
    if (saved === undefined) delete process.env.DEVICE_TOKEN;
    else process.env.DEVICE_TOKEN = saved;
    expect(s).toMatchObject({ status: "running", name: "win-pc-app", path: "C:\\Users\\me\\dev\\app", url: "https://claude.ai/code/session_01abc", exitCode: null });
    expect(spawned[0]!.cwd).toBe("C:\\Users\\me\\dev\\app");
    expect(spawned[0]!.argv).toEqual([
      "C:\\Users\\me\\.local\\bin\\claude.exe",
      "--remote-control=win-pc-app",
      "--name",
      "win-pc-app",
      "--permission-mode",
      "manual",
      "--worktree",
      "--",
      'fix "it" %PATH% \\\n2行目 ',
    ]);
    expect(spawned[0]!.env.DEVICE_TOKEN).toBeUndefined();
    expect(s.screen).toContain("Welcome");
  });

  test("output written while spawning is kept", async () => {
    const pty = fakePty();
    const spawn: PtySpawn = (argv, opts) => {
      opts.data(new TextEncoder().encode("early output\r\n"));
      return pty.spawn(argv, opts);
    };
    const { manager, backend } = setup({ spawn });
    const s = await manager.start("C:\\x\\app", { prompt: "hi" });
    expect((await backend.capture(s.id)).lines).toEqual(["early output"]);
  });

  test("a spawn failure is reported as spawn_failed and leaves nothing behind", async () => {
    const { manager } = setup({
      spawn: () => {
        throw new Error("ENOENT: no such file");
      },
    });
    await expect(manager.start("C:\\x\\app", { prompt: "hi" })).rejects.toMatchObject({ code: "spawn_failed" });
    expect(await manager.list()).toEqual([]);
  });

  test("an immediate exit is reported with the exit code and the screen", async () => {
    const { manager, children } = setup({ startupWaitMs: 2_000 });
    const pending = manager.start("C:\\x\\app", { prompt: "hi" });
    await waitFor(() => children.length === 1);
    children[0]!.emit("error: unknown option '--permission-mode'\r\n");
    children[0]!.exit(1);
    expect(await pending).toMatchObject({ status: "exited", exitCode: 1, screen: ["error: unknown option '--permission-mode'"] });
    expect(await manager.activeCount()).toBe(0);
  });

  test("text is pasted with CR line breaks, bracketed only when claude asked for it, then Enter", async () => {
    const { manager, children } = setup();
    const s = await manager.start("C:\\x\\app", { prompt: "hi" });
    const w = children[0]!.written;
    await manager.send(s.id, { text: "a\r\nb", submit: false });
    expect(w.at(-1)).toBe("a\rb");
    children[0]!.emit("\x1b[?2004h");
    await manager.send(s.id, { text: "c\nd" });
    expect(w.slice(-2)).toEqual(["\x1b[200~c\rd\x1b[201~", "\r"]);
  });

  test("keys follow the cursor key mode, and Escape is written on its own", async () => {
    const { manager, children } = setup();
    const s = await manager.start("C:\\x\\app", { prompt: "hi" });
    const w = children[0]!.written;
    await manager.send(s.id, { key: "Up" });
    await manager.send(s.id, { key: "Escape" });
    children[0]!.emit("\x1b[?1h");
    await manager.send(s.id, { key: "Down" });
    await manager.send(s.id, { key: "Enter" });
    expect(w.slice(-4)).toEqual(["\x1b[A", "\x1b", "\x1bOB", "\r"]);
  });

  test("terminal queries are answered back to claude", async () => {
    const { manager, children } = setup();
    await manager.start("C:\\x\\app", { prompt: "hi" });
    children[0]!.emit("\x1b[6n");
    await waitFor(() => children[0]!.written.some((d) => /^\x1b\[\d+;\d+R$/.test(d)));
  });

  test("send refuses unknown and finished sessions", async () => {
    const { manager, children } = setup();
    const s = await manager.start("C:\\x\\app", { prompt: "hi" });
    children[0]!.exit(0);
    await waitFor(async () => (await manager.list())[0]?.status === "exited");
    await expect(manager.send(s.id, { text: "hi" })).rejects.toMatchObject({ code: "not_found" });
    await expect(manager.send("cc_unknown1", { text: "hi" })).rejects.toMatchObject({ code: "not_found" });
  });

  test("stop sends Ctrl+C twice, then kills the process tree and forgets the session", async () => {
    const { manager, children, killed } = setup();
    const s = await manager.start("C:\\x\\app", { prompt: "hi" });
    expect((await manager.stop(s.id)).status).toBe("stopping");
    expect(children[0]!.written.filter((d) => d === "\x03").length).toBe(2);
    await waitFor(async () => (await manager.list()).length === 0);
    expect(killed).toEqual([{ pid: children[0]!.pid, graceful: false }]);
    await waitFor(() => children[0]!.closed);
  });

  test("sessions count against MAX_SESSIONS and exited ones do not", async () => {
    const { manager, children } = setup();
    await manager.start("C:\\x\\a", { prompt: "hi" });
    await manager.start("C:\\x\\b", { prompt: "hi" });
    await expect(manager.start("C:\\x\\c", { prompt: "hi" })).rejects.toMatchObject({ code: "limit" });
    children[0]!.exit(0);
    await waitFor(async () => (await manager.activeCount()) === 1);
    await expect(manager.start("C:\\x\\c", { prompt: "hi" })).resolves.toMatchObject({ status: "running" });
  });

  test("shutdown interrupts live sessions and kills what is left", async () => {
    const { manager, children, killed } = setup();
    await manager.start("C:\\x\\a", { prompt: "hi" });
    manager.shutdown();
    expect(children[0]!.written).toContain("\x03");
    await waitFor(() => killed.length === 1);
    expect(children[0]!.written.filter((d) => d === "\x03").length).toBe(2);
  });
});

// 本物の疑似端末（Bun.Terminal。Windows では ConPTY）で、偽の claude（Bun のスクリプト）を動かして通しで確かめる
describe("PtyBackend with a real terminal", () => {
  test("start, send text and keys, exit code, stop", async () => {
    // Windows の一時フォルダは短い名前（8.3 形式）のことがあるので、実体の名前にそろえる
    const dir = fs.realpathSync.native(fs.mkdtempSync(nodePath.join(os.tmpdir(), "cc-remote-mcp-pty-")));
    const out = nodePath.join(dir, "out");
    const fake = nodePath.join(import.meta.dir, "fixtures", "fake-claude.ts");
    // claude の代わりに「bun 偽のclaude 出力先」を起動する（claude に渡る引数はそのまま後ろにつく）
    const spawn: PtySpawn = (argv, opts) => bunPtySpawn([process.execPath, fake, out, ...argv.slice(1)], opts);
    const platform = (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux") as Platform;
    const backend = new PtyBackend({ platform, spawn });
    const manager = new InteractiveManager({
      platform,
      deviceName: "box",
      claudeBin: "claude",
      backend,
      defaultPermissionMode: null,
      activeRc: () => 0,
      maxSessions: 4,
      log: () => {},
      startupWaitMs: 10_000,
      pollMs: 50,
      killGraceMs: 10_000,
    });
    const input = () => (fs.existsSync(`${out}.input.txt`) ? fs.readFileSync(`${out}.input.txt`, "utf8") : "");
    try {
      const prompt = 'fix "it"; then `id` $HOME %PATH% C:\\dir\\ \n2行目';
      const saved = process.env.DEVICE_TOKEN;
      process.env.DEVICE_TOKEN = "secret-token";
      const s = await manager.start(dir, { prompt, name: '名前 "テスト"' });
      if (saved === undefined) delete process.env.DEVICE_TOKEN;
      else process.env.DEVICE_TOKEN = saved;
      expect(s).toMatchObject({ status: "running", name: '名前 "テスト"', url: "https://claude.ai/code/session_test" });
      expect(JSON.parse(fs.readFileSync(`${out}.args.json`, "utf8"))).toEqual({
        args: ['--remote-control=名前 "テスト"', "--name", '名前 "テスト"', "--", `${prompt} `],
        cwd: dir,
        token: null,
        tty: true,
      });

      await manager.send(s.id, { text: "a\nb" });
      await waitFor(() => input().endsWith("\r"));
      expect(input()).toBe("\x1b[200~a\rb\x1b[201~\r");
      await manager.send(s.id, { key: "Escape" });
      await waitFor(() => input().endsWith("\x1b"));
      await manager.send(s.id, { key: "Up" });
      await waitFor(() => input().endsWith("\x1b[A"));
      // 画面（端末エミュレーターの表示）にも出る
      await waitFor(async () => (await backend.capture(s.id)).lines.some((l) => l.includes('GOT "\\u001b[A"')));

      await manager.send(s.id, { text: "quit", submit: false });
      await waitFor(async () => (await manager.list())[0]?.status === "exited");
      expect((await manager.list())[0]).toMatchObject({ id: s.id, exitCode: 3 });

      const t = await manager.start(dir, { prompt: "second" });
      expect(t.status).toBe("running");
      await manager.stop(t.id);
      let stopped: { exitCode: number | null } | undefined;
      await waitFor(async () => (stopped = (await manager.list()).find((x) => x.id === t.id && x.status === "exited")) !== undefined);
      expect(stopped?.exitCode).toBe(0);
    } finally {
      for (const r of await backend.rows()) await backend.remove(r.id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
