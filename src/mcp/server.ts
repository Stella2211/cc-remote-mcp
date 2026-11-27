import { McpServer } from "@modelcontextprotocol/server";
import pkg from "../../package.json";
import { registerTools } from "./tools";

// 7ツール（端末一覧、rc 一覧・停止・起動、ディレクトリ一覧、対話セッションの起動、入力の送信）。Access の Managed OAuth を通ったクライアントには全部見える
export function createServer(env: Env, ctx: ExecutionContext): McpServer {
  const server = new McpServer({ name: "cc-remote-mcp", version: pkg.version });
  registerTools(server, env, ctx);
  return server;
}
