import { describe, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type SpawnFn, SessionManager, childEnv, cleanLine, findSessionUrl } from "../client/sessions";

type Spawned = { cmd: string; args: string[]; opts: Parameters<SpawnFn>[2]; child: FakeChild };

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(readonly pid: number) {
    super();
  }
  exit(code: number) {
    this.emit("exit", code);
  }
}

function setup(over: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) {
  const spawned: Spawned[] = [];
  const kills: { pid: number; graceful: boolean }[] = [];
  let pid = 100;
  const spawn: SpawnFn = (cmd, args, opts) => {
    const child = new FakeChild(++pid);
    spawned.push({ cmd, args, opts, child });
    return child as never;
  };
  const manager = new SessionManager({
    platform: "linux",
    deviceName: "box",
    claudeBin: "/usr/local/bin/claude",
    maxSessions: 2,
    defaultPermissionMode: null,
    spawn,
    kill: (p, graceful) => kills.push({ pid: p, graceful }),
    startupWaitMs: 50,
    killGraceMs: 20,
    ...over,
  });
  return { manager, spawned, kills };
}

describe("SessionManager.start", () => {
  test("runs claude remote-control with a fixed argument array in the directory", async () => {
    const { manager, spawned } = setup();
    const info = await manager.start("/home/me/dev/app", {});
    expect(spawned).toHaveLength(1);
    const s = spawned[0]!;
    expect(s.cmd).toBe("/usr/local/bin/claude");
    expect(s.args).toEqual(["remote-control", "--name", "box-app", "--spawn", "same-dir"]);
    expect(s.opts.cwd).toBe("/home/me/dev/app");
    expect(s.opts.detached).toBe(true);
    expect(s.opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(info.status).toBe("running");
    expect(info.id).toMatch(/^rc_/);
  });

  test("passes name, spawn and permission mode as separate arguments", async () => {
    const { manager, spawned } = setup({ defaultPermissionMode: "acceptEdits" });
    await manager.start("/d/x", { name: "my session; rm -rf /", spawn: "worktree" });
    expect(spawned[0]!.args).toEqual([
      "remote-control",
      "--name",
      "my session; rm -rf /",
      "--spawn",
      "worktree",
      "--permission-mode",
      "acceptEdits",
    ]);
  });

  test("picks up the session URL from the output and returns early", async () => {
    const { manager, spawned } = setup({ startupWaitMs: 5_000 });
    const p = manager.start("/d/x", {});
    spawned[0]!.child.stdout.write("\x1b[32mSession URL:\x1b[0m https://claude.ai/code/session_abc?x=1\n");
    const info = await p;
    expect(info.url).toBe("https://claude.ai/code/session_abc?x=1");
    expect(info.status).toBe("running");
  });

  test("reports an early exit with the tail of the output", async () => {
    const { manager, spawned } = setup({ startupWaitMs: 5_000 });
    const p = manager.start("/d/x", {});
    spawned[0]!.child.stderr.write("Error: Workspace not trusted. Please run `claude` in /d/x first\n");
    spawned[0]!.child.exit(1);
    const info = await p;
    expect(info.status).toBe("exited");
    expect(info.exitCode).toBe(1);
    expect(info.lastOutput.join("\n")).toContain("Workspace not trusted");
  });

  test("a binary that cannot be started is spawn_failed, leaves no session and frees the slot", async () => {
    // 実在しない実行ファイルは、spawn が投げずに error イベントで知らせる（本物の node:child_process で確かめる）
    const { manager } = setup({ spawn: undefined, claudeBin: "/nonexistent/claude-bin", startupWaitMs: 5_000, maxSessions: 1 });
    await expect(manager.start("/tmp", {})).rejects.toMatchObject({ code: "spawn_failed", message: expect.stringContaining("claude コマンドを起動できなかった") });
    expect(manager.list()).toEqual([]);
    expect(manager.activeCount()).toBe(0);
    await expect(manager.start("/tmp", {})).rejects.toMatchObject({ code: "spawn_failed" });
  });

  test("a binary that cannot be started does not take the slot from a concurrent start", async () => {
    // 1つ目は本物の node:child_process で実在しない実行ファイルを起動する。error イベントを待たずに錠の中で失敗させるので、
    // 錠の後ろで待っていた2つ目が、一瞬残った1つ目に数えられて上限で断られることはない
    let calls = 0;
    const { manager } = setup({
      claudeBin: "/nonexistent/claude-bin",
      maxSessions: 1,
      othersActive: async () => 0,
      spawn: (cmd, args, opts) => (++calls === 1 ? nodeSpawn(cmd, args, opts) : (new FakeChild(300) as never)),
    });
    const results = await Promise.allSettled([manager.start("/tmp", {}), manager.start("/tmp", {})]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
    expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ code: "spawn_failed" });
    expect(manager.list()).toHaveLength(1);
  });

  test("a spawn error event after the pid is known is an ordinary exit", async () => {
    const { manager, spawned } = setup({ startupWaitMs: 5_000 });
    const p = manager.start("/d/x", {});
    spawned[0]!.child.emit("error", new Error("boom"));
    expect((await p).status).toBe("exited");
  });

  test("enforces the limit and refuses a second rc in the same directory", async () => {
    const { manager } = setup();
    await manager.start("/d/a", {});
    await expect(manager.start("/d/a", {})).rejects.toMatchObject({ code: "limit" });
    await manager.start("/d/b", {});
    await expect(manager.start("/d/c", {})).rejects.toMatchObject({ code: "limit" });
  });

  // 要求は並行に処理される。対話セッションの数を待つ間に別の起動が割り込んでも、検査をすり抜けない
  test("two concurrent starts in the same directory start only one rc", async () => {
    const { manager, spawned } = setup({ othersActive: async () => 0 });
    const results = await Promise.allSettled([manager.start("/d/a", {}), manager.start("/d/a", {})]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "limit", message: "同じディレクトリで rc がすでに動いている" });
    expect(spawned).toHaveLength(1);
  });

  test("concurrent starts at the limit start no more than MAX_SESSIONS", async () => {
    const { manager, spawned } = setup({ othersActive: async () => 1 });
    const results = await Promise.allSettled([manager.start("/d/a", {}), manager.start("/d/b", {})]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "limit" });
    expect(spawned).toHaveLength(1);
  });

  test("a failed spawn releases the slot for a concurrent start", async () => {
    let calls = 0;
    const { manager } = setup({
      maxSessions: 1,
      othersActive: async () => 0,
      spawn: () => {
        if (++calls === 1) throw new Error("ENOENT");
        return new FakeChild(200) as never;
      },
    });
    const results = await Promise.allSettled([manager.start("/d/a", {}), manager.start("/d/a", {})]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
    expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ code: "spawn_failed" });
    expect(calls).toBe(2);
  });

  test("does not hand the client's own secrets to claude", () => {
    const env = childEnv({ PATH: "/bin", DEVICE_TOKEN: "x", CF_ACCESS_CLIENT_SECRET: "y", CC_REMOTE_MCP_URL: "z", HOME: "/h" } as unknown as NodeJS.ProcessEnv);
    expect(env as unknown).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("SessionManager.stop", () => {
  test("sends a graceful stop, then forces it if the process stays", async () => {
    const { manager, spawned, kills } = setup();
    const info = await manager.start("/d/a", {});
    const stopped = manager.stop(info.id);
    expect(stopped.status).toBe("stopping");
    expect(kills).toEqual([{ pid: spawned[0]!.child.pid, graceful: true }]);
    await Bun.sleep(40);
    expect(kills.at(-1)).toEqual({ pid: spawned[0]!.child.pid, graceful: false });
  });

  test("after the process exits, sweeps the group once and cancels the timed force-kill", async () => {
    const { manager, spawned, kills } = setup();
    const info = await manager.start("/d/a", {});
    manager.stop(info.id);
    spawned[0]!.child.exit(0);
    const pid = spawned[0]!.child.pid;
    expect(kills).toEqual([
      { pid, graceful: true },
      { pid, graceful: false },
    ]);
    await Bun.sleep(40);
    expect(kills).toHaveLength(2);
    expect(manager.list()[0]!.status).toBe("exited");
  });

  test("a second stop on a stuck session forces it again", async () => {
    const { manager, spawned, kills } = setup({ killGraceMs: 10_000 });
    const info = await manager.start("/d/a", {});
    manager.stop(info.id);
    manager.stop(info.id);
    expect(kills).toEqual([
      { pid: spawned[0]!.child.pid, graceful: true },
      { pid: spawned[0]!.child.pid, graceful: false },
    ]);
  });

  test("windows does not sweep after exit", async () => {
    const { manager, spawned, kills } = setup({ platform: "win32" });
    await manager.start("C:\\d\\a", {});
    spawned[0]!.child.exit(0);
    expect(kills).toEqual([]);
  });

  test("unknown ids are not_found and nothing is killed", () => {
    const { manager, kills } = setup();
    expect(() => manager.stop("rc_AAAAAAAAAAAA")).toThrow();
    expect(kills).toEqual([]);
  });
});

test("cleanLine strips escapes and control characters", () => {
  expect(cleanLine("\x1b[1mhello\x1b[0m\tworld\u202e")).toBe("hello world");
  expect(cleanLine("x".repeat(1000))).toHaveLength(300);
});

test("findSessionUrl only matches claude.ai/code", () => {
  expect(findSessionUrl("open https://claude.ai/code/abc now")).toBe("https://claude.ai/code/abc");
  expect(findSessionUrl("https://evil.example/claude.ai/code")).toBeNull();
});
