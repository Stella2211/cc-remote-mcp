import {
  type ActionName,
  type ErrorCode,
  MAX_PATH_CHARS,
  type ResponseMessage,
  actionParams,
  requestMessageSchema,
} from "../shared/protocol";
import { type FsOps, type Policy, isHome, listRoots, listSubdirs, resolveDir } from "./paths";
import type { InteractiveManager } from "./interactive";
import { SessionError, type SessionManager } from "./sessions";

// Worker から届いたリクエストを、決まった7つの操作のどれかに振り分ける。
// それ以外の action・余計な引数・形の合わない引数はすべて拒否する（任意のコマンドは実行しない）。

export type Deps = { policy: Policy; fs: FsOps; sessions: SessionManager; interactive: InteractiveManager };

class ActionError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function hasAction(action: string): action is ActionName {
  return Object.hasOwn(actionParams, action);
}

async function run(deps: Deps, action: ActionName, rawParams: unknown): Promise<unknown> {
  const parsed = actionParams[action].safeParse(rawParams ?? {});
  if (!parsed.success) throw new ActionError("bad_request", "引数の形が不正");

  switch (action) {
    case "list_sessions":
      return { sessions: deps.sessions.list(), interactive: await deps.interactive.list() };

    case "stop_session": {
      const { id } = parsed.data as { id: string };
      return { session: deps.sessions.stop(id) };
    }

    case "list_dirs": {
      const { path } = parsed.data as { path?: string };
      if (path === undefined) {
        // パスを省いたら許可ルートを返す（どこから辿ればよいかの入口）
        return { path: null, ...listRoots(deps.policy) };
      }
      const checked = resolveDir(deps.policy, deps.fs, path);
      if (!checked.ok) throw new ActionError(checked.code, checked.message);
      // 入力は1024文字以内でも、シンボリックリンクを解決した実体のパスは長くなりうる。
      // 応答の path に入らない（MAX_LIST_BYTES の余白もこの長さを前提にしている）ので、ここで断る
      if (checked.real.length > MAX_PATH_CHARS) {
        throw new ActionError("bad_request", `実体のパスが長すぎる（${MAX_PATH_CHARS}文字まで）`);
      }
      let listed: ReturnType<typeof listSubdirs>;
      try {
        listed = listSubdirs(deps.policy, deps.fs, checked.real);
      } catch {
        throw new ActionError("forbidden", "ディレクトリを読めなかった（権限を確認）");
      }
      return { path: checked.real, ...listed };
    }

    case "start_session": {
      const params = parsed.data as {
        path: string;
        name?: string;
        spawn?: "same-dir" | "worktree";
        permissionMode?: "default" | "acceptEdits" | "plan" | "auto";
      };
      const checked = resolveDir(deps.policy, deps.fs, params.path);
      if (!checked.ok) throw new ActionError(checked.code, checked.message);
      if (isHome(deps.policy, checked.real)) {
        throw new ActionError("forbidden", "ホームディレクトリでは rc を起動できない（trust が保存されない）。プロジェクトのディレクトリを指定する");
      }
      return { session: await deps.sessions.start(checked.real, params) };
    }

    case "start_interactive": {
      const params = parsed.data as {
        path: string;
        prompt: string;
        name?: string;
        permissionMode?: "default" | "acceptEdits" | "plan" | "auto";
        worktree?: boolean;
      };
      const checked = resolveDir(deps.policy, deps.fs, params.path);
      if (!checked.ok) throw new ActionError(checked.code, checked.message);
      if (isHome(deps.policy, checked.real)) {
        throw new ActionError("forbidden", "ホームディレクトリでは起動できない（trust が保存されない）。プロジェクトのディレクトリを指定する");
      }
      return { session: await deps.interactive.start(checked.real, params) };
    }

    case "send_input": {
      const { id, ...input } = parsed.data as { id: string; text?: string; key?: "Enter" | "Escape" | "Up" | "Down"; submit?: boolean };
      return { session: await deps.interactive.send(id, input) };
    }

    case "stop_interactive": {
      const { id } = parsed.data as { id: string };
      return { session: await deps.interactive.stop(id) };
    }
  }
}

// 受け取った文字列を処理して、返すべき応答を作る。応答を返さないもの（不正なJSONなど）は null
export async function handleRequest(deps: Deps, raw: string): Promise<ResponseMessage | null> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const msg = requestMessageSchema.safeParse(json);
  if (!msg.success) return null;
  const { id, action, params } = msg.data;

  if (!hasAction(action)) {
    return { type: "response", id, ok: false, error: { code: "bad_request", message: "許可されていない操作" } };
  }
  try {
    const result = await run(deps, action, params);
    return { type: "response", id, ok: true, result };
  } catch (err) {
    if (err instanceof ActionError || err instanceof SessionError) {
      return { type: "response", id, ok: false, error: { code: err.code, message: err.message.slice(0, 500) } };
    }
    console.error(JSON.stringify({ action, error: "internal" }));
    return { type: "response", id, ok: false, error: { code: "internal", message: "クライアント内部のエラー" } };
  }
}
