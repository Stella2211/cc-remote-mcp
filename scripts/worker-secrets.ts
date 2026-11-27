import { parseDeviceKeys } from "../src/device-auth";
import { readWorkerName } from "./deploy";

// GitHub Actions の secrets から、Worker のシークレット（ALLOWED_EMAIL / DEVICE_KEYS / DISCORD_WEBHOOK_URL）を wrangler で書く。
// .github/workflows/worker-secrets.yml から動かす（手動実行だけ）。手元の `wrangler secret put` もそのまま使える（docs/setup.md）。
//
// - 空の secret は書かない（消さない）。Worker に入っている値はそのまま残る
// - 値は stdin で wrangler に渡す。画面にも引数にも出さない

// 環境変数 → Worker のシークレット名
export const WORKER_SECRETS = {
  CC_REMOTE_MCP_ALLOWED_EMAIL: "ALLOWED_EMAIL",
  CC_REMOTE_MCP_DEVICE_KEYS: "DEVICE_KEYS",
  CC_REMOTE_MCP_DISCORD_WEBHOOK_URL: "DISCORD_WEBHOOK_URL",
} as const;

export type SecretToWrite = { name: string; value: string };

// 空（空白だけも含む）でないものだけを、書く順（上の定義順）で返す。DEVICE_KEYS は JSON のオブジェクトでなければ止める（値は出さない）
export function planSecrets(env: Record<string, string | undefined>): SecretToWrite[] {
  const plan: SecretToWrite[] = [];
  for (const [from, name] of Object.entries(WORKER_SECRETS)) {
    const value = env[from]?.trim();
    if (!value) continue;
    if (name === "DEVICE_KEYS") checkDeviceKeys(from, value);
    plan.push({ name, value });
  }
  return plan;
}

// Worker の parseDeviceKeys と同じ規則で検査する。1件でも不正、または有効な端末が0件なら書かない
// （書くと Worker が一部または全部の端末を黙って受け付けなくなる）。値は表示しない
function checkDeviceKeys(from: string, value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${from} が JSON ではない（値は表示しない）`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${from} が JSON のオブジェクトではない（値は表示しない）`);
  const total = Object.keys(parsed).length;
  const valid = parseDeviceKeys(value).size;
  if (valid === 0) throw new Error(`${from} に有効な端末が1つも無い（書くと全端末が使えなくなる。値は表示しない）`);
  if (valid !== total) throw new Error(`${from} に不正な端末名かハッシュがある（${total - valid} 件。値は表示しない）`);
}

if (import.meta.main) {
  const env = process.env;
  let plan: SecretToWrite[];
  let workerName: string | undefined;
  try {
    plan = planSecrets(env);
    workerName = readWorkerName(env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  if (!plan.length) {
    console.log(`書くシークレットが無い（${Object.keys(WORKER_SECRETS).join(" / ")} が全部空）。何も変えない。`);
    process.exit(0);
  }
  if (!env.CLOUDFLARE_API_TOKEN?.trim() || !env.CLOUDFLARE_ACCOUNT_ID?.trim()) {
    console.log("CLOUDFLARE_API_TOKEN か CLOUDFLARE_ACCOUNT_ID が空。何も書かずに終わる（docs/setup.md）。");
    process.exit(0);
  }
  const nameArgs = workerName ? ["--name", workerName] : [];
  console.log(`書き込み先の Worker: ${workerName ?? "wrangler.jsonc の name"}`);
  let failed = false;
  for (const { name, value } of plan) {
    const proc = Bun.spawnSync([process.execPath, "x", "wrangler", "secret", "put", name, ...nameArgs], {
      stdin: new TextEncoder().encode(value),
      stdout: "ignore",
      stderr: "inherit",
    });
    if (proc.exitCode === 0) console.log(`${name}: 書いた`);
    else {
      console.error(`${name}: 書けなかった（終了コード ${proc.exitCode}）`);
      failed = true;
    }
  }
  console.log(`書かなかった（空）: ${Object.values(WORKER_SECRETS).filter((n) => !plan.some((p) => p.name === n)).join(", ") || "なし"}`);
  process.exitCode = failed ? 1 : 0;
}
