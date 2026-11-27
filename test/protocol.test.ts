import { expect, test } from "bun:test";
import { CLIENT_VERSION } from "../client/connection";
import { helloMessageSchema } from "../shared/protocol";

const hello = (clientVersion: string) => helloMessageSchema.safeParse({ type: "hello", protocol: 1, clientVersion, platform: "linux" }).success;

test("hello accepts the real client version and ordinary version strings", () => {
  for (const v of [CLIENT_VERSION, "0.1.0", "1.2.3-beta.1+build_5", "v2"]) expect(hello(v)).toBe(true);
});

test("hello rejects newlines, control characters, markup and overlong versions", () => {
  for (const v of ["", "1.0\n- name: x", "1.0\r", "1\u00000", "1‮0", "1 0", "<b>", "`1`", "[a](b)", "|", "é1", "1".repeat(33)]) {
    expect(hello(v)).toBe(false);
  }
});
