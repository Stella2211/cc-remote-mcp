import { beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { FakeDurableObject } from "./support";

mock.module("cloudflare:workers", () => ({ DurableObject: FakeDurableObject }));

let worker: ExportedHandler<Env>;
beforeAll(async () => {
  worker = (await import("../src/index")).default;
});

const token = "k".repeat(43);
const forwarded: Request[] = [];
const hubStub = {
  fetch: async (req: Request) => {
    forwarded.push(req);
    return new Response("upgraded", { status: 200 });
  },
};
const env = {
  MCP_HOST: "cc-remote-mcp.example.com",
  LINK_HOST: "link.cc-remote-mcp.example.com",
  ALLOWED_EMAIL: "me@example.com",
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_AUD: "aud",
  DEVICE_KEYS: JSON.stringify({ "mac-mini": createHash("sha256").update(token).digest("hex") }),
  HUB: { idFromName: () => ({}), get: () => hubStub },
} as unknown as Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (url: string, init?: RequestInit, over: Partial<Env> = {}) =>
  worker.fetch!(new Request(url, init) as never, { ...env, ...over }, ctx);

const LINK = "https://link.cc-remote-mcp.example.com";
const upgrade = { Upgrade: "websocket", Connection: "Upgrade" };

describe("link host", () => {
  test("only /connect exists", async () => {
    expect((await call(`${LINK}/`)).status).toBe(404);
    expect((await call(`${LINK}/mcp`)).status).toBe(404);
  });

  test("non-WebSocket requests are refused", async () => {
    expect((await call(`${LINK}/connect`)).status).toBe(426);
  });

  test("a bad token is 401 and never reaches the hub", async () => {
    forwarded.length = 0;
    const res = await call(`${LINK}/connect`, { headers: { ...upgrade, Authorization: `Bearer ${"x".repeat(43)}`, "X-CC-Remote-MCP-Device": "mac-mini" } });
    expect(res.status).toBe(401);
    expect(forwarded).toEqual([]);
  });

  test("a good token reaches the hub with the device name and without the token", async () => {
    forwarded.length = 0;
    await call(`${LINK}/connect`, {
      headers: { ...upgrade, Authorization: `Bearer ${token}`, "X-CC-Remote-MCP-Device": "mac-mini", "X-CC-Remote-MCP-Authenticated-Device": "win-pc" },
    });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.headers.get("X-CC-Remote-MCP-Authenticated-Device")).toBe("mac-mini");
    expect(forwarded[0]!.headers.get("Authorization")).toBeNull();
  });
});

describe("MCP host", () => {
  const MCP = "https://cc-remote-mcp.example.com";

  test("paths other than /mcp are 404", async () => {
    expect((await call(`${MCP}/`)).status).toBe(404);
    expect((await call(`${MCP}/connect`, { headers: upgrade })).status).toBe(404);
  });

  test("/mcp without an Access JWT is 403", async () => {
    expect((await call(`${MCP}/mcp`, { method: "POST" })).status).toBe(403);
  });

  test("/mcp is 500 while ACCESS_AUD is empty (fail closed)", async () => {
    expect((await call(`${MCP}/mcp`, { method: "POST" }, { ACCESS_AUD: "" })).status).toBe(500);
  });

  test("DEV_BYPASS_ACCESS does nothing on the real host", async () => {
    expect((await call(`${MCP}/mcp`, { method: "POST" }, { DEV_BYPASS_ACCESS: "1" })).status).toBe(403);
  });
});

test("other hosts are 404", async () => {
  expect((await call("https://example.com/mcp")).status).toBe(404);
  expect((await call("https://example.com/connect", { headers: upgrade })).status).toBe(404);
});

describe("host vars", () => {
  test.each(["MCP_HOST", "LINK_HOST"] as const)("every host is 500 while %s is empty (fail closed)", async (name) => {
    forwarded.length = 0;
    for (const host of ["cc-remote-mcp.example.com", "link.cc-remote-mcp.example.com", "example.com"]) {
      expect((await call(`https://${host}/mcp`, { method: "POST" }, { [name]: "" })).status).toBe(500);
      expect((await call(`https://${host}/connect`, { headers: { ...upgrade, Authorization: `Bearer ${token}`, "X-CC-Remote-MCP-Device": "mac-mini" } }, { [name]: "" })).status).toBe(500);
    }
    expect(forwarded).toEqual([]);
  });

  test("localhost dev still works without host vars", async () => {
    forwarded.length = 0;
    const res = await call("http://localhost:8787/connect", { headers: { ...upgrade, Authorization: `Bearer ${token}`, "X-CC-Remote-MCP-Device": "mac-mini" } }, {
      MCP_HOST: "",
      LINK_HOST: "",
      DEV_BYPASS_ACCESS: "1",
    });
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
  });

  test("the hosts come from the vars", async () => {
    const over = { MCP_HOST: "mcp.other.test", LINK_HOST: "link.other.test" };
    expect((await call("https://cc-remote-mcp.example.com/mcp", { method: "POST" }, over)).status).toBe(404);
    expect((await call("https://mcp.other.test/mcp", { method: "POST" }, over)).status).toBe(403);
    expect((await call("https://link.other.test/connect", {}, over)).status).toBe(426);
  });
});
