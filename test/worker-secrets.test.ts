import { describe, expect, test } from "bun:test";
const HASH = "a".repeat(64);
import { planSecrets } from "../scripts/worker-secrets";

describe("planSecrets", () => {
  test("writes only the non-empty secrets, under the Worker secret names", () => {
    expect(
      planSecrets({
        CC_REMOTE_MCP_ALLOWED_EMAIL: " me@example.com ",
        CC_REMOTE_MCP_DEVICE_KEYS: JSON.stringify({ pc: HASH }),
        CC_REMOTE_MCP_DISCORD_WEBHOOK_URL: "",
      }),
    ).toEqual([
      { name: "ALLOWED_EMAIL", value: "me@example.com" },
      { name: "DEVICE_KEYS", value: JSON.stringify({ pc: HASH }) },
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
    for (const bad of ["not json", "[]", "null", '"s"', "{}", '{"pc":"abc"}', JSON.stringify({ pc: HASH, "bad name": HASH }), JSON.stringify({ pc: 1 })]) {
      expect(() => planSecrets({ CC_REMOTE_MCP_DEVICE_KEYS: bad })).toThrow();
      try {
        planSecrets({ CC_REMOTE_MCP_DEVICE_KEYS: bad });
      } catch (err) {
        expect((err as Error).message).not.toContain(bad);
      }
    }
  });

  test("accepts upper-case hashes like the Worker does", () => {
    const value = JSON.stringify({ pc: "A".repeat(64) });
    expect(planSecrets({ CC_REMOTE_MCP_DEVICE_KEYS: value })).toEqual([{ name: "DEVICE_KEYS", value }]);
  });
});
