import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { DEVICE_NAME_RE } from "../shared/protocol";

// 端末トークンの発行と、Worker に入れる DEVICE_KEYS（端末名 → トークンの SHA-256）の管理。
// トークンは発行した PC の client/.env にだけ書き、画面にも出さない。外に出すのはハッシュだけ。
//
//   bun run device init <端末名> [--force] … この PC の client/.env にトークンを書き、ハッシュを表示する（各 PC で実行）
//                                       すでにトークンがあれば上書きせず断る。作り直すなら --force（古いトークンは使えなくなる）
//   bun run device add <端末名> <ハッシュ> … devices.local.json に登録する（デプロイする PC で実行）
//   bun run device remove <端末名>      … devices.local.json から外す（失効）
//   bun run device show                 … devices.local.json の中身を表示する
// add / remove のあとで `bunx wrangler secret put DEVICE_KEYS < devices.local.json` を実行する。

export class DeviceError extends Error {}

function fail(message: string): never {
  throw new DeviceError(message);
}

function checkName(name: string | undefined): string {
  if (!name || !DEVICE_NAME_RE.test(name)) fail("端末名は英小文字・数字・ハイフンの1〜32文字（例: mac-mini）");
  return name;
}

// KEY=... の行を置き換える（なければ末尾に足す）
export function setEnvLine(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(text)) return text.replace(re, () => line);
  return `${text.replace(/\n?$/, "\n")}${line}\n`;
}

// KEY=... の行の値（なければ空）
export function getEnvLine(text: string, key: string): string {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(text);
  return (m?.[1] ?? "").trim().replace(/\r$/, "");
}

function readText(file: string, label: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    return fail(`${label} を読めない: ${(e as Error).message}`);
  }
}

function readKeys(keysFile: string): Record<string, string> {
  if (!fs.existsSync(keysFile)) return {};
  const text = readText(keysFile, "devices.local.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("devices.local.json が JSON として読めない。直すか、消して `device add` からやり直す");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("devices.local.json は { \"端末名\": \"ハッシュ\" } の形でなければならない");
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== "string") fail(`devices.local.json の ${k} の値が文字列ではない`);
  }
  return parsed as Record<string, string>;
}

function writeKeys(keysFile: string, keys: Record<string, string>): void {
  const sorted = Object.fromEntries(Object.entries(keys).sort(([a], [b]) => a.localeCompare(b)));
  try {
    fs.writeFileSync(keysFile, `${JSON.stringify(sorted)}\n`, { mode: 0o600 });
  } catch (e) {
    fail(`devices.local.json を書けない: ${(e as Error).message}`);
  }
}

export type Io = { log: (s: string) => void };

// 成功なら何もせず返り、失敗なら DeviceError を投げる。root はリポジトリの場所（テストで差し替える）
export function run(argv: string[], root: string, io: Io): void {
  const [cmd, ...rest] = argv;
  const force = rest.includes("--force");
  const args = rest.filter((a) => a !== "--force");
  const clientEnv = nodePath.join(root, "client", ".env");
  const clientEnvExample = nodePath.join(root, "client", ".env.example");
  const keysFile = nodePath.join(root, "devices.local.json");
  if (force && cmd !== "init") fail("--force は init だけで使える");
  switch (cmd) {
    case "init": {
      if (args.length > 1) fail("使い方: bun run device init <端末名> [--force]");
      const name = checkName(args[0]);
      const existing = fs.existsSync(clientEnv);
      const source = existing ? clientEnv : fs.existsSync(clientEnvExample) ? clientEnvExample : null;
      let text = source ? readText(source, source === clientEnv ? "client/.env" : "client/.env.example") : "";
      // 同じ端末のトークンを作り直すと古いトークンは使えなくなる。使っている端末を壊さないよう、既定では断る
      const oldToken = existing ? getEnvLine(text, "DEVICE_TOKEN") : "";
      const oldName = getEnvLine(text, "DEVICE_NAME") || "（名前なし）";
      if (oldToken && !force) {
        fail(
          `client/.env にはすでに端末 ${oldName} のトークンがある。上書きしない。\n` +
            `作り直すなら --force を付ける（${oldName} は ${name} に置き換わり、古いトークンは使えなくなる。` +
            `登録し直すまでこの PC はつながらない）:\n  bun run device init ${name} --force`,
        );
      }
      const token = randomBytes(32).toString("base64url");
      const hash = createHash("sha256").update(token).digest("hex");
      text = setEnvLine(text, "DEVICE_NAME", name);
      text = setEnvLine(text, "DEVICE_TOKEN", token);
      try {
        fs.mkdirSync(nodePath.dirname(clientEnv), { recursive: true });
        fs.writeFileSync(clientEnv, text, { mode: 0o600 });
        fs.chmodSync(clientEnv, 0o600);
      } catch (e) {
        fail(`client/.env を書けない: ${(e as Error).message}`);
      }
      if (oldToken) io.log(`--force: 端末 ${oldName} のトークンを ${name} 用に作り直した（古いトークンは無効）。`);
      io.log(`client/.env に DEVICE_NAME と DEVICE_TOKEN を書いた（トークンは表示しない）。`);
      io.log(`デプロイする PC で次を実行して登録する（ハッシュは秘密ではない）:`);
      io.log(`  bun run device add ${name} ${hash}`);
      break;
    }
    case "add": {
      if (args.length > 2) fail("使い方: bun run device add <端末名> <ハッシュ>");
      const name = checkName(args[0]);
      const hash = (args[1] ?? "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash)) fail("ハッシュは64桁の16進（device init が表示した値）");
      const keys = readKeys(keysFile);
      const replaced = name in keys && keys[name] !== hash;
      keys[name] = hash;
      writeKeys(keysFile, keys);
      if (replaced) io.log(`${name} は登録済みだったので、ハッシュを入れ替えた（古いトークンは無効になる）。`);
      io.log(`${name} を登録した（${Object.keys(keys).length}台）。反映: bunx wrangler secret put DEVICE_KEYS < devices.local.json`);
      break;
    }
    case "remove": {
      if (args.length > 1) fail("使い方: bun run device remove <端末名>");
      const name = checkName(args[0]);
      const keys = readKeys(keysFile);
      if (!(name in keys)) fail(`${name} は登録されていない`);
      delete keys[name];
      writeKeys(keysFile, keys);
      io.log(`${name} を外した。反映: bunx wrangler secret put DEVICE_KEYS < devices.local.json`);
      break;
    }
    case "show":
      io.log(JSON.stringify(readKeys(keysFile), null, 2));
      break;
    default:
      fail("使い方: bun run device init|add|remove|show ...（scripts/device.ts の先頭を参照）");
  }
}

if (import.meta.main) {
  try {
    run(process.argv.slice(2), nodePath.resolve(import.meta.dir, ".."), { log: (s) => console.log(s) });
  } catch (e) {
    if (e instanceof DeviceError) {
      console.error(e.message);
      process.exit(1);
    }
    console.error(`予期しないエラー: ${(e as Error).message}`);
    process.exit(1);
  }
}
