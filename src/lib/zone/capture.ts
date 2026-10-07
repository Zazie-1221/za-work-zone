import { imageThumb, ingestFile, isDesktop, pickFolder, probePaths, removeUserFile, settleMove } from "@/lib/zone/desktop";
import { baseName, planPaths, storedPaths, type PathFact, type PathPlan } from "@/lib/zone/incoming";
import { joinStorePath, MODE_LABEL, stageSubdir, tallyLine, type IngestTally } from "@/lib/zone/ingest";
import { placeFile, type IngestMode, type Workspace } from "@/lib/zone/model";
import { useZone } from "@/lib/zone/store";
import { packageSession, storeFromDisk } from "@/lib/zone/package-fs";

export type IncomingNotice = { message: string; added: number };

type Batch = { shelfId: string | null; paths: string[] };

let bucket: Batch[] = [];
let timer = 0;
let running = false;
let notify: (notice: IncomingNotice) => void = () => {};

export function bindIncoming(handler: (notice: IncomingNotice) => void) {
  notify = handler;
}

function addToBucket(shelfId: string | null, paths: string[]) {
  const same = bucket.find((batch) => batch.shelfId === shelfId);
  if (same) same.paths.push(...paths);
  else bucket.push({ shelfId, paths: [...paths] });
}

export function queueIncoming(paths: string[], shelfId: string | null = null) {
  const next = paths.map((path) => path.trim()).filter(Boolean);
  if (next.length === 0) return;
  addToBucket(shelfId, next);
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const batches = bucket;
    bucket = [];
    void drainIncoming(batches);
  }, 400);
}

async function drainIncoming(batches: Batch[]) {
  if (running) {
    for (const batch of batches) addToBucket(batch.shelfId, batch.paths);
    return;
  }
  running = true;
  try {
    for (const batch of batches) {
      const notice = await ingestPaths(batch.paths, { shelfId: batch.shelfId });
      notify(notice);
    }
  } finally {
    running = false;
    if (bucket.length > 0) {
      const more = bucket;
      bucket = [];
      void drainIncoming(more);
    }
  }
}

function reasonOf(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return "没有放进项目。";
}

async function factsFor(paths: string[]): Promise<PathFact[]> {
  if (!isDesktop()) {
    return paths.map((path) => ({
      path,
      name: baseName(path),
      exists: false,
      isDir: false,
      readable: false,
      reason: "浏览器里读不到资源管理器。在 Windows 上用右键「发送到 ZAのWork-Zone」，或按 Ctrl+Alt+A。",
    }));
  }
  return probePaths(paths);
}

async function thumbOf(path: string): Promise<string | undefined> {
  if (!isDesktop()) return undefined;
  try {
    return (await imageThumb(path)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** 记一条文件记录。shelfId 有值就放进那一层并固定；没有就按归类规则放。 */
function addRecord(input: {
  name: string;
  size?: number;
  path: string;
  sourcePath?: string;
  external: boolean;
  shelfId: string | null;
  folderId?: string;
  thumb?: string;
}) {
  return useZone.getState().addFile({
    name: input.name,
    size: input.size,
    path: input.path,
    sourcePath: input.sourcePath,
    external: input.external,
    thumb: input.thumb,
    folderId: input.shelfId ?? input.folderId,
    keepUnlocked: !input.shelfId,
  });
}

type Target =
  | { kind: "package" }
  | { kind: "folder"; dir: string }
  | { kind: "blocked"; message: string };

/**
 * 复制/移动要放到哪里：打开的项目包，或者这个项目的“存放文件夹”。
 * 都没有就当场让用户选一个存放文件夹；用户不选就整批不处理 —— 不会悄悄改成只记路径。
 */
async function resolveTarget(workspace: Workspace, mode: IngestMode): Promise<Target> {
  const live = packageSession();
  if (live) {
    if (live.packageId !== workspace.packageId) return { kind: "blocked", message: "先切回打开的项目包，再把文件放进来。没有放进来。" };
    if (live.readonly) return { kind: "blocked", message: "这个项目包正在另一个窗口里编辑，没有放进来。" };
    return { kind: "package" };
  }
  if (!isDesktop()) {
    return {
      kind: "blocked",
      message: `浏览器里写不进你电脑的文件夹，没法${MODE_LABEL[mode]}。先「新建项目包」，或把导入方式改成「只记录路径」。`,
    };
  }
  const known = workspace.storeDir?.trim();
  if (known) return { kind: "folder", dir: known };
  let picked: string | null = null;
  try {
    picked = await pickFolder(`选一个文件夹，存放「${workspace.name}」的文件（复制/移动进来的文件会按阶段放进里面）`);
  } catch (error) {
    return { kind: "blocked", message: `打不开选文件夹的窗口：${reasonOf(error)}。没有放进来。` };
  }
  if (!picked) {
    return {
      kind: "blocked",
      message: `还没有存放文件夹，所以没有${MODE_LABEL[mode]}。再放一次选个文件夹，或把导入方式改成「只记录路径」。`,
    };
  }
  useZone.getState().setStoreDir(workspace.id, picked);
  return { kind: "folder", dir: picked };
}

export async function ingestPaths(raw: string[], options: { shelfId?: string | null } = {}): Promise<IncomingNotice> {
  const state = useZone.getState();
  const workspace = state.workspaces.find((item) => item.id === state.activeWorkspaceId) ?? state.workspaces[0];
  if (!workspace) return { message: "还没有项目。", added: 0 };
  const shelfId = options.shelfId ?? null;
  const mode: IngestMode = workspace.ingestMode ?? "copy";
  const mine = state.files.filter((file) => file.workspaceId === workspace.id);
  const facts = await factsFor(raw);
  const plans = planPaths(storedPaths(mine), facts, mode, mine);
  const lines: string[] = [];
  const tally: IngestTally = { copied: 0, moved: 0, linked: 0 };
  let added = 0;
  let where = "项目文件夹";

  const record = async (plan: Extract<PathPlan, { kind: "record" }>) => {
    const saved = addRecord({
      name: plan.name,
      size: plan.size,
      path: plan.path,
      sourcePath: plan.path,
      external: true,
      shelfId,
      thumb: await thumbOf(plan.path),
    });
    if (saved.fileId && !saved.message.includes("已在项目里")) {
      added += 1;
      tally.linked += 1;
      if (mode !== "link") lines.push(`${plan.name}：${plan.because}。`);
    } else {
      lines.push(`${saved.message}。`);
    }
  };

  let target: Target | null = null;
  for (const plan of plans) {
    if (plan.kind === "duplicate") {
      lines.push(`${plan.name} 已在项目里。`);
      continue;
    }
    if (plan.kind === "fail") {
      lines.push(plan.reason);
      continue;
    }
    if (plan.kind === "record") {
      await record(plan);
      continue;
    }
    if (plan.kind === "settle") {
      try {
        const settled = await settleMove(plan.path, plan.keptPath);
        if (settled.removed) {
          tally.moved += 1;
          lines.push(`${plan.name} 之前复制进来过，这次已把原文件移走。`);
        } else {
          lines.push(`${plan.name} 已在项目里，原文件还在：${settled.note ?? "没有移走"}。`);
        }
      } catch (error) {
        lines.push(`${plan.name} 已在项目里，原文件还在：${reasonOf(error)}`);
      }
      continue;
    }
    target ??= await resolveTarget(workspace, mode);
    if (target.kind === "blocked") {
      lines.push(`${plan.name} 没有放进来。`);
      continue;
    }
    const fresh = useZone.getState();
    const current = fresh.workspaces.find((item) => item.id === workspace.id) ?? workspace;

    if (target.kind === "package") {
      where = "项目包";
      try {
        const saved = await storeFromDisk({ name: plan.name, sourcePath: plan.path, size: plan.size, shelfId });
        if (!saved.fileId) {
          lines.push(saved.message);
          continue;
        }
        added += 1;
        if (plan.mode === "move") {
          try {
            await removeUserFile(plan.path);
            tally.moved += 1;
          } catch (error) {
            tally.copied += 1;
            lines.push(`${saved.name} 已复制进来，但原文件没删掉：${reasonOf(error)}`);
          }
        } else {
          tally.copied += 1;
        }
      } catch (error) {
        lines.push(`${plan.name} 没有放进来：${reasonOf(error)}`);
      }
      continue;
    }

    where = target.dir;
    const old = plan.replaceId ? mine.find((item) => item.id === plan.replaceId) : undefined;
    const placed = old
      ? { folderId: old.folderId }
      : placeFile({ name: plan.name, path: plan.path, folders: current.folders, rules: current.rules, chosenId: shelfId });
    const destDir = joinStorePath(target.dir, stageSubdir(current.folders, placed.folderId));
    try {
      const done = await ingestFile(plan.path, destDir, plan.mode);
      const thumb = (await thumbOf(done.path)) ?? old?.thumb;
      let saved: { fileId: string | null; message: string };
      if (old) {
        // 这个文件以前只记了路径：这次真的放进去了，把原来那条记录指向新位置，不另起一条。
        useZone.getState().relinkFile(old.id, { name: old.name, size: done.size, thumb, dominant: old.dominant, path: done.path, external: false });
        saved = { fileId: old.id, message: "" };
      } else {
        saved = addRecord({
          name: done.name,
          size: done.size,
          path: done.path,
          sourcePath: plan.path,
          external: false,
          shelfId,
          folderId: placed.folderId,
          thumb,
        });
      }
      if (!saved.fileId) {
        lines.push(`${done.name} 已放进 ${destDir}，但没记进清单：${saved.message}`);
        continue;
      }
      if (!saved.message.includes("已在项目里")) added += 1;
      if (done.inPlace) lines.push(`${done.name} 本来就在项目文件夹里，没有动它。`);
      else if (plan.mode === "move" && done.moved) tally.moved += 1;
      else tally.copied += 1;
      if (done.note && !done.inPlace) lines.push(`${done.name}：${done.note}。`);
    } catch (error) {
      lines.push(`${plan.name} 没有放进来，原文件没动：${reasonOf(error)}`);
    }
  }

  if (target?.kind === "blocked") lines.unshift(target.message);
  if (lines.length === 0 && added === 0) return { message: "没有可加入的文件。", added: 0 };
  const summary = tallyLine(tally, where === "项目包" ? "项目包" : `「${where}」`);
  const head =
    added > 0
      ? `加入 ${added} 个。`
      : plans.every((plan) => plan.kind === "duplicate")
        ? "都已经在项目里。"
        : tally.copied + tally.moved + tally.linked > 0
          ? "已处理。"
          : "没有新文件加入。";
  return { message: [head, summary, ...lines].filter(Boolean).join(" "), added };
}
