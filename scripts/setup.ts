// Cloudflare Access のアプリ（Managed OAuth）を API で用意し、デプロイに要る秘密ではない値を出す。
// GitHub Actions の setup.yml（workflow_dispatch）か、手元（.env.local に API トークンがあるとき）で動かす。何度動かしても同じ結果になる。
//
//   bun run setup --dry-run          … 読むだけ。作る・変えるものを表示する
//   bun run setup                    … 無ければ作る。あれば AUD を読むだけ（変更しない）
//   bun run setup --update-existing  … 既存のアプリの OAuth 設定とポリシーをこのスクリプトの値に合わせる
//
// 環境変数：CLOUDFLARE_API_TOKEN（必須）、CLOUDFLARE_ACCOUNT_ID（任意。アカウントが複数のときは必須）、
// CC_REMOTE_MCP_MCP_HOST / CC_REMOTE_MCP_LINK_HOST / CC_REMOTE_MCP_ALLOWED_EMAIL（必須）。
// API トークンとメールアドレスは出力しない。

const API = "https://api.cloudflare.com/client/v4";
const APP_NAME = "cc-remote-mcp";
const POLICY_NAME = "cc-remote-mcp";
const REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
// 注意：Managed OAuth は Cloudflare 側で Beta。フィールド名は公式 API リファレンス（SelfHostedApplication）の記載による。実機での確認は未了
export const OAUTH_CONFIGURATION = {
  enabled: true,
  dynamic_client_registration: {
    enabled: true,
    allowed_uris: REDIRECT_URIS,
    allow_any_on_localhost: false,
    allow_any_on_loopback: false,
  },
  // API は「日」の単位を持たないので、docs/setup.md の「1か月」は 720h にする
  grant: { session_duration: "720h", access_token_lifetime: "15m" },
};

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface SetupOptions {
  env: Record<string, string | undefined>;
  args: string[];
  fetch: Fetch;
  log: (line: string) => void;
}
export interface SetupResult {
  accountId: string;
  teamDomain: string;
  aud: string | undefined; // dry-run で新規作成になるときだけ undefined
  appAction: "created" | "reused" | "updated" | "unchanged" | "would-create" | "would-update";
}

// 権限不足（403）のときに、どの API にどの権限が要るかを出すための表。名前はダッシュボードでの表記
const PERMISSION_HINTS: Record<string, string> = {
  accounts: "Account Settings: Read（アカウントの一覧。未確認）",
  organizations: "Access: Organizations, Identity Providers, and Groups: Read",
  identity_providers: "Access: Organizations, Identity Providers, and Groups: Read",
  apps: "Access: Apps and Policies: Edit（読むだけなら Read）",
  policies: "Access: Apps and Policies: Edit（読むだけなら Read）",
};

class CloudflareError extends Error {}

export function parseArgs(args: string[]): { dryRun: boolean; updateExisting: boolean } {
  const known = new Set(["--dry-run", "--update-existing"]);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length) throw new Error(`知らない引数: ${unknown.join(" ")}（使えるのは --dry-run と --update-existing）`);
  return { dryRun: args.includes("--dry-run"), updateExisting: args.includes("--update-existing") };
}

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function readSetupInput(env: Record<string, string | undefined>) {
  const get = (name: string) => env[name]?.trim() ?? "";
  const missing = ["CLOUDFLARE_API_TOKEN", "CC_REMOTE_MCP_MCP_HOST", "CC_REMOTE_MCP_LINK_HOST", "CC_REMOTE_MCP_ALLOWED_EMAIL"].filter((n) => !get(n));
  if (missing.length) throw new Error(`環境変数が空: ${missing.join(", ")}`);
  const mcpHost = get("CC_REMOTE_MCP_MCP_HOST").toLowerCase();
  const linkHost = get("CC_REMOTE_MCP_LINK_HOST").toLowerCase();
  for (const [name, host] of [["CC_REMOTE_MCP_MCP_HOST", mcpHost], ["CC_REMOTE_MCP_LINK_HOST", linkHost]] as const) {
    if (!HOST.test(host)) throw new Error(`${name} がホスト名として使えない（https:// もパスも付けない）`);
  }
  if (mcpHost === linkHost) throw new Error("CC_REMOTE_MCP_MCP_HOST と CC_REMOTE_MCP_LINK_HOST が同じ。link. は Access の対象にしない別のホスト名にする");
  const email = get("CC_REMOTE_MCP_ALLOWED_EMAIL");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("CC_REMOTE_MCP_ALLOWED_EMAIL がメールアドレスの形ではない");
  return { token: get("CLOUDFLARE_API_TOKEN"), accountId: get("CLOUDFLARE_ACCOUNT_ID"), mcpHost, linkHost, email };
}

type Json = Record<string, any>;

function client(token: string, fetchFn: Fetch) {
  async function call(method: string, path: string, body?: unknown): Promise<{ result: any; info?: Json }> {
    const res = await fetchFn(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // JSON でない応答は下のエラーにまとめる
    }
    if (res.status === 401) throw new CloudflareError("API トークンが無効（401）。CLOUDFLARE_API_TOKEN を確かめる");
    if (res.status === 403) {
      const hint = PERMISSION_HINTS[path === "/accounts" ? "accounts" : (/\/access\/([a-z_]+)/.exec(path)?.[1] ?? "")];
      throw new CloudflareError(`権限が足りない（403）：${method} ${path.split("?")[0]!.replace(/\/accounts\/[^/]+/, "/accounts/<id>")}${hint ? `。API トークンに「${hint}」を足す` : ""}`);
    }
    if (!res.ok || json.success === false) {
      const msg = Array.isArray(json.errors) ? json.errors.map((e: Json) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ") : "";
      throw new CloudflareError(`Cloudflare API のエラー（${res.status}）：${method} ${path.split("?")[0]!.replace(/\/accounts\/[^/]+/, "/accounts/<id>")}${msg ? ` ${msg}` : ""}`);
    }
    return { result: json.result, info: json.result_info };
  }
  // 一覧は per_page=50 でページを辿る
  async function list(path: string): Promise<Json[]> {
    const out: Json[] = [];
    for (let page = 1; page <= 20; page++) {
          const { result, info } = await call("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=50&page=${page}`);
      out.push(...((result as Json[] | null) ?? []));
      if (!info?.total_pages || page >= info.total_pages) break;
    }
    return out;
  }
  return { call, list };
}

async function resolveAccountId(cf: ReturnType<typeof client>, given: string): Promise<string> {
  if (given) return given;
  const accounts = await cf.list("/accounts");
  if (accounts.length === 1) return String(accounts[0]!.id);
  if (accounts.length === 0) throw new CloudflareError("API トークンから見えるアカウントが無い。CLOUDFLARE_ACCOUNT_ID を設定する");
  const names = accounts.map((a) => String(a.name ?? "(名前なし)")).join(", ");
  throw new CloudflareError(`アカウントが${accounts.length}つ見える（${names}）。使うアカウントの ID を CLOUDFLARE_ACCOUNT_ID に設定する`);
}

async function readTeamDomain(cf: ReturnType<typeof client>, accountId: string): Promise<string> {
  let org: Json | null = null;
  try {
    org = (await cf.call("GET", `/accounts/${accountId}/access/organizations`)).result;
  } catch (err) {
    // Zero Trust が未開始のアカウントは、組織が無い旨のエラー（404 など）になる。権限不足（403）はそのまま出す
    if (!(err instanceof CloudflareError) || err.message.includes("403") || err.message.includes("401")) throw err;
  }
  const domain = typeof org?.auth_domain === "string" ? org.auth_domain.trim() : "";
  if (!domain) {
    throw new CloudflareError(
      "このアカウントは Zero Trust が始まっていない。ダッシュボードで Zero Trust を開き、チーム名の決定・Free プランの選択・支払い情報の入力を済ませる（API ではできない、人間が1回だけ行う作業）。そのあと setup をやり直す",
    );
  }
  return domain;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const { dryRun, updateExisting } = parseArgs(opts.args);
  const input = readSetupInput(opts.env);
  const { log } = opts;
  // Actions のログに出ても伏せ字になるようにする（ここでは値自体を出さない）
  if (opts.env.GITHUB_ACTIONS === "true") log(`::add-mask::${input.email}`);
  const cf = client(input.token, opts.fetch);

  const accountId = await resolveAccountId(cf, input.accountId);
  const teamDomain = await readTeamDomain(cf, accountId);
  log(`Zero Trust のチームのドメインを読んだ。dry-run=${dryRun} update-existing=${updateExisting}`);

  // IdP が0件のときは警告だけ（Zero Trust を始めると One-time PIN が入る想定。未確認）
  const idps = await cf.list(`/accounts/${accountId}/access/identity_providers`);
  if (idps.length === 0) log("警告：ログイン方法（IdP）が1つも無い。Managed OAuth のログインが通らない。ダッシュボードで One-time PIN などを足す");

  // 既存のアプリを MCP のホストで探す。link. のホストを含むアプリがあれば警告する
  const apps = await cf.list(`/accounts/${accountId}/access/apps`);
  const covers = (app: Json, host: string) => app.domain === host || (Array.isArray(app.destinations) && app.destinations.some((d: Json) => d?.uri === host));
  const existing = apps.find((a) => a.type === "self_hosted" && covers(a, input.mcpHost));
  if (apps.some((a) => a.type === "self_hosted" && covers(a, input.linkHost))) {
    log("警告：link. のホストを含む Access アプリがある。Service Auth を使う設計でなければ、link. は対象に含めない（docs/auth）");
  }

  // 再利用ポリシーを名前で探す
  const policies = await cf.list(`/accounts/${accountId}/access/policies`);
  const policy = policies.find((p) => p.name === POLICY_NAME);
  const policyBody = { name: POLICY_NAME, decision: "allow", include: [{ email: { email: input.email } }] };
  const policyMatches = !!policy && policy.decision === "allow" && sameJson(policy.include, policyBody.include);

  let appAction: SetupResult["appAction"];
  let aud: string | undefined;

  if (!existing) {
    if (dryRun) {
      log(`dry-run：Access アプリ「${APP_NAME}」を作る（Managed OAuth、許可はメールアドレス1件のポリシー${policy ? "（既存のポリシーを使う）" : "を新しく作る"}）`);
      appAction = "would-create";
    } else {
      let policyId: string;
      if (policy) {
        policyId = String(policy.id);
        if (!policyMatches) log("警告：既存のポリシー「cc-remote-mcp」の許可メールアドレスが指定と違う。変更しない（--update-existing で合わせる）");
      } else {
        policyId = String((await cf.call("POST", `/accounts/${accountId}/access/policies`, policyBody)).result.id);
        log("再利用ポリシー「cc-remote-mcp」を作った");
      }
      const app = (
        await cf.call("POST", `/accounts/${accountId}/access/apps`, {
          type: "self_hosted",
          name: APP_NAME,
          domain: input.mcpHost,
          destinations: [{ type: "public", uri: input.mcpHost }],
          policies: [{ id: policyId, precedence: 1 }],
          oauth_configuration: OAUTH_CONFIGURATION,
        })
      ).result;
      aud = String(app.aud);
      appAction = "created";
    }
  } else if (!updateExisting) {
    aud = String(existing.aud);
    log("既存の Access アプリを使う（変更しない。合わせたいときは --update-existing）");
    appAction = "reused";
  } else {
    // 既存のアプリに OAuth 設定とポリシーだけを重ねる。PUT は GET した全フィールドを含める（含めないと既存の設定が消える）
    const full = (await cf.call("GET", `/accounts/${accountId}/access/apps/${existing.id}`)).result as Json;
    aud = String(full.aud);
    const policyIds = Array.isArray(full.policies) ? full.policies.map((p: unknown) => (typeof p === "string" ? p : (p as Json).id)) : [];
    const oauthSame = sameJson(full.oauth_configuration, OAUTH_CONFIGURATION);
    const policyAttached = !!policy && policyIds.includes(policy.id);
    if (oauthSame && policyAttached && policyMatches) {
      log("既存の Access アプリは指定どおり（変更なし）");
      appAction = "unchanged";
    } else if (dryRun) {
      log(`dry-run：既存の Access アプリを更新する（OAuth 設定${oauthSame ? "は同じ" : "を合わせる"}、ポリシー${policyAttached && policyMatches ? "は同じ" : "を合わせる"}）`);
      appAction = "would-update";
    } else {
      let policyId: string;
      if (!policy) {
        policyId = String((await cf.call("POST", `/accounts/${accountId}/access/policies`, policyBody)).result.id);
      } else {
        policyId = String(policy.id);
        // 注意：再利用ポリシーの PUT の body は name / decision / include のみで足りる想定（未確認）
        if (!policyMatches) await cf.call("PUT", `/accounts/${accountId}/access/policies/${policyId}`, policyBody);
      }
      const next: Json = { ...full, oauth_configuration: OAUTH_CONFIGURATION, policies: [{ id: policyId, precedence: 1 }] };
      // 読み取り専用のフィールド（id・aud・時刻）は PUT しても無視される想定だが、念のため外す（未確認）
      for (const k of ["id", "aud", "created_at", "updated_at"]) delete next[k];
      await cf.call("PUT", `/accounts/${accountId}/access/apps/${existing.id}`, next);
      log("既存の Access アプリを更新した");
      appAction = "updated";
    }
  }

  log("");
  log("結果（秘密ではない値）");
  log(`CLOUDFLARE_ACCOUNT_ID=${accountId}`);
  log(`CC_REMOTE_MCP_ACCESS_TEAM_DOMAIN=${teamDomain}`);
  log(`CC_REMOTE_MCP_ACCESS_AUD=${aud ?? "(dry-run のため未定。作成後に確定)"}`);
  log(`Access アプリ：${appAction}`);
  if (aud) {
    log("");
    log("次に Claude Code が実行する：");
    log(`gh secret set CLOUDFLARE_ACCOUNT_ID --body ${accountId}`);
    log(`gh variable set CC_REMOTE_MCP_ACCESS_TEAM_DOMAIN --body ${teamDomain}`);
    log(`gh variable set CC_REMOTE_MCP_ACCESS_AUD --body ${aud}`);
  }
  return { accountId, teamDomain, aud, appAction };
}

if (import.meta.main) {
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    console.log(line);
  };
  let code = 0;
  try {
    await runSetup({ env: process.env, args: process.argv.slice(2), fetch: (u, i) => fetch(u, i), log });
  } catch (err) {
    console.error((err as Error).message);
    lines.push(`エラー：${(err as Error).message}`);
    code = 1;
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const body = lines.filter((l) => !l.startsWith("::add-mask::")).join("\n");
    await Bun.write(summary, `${(await Bun.file(summary).exists()) ? await Bun.file(summary).text() : ""}## setup\n\n\`\`\`\n${body}\n\`\`\`\n`);
  }
  process.exit(code);
}
