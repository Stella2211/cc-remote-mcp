import { describe, expect, test } from "bun:test";
import { MAX_LIST_BYTES, type Policy, fitName, isHome, isWithin, listRoots, listSubdirs, resolveDir, validateShape } from "../client/paths";
import { MAX_MESSAGE_BYTES, MAX_DIR_NAME_CHARS, MAX_PATH_CHARS, actionResults } from "../shared/protocol";
import { fakeFs } from "./support";

const posix: Policy = {
  platform: "linux",
  roots: ["/home/me/dev"],
  blocked: ["/home/me/dev/secret", "/home/me/.ssh"],
  hideDotDirs: true,
  home: "/home/me",
};

const fs = fakeFs({
  dirs: [
    "/home/me",
    "/home/me/dev",
    "/home/me/dev/app",
    "/home/me/dev/app/src",
    "/home/me/dev/secret",
    "/home/me/dev/secret/inner",
    "/home/me/dev/.hidden",
    "/home/me/.ssh",
    "/etc",
    "/home/me/dev-other",
  ],
  links: {
    "/home/me/dev/escape": "/etc",
    "/home/me/dev/sneaky": "/home/me/dev/secret",
    "/home/me/dev/alias": "/home/me/dev/app",
  },
  files: ["/home/me/dev/readme.md"],
});

describe("validateShape", () => {
  test.each([
    ["relative", "dev/app"],
    ["dot-dot", "/home/me/dev/../.."],
    ["dot-dot at end", "/home/me/dev/app/.."],
    ["single dot", "/home/me/./dev"],
    ["NUL", "/home/me/dev\u0000/x"],
    ["newline", "/home/me/dev\n/x"],
    ["bidi override", "/home/me/dev/\u202eppa"],
    ["empty", ""],
  ])("posix rejects %s", (_, input) => {
    expect(validateShape("linux", input)).not.toBeNull();
  });

  test.each([
    ["UNC", "\\\\server\\share\\x"],
    ["device path", "\\\\?\\C:\\x"],
    ["forward-slash UNC", "//server/share"],
    ["drive-relative", "C:foo"],
    ["rooted without drive", "\\Users\\me"],
    ["dot-dot", "C:\\Users\\me\\..\\x"],
    ["dot-dot with slash", "C:/Users/me/../x"],
    ["wildcard", "C:\\Users\\*"],
  ])("win32 rejects %s", (_, input) => {
    expect(validateShape("win32", input)).not.toBeNull();
  });

  test("accepts plain absolute paths", () => {
    expect(validateShape("linux", "/home/me/dev/app")).toBeNull();
    expect(validateShape("win32", "C:\\Users\\me\\dev")).toBeNull();
    expect(validateShape("win32", "D:/work/app")).toBeNull();
  });
});

describe("isWithin", () => {
  test("prefix that is not a parent is outside", () => {
    expect(isWithin("linux", "/home/me/dev", "/home/me/dev-other")).toBe(false);
    expect(isWithin("linux", "/home/me/dev", "/home/me/dev/app")).toBe(true);
    expect(isWithin("linux", "/home/me/dev", "/home/me/dev")).toBe(true);
  });

  test("linux is case-sensitive, darwin and win32 are not", () => {
    expect(isWithin("linux", "/home/me/Dev", "/home/me/dev/app")).toBe(false);
    expect(isWithin("darwin", "/Users/me/Dev", "/users/me/dev/app")).toBe(true);
    expect(isWithin("win32", "C:\\Users\\Me", "c:\\users\\me\\x")).toBe(true);
    expect(isWithin("win32", "C:\\Users\\Me", "D:\\Users\\Me")).toBe(false);
  });
});

describe("resolveDir", () => {
  test("a directory inside the root is allowed", () => {
    expect(resolveDir(posix, fs, "/home/me/dev/app")).toEqual({ ok: true, real: "/home/me/dev/app" });
  });

  test("trailing slashes are fine", () => {
    expect(resolveDir(posix, fs, "/home/me/dev/app/")).toEqual({ ok: true, real: "/home/me/dev/app" });
  });

  test("outside the roots is forbidden", () => {
    expect(resolveDir(posix, fs, "/etc")).toMatchObject({ ok: false, code: "forbidden" });
    expect(resolveDir(posix, fs, "/home/me")).toMatchObject({ ok: false, code: "forbidden" });
    expect(resolveDir(posix, fs, "/home/me/dev-other")).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("a symlink that escapes the root is forbidden", () => {
    expect(resolveDir(posix, fs, "/home/me/dev/escape")).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("a symlink into a blocked directory is forbidden", () => {
    expect(resolveDir(posix, fs, "/home/me/dev/sneaky")).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("a symlink to an allowed directory resolves to its real path", () => {
    expect(resolveDir(posix, fs, "/home/me/dev/alias")).toEqual({ ok: true, real: "/home/me/dev/app" });
  });

  test("blocked directories and everything below them are forbidden", () => {
    expect(resolveDir(posix, fs, "/home/me/dev/secret")).toMatchObject({ ok: false, code: "forbidden" });
    expect(resolveDir(posix, fs, "/home/me/dev/secret/inner")).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("dot directories are hidden unless allowed", () => {
    expect(resolveDir(posix, fs, "/home/me/dev/.hidden")).toMatchObject({ ok: false, code: "forbidden" });
    expect(resolveDir({ ...posix, hideDotDirs: false }, fs, "/home/me/dev/.hidden")).toMatchObject({ ok: true });
  });

  test("traversal is rejected before touching the filesystem", () => {
    const local = fakeFs({ dirs: ["/home/me/dev"] });
    expect(resolveDir(posix, local, "/home/me/dev/../../etc")).toMatchObject({ ok: false, code: "bad_request" });
    expect(local.calls).toEqual([]);
  });

  test("missing paths and files are not_found", () => {
    expect(resolveDir(posix, fs, "/home/me/dev/nope")).toMatchObject({ ok: false, code: "not_found" });
    expect(resolveDir(posix, fs, "/home/me/dev/readme.md")).toMatchObject({ ok: false, code: "not_found" });
  });

  test("darwin compares blocked directories case-insensitively", () => {
    const mac: Policy = { platform: "darwin", roots: ["/Users/me/dev"], blocked: ["/Users/me/dev/Secret"], hideDotDirs: true, home: "/Users/me" };
    const macFs = fakeFs({ dirs: ["/Users/me/dev", "/Users/me/dev/SECRET"] });
    expect(resolveDir(mac, macFs, "/Users/me/dev/SECRET")).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("win32 paths", () => {
    const win: Policy = { platform: "win32", roots: ["C:\\Users\\me\\dev"], blocked: ["C:\\Users\\me\\dev\\secret"], hideDotDirs: true, home: "C:\\Users\\me" };
    const winFs = fakeFs({ dirs: ["C:\\Users\\me\\dev", "C:\\Users\\me\\dev\\app", "C:\\Users\\me\\dev\\Secret"], sep: "\\" });
    expect(resolveDir(win, winFs, "C:\\Users\\me\\dev\\app")).toEqual({ ok: true, real: "C:\\Users\\me\\dev\\app" });
    expect(resolveDir(win, winFs, "c:\\users\\me\\dev\\Secret")).toMatchObject({ ok: false });
    expect(resolveDir(win, winFs, "\\\\host\\c$\\Users\\me\\dev")).toMatchObject({ ok: false, code: "bad_request" });
  });
});

describe("listSubdirs", () => {
  test("lists only allowed directories, sorted, without files, dot dirs, blocked or escaping links", () => {
    const { entries, truncated } = listSubdirs(posix, fs, "/home/me/dev");
    expect(entries.map((e) => e.name)).toEqual(["alias", "app"]);
    expect(entries[0]).toEqual({ name: "alias", path: "/home/me/dev/alias" });
    expect(truncated).toBe(false);
  });

  test("caps the number of entries", () => {
    const many = Array.from({ length: 510 }, (_, i) => `/r/d${String(i).padStart(3, "0")}`);
    const big = fakeFs({ dirs: ["/r", ...many] });
    const out = listSubdirs({ ...posix, roots: ["/r"], blocked: [] }, big, "/r");
    expect(out.entries).toHaveLength(500);
    expect(out.truncated).toBe(true);
  });

  test("skips entries whose path would exceed the protocol limit", () => {
    const base = `/r/${"p".repeat(MAX_PATH_CHARS - 20)}`;
    const tooLong = `${base}/${"x".repeat(30)}`;
    const fits = `${base}/ok`;
    const local = fakeFs({ dirs: ["/r", base, tooLong, fits] });
    const out = listSubdirs({ ...posix, roots: ["/r"], blocked: [] }, local, base);
    expect(out.entries).toEqual([{ name: "ok", path: fits }]);
    expect(out.truncated).toBe(false);
    expect(local.calls).not.toContain(`realpath ${tooLong}`);
  });

  test("caps the listing by bytes so the reply fits in one message", () => {
    // 1件あたり約700バイトが500件（約360KB）。件数の上限には届かないが、バイト数で打ち切る
    const base = `/r/${"b".repeat(200)}`;
    const many = Array.from({ length: 500 }, (_, i) => `${base}/${String(i).padStart(3, "0")}${"n".repeat(MAX_DIR_NAME_CHARS - 3)}`);
    const big = fakeFs({ dirs: ["/r", base, ...many] });
    const out = listSubdirs({ ...posix, roots: ["/r"], blocked: [] }, big, base);
    expect(out.truncated).toBe(true);
    expect(out.entries.length).toBeGreaterThan(0);
    expect(out.entries.length).toBeLessThan(500);
    expect(new TextEncoder().encode(JSON.stringify(out.entries)).length).toBeLessThanOrEqual(MAX_LIST_BYTES);
    // 応答全体（最長の id と path をつけても）が1通に収まり、Worker のスキーマにも合う
    const result = { path: "/".repeat(MAX_PATH_CHARS), ...out };
    expect(actionResults.list_dirs.safeParse(result).success).toBe(true);
    const reply = JSON.stringify({ type: "response", id: "x".repeat(64), ok: true, result });
    expect(new TextEncoder().encode(reply).length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });
});

describe("listRoots", () => {
  test("uses the root path as the name when it fits", () => {
    expect(listRoots(posix)).toEqual({ entries: [{ name: "/home/me/dev", path: "/home/me/dev" }], truncated: false });
  });

  test("shortens the name of a long root and skips a root whose path is too long", () => {
    const long = `/data/${"d".repeat(300)}/project`;
    const tooLong = `/data/${"e".repeat(MAX_PATH_CHARS)}`;
    const out = listRoots({ ...posix, roots: [long, tooLong] });
    expect(out).toEqual({ entries: [{ name: "project", path: long }], truncated: false });
    expect(actionResults.list_dirs.safeParse({ path: null, ...out }).success).toBe(true);
  });

  test("a root whose last element is itself too long still gets a name that fits", () => {
    const long = `/data/${"f".repeat(400)}`;
    const [entry] = listRoots({ ...posix, roots: [long] }).entries;
    expect(entry?.path).toBe(long);
    expect(entry?.name.length).toBeLessThanOrEqual(MAX_DIR_NAME_CHARS);
  });
});

describe("fitName", () => {
  test("keeps short names and cuts long ones without splitting a surrogate pair", () => {
    expect(fitName("app")).toBe("app");
    const cut = fitName("a".repeat(253) + "😀".repeat(10));
    expect(cut.length).toBeLessThanOrEqual(MAX_DIR_NAME_CHARS);
    expect(cut.endsWith("…")).toBe(true);
    expect(/[\ud800-\udbff]…$/.test(cut)).toBe(false);
  });
});

test("isHome", () => {
  expect(isHome(posix, "/home/me")).toBe(true);
  expect(isHome(posix, "/home/me/dev")).toBe(false);
});

test("a child whose name starts with .. is inside its parent", () => {
  expect(isWithin("linux", "/data", "/data/..x")).toBe(true);
  expect(isWithin("linux", "/data/secret", "/data/secret/..x")).toBe(true);
  expect(isWithin("linux", "/data/secret", "/data/..x")).toBe(false);
  expect(isWithin("win32", "C:\\data\\secret", "C:\\data\\secret\\..x")).toBe(true);
  const policy: Policy = { platform: "linux", roots: ["/data"], blocked: ["/data/secret"], hideDotDirs: false, home: "/home/me" };
  const local = fakeFs({ dirs: ["/data", "/data/secret", "/data/secret/..x", "/data/..proj"] });
  expect(resolveDir(policy, local, "/data/secret/..x")).toMatchObject({ ok: false, code: "forbidden" });
  expect(resolveDir(policy, local, "/data/..proj")).toEqual({ ok: true, real: "/data/..proj" });
});
