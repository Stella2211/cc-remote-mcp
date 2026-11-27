import pkg from "../package.json";
import { MAX_MESSAGE_BYTES, PING, PONG, PROTOCOL_VERSION, utf8Bytes } from "../shared/protocol";

// Worker への WebSocket を張り続ける。切れたら指数バックオフ（揺らぎ付き、最大60秒）でつなぎ直す。
// PC 側は外から接続を受けない。こちらからつなぎに行くだけ。

export const CLIENT_VERSION: string = pkg.version;

// 同じ端末名で別のクライアントがつないだとき、Worker が古い方をこのコードで閉じる
export const CLOSE_REPLACED = 4000;

export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
  return Math.round(base * (0.5 + random() * 0.5));
}

// WebSocket の error イベントから、ログに残せる理由を取り出す。Bun は error.code（ENOTFOUND など）と
// message（URL とステータスだけ。ヘッダーは入らない）を持つ。長さは切り詰め、トークンらしい文字列は伏せる
export function describeError(ev: unknown): { reason?: string; code?: string } {
  const e = ev as { message?: unknown; error?: { code?: unknown; message?: unknown } } | null;
  const out: { reason?: string; code?: string } = {};
  const message = typeof e?.message === "string" ? e.message : typeof e?.error?.message === "string" ? e.error.message : "";
  if (message) out.reason = message.replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 200);
  if (typeof e?.error?.code === "string") out.code = e.error.code.slice(0, 40);
  return out;
}

export type LinkOptions = {
  url: string;
  deviceName: string;
  token: string;
  platform: "darwin" | "linux" | "win32";
  accessClientId: string | null;
  accessClientSecret: string | null;
  onRequest: (raw: string) => Promise<string | null>;
  log: (event: Record<string, unknown>) => void;
  heartbeatMs?: number;
  pongTimeoutMs?: number;
  connectTimeoutMs?: number;
};

export class Link {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pongTimer?: ReturnType<typeof setTimeout>;
  private stableTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly opts: LinkOptions) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, "client stopping");
  }

  private clearTimers(): void {
    clearInterval(this.heartbeat);
    clearTimeout(this.pongTimer);
    clearTimeout(this.stableTimer);
    clearTimeout(this.connectTimer);
  }

  private connect(): void {
    if (this.stopped) return;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.token}`,
      "X-CC-Remote-MCP-Device": this.opts.deviceName,
    };
    // 任意：link. ホストを Access のサービストークンでも守る場合
    if (this.opts.accessClientId && this.opts.accessClientSecret) {
      headers["CF-Access-Client-Id"] = this.opts.accessClientId;
      headers["CF-Access-Client-Secret"] = this.opts.accessClientSecret;
    }

    let ws: WebSocket;
    try {
      // Bun の WebSocket はハンドシェイクにヘッダーを付けられる
      ws = new WebSocket(this.opts.url, { headers } as unknown as string[]);
    } catch {
      this.scheduleReconnect(undefined);
      return;
    }
    this.ws = ws;
    // スリープ復帰直後などで接続が開かないまま止まるのを防ぐ
    this.connectTimer = setTimeout(() => {
      if (this.ws !== ws || ws.readyState === WebSocket.OPEN) return;
      this.opts.log({ link: "connect_timeout" });
      this.ws = null;
      this.clearTimers();
      try {
        ws.close();
      } catch {
        // まだ開いていない
      }
      this.scheduleReconnect(undefined);
    }, this.opts.connectTimeoutMs ?? 15_000);

    ws.addEventListener("open", () => {
      clearTimeout(this.connectTimer);
      this.opts.log({ link: "open" });
      ws.send(
        JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, clientVersion: CLIENT_VERSION, platform: this.opts.platform }),
      );
      // 1分つながっていたら、バックオフを最初に戻す
      this.stableTimer = setTimeout(() => {
        this.attempt = 0;
      }, 60_000);
      this.heartbeat = setInterval(() => this.ping(ws), this.opts.heartbeatMs ?? 25_000);
    });

    ws.addEventListener("message", (ev) => {
      const data = typeof ev.data === "string" ? ev.data : null;
      if (data === null || utf8Bytes(data) > MAX_MESSAGE_BYTES) return;
      if (data === PONG) {
        clearTimeout(this.pongTimer);
        return;
      }
      void this.opts.onRequest(data).then((reply) => {
        if (reply === null || ws.readyState !== WebSocket.OPEN) return;
        if (utf8Bytes(reply) > MAX_MESSAGE_BYTES) {
          this.opts.log({ link: "reply_too_large" });
          return;
        }
        ws.send(reply);
      });
    });

    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      this.opts.log({ link: "closed", code: ev.code });
      this.scheduleReconnect(ev.code);
    });

    ws.addEventListener("error", (ev) => {
      // close が続いて来るので、ここではログだけ。理由（ENOTFOUND、401 での拒否など）も残す
      this.opts.log({ link: "error", ...describeError(ev) });
    });
  }

  private ping(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(PING);
    clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      // 応答がない（スリープ復帰・回線切り替えなど）。張り直す
      this.opts.log({ link: "pong_timeout" });
      ws.close(4002, "pong timeout");
      if (this.ws === ws) {
        this.ws = null;
        this.clearTimers();
        this.scheduleReconnect(4002);
      }
    }, this.opts.pongTimeoutMs ?? 10_000);
  }

  private scheduleReconnect(code: number | undefined): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    // 別のクライアントに置き換えられたときは、取り合いにならないよう長めに待つ
    const delay = code === CLOSE_REPLACED ? 5 * 60_000 : backoffMs(this.attempt);
    this.attempt += 1;
    this.opts.log({ link: "reconnect_scheduled", ms: delay });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
