import nodePath from "node:path";
import { MAX_MESSAGE_BYTES, MAX_DIR_NAME_CHARS, MAX_PATH_CHARS } from "../shared/protocol";

// どのディレクトリを一覧・起動の対象にしてよいかの判定。
// 判定は実体のパス（realpath）で行う。シンボリックリンクで許可ルートの外やブロック対象へ抜けるのを防ぐ。
// ファイルシステムの操作は FsOps として差し込めるようにしてある（テストで偽物を使う）。

export type Platform = "darwin" | "linux" | "win32";

export type FsOps = {
  // 実体のパスを返す。存在しなければ throw
  realpath(p: string): string;
  isDirectory(p: string): boolean;
  // ディレクトリ直下の名前と、それがディレクトリ（またはディレクトリかもしれないシンボリックリンク）か
  readdir(p: string): { name: string; dirLike: boolean }[];
};

export type Policy = {
  platform: Platform;
  // realpath 済みの許可ルート（1件以上）
  roots: string[];
  // realpath 済み（存在しなければ解決しただけ）のブロック対象
  blocked: string[];
  // 許可ルートからの相対パスに . で始まる要素を含むものを対象外にする
  hideDotDirs: boolean;
  home: string;
};

export type PathCheck = { ok: true; real: string } | { ok: false; code: "bad_request" | "forbidden" | "not_found"; message: string };

const pathFor = (platform: Platform) => (platform === "win32" ? nodePath.win32 : nodePath.posix);

// Windows と macOS（既定の APFS）は大文字小文字を区別しないので、比較は小文字で行う。
// 区別する側に倒すと、ブロック対象を大文字違いで素通りできてしまう
const fold = (platform: Platform, p: string) => (platform === "linux" ? p : p.toLowerCase());

export function isWithin(platform: Platform, parent: string, child: string): boolean {
  const path = pathFor(platform);
  const rel = path.relative(fold(platform, parent), fold(platform, child));
  // "..x" のような名前の子は内側。外に出るのは ".." そのものか "../" で始まるときだけ
  const outside = rel === ".." || rel.startsWith(`..${path.sep}`) || (platform === "win32" && rel.startsWith("../"));
  return !outside && !path.isAbsolute(rel);
}

function segments(platform: Platform, p: string): string[] {
  return p.split(platform === "win32" ? /[\\/]+/ : /\/+/).filter(Boolean);
}

// 入力の形だけを見る（ファイルシステムには触れない）
export function validateShape(platform: Platform, input: string): string | null {
  if (input.length === 0 || input.length > MAX_PATH_CHARS) return "パスの長さが不正";
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)) return "制御文字や不可視文字を含むパスは使えない";
  if (platform === "win32") {
    // UNC（\\server\share）、デバイスパス（\\?\ や \\.\）、ドライブ相対（C:foo）は扱わない
    if (/^[\\/]{2}/.test(input)) return "UNC パスやデバイスパスは使えない";
    if (!/^[A-Za-z]:[\\/]/.test(input)) return "ドライブ文字から始まる絶対パスを指定する";
    if (/[<>"|?*]/.test(input.slice(2))) return "Windows のパスに使えない文字を含む";
  } else if (!input.startsWith("/")) {
    return "/ から始まる絶対パスを指定する";
  }
  if (segments(platform, input).some((s) => s === ".." || s === ".")) return ". や .. を含むパスは使えない";
  return null;
}

// 実体のパスが許可ルートの内側で、ブロック対象の外か
export function checkReal(policy: Policy, real: string): PathCheck {
  const { platform } = policy;
  const root = policy.roots.find((r) => isWithin(platform, r, real));
  if (!root) return { ok: false, code: "forbidden", message: "許可ルート（ALLOWED_ROOTS）の外にある" };
  if (policy.blocked.some((b) => isWithin(platform, b, real))) {
    return { ok: false, code: "forbidden", message: "ブロック対象（BLOCKED_DIRS）に含まれる" };
  }
  if (policy.hideDotDirs) {
    const rel = pathFor(platform).relative(root, real);
    if (segments(platform, rel).some((s) => s.startsWith("."))) {
      return { ok: false, code: "forbidden", message: ". で始まるディレクトリは対象外（HIDE_DOT_DIRS）" };
    }
  }
  return { ok: true, real };
}

// 入力のパスを検査し、使ってよければ実体のパスを返す
export function resolveDir(policy: Policy, fs: FsOps, input: string): PathCheck {
  const shapeError = validateShape(policy.platform, input);
  if (shapeError) return { ok: false, code: "bad_request", message: shapeError };
  const resolved = pathFor(policy.platform).resolve(input);
  let real: string;
  try {
    real = fs.realpath(resolved);
  } catch {
    return { ok: false, code: "not_found", message: "ディレクトリが見つからない" };
  }
  const checked = checkReal(policy, real);
  if (!checked.ok) return checked;
  let dir = false;
  try {
    dir = fs.isDirectory(real);
  } catch {
    dir = false;
  }
  if (!dir) return { ok: false, code: "not_found", message: "ディレクトリではない" };
  return checked;
}

export const MAX_ENTRIES = 500;

// 応答1通（MAX_MESSAGE_BYTES）のうち、一覧の entries に使ってよいバイト数。
// 残りは外側（id、一覧したディレクトリの path、truncated など）の分。path は最大1024文字で、
// JSON にすると1文字が最大6バイト（\uXXXX）になるので 8KB 残す
export const MAX_LIST_BYTES = MAX_MESSAGE_BYTES - 8 * 1024;

export type DirEntry = { name: string; path: string };

// 名前を MAX_DIR_NAME_CHARS に収める（サロゲートペアの途中では切らない）
export function fitName(name: string): string {
  if (name.length <= MAX_DIR_NAME_CHARS) return name;
  let end = MAX_DIR_NAME_CHARS - 1;
  const code = name.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${name.slice(0, end)}…`;
}

// 件数（MAX_ENTRIES）とバイト数（MAX_LIST_BYTES）の両方の上限まで entries を溜める。
// 上限に達したら add は false を返す（呼び出し側はそこで打ち切り、truncated にする）
function entryCollector() {
  const encoder = new TextEncoder();
  const entries: DirEntry[] = [];
  // 配列の [ と ] の分
  let bytes = 2;
  return {
    entries,
    add(entry: DirEntry): boolean {
      // 区切りの , の分を1バイト足す
      const size = encoder.encode(JSON.stringify(entry)).length + 1;
      if (entries.length >= MAX_ENTRIES || bytes + size > MAX_LIST_BYTES) return false;
      entries.push(entry);
      bytes += size;
      return true;
    },
  };
}

// 許可ルートの一覧（list_dirs で path を省いたとき）。名前はルートのパスそのもので、長すぎるときは末尾の要素にする。
// path が MAX_PATH_CHARS を超えるルートは、応答の形に合わないので出さない
export function listRoots(policy: Policy): { entries: DirEntry[]; truncated: boolean } {
  const path = pathFor(policy.platform);
  const out = entryCollector();
  for (const root of policy.roots) {
    if (root.length > MAX_PATH_CHARS) continue;
    const name = root.length <= MAX_DIR_NAME_CHARS ? root : fitName(path.basename(root) || root);
    if (!out.add({ name, path: root })) return { entries: out.entries, truncated: true };
  }
  return { entries: out.entries, truncated: false };
}

// 直下のサブディレクトリのうち、方針を満たすものだけを名前順で返す。
// path が MAX_PATH_CHARS を超えるものは、応答の形に合わない（辿れもしない）ので出さない
export function listSubdirs(policy: Policy, fs: FsOps, dir: string): { entries: DirEntry[]; truncated: boolean } {
  const path = pathFor(policy.platform);
  const names = fs
    .readdir(dir)
    .filter((e) => e.dirLike)
    .map((e) => e.name)
    .filter((n) => !(policy.hideDotDirs && n.startsWith(".")))
    .filter((n) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(n))
    .sort((a, b) => a.localeCompare(b));
  const out = entryCollector();
  for (const name of names) {
    const full = path.join(dir, name);
    if (full.length > MAX_PATH_CHARS) continue;
    let real: string;
    try {
      real = fs.realpath(full);
      if (!fs.isDirectory(real)) continue;
    } catch {
      continue;
    }
    if (!checkReal(policy, real).ok) continue;
    if (!out.add({ name: fitName(name), path: full })) return { entries: out.entries, truncated: true };
  }
  return { entries: out.entries, truncated: false };
}

// ホームディレクトリ自体では rc を起動できない（trust が保存されず、非対話では必ず失敗する）
export function isHome(policy: Policy, real: string): boolean {
  return fold(policy.platform, pathFor(policy.platform).resolve(real)) === fold(policy.platform, pathFor(policy.platform).resolve(policy.home));
}

// 資格情報の置き場など、設定に関係なく常にブロックするホーム直下のディレクトリ
export const ALWAYS_BLOCKED = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".claude",
  ".config/gcloud",
  ".config/gh",
  // macOS のキーチェーンと、Windows のアプリのデータ（ブラウザのプロファイルなど）
  "Library/Keychains",
  "AppData",
];
