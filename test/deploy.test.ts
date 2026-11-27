import { describe, expect, test } from "bun:test";
import { buildDeployConfig, readDeployValues, readWorkerName } from "../scripts/deploy";

const full = {
  CC_REMOTE_MCP_MCP_HOST: "mcp.example.net",
  CC_REMOTE_MCP_LINK_HOST: "link.example.net",
  CC_REMOTE_MCP_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  CC_REMOTE_MCP_ACCESS_AUD: "aud",
};

describe("readDeployValues", () => {
  test("maps the CC_REMOTE_MCP_* variables to the Worker vars", () => {
    expect(readDeployValues(full)).toEqual({
      MCP_HOST: "mcp.example.net",
      LINK_HOST: "link.example.net",
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUD: "aud",
    });
  });

  test.each(Object.keys(full))("refuses when %s is missing or blank", (name) => {
    expect(() => readDeployValues({ ...full, [name]: undefined })).toThrow(name);
    expect(() => readDeployValues({ ...full, [name]: "  " })).toThrow(name);
  });
});

test("buildDeployConfig replaces the example routes and vars and keeps the rest", () => {
  const base = {
    name: "cc-remote-mcp",
    main: "src/index.ts",
    routes: [
      { pattern: "cc-remote-mcp.example.com", custom_domain: true },
      { pattern: "link.cc-remote-mcp.example.com", custom_domain: true },
    ],
    migrations: [{ tag: "v1", new_sqlite_classes: ["DeviceHub"] }],
    vars: { MCP_HOST: "cc-remote-mcp.example.com", LINK_HOST: "link.cc-remote-mcp.example.com", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", OTHER: "x" },
  };
  const out = buildDeployConfig(base, readDeployValues(full));
  expect(out.routes).toEqual([
    { pattern: "mcp.example.net", custom_domain: true },
    { pattern: "link.example.net", custom_domain: true },
  ]);
  expect(out.vars).toEqual({
    MCP_HOST: "mcp.example.net",
    LINK_HOST: "link.example.net",
    ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    ACCESS_AUD: "aud",
    OTHER: "x",
  });
  expect(out.name).toBe("cc-remote-mcp");
  expect(out.main).toBe("src/index.ts");
  expect(out.migrations).toEqual(base.migrations);
});

describe("worker name", () => {
  test("is optional and keeps the name in wrangler.jsonc when blank", () => {
    expect(readWorkerName({})).toBeUndefined();
    expect(readWorkerName({ CC_REMOTE_MCP_WORKER_NAME: "  " })).toBeUndefined();
    expect(buildDeployConfig({ name: "cc-remote-mcp" }, readDeployValues(full), undefined).name).toBe("cc-remote-mcp");
  });

  test("overrides the name so an already deployed Worker keeps its name", () => {
    const name = readWorkerName({ CC_REMOTE_MCP_WORKER_NAME: " old-worker " });
    expect(name).toBe("old-worker");
    expect(buildDeployConfig({ name: "cc-remote-mcp" }, readDeployValues(full), name).name).toBe("old-worker");
  });

  test.each(["Old-Worker", "-old", "old-", "old_worker", "a".repeat(64), "old worker"])("refuses %p", (name) => {
    expect(() => readWorkerName({ CC_REMOTE_MCP_WORKER_NAME: name })).toThrow("CC_REMOTE_MCP_WORKER_NAME");
  });
});
