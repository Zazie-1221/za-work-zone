import type { Folder, StageBoard, StageTodo, Workspace, ZoneFile } from "./model.ts";

export function capText(text: string, max = 80): string {
  return [...text].slice(0, max).join("");
}

export function clampProgress(text: string): string {
  return capText(text.trim());
}

export function clampLine(text: string): string {
  return capText(text.replace(/\s+/g, " ").trim());
}

export function samePath(left: string, right: string): boolean {
  const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(left) === norm(right);
}

export function matchesStoredPath(file: { path?: string; sourcePath?: string }, path: string): boolean {
  return Boolean((file.path && samePath(file.path, path)) || (file.sourcePath && samePath(file.sourcePath, path)));
}

export function splitIncoming(existing: string[], incoming: string[]): { fresh: string[]; duplicate: string[] } {
  const seen = [...existing];
  const fresh: string[] = [];
  const duplicate: string[] = [];
  for (const path of incoming) {
    if (seen.some((item) => samePath(item, path))) {
      duplicate.push(path);
      continue;
    }
    seen.push(path);
    fresh.push(path);
  }
  return { fresh, duplicate };
}

export function openTodoCount(board: StageBoard | undefined): number {
  return board?.todos.filter((todo) => !todo.done).length ?? 0;
}

export function boardFor(workspace: Workspace, folderId: string): StageBoard {
  return (
    workspace.stageNotes?.find((board) => board.folderId === folderId) ?? {
      folderId,
      note: "",
      todos: [],
      updatedAt: 0,
    }
  );
}

export function advanceHint(workspace: Workspace, folderId: string | undefined): string {
  if (!folderId) return "";
  const count = openTodoCount(boardFor(workspace, folderId));
  return count > 0 ? `这一阶段还有 ${count} 件待办没做完。` : "";
}

export type ResumeBrief = {
  stageName: string;
  files: string[];
  todos: string[];
};

export function resumeBrief(workspace: Workspace, files: ZoneFile[]): ResumeBrief | null {
  const roots = workspace.folders.filter((folder) => folder.parentId == null);
  const boards = workspace.stageNotes ?? [];
  const open = boards.flatMap((board) => board.todos.filter((todo) => !todo.done).map((todo) => ({ board, todo })));
  if (open.length === 0) return null;
  const latest = [...boards].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const stageName =
    roots.find((folder) => folder.id === latest?.folderId)?.name ??
    roots.find((folder) => folder.id === workspace.currentStageId)?.name ??
    roots[0]?.name ??
    "当前阶段";
  const recent = files
    .filter((file) => file.workspaceId === workspace.id && file.openedAt)
    .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))
    .slice(0, 3)
    .map((file) => file.name);
  const order = new Map(roots.map((folder, index) => [folder.id, index]));
  const todos = [...open]
    .sort((a, b) => (order.get(a.board.folderId) ?? 0) - (order.get(b.board.folderId) ?? 0))
    .slice(0, 3)
    .map((item) => item.todo.text);
  return { stageName, files: recent, todos };
}

export function stageName(folders: Folder[], id: string | undefined): string {
  return folders.find((folder) => folder.id === id)?.name ?? "";
}

export function sanitizeBoards(value: unknown): StageBoard[] {
  if (!Array.isArray(value)) return [];
  const boards: StageBoard[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<StageBoard>;
    if (typeof row.folderId !== "string" || !row.folderId) continue;
    const todos: StageTodo[] = [];
    if (Array.isArray(row.todos)) {
      for (const todo of row.todos) {
        if (!todo || typeof todo !== "object") continue;
        const task = todo as Partial<StageTodo>;
        if (typeof task.id !== "string" || typeof task.text !== "string") continue;
        const text = clampLine(task.text);
        if (!text) continue;
        todos.push({ id: task.id, text, done: Boolean(task.done) });
      }
    }
    boards.push({
      folderId: row.folderId,
      note: typeof row.note === "string" ? clampLine(row.note) : "",
      todos,
      updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
    });
  }
  return boards;
}
