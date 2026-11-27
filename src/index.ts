import { createMcpHandler } from "agents/mcp/server";
import { checkAccess } from "./access";
import { authenticateDevice } from "./device-auth";
import { AUTH_HEADER, getHub } from "./hub";
import { createServer } from "./mcp/server";

// Durable Object のクラスは Worker の main から export する必要がある
export { DeviceHub } from "./hub";

const plain = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
const notFound = () => plain(404, "Not Found");

// ローカル開発専用。DEV_BYPASS_ACCESS=1 かつ localhost / 127.0.0.1 宛のときだけ真になる
function isLocalDev(url: URL, env: Env): boolean {
  return env.DEV_BYPASS_ACCESS === "1" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

// 端末からの WebSocket 接続。Access の対象外のホストなので、ここで端末トークンを検証する
async function handleLink(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return plain(426, "Upgrade Required");
  const device = await authenticateDevice(request, env);
  if (!device) {
    console.log(JSON.stringify({ link: "auth_failed" }));
    return plain(401, "Unauthorized");
  }
  // 端末名は認証の結果だけを DO に渡す（クライアントが付けた同名ヘッダーは上書きされる）。トークンは渡さない
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.delete("CF-Access-Client-Secret");
  headers.set(AUTH_HEADER, device);
  console.log(JSON.stringify({ link: "accepted", device }));
  return getHub(env).fetch(new Request(request.url, { method: "GET", headers }));
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const dev = isLocalDev(url, env);
    // ホスト名は wrangler.jsonc の vars（本番はデプロイ時に差し込む）。未設定なら fail closed
    const mcpHost = env.MCP_HOST;
    const linkHost = env.LINK_HOST;
    if (!dev && (!mcpHost || !linkHost)) {
      console.log(JSON.stringify({ hosts: "misconfigured" }));
      return plain(500, "Server misconfigured");
    }

    if (url.hostname === linkHost || (dev && url.pathname === "/connect")) {
      if (url.pathname !== "/connect") return notFound();
      return handleLink(request, env);
    }

    if (url.hostname === mcpHost || dev) {
      if (url.pathname !== "/mcp") return notFound();
      if (!dev) {
        const denied = await checkAccess(request, env, ctx);
        if (denied) return denied;
      }
      const handler = createMcpHandler(() => createServer(env, ctx), {
        route: "/mcp",
        corsOptions: false,
        allowedHostnames: dev ? ["localhost", "127.0.0.1"] : [mcpHost],
      });
      return handler(request, env, ctx);
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;
