import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { DeviceError, getEnvLine, run, setEnvLine } from "../scripts/device";

let root: string;
let out: string[];
const io = { log: (s: string) => void out.push(s) };
const env = () => nodePath.join(root, "client", ".env");
const keys = () => nodePath.join(root, "devices.local.json");
const HASH = "a".repeat(64);

beforeEach(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "device-"));
  fs.mkdirSync(nodePath.join(root, "client"));
  out = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const fails = (argv: string[], re: RegExp) => {
  try {
    run(argv, root, io);
  } catch (e) {
    expect(e).toBeInstanceOf(DeviceError);
    expect((e as Error).message).toMatch(re);
    return;
  }
  throw new Error("failed to fail");
};

describe("env line helpers", () => {
  test("set and get", () => {
    expect(setEnvLine("A=1\n", "B", "2")).toBe("A=1\nB=2\n");
    expect(setEnvLine("A=1\nB=x\n", "B", "$&")).toBe("A=1\nB=$&\n");
    expect(getEnvLine("A=1\nB=\n", "B")).toBe("");
    expect(getEnvLine("A=1\nB=2\r\n", "B")).toBe("2");
  });
});

describe("device init", () => {
  test("writes the token without printing it", () => {
    run(["init", "mac-mini"], root, io);
    const token = getEnvLine(fs.readFileSync(env(), "utf8"), "DEVICE_TOKEN");
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(out.join("\n")).not.toContain(token);
    expect(out.join("\n")).toMatch(/device add mac-mini [0-9a-f]{64}/);
  });

  test("refuses to overwrite an existing token, and leaves the file alone", () => {
    run(["init", "mac-mini"], root, io);
    const before = fs.readFileSync(env(), "utf8");
    fails(["init", "other"], /上書きしない[\s\S]*--force/);
    expect(fs.readFileSync(env(), "utf8")).toBe(before);
  });

  test("--force replaces it", () => {
    run(["init", "mac-mini"], root, io);
    const before = getEnvLine(fs.readFileSync(env(), "utf8"), "DEVICE_TOKEN");
    run(["init", "mac-mini", "--force"], root, io);
    const after = fs.readFileSync(env(), "utf8");
    expect(getEnvLine(after, "DEVICE_TOKEN")).not.toBe(before);
  });

  test("an empty DEVICE_TOKEN (from .env.example) is not an overwrite", () => {
    fs.writeFileSync(env(), "DEVICE_NAME=\nDEVICE_TOKEN=\nALLOWED_ROOTS=/x\n");
    run(["init", "pc"], root, io);
    expect(fs.readFileSync(env(), "utf8")).toContain("ALLOWED_ROOTS=/x");
  });

  test.each([[[]], [["BAD NAME"]], [["a", "b"]]])("bad args %p", (args) => {
    fails(["init", ...args], /端末名|使い方/);
  });
});

describe("device add / remove / show", () => {
  test("round trip", () => {
    run(["add", "pc", HASH], root, io);
    expect(JSON.parse(fs.readFileSync(keys(), "utf8"))).toEqual({ pc: HASH });
    run(["remove", "pc"], root, io);
    expect(JSON.parse(fs.readFileSync(keys(), "utf8"))).toEqual({});
  });

  test("replacing a different hash says so", () => {
    run(["add", "pc", HASH], root, io);
    out = [];
    run(["add", "pc", "b".repeat(64)], root, io);
    expect(out[0]).toContain("入れ替えた");
  });

  test("bad hash, unknown device, unknown command", () => {
    fails(["add", "pc", "zz"], /64桁/);
    fails(["remove", "pc"], /登録されていない/);
    fails(["nope"], /使い方/);
    fails(["show", "--force"], /--force/);
  });

  test.each(["{broken", "[]", "null", '{"pc":1}'])("malformed devices.local.json %p gives a clear error", (text) => {
    fs.writeFileSync(keys(), text);
    fails(["show"], /devices\.local\.json/);
    fails(["add", "pc", HASH], /devices\.local\.json/);
    expect(fs.readFileSync(keys(), "utf8")).toBe(text);
  });

  test("unreadable devices.local.json (a directory) is a clear error", () => {
    fs.mkdirSync(keys());
    fails(["show"], /読めない/);
  });
});
