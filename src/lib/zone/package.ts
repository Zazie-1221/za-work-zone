import { clampProgress, sanitizeBoards } from "./notes.ts";
import {
  folderPath,
  isSensitive,
  kindFromName,
  roleFromName,
  uid,
  type ClassRule,
  type Clip,
  type Folder,
  type IngestMode,
  type StageBoard,
  type Workspace,
  type ZoneFile,
} from "./model.ts";
import { backupLabel, backupOrder } from "./versions.ts";

export const PACKAGE_FORMAT = 2;
export const BIG_FILE = 500 * 1024 * 1024;

export const PACKAGE_STAGE_NAMES = ["01草图", "02建模", "03渲染", "04交付", "05参考"] as const;

export type PackageManifest = {
  format: number;
  id: string;
  name: string;
  archived: boolean;
  folders: Folder[];
  files: PackageFile[];
  rules: ClassRule[];
  pinnedClips: Clip[];
  currentStageId?: string;
  doneStageIds?: string[];
  progress?: string;
  stageNotes?: StageBoard[];
  ingestMode?: IngestMode;
  dismissedPaths?: string[];
};

export type PackageFile = {
  id: string;
  folderId: string;
  name: string;
  relativePath: string | null;
  absolutePath?: string;
  external: boolean;
  kind: ZoneFile["kind"];
  role: ZoneFile["role"];
  tags: string[];
  folderLocked: boolean;
  pinned: boolean;
  openedAt?: number;
  size?: number;
  thumb?: string;
  dominant?: string;
  note?: string;
  sourcePath?: string;
  modifiedAt?: number;
  versionGroup?: string;
  versionSolo?: boolean;
  versionCurrent?: boolean;
};

export type DirTree = Map<string, Uint8Array>;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function packageFolders(): Folder[] {
  return PACKAGE_STAGE_NAMES.map((name) => ({ id: uid(), parentId: null, name }));
}

export function newManifest(name: string): PackageManifest {
  const folders = packageFolders();
  return {
    format: PACKAGE_FORMAT,
    id: uid(),
    name: name.trim() || "未命名项目",
    archived: false,
    folders,
    files: [],
    rules: [],
    pinnedClips: [],
    currentStageId: folders[0]?.id,
    doneStageIds: [],
  };
}

export function dirPrefix(folders: Folder[], id: string): string {
  return folderPath(folders, id)
    .split(" / ")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

export function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
}

export function safeFileName(name: string, taken: string[]): string {
  const clean = name.replace(/[\\/]/g, "-").trim() || "未命名";
  if (!taken.includes(clean)) return clean;
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  let n = 2;
  while (taken.includes(`${stem}-${n}${ext}`)) n += 1;
  return `${stem}-${n}${ext}`;
}

export function fileFromZone(file: ZoneFile, folders: Folder[]): PackageFile {
  const absolute = file.external || (file.path ? isAbsolutePath(file.path) : false);
  const relative = absolute ? null : file.path && !isAbsolutePath(file.path) ? file.path : `${dirPrefix(folders, file.folderId)}/${file.name}`;
  return {
    id: file.id,
    folderId: file.folderId,
    name: file.name,
    relativePath: absolute ? null : relative,
    absolutePath: absolute ? file.path : undefined,
    external: absolute,
    kind: file.kind,
    role: file.role,
    tags: file.tags,
    folderLocked: file.folderLocked,
    pinned: file.pinned,
    openedAt: file.openedAt,
    size: file.size,
    thumb: file.thumb,
    dominant: file.dominant,
    note: file.note,
    sourcePath: file.sourcePath,
    modifiedAt: file.modifiedAt,
    versionGroup: file.versionGroup,
    versionSolo: file.versionSolo,
    versionCurrent: file.versionCurrent,
  };
}

export function manifestFromState(workspace: Workspace, files: ZoneFile[], clips: Clip[]): PackageManifest {
  const mine = files.filter((file) => file.workspaceId === workspace.id);
  return {
    format: PACKAGE_FORMAT,
    id: workspace.packageId || workspace.id.replace(/^pkg-/, ""),
    name: workspace.name,
    archived: workspace.archived ?? false,
    folders: workspace.folders,
    files: mine.map((file) => fileFromZone(file, workspace.folders)),
    rules: workspace.rules ?? [],
    pinnedClips: clips.filter((clip) => clip.pinned && !(clip.text && isSensitive(clip.text))),
    currentStageId: workspace.currentStageId,
    doneStageIds: workspace.doneStageIds ?? [],
    progress: workspace.progress,
    stageNotes: workspace.stageNotes ?? [],
    ingestMode: workspace.ingestMode,
    dismissedPaths: workspace.dismissedPaths ?? [],
  };
}

export function workspaceIdFor(manifest: PackageManifest): string {
  return `pkg-${manifest.id}`;
}

export function stateFromManifest(
  manifest: PackageManifest,
  present: Set<string>,
): { workspace: Workspace; files: ZoneFile[]; pinnedClips: Clip[] } {
  const workspaceId = workspaceIdFor(manifest);
  const workspace: Workspace = {
    id: workspaceId,
    name: manifest.name,
    folders: manifest.folders,
    rules: manifest.rules ?? [],
    currentStageId: manifest.currentStageId,
    doneStageIds: manifest.doneStageIds ?? [],
    packageId: manifest.id,
    archived: manifest.archived ?? false,
    progress: manifest.progress,
    stageNotes: manifest.stageNotes ?? [],
    ingestMode: manifest.ingestMode,
    dismissedPaths: manifest.dismissedPaths ?? [],
  };
  const files: ZoneFile[] = manifest.files.map((file) => {
    const missing = file.external ? false : !file.relativePath || !present.has(file.relativePath);
    return {
      id: file.id,
      workspaceId,
      folderId: file.folderId,
      folderLocked: file.folderLocked,
      kind: file.kind,
      role: file.role,
      name: file.name,
      size: file.size,
      thumb: file.thumb,
      dominant: file.dominant,
      stale: missing,
      path: file.external ? file.absolutePath : (file.relativePath ?? undefined),
      external: file.external,
      tags: file.tags ?? [],
      pinned: file.pinned,
      createdAt: file.openedAt ?? 0,
      openedAt: file.openedAt,
      note: file.note,
      sourcePath: file.sourcePath,
      modifiedAt: file.modifiedAt,
      versionGroup: file.versionGroup,
      versionSolo: file.versionSolo,
      versionCurrent: file.versionCurrent,
    };
  });
  return { workspace, files, pinnedClips: manifest.pinnedClips ?? [] };
}

export function parseManifest(raw: string): { manifest: PackageManifest; migrated: boolean } {
  const data = (() => {
    try {
      return JSON.parse(raw) as Partial<PackageManifest> & { format?: number };
    } catch {
      throw new Error("这不是项目包。");
    }
  })();
  if (data.format != null && data.format > PACKAGE_FORMAT) {
    throw new Error("这份项目包是更新的格式，当前打不开。");
  }
  const migrated = data.format !== PACKAGE_FORMAT;
  if (!data.name || !Array.isArray(data.folders)) throw new Error("这不是项目包。");
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    id: data.id || uid(),
    name: data.name,
    archived: data.archived ?? false,
    folders: data.folders,
    files: (data.files ?? []).map((file) => ({
      ...file,
      tags: file.tags ?? [],
      external: file.external ?? Boolean(file.absolutePath),
      relativePath: file.relativePath ?? null,
      modifiedAt: typeof file.modifiedAt === "number" ? file.modifiedAt : undefined,
      versionGroup: typeof file.versionGroup === "string" && file.versionGroup ? file.versionGroup : undefined,
      versionSolo: file.versionSolo === true ? true : undefined,
      versionCurrent: file.versionCurrent === true ? true : undefined,
    })),
    rules: data.rules ?? [],
    pinnedClips: (data.pinnedClips ?? []).filter((clip) => !(clip.text && isSensitive(clip.text))),
    currentStageId: data.currentStageId,
    doneStageIds: data.doneStageIds ?? [],
    progress: typeof data.progress === "string" ? clampProgress(data.progress) : undefined,
    stageNotes: sanitizeBoards(data.stageNotes),
    ingestMode: data.ingestMode === "move" || data.ingestMode === "link" || data.ingestMode === "copy" ? data.ingestMode : undefined,
    dismissedPaths: Array.isArray(data.dismissedPaths) ? data.dismissedPaths.filter((item) => typeof item === "string") : [],
  };
  return { manifest, migrated };
}

export function recoverManifest(
  primary: string | null,
  backups: { name: string; raw: string }[],
): { manifest: PackageManifest; migrated: boolean; recoveredFrom: string | null } {
  if (primary == null) throw new Error("这不是项目包。");
  if (primary.trim()) {
    try {
      const parsed = parseManifest(primary);
      return { ...parsed, recoveredFrom: null };
    } catch (error) {
      if (error instanceof Error && error.message.includes("更新的格式")) throw error;
    }
  }
  const byName = new Map(backups.map((item) => [item.name, item.raw]));
  for (const name of backupOrder(backups.map((item) => item.name))) {
    const raw = byName.get(name);
    if (!raw) continue;
    try {
      const parsed = parseManifest(raw);
      return { ...parsed, recoveredFrom: backupLabel(name) };
    } catch (error) {
      if (error instanceof Error && error.message.includes("更新的格式")) continue;
    }
  }
  throw new Error(primary.trim() ? "清单损坏，也没有可用的备份。" : "这不是项目包。");
}

export function writeAtomic(tree: DirTree, path: string, bytes: Uint8Array) {
  const temp = `${path}.tmp`;
  tree.set(temp, bytes);
  const saved = tree.get(temp);
  if (!saved) throw new Error("临时文件没有写上。");
  tree.set(path, saved);
  tree.delete(temp);
}

export function encodeManifest(manifest: PackageManifest): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

export function materialize(manifest: PackageManifest, blobs: Record<string, Uint8Array> = {}): DirTree {
  const tree: DirTree = new Map(Object.entries(blobs));
  for (const name of PACKAGE_STAGE_NAMES) {
    if (!tree.has(`${name}/.keep`) && manifest.folders.some((folder) => folder.name === name && folder.parentId == null)) {
      tree.set(`${name}/.keep`, new Uint8Array());
    }
  }
  writeAtomic(tree, "workzone.json", encodeManifest(manifest));
  return tree;
}

export function copyTree(tree: DirTree): DirTree {
  return new Map([...tree.entries()].map(([path, bytes]) => [path, new Uint8Array(bytes)]));
}

export function readTree(tree: DirTree): {
  manifest: PackageManifest;
  migrated: boolean;
  workspace: Workspace;
  files: ZoneFile[];
  pinnedClips: Clip[];
} {
  const rawBytes = tree.get("workzone.json");
  if (!rawBytes) throw new Error("这不是项目包。");
  const raw = textDecoder.decode(rawBytes);
  const parsed = parseManifest(raw);
  if (parsed.migrated) {
    tree.set("workzone.json.bak", rawBytes);
    writeAtomic(tree, "workzone.json", encodeManifest(parsed.manifest));
  }
  const present = new Set(tree.keys());
  const state = stateFromManifest(parsed.manifest, present);
  return { ...parsed, ...state };
}

export function placeCopiedFile(
  manifest: PackageManifest,
  input: { id?: string; name: string; folderId: string; size?: number; locked?: boolean },
): { manifest: PackageManifest; relativePath: string } {
  const taken = manifest.files.filter((file) => file.folderId === input.folderId).map((file) => file.name);
  const name = safeFileName(input.name, taken);
  const relativePath = `${dirPrefix(manifest.folders, input.folderId)}/${name}`;
  const entry: PackageFile = {
    id: input.id || uid(),
    folderId: input.folderId,
    name,
    relativePath,
    external: false,
    kind: kindFromName(name),
    role: roleFromName(name),
    tags: [],
    folderLocked: input.locked ?? false,
    pinned: false,
    size: input.size,
  };
  return { manifest: { ...manifest, files: [...manifest.files, entry] }, relativePath };
}

export function renameFolderInManifest(manifest: PackageManifest, folderId: string, newName: string): PackageManifest {
  const title = newName.trim();
  if (!title) return manifest;
  const oldPrefix = dirPrefix(manifest.folders, folderId);
  const folders = manifest.folders.map((folder) => (folder.id === folderId ? { ...folder, name: title } : folder));
  const newPrefix = dirPrefix(folders, folderId);
  if (!oldPrefix || oldPrefix === newPrefix) return { ...manifest, folders };
  const files = manifest.files.map((file) => {
    if (!file.relativePath || file.external) return file;
    if (file.relativePath === oldPrefix || file.relativePath.startsWith(`${oldPrefix}/`)) {
      const relativePath = `${newPrefix}${file.relativePath.slice(oldPrefix.length)}`;
      return { ...file, relativePath, name: relativePath.split("/").pop() || file.name };
    }
    return file;
  });
  return { ...manifest, folders, files };
}

export function includeInPackageZip(path: string): boolean {
  const parts = path.split("/");
  const base = parts[parts.length - 1] ?? path;
  if (parts.includes(".cache") || parts.includes(".workzone")) return false;
  if (base === "workzone.lock" || base === "workzone.json.tmp" || base === "workzone.json.bak") return false;
  if (base.endsWith(".tmp") || base === ".keep") return false;
  return true;
}

export type LockFile = { id: string; at: number };

export function lockBlocks(existing: LockFile | null, selfId: string, now: number, ttl = 15000): boolean {
  if (!existing || existing.id === selfId) return false;
  return now - existing.at < ttl;
}

export type PackRow = { id: string; name: string; size: number; where: string; missing: boolean; big: boolean };

export function externalRows(files: ZoneFile[]): PackRow[] {
  return files
    .filter((file) => file.external)
    .map((file) => ({
      id: file.id,
      name: file.name,
      size: file.size ?? 0,
      where: file.path || "没有原位置",
      missing: file.stale === true || !file.path,
      big: (file.size ?? 0) > BIG_FILE,
    }));
}

export function packFit(rows: PackRow[], selected: string[], freeBytes: number | null): { total: number; short: boolean } {
  const total = rows.filter((row) => selected.includes(row.id) && !row.missing).reduce((sum, row) => sum + row.size, 0);
  return { total, short: freeBytes != null && total > freeBytes };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date = new Date()): { time: number; day: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export function zipTree(tree: DirTree): Uint8Array {
  const entries = [...tree.entries()].filter(([path]) => includeInPackageZip(path) && !path.endsWith("/"));
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const stamp = dosTime();
  for (const [path, data] of entries) {
    const name = textEncoder.encode(path);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.day, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);
  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of locals) {
    out.set(part, cursor);
    cursor += part.length;
  }
  for (const part of centrals) {
    out.set(part, cursor);
    cursor += part.length;
  }
  out.set(end, cursor);
  return out;
}

export function unzipTree(zip: Uint8Array): DirTree {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const tree: DirTree = new Map();
  let offset = 0;
  while (offset + 30 <= zip.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extra = view.getUint16(offset + 28, true);
    const name = textDecoder.decode(zip.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extra;
    const data = zip.subarray(start, start + compressed);
    if (method !== 0) throw new Error("这个 zip 用了压缩，当前只打开未压缩的项目包。");
    if (name && !name.endsWith("/")) tree.set(name, new Uint8Array(data));
    offset = start + compressed;
  }
  return tree;
}
