// wrangler.jsonc の vars は `bun run cf-typegen` で生成される Cloudflare.Env に入る。
// シークレットは wrangler.jsonc に現れないので、ここで補う。
declare namespace Cloudflare {
  interface Env {
    ALLOWED_EMAIL: string;
    // 端末名 → 端末トークンの SHA-256（16進）の JSON。scripts/device.ts が作る
    DEVICE_KEYS: string;
    DEV_BYPASS_ACCESS?: string;
    // 未設定なら通知しない
    DISCORD_WEBHOOK_URL?: string;
  }
}

// wrangler types は global の Env に Cloudflare.Env を継承させないので、ここで結ぶ
interface Env extends Cloudflare.Env {}
