import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { isDesktop, loadDesktopState, saveDesktopState } from "@/lib/zone/desktop";
import {
  classifyText,
  clipTitle,
  defaultFolders,
  descendantIds,
  KIND_LABEL,
  DEFAULT_IGNORED_APPS,
  kindFromName,
  placeFile,
  roleForRule,
  roleFromName,
  ruleHit,
  stageOverrideForName,
  ruleMatchOk,
  seedContent,
  advanceStage,
  reopenStage,
  resetStages,
  uid,
  isFolderInside,
  type Clip,
  type ClipKind,
  type Folder,
  type PanelPos,
  type Workspace,
  type ZoneFile,
} from "@/lib/zone/model";
import { dirPrefix, isAbsolutePath } from "@/lib/zone/package";
import { versionCards } from "@/lib/zone/versions";
import { advanceHint, clampLine, clampProgress, matchesStoredPath } from "@/lib/zone/notes";
import type { Dock, IngestMode, StageBoard } from "@/lib/zone/model";
import { DEFAULT_DOCK } from "@/lib/zone/model";

export type ClipResult = "added" | "duplicate" | "sensitive" | "empty";

type FileInput = {
  name: string;
  size?: number;
  thumb?: string;
  dominant?: string;
  path?: string;
  sourcePath?: string;
  modifiedAt?: number;
  folderId?: string | null;
  external?: boolean;
  keepUnlocked?: boolean;
  workspaceId?: string;
};

type Persisted = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  files: ZoneFile[];
  clips: Clip[];
  capturePaused: boolean;
  ignoredApps: string[];
  panel: PanelPos | null;
  collapsed: boolean;
  dock: Dock;
  shellMenu: boolean;
};

type ZoneState = Persisted & {
  setActiveWorkspace: (id: string) => void;
  addWorkspace: (name: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  removeWorkspace: (id: string) => void;
  addFolder: (name: string, parentId?: string | null) => void;
  renameFolder: (id: string, name: string) => void;
  moveFolder: (id: string, parentId: string | null) => void;
  removeFolder: (id: string, withContents: boolean) => void;
  addFile: (input: FileInput) => { fileId: string | null; message: string };
  openFile: (id: string) => void;
  moveFile: (id: string, folderId: string) => void;
  togglePinFile: (id: string) => void;
  removeFile: (id: string) => void;
  /** 乐观删除失败时把记录放回去（按原来的顺序），不丢任何文件记录。 */
  restoreRemoved: (snapshot: { files: ZoneFile[]; workspace?: Workspace }) => void;
  setVersionCurrent: (id: string) => void;
  splitVersion: (id: string) => void;
  mergeVersionGroups: (ids: string[]) => void;
  setFileTags: (id: string, tags: string[]) => void;
  relinkFile: (
    id: string,
    patch: { name: string; size?: number; thumb?: string; dominant?: string; path?: string; external?: boolean; modifiedAt?: number },
  ) => void;
  markMissing: (ids: string[]) => void;
  markPresent: (ids: string[]) => void;
  setIgnoredApps: (names: string[]) => void;
  addRule: (match: string, purpose: "active" | "hold" | "ref" | "archive") => "added" | "short";
  removeRule: (id: string) => void;
  addClipText: (raw: string) => ClipResult;
  addClipImage: (thumb: string, name: string, dominant?: string, originalPath?: string) => ClipResult;
  touchClip: (id: string) => void;
  togglePinClip: (id: string) => void;
  removeClip: (id: string) => void;
  setPaused: (paused: boolean) => void;
  setPanel: (panel: PanelPos | null) => void;
  setCollapsed: (collapsed: boolean) => void;
  setDock: (dock: Dock) => void;
  focusStage: (id: string) => void;
  confirmStage: () => { message: string; openId?: string };
  reopenStage: (id: string) => { message: string; openId?: string };
  resetStages: () => { message: string; openId?: string };
  setProgress: (text: string) => void;
  setStageNote: (folderId: string, note: string) => void;
  addTodo: (folderId: string, text: string) => string | null;
  toggleTodo: (folderId: string, id: string) => void;
  removeTodo: (folderId: string, id: string) => void;
  reorderTodos: (folderId: string, fromId: string, toId: string) => void;
  setFileNote: (id: string, note: string) => void;
  setIngestMode: (mode: IngestMode) => void;
  setStoreDir: (workspaceId: string, dir: string | undefined) => void;
  setShellMenu: (enabled: boolean) => void;
  resetDemo: () => void;
  adoptPackage: (snapshot: { workspace: Workspace; files: ZoneFile[]; pinnedClips: Clip[] }) => void;
};

const CLIP_CAP = 120;

function prune(clips: Clip[]): Clip[] {
  const unpinned = clips
    .filter((c) => !c.pinned)
    .sort((a, b) => b.usedAt - a.usedAt)
    .slice(0, CLIP_CAP);
  const keep = new Set([...clips.filter((c) => c.pinned), ...unpinned].map((c) => c.id));
  return clips.filter((c) => keep.has(c.id));
}

function keepStage(ws: Workspace, removed: string[], folders: Folder[]) {
  const doneStageIds = (ws.doneStageIds ?? []).filter(
    (id) => !removed.includes(id) && folders.some((folder) => folder.id === id && folder.parentId == null),
  );
  const roots = folders.filter((folder) => folder.parentId == null);
  const currentOk = roots.some((folder) => folder.id === ws.currentStageId);
  return {
    doneStageIds,
    currentStageId: currentOk
      ? ws.currentStageId
      : (roots.find((folder) => !doneStageIds.includes(folder.id))?.id ?? roots[0]?.id),
  };
}

function dismissPaths(ws: Workspace, paths: string[]): Workspace {
  const next = [...new Set([...(ws.dismissedPaths ?? []), ...paths.filter(Boolean)])];
  if (next.length === (ws.dismissedPaths ?? []).length) return ws;
  return { ...ws, dismissedPaths: next };
}

function forgetDismissed(ws: Workspace, path?: string): Workspace {
  if (!path || !(ws.dismissedPaths ?? []).includes(path)) return ws;
  return { ...ws, dismissedPaths: (ws.dismissedPaths ?? []).filter((item) => item !== path) };
}

function relativePath(file: ZoneFile): string {
  if (!file.path || file.external || isAbsolutePath(file.path)) return "";
  return file.path;
}

function dropBoards(ws: Workspace, removed: string[]): StageBoard[] {
  return (ws.stageNotes ?? []).filter((board) => !removed.includes(board.folderId));
}

function touchBoard(ws: Workspace, folderId: string, edit: (board: StageBoard) => StageBoard): Workspace {
  const boards = [...(ws.stageNotes ?? [])];
  const index = boards.findIndex((board) => board.folderId === folderId);
  const current = boards[index] ?? { folderId, note: "", todos: [], updatedAt: 0 };
  const next = { ...edit(current), folderId, updatedAt: Date.now() };
  if (index >= 0) boards[index] = next;
  else boards.push(next);
  return { ...ws, stageNotes: boards };
}

function activeWorkspace(state: Persisted): Workspace | undefined {
  return state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? state.workspaces[0];
}

function retarget(files: ZoneFile[], ws: Workspace): ZoneFile[] {
  return files.map((file) => {
    if (file.workspaceId !== ws.id || file.folderLocked) return file;
    const hit = ruleHit(file.name, ws.rules);
    const placed = placeFile({ name: file.name, path: file.path, folders: ws.folders, rules: ws.rules });
    const role = hit ? roleForRule(hit.purpose, file.name) : roleFromName(file.name);
    if (file.folderId === placed.folderId && file.role === role) return file;
    return { ...file, folderId: placed.folderId, role };
  });
}

function blank(): Persisted {
  const seeded = seedContent();
  return {
    ...seeded,
    capturePaused: false,
    ignoredApps: DEFAULT_IGNORED_APPS,
    panel: null,
    collapsed: false,
    dock: DEFAULT_DOCK,
    shellMenu: true,
  };
}

export const useZone = create<ZoneState>()(
  persist(
    (set, get) => ({
      ...blank(),
      setActiveWorkspace: (id) => {
        if (get().workspaces.some((w) => w.id === id)) set({ activeWorkspaceId: id });
      },
      addWorkspace: (name) => {
        const title = name.trim();
        if (!title) return;
        const id = uid();
        const folders = defaultFolders();
        const ws: Workspace = {
          id,
          name: title,
          folders,
          rules: [],
          currentStageId: folders[0]?.id,
          doneStageIds: [],
        };
        set({ workspaces: [...get().workspaces, ws], activeWorkspaceId: id });
      },
      renameWorkspace: (id, name) => {
        const title = name.trim();
        if (!title) return;
        set({
          workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, name: title } : w)),
        });
      },
      removeWorkspace: (id) => {
        const list = get().workspaces;
        if (list.length < 2) return;
        const next = list.filter((w) => w.id !== id);
        const active =
          get().activeWorkspaceId === id ? (next[0]?.id ?? "") : get().activeWorkspaceId;
        set({
          workspaces: next,
          activeWorkspaceId: active,
          files: get().files.filter((f) => f.workspaceId !== id),
        });
      },
      addFolder: (name, parentId = null) => {
        const title = name.trim();
        if (!title) return;
        const ws = activeWorkspace(get());
        if (!ws) return;
        if (parentId && !ws.folders.some((folder) => folder.id === parentId)) return;
        set({
          workspaces: get().workspaces.map((workspace) =>
            workspace.id === ws.id
              ? { ...workspace, folders: [...workspace.folders, { id: uid(), parentId, name: title }] }
              : workspace,
          ),
        });
      },
      renameFolder: (id, name) => {
        const title = name.trim();
        if (!title) return;
        const ws = activeWorkspace(get());
        if (!ws) return;
        const folders = ws.folders.map((folder) => (folder.id === id ? { ...folder, name: title } : folder));
        const oldPrefix = dirPrefix(ws.folders, id);
        const newPrefix = dirPrefix(folders, id);
        set({
          workspaces: get().workspaces.map((workspace) => (workspace.id === ws.id ? { ...workspace, folders } : workspace)),
          files:
            !oldPrefix || oldPrefix === newPrefix
              ? get().files
              : get().files.map((file) => {
                  if (file.workspaceId !== ws.id || file.external || !file.path || isAbsolutePath(file.path)) return file;
                  if (file.path === oldPrefix || file.path.startsWith(`${oldPrefix}/`)) {
                    return { ...file, path: `${newPrefix}${file.path.slice(oldPrefix.length)}` };
                  }
                  return file;
                }),
        });
      },
      moveFolder: (id, parentId) => {
        const ws = activeWorkspace(get());
        if (!ws || id === parentId || isFolderInside(ws.folders, id, parentId)) return;
        if (parentId && !ws.folders.some((folder) => folder.id === parentId)) return;
        set({
          workspaces: get().workspaces.map((workspace) =>
            workspace.id === ws.id
              ? { ...workspace, folders: workspace.folders.map((folder) => (folder.id === id ? { ...folder, parentId } : folder)) }
              : workspace,
          ),
        });
      },
      removeFolder: (id, withContents) => {
        const ws = activeWorkspace(get());
        if (!ws) return;
        const node = ws.folders.find((folder) => folder.id === id);
        if (!node) return;
        const ids = descendantIds(ws.folders, id);
        const stageOf = (folders: Folder[]) => keepStage(ws, ids, folders);
        if (withContents) {
          const folders = ws.folders.filter((folder) => !ids.includes(folder.id));
          const gone = get().files.filter((file) => file.workspaceId === ws.id && ids.includes(file.folderId));
          const paths = gone.map(relativePath).filter(Boolean);
          set({
            workspaces: get().workspaces.map((workspace) =>
              workspace.id === ws.id
                ? dismissPaths({ ...workspace, folders, stageNotes: dropBoards(ws, ids), ...stageOf(folders) }, paths)
                : workspace,
            ),
            files: get().files.filter((file) => !(file.workspaceId === ws.id && ids.includes(file.folderId))),
          });
          return;
        }
        const children = ws.folders.filter((folder) => folder.parentId === id);
        const elsewhere = ws.folders.find((folder) => !ids.includes(folder.id));
        const fileTarget = node.parentId ?? children[0]?.id ?? elsewhere?.id ?? "";
        const folders = ws.folders
          .filter((folder) => folder.id !== id)
          .map((folder) => (folder.parentId === id ? { ...folder, parentId: node.parentId } : folder));
        set({
          workspaces: get().workspaces.map((workspace) =>
            workspace.id === ws.id ? { ...workspace, folders, stageNotes: dropBoards(ws, [id]), ...stageOf(folders) } : workspace,
          ),
          files: get().files.map((file) =>
            file.workspaceId === ws.id && file.folderId === id
              ? { ...file, folderId: fileTarget, folderLocked: true }
              : file,
          ),
        });
      },
      addFile: (input) => {
        const ws = input.workspaceId
          ? get().workspaces.find((workspace) => workspace.id === input.workspaceId)
          : activeWorkspace(get());
        if (!ws) return { fileId: null, message: "还没有工作区" };
        const kind = kindFromName(input.name);
        const hit = ruleHit(input.name, ws.rules);
        const role = hit ? roleForRule(hit.purpose, input.name) : roleFromName(input.name);
        const placed = placeFile({
          name: input.name,
          path: input.path,
          folders: ws.folders,
          rules: ws.rules,
          chosenId: input.keepUnlocked ? null : input.folderId,
        });
        const folderId = input.keepUnlocked && input.folderId ? input.folderId : placed.folderId;
        const folderLocked = input.keepUnlocked ? false : placed.locked;
        if (!placed.folderId) return { fileId: null, message: "还没有阶段" };
        const identity = (file: ZoneFile) => {
          if (input.path && matchesStoredPath(file, input.path)) return true;
          if (input.sourcePath && matchesStoredPath(file, input.sourcePath)) return true;
          return false;
        };
        const byPath = input.path || input.sourcePath
          ? get().files.find((file) => file.workspaceId === ws.id && identity(file))
          : undefined;
        if (byPath) {
          set({
            workspaces: get().workspaces.map((workspace) => (workspace.id === ws.id ? forgetDismissed(workspace, input.path) : workspace)),
            files: get().files.map((file) =>
              file.id === byPath.id
                ? {
                    ...file,
                    thumb: input.thumb ?? file.thumb,
                    dominant: input.dominant ?? file.dominant,
                    size: input.size ?? file.size,
                    path: input.path ?? file.path,
                    sourcePath: input.sourcePath ?? file.sourcePath,
                    external: input.external ?? file.external,
                    modifiedAt: input.modifiedAt ?? file.modifiedAt,
                    stale: false,
                  }
                : file,
            ),
          });
          return { fileId: byPath.id, message: `${input.name} 已在项目里` };
        }
        const sameName = get().files.filter((file) => file.workspaceId === ws.id && file.name === input.name);
        const sameVersion = (file: ZoneFile) => {
          if (input.path && (file.path || file.sourcePath) && !identity(file)) return false;
          return file.size === input.size;
        };
        const existing = sameName.find((file) => sameVersion(file));
        if (existing) {
          set({
            workspaces: get().workspaces.map((workspace) => (workspace.id === ws.id ? forgetDismissed(workspace, input.path) : workspace)),
            files: get().files.map((f) =>
              f.id === existing.id
                ? {
                    ...f,
                    thumb: input.thumb ?? f.thumb,
                    dominant: input.dominant ?? f.dominant,
                    path: input.path ?? f.path,
                    sourcePath: input.sourcePath ?? f.sourcePath,
                    external: input.external ?? f.external,
                    modifiedAt: input.modifiedAt ?? f.modifiedAt,
                    folderId,
                    folderLocked,
                    stale: false,
                    createdAt: Date.now(),
                  }
                : f,
            ),
          });
          return { fileId: existing.id, message: `${input.name} 已重新挂上` };
        }
        const id = uid();
        const item: ZoneFile = {
          id,
          workspaceId: ws.id,
          folderId,
          folderLocked,
          kind,
          role,
          name: input.name,
          path: input.path,
          sourcePath: input.sourcePath,
          external: input.external,
          tags: [],
          size: input.size,
          thumb: input.thumb,
          dominant: input.dominant,
          stale: false,
          pinned: false,
          createdAt: Date.now(),
          modifiedAt: input.modifiedAt,
        };
        set({
          workspaces: get().workspaces.map((workspace) => (workspace.id === ws.id ? forgetDismissed(workspace, input.path) : workspace)),
          files: [
            item,
            ...get().files.map((f) => (sameName.some((old) => old.id === f.id) && sameVersion(f) ? { ...f, stale: true } : f)),
          ],
        });
        const how = placed.label;
        const replaced = sameName.some((file) => sameVersion(file)) ? "。同名旧记录已标成失效" : "";
        return { fileId: id, message: `${input.name} ${how} · ${KIND_LABEL[kind]}${replaced}` };
      },
      openFile: (id) => {
        set({
          files: get().files.map((f) => (f.id === id ? { ...f, openedAt: Date.now() } : f)),
        });
      },
      moveFile: (id, folderId) => {
        set({
          files: get().files.map((file) => (file.id === id ? { ...file, folderId, folderLocked: true } : file)),
        });
      },
      togglePinFile: (id) => {
        set({
          files: get().files.map((f) => (f.id === id ? { ...f, pinned: !f.pinned } : f)),
        });
      },
      removeFile: (id) => {
        const file = get().files.find((item) => item.id === id);
        const path = file ? relativePath(file) : "";
        set({
          files: get().files.filter((item) => item.id !== id),
          workspaces:
            file && path
              ? get().workspaces.map((workspace) => (workspace.id === file.workspaceId ? dismissPaths(workspace, [path]) : workspace))
              : get().workspaces,
        });
      },
      restoreRemoved: (snapshot) => {
        const current = new Map(get().files.map((file) => [file.id, file]));
        const before = new Set(snapshot.files.map((file) => file.id));
        const merged = [...snapshot.files.map((file) => current.get(file.id) ?? file), ...get().files.filter((file) => !before.has(file.id))];
        const back = snapshot.workspace;
        set({
          files: merged,
          workspaces: back ? get().workspaces.map((workspace) => (workspace.id === back.id ? back : workspace)) : get().workspaces,
        });
      },
      setVersionCurrent: (id) => {
        const file = get().files.find((item) => item.id === id);
        if (!file) return;
        const card = versionCards(
          get().files.filter((item) => item.workspaceId === file.workspaceId && item.folderId === file.folderId),
        ).find((group) => group.members.some((item) => item.id === id));
        const ids = new Set(card?.members.map((item) => item.id) ?? [id]);
        set({
          files: get().files.map((item) => {
            if (!ids.has(item.id)) return item;
            if (item.id === id) return { ...item, versionCurrent: true };
            return item.versionCurrent ? { ...item, versionCurrent: undefined } : item;
          }),
        });
      },
      splitVersion: (id) => {
        set({
          files: get().files.map((item) =>
            item.id === id ? { ...item, versionSolo: true, versionGroup: undefined, versionCurrent: undefined } : item,
          ),
        });
      },
      mergeVersionGroups: (ids) => {
        const unique = [...new Set(ids)];
        if (unique.length < 2) return;
        const chosen = new Set(unique);
        const group = uid();
        const keep = unique.find((item) => get().files.find((file) => file.id === item)?.versionCurrent);
        set({
          files: get().files.map((item) =>
            chosen.has(item.id)
              ? { ...item, versionGroup: group, versionSolo: false, versionCurrent: keep ? item.id === keep : undefined }
              : item,
          ),
        });
      },
      setFileTags: (id, tags) => {
        const next = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 8);
        set({ files: get().files.map((file) => (file.id === id ? { ...file, tags: next } : file)) });
      },
      markMissing: (ids) => {
        if (ids.length === 0) return;
        const missing = new Set(ids);
        set({
          files: get().files.map((file) => (missing.has(file.id) ? { ...file, stale: true } : file)),
        });
      },
      markPresent: (ids) => {
        if (ids.length === 0) return;
        const back = new Set(ids);
        set({
          files: get().files.map((file) => (back.has(file.id) ? { ...file, stale: false } : file)),
        });
      },
      setIgnoredApps: (names) => {
        const ignoredApps = names.map((name) => name.trim().toLowerCase()).filter((name) => name.length > 1);
        set({ ignoredApps });
      },
      relinkFile: (id, patch) => {
        const file = get().files.find((item) => item.id === id);
        if (!file) return;
        const ws = get().workspaces.find((item) => item.id === file.workspaceId);
        const name = patch.name.trim() || file.name;
        const hit = ws ? ruleHit(name, ws.rules) : undefined;
        const role = hit ? roleForRule(hit.purpose, name) : roleFromName(name);
        const placed =
          file.folderLocked || !ws
            ? null
            : placeFile({ name, path: patch.path ?? file.path, folders: ws.folders, rules: ws.rules });
        set({
          files: get().files.map((item) =>
            item.id === id
              ? {
                  ...item,
                  name,
                  size: patch.size,
                  thumb: patch.thumb,
                  dominant: patch.dominant,
                  path: patch.path ?? item.path,
                  external: patch.external ?? item.external,
                  modifiedAt: patch.modifiedAt ?? item.modifiedAt,
                  kind: kindFromName(name),
                  role,
                  folderId: placed?.folderId ?? item.folderId,
                  stale: false,
                }
              : item,
          ),
        });
      },
      addRule: (match, purpose) => {
        const text = match.trim().toLowerCase();
        if (!ruleMatchOk(text)) return "short";
        const ws = activeWorkspace(get());
        if (!ws) return "short";
        const rules = (ws.rules ?? []).filter((rule) => rule.match !== text);
        const next = { ...ws, rules: [{ id: uid(), match: text, purpose }, ...rules] };
        set({
          workspaces: get().workspaces.map((w) => (w.id === ws.id ? next : w)),
          files: retarget(get().files, next),
        });
        return "added";
      },
      removeRule: (id) => {
        const ws = activeWorkspace(get());
        if (!ws) return;
        const next = { ...ws, rules: (ws.rules ?? []).filter((rule) => rule.id !== id) };
        set({
          workspaces: get().workspaces.map((w) => (w.id === ws.id ? next : w)),
          files: retarget(get().files, next),
        });
      },
      addClipText: (raw) => {
        const kind = classifyText(raw);
        if (kind === "empty") return "empty";
        if (kind === "sensitive") return "sensitive";
        const text = raw.trim();
        const now = Date.now();
        const existing = get().clips.find((c) => c.kind !== "image" && c.text === text);
        if (existing) {
          set({
            clips: get().clips.map((c) => (c.id === existing.id ? { ...c, usedAt: now } : c)),
          });
          return "duplicate";
        }
        const clip: Clip = {
          id: uid(),
          kind,
          text,
          name: clipTitle(kind, text),
          pinned: false,
          createdAt: now,
          usedAt: now,
        };
        set({ clips: prune([clip, ...get().clips]) });
        return "added";
      },
      addClipImage: (thumb, name, dominant, originalPath) => {
        if (!thumb.startsWith("data:image/")) return "empty";
        const now = Date.now();
        const existing = get().clips.find((c) => c.kind === "image" && c.thumb === thumb);
        if (existing) {
          set({
            clips: get().clips.map((c) =>
              c.id === existing.id
                ? {
                    ...c,
                    usedAt: now,
                    dominant: dominant ?? c.dominant,
                    originalPath: originalPath ?? c.originalPath,
                  }
                : c,
            ),
          });
          return "duplicate";
        }
        const clip: Clip = {
          id: uid(),
          kind: "image",
          thumb,
          dominant,
          originalPath,
          name: name.trim() || "剪贴图片",
          pinned: false,
          createdAt: now,
          usedAt: now,
        };
        const next = prune([clip, ...get().clips]);
        const kept = new Set(next.map((c) => c.id));
        for (const old of get().clips) {
          if (!kept.has(old.id) && old.originalPath) {
            void import("@/lib/zone/desktop").then((d) => d.clipForgetOriginal(old.originalPath!)).catch(() => {});
          }
        }
        set({ clips: next });
        return "added";
      },
      touchClip: (id) => {
        const now = Date.now();
        set({
          clips: get().clips.map((c) => (c.id === id ? { ...c, usedAt: now } : c)),
        });
      },
      togglePinClip: (id) => {
        set({
          clips: get().clips.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)),
        });
      },
      removeClip: (id) => {
        const victim = get().clips.find((c) => c.id === id);
        if (victim?.originalPath) {
          void import("@/lib/zone/desktop").then((d) => d.clipForgetOriginal(victim.originalPath!)).catch(() => {});
        }
        set({ clips: get().clips.filter((c) => c.id !== id) });
      },
      setPaused: (paused) => set({ capturePaused: paused }),
      setPanel: (panel) => set({ panel }),
      setCollapsed: (collapsed) => set({ collapsed }),
      setDock: (dock) => set({ dock }),
      focusStage: (id) => {
        const ws = activeWorkspace(get());
        if (!ws || !ws.folders.some((folder) => folder.id === id && folder.parentId == null)) return;
        set({
          workspaces: get().workspaces.map((workspace) =>
            workspace.id === ws.id ? { ...workspace, currentStageId: id } : workspace,
          ),
        });
      },
      confirmStage: () => {
        const ws = activeWorkspace(get());
        if (!ws) return { message: "还没有工作区" };
        const leaving = ws.folders.find((folder) => folder.id === ws.currentStageId && !(ws.doneStageIds ?? []).includes(folder.id));
        const hint = advanceHint(ws, leaving?.id);
        const next = advanceStage(ws);
        set({
          workspaces: get().workspaces.map((workspace) => (workspace.id === ws.id ? next.workspace : workspace)),
        });
        return { message: hint ? `${next.message} ${hint}` : next.message, openId: next.openId };
      },
      reopenStage: (id) => {
        const ws = activeWorkspace(get());
        if (!ws) return { message: "还没有工作区" };
        const next = reopenStage(ws, id);
        set({ workspaces: get().workspaces.map((workspace) => (workspace.id === ws.id ? next.workspace : workspace)) });
        return { message: next.message, openId: next.openId };
      },
      resetStages: () => {
        const ws = activeWorkspace(get());
        if (!ws) return { message: "还没有工作区" };
        const next = resetStages(ws);
        set({ workspaces: get().workspaces.map((workspace) => (workspace.id === ws.id ? next.workspace : workspace)) });
        return { message: next.message, openId: next.openId };
      },
      setProgress: (text) => {
        const ws = activeWorkspace(get());
        if (!ws) return;
        const progress = clampProgress(text);
        set({
          workspaces: get().workspaces.map((workspace) => (workspace.id === ws.id ? { ...workspace, progress } : workspace)),
        });
      },
      setStageNote: (folderId, note) => {
        const ws = activeWorkspace(get());
        if (!ws || !ws.folders.some((folder) => folder.id === folderId)) return;
        const next = touchBoard(ws, folderId, (board) => ({ ...board, note: clampLine(note) }));
        set({ workspaces: get().workspaces.map((workspace) => (workspace.id === ws.id ? next : workspace)) });
      },
      addTodo: (folderId, text) => {
        const line = clampLine(text);
        const ws = activeWorkspace(get());
        if (!line || !ws || !ws.folders.some((folder) => folder.id === folderId)) return null;
        const id = uid();
        const next = touchBoard(ws, folderId, (board) => ({
          ...board,
          todos: [...board.todos, { id, text: line, done: false }],
        }));
        set({ workspaces: get().workspaces.map((workspace) => (workspace.id === ws.id ? next : workspace)) });
        return id;
      },
      toggleTodo: (folderId, id) => {
        const ws = activeWorkspace(get());
        if (!ws) return;
        const next = touchBoard(ws, folderId, (board) => ({
          ...board,
          todos: board.todos.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo)),
        }));
        set({ workspaces: get().workspaces.map((workspace) => (workspace.id === ws.id ? next : workspace)) });
      },
      removeTodo: (folderId, id) => {
        const ws = activeWorkspace(get());
        if (!ws) return;
        const next = touchBoard(ws, folderId, (board) => ({
          ...board,
          todos: board.todos.filter((todo) => todo.id !== id),
        }));
        set({ workspaces: get().workspaces.map((workspace) => (workspace.id === ws.id ? next : workspace)) });
      },
      reorderTodos: (folderId, fromId, toId) => {
        if (fromId === toId) return;
        const ws = activeWorkspace(get());
        if (!ws) return;
        const next = touchBoard(ws, folderId, (board) => {
          const todos = [...board.todos];
          const from = todos.findIndex((todo) => todo.id === fromId);
          const to = todos.findIndex((todo) => todo.id === toId);
          if (from < 0 || to < 0) return board;
          const [item] = todos.splice(from, 1);
          if (!item) return board;
          todos.splice(to, 0, item);
          return { ...board, todos };
        });
        set({ workspaces: get().workspaces.map((workspace) => (workspace.id === ws.id ? next : workspace)) });
      },
      setFileNote: (id, note) => {
        const line = clampLine(note);
        set({
          files: get().files.map((file) => (file.id === id ? { ...file, note: line || undefined } : file)),
        });
      },
      setIngestMode: (mode) => {
        const ws = activeWorkspace(get());
        if (!ws) return;
        set({
          workspaces: get().workspaces.map((workspace) => (workspace.id === ws.id ? { ...workspace, ingestMode: mode } : workspace)),
        });
      },
      setStoreDir: (workspaceId, dir) => {
        const clean = dir?.trim() || undefined;
        set({
          workspaces: get().workspaces.map((workspace) => (workspace.id === workspaceId ? { ...workspace, storeDir: clean } : workspace)),
        });
      },
      setShellMenu: (enabled) => set({ shellMenu: enabled }),
      resetDemo: () => {
        const keep = { panel: get().panel, collapsed: get().collapsed, dock: get().dock };
        set({ ...blank(), ...keep });
      },
      adoptPackage: (snapshot) => {
        const incoming = snapshot.workspace;
        const rest = get().workspaces.filter((workspace) => workspace.id !== incoming.id);
        const pinned = new Set(snapshot.pinnedClips.map((clip) => clip.id));
        const clips = [
          ...snapshot.pinnedClips,
          ...get().clips.filter((clip) => !pinned.has(clip.id) && !snapshot.pinnedClips.some((item) => item.text && item.text === clip.text)),
        ];
        set({
          workspaces: [...rest, incoming],
          activeWorkspaceId: incoming.id,
          files: [...get().files.filter((file) => file.workspaceId !== incoming.id), ...snapshot.files],
          clips,
        });
      },
    }),
    {
      name: "za-work-zone",
      version: 11,
      storage: createJSONStorage(() => ({
        getItem: (name) => (isDesktop() ? loadDesktopState(name) : localStorage.getItem(name)),
        setItem: (name, value) => {
          if (isDesktop()) saveDesktopState(value);
          else localStorage.setItem(name, value);
        },
        removeItem: (name) => {
          if (!isDesktop()) localStorage.removeItem(name);
        },
      })),
      migrate: (persisted, version) => {
        let state = persisted as Persisted;
        if (version < 2) {
          state = {
            ...state,
            workspaces: state.workspaces.map((workspace) => ({ ...workspace, rules: workspace.rules ?? [] })),
            files: state.files.map((file) => ({ ...file, stale: file.stale ?? false })),
          };
        }
        if (version < 3) {
          state = {
            ...state,
            files: state.files.map((file) => ({ ...file, kind: kindFromName(file.name) })),
          };
        }
        if (version < 4) {
          state = { ...state, ignoredApps: state.ignoredApps?.length ? state.ignoredApps : DEFAULT_IGNORED_APPS };
        }
        if (version < 5) {
          state = {
            ...state,
            workspaces: state.workspaces.map((workspace) => {
              const legacy = workspace as Workspace & { shelves?: { id: string; name: string }[]; folders?: Workspace["folders"] };
              if (legacy.folders && legacy.folders.length > 0) return { ...workspace, folders: legacy.folders };
              const folders = (legacy.shelves ?? []).map((shelf) => ({ id: shelf.id, parentId: null, name: shelf.name }));
              return { ...workspace, folders: folders.length > 0 ? folders : defaultFolders() };
            }),
            files: state.files.map((file) => {
              const legacy = file as ZoneFile & { shelfId?: string; shelfLocked?: boolean };
              return {
                ...file,
                folderId: file.folderId || legacy.shelfId || "",
                folderLocked: file.folderLocked ?? legacy.shelfLocked ?? false,
                tags: file.tags ?? [],
              };
            }),
          };
        }
        if (version < 7) {
          state = {
            ...state,
            files: state.workspaces.reduce((files, workspace) => retarget(files, workspace), state.files),
          };
        }
        if (version < 8) {
          state = {
            ...state,
            workspaces: state.workspaces.map((workspace) => {
              const roots = workspace.folders.filter((folder) => folder.parentId == null);
              const currentOk = roots.some((folder) => folder.id === workspace.currentStageId);
              return {
                ...workspace,
                doneStageIds: workspace.doneStageIds ?? [],
                currentStageId: currentOk ? workspace.currentStageId : roots[0]?.id,
              };
            }),
          };
        }
        if (version < 9) {
          state = {
            ...state,
            shellMenu: state.shellMenu !== false,
            workspaces: state.workspaces.map((workspace) => ({
              ...workspace,
              progress: typeof workspace.progress === "string" ? clampProgress(workspace.progress) : workspace.progress,
              stageNotes: Array.isArray(workspace.stageNotes) ? workspace.stageNotes : [],
              ingestMode:
                workspace.ingestMode === "move" || workspace.ingestMode === "link" || workspace.ingestMode === "copy"
                  ? workspace.ingestMode
                  : undefined,
            })),
            files: state.files.map((file) => ({
              ...file,
              note: typeof file.note === "string" ? clampLine(file.note) : file.note,
            })),
          };
        }
        if (version < 10) {
          const now = Date.now();
          const samples: ZoneFile[] = [
            {
              id: "f-logo-v1",
              workspaceId: "ws-brand",
              folderId: "br-mark",
              folderLocked: false,
              kind: "model",
              role: "wip",
              name: "logo-v1.3dm",
              size: 1_100_000,
              tags: [],
              pinned: false,
              createdAt: now - 1000 * 60 * 80,
              modifiedAt: now - 1000 * 60 * 80,
            },
            {
              id: "f-logo-v2",
              workspaceId: "ws-brand",
              folderId: "br-mark",
              folderLocked: false,
              kind: "model",
              role: "wip",
              name: "logo-v2.3dm",
              size: 1_240_000,
              tags: [],
              pinned: false,
              createdAt: now - 1000 * 60 * 40,
              modifiedAt: now - 1000 * 60 * 40,
            },
            {
              id: "f-logo-final",
              workspaceId: "ws-brand",
              folderId: "br-mark",
              folderLocked: false,
              kind: "model",
              role: "wip",
              name: "logo-final.3dm",
              size: 1_360_000,
              tags: [],
              pinned: false,
              createdAt: now - 1000 * 60 * 8,
              modifiedAt: now - 1000 * 60 * 8,
            },
            {
              id: "f-logo-rhl",
              workspaceId: "ws-brand",
              folderId: "br-mark",
              folderLocked: false,
              kind: "model",
              role: "wip",
              name: "logo-final.3dm.rhl",
              size: 48_000,
              tags: [],
              pinned: false,
              createdAt: now - 1000 * 60 * 7,
              modifiedAt: now - 1000 * 60 * 7,
            },
          ];
          const present = new Set(state.files.map((file) => file.id));
          state = {
            ...state,
            files: [...samples.filter((file) => !present.has(file.id) && state.workspaces.some((workspace) => workspace.id === "ws-brand")), ...state.files],
          };
        }
        if (version < 11) {
          // KeyShot / V-Ray scenes were auto-filed under 建模; move the ones the user never placed by hand.
          const scenes = state.files.filter((file) => !file.folderLocked && stageOverrideForName(file.name));
          if (scenes.length > 0) {
            const moved = new Map(
              state.workspaces.reduce((files, workspace) => retarget(files, workspace), scenes).map((file) => [file.id, file]),
            );
            state = { ...state, files: state.files.map((file) => moved.get(file.id) ?? file) };
          }
        }
        return state;
      },
      partialize: (s) => ({
        workspaces: s.workspaces,
        activeWorkspaceId: s.activeWorkspaceId,
        files: s.files,
        clips: s.clips,
        capturePaused: s.capturePaused,
        ignoredApps: s.ignoredApps,
        panel: s.panel,
        collapsed: s.collapsed,
        dock: s.dock,
        shellMenu: s.shellMenu,
      }),
    },
  ),
);

export function clipResultMessage(result: ClipResult, kind?: ClipKind): string {
  if (result === "sensitive") return "这条看起来像密钥或卡号，没有留下。";
  if (result === "empty") return "没有可留下的内容。";
  if (result === "duplicate") return "已经在剪贴板里，时间更新了。";
  if (kind === "color") return "色值已留下。";
  if (kind === "link") return "链接已留下。";
  if (kind === "image") return "图片已留下。";
  return "文案已留下。";
}
