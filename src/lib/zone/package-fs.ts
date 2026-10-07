import { recallFile, rememberFile } from "@/components/zone/session-files";
import { makeThumb } from "@/lib/zone/thumb";
import { placeFile, type ZoneFile } from "./model.ts";
import {
  dirPrefix,
  encodeManifest,
  externalRows,
  isAbsolutePath,
  lockBlocks,
  manifestFromState,
  newManifest,
  packFit,
  parseManifest,
  readTree,
  recoverManifest,
  safeFileName,
  stateFromManifest,
  unzipTree,
  zipTree,
  type DirTree,
  type LockFile,
  type PackRow,
} from "./package.ts";
import { useZone } from "./store.ts";
import { fileSize, isDesktop, readFileChunk, trashPaths } from "./desktop.ts";
import {
  backupLabel,
  backupOrder,
  backupStamp,
  dailyBackupName,
  isDailyBackup,
  pruneBackupNames,
} from "./versions.ts";

type Writable = { write(data: BufferSource | Blob | string): Promise<void>; close(): Promise<void>; abort?(): Promise<void> };

interface FsFile {
  kind?: string;
  getFile(): Promise<File>;
  createWritable(): Promise<Writable>;
  move?(name: string): Promise<void>;
}

interface FsDir {
  kind?: string;
  name: string;
  entries(): AsyncIterable<[string, FsDir | FsFile]>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDir>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFile>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  requestPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  move?(name: string): Promise<void>;
}

type Session = {
  root: FsDir;
  mode: "folder" | "browser";
  lockId: string;
  readonly: boolean;
  workspaceId: string;
  packageId: string;
};

const RECENT_KEY = "za-package-recent";
let session: Session | null = null;
let lastJson = "";
let saveTimer = 0;
let watchTimer = 0;
let heartTimer = 0;

export type RecentPackage = { id: string; name: string; mode: "folder" | "browser"; at: number };

export function packageSession(): { mode: "folder" | "browser"; readonly: boolean; packageId: string } | null {
  if (!session) return null;
  return { mode: session.mode, readonly: session.readonly, packageId: session.packageId };
}

export function recentPackages(): RecentPackage[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as RecentPackage[]) : [];
    return list.sort((a, b) => b.at - a.at).slice(0, 8);
  } catch {
    return [];
  }
}

function rememberRecent(item: RecentPackage) {
  const next = [item, ...recentPackages().filter((row) => row.id !== item.id)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("za-packages", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveHandle(id: string, root: FsDir) {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(root, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadHandle(id: string): Promise<FsDir | null> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("handles", "readonly");
    const request = tx.objectStore("handles").get(id);
    request.onsuccess = () => resolve((request.result as FsDir | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function pickParent(): Promise<FsDir> {
  const show = (window as unknown as { showDirectoryPicker?: (opts?: { mode?: string }) => Promise<FsDir> }).showDirectoryPicker;
  if (!show) throw new Error("no-picker");
  return show({ mode: "readwrite" });
}

async function browserRoot(id: string): Promise<FsDir> {
  const root = await navigator.storage.getDirectory();
  const packages = await root.getDirectoryHandle("za-packages", { create: true });
  return (await packages.getDirectoryHandle(id, { create: true })) as unknown as FsDir;
}

async function writeAt(root: FsDir, relative: string, data: Blob | Uint8Array) {
  const parts = relative.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) return;
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  const body = data instanceof Uint8Array ? new Uint8Array(data) : data;
  await writable.write(body);
  await writable.close();
}

async function readAt(root: FsDir, relative: string): Promise<File | null> {
  const parts = relative.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) return null;
  try {
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle(fileName);
    return handle.getFile();
  } catch {
    return null;
  }
}

async function removeAt(root: FsDir, relative: string) {
  const parts = relative.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) return;
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part);
  await dir.removeEntry(fileName);
}

async function listFiles(root: FsDir, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const [name, handle] of root.entries()) {
    if (name.startsWith(".")) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "file" || !("entries" in handle)) {
      if (name === "workzone.json" || name === "workzone.json.bak" || name === "workzone.lock" || name.endsWith(".tmp")) continue;
      out.push(path);
    } else {
      out.push(...(await listFiles(handle as FsDir, path)));
    }
  }
  return out;
}

async function ensureStageDirs(root: FsDir, names: string[]) {
  for (const name of names) await root.getDirectoryHandle(name, { create: true });
}

async function writeJson(root: FsDir, json: string, backup: string | null) {
  await keepRollingBackup(root);
  if (backup != null) await writeAt(root, "workzone.json.bak", new TextEncoder().encode(backup));
  const tmp = await root.getFileHandle("workzone.json.tmp", { create: true });
  const writable = await tmp.createWritable();
  await writable.write(json);
  await writable.close();
  if (tmp.move) {
    await tmp.move("workzone.json");
    return;
  }
  await writeAt(root, "workzone.json", new TextEncoder().encode(json));
  await root.removeEntry("workzone.json.tmp").catch(() => undefined);
}

async function readLock(root: FsDir): Promise<LockFile | null> {
  const file = await readAt(root, "workzone.lock");
  if (!file) return null;
  try {
    return JSON.parse(await file.text()) as LockFile;
  } catch {
    return null;
  }
}

async function writeLock(root: FsDir, lockId: string) {
  await writeAt(root, "workzone.lock", new TextEncoder().encode(JSON.stringify({ id: lockId, at: Date.now() })));
}

function stopTimers() {
  window.clearInterval(watchTimer);
  window.clearInterval(heartTimer);
  window.clearTimeout(saveTimer);
}

async function releaseLock() {
  if (!session || session.readonly) return;
  try {
    await session.root.removeEntry("workzone.lock");
  } catch {
    // already gone
  }
}

let saving: Promise<void> = Promise.resolve();

/** 存清单一次只跑一个：自动保存和放文件同时存，会互相读到换到一半的 workzone.json。 */
function saveNow(): Promise<void> {
  const run = saving.then(saveOnce, saveOnce);
  saving = run.catch(() => undefined);
  return run;
}

async function saveOnce() {
  if (!session || session.readonly) return;
  const state = useZone.getState();
  const workspace = state.workspaces.find((item) => item.id === session?.workspaceId);
  if (!workspace?.packageId) return;
  const manifest = manifestFromState(workspace, state.files, state.clips);
  const json = new TextDecoder().decode(encodeManifest(manifest));
  if (json === lastJson) return;
  await writeJson(session.root, json, null);
  lastJson = json;
}

function saveSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void saveNow();
  }, 400);
}

async function syncFromDisk() {
  if (!session || session.readonly) return;
  const paths = new Set(await listFiles(session.root));
  const state = useZone.getState();
  const mine = state.files.filter((file) => file.workspaceId === session?.workspaceId);
  const missing = mine
    .filter((file) => !file.external && file.path && !paths.has(file.path) && !file.path.endsWith("/.keep") && !file.stale)
    .map((file) => file.id);
  if (missing.length > 0) state.markMissing(missing);
  const back = mine.filter((file) => file.stale && !file.external && file.path && paths.has(file.path)).map((file) => file.id);
  if (back.length > 0) state.markPresent(back);
  const known = new Set(mine.map((file) => file.path).filter(Boolean));
  const workspace = state.workspaces.find((item) => item.id === session?.workspaceId);
  const dismissed = new Set(workspace?.dismissedPaths ?? []);
  for (const path of paths) {
    if (known.has(path) || dismissed.has(path) || path.endsWith("/.keep")) continue;
    const name = path.split("/").pop() || path;
    const file = await readAt(session.root, path);
    if (!file || !workspace) continue;
    const placed = placeFile({ name, path, folders: workspace.folders, rules: workspace.rules });
    const added = state.addFile({
      name,
      path,
      size: file.size,
      modifiedAt: file.lastModified,
      folderId: placed.folderId,
      keepUnlocked: false,
      workspaceId: session.workspaceId,
    });
    if (added.fileId) rememberFile(added.fileId, file);
  }
}

async function listBackupNames(root: FsDir): Promise<string[]> {
  try {
    const zone = await root.getDirectoryHandle(".workzone");
    const backups = await zone.getDirectoryHandle("backups");
    const names: string[] = [];
    for await (const [name, handle] of backups.entries()) {
      if (handle.kind === "file" || !("entries" in handle)) names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

async function pruneBackups(root: FsDir) {
  const names = await listBackupNames(root);
  for (const name of pruneBackupNames(names)) {
    await removeAt(root, `.workzone/backups/${name}`).catch(() => undefined);
  }
}

async function keepRollingBackup(root: FsDir) {
  const current = await readAt(root, "workzone.json");
  if (!current) return;
  const raw = await current.text();
  if (!raw.trim()) return;
  try {
    parseManifest(raw);
  } catch {
    return;
  }
  await writeAt(root, `.workzone/backups/${backupStamp(new Date())}.json`, new TextEncoder().encode(raw));
  await pruneBackups(root);
}

async function ensureDailyBackup(root: FsDir) {
  const name = dailyBackupName(new Date());
  if (await readAt(root, `.workzone/backups/${name}`)) return;
  const current = await readAt(root, "workzone.json");
  if (!current) return;
  const raw = await current.text();
  try {
    parseManifest(raw);
  } catch {
    return;
  }
  await writeAt(root, `.workzone/backups/${name}`, new TextEncoder().encode(raw));
  await pruneBackups(root);
}

async function readBackups(root: FsDir): Promise<{ name: string; raw: string }[]> {
  const names = backupOrder(await listBackupNames(root));
  const backups: { name: string; raw: string }[] = [];
  for (const name of names) {
    const file = await readAt(root, `.workzone/backups/${name}`);
    if (file) backups.push({ name, raw: await file.text() });
  }
  const legacy = await readAt(root, "workzone.json.bak");
  if (legacy) backups.push({ name: "workzone.json.bak", raw: await legacy.text() });
  return backups;
}

async function adoptRoot(root: FsDir, mode: "folder" | "browser"): Promise<string> {
  const file = await readAt(root, "workzone.json");
  if (!file) throw new Error("这不是项目包。");
  const raw = await file.text();
  let recoveredFrom: string | null = null;
  let parsed: ReturnType<typeof parseManifest>;
  try {
    parsed = parseManifest(raw);
  } catch (error) {
    if (error instanceof Error && error.message.includes("更新的格式")) throw error;
    const recovered = recoverManifest(raw, await readBackups(root));
    parsed = recovered;
    recoveredFrom = recovered.recoveredFrom;
  }
  const disk = new Set(await listFiles(root));
  const state = stateFromManifest(parsed.manifest, disk);
  const lockId = session?.lockId ?? crypto.randomUUID();
  const existing = await readLock(root);
  const readonly = lockBlocks(existing, lockId, Date.now());
  stopTimers();
  session = { root, mode, lockId, readonly, workspaceId: state.workspace.id, packageId: parsed.manifest.id };
  lastJson = !recoveredFrom && !parsed.migrated ? (raw.trim().endsWith("\n") ? raw : `${raw}\n`) : "";
  useZone.getState().adoptPackage(state);
  rememberRecent({ id: parsed.manifest.id, name: parsed.manifest.name, mode, at: Date.now() });
  if (mode === "folder") await saveHandle(parsed.manifest.id, root);
  if (readonly) return `${parsed.manifest.name} 已在另一个窗口打开，这次只能看。`;
  if (parsed.migrated || recoveredFrom) {
    const json = new TextDecoder().decode(encodeManifest(parsed.manifest));
    await writeJson(root, json, parsed.migrated ? raw : null);
    lastJson = json;
  }
  await ensureStageDirs(
    root,
    parsed.manifest.folders.filter((folder) => folder.parentId == null).map((folder) => folder.name),
  );
  await ensureDailyBackup(root);
  await writeLock(root, lockId);
  heartTimer = window.setInterval(() => {
    if (session) void writeLock(session.root, session.lockId);
  }, 5000);
  watchTimer = window.setInterval(() => {
    void syncFromDisk();
  }, 3000);
  if (recoveredFrom) return `${parsed.manifest.name} 的清单损坏了，已用${recoveredFrom}恢复。`;
  return parsed.migrated ? `${parsed.manifest.name} 已打开，旧清单已备份。` : `${parsed.manifest.name} 已打开。`;
}

export function bindPackageAutosave(): () => void {
  const unsub = useZone.subscribe(() => saveSoon());
  const hide = () => {
    void releaseLock();
  };
  window.addEventListener("pagehide", hide);
  return () => {
    unsub();
    window.removeEventListener("pagehide", hide);
    void releaseLock();
    stopTimers();
    session = null;
  };
}

export async function createProjectPackage(name: string): Promise<string> {
  const manifest = newManifest(name);
  let root: FsDir;
  let mode: "folder" | "browser" = "folder";
  let where = "已在所选位置建好项目包。";
  try {
    const parent = await pickParent();
    root = await parent.getDirectoryHandle(manifest.name, { create: true });
    if (await readAt(root, "workzone.json")) throw new Error("这个位置已经有同名项目包。换一个名字。");
  } catch (error) {
    if (error instanceof Error && error.message.includes("同名")) throw error;
    const aborted = error instanceof DOMException && error.name === "AbortError";
    if (aborted) throw new Error("没有选择存放位置。");
    root = await browserRoot(manifest.id);
    mode = "browser";
    where = "这个预览选不了电脑文件夹，项目包先放在浏览器里。导出 zip 可以拷走，再拖回来打开。";
  }
  await ensureStageDirs(root, manifest.folders.map((folder) => folder.name));
  await writeJson(root, new TextDecoder().decode(encodeManifest(manifest)), null);
  const message = await adoptRoot(root, mode);
  return `${message} ${where}`;
}

export async function openProjectPackage(): Promise<string> {
  try {
    const root = await pickParent();
    return adoptRoot(root, "folder");
  } catch (error) {
    if (error instanceof Error && (error.message === "这不是项目包。" || error.message.includes("更新的格式"))) throw error;
    const aborted = error instanceof DOMException && error.name === "AbortError";
    if (aborted) throw new Error("没有选中项目包。");
    throw new Error("没有选中项目包。也可以把文件夹或 zip 拖进窗口。");
  }
}

export async function openRecentPackage(id: string): Promise<string> {
  const recent = recentPackages().find((item) => item.id === id);
  if (recent?.mode === "browser") return adoptRoot(await browserRoot(id), "browser");
  const handle = await loadHandle(id);
  if (!handle) throw new Error("找不到上次的文件夹，请重新打开项目包。");
  const permission = await handle.requestPermission?.({ mode: "readwrite" });
  if (permission && permission !== "granted") throw new Error("没有获得这个文件夹的写入许可。");
  return adoptRoot(handle, "folder");
}

async function importTree(tree: DirTree): Promise<string> {
  const opened = readTree(tree);
  const root = await browserRoot(opened.manifest.id);
  for (const [path, bytes] of tree) {
    if (!path || path.endsWith("/")) continue;
    await writeAt(root, path, bytes);
  }
  return adoptRoot(root, "browser");
}

export async function openZipFile(file: File): Promise<string> {
  let tree: DirTree;
  try {
    tree = unzipTree(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    if (error instanceof Error && error.message.includes("压缩")) throw error;
    throw new Error("这不是项目包。");
  }
  if (!tree.has("workzone.json")) throw new Error("这不是项目包。");
  return importTree(tree);
}

export async function openDroppedTransfer(data: DataTransfer | null): Promise<string | null> {
  if (!data) return null;
  const files = [...data.files];
  const zip = files.find((file) => file.name.toLowerCase().endsWith(".zip"));
  if (zip && files.length === 1) {
    try {
      const tree = unzipTree(new Uint8Array(await zip.arrayBuffer()));
      if (!tree.has("workzone.json")) return null;
      return await importTree(tree);
    } catch (error) {
      if (error instanceof Error && (error.message === "这不是项目包。" || error.message.includes("格式"))) throw error;
      return null;
    }
  }
  const json = files.find((file) => file.name === "workzone.json");
  if (json && files.every((file) => file.webkitRelativePath || file.name === "workzone.json")) {
    const tree: DirTree = new Map();
    for (const file of files) {
      const path = file.webkitRelativePath ? file.webkitRelativePath.split("/").slice(1).join("/") : file.name;
      if (!path) continue;
      tree.set(path, new Uint8Array(await file.arrayBuffer()));
    }
    if (!tree.has("workzone.json") && json) tree.set("workzone.json", new Uint8Array(await json.arrayBuffer()));
    return importTree(tree);
  }
  return null;
}

export async function ingestIntoPackage(files: File[], mode: "copy" | "move" | "link", shelfId: string | null): Promise<string> {
  if (!session) return "还没有打开项目包。";
  if (session.readonly) return "这个项目包正在另一个窗口里编辑。";
  let copied = 0;
  let linked = 0;
  let big = 0;
  for (const file of files) {
    const state = useZone.getState();
    const workspace = state.workspaces.find((item) => item.id === session?.workspaceId);
    if (!workspace) return "还没有打开项目包。";
    if ((file.size ?? 0) > 500 * 1024 * 1024) big += 1;
    if (mode === "link") {
      const placed = placeFile({
        name: file.name,
        folders: workspace.folders,
        rules: workspace.rules,
        chosenId: shelfId,
      });
      const added = state.addFile({
        name: file.name,
        size: file.size,
        modifiedAt: file.lastModified,
        external: true,
        path: file.webkitRelativePath || file.name,
        keepUnlocked: false,
        folderId: placed.folderId,
        workspaceId: session.workspaceId,
      });
      if (added.fileId) rememberFile(added.fileId, file);
      linked += 1;
      continue;
    }
    const placed = placeFile({
      name: file.name,
      folders: workspace.folders,
      rules: workspace.rules,
      chosenId: shelfId,
    });
    const names = state.files.filter((item) => item.folderId === placed.folderId).map((item) => item.name);
    const name = safeFileName(file.name, names);
    const relative = `${dirPrefix(workspace.folders, placed.folderId)}/${name}`;
    const made = file.type.startsWith("image/") ? await makeThumb(file) : undefined;
    await writeAt(session.root, relative, file);
    const added = state.addFile({
      name,
      size: file.size,
      modifiedAt: file.lastModified,
      path: relative,
      thumb: made?.thumb,
      dominant: made?.dominant,
      folderId: placed.folderId,
      keepUnlocked: false,
      external: false,
      workspaceId: session.workspaceId,
    });
    if (added.fileId) rememberFile(added.fileId, file);
    copied += 1;
  }
  await saveNow();
  const huge = big > 0 ? ` 其中 ${big} 个超过 500 MB。` : "";
  if (mode === "move") return `已复制 ${copied} 个进项目包。浏览器不能删除你电脑上的原文件。${huge}`;
  if (mode === "link") return `记下 ${linked} 个外部引用。${huge}`;
  return `已复制 ${copied} 个进项目包。${huge}`;
}

const CHUNK = 4 * 1024 * 1024;

async function exists(root: FsDir, relative: string): Promise<boolean> {
  return (await readAt(root, relative)) != null;
}

/** 边读边写：把磁盘上的文件分块流进项目包，不把整个大文件读进内存；写完核对大小，不对就撤销。 */
async function streamIntoPackage(root: FsDir, relative: string, sourcePath: string, expected: number): Promise<number> {
  const parts = relative.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error("文件名是空的。");
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  let written = 0;
  try {
    for (;;) {
      const bytes = await readFileChunk(sourcePath, written, CHUNK);
      if (bytes.length === 0) break;
      await writable.write(new Uint8Array(bytes));
      written += bytes.length;
      if (bytes.length < CHUNK) break;
    }
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => undefined);
    await dir.removeEntry(fileName).catch(() => undefined);
    throw error;
  }
  const stored = (await handle.getFile()).size;
  if (stored !== written || (expected > 0 && written !== expected)) {
    await dir.removeEntry(fileName).catch(() => undefined);
    throw new Error("复制后大小对不上，已撤销。");
  }
  return written;
}

/** 桌面端：把磁盘上的真实文件复制进打开的项目包（按归类放进阶段子文件夹），记录指向包里的新位置。 */
export async function storeFromDisk(input: {
  name: string;
  sourcePath: string;
  size?: number;
  shelfId?: string | null;
}): Promise<{ fileId: string | null; message: string; name: string; relative: string }> {
  const none = (message: string) => ({ fileId: null, message, name: input.name, relative: "" });
  if (!session) return none("还没有打开项目包。");
  if (session.readonly) return none("这个项目包正在另一个窗口里编辑。");
  const state = useZone.getState();
  const workspace = state.workspaces.find((item) => item.id === session?.workspaceId);
  if (!workspace) return none("还没有打开项目包。");
  const placed = placeFile({
    name: input.name,
    path: input.sourcePath,
    folders: workspace.folders,
    rules: workspace.rules,
    chosenId: input.shelfId ?? null,
  });
  const prefix = dirPrefix(workspace.folders, placed.folderId);
  const taken = state.files.filter((item) => item.folderId === placed.folderId).map((item) => item.name);
  let name = safeFileName(input.name, taken);
  while (await exists(session.root, `${prefix}/${name}`)) {
    taken.push(name);
    name = safeFileName(input.name, taken);
  }
  const relative = `${prefix}/${name}`;
  const expected = input.size ?? (await fileSize(input.sourcePath)) ?? 0;
  const written = await streamIntoPackage(session.root, relative, input.sourcePath, expected);
  const added = state.addFile({
    name,
    size: written,
    path: relative,
    sourcePath: input.sourcePath,
    external: false,
    folderId: input.shelfId ?? placed.folderId,
    keepUnlocked: !input.shelfId,
    workspaceId: session.workspaceId,
  });
  // 清单稍后会由自动保存补上；这里失败不该让一个已经放好的文件被说成“没放进来”。
  await saveNow().catch(() => undefined);
  return { ...added, name, relative };
}

export async function renamePackedFolder(folderId: string, oldName: string, newName: string): Promise<boolean> {
  if (!session || session.readonly) return true;
  const workspace = useZone.getState().workspaces.find((item) => item.id === session?.workspaceId);
  if (!workspace?.packageId) return true;
  const folder = workspace.folders.find((item) => item.id === folderId);
  if (!folder) return true;
  try {
    const parentPath = folder.parentId ? dirPrefix(workspace.folders, folder.parentId) : "";
    const parent = parentPath ? await walkDir(session.root, parentPath) : session.root;
    const handle = await parent.getDirectoryHandle(oldName);
    if (!handle.move) return false;
    await handle.move(newName);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return true;
    return false;
  }
}

export async function ensurePackedFolder(parentId: string | null, name: string): Promise<void> {
  if (!session || session.readonly) return;
  const title = name.trim();
  if (!title) return;
  const workspace = useZone.getState().workspaces.find((item) => item.id === session?.workspaceId);
  if (!workspace?.packageId) return;
  try {
    const parent = parentId ? await walkDir(session.root, dirPrefix(workspace.folders, parentId)) : session.root;
    await parent.getDirectoryHandle(title, { create: true });
  } catch {
    // the tree still shows the folder
  }
}

export async function deletePackedFolder(folderId: string): Promise<boolean> {
  return trashPackedFolder(folderId);
}

async function copyHandleTree(root: FsDir, source: FsDir, dest: string) {
  for await (const [name, handle] of source.entries()) {
    const path = `${dest}/${name}`;
    if (handle.kind === "file" || !("entries" in handle)) {
      const file = await (handle as FsFile).getFile();
      await writeAt(root, path, new Uint8Array(await file.arrayBuffer()));
    } else {
      await copyHandleTree(root, handle as FsDir, path);
    }
  }
}

export async function trashPackedFolder(folderId: string): Promise<boolean> {
  if (!session || session.readonly) return true;
  const workspace = useZone.getState().workspaces.find((item) => item.id === session?.workspaceId);
  if (!workspace?.packageId) return true;
  const prefix = dirPrefix(workspace.folders, folderId);
  if (!prefix) return true;
  const parts = prefix.split("/").filter(Boolean);
  const name = parts.pop();
  if (!name) return true;
  try {
    const parent = parts.length > 0 ? await walkDir(session.root, parts.join("/")) : session.root;
    let source: FsDir;
    try {
      source = await parent.getDirectoryHandle(name);
    } catch {
      return true;
    }
    await copyHandleTree(session.root, source, `.workzone/trash/${backupStamp(new Date())}/${prefix}`);
    await parent.removeEntry(name, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

async function holdRelative(path: string): Promise<boolean> {
  if (!session) return false;
  const file = await readAt(session.root, path);
  if (!file) return false;
  await writeAt(session.root, `.workzone/trash/${backupStamp(new Date())}/${path}`, new Uint8Array(await file.arrayBuffer()));
  await removeAt(session.root, path);
  return true;
}

export async function releaseRecords(files: ZoneFile[], alsoTrash: boolean): Promise<{ gone: boolean; message: string }> {
  if (!alsoTrash) return { gone: true, message: "只去掉了记录，文件还在原来的位置。" };
  const absolute = [
    ...new Set(
      files
        .map((file) => (file.path && isAbsolutePath(file.path) ? file.path : ""))
        .filter(Boolean),
    ),
  ];
  const relative = [
    ...new Set(files.map((file) => (file.path && !file.external && !isAbsolutePath(file.path) ? file.path : "")).filter(Boolean)),
  ];
  if (absolute.length === 0 && relative.length === 0) {
    return { gone: true, message: "只去掉了记录，这些文件没有留在磁盘上的原件。" };
  }
  let recycled = 0;
  let blocked = 0;
  if (absolute.length > 0) {
    if (isDesktop()) {
      try {
        recycled = await trashPaths(absolute);
        if (recycled < absolute.length) blocked += absolute.length - recycled;
      } catch {
        blocked += absolute.length;
      }
    } else {
      blocked += absolute.length;
    }
  }
  let held = 0;
  if (session && !session.readonly) {
    for (const path of relative) {
      try {
        if (await holdRelative(path)) held += 1;
      } catch {
        blocked += 1;
      }
    }
  }
  if (recycled === 0 && held === 0) {
    return { gone: false, message: "没有放进回收站，记录还留着。可以从备份恢复清单。" };
  }
  if (recycled > 0 && held === 0 && blocked === 0) return { gone: true, message: "已移到回收站，可以从回收站恢复。" };
  if (held > 0 && blocked === 0) {
    return { gone: true, message: "没有永久删除。文件放进了项目包的回收暂存，可以从备份恢复清单；在 Windows 上，外部文件会进系统回收站。" };
  }
  return { gone: true, message: "能保护的文件已经移走，没有永久删除。可以从回收站或项目包的回收暂存里找回。" };
}

export type BackupRow = { name: string; label: string; daily: boolean };

export async function listPackageBackups(): Promise<BackupRow[]> {
  if (!session) return [];
  const names = backupOrder(await listBackupNames(session.root));
  if (await readAt(session.root, "workzone.json.bak")) names.push("workzone.json.bak");
  return names.map((name) => ({ name, label: backupLabel(name), daily: isDailyBackup(name) }));
}

export async function restorePackageBackup(name: string): Promise<string> {
  if (!session || session.readonly) return "现在不能改这个项目包。";
  await saveNow();
  await keepRollingBackup(session.root);
  const file = await readAt(session.root, name === "workzone.json.bak" ? name : `.workzone/backups/${name}`);
  if (!file) return "这份备份已经不在了。";
  const recovered = recoverManifest("{}", [{ name, raw: await file.text() }]);
  const disk = new Set(await listFiles(session.root));
  const state = stateFromManifest(recovered.manifest, disk);
  useZone.getState().adoptPackage(state);
  lastJson = "";
  await saveNow();
  return `已恢复到${recovered.recoveredFrom ?? backupLabel(name)}。恢复前的清单也留了一份。`;
}

export async function relinkIntoPackage(fileId: string, file: File): Promise<string | null> {
  if (!session) return null;
  if (session.readonly) return "这个项目包正在另一个窗口里编辑。";
  const state = useZone.getState();
  const existing = state.files.find((item) => item.id === fileId);
  const workspace = state.workspaces.find((item) => item.id === session?.workspaceId);
  if (!existing || !workspace || existing.workspaceId !== workspace.id) return null;
  const placed = placeFile({
    name: file.name,
    folders: workspace.folders,
    rules: workspace.rules,
    chosenId: existing.folderLocked ? existing.folderId : null,
  });
  const folderId = existing.folderLocked ? existing.folderId : placed.folderId;
  const names = state.files.filter((item) => item.folderId === folderId && item.id !== fileId).map((item) => item.name);
  const safe = safeFileName(file.name, names);
  const relative = `${dirPrefix(workspace.folders, folderId)}/${safe}`;
  const made = file.type.startsWith("image/") ? await makeThumb(file) : undefined;
  await writeAt(session.root, relative, file);
  if (existing.path && !existing.external && existing.path !== relative) {
    await removeAt(session.root, existing.path).catch(() => undefined);
  }
  state.relinkFile(fileId, {
    name: safe,
    size: file.size,
    path: relative,
    thumb: made?.thumb ?? existing.thumb,
    dominant: made?.dominant ?? existing.dominant,
    external: false,
    modifiedAt: file.lastModified,
  });
  rememberFile(fileId, file);
  await saveNow();
  return `${safe} 已放回项目包。`;
}

async function walkDir(root: FsDir, path: string): Promise<FsDir> {
  let dir = root;
  for (const part of path.split("/").filter(Boolean)) dir = await dir.getDirectoryHandle(part);
  return dir;
}

export async function deletePackedFile(path: string | undefined, external?: boolean) {
  if (!session || !path || external || isAbsolutePath(path)) return;
  try {
    await holdRelative(path);
  } catch {
    // already gone
  }
}

export async function readPackedBlob(path: string | undefined, external?: boolean): Promise<Blob | null> {
  if (!session || !path || external) return null;
  return readAt(session.root, path);
}

export function currentExternalRows(): PackRow[] {
  if (!session) return [];
  const state = useZone.getState();
  return externalRows(state.files.filter((file) => file.workspaceId === session?.workspaceId));
}

export async function freeSpace(): Promise<number | null> {
  try {
    const estimate = await navigator.storage.estimate();
    if (estimate.quota == null || estimate.usage == null) return null;
    return Math.max(0, estimate.quota - estimate.usage);
  } catch {
    return null;
  }
}

export function fitSelected(rows: PackRow[], selected: string[], free: number | null) {
  return packFit(rows, selected, free);
}

export async function packExternal(ids: string[]): Promise<string> {
  if (!session || session.readonly) return "现在不能写入项目包。";
  const rows = currentExternalRows();
  const free = await freeSpace();
  const fit = packFit(rows, ids, free);
  if (fit.short) return "空间不够，没有复制。";
  let copied = 0;
  let big = 0;
  let skipped = 0;
  for (const row of rows.filter((item) => ids.includes(item.id))) {
    const held = recallFile(row.id);
    if (!held || row.missing) {
      skipped += 1;
      continue;
    }
    if (row.big) big += 1;
    const state = useZone.getState();
    const file = state.files.find((item) => item.id === row.id);
    const workspace = state.workspaces.find((item) => item.id === session?.workspaceId);
    if (!file || !workspace) {
      skipped += 1;
      continue;
    }
    const placed = placeFile({
      name: file.name,
      folders: workspace.folders,
      rules: workspace.rules,
      chosenId: file.folderLocked ? file.folderId : null,
    });
    const folderId = file.folderLocked ? file.folderId : placed.folderId;
    const relative = `${dirPrefix(workspace.folders, folderId)}/${safeFileName(file.name, [])}`;
    await writeAt(session.root, relative, held);
    state.relinkFile(file.id, {
      name: file.name,
      size: held.size,
      path: relative,
      thumb: file.thumb,
      dominant: file.dominant,
      external: false,
    });
    rememberFile(file.id, held);
    copied += 1;
  }
  await saveNow();
  const huge = big > 0 ? ` 其中 ${big} 个超过 500 MB。` : "";
  const lost = skipped > 0 ? ` ${skipped} 个找不到，已跳过。` : "";
  return `已收进项目包 ${copied} 个。${lost}${huge}`;
}

export async function downloadPackageZip(): Promise<string> {
  if (!session) return "还没有打开项目包。";
  await saveNow();
  const paths = await listFiles(session.root);
  const tree: DirTree = new Map();
  const json = await readAt(session.root, "workzone.json");
  if (json) tree.set("workzone.json", new Uint8Array(await json.arrayBuffer()));
  for (const path of paths) {
    const file = await readAt(session.root, path);
    if (!file) continue;
    tree.set(path, new Uint8Array(await file.arrayBuffer()));
  }
  const zip = zipTree(tree);
  const name = useZone.getState().workspaces.find((item) => item.id === session?.workspaceId)?.name ?? "项目包";
  const blob = new Blob([new Uint8Array(zip)], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.zip`;
  link.click();
  URL.revokeObjectURL(url);
  return "项目包 zip 已下载。";
}

export async function archivePackage(archived: boolean): Promise<string> {
  if (!session || session.readonly) return "现在不能改这个项目包。";
  const state = useZone.getState();
  const workspace = state.workspaces.find((item) => item.id === session?.workspaceId);
  if (!workspace) return "还没有打开项目包。";
  state.adoptPackage({
    workspace: { ...workspace, archived },
    files: state.files.filter((file) => file.workspaceId === workspace.id),
    pinnedClips: state.clips.filter((clip) => clip.pinned),
  });
  await saveNow();
  return archived ? "项目已归档，之后仍可打开。" : "项目已重新打开。";
}

export async function importFolderFiles(files: File[]): Promise<string | null> {
  if (!files.some((file) => file.name === "workzone.json" || file.webkitRelativePath.endsWith("workzone.json"))) return null;
  const tree: DirTree = new Map();
  for (const file of files) {
    const relative = file.webkitRelativePath ? file.webkitRelativePath.split("/").slice(1).join("/") : file.name;
    if (!relative) continue;
    tree.set(relative, new Uint8Array(await file.arrayBuffer()));
  }
  return importTree(tree);
}
