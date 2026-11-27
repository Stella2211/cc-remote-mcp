import { describe, expect, test } from "bun:test";
import { handleRequest } from "../client/actions";
import { InteractiveManager } from "../client/interactive";
import { TmuxBackend, type TmuxRunner } from "../client/interactive-tmux";
import type { Policy } from "../client/paths";
import { SessionManager } from "../client/sessions";
import { MAX_PATH_CHARS } from "../shared/protocol";
import { fakeFs } from "./support";

const policy: Policy = { platform: "linux", roots: ["/home/me/dev"], blocked: ["/home/me/dev/secret"], hideDotDirs: true, home: "/home/me" };
const fs = fakeFs({ dirs: ["/home/me", "/home/me/dev", "/home/me/dev/app", "/home/me/dev/secret", "/etc"], links: { "/home/me/dev/out": "/etc" } });

function deps(over: Partial<Policy> = {}) {
  const spawned: { args: string[]; cwd: string }[] = [];
  const tmuxCalls: string[][] = [];
  const tmuxCwds: (string | undefined)[] = [];
  let started = "";
  // tmux の代役。new-session だけ記録し、作ったセッションの場所は起動した場所を返す。一覧はいつも空（サーバーなし）
  const run: TmuxRunner = async (args, _input, cwd) => {
    tmuxCalls.push(args);
    tmuxCwds.push(cwd);
    if (args.includes("new-session")) {
      started = cwd ?? "/";
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args.includes("#{session_path}") && started) return { code: 0, stdout: `${started}\n`, stderr: "" };
    return { code: 1, stdout: "", stderr: "no server running" };
  };
  const interactive = new InteractiveManager({
    platform: "linux",
    deviceName: "box",
    claudeBin: "/bin/claude",
    backend: new TmuxBackend(run),
    defaultPermissionMode: null,
    activeRc: () => 0,
    maxSessions: 4,
    log: () => {},
    startupWaitMs: 0,
    sleep: async () => {},
  });
  const sessions = new SessionManager({
    platform: "linux",
    deviceName: "box",
    claudeBin: "/bin/claude",
    maxSessions: 4,
    defaultPermissionMode: null,
    startupWaitMs: 10,
    spawn: (_cmd, args, opts) => {
      spawned.push({ args, cwd: opts.cwd });
      const { EventEmitter } = require("node:events");
      const { PassThrough } = require("node:stream");
      return Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough() }) as never;
    },
    kill: () => {},
  });
  return { deps: { policy: { ...policy, ...over }, fs, sessions, interactive }, spawned, tmuxCalls, tmuxCwds };
}

const req = (action: string, params: unknown = {}) => JSON.stringify({ type: "request", id: "req_12345678", action, params });

describe("handleRequest", () => {
  test("ignores malformed messages", async () => {
    const { deps: d } = deps();
    expect(await handleRequest(d, "not json")).toBeNull();
    expect(await handleRequest(d, JSON.stringify({ type: "request", id: "x", action: "list_sessions" }))).toBeNull();
  });

  test.each(["exec", "shell", "run", "__proto__", "constructor", "toString"])("rejects the action %s", async (action) => {
    const { deps: d, spawned } = deps();
    const res = await handleRequest(d, req(action, { command: "rm -rf /" }));
    expect(res).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(spawned).toEqual([]);
  });

  test("rejects unexpected parameters", async () => {
    const { deps: d, spawned } = deps();
    const res = await handleRequest(d, req("start_session", { path: "/home/me/dev/app", args: ["--dangerously-skip-permissions"] }));
    expect(res).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(spawned).toEqual([]);
  });

  test("rejects permission modes that are not allowed remotely", async () => {
    const { deps: d, spawned } = deps();
    for (const permissionMode of ["bypassPermissions", "dontAsk"]) {
      const res = await handleRequest(d, req("start_session", { path: "/home/me/dev/app", permissionMode }));
      expect(res).toMatchObject({ ok: false, error: { code: "bad_request" } });
    }
    expect(spawned).toEqual([]);
  });

  test("rejects a session name that looks like a flag", async () => {
    const { deps: d, spawned } = deps();
    const res = await handleRequest(d, req("start_session", { path: "/home/me/dev/app", name: "--settings=/tmp/x" }));
    expect(res).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(spawned).toEqual([]);
  });

  test("list_dirs without a path returns the roots", async () => {
    const { deps: d } = deps();
    const res = await handleRequest(d, req("list_dirs"));
    expect(res).toMatchObject({ ok: true, result: { path: null, entries: [{ name: "/home/me/dev", path: "/home/me/dev" }] } });
  });

  test("list_dirs without a path keeps a long root's name within the protocol limit", async () => {
    const long = `/data/${"d".repeat(300)}/project`;
    const { deps: d } = deps({ roots: [long] });
    const res = await handleRequest(d, req("list_dirs"));
    expect(res).toMatchObject({ ok: true, result: { path: null, entries: [{ name: "project", path: long }], truncated: false } });
  });

  test("list_dirs refuses a directory whose real path is too long for the reply", async () => {
    const longReal = `/home/me/dev/${"r".repeat(MAX_PATH_CHARS)}`;
    const local = fakeFs({ dirs: ["/home/me", "/home/me/dev", longReal], links: { "/home/me/dev/deep": longReal } });
    const { deps: d } = deps();
    const res = await handleRequest({ ...d, fs: local }, req("list_dirs", { path: "/home/me/dev/deep" }));
    expect(res).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(local.calls).not.toContain(`readdir ${longReal}`);
  });

  test("list_dirs refuses paths outside the policy", async () => {
    const { deps: d } = deps();
    expect(await handleRequest(d, req("list_dirs", { path: "/etc" }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await handleRequest(d, req("list_dirs", { path: "/home/me/dev/out" }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await handleRequest(d, req("list_dirs", { path: "/home/me/dev/../.." }))).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });

  test("start_session never spawns outside the policy", async () => {
    const { deps: d, spawned } = deps();
    for (const path of ["/etc", "/home/me/dev/secret", "/home/me/dev/out", "/home/me/dev/../../etc", "relative"]) {
      const res = await handleRequest(d, req("start_session", { path }));
      expect(res).toMatchObject({ ok: false });
    }
    expect(spawned).toEqual([]);
  });

  test("start_session refuses the home directory", async () => {
    const { deps: d, spawned } = deps({ roots: ["/home/me"] });
    const res = await handleRequest(d, req("start_session", { path: "/home/me" }));
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(spawned).toEqual([]);
  });

  test("start_session starts claude rc in the real path", async () => {
    const { deps: d, spawned } = deps();
    const res = await handleRequest(d, req("start_session", { path: "/home/me/dev/app/" }));
    expect(res).toMatchObject({ ok: true, result: { session: { path: "/home/me/dev/app", status: "running" } } });
    expect(spawned).toEqual([{ args: ["remote-control", "--name", "box-app", "--spawn", "same-dir"], cwd: "/home/me/dev/app" }]);
  });

  test("start_interactive never starts outside the policy or in the home directory", async () => {
    const { deps: d, tmuxCalls } = deps({ roots: ["/home/me", "/home/me/dev"] });
    for (const path of ["/etc", "/home/me/dev/secret", "/home/me/dev/out", "/home/me", "relative"]) {
      const res = await handleRequest(d, req("start_interactive", { path, prompt: "hi" }));
      expect(res).toMatchObject({ ok: false });
    }
    expect(tmuxCalls.filter((a) => a.includes("new-session"))).toEqual([]);
  });

  test("start_interactive rejects bad prompts, names and extra parameters", async () => {
    const { deps: d, tmuxCalls } = deps();
    const bad = [
      { path: "/home/me/dev/app" },
      { path: "/home/me/dev/app", prompt: "" },
      { path: "/home/me/dev/app", prompt: "   " },
      { path: "/home/me/dev/app", prompt: "hi\u001b[201~" },
      { path: "/home/me/dev/app", prompt: "あ".repeat(4001) },
      { path: "/home/me/dev/app", prompt: "hi", name: "--settings=/tmp/x" },
      { path: "/home/me/dev/app", prompt: "hi", name: "x;" },
      { path: "/home/me/dev/app", prompt: "hi", permissionMode: "bypassPermissions" },
      { path: "/home/me/dev/app", prompt: "hi", args: ["--dangerously-skip-permissions"] },
    ];
    for (const params of bad) {
      const res = await handleRequest(d, req("start_interactive", params));
      expect(res).toMatchObject({ ok: false, error: { code: "bad_request" } });
    }
    expect(tmuxCalls.filter((a) => a.includes("new-session"))).toEqual([]);
  });

  test("start_interactive runs claude --remote-control in tmux with the prompt after --", async () => {
    const { deps: d, tmuxCalls, tmuxCwds } = deps();
    const res = await handleRequest(d, req("start_interactive", { path: "/home/me/dev/app/", prompt: "install", permissionMode: "default" }));
    expect(res).toMatchObject({ ok: true });
    const call = tmuxCalls.find((a) => a.includes("new-session"))!;
    expect(call.slice(0, 5)).toEqual(["-u", "-L", "cc-remote-mcp", "-f", "/dev/null"]);
    const cmd = call.slice(call.indexOf("/bin/claude"), call.indexOf(";"));
    expect(cmd).toEqual(["/bin/claude", "--remote-control=box-app", "--name", "box-app", "--permission-mode", "manual", "--", "install "]);
    // 場所は -c ではなく、tmux を起動する場所として渡す
    expect(call).not.toContain("-c");
    expect(tmuxCwds[tmuxCalls.indexOf(call)]).toBe("/home/me/dev/app");
  });

  test("send_input and stop_interactive only accept cc_ ids and one of text or key", async () => {
    const { deps: d } = deps();
    for (const params of [
      { id: "rc_abcdefgh", text: "hi" },
      { id: "cc_abcdefgh" },
      { id: "cc_abcdefgh", text: "hi", key: "Enter" },
      { id: "cc_abcdefgh", key: "C-c" },
      { id: "cc_abcdefgh", text: "a\u0003b" },
    ]) {
      expect(await handleRequest(d, req("send_input", params))).toMatchObject({ ok: false, error: { code: "bad_request" } });
    }
    // 形は正しいが、tmux 側に無い
    expect(await handleRequest(d, req("send_input", { id: "cc_abcdefgh", text: "hi" }))).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await handleRequest(d, req("stop_interactive", { id: "rc_abcdefgh" }))).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });
});
