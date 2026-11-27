import { beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { FakeDurableObject, sqlStorage } from "./support";

mock.module("cloudflare:workers", () => ({ DurableObject: FakeDurableObject }));
(globalThis as Record<string, unknown>).WebSocketRequestResponsePair = class {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
};

let Hub: typeof import("../src/hub").DeviceHub;
beforeAll(async () => {
  Hub = (await import("../src/hub")).DeviceHub;
});

class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  private attachment: unknown = null;
  constructor(readonly tags: string[] = []) {}
  send(data: string) {
    if (this.readyState !== 1) throw new Error("closed");
    this.sent.push(data);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  serializeAttachment(v: unknown) {
    this.attachment = structuredClone(v);
  }
  deserializeAttachment() {
    return this.attachment;
  }
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

function makeHub(devices: string[] = ["mac-mini", "win-pc"]) {
  const sockets: FakeSocket[] = [];
  const ctx = {
    storage: { sql: sqlStorage() },
    setWebSocketAutoResponse() {},
    acceptWebSocket(ws: FakeSocket, tags: string[]) {
      (ws as { tags: string[] }).tags.push(...tags);
      sockets.push(ws);
    },
    getWebSockets(tag?: string) {
      return sockets.filter((s) => (tag ? s.tags.includes(tag) : true));
    },
  };
  const env = { DEVICE_KEYS: JSON.stringify(Object.fromEntries(devices.map((d) => [d, hash(d)]))) } as unknown as Env;
  const hub = new Hub(ctx as never, env);
  return { hub, env, sockets };
}

const connect = (hub: InstanceType<typeof Hub>, device: string) => {
  const ws = new FakeSocket();
  hub.adopt(ws as never, device);
  return ws;
};

const lastRequest = (ws: FakeSocket) => JSON.parse(ws.sent.at(-1)!) as { id: string; action: string; params: unknown };
const respond = (hub: InstanceType<typeof Hub>, ws: FakeSocket, body: Record<string, unknown>) =>
  hub.webSocketMessage(ws as never, JSON.stringify({ type: "response", ...body }));

describe("DeviceHub", () => {
  test("lists registered devices with their connection state", async () => {
    const { hub } = makeHub();
    const ws = connect(hub, "mac-mini");
    await hub.webSocketMessage(ws as never, JSON.stringify({ type: "hello", protocol: 1, clientVersion: "0.1.0", platform: "darwin" }));
    const devices = await hub.listDevices();
    expect(devices.map((d) => [d.name, d.online, d.platform])).toEqual([
      ["mac-mini", true, "darwin"],
      ["win-pc", false, null],
    ]);
  });

  test("a hello with a hostile clientVersion is dropped like any invalid message", async () => {
    const { hub } = makeHub();
    const ws = connect(hub, "mac-mini");
    for (const v of ["0.1.0\n- name: evil", "1.0 <b>", "1\u202e0", "`x`", "", "9".repeat(33)]) {
      await hub.webSocketMessage(ws as never, JSON.stringify({ type: "hello", protocol: 1, clientVersion: v, platform: "darwin" }));
    }
    const mac = (await hub.listDevices()).find((d) => d.name === "mac-mini")!;
    expect(mac.clientVersion).toBeNull();
    expect(mac.platform).toBeNull();
  });

  test("a call is answered by the device's response", async () => {
    const { hub } = makeHub();
    const ws = connect(hub, "mac-mini");
    const pending = hub.call("mac-mini", "list_sessions", {});
    const sent = lastRequest(ws);
    expect(sent).toMatchObject({ action: "list_sessions", params: {} });
    await respond(hub, ws, { id: sent.id, ok: true, result: { sessions: [] } });
    expect(await pending).toEqual({ ok: true, result: { sessions: [] } });
  });

  test("errors from the device are passed through", async () => {
    const { hub } = makeHub();
    const ws = connect(hub, "mac-mini");
    const pending = hub.call("mac-mini", "list_dirs", { path: "/etc" });
    await respond(hub, ws, { id: lastRequest(ws).id, ok: false, error: { code: "forbidden", message: "no" } });
    expect(await pending).toEqual({ ok: false, code: "forbidden", message: "no" });
  });

  test("a response from another device's socket is ignored", async () => {
    const { hub } = makeHub();
    const mac = connect(hub, "mac-mini");
    const win = connect(hub, "win-pc");
    const pending = hub.call("mac-mini", "list_sessions", {}, 30);
    await respond(hub, win, { id: lastRequest(mac).id, ok: true, result: { sessions: ["forged"] } });
    expect(await pending).toMatchObject({ ok: false, code: "timeout" });
  });

  test("offline, unknown and revoked devices", async () => {
    const { hub, env } = makeHub();
    expect(await hub.call("win-pc", "list_sessions", {})).toMatchObject({ ok: false, code: "offline" });
    expect(await hub.call("ghost", "list_sessions", {})).toMatchObject({ ok: false, code: "unknown_device" });
    const ws = connect(hub, "win-pc");
    (env as { DEVICE_KEYS: string }).DEVICE_KEYS = JSON.stringify({ "mac-mini": hash("mac-mini") });
    expect(await hub.call("win-pc", "list_sessions", {})).toMatchObject({ ok: false, code: "unknown_device" });
    expect(ws.closed?.code).toBe(4003);
  });

  test("a new connection replaces the old one without marking the device offline", async () => {
    const { hub } = makeHub();
    const old = connect(hub, "mac-mini");
    const pending = hub.call("mac-mini", "list_sessions", {});
    const fresh = connect(hub, "mac-mini");
    expect(old.closed?.code).toBe(4000);
    await hub.webSocketClose(old as never, 4000);
    expect(await pending).toMatchObject({ ok: false, code: "offline" });
    const [mac] = await hub.listDevices();
    expect(mac).toMatchObject({ name: "mac-mini", online: true, disconnectedAt: null });
    expect(fresh.closed).toBeNull();
  });

  test("closing the only connection marks the device offline", async () => {
    const { hub } = makeHub();
    const ws = connect(hub, "mac-mini");
    ws.readyState = 3;
    await hub.webSocketClose(ws as never, 1006);
    const [mac] = await hub.listDevices();
    expect(mac!.online).toBe(false);
    expect(mac!.disconnectedAt).not.toBeNull();
  });

  test("rotating a device's token closes connections made with the old one", async () => {
    const { hub, env } = makeHub();
    const ws = connect(hub, "mac-mini");
    (env as { DEVICE_KEYS: string }).DEVICE_KEYS = JSON.stringify({ "mac-mini": hash("new-token"), "win-pc": hash("win-pc") });
    expect(await hub.call("mac-mini", "list_sessions", {})).toMatchObject({ ok: false, code: "offline" });
    expect(ws.closed?.code).toBe(4003);
    const fresh = connect(hub, "mac-mini");
    await hub.listDevices();
    expect(fresh.closed).toBeNull();
  });

  test("responses are matched by connection id, not by socket object", async () => {
    const { hub } = makeHub();
    const ws = connect(hub, "mac-mini");
    const pending = hub.call("mac-mini", "list_sessions", {});
    // 休止から戻ったときのように、同じ接続が別のオブジェクトとして渡される
    const revived = new FakeSocket(["mac-mini"]);
    revived.serializeAttachment(ws.deserializeAttachment());
    await respond(hub, revived, { id: lastRequest(ws).id, ok: true, result: { sessions: [] } });
    expect(await pending).toEqual({ ok: true, result: { sessions: [] } });
  });

  test("garbage and oversized messages are ignored", async () => {
    const { hub } = makeHub();
    const ws = connect(hub, "mac-mini");
    await hub.webSocketMessage(ws as never, "not json");
    await hub.webSocketMessage(ws as never, "x".repeat(300_000));
    await hub.webSocketMessage(ws as never, new ArrayBuffer(8));
    expect((await hub.listDevices())[0]!.online).toBe(true);
  });
});
