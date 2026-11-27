import { Database } from "bun:sqlite";
import type { FsOps } from "../client/paths";

// cloudflare:workers の DurableObject の代役
export class FakeDurableObject {
  constructor(
    protected ctx: unknown,
    protected env: unknown,
  ) {}
}

// DO の ctx.storage.sql と同じ形に bun:sqlite を包む
export function sqlStorage(db = new Database(":memory:")) {
  return {
    exec: (query: string, ...bindings: unknown[]) => {
      const rows = db.query(query).all(...(bindings as never[]));
      return { toArray: () => rows };
    },
  };
}

// 偽のファイルシステム。dirs はディレクトリ、links はシンボリックリンク（リンク → 実体）、files はファイル
export function fakeFs(opts: { dirs: string[]; links?: Record<string, string>; files?: string[]; sep?: "/" | "\\" }): FsOps & {
  calls: string[];
} {
  const sep = opts.sep ?? "/";
  const links = opts.links ?? {};
  const files = new Set(opts.files ?? []);
  const dirs = new Set(opts.dirs);
  const calls: string[] = [];
  const resolveLinks = (p: string): string => {
    for (const [from, to] of Object.entries(links)) {
      if (p === from) return resolveLinks(to);
      if (p.startsWith(from + sep)) return resolveLinks(to + p.slice(from.length));
    }
    return p;
  };
  return {
    calls,
    realpath(p) {
      calls.push(`realpath ${p}`);
      const r = resolveLinks(p);
      if (!dirs.has(r) && !files.has(r)) throw new Error("ENOENT");
      return r;
    },
    isDirectory(p) {
      return dirs.has(p);
    },
    readdir(p) {
      calls.push(`readdir ${p}`);
      const prefix = p.endsWith(sep) ? p : p + sep;
      const names = new Map<string, boolean>();
      for (const d of [...dirs, ...Object.keys(links), ...files]) {
        if (!d.startsWith(prefix)) continue;
        const rest = d.slice(prefix.length);
        if (!rest || rest.includes(sep)) continue;
        names.set(rest, dirs.has(d) || d in links);
      }
      return [...names].map(([name, dirLike]) => ({ name, dirLike }));
    },
  };
}
