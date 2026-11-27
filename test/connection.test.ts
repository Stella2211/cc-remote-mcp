import { describe, expect, test } from "bun:test";
import { describeError } from "../client/connection";

describe("describeError", () => {
  test("Bun の error イベントから理由とコードを取り出す", () => {
    const ev = {
      type: "error",
      message: "WebSocket connection to 'wss://link.example/connect' failed: Failed to connect",
      error: { code: "ENOTFOUND", message: "ignored when message exists" },
    };
    expect(describeError(ev)).toEqual({
      reason: "WebSocket connection to 'wss://link.example/connect' failed: Failed to connect",
      code: "ENOTFOUND",
    });
  });

  test("message がなければ error.message を使う", () => {
    expect(describeError({ error: { message: "boom" } })).toEqual({ reason: "boom" });
  });

  test("何も取れなければ空（ログの形を壊さない）", () => {
    expect(describeError({})).toEqual({});
    expect(describeError(null)).toEqual({});
    expect(describeError("x")).toEqual({});
  });

  test("長すぎる理由は切り詰め、トークンらしい長い文字列は伏せる", () => {
    const token = "A".repeat(43);
    const out = describeError({ message: `bad ${token} ${"x ".repeat(300)}` });
    expect(out.reason).not.toContain(token);
    expect(out.reason).toContain("[redacted]");
    expect(out.reason!.length).toBeLessThanOrEqual(200);
  });

  test("コードは文字列のときだけ、長さを切る", () => {
    expect(describeError({ error: { code: 1 } })).toEqual({});
    expect(describeError({ error: { code: "E".repeat(100) } }).code).toHaveLength(40);
  });
});
