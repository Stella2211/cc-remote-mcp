import { DEVICE_NAME_RE, DEVICE_TOKEN_RE } from "../shared/protocol";

// 各PCのクライアントの認証。端末ごとのトークン（32バイトの乱数）を Authorization: Bearer で受け取り、
// その SHA-256 を DEVICE_KEYS（端末名 → SHA-256 の16進）と比べる。Worker はトークンそのものを持たない。

const HEX64 = /^[0-9a-f]{64}$/;

export function parseDeviceKeys(raw: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  if (!raw) return keys;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return keys;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return keys;
  for (const [name, hash] of Object.entries(json)) {
    if (DEVICE_NAME_RE.test(name) && typeof hash === "string" && HEX64.test(hash.toLowerCase())) {
      keys.set(name, hash.toLowerCase());
    }
  }
  return keys;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 長さが同じ文字列どうしを、途中で打ち切らずに比べる
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 端末名を返す。通らなければ null（理由は返さない）
export async function authenticateDevice(request: Request, env: Env): Promise<string | null> {
  const name = request.headers.get("X-CC-Remote-MCP-Device") ?? "";
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!DEVICE_NAME_RE.test(name) || !DEVICE_TOKEN_RE.test(token)) return null;
  const expected = parseDeviceKeys(env.DEVICE_KEYS).get(name);
  // 未登録の端末名でもハッシュ計算はしておき、応答時間で登録の有無を見分けにくくする
  const actual = await sha256Hex(token);
  if (!expected) return null;
  return constantTimeEqual(actual, expected) ? name : null;
}
