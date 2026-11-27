import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { authenticateDevice, constantTimeEqual, parseDeviceKeys } from "../src/device-auth";

const token = "t".repeat(43);
const hash = createHash("sha256").update(token).digest("hex");
const env = { DEVICE_KEYS: JSON.stringify({ "mac-mini": hash }) } as unknown as Env;

const request = (headers: Record<string, string>) => new Request("https://link.cc-remote-mcp.example.com/connect", { headers });

describe("parseDeviceKeys", () => {
  test("keeps only valid names and hashes", () => {
    const keys = parseDeviceKeys(JSON.stringify({ "mac-mini": hash.toUpperCase(), "Bad Name": hash, pc: "short", win: 1 }));
    expect([...keys]).toEqual([["mac-mini", hash]]);
  });

  test.each([undefined, "", "not json", "[]", "null"])("broken input %p is empty", (raw) => {
    expect(parseDeviceKeys(raw).size).toBe(0);
  });
});

describe("authenticateDevice", () => {
  test("accepts the right token for the device", async () => {
    expect(await authenticateDevice(request({ Authorization: `Bearer ${token}`, "X-CC-Remote-MCP-Device": "mac-mini" }), env)).toBe("mac-mini");
  });

  test.each([
    ["wrong token", { Authorization: `Bearer ${"u".repeat(43)}`, "X-CC-Remote-MCP-Device": "mac-mini" }],
    ["unknown device", { Authorization: `Bearer ${token}`, "X-CC-Remote-MCP-Device": "other" }],
    ["no device header", { Authorization: `Bearer ${token}` }],
    ["no token", { "X-CC-Remote-MCP-Device": "mac-mini" }],
    ["basic auth", { Authorization: `Basic ${token}`, "X-CC-Remote-MCP-Device": "mac-mini" }],
    ["bad device name", { Authorization: `Bearer ${token}`, "X-CC-Remote-MCP-Device": "../hub" }],
  ])("rejects %s", async (_, headers) => {
    expect(await authenticateDevice(request(headers as Record<string, string>), env)).toBeNull();
  });

  test("rejects everything when DEVICE_KEYS is unset", async () => {
    expect(await authenticateDevice(request({ Authorization: `Bearer ${token}`, "X-CC-Remote-MCP-Device": "mac-mini" }), {} as Env)).toBeNull();
  });
});

test("constantTimeEqual", () => {
  expect(constantTimeEqual("abc", "abc")).toBe(true);
  expect(constantTimeEqual("abc", "abd")).toBe(false);
  expect(constantTimeEqual("abc", "abcd")).toBe(false);
});
