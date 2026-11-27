import { describe, expect, test } from "bun:test";
import { OAUTH_CONFIGURATION, parseArgs, readSetupInput, runSetup } from "../scripts/setup";

const env = {
  CLOUDFLARE_API_TOKEN: "tok-secret",
  CC_REMOTE_MCP_MCP_HOST: "mcp.example.net",
  CC_REMOTE_MCP_LINK_HOST: "link.example.net",
  CC_REMOTE_MCP_ALLOWED_EMAIL: "me@example.org",
};

interface Call {
  method: string;
  path: string;
  body?: any;
}
interface Fake {
  accounts?: any[];
  org?: any | null; // null → 404
  idps?: any[];
  apps?: any[];
  fullApp?: any;
  policies?: any[];
  status?: Record<string, number>; // 例："GET /accounts/a1/access/apps" → 403
}

function fakeFetch(f: Fake) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.cloudflare.com/client/v4", "").split("?")[0]!;
    const method = init?.method ?? "GET";
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-secret");
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const respond = (result: unknown, status = 200) =>
      new Response(JSON.stringify(status < 300 ? { success: true, result, result_info: { total_pages: 1 } } : { success: false, errors: [{ code: 1, message: "x" }] }), { status });
    const forced = f.status?.[`${method} ${path}`];
    if (forced) return respond(null, forced);
    if (path === "/accounts") return respond(f.accounts ?? [{ id: "a1", name: "one" }]);
    if (path.endsWith("/access/organizations")) return f.org === null ? respond(null, 404) : respond(f.org ?? { auth_domain: "team.cloudflareaccess.com" });
    if (path.endsWith("/access/identity_providers")) return respond(f.idps ?? [{ id: "i", type: "onetimepin" }]);
    if (method === "GET" && path.endsWith("/access/apps")) return respond(f.apps ?? []);
    if (method === "GET" && /\/access\/apps\/[^/]+$/.test(path)) return respond(f.fullApp);
    if (method === "POST" && path.endsWith("/access/apps")) return respond({ id: "app1", aud: "new-aud" });
    if (method === "PUT" && /\/access\/apps\/[^/]+$/.test(path)) return respond({ id: "app1", aud: "old-aud" });
    if (method === "GET" && path.endsWith("/access/policies")) return respond(f.policies ?? []);
    if (method === "POST" && path.endsWith("/access/policies")) return respond({ id: "pol-new" });
    if (method === "PUT" && /\/access\/policies\/[^/]+$/.test(path)) return respond({ id: "pol1" });
    return respond(null, 500);
  };
  return { fn, calls, writes: () => calls.filter((c) => c.method !== "GET") };
}

const run = (f: Fake, args: string[] = [], e: Record<string, string | undefined> = env) => {
  const fake = fakeFetch(f);
  const lines: string[] = [];
  const p = runSetup({ env: e, args, fetch: fake.fn, log: (l) => lines.push(l) });
  return { p, fake, lines };
};

const goodPolicy = { id: "pol1", name: "cc-remote-mcp", decision: "allow", include: [{ email: { email: "me@example.org" } }] };
const existingApp = { id: "app1", type: "self_hosted", domain: "mcp.example.net", aud: "old-aud" };

describe("create path", () => {
  test("creates the policy and the app with Managed OAuth and prints the values", async () => {
    const { p, fake, lines } = run({});
    const r = await p;
    expect(r).toEqual({ accountId: "a1", teamDomain: "team.cloudflareaccess.com", aud: "new-aud", appAction: "created" });
    const w = fake.writes();
    expect(w.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /accounts/a1/access/policies", "POST /accounts/a1/access/apps"]);
    expect(w[0]!.body).toEqual({ name: "cc-remote-mcp", decision: "allow", include: [{ email: { email: "me@example.org" } }] });
    expect(w[1]!.body).toMatchObject({
      type: "self_hosted",
      domain: "mcp.example.net",
      destinations: [{ type: "public", uri: "mcp.example.net" }],
      policies: [{ id: "pol-new", precedence: 1 }],
      oauth_configuration: OAUTH_CONFIGURATION,
    });
    expect(OAUTH_CONFIGURATION.dynamic_client_registration.allow_any_on_localhost).toBe(false);
    const out = lines.join("\n");
    expect(out).toContain("gh variable set CC_REMOTE_MCP_ACCESS_AUD --body new-aud");
    expect(out).toContain("gh variable set CC_REMOTE_MCP_ACCESS_TEAM_DOMAIN --body team.cloudflareaccess.com");
    expect(out).toContain("gh secret set CLOUDFLARE_ACCOUNT_ID --body a1");
    expect(out).not.toContain("me@example.org");
    expect(out).not.toContain("tok-secret");
  });

  test("uses an existing reusable policy without changing it", async () => {
    const { p, fake } = run({ policies: [goodPolicy] });
    await p;
    expect(fake.writes().map((c) => `${c.method} ${c.path}`)).toEqual(["POST /accounts/a1/access/apps"]);
    expect(fake.writes()[0]!.body.policies).toEqual([{ id: "pol1", precedence: 1 }]);
  });

  test("dry-run reads only", async () => {
    const { p, fake, lines } = run({}, ["--dry-run"]);
    const r = await p;
    expect(r.appAction).toBe("would-create");
    expect(r.aud).toBeUndefined();
    expect(fake.writes()).toEqual([]);
    expect(lines.join("\n")).not.toContain("gh variable set CC_REMOTE_MCP_ACCESS_AUD");
  });

  test("masks the email in GitHub Actions without printing it elsewhere", async () => {
    const { p, lines } = run({}, [], { ...env, GITHUB_ACTIONS: "true" });
    await p;
    expect(lines.filter((l) => l.includes("me@example.org"))).toEqual(["::add-mask::me@example.org"]);
  });
});

describe("reuse path", () => {
  test("reads the AUD and writes nothing", async () => {
    const { p, fake } = run({ apps: [existingApp], policies: [goodPolicy] });
    const r = await p;
    expect(r).toMatchObject({ aud: "old-aud", appAction: "reused" });
    expect(fake.writes()).toEqual([]);
  });

  test("still writes nothing when the existing app differs from the script's values", async () => {
    const { p, fake } = run({ apps: [{ ...existingApp, oauth_configuration: { enabled: false } }] });
    expect((await p).appAction).toBe("reused");
    expect(fake.writes()).toEqual([]);
  });
});

describe("update path (--update-existing)", () => {
  test("PUTs the full app with only OAuth and policies replaced", async () => {
    const full = { ...existingApp, name: "mine", session_duration: "6h", custom_field: 1, policies: [{ id: "other", precedence: 1 }], oauth_configuration: { enabled: false } };
    const { p, fake } = run({ apps: [existingApp], fullApp: full, policies: [goodPolicy] }, ["--update-existing"]);
    expect(await p).toMatchObject({ aud: "old-aud", appAction: "updated" });
    const w = fake.writes();
    expect(w.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /accounts/a1/access/apps/app1"]);
    expect(w[0]!.body).toMatchObject({ name: "mine", session_duration: "6h", custom_field: 1, domain: "mcp.example.net", oauth_configuration: OAUTH_CONFIGURATION, policies: [{ id: "pol1", precedence: 1 }] });
    expect(w[0]!.body.aud).toBeUndefined();
  });

  test("fixes a policy with another email", async () => {
    const full = { ...existingApp, policies: [{ id: "pol1" }], oauth_configuration: OAUTH_CONFIGURATION };
    const stale = { ...goodPolicy, include: [{ email: { email: "x@example.org" } }] };
    const { p, fake } = run({ apps: [existingApp], fullApp: full, policies: [stale] }, ["--update-existing"]);
    await p;
    expect(fake.writes().map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /accounts/a1/access/policies/pol1", "PUT /accounts/a1/access/apps/app1"]);
  });

  test("does nothing when already as specified", async () => {
    const full = { ...existingApp, policies: [{ id: "pol1", precedence: 1 }], oauth_configuration: OAUTH_CONFIGURATION };
    const { p, fake } = run({ apps: [existingApp], fullApp: full, policies: [goodPolicy] }, ["--update-existing"]);
    expect((await p).appAction).toBe("unchanged");
    expect(fake.writes()).toEqual([]);
  });

  test("dry-run does not write", async () => {
    const full = { ...existingApp, policies: [], oauth_configuration: { enabled: false } };
    const { p, fake } = run({ apps: [existingApp], fullApp: full }, ["--update-existing", "--dry-run"]);
    expect((await p).appAction).toBe("would-update");
    expect(fake.writes()).toEqual([]);
  });
});

describe("failures", () => {
  test("Zero Trust not initialized", async () => {
    await expect(run({ org: null }).p).rejects.toThrow("Zero Trust が始まっていない");
    await expect(run({ org: { auth_domain: "" } }).p).rejects.toThrow("Zero Trust が始まっていない");
  });

  test("multiple accounts need CLOUDFLARE_ACCOUNT_ID", async () => {
    const accounts = [{ id: "a1", name: "First" }, { id: "a2", name: "Second" }];
    await expect(run({ accounts }).p).rejects.toThrow("CLOUDFLARE_ACCOUNT_ID");
    const r = await run({ accounts }, ["--dry-run"], { ...env, CLOUDFLARE_ACCOUNT_ID: "a2" }).p;
    expect(r.accountId).toBe("a2");
  });

  test("403 names the missing permission", async () => {
    await expect(run({ status: { "GET /accounts/a1/access/apps": 403 } }).p).rejects.toThrow("Access: Apps and Policies");
    await expect(run({ status: { "GET /accounts/a1/access/organizations": 403 } }).p).rejects.toThrow("Organizations");
  });

  test("input validation", () => {
    expect(() => readSetupInput({ ...env, CC_REMOTE_MCP_LINK_HOST: "mcp.example.net" })).toThrow("同じ");
    expect(() => readSetupInput({ ...env, CC_REMOTE_MCP_ALLOWED_EMAIL: undefined })).toThrow("CC_REMOTE_MCP_ALLOWED_EMAIL");
    expect(() => readSetupInput({ ...env, CC_REMOTE_MCP_MCP_HOST: "https://mcp.example.net/" })).toThrow("ホスト名");
    expect(() => parseArgs(["--force"])).toThrow("--force");
  });
});
