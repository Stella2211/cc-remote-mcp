import fs from "node:fs";
import nodePath from "node:path";
import { parseDeviceKeys } from "../src/device-auth";
import { readWorkerName, WORKER_NAME_VAR } from "./deploy";

// フォークしたリポジトリのデプロイに要る値を集めて登録する（デプロイする PC で実行。Claude Code が動かしてよい）。
// CLOUDFLARE_API_TOKEN だけは人が作って環境変数（か .env.local）に入れる。値はどれも画面に出さない（repository variables を除く）。
//
//   bun run bootstrap github --mcp-host <MCP のホスト> --link-host <link のホスト> [--repo <owner/name>]
//                            [--account-id <ID>] [--worker-name <名前>] [--create-access-app --email <メールアドレス>] [--dry-run]
//     … アカウント ID・Zero Trust のチームのドメイン・Access アプリの AUD を API で調べ、
//       GitHub Actions の variables（CC_REMOTE_MCP_*）と secrets（CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID）を gh で入れる。
//       --create-access-app を付けたときだけ、MCP のホストの Access アプリ（Managed OAuth つき）と許可のポリシーを作る
//   bun run bootstrap worker-secrets [--email <メールアドレス>] [--worker-name <名前>] [--account-id <ID>] [--dry-run]
//     … Worker のシークレットを wrangler secret put で入れる（初回のデプロイのあとで）。
//       ALLOWED_EMAIL は --email、DEVICE_KEYS は devices.local.json、DISCORD_WEBHOOK_URL は同名の環境変数があるときだけ
//
// --dry-run は Cloudflare の読み取りだけ行い、登録する名前と登録先を表示して何も書かない。
// ホスト名は引数か、環境変数 CC_REMOTE_MCP_MCP_HOST / CC_REMOTE_MCP_LINK_HOST（.env.local）から取る。

export class BootstrapError extends Error {}

function fail(message: string): never {
  throw new BootstrapError(message);
}

export type Options = {
  command: "github" | "worker-secrets";
  dryRun: boolean;
  createAccessApp: boolean;
  repo?: string;
  mcpHost?: string;
  linkHost?: string;
  accountId?: string;
  workerName?: string;
  email?: string;
};

const USAGE = "使い方: bun run bootstrap github|worker-secrets [オプション]（scripts/bootstrap.ts の先頭を参照）";
const VALUE_FLAGS = {
  "--repo": "repo",
  "--mcp-host": "mcpHost",
  "--link-host": "linkHost",
  "--account-id": "accountId",
  "--worker-name": "workerName",
  "--email": "email",
} as const;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isHostname(s: string): boolean {
  return HOSTNAME.test(s);
}

// 引数を読む。足りない値は env（Bun が読んだ .env.local を含む）で補う
export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): Options {
  const [command, ...rest] = argv;
  if (command !== "github" && command !== "worker-secrets") fail(USAGE);
  const opts: Options = { command, dryRun: false, createAccessApp: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--create-access-app") opts.createAccessApp = true;
    else if (arg in VALUE_FLAGS) {
      const value = rest[++i];
      if (!value || value.startsWith("--")) fail(`${arg} に値がない`);
      opts[VALUE_FLAGS[arg as keyof typeof VALUE_FLAGS]] = value.trim();
    } else fail(`知らない引数: ${arg}\n${USAGE}`);
  }
  opts.mcpHost ??= env.CC_REMOTE_MCP_MCP_HOST?.trim() || undefined;
  opts.linkHost ??= env.CC_REMOTE_MCP_LINK_HOST?.trim() || undefined;
  opts.accountId ??= env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined;
  opts.workerName ??= env[WORKER_NAME_VAR]?.trim() || undefined;

  if (opts.workerName) readWorkerName({ [WORKER_NAME_VAR]: opts.workerName }); // 形だけ検査する（不正なら投げる）
  if (opts.repo && !REPO.test(opts.repo)) fail("--repo は owner/name の形で書く");
  if (opts.email && !EMAIL.test(opts.email)) fail("--email がメールアドレスの形ではない");
  if (opts.createAccessApp && opts.command !== "github") fail("--create-access-app は github だけで使える");
  if (opts.command === "github") {
    for (const [flag, host] of [["--mcp-host", opts.mcpHost], ["--link-host", opts.linkHost]] as const) {
      if (!host) fail(`${flag} がない（引数か .env.local の CC_REMOTE_MCP_${flag === "--mcp-host" ? "MCP" : "LINK"}_HOST）`);
      if (!isHostname(host)) fail(`${flag} はホスト名だけを書く（英小文字。https:// もパスも付けない）: ${host}`);
    }
    if (opts.mcpHost === opts.linkHost) fail("--mcp-host と --link-host は別のホスト名にする");
    if (opts.createAccessApp && !opts.email) fail("--create-access-app には --email（Access で許可するメールアドレス）が要る");
  }
  return opts;
}

// 登録する1件。value は実行するときだけ使い、表示には使わない（secret のとき）
export type Step = { kind: "gh-variable" | "gh-secret" | "wrangler-secret"; name: string; value: string; secret: boolean };

export function buildGithubPlan(v: {
  mcpHost: string;
  linkHost: string;
  teamDomain: string;
  aud: string;
  workerName?: string;
  accountId: string;
  apiToken: string;
}): Step[] {
  const variable = (name: string, value: string): Step => ({ kind: "gh-variable", name, value, secret: false });
  const secret = (name: string, value: string): Step => ({ kind: "gh-secret", name, value, secret: true });
  return [
    variable("CC_REMOTE_MCP_MCP_HOST", v.mcpHost),
    variable("CC_REMOTE_MCP_LINK_HOST", v.linkHost),
    variable("CC_REMOTE_MCP_ACCESS_TEAM_DOMAIN", v.teamDomain),
    variable("CC_REMOTE_MCP_ACCESS_AUD", v.aud),
    // 空なら触らない（すでに入っている名前を消さない）
    ...(v.workerName ? [variable(WORKER_NAME_VAR, v.workerName)] : []),
    secret("CLOUDFLARE_API_TOKEN", v.apiToken),
    secret("CLOUDFLARE_ACCOUNT_ID", v.accountId),
  ];
}

// devices.local.json を Worker の parseDeviceKeys と同じ規則で調べる。通らない中身を入れると全端末が切れるので、入れる前に止める。
// 中身（端末名・ハッシュ）はエラーに出さない
export function validateDeviceKeys(raw: string): void {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    fail("devices.local.json が JSON として読めない（DEVICE_KEYS は入れない）");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) fail("devices.local.json がオブジェクトではない（DEVICE_KEYS は入れない）");
  const total = Object.keys(json).length;
  if (total === 0) fail("devices.local.json に端末が1つもない。入れると全端末が切れる（DEVICE_KEYS は入れない）");
  const accepted = parseDeviceKeys(raw).size;
  if (accepted !== total) fail(`devices.local.json に Worker が受け付けない項目が ${total - accepted} 件ある（端末名か SHA-256 の形が違う。DEVICE_KEYS は入れない）`);
}

export function buildWorkerSecretPlan(v: { email?: string; deviceKeys?: string; discordWebhook?: string }): Step[] {
  const secret = (name: string, value: string): Step => ({ kind: "wrangler-secret", name, value, secret: true });
  return [
    ...(v.email ? [secret("ALLOWED_EMAIL", v.email)] : []),
    ...(v.deviceKeys ? [secret("DEVICE_KEYS", v.deviceKeys)] : []),
    ...(v.discordWebhook ? [secret("DISCORD_WEBHOOK_URL", v.discordWebhook)] : []),
  ];
}

// 表示用の1行。シークレットの値は出さない
export function describeStep(step: Step, target: string): string {
  const where = { "gh-variable": "GitHub variable", "gh-secret": "GitHub secret", "wrangler-secret": "Worker secret" }[step.kind];
  const shown = step.secret ? "（値は表示しない）" : `= ${step.value}`;
  return `${where} ${step.name} ${shown} → ${target}`;
}

// 実行するコマンド。シェルを通さない引数の配列で、シークレットの値は引数に置かず標準入力で渡す
export function commandFor(step: Step, target: string, bun = process.execPath): { argv: string[]; stdin?: string } {
  switch (step.kind) {
    case "gh-variable":
      return { argv: ["gh", "variable", "set", step.name, "--repo", target, "--body", step.value] };
    case "gh-secret":
      return { argv: ["gh", "secret", "set", step.name, "--repo", target], stdin: step.value };
    case "wrangler-secret":
      return { argv: [bun, "x", "wrangler", "secret", "put", step.name, "--name", target], stdin: step.value };
  }
}

// ---- Cloudflare Access ----

export type AccessApp = {
  id: string;
  name?: string;
  aud?: string;
  type?: string;
  domain?: string;
  self_hosted_domains?: string[];
  destinations?: { type?: string; uri?: string }[];
  oauth_configuration?: {
    enabled?: boolean;
    dynamic_client_registration?: { enabled?: boolean; allow_any_on_localhost?: boolean; allow_any_on_loopback?: boolean; allowed_uris?: string[] };
    grant?: { session_duration?: string; access_token_lifetime?: string };
  };
};

export const REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
// docs/setup.md の「Grant session duration：1か月」を時間で書いたもの
export const GRANT_SESSION_DURATION = "720h";

const normalize = (s: string) => s.trim().toLowerCase().replace(/\/+$/, "");

// host をそのまま（パスなしで）守っている Access アプリ
export function findAppsForHost(apps: AccessApp[], host: string): AccessApp[] {
  return apps.filter((app) => {
    const domains = [app.domain, ...(app.self_hosted_domains ?? []), ...(app.destinations ?? []).filter((d) => !d.type || d.type === "public").map((d) => d.uri)];
    return domains.some((d) => d && normalize(d) === host);
  });
}

// host（パスつきも含む）にかかっている Access アプリ。link のホストにあれば警告する
export function findAppsCovering(apps: AccessApp[], host: string): AccessApp[] {
  return apps.filter((app) => {
    const domains = [app.domain, ...(app.self_hosted_domains ?? []), ...(app.destinations ?? []).map((d) => d.uri)];
    return domains.some((d) => d && (normalize(d) === host || normalize(d).startsWith(`${host}/`)));
  });
}

// 見つけたアプリが docs/setup.md の設定と違うところ（書き換えはしない。直すのはダッシュボードか API で）
export function oauthWarnings(app: AccessApp): string[] {
  const o = app.oauth_configuration;
  const out: string[] = [];
  if (!o?.enabled) return ["Managed OAuth が無効"];
  const dcr = o.dynamic_client_registration;
  if (!dcr?.enabled) out.push("DCR（dynamic client registration）が無効");
  if (dcr?.allow_any_on_localhost || dcr?.allow_any_on_loopback) out.push("localhost / loopback のクライアントが許可されている");
  const uris = (dcr?.allowed_uris ?? []).map(normalize);
  const missing = REDIRECT_URIS.filter((u) => !uris.includes(normalize(u)));
  if (missing.length) out.push(`Allowed redirect URIs に足りない: ${missing.join(", ")}`);
  if (!o.grant?.session_duration) out.push("Grant session duration が未設定（約24時間でコネクタの再接続が要る）");
  return out;
}

export function accessPolicyBody(email: string) {
  return { name: "cc-remote-mcp: allow owner", decision: "allow", include: [{ email: { email } }] };
}

export function accessAppBody(mcpHost: string, policyId: string) {
  return {
    name: "cc-remote-mcp",
    type: "self_hosted",
    domain: mcpHost,
    destinations: [{ type: "public", uri: mcpHost }],
    policies: [{ id: policyId, precedence: 1 }],
    oauth_configuration: {
      enabled: true,
      dynamic_client_registration: { enabled: true, allow_any_on_localhost: false, allow_any_on_loopback: false, allowed_uris: REDIRECT_URIS },
      grant: { session_duration: GRANT_SESSION_DURATION },
    },
  };
}

type CfResponse<T> = { success: boolean; result: T; errors?: { code: number; message: string }[]; result_info?: { total_pages?: number } };

function cfClient(token: string) {
  return async function cf<T>(path: string, init?: { method: string; body: unknown }): Promise<CfResponse<T>> {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method: init?.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: init ? JSON.stringify(init.body) : undefined,
    });
    const json = (await res.json().catch(() => ({ success: false }))) as CfResponse<T>;
    if (!res.ok || !json.success) {
      const errors = (json.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
      fail(`Cloudflare API ${init?.method ?? "GET"} ${path.replace(/accounts\/[^/]+/, "accounts/<ID>")} が失敗: ${errors}`);
    }
    return json;
  };
}

type Io = { log: (s: string) => void };

async function resolveAccountId(cf: ReturnType<typeof cfClient>, given: string | undefined, io: Io): Promise<string> {
  if (given) return given;
  const { result } = await cf<{ id: string; name: string }[]>("/accounts?per_page=50");
  if (result.length === 1) {
    io.log(`Cloudflare アカウント: ${result[0]!.name}`);
    return result[0]!.id;
  }
  if (!result.length) fail("API トークンで見えるアカウントがない。トークンの対象アカウントを確かめる");
  return fail(`アカウントが複数ある。--account-id で選ぶ:\n${result.map((a) => `  ${a.id}  ${a.name}`).join("\n")}`);
}

async function listAccessApps(cf: ReturnType<typeof cfClient>, accountId: string): Promise<AccessApp[]> {
  const apps: AccessApp[] = [];
  for (let page = 1; ; page++) {
    const res = await cf<AccessApp[]>(`/accounts/${accountId}/access/apps?per_page=100&page=${page}`);
    apps.push(...res.result);
    if (page >= (res.result_info?.total_pages ?? 1)) return apps;
  }
}

function runSteps(steps: Step[], target: string, env: Record<string, string | undefined>, io: Io): void {
  for (const step of steps) {
    const { argv, stdin } = commandFor(step, target);
    io.log(describeStep(step, target));
    const proc = Bun.spawnSync(argv, {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "inherit",
      stderr: "inherit",
      env,
    });
    if (proc.exitCode !== 0) fail(`${argv[0] === "gh" ? "gh" : "wrangler"} が失敗した（${step.name}）。ここで止める`);
  }
}

function resolveRepo(given: string | undefined): string {
  if (given) return given;
  const proc = Bun.spawnSync(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { stderr: "pipe" });
  const repo = proc.stdout.toString().trim();
  if (proc.exitCode !== 0 || !REPO.test(repo)) fail("登録先のリポジトリがわからない。--repo <owner/name> で指定する（gh auth login も確かめる）");
  return repo;
}

export async function github(opts: Options, env: Record<string, string | undefined>, io: Io): Promise<void> {
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) fail("CLOUDFLARE_API_TOKEN が空。人が作ったトークンを環境変数か .env.local に入れる（docs/setup.md の権限の表）");
  const cf = cfClient(token);
  const repo = resolveRepo(opts.repo);
  io.log(`登録先のリポジトリ: ${repo}`);
  const accountId = await resolveAccountId(cf, opts.accountId, io);

  let teamDomain: string;
  try {
    teamDomain = (await cf<{ auth_domain?: string }>(`/accounts/${accountId}/access/organizations`)).result.auth_domain ?? "";
  } catch (e) {
    return fail(`${(e as Error).message}\nZero Trust を一度ダッシュボードで有効にしたか（チーム名とプラン）、トークンに Access: Organizations の Read があるかを確かめる`);
  }
  if (!teamDomain) fail("Zero Trust のチームのドメインが取れない。ダッシュボードで Zero Trust を有効にする");
  io.log(`Zero Trust のチームのドメイン: ${teamDomain}`);

  const apps = await listAccessApps(cf, accountId);
  for (const app of findAppsCovering(apps, opts.linkHost!)) {
    io.log(`警告: link のホストに Access アプリ「${app.name ?? app.id}」がかかっている。サービストークンを使わないなら外す（docs/auth/README.md）`);
  }
  const found = findAppsForHost(apps, opts.mcpHost!);
  if (found.length > 1) fail(`${opts.mcpHost} の Access アプリが複数ある（${found.map((a) => a.name ?? a.id).join(", ")}）。1つにする`);
  let aud = found[0]?.aud;
  if (found[0]) {
    io.log(`Access アプリ「${found[0].name ?? found[0].id}」を使う`);
    for (const w of oauthWarnings(found[0])) io.log(`警告: ${w}（docs/setup.md の手順 1 に合わせる）`);
    if (opts.createAccessApp) io.log("--create-access-app: すでにあるので作らない");
  } else if (!opts.createAccessApp) {
    fail(`${opts.mcpHost} の Access アプリがない。ダッシュボードで作る（docs/setup.md の手順 1）か、--create-access-app --email <メールアドレス> を付ける`);
  } else if (opts.dryRun) {
    io.log(`dry-run: ${opts.mcpHost} の Access アプリ（Managed OAuth・DCR つき）と、--email を許可するポリシーを作る（作らない）`);
    aud = "（作ったあとに決まる）";
  } else {
    const policy = (await cf<{ id: string }>(`/accounts/${accountId}/access/policies`, { method: "POST", body: accessPolicyBody(opts.email!) })).result;
    let app: AccessApp;
    try {
      app = (await cf<AccessApp>(`/accounts/${accountId}/access/apps`, { method: "POST", body: accessAppBody(opts.mcpHost!, policy.id) })).result;
    } catch (e) {
      return fail(`${(e as Error).message}\nポリシー「${accessPolicyBody("").name}」は作れたので、ダッシュボードで使うか消す`);
    }
    io.log(`Access アプリ「${app.name}」と許可のポリシーを作った`);
    aud = app.aud;
  }
  if (!aud) fail("Access アプリの AUD が取れない");

  const plan = buildGithubPlan({ mcpHost: opts.mcpHost!, linkHost: opts.linkHost!, teamDomain, aud, workerName: opts.workerName, accountId, apiToken: token });
  if (opts.dryRun) {
    io.log("dry-run: 次を登録する（何も書かない）");
    for (const step of plan) io.log(`  ${describeStep(step, repo)}`);
    return;
  }
  runSteps(plan, repo, env, io);
  io.log("GitHub に登録した。次: gh workflow run ci --repo " + repo + " --ref main（docs/setup.md）");
}

export function workerSecrets(opts: Options, root: string, env: Record<string, string | undefined>, io: Io): void {
  const keysFile = nodePath.join(root, "devices.local.json");
  const deviceKeys = fs.existsSync(keysFile) ? fs.readFileSync(keysFile, "utf8").trim() : undefined;
  if (deviceKeys !== undefined) validateDeviceKeys(deviceKeys);
  const plan = buildWorkerSecretPlan({ email: opts.email, deviceKeys, discordWebhook: env.DISCORD_WEBHOOK_URL?.trim() || undefined });
  if (!plan.length) fail("入れるものがない（--email、devices.local.json、環境変数 DISCORD_WEBHOOK_URL のどれもない）");
  if (!deviceKeys) io.log("devices.local.json がないので DEVICE_KEYS は入れない（bun run device add のあとでもう一度）");
  const base = Bun.JSONC.parse(fs.readFileSync(nodePath.join(root, "wrangler.jsonc"), "utf8")) as { name: string };
  const worker = opts.workerName ?? base.name;
  if (opts.dryRun) {
    io.log("dry-run: 次を登録する（何も書かない）");
    for (const step of plan) io.log(`  ${describeStep(step, worker)}`);
    return;
  }
  if (!env.CLOUDFLARE_API_TOKEN?.trim()) io.log("CLOUDFLARE_API_TOKEN がないので、wrangler のログインを使う");
  runSteps(plan, worker, { ...env, ...(opts.accountId ? { CLOUDFLARE_ACCOUNT_ID: opts.accountId } : {}) }, io);
  io.log(`Worker ${worker} にシークレットを入れた`);
}

if (import.meta.main) {
  const io = { log: (s: string) => console.log(s) };
  try {
    const opts = parseArgs(process.argv.slice(2), process.env);
    if (opts.command === "github") await github(opts, process.env, io);
    else workerSecrets(opts, nodePath.resolve(import.meta.dir, ".."), process.env, io);
  } catch (e) {
    console.error(e instanceof BootstrapError ? e.message : `予期しないエラー: ${(e as Error).message}`);
    process.exit(1);
  }
}
