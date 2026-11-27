// Discord への通知。固定の書式で、rc と対話セッションの起動・停止とメール不一致の拒否だけを送る（プロンプトや入力の中身は送らない）。
// 呼び出し側は ctx.waitUntil(notify(...)) で使う。失敗しても throw しない。

export type NotifyEvent =
  | { type: "email_rejected"; email: string }
  | { type: "rc_started"; device: string; path: string; status: string }
  | { type: "rc_stopped"; device: string; path: string }
  | { type: "session_started"; device: string; path: string; status: string }
  | { type: "session_stopped"; device: string; path: string };

const WEBHOOK_PREFIXES = ["https://discord.com/api/webhooks/", "https://discordapp.com/api/webhooks/"];
const SUPPRESS_EMBEDS = 1 << 2;

export function isDiscordWebhook(url: string | undefined): url is string {
  if (!url || !WEBHOOK_PREFIXES.some((p) => url.startsWith(p))) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "discord.com" || u.hostname === "discordapp.com") && !u.username;
  } catch {
    return false;
  }
}

// 外部由来の文字列を Discord 上で無害にする（制御文字を除き、短く切り、Markdown 記号と @ を崩す）
export function neutralize(value: string, max = 80): string {
  const flat = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  const short = chars.length > max ? `…${chars.slice(-max).join("")}` : flat;
  return short.replace(/[\\`*_~|<>[\]()#:!-]/g, "\\$&").replace(/@/g, "@\u200b") || "(なし)";
}

export function jst(now = Date.now()): string {
  return `${new Date(now + 9 * 3600_000).toISOString().slice(0, 19).replace("T", " ")} JST`;
}

export function formatEvent(event: NotifyEvent, now = Date.now()): string {
  const at = `日時: ${jst(now)}`;
  switch (event.type) {
    case "email_rejected":
      return ["[cc-remote-mcp] 許可外のメールアドレスを拒否", at, `メール: ${neutralize(event.email)}`].join("\n");
    case "rc_started":
      return [
        "[cc-remote-mcp] claude rc を起動",
        at,
        `端末: ${neutralize(event.device, 32)}`,
        `場所: ${neutralize(event.path)}`,
        `状態: ${neutralize(event.status, 16)}`,
      ].join("\n");
    case "rc_stopped":
      return ["[cc-remote-mcp] claude rc を停止", at, `端末: ${neutralize(event.device, 32)}`, `場所: ${neutralize(event.path)}`].join("\n");
    case "session_started":
      return [
        "[cc-remote-mcp] 対話セッションを起動",
        at,
        `端末: ${neutralize(event.device, 32)}`,
        `場所: ${neutralize(event.path)}`,
        `状態: ${neutralize(event.status, 16)}`,
      ].join("\n");
    case "session_stopped":
      return ["[cc-remote-mcp] 対話セッションを停止", at, `端末: ${neutralize(event.device, 32)}`, `場所: ${neutralize(event.path)}`].join("\n");
  }
}

export async function notify(env: Env, event: NotifyEvent, fetcher: typeof fetch = fetch): Promise<void> {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!isDiscordWebhook(url)) return;
  try {
    const res = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: formatEvent(event), allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.log(JSON.stringify({ notify: event.type, status: res.status }));
  } catch {
    console.log(JSON.stringify({ notify: event.type, error: "send_failed" }));
  }
}
