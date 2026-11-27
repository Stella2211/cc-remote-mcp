import fs from "node:fs";
import nodePath from "node:path";
import { MAX_MESSAGE_BYTES, utf8Bytes } from "../shared/protocol";
import { handleRequest } from "./actions";
import { ConfigError, loadConfig, realFs } from "./config";
import { Link } from "./connection";
import { type InteractiveBackend, InteractiveManager } from "./interactive";
import { PtyBackend, bunSupportsConpty } from "./interactive-pty";
import { TmuxBackend, defaultTmuxRunner, tmuxEnv } from "./interactive-tmux";
import { SessionManager, StartLock } from "./sessions";

// PC 側の常駐クライアント。使い方：bun run client/main.ts [--env <path>]
// 既定の設定ファイルは、このファイルと同じフォルダの .env（client/.env）

const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

function envPath(): string {
  const i = process.argv.indexOf("--env");
  if (i !== -1 && process.argv[i + 1]) return nodePath.resolve(process.argv[i + 1]!);
  return nodePath.join(import.meta.dir, ".env");
}

// claude の実行ファイル。Windows の .cmd / .bat はシェル経由でしか起動できないので使わない
function resolveClaude(configured: string | null, platform: string): string {
  const found = configured ?? Bun.which("claude");
  if (!found) throw new ConfigError("claude が見つからない。CLAUDE_BIN にフルパスを書く");
  if (platform === "win32" && /\.(cmd|bat)$/i.test(found)) {
    throw new ConfigError("Windows では claude.exe（ネイティブ版）を使う。CLAUDE_BIN に claude.exe のフルパスを書く");
  }
  return found;
}

// tmux の実行ファイル。launchd などでは PATH に Homebrew が入っていないので、よくある場所も探す。見つからなければ null（対話セッションだけ使えない）
function resolveTmux(configured: string | null, platform: string): string | null {
  if (platform === "win32") return null;
  if (configured) return configured;
  const found = Bun.which("tmux");
  if (found) return found;
  for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // 無い
    }
  }
  return null;
}

// 対話セッションの入れ物を OS で選ぶ。macOS / Linux は tmux、Windows は Bun の疑似端末（ConPTY）
function interactiveBackend(platform: string, tmuxBin: string | null): { backend: InteractiveBackend | null; unavailable?: string } {
  if (platform === "win32") {
    if (!bunSupportsConpty(Bun.version)) {
      return { backend: null, unavailable: `Windows で対話セッションを使うには Bun 1.3.14 以降が要る（今は ${Bun.version}）。端末で bun upgrade を実行してクライアントを起動し直す` };
    }
    return { backend: new PtyBackend({ platform: "win32" }) };
  }
  if (!tmuxBin) return { backend: null, unavailable: "tmux が見つからない。端末に tmux を入れる（macOS は brew install tmux）か、TMUX_BIN にフルパスを書く" };
  return { backend: new TmuxBackend(defaultTmuxRunner(tmuxBin, tmuxEnv(process.env))) };
}

function main(): void {
  let config: ReturnType<typeof loadConfig>;
  let claudeBin: string;
  try {
    config = loadConfig(envPath());
    claudeBin = resolveClaude(config.claudeBin, config.policy.platform);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`設定エラー: ${err.message}`);
      // 設定の誤りは再起動しても直らないので、サービス側の再起動で連打しないよう少し待ってから終わる
      setTimeout(() => process.exit(78), 30_000);
      return;
    }
    throw err;
  }

  const tmuxBin = resolveTmux(config.tmuxBin, config.policy.platform);
  // rc と対話セッションは上限を合算するので、起動の検査と登録を1つの錠で順番に行う
  const startLock = new StartLock();
  const sessions: SessionManager = new SessionManager({
    platform: config.policy.platform,
    deviceName: config.deviceName,
    claudeBin,
    maxSessions: config.maxSessions,
    othersActive: () => interactive.activeCount(),
    startLock,
    defaultPermissionMode: config.defaultPermissionMode,
  });
  // 対話セッションは macOS / Linux では tmux の中で動くので、クライアントを止めても（再起動しても）終わらない。
  // ただし Linux の systemd は KillMode=mixed でサービスの cgroup ごと止めるので、tmux も一緒に止まる。
  // Windows ではクライアントの疑似端末の中で動くので、クライアントと一緒に終わる
  const interactive: InteractiveManager = new InteractiveManager({
    platform: config.policy.platform,
    deviceName: config.deviceName,
    claudeBin,
    ...interactiveBackend(config.policy.platform, tmuxBin),
    defaultPermissionMode: config.defaultPermissionMode,
    activeRc: () => sessions.activeCount(),
    maxSessions: config.maxSessions,
    startLock,
    log,
  });

  const link = new Link({
    url: config.url,
    deviceName: config.deviceName,
    token: config.deviceToken,
    platform: config.policy.platform,
    accessClientId: config.accessClientId,
    accessClientSecret: config.accessClientSecret,
    log,
    onRequest: async (raw) => {
      const reply = await handleRequest({ policy: config.policy, fs: realFs, sessions, interactive }, raw);
      if (!reply) return null;
      const text = JSON.stringify(reply);
      if (utf8Bytes(text) <= MAX_MESSAGE_BYTES) return text;
      // 大きすぎて送れない応答は、黙って捨てずに失敗として返す（Worker を待たせない）
      return JSON.stringify({ type: "response", id: reply.id, ok: false, error: { code: "internal", message: "応答が大きすぎる" } });
    },
  });

  log({ start: config.deviceName, roots: config.policy.roots.length, claude: claudeBin, tmux: tmuxBin, bun: Bun.version });
  link.start();

  const shutdown = () => {
    log({ stop: "signal" });
    link.stop();
    sessions.stopAll();
    interactive.shutdown();
    // rc が Ctrl+C を受けて片付けるのを少し待つ
    setTimeout(() => process.exit(0), 3_000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
