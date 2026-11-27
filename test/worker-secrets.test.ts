import { describe, expect, test } from "bun:test";
import { planSecrets } from "../scripts/worker-secrets";

describe("planSecrets", () => {
  test("writes only the non-empty secrets, under the Worker secret names", () => {
    expect(
      planSecrets({
        CC_REMOTE_MCP_ALLOWED_EMAIL: " me@example.com ",
        CC_REMOTE_MCP_DEVICE_KEYS: '{"pc":"abc"}',
        CC_REMOTE_MCP_DISCORD_WEBHOOK_URL: "",
      }),
    ).toEqual([
      { name: "ALLOWED_EMAIL", value: "me@example.com" },
      { name: "DEVICE_KEYS", value: '{"pc":"abc"}' },
    ]);
  });

  test("returns nothing when all are unset or blank", () => {
    expect(planSecrets({})).toEqual([]);
    expect(planSecrets({ CC_REMOTE_MCP_ALLOWED_EMAIL: "  ", CC_REMOTE_MCP_DISCORD_WEBHOOK_URL: "\n" })).toEqual([]);
  });

  test("ignores unrelated variables", () => {
    expect(planSecrets({ ALLOWED_EMAIL: "x@example.com", CLOUDFLARE_API_TOKEN: "t" })).toEqual([]);
  });

  test("rejects DEVICE_KEYS that is not a JSON object, without echoing the value", () => {
    for (const bad of ["not json", "[]", "null", '"s"']) {
      expect(() => planSecrets({ CC_REMOTE_MCP_DEVICE_KEYS: bad })).toThrow(/JSON のオブジェクト/);
      try {
        planSecrets({ CC_REMOTE_MCP_DEVICE_KEYS: bad });
      } catch (err) {
        expect((err as Error).message).not.toContain(bad);
      }
    }
  });
});
