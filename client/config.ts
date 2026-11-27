import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { DEVICE_NAME_RE, DEVICE_TOKEN_RE, PERMISSION_MODES } from "../shared/protocol";
import { ALWAYS_BLOCKED, type FsOps, type Platform, type Policy } from "./paths";

// クライアントの設定（client/.env）。Bun が cwd の .env を自動で読むのには頼らず、このファイルだけを明示的に読む

export type Config = {
  url: string;
  deviceName: string;
  deviceToken: string;
  policy: Policy;
  claudeBin: string | null;
  tmuxBin: string | null;
  maxSessions: number;
  defaultPermissionMode: (typeof PERMISSION_MODES)[number] | null;
  accessClientId: string | null;
  accessClientSecret: string | null;
};

// KEY=VALUE の行だけを読む。# の行と空行は無視。値の前後の引用符（" か '）は外す。変数展開はしない
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}

export function currentPlatform(): Platform {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  throw new Error(`未対応のOS: ${p}`);
}

// PATH と同じ区切り（macOS/Linux は :、Windows は ;）で並べたパスの一覧
export function splitList(platform: Platform, value: string | undefined): string[] {
  if (!value) return [];
  const sep = platform === "win32" ? ";" : ":";
  return value
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const realFs: FsOps = {
  realpath: (p) => fs.realpathSync.native(p),
  isDirectory: (p) => fs.statSync(p).isDirectory(),
  readdir: (p) =>
    fs.readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, dirLike: d.isDirectory() || d.isSymbolicLink() })),
};

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return nodePath.join(home, p.slice(2));
  return p;
}

export class ConfigError extends Error {}

export function buildConfig(env: Record<string, string>, opts: { platform: Platform; home: string; fs: FsOps }): Config {
  const { platform, home } = opts;
  const path = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const need = (key: string) => {
    const v = env[key]?.trim();
    if (!v) throw new ConfigError(`${key} が未設定`);
    return v;
  };

  const url = need("CC_REMOTE_MCP_URL");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError("CC_REMOTE_MCP_URL が URL として読めない");
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (!(parsed.protocol === "wss:" || (local && parsed.protocol === "ws:"))) {
    throw new ConfigError("CC_REMOTE_MCP_URL は wss:// にする（ws:// は localhost のときだけ）");
  }

  const deviceName = need("DEVICE_NAME");
  if (!DEVICE_NAME_RE.test(deviceName)) throw new ConfigError("DEVICE_NAME は英小文字・数字・ハイフンの1〜32文字");
  const deviceToken = need("DEVICE_TOKEN");
  if (!DEVICE_TOKEN_RE.test(deviceToken)) throw new ConfigError("DEVICE_TOKEN の形式が不正（bun run device init で作る）");

  const absolute = (p: string, key: string) => {
    const expanded = expandHome(p, home);
    if (!path.isAbsolute(expanded)) throw new ConfigError(`${key} に相対パスがある: ${p}`);
    return path.resolve(expanded);
  };
  const real = (p: string) => {
    try {
      return opts.fs.realpath(p);
    } catch {
      return p;
    }
  };

  const roots = splitList(platform, env.ALLOWED_ROOTS).map((p) => absolute(p, "ALLOWED_ROOTS"));
  if (roots.length === 0) throw new ConfigError("ALLOWED_ROOTS が未設定（一覧・起動を許すディレクトリを1つ以上）");
  const realRoots = roots.map((r) => {
    try {
      const rr = opts.fs.realpath(r);
      if (!opts.fs.isDirectory(rr)) throw new Error();
      return rr;
    } catch {
      throw new ConfigError(`ALLOWED_ROOTS のディレクトリが無い: ${r}`);
    }
  });
  const blocked = [
    ...splitList(platform, env.BLOCKED_DIRS).map((p) => absolute(p, "BLOCKED_DIRS")),
    ...ALWAYS_BLOCKED.map((p) => path.join(home, p)),
  ].map(real);

  const maxSessions = env.MAX_SESSIONS ? Number(env.MAX_SESSIONS) : 4;
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 16) throw new ConfigError("MAX_SESSIONS は1〜16の整数");

  const mode = env.DEFAULT_PERMISSION_MODE?.trim() || null;
  if (mode && !(PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new ConfigError(`DEFAULT_PERMISSION_MODE は ${PERMISSION_MODES.join(" / ")} のどれか`);
  }

  const claudeBin = env.CLAUDE_BIN?.trim() ? absolute(env.CLAUDE_BIN.trim(), "CLAUDE_BIN") : null;
  const tmuxBin = env.TMUX_BIN?.trim() ? absolute(env.TMUX_BIN.trim(), "TMUX_BIN") : null;
  const accessClientId = env.CF_ACCESS_CLIENT_ID?.trim() || null;
  const accessClientSecret = env.CF_ACCESS_CLIENT_SECRET?.trim() || null;
  if (!!accessClientId !== !!accessClientSecret) throw new ConfigError("CF_ACCESS_CLIENT_ID と CF_ACCESS_CLIENT_SECRET は両方そろえる");

  return {
    url,
    deviceName,
    deviceToken,
    policy: {
      platform,
      roots: realRoots,
      blocked,
      hideDotDirs: (env.HIDE_DOT_DIRS ?? "true").trim().toLowerCase() !== "false",
      home: real(home),
    },
    claudeBin,
    tmuxBin,
    maxSessions,
    defaultPermissionMode: mode as Config["defaultPermissionMode"],
    accessClientId,
    accessClientSecret,
  };
}

export function loadConfig(envPath: string): Config {
  let text: string;
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch {
    throw new ConfigError(`設定ファイルが読めない: ${envPath}（client/.env.example をコピーして作る）`);
  }
  return buildConfig(parseEnv(text), { platform: currentPlatform(), home: os.homedir(), fs: realFs });
}
