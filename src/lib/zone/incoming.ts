import type { IngestMode } from "./model.ts";
import { matchesStoredPath, samePath, splitIncoming } from "./notes.ts";

export type PathFact = {
  path: string;
  name: string;
  exists: boolean;
  isDir: boolean;
  size?: number;
  readable: boolean;
  reason?: string;
};

/** 清单里已有的记录（只需要这些字段）。用来判断“再拖一次同一个文件”该不该重新处理。 */
export type KnownFile = { id: string; path?: string; sourcePath?: string; external?: boolean };

export type PathPlan =
  | { kind: "duplicate"; path: string; name: string }
  | { kind: "fail"; path: string; name: string; reason: string }
  | { kind: "record"; path: string; name: string; size?: number; because: string }
  | { kind: "copy"; path: string; name: string; size?: number; mode: "copy" | "move"; replaceId?: string }
  /** 以前复制进来过、原文件还在，这次选的是“移动进来”：核对副本一样就移走原文件。 */
  | { kind: "settle"; path: string; name: string; recordId: string; keptPath: string };

export function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function isDiskPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** 这个文件清单里已经有了，但用户现在选的方式要求真的复制/移动：返回该怎么补做。 */
function redo(known: KnownFile[], path: string, mode: IngestMode): { kind: "replace"; id: string } | { kind: "settle"; id: string; kept: string } | null {
  if (mode === "link") return null;
  const hit = known.find((item) => matchesStoredPath(item, path));
  if (!hit) return null;
  // 只是“记了路径”的旧记录：这次真的把文件放进去，再把记录指向新位置。
  if (hit.external) return { kind: "replace", id: hit.id };
  // 以前复制进来的，原文件还在：选了“移动进来”就把原文件移走（内容一致才删）。
  if (mode === "move" && hit.path && hit.sourcePath && samePath(hit.sourcePath, path) && !samePath(hit.path, path) && isDiskPath(hit.path)) {
    return { kind: "settle", id: hit.id, kept: hit.path };
  }
  return null;
}

export function planPaths(existing: string[], facts: PathFact[], mode: IngestMode, known: KnownFile[] = []): PathPlan[] {
  const { duplicate } = splitIncoming(
    existing,
    facts.map((fact) => fact.path),
  );
  const pending = [...duplicate];
  const plans: PathPlan[] = [];
  for (const fact of facts) {
    const name = fact.name || baseName(fact.path);
    const dupAt = pending.findIndex((item) => item === fact.path);
    if (dupAt >= 0) {
      pending.splice(dupAt, 1);
      const again = fact.exists && !fact.isDir && fact.readable ? redo(known, fact.path, mode) : null;
      if (again?.kind === "replace") {
        plans.push({ kind: "copy", path: fact.path, name, size: fact.size, mode: mode === "move" ? "move" : "copy", replaceId: again.id });
      } else if (again?.kind === "settle") {
        plans.push({ kind: "settle", path: fact.path, name, recordId: again.id, keptPath: again.kept });
      } else {
        plans.push({ kind: "duplicate", path: fact.path, name });
      }
      continue;
    }
    if (!fact.exists) {
      plans.push({ kind: "fail", path: fact.path, name, reason: fact.reason || `找不到 ${fact.path}。` });
      continue;
    }
    if (fact.isDir) {
      plans.push({ kind: "record", path: fact.path, name, because: "文件夹没法复制或移动，只记录了路径" });
      continue;
    }
    if (!fact.readable) {
      plans.push({ kind: "fail", path: fact.path, name, reason: fact.reason || `没有权限读取 ${fact.path}。` });
      continue;
    }
    if (mode === "link") {
      plans.push({ kind: "record", path: fact.path, name, size: fact.size, because: "只记录了路径" });
      continue;
    }
    plans.push({ kind: "copy", path: fact.path, name, size: fact.size, mode: mode === "move" ? "move" : "copy" });
  }
  return plans;
}

export function storedPaths(files: { path?: string; sourcePath?: string }[]): string[] {
  const paths: string[] = [];
  for (const file of files) {
    if (file.path) paths.push(file.path);
    if (file.sourcePath) paths.push(file.sourcePath);
  }
  return paths;
}