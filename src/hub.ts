import { DurableObject } from "cloudflare:workers";
import {
  type ActionName,
  DEVICE_NAME_RE,
  type ErrorCode,
  MAX_MESSAGE_BYTES,
  PING,
  PONG,
  clientMessageSchema,
  utf8Bytes,
} from "../shared/protocol";
import { parseDeviceKeys } from "./device-auth";

// すべての端末の WebSocket を1つの Durable Object（idFromName("hub")）で持つ。
// WebSocket Hibernation API を使うので、何も起きていない間は DO はメモリから降りる（ping は auto-response で返し、DO を起こさない）。
// MCP ツールからは RPC の listDevices / call で使う。

export const AUTH_HEADER = "X-CC-Remote-MCP-Authenticated-Device";
export const CLOSE_REPLACED = 4000;
export const CLOSE_REVOKED = 4003;
export const CALL_TIMEOUT_MS = 20_000;

// connId: 応答の照合に使う接続ごとの識別子（休止から戻ると WebSocket のオブジェクトは作り直されるので、オブジェクトの同一性では比べない）
// keyHash: 接続したときの DEVICE_KEYS のハッシュ。同じ端末名でトークンを入れ替えたら古い接続を閉じるのに使う
type Attachment = { device: string; connectedAt: number; connId: string; keyHash: string | null };

export type DeviceInfo = {
  name: string;
  online: boolean;
  platform: string | null;
  clientVersion: string | null;
  connectedAt: number | null;
  lastSeen: number | null;
  disconnectedAt: number | null;
};

export type CallOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: ErrorCode | "offline" | "timeout" | "unknown_device"; message: string };

type Pending = { connId: string; resolve: (o: CallOutcome) => void; timer: ReturnType<typeof setTimeout> };

type Row = {
  name: string;
  platform: string | null;
  client_version: string | null;
  connected_at: number | null;
  disconnected_at: number | null;
  last_seen: number | null;
};

const OPEN = 1;

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class DeviceHub extends DurableObject<Env> {
  private pending = new Map<string, Pending>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS devices (
        name TEXT PRIMARY KEY,
        platform TEXT,
        client_version TEXT,
        connected_at INTEGER,
        disconnected_at INTEGER,
        last_seen INTEGER
      )`,
    );
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  // Worker が端末を認証したあとにだけ呼ばれる（AUTH_HEADER は Worker が付け直す）
  override async fetch(request: Request): Promise<Response> {
    const device = request.headers.get(AUTH_HEADER) ?? "";
    if (!DEVICE_NAME_RE.test(device) || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Bad Request", { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.adopt(server, device);
    return new Response(null, { status: 101, webSocket: client });
  }

  // 新しい接続を受け入れる。同じ端末名の古い接続は閉じる（同時に1本だけ）
  adopt(ws: WebSocket, device: string, now = Date.now()): void {
    for (const old of this.ctx.getWebSockets(device)) {
      try {
        old.close(CLOSE_REPLACED, "replaced by a newer connection");
      } catch {
        // すでに閉じている
      }
    }
    this.ctx.acceptWebSocket(ws, [device]);
    const keyHash = parseDeviceKeys(this.env.DEVICE_KEYS).get(device) ?? null;
    ws.serializeAttachment({ device, connectedAt: now, connId: randomId(), keyHash } satisfies Attachment);
    this.ctx.storage.sql.exec(
      `INSERT INTO devices (name, connected_at, disconnected_at, last_seen) VALUES (?, ?, NULL, ?)
       ON CONFLICT(name) DO UPDATE SET connected_at = excluded.connected_at, disconnected_at = NULL, last_seen = excluded.last_seen`,
      device,
      now,
      now,
    );
  }

  private attachmentOf(ws: WebSocket): Attachment | null {
    const a = ws.deserializeAttachment() as Attachment | null;
    return a && typeof a.device === "string" && typeof a.connId === "string" ? a : null;
  }

  private deviceOf(ws: WebSocket): string | null {
    return this.attachmentOf(ws)?.device ?? null;
  }

  private openSocket(device: string): WebSocket | null {
    return this.ctx.getWebSockets(device).find((w) => w.readyState === OPEN) ?? null;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || utf8Bytes(message) > MAX_MESSAGE_BYTES) return;
    const att = this.attachmentOf(ws);
    if (!att) return;
    const device = att.device;
    let json: unknown;
    try {
      json = JSON.parse(message);
    } catch {
      return;
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const msg = parsed.data;
    const now = Date.now();

    if (msg.type === "hello") {
      this.ctx.storage.sql.exec(
        "UPDATE devices SET platform = ?, client_version = ?, last_seen = ? WHERE name = ?",
        msg.platform,
        msg.clientVersion,
        now,
        device,
      );
      return;
    }

    const p = this.pending.get(msg.id);
    // リクエストを送った接続からの応答だけを受け付ける
    if (!p || p.connId !== att.connId) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    this.ctx.storage.sql.exec("UPDATE devices SET last_seen = ? WHERE name = ?", now, device);
    p.resolve(msg.ok ? { ok: true, result: msg.result } : { ok: false, code: msg.error.code, message: msg.error.message });
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.onGone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {
      // すでに閉じている
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.onGone(ws);
  }

  private onGone(ws: WebSocket): void {
    const connId = this.attachmentOf(ws)?.connId;
    for (const [id, p] of this.pending) {
      if (p.connId !== connId) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve({ ok: false, code: "offline", message: "応答の前に端末との接続が切れた" });
    }
    const device = this.deviceOf(ws);
    if (!device) return;
    // 置き換えで閉じた古い接続なら、新しい接続が生きているので切断扱いにしない
    if (this.ctx.getWebSockets(device).some((w) => w !== ws && w.readyState === OPEN)) return;
    this.ctx.storage.sql.exec("UPDATE devices SET disconnected_at = ? WHERE name = ?", Date.now(), device);
  }

  // DEVICE_KEYS から外された端末、またはトークンを入れ替えた端末の古い接続を閉じる（失効をすぐ効かせる）
  private enforceRevocation(keys: Map<string, string>): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws);
      if (!att || keys.get(att.device) !== att.keyHash) {
        try {
          ws.close(CLOSE_REVOKED, "revoked");
        } catch {
          // すでに閉じている
        }
      }
    }
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const keys = parseDeviceKeys(this.env.DEVICE_KEYS);
    this.enforceRevocation(keys);
    const registered = new Set(keys.keys());
    const rows = new Map(
      (this.ctx.storage.sql.exec("SELECT * FROM devices").toArray() as unknown as Row[]).map((r) => [r.name, r]),
    );
    return [...registered].sort().map((name) => {
      const r = rows.get(name);
      return {
        name,
        online: this.openSocket(name) !== null,
        platform: r?.platform ?? null,
        clientVersion: r?.client_version ?? null,
        connectedAt: r?.connected_at ?? null,
        lastSeen: r?.last_seen ?? null,
        disconnectedAt: r?.disconnected_at ?? null,
      };
    });
  }

  async call(device: string, action: ActionName, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<CallOutcome> {
    const keys = parseDeviceKeys(this.env.DEVICE_KEYS);
    this.enforceRevocation(keys);
    if (!keys.has(device)) return { ok: false, code: "unknown_device", message: "登録されていない端末" };
    const ws = this.openSocket(device);
    if (!ws) return { ok: false, code: "offline", message: "端末がオフライン（クライアントが接続していない）" };

    const id = randomId();
    return new Promise<CallOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, code: "timeout", message: "端末から時間内に応答がなかった" });
      }, timeoutMs);
      const connId = this.attachmentOf(ws)?.connId ?? "";
      this.pending.set(id, { connId, resolve, timer });
      try {
        ws.send(JSON.stringify({ type: "request", id, action, params }));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, code: "offline", message: "端末への送信に失敗した" });
      }
    });
  }
}

export function getHub(env: Env) {
  return env.HUB.get(env.HUB.idFromName("hub"));
}
