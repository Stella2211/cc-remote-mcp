import * as z from "zod";

// Worker（Durable Object）と各PCのクライアントのあいだで WebSocket に流す JSON の取り決め。
// どちらの側もこのスキーマで受信内容を検証してから使う。Workers と Bun の両方で動くよう、zod 以外に依存しない。

export const PROTOCOL_VERSION = 1;

// 端末名。DEVICE_KEYS のキー、WebSocket のタグ、ツールの device 引数に使う
export const DEVICE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const deviceNameSchema = z.string().regex(DEVICE_NAME_RE, "端末名は英小文字・数字・ハイフンの1〜32文字");

const NO_CONTROL = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u;

export const MAX_PATH_CHARS = 1024;
// セッション名、画面・出力から拾う URL、末尾に付ける行の長さ（文字数）と行数の上限
export const MAX_SESSION_NAME_CHARS = 64;
export const MAX_URL_CHARS = 300;
export const MAX_LINE_CHARS = 300;
export const MAX_OUTPUT_LINES = 20;

// 端末トークン（32バイトの乱数の base64url は43文字）。クライアントの設定読み込みと Worker の認証で同じ形を使う
export const DEVICE_TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/;

export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

export const pathSchema = z.string().min(1).max(MAX_PATH_CHARS).regex(NO_CONTROL, "制御文字は使えない");

// クライアントが起動した rc プロセスに振る ID（クライアントが生成する）
export const sessionIdSchema = z.string().regex(/^rc_[A-Za-z0-9_-]{8,32}$/, "rc_ で始まる ID");

// claude remote-control --name に渡す名前。引数配列で渡すのでシェル解釈はないが、- で始まるとフラグと誤読されうるので弾く
export const sessionNameSchema = z
  .string()
  .min(1)
  .max(MAX_SESSION_NAME_CHARS)
  .regex(NO_CONTROL, "制御文字は使えない")
  .refine((s) => !s.startsWith("-"), "- で始まる名前は使えない");

// bypassPermissions と dontAsk は遠隔からは選ばせない
export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto"] as const;
export const SPAWN_MODES = ["same-dir", "worktree"] as const;

// ---- 対話セッション（macOS / Linux は tmux、Windows は Bun の疑似端末の中で動かす `claude --remote-control`） ----

// クライアントが起動した対話セッションの ID。そのまま tmux のセッション名にも使う（Windows では疑似端末の管理に使う）
export const INTERACTIVE_ID_RE = /^cc_[A-Za-z0-9_-]{8,32}$/;
export const interactiveIdSchema = z.string().regex(INTERACTIVE_ID_RE, "cc_ で始まる ID");

// tmux は「; で終わる引数」をコマンドの区切りとして読むので、名前の末尾の ; は弾く
export const interactiveNameSchema = sessionNameSchema.refine((s) => !s.endsWith(";"), "; で終わる名前は使えない");

// 改行とタブ以外の制御文字（ESC など）は通さない。端末に生のエスケープ列を流し込ませないため
const TEXT_NO_CONTROL = (s: string) => !/\p{Cc}/u.test(s.replace(/[\n\t]/g, ""));

// 初回プロンプトは claude の引数として渡す。tmux の1コマンドは約16KBまでなので、余裕を見て UTF-8 で 12000 バイトまで
export const MAX_PROMPT_BYTES = 12_000;
export const promptSchema = z
  .string()
  .min(1)
  .max(MAX_PROMPT_BYTES)
  .refine((s) => s.trim().length > 0, "空のプロンプト")
  .refine(TEXT_NO_CONTROL, "改行とタブ以外の制御文字は使えない")
  .refine((s) => utf8Bytes(s) <= MAX_PROMPT_BYTES, `プロンプトは UTF-8 で ${MAX_PROMPT_BYTES} バイトまで（長い指示は send_input で続ける）`);

// 送る入力は tmux では貼り付けバッファ経由（標準入力で渡す）、Windows では疑似端末への書き込みなので、プロンプトより長くてよい
export const MAX_INPUT_CHARS = 20_000;
export const inputTextSchema = z
  .string()
  .min(1)
  .max(MAX_INPUT_CHARS)
  .refine(TEXT_NO_CONTROL, "改行とタブ以外の制御文字は使えない");

// 文字の代わりに送れるキー。Esc は実行中の応答を止める、上下は選択肢の移動。モード切り替え（Shift+Tab）や Ctrl+C は送らせない
export const INPUT_KEYS = ["Enter", "Escape", "Up", "Down"] as const;

// ---- 操作（ホワイトリスト。これ以外の action はクライアントが拒否する） ----

export const actionParams = {
  list_sessions: z.object({}).strict(),
  stop_session: z.object({ id: sessionIdSchema }).strict(),
  list_dirs: z.object({ path: pathSchema.optional() }).strict(),
  start_session: z
    .object({
      path: pathSchema,
      name: sessionNameSchema.optional(),
      spawn: z.enum(SPAWN_MODES).optional(),
      permissionMode: z.enum(PERMISSION_MODES).optional(),
    })
    .strict(),
  start_interactive: z
    .object({
      path: pathSchema,
      prompt: promptSchema,
      name: interactiveNameSchema.optional(),
      permissionMode: z.enum(PERMISSION_MODES).optional(),
      worktree: z.boolean().optional(),
    })
    .strict(),
  send_input: z
    .object({
      id: interactiveIdSchema,
      text: inputTextSchema.optional(),
      key: z.enum(INPUT_KEYS).optional(),
      // text のあとに Enter を送って確定するか（既定 true）
      submit: z.boolean().optional(),
    })
    .strict()
    .refine((p) => (p.text === undefined) !== (p.key === undefined), "text と key のどちらか一方だけを指定する"),
  stop_interactive: z.object({ id: interactiveIdSchema }).strict(),
} as const;

export type ActionName = keyof typeof actionParams;
export type ActionParams<A extends ActionName> = z.infer<(typeof actionParams)[A]>;
export const ACTION_NAMES = Object.keys(actionParams) as ActionName[];

export const sessionInfoSchema = z.object({
  id: sessionIdSchema,
  path: z.string().max(MAX_PATH_CHARS),
  name: z.string().max(MAX_SESSION_NAME_CHARS),
  status: z.enum(["starting", "running", "stopping", "exited"]),
  pid: z.number().int().nullable(),
  startedAt: z.number(),
  exitedAt: z.number().nullable(),
  exitCode: z.number().int().nullable(),
  // rc の出力から拾ったセッションURL（拾えなければ null）
  url: z
    .string()
    .max(MAX_URL_CHARS)
    .refine((u) => u.startsWith("https://claude.ai/code"), "claude.ai/code の URL だけ")
    .nullable(),
  // 終了理由を調べるための出力の末尾（ANSI を除き、行数と長さを絞ったもの）
  lastOutput: z.array(z.string().max(MAX_LINE_CHARS)).max(MAX_OUTPUT_LINES),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const interactiveInfoSchema = z.object({
  id: interactiveIdSchema,
  path: z.string().max(MAX_PATH_CHARS),
  name: z.string().max(MAX_SESSION_NAME_CHARS),
  // stopping は停止を指示した直後の応答でだけ使う
  status: z.enum(["running", "stopping", "exited"]),
  startedAt: z.number(),
  exitCode: z.number().int().nullable(),
  // 画面から拾えたセッションURL（拾えなければ null）
  url: z
    .string()
    .max(MAX_URL_CHARS)
    .refine((u) => u.startsWith("https://claude.ai/code"), "claude.ai/code の URL だけ")
    .nullable(),
  // 画面の末尾（起動直後と終了後だけ。ANSI を除き、行数と長さを絞ったもの）
  screen: z.array(z.string().max(MAX_LINE_CHARS)).max(MAX_OUTPUT_LINES),
});
export type InteractiveInfo = z.infer<typeof interactiveInfoSchema>;

// 一覧の名前の長さの上限（表示用。辿るのには path を使う）
export const MAX_DIR_NAME_CHARS = 255;
export const dirEntrySchema = z.object({ name: z.string().max(MAX_DIR_NAME_CHARS), path: z.string().max(MAX_PATH_CHARS) });

export const actionResults = {
  // interactive は対話セッションに対応していない旧クライアントでは無い
  list_sessions: z.object({
    sessions: z.array(sessionInfoSchema).max(100),
    interactive: z.array(interactiveInfoSchema).max(100).optional(),
  }),
  stop_session: z.object({ session: sessionInfoSchema }),
  list_dirs: z.object({
    // path を省いたときは null で、entries は許可ルートの一覧になる
    path: z.string().max(MAX_PATH_CHARS).nullable(),
    entries: z.array(dirEntrySchema).max(500),
    truncated: z.boolean(),
  }),
  start_session: z.object({ session: sessionInfoSchema }),
  start_interactive: z.object({ session: interactiveInfoSchema }),
  send_input: z.object({ session: interactiveInfoSchema }),
  stop_interactive: z.object({ session: interactiveInfoSchema }),
} as const;
export type ActionResult<A extends ActionName> = z.infer<(typeof actionResults)[A]>;

export const ERROR_CODES = ["bad_request", "forbidden", "not_found", "limit", "spawn_failed", "internal"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// ---- メッセージ ----

// Worker → クライアント
export const requestMessageSchema = z.object({
  type: z.literal("request"),
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  action: z.string().max(64),
  params: z.unknown(),
});
export type RequestMessage = z.infer<typeof requestMessageSchema>;

// クライアント → Worker
export const helloMessageSchema = z.object({
  type: z.literal("hello"),
  protocol: z.number().int(),
  // 版の文字列は結果の本文にそのまま載るので、半角の英数字と . + - _ だけに絞る（改行・制御文字・記号は通さない）
  clientVersion: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/),
  platform: z.enum(["darwin", "linux", "win32", "other"]),
});

export const responseMessageSchema = z.discriminatedUnion("ok", [
  z.object({ type: z.literal("response"), id: z.string().max(64), ok: z.literal(true), result: z.unknown() }),
  z.object({
    type: z.literal("response"),
    id: z.string().max(64),
    ok: z.literal(false),
    error: z.object({ code: z.enum(ERROR_CODES), message: z.string().max(500) }),
  }),
]);
export type ResponseMessage = z.infer<typeof responseMessageSchema>;

export const clientMessageSchema = z.union([helloMessageSchema, responseMessageSchema]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// WebSocket 1通の上限（UTF-8 のバイト数。クライアント→Worker）。一覧は件数とバイト数で絞って収める（client/paths.ts の MAX_LIST_BYTES）
export const MAX_MESSAGE_BYTES = 256 * 1024;

// ハートビート。Durable Object の auto-response で返すので、DO を起こさない
export const PING = "ping";
export const PONG = "pong";
