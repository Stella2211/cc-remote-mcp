import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { DEVICE_NAME_RE } from "../shared/protocol";

// 端末トークンの発行と、Worker に入れる DEVICE_KEYS（端末名 → トークンの SHA-256）の管理。
// トークンは発行した PC の client/.env にだけ書き、画面にも出さない。外に出すのはハッシュだけ。
//
//   bun run device init <端末名>        … この PC の client/.env にトークンを書き、ハッシュを表示する（各 PC で実行）
//   bun run device add <端末名> <ハッシュ> … devices.local.json に登録する（デプロイする PC で実行）
//   bun run device remove <端末名>      … devices.local.json から外す（失効）
//   bun run device show                 … devices.local.json の中身を表示する
// add / remove のあとで `bunx wrangler secret put DEVICE_KEYS < devices.local.json` を実行する。

const ROOT = nodePath.resolve(import.meta.dir, "..");
const CLIENT_ENV = nodePath.join(ROOT, "client", ".env");
const CLIENT_ENV_EXAMPLE = nodePath.join(ROOT, "client", ".env.example");
const KEYS_FILE = nodePath.join(ROOT, "devices.local.json");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function checkName(name: string | undefined): string {
  if (!name || !DEVICE_NAME_RE.test(name)) fail("端末名は英小文字・数字・ハイフンの1〜32文字（例: mac-mini）");
  return name;
}

// KEY=... の行を置き換える（なければ末尾に足す）
export function setEnvLine(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(text)) return text.replace(re, line);
  return `${text.replace(/\n?$/, "\n")}${line}\n`;
}

function readKeys(): Record<string, string> {
  if (!fs.existsSync(KEYS_FILE)) return {};
  return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")) as Record<string, string>;
}

function writeKeys(keys: Record<string, string>): void {
  const sorted = Object.fromEntries(Object.entries(keys).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(KEYS_FILE, `${JSON.stringify(sorted)}\n`, { mode: 0o600 });
}

const [cmd, ...args] = process.argv.slice(2);

if (import.meta.main) {
  switch (cmd) {
    case "init": {
      const name = checkName(args[0]);
      const token = randomBytes(32).toString("base64url");
      const hash = createHash("sha256").update(token).digest("hex");
      let text = fs.existsSync(CLIENT_ENV)
        ? fs.readFileSync(CLIENT_ENV, "utf8")
        : fs.existsSync(CLIENT_ENV_EXAMPLE)
          ? fs.readFileSync(CLIENT_ENV_EXAMPLE, "utf8")
          : "";
      text = setEnvLine(text, "DEVICE_NAME", name);
      text = setEnvLine(text, "DEVICE_TOKEN", token);
      fs.writeFileSync(CLIENT_ENV, text, { mode: 0o600 });
      fs.chmodSync(CLIENT_ENV, 0o600);
      console.log(`client/.env に DEVICE_NAME と DEVICE_TOKEN を書いた（トークンは表示しない）。`);
      console.log(`デプロイする PC で次を実行して登録する（ハッシュは秘密ではない）:`);
      console.log(`  bun run device add ${name} ${hash}`);
      break;
    }
    case "add": {
      const name = checkName(args[0]);
      const hash = (args[1] ?? "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash)) fail("ハッシュは64桁の16進（device init が表示した値）");
      const keys = readKeys();
      keys[name] = hash;
      writeKeys(keys);
      console.log(`${name} を登録した（${Object.keys(keys).length}台）。反映: bunx wrangler secret put DEVICE_KEYS < devices.local.json`);
      break;
    }
    case "remove": {
      const name = checkName(args[0]);
      const keys = readKeys();
      if (!(name in keys)) fail(`${name} は登録されていない`);
      delete keys[name];
      writeKeys(keys);
      console.log(`${name} を外した。反映: bunx wrangler secret put DEVICE_KEYS < devices.local.json`);
      break;
    }
    case "show":
      console.log(JSON.stringify(readKeys(), null, 2));
      break;
    default:
      fail("使い方: bun run device init|add|remove|show ...（scripts/device.ts の先頭を参照）");
  }
}
