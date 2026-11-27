import fs from "node:fs";
import nodePath from "node:path";

// 本番の値を差し込んでデプロイする。wrangler.jsonc のホスト名と Access の値は例なので、
// 環境変数の値で routes と vars を置き換えた設定を一時ファイルに書き、それで wrangler deploy を動かす。
// 値は GitHub Actions では repository variables から、手元では .env.local（Bun が自動で読む。コミットしない）から来る。
//
//   bun run deploy              … デプロイする
//   bun run deploy --dry-run    … 引数はそのまま wrangler deploy に渡る

export const DEPLOY_VARS = {
  CC_REMOTE_MCP_MCP_HOST: "MCP_HOST",
  CC_REMOTE_MCP_LINK_HOST: "LINK_HOST",
  CC_REMOTE_MCP_ACCESS_TEAM_DOMAIN: "ACCESS_TEAM_DOMAIN",
  CC_REMOTE_MCP_ACCESS_AUD: "ACCESS_AUD",
} as const;

type DeployValues = Record<(typeof DEPLOY_VARS)[keyof typeof DEPLOY_VARS], string>;

// 任意：Worker の名前。空なら wrangler.jsonc の name のまま。デプロイ済みの Worker の名前を変えると
// 別の Worker ができ（シークレットも Durable Object の中身も引き継がない）、ルートがぶつかるので、旧名で動かしている人はここで旧名を入れる
export const WORKER_NAME_VAR = "CC_REMOTE_MCP_WORKER_NAME";
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function readWorkerName(env: Record<string, string | undefined>): string | undefined {
  const name = env[WORKER_NAME_VAR]?.trim();
  if (!name) return undefined;
  if (!WORKER_NAME.test(name)) throw new Error(`${WORKER_NAME_VAR} が Worker の名前として使えない（英小文字・数字・ハイフン、63文字まで）`);
  return name;
}

// 1つでも空なら例の値のままデプロイしないよう、足りない名前を挙げて止める
export function readDeployValues(env: Record<string, string | undefined>): DeployValues {
  const missing = Object.keys(DEPLOY_VARS).filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`環境変数が空: ${missing.join(", ")}`);
  return Object.fromEntries(Object.entries(DEPLOY_VARS).map(([from, to]) => [to, env[from]!.trim()])) as DeployValues;
}

// routes は2つのカスタムドメインに置き換え、vars は同名を上書きする。name は workerName があればそれにする。ほかの設定はそのまま
export function buildDeployConfig(base: Record<string, unknown>, values: DeployValues, workerName?: string): Record<string, unknown> {
  return {
    ...base,
    ...(workerName ? { name: workerName } : {}),
    routes: [
      { pattern: values.MCP_HOST, custom_domain: true },
      { pattern: values.LINK_HOST, custom_domain: true },
    ],
    vars: { ...(base.vars as Record<string, unknown> | undefined), ...values },
  };
}

if (import.meta.main) {
  const root = nodePath.resolve(import.meta.dir, "..");
  let values: DeployValues;
  let workerName: string | undefined;
  try {
    values = readDeployValues(process.env);
    workerName = readWorkerName(process.env);
  } catch (err) {
    console.error(`${(err as Error).message}\nGitHub の repository variables か .env.local に入れる（docs/setup.md）。`);
    process.exit(1);
  }
  const base = Bun.JSONC.parse(fs.readFileSync(nodePath.join(root, "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
  // main などの相対パスが同じ意味になるよう、wrangler.jsonc と同じ場所に書く（.gitignore 済み。終わったら消す）
  const generated = nodePath.join(root, "wrangler.deploy.json");
  const config = buildDeployConfig(base, values, workerName);
  console.log(`デプロイ先の Worker: ${String(config.name)}`);
  fs.writeFileSync(generated, `${JSON.stringify(config, null, 2)}\n`);
  try {
    const proc = Bun.spawnSync([process.execPath, "x", "wrangler", "deploy", "--config", generated, ...process.argv.slice(2)], {
      cwd: root,
      stdio: ["inherit", "inherit", "inherit"],
    });
    process.exitCode = proc.exitCode ?? 1;
  } finally {
    fs.rmSync(generated, { force: true });
  }
}
