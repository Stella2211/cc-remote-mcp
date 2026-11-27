import { describe, expect, test } from "bun:test";
import { buildConfig, parseEnv, splitList } from "../client/config";
import { fakeFs } from "./support";

const fs = fakeFs({ dirs: ["/home/me", "/home/me/dev", "/home/me/.ssh"] });
const base = {
  CC_REMOTE_MCP_URL: "wss://link.cc-remote-mcp.example.com/connect",
  DEVICE_NAME: "mac-mini",
  DEVICE_TOKEN: "A".repeat(43),
  ALLOWED_ROOTS: "~/dev",
};
const build = (env: Record<string, string>) => buildConfig(env, { platform: "linux", home: "/home/me", fs });

test("parseEnv", () => {
  expect(parseEnv('# c\nA=1\nexport B="two words"\nC=\'x\'\n bad line\nD=a=b\n')).toEqual({ A: "1", B: "two words", C: "x", D: "a=b" });
});

test("splitList uses the PATH separator of the platform", () => {
  expect(splitList("linux", "/a:/b: ")).toEqual(["/a", "/b"]);
  expect(splitList("win32", "C:\\a;D:\\b")).toEqual(["C:\\a", "D:\\b"]);
});

describe("buildConfig", () => {
  test("expands ~ and always blocks credential directories", () => {
    const c = build(base);
    expect(c.policy.roots).toEqual(["/home/me/dev"]);
    expect(c.policy.blocked).toContain("/home/me/.ssh");
    expect(c.policy.hideDotDirs).toBe(true);
    expect(c.maxSessions).toBe(4);
  });

  test.each([
    ["missing roots", { ALLOWED_ROOTS: "" }],
    ["missing root dir", { ALLOWED_ROOTS: "/nope" }],
    ["relative root", { ALLOWED_ROOTS: "dev" }],
    ["plain ws to a remote host", { CC_REMOTE_MCP_URL: "ws://link.cc-remote-mcp.example.com/connect" }],
    ["http url", { CC_REMOTE_MCP_URL: "https://link.cc-remote-mcp.example.com/connect" }],
    ["bad device name", { DEVICE_NAME: "Mac Mini" }],
    ["short token", { DEVICE_TOKEN: "abc" }],
    ["bad permission mode", { DEFAULT_PERMISSION_MODE: "bypassPermissions" }],
    ["too many sessions", { MAX_SESSIONS: "100" }],
    ["half an Access service token", { CF_ACCESS_CLIENT_ID: "x" }],
  ])("rejects %s", (_, over) => {
    expect(() => build({ ...base, ...over })).toThrow();
  });

  test("allows ws:// to localhost for development", () => {
    expect(build({ ...base, CC_REMOTE_MCP_URL: "ws://localhost:8787/connect" }).url).toBe("ws://localhost:8787/connect");
  });
});
