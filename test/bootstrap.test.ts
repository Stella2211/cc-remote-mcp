import { describe, expect, test } from "bun:test";
import {
  accessAppBody,
  accessPolicyBody,
  BootstrapError,
  buildGithubPlan,
  buildWorkerSecretPlan,
  commandFor,
  describeStep,
  findAppsCovering,
  findAppsForHost,
  oauthWarnings,
  parseArgs,
  REDIRECT_URIS,
  type AccessApp,
} from "../scripts/bootstrap";

const hosts = ["--mcp-host", "mcp.example.net", "--link-host", "link.example.net"];
const TOKEN = "token-value-that-must-not-show";

const fails = (fn: () => unknown, re: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(re);
    return;
  }
  throw new Error("failed to fail");
};

describe("parseArgs", () => {
  test("reads the github options", () => {
    const opts = parseArgs(["github", ...hosts, "--repo", "someone/cc-remote-mcp", "--worker-name", "my-worker", "--dry-run"]);
    expect(opts).toMatchObject({
      command: "github",
      dryRun: true,
      createAccessApp: false,
      repo: "someone/cc-remote-mcp",
      mcpHost: "mcp.example.net",
      linkHost: "link.example.net",
      workerName: "my-worker",
    });
  });

  test("falls back to the environment (.env.local) for hosts, account and worker name", () => {
    const opts = parseArgs(["github"], {
      CC_REMOTE_MCP_MCP_HOST: "mcp.example.net",
      CC_REMOTE_MCP_LINK_HOST: "link.example.net",
      CLOUDFLARE_ACCOUNT_ID: "0123abcd",
      CC_REMOTE_MCP_WORKER_NAME: "my-worker",
    });
    expect(opts).toMatchObject({ mcpHost: "mcp.example.net", linkHost: "link.example.net", accountId: "0123abcd", workerName: "my-worker" });
    expect(parseArgs(["github", "--mcp-host", "a.example.net", "--link-host", "b.example.net"], { CC_REMOTE_MCP_MCP_HOST: "x.example.net" }).mcpHost).toBe(
      "a.example.net",
    );
  });

  test.each([
    [[], /使い方/],
    [["deploy"], /使い方/],
    [["github", "--link-host", "link.example.net"], /--mcp-host がない/],
    [["github", "--mcp-host", "https://mcp.example.net", "--link-host", "link.example.net"], /ホスト名だけ/],
    [["github", "--mcp-host", "mcp.example.net/mcp", "--link-host", "link.example.net"], /ホスト名だけ/],
    [["github", "--mcp-host", "MCP.example.net", "--link-host", "link.example.net"], /ホスト名だけ/],
    [["github", "--mcp-host", "same.example.net", "--link-host", "same.example.net"], /別のホスト名/],
    [["github", ...hosts, "--repo"], /--repo に値がない/],
    [["github", ...hosts, "--repo", "--dry-run"], /--repo に値がない/],
    [["github", ...hosts, "--repo", "no-slash"], /owner\/name/],
    [["github", ...hosts, "--create-access-app"], /--email/],
    [["github", ...hosts, "--create-access-app", "--email", "not-an-email"], /メールアドレスの形/],
    [["github", ...hosts, "--worker-name", "Bad_Name"], /CC_REMOTE_MCP_WORKER_NAME/],
    [["github", ...hosts, "--force"], /知らない引数/],
    [["worker-secrets", "--create-access-app"], /github だけ/],
  ] as [string[], RegExp][])("refuses %p", (argv, re) => {
    fails(() => parseArgs(argv), re);
  });

  test("worker-secrets needs no hosts", () => {
    expect(parseArgs(["worker-secrets", "--email", "me@example.com"])).toMatchObject({ command: "worker-secrets", email: "me@example.com" });
  });

  test("errors are BootstrapError", () => {
    expect(() => parseArgs(["nope"])).toThrow(BootstrapError);
  });
});

describe("plans", () => {
  const github = buildGithubPlan({
    mcpHost: "mcp.example.net",
    linkHost: "link.example.net",
    teamDomain: "team.cloudflareaccess.com",
    aud: "aud-example",
    accountId: "account-example",
    apiToken: TOKEN,
  });

  test("github sets the four variables and the two secrets the workflow reads", () => {
    expect(github.map((s) => [s.kind, s.name])).toEqual([
      ["gh-variable", "CC_REMOTE_MCP_MCP_HOST"],
      ["gh-variable", "CC_REMOTE_MCP_LINK_HOST"],
      ["gh-variable", "CC_REMOTE_MCP_ACCESS_TEAM_DOMAIN"],
      ["gh-variable", "CC_REMOTE_MCP_ACCESS_AUD"],
      ["gh-secret", "CLOUDFLARE_API_TOKEN"],
      ["gh-secret", "CLOUDFLARE_ACCOUNT_ID"],
    ]);
  });

  test("the worker name variable is set only when given", () => {
    const plan = buildGithubPlan({ mcpHost: "m", linkHost: "l", teamDomain: "t", aud: "a", accountId: "x", apiToken: "y", workerName: "my-worker" });
    expect(plan.find((s) => s.name === "CC_REMOTE_MCP_WORKER_NAME")).toMatchObject({ kind: "gh-variable", value: "my-worker" });
  });

  test("worker secrets include only what is available", () => {
    expect(buildWorkerSecretPlan({}).length).toBe(0);
    expect(buildWorkerSecretPlan({ email: "me@example.com", deviceKeys: "{}" }).map((s) => s.name)).toEqual(["ALLOWED_EMAIL", "DEVICE_KEYS"]);
    expect(buildWorkerSecretPlan({ discordWebhook: "https://discord.example/x" }).map((s) => s.name)).toEqual(["DISCORD_WEBHOOK_URL"]);
    expect(buildWorkerSecretPlan({ email: "a@example.com", deviceKeys: "{}", discordWebhook: "w" }).every((s) => s.secret)).toBe(true);
  });
});

describe("redaction", () => {
  const secret = { kind: "gh-secret", name: "CLOUDFLARE_API_TOKEN", value: TOKEN, secret: true } as const;
  const variable = { kind: "gh-variable", name: "CC_REMOTE_MCP_MCP_HOST", value: "mcp.example.net", secret: false } as const;
  const worker = { kind: "wrangler-secret", name: "ALLOWED_EMAIL", value: "me@example.com", secret: true } as const;

  test("describeStep never shows a secret value", () => {
    expect(describeStep(secret, "someone/repo")).not.toContain(TOKEN);
    expect(describeStep(worker, "cc-remote-mcp")).not.toContain("me@example.com");
    expect(describeStep(variable, "someone/repo")).toContain("mcp.example.net");
  });

  test("secret values go through stdin, never argv", () => {
    const gh = commandFor(secret, "someone/repo");
    expect(gh.argv).toEqual(["gh", "secret", "set", "CLOUDFLARE_API_TOKEN", "--repo", "someone/repo"]);
    expect(gh.stdin).toBe(TOKEN);
    const wr = commandFor(worker, "my-worker", "/bin/bun");
    expect(wr.argv).toEqual(["/bin/bun", "x", "wrangler", "secret", "put", "ALLOWED_EMAIL", "--name", "my-worker"]);
    expect(wr.stdin).toBe("me@example.com");
    expect(commandFor(variable, "someone/repo")).toEqual({ argv: ["gh", "variable", "set", "CC_REMOTE_MCP_MCP_HOST", "--repo", "someone/repo", "--body", "mcp.example.net"] });
  });
});

describe("Access apps", () => {
  const apps: AccessApp[] = [
    { id: "1", name: "by-domain", domain: "mcp.example.net", aud: "a1" },
    { id: "2", name: "by-destination", destinations: [{ type: "public", uri: "other.example.net/" }] },
    { id: "3", name: "with-path", domain: "link.example.net/admin" },
    { id: "4", name: "private", destinations: [{ type: "private", uri: "mcp2.example.net" }] },
  ];

  test("findAppsForHost matches the host without a path", () => {
    expect(findAppsForHost(apps, "mcp.example.net").map((a) => a.id)).toEqual(["1"]);
    expect(findAppsForHost(apps, "other.example.net").map((a) => a.id)).toEqual(["2"]);
    expect(findAppsForHost(apps, "link.example.net")).toEqual([]);
    expect(findAppsForHost(apps, "mcp2.example.net")).toEqual([]);
    expect(findAppsForHost([{ id: "5", domain: "MCP.Example.net" }], "mcp.example.net").length).toBe(1);
  });

  test("findAppsCovering also catches paths under the host", () => {
    expect(findAppsCovering(apps, "link.example.net").map((a) => a.id)).toEqual(["3"]);
    expect(findAppsCovering(apps, "link2.example.net")).toEqual([]);
  });

  test("the created app matches docs/setup.md step 1", () => {
    const body = accessAppBody("mcp.example.net", "policy-id");
    expect(body).toMatchObject({ type: "self_hosted", domain: "mcp.example.net", policies: [{ id: "policy-id", precedence: 1 }] });
    expect(oauthWarnings({ id: "x", ...body })).toEqual([]);
    expect(accessPolicyBody("me@example.com")).toMatchObject({ decision: "allow", include: [{ email: { email: "me@example.com" } }] });
  });

  test("oauthWarnings lists what differs from the docs", () => {
    expect(oauthWarnings({ id: "x" })).toEqual(["Managed OAuth が無効"]);
    const w = oauthWarnings({
      id: "x",
      oauth_configuration: { enabled: true, dynamic_client_registration: { enabled: false, allow_any_on_localhost: true, allowed_uris: [REDIRECT_URIS[0]!] } },
    });
    expect(w.join("\n")).toMatch(/DCR/);
    expect(w.join("\n")).toMatch(/localhost/);
    expect(w.join("\n")).toContain(REDIRECT_URIS[1]!);
    expect(w.join("\n")).toMatch(/Grant session duration/);
  });
});
