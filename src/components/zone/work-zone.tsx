import {
  Archive,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  ClipboardPaste,
  Download,
  DraftingCompass,
  FolderInput,
  FileCode,
  FilePlus,
  FileText,
  GripHorizontal,
  Image as ImageIcon,
  Layers,
  Link2,
  Minus,
  Music,
  Pause,
  PenTool,
  Pencil,
  Pin,
  Play,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Type,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { forgetFile, recallFile, rememberFile } from "@/components/zone/session-files";
import { PackageBar } from "@/components/zone/package-bar";
import { bindIncoming, ingestPaths, queueIncoming } from "@/lib/zone/capture";
import {
  bindDesktopWindow,
  clipCleanup,
  clipKeepOriginal,
  clipSaveAs,
  clipStartDrag,
  clipWriteTemp,
  copyImage,
  copyText,
  fileSize,
  flushDesktopState,
  imageThumb,
  isDesktop,
  missingPaths,
  onDesktopEvent,
  onFileDrop,
  openPath,
  pickFile,
  pickFiles,
  pickFolder,
  revealPath,
  setClipboardPaused,
  setShellMenuEnabled,
  applyLayout,
  fullscreenActive,
  onZoneHover,
  setHitRects,
  snapCollapsed,
  type Box as ZoneBox,
  type ZoneLayout,
  startWindowDrag,
  syncIgnoredApps,
  takePendingSends,
  type CapturePayload,
} from "@/lib/zone/desktop";
import { CAPSULE_TIMING, resolveCapsule, stageTone } from "@/lib/zone/capsule";
import { animateSpring, COLLAPSE_SPRING, type SpringOptions } from "@/lib/zone/spring";
import { cn } from "@/lib/cn";
import {
  effectiveMotion,
  nextMotion,
  readMotion,
  SHIP_FX,
  shipSeenKey,
  startShipParticles,
  writeMotion,
  type MotionLevel,
} from "@/components/zone/ship-fx";
import {
  BUILTIN_NOTES,
  CLIP_LABEL,
  classifyText,
  descendantIds,
  folderByName,
  folderPath,
  formatBytes,
  formatWhen,
  IN_USE_MS,
  isColor,
  KIND_LABEL,
  KIND_ORDER,
  placeFile,
  ROLE_LABEL,
  RULE_STAGE,
  stageActionLabel,
  stageCursor,
  sourceIgnored,
  type ClassRule,
  type Clip,
  type ClipKind,
  type Folder,
  type Kind,
  type Workspace,
  type ZoneFile,
} from "@/lib/zone/model";
import { clipResultMessage, useZone, type ClipResult } from "@/lib/zone/store";
import { boardFor, openTodoCount, resumeBrief } from "@/lib/zone/notes";
import { isRhinoBackup, versionCards, versionIdentity, type VersionCard } from "@/lib/zone/versions";
import { makeThumb, thumbToPngBlob } from "@/lib/zone/thumb";
import { BIG_FILE } from "@/lib/zone/package";
import { MODE_HINT, MODE_LABEL } from "@/lib/zone/ingest";
import {
  bindPackageAutosave,
  ensurePackedFolder,
  importFolderFiles,
  ingestIntoPackage,
  openDroppedTransfer,
  openRecentPackage,
  packageSession,
  readPackedBlob,
  recentPackages,
  releaseRecords,
  renamePackedFolder,
  type RecentPackage,
} from "@/lib/zone/package-fs";

// 桌面端收/展：窗口永远是最大尺寸的透明窗口，可见形状（胶囊 <-> 面板）在里面用弹簧形变。
// 收起时内容先淡出这么久，形状再收缩（和 styles.css 里 .zone-body 的淡出时长对齐）。
const CONTENT_OUT_MS = 120;
const CAPSULE_RADIUS = 22;
const PANEL_RADIUS = 16;

// 「同时删除文件」：先把记录从界面拿掉（马上生效），回收站在后台移；失败就原样放回并提示。
// 原先是等回收站（起 PowerShell，实测 3 秒多）完成才更新界面。
type RemovalSnapshot = { files: ZoneFile[]; workspace?: Workspace; sessions: Array<[string, File]> };

function snapshotForRemoval(workspaceId: string | undefined, victims: ZoneFile[]): RemovalSnapshot {
  const state = useZone.getState();
  const sessions: Array<[string, File]> = [];
  for (const victim of victims) {
    const held = recallFile(victim.id);
    if (held) sessions.push([victim.id, held]);
  }
  return { files: state.files, workspace: state.workspaces.find((workspace) => workspace.id === workspaceId), sessions };
}

function putBackRemoved(snapshot: RemovalSnapshot) {
  for (const [id, file] of snapshot.sessions) rememberFile(id, file);
  useZone.getState().restoreRemoved({ files: snapshot.files, workspace: snapshot.workspace });
}

function trashInBackground(victims: ZoneFile[], snapshot: RemovalSnapshot, onStatus: (message: string) => void, done: (message: string) => string) {
  void releaseRecords(victims, true)
    .then((result) => {
      if (result.gone) {
        onStatus(done(result.message));
        return;
      }
      putBackRemoved(snapshot);
      onStatus("没能放进回收站，文件没动，记录已经恢复。");
    })
    .catch(() => {
      putBackRemoved(snapshot);
      onStatus("没能放进回收站，文件没动，记录已经恢复。");
    });
}

type ZonePhase = "collapsed" | "expanding" | "expanded" | "fading" | "collapsing";

function shapeValues(box: ZoneBox, radius: number): number[] {
  return [box.x, box.y, box.w, box.h, radius];
}

function boxStyle(box: ZoneBox): React.CSSProperties {
  return { position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h };
}

function inBox(box: ZoneBox, x: number, y: number, slop: number) {
  return x >= box.x - slop && x <= box.x + box.w + slop && y >= box.y - slop && y <= box.y + box.h + slop;
}

function unionBox(a: ZoneBox, b: ZoneBox): ZoneBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
const KIND_ICON: Record<Kind, typeof FileText> = {
  image: ImageIcon,
  vector: PenTool,
  design: Layers,
  model: Box,
  drawing: DraftingCompass,
  video: Clapperboard,
  audio: Music,
  document: FileText,
  font: Type,
  archive: Archive,
  code: FileCode,
};

export function WorkZone() {
  const [ready, setReady] = useState(false);
  const desktop = isDesktop();
  useEffect(() => setReady(true), []);
  return (
    <main className={desktop ? "zone-shell h-full text-paper" : "zone-stage relative bg-desk text-paper"}>
      {desktop ? null : <Desk />}
      {ready ? <ZonePanel /> : null}
    </main>
  );
}

function Desk() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-end p-6 sm:items-center sm:p-12">
      <article className="pointer-events-auto max-w-xl">
        <p className="text-xs tracking-tight text-muted">ZA STUDIO · 品牌视觉 · 04</p>
        <h1 className="poster-title mt-3">Quiet</h1>
        <p className="mt-2 text-sm text-muted">安静的标记</p>
        <p className="mt-6 max-w-sm select-text text-lg">把安静做成像完成过的事。</p>
        <ul className="mt-8 flex gap-6 text-xs text-muted">
          <li className="flex items-center gap-2">
            <span className="swatch-ink size-8 rounded-sm border border-line" />
            主色
          </li>
          <li className="flex items-center gap-2">
            <span className="size-8 rounded-sm border border-line bg-paper" />
            纸色
          </li>
          <li className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-sm border border-line text-paper">ZA</span>
            标记
          </li>
        </ul>
      </article>
    </div>
  );
}

function Wordmark() {
  return (
    <span className="truncate text-sm font-medium tracking-tight text-paper">
      <span className="font-display text-base font-medium">ZA</span>
      <span className="text-muted">の</span>
      Work-Zone
    </span>
  );
}

function ZonePanel() {
  const desktop = isDesktop();
  const workspaces = useZone((s) => s.workspaces);
  const activeWorkspaceId = useZone((s) => s.activeWorkspaceId);
  const files = useZone((s) => s.files);
  const capturePaused = useZone((s) => s.capturePaused);
  const panel = useZone((s) => s.panel);
  const collapsed = useZone((s) => s.collapsed);
  const setPanel = useZone((s) => s.setPanel);
  const setCollapsed = useZone((s) => s.setCollapsed);
  const addFile = useZone((s) => s.addFile);
  const addClipText = useZone((s) => s.addClipText);
  const addClipImage = useZone((s) => s.addClipImage);
  const openFile = useZone((s) => s.openFile);
  const resetDemo = useZone((s) => s.resetDemo);

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("拖进来会写明归类原因。选中文字复制，或在页面上按 Ctrl+V。");
  useEffect(() => {
    const onZoneStatus = (event: Event) => setStatus(String((event as CustomEvent).detail ?? ""));
    window.addEventListener("zone-status", onZoneStatus);
    return () => window.removeEventListener("zone-status", onZoneStatus);
  }, []);
  const [toast, setToast] = useState<string | null>(null);
  const [edge, setEdge] = useState(false);
  const [dragShelf, setDragShelf] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [intake, setIntake] = useState<{ files: File[]; shelfId: string | null } | null>(null);
  const [glass, setGlass] = useState(true);
  const [motion, setMotion] = useState<MotionLevel>("full");
  const [summon, setSummon] = useState<"in" | "out" | "idle">("in");
  const [clipFilter, setClipFilter] = useState<ClipKind | "all">("all");
  const [draftPos, setDraftPos] = useState<{ x: number; y: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const dragCleanup = useRef<(() => void) | null>(null);
  const ignoreClick = useRef(false);
  const focusSearch = useRef(false);
  const frameRef = useRef({ width: 384, height: 560 });
  const morphingRef = useRef(false);
  // 桌面端：phase 是形变所处阶段；layout 是 Rust 给出的窗口内胶囊/面板矩形（逻辑像素）。
  const [phase, setPhaseState] = useState<ZonePhase>("collapsed");
  const phaseRef = useRef<ZonePhase>("collapsed");
  const [layout, setLayoutState] = useState<ZoneLayout | null>(null);
  const layoutRef = useRef<ZoneLayout | null>(null);
  const shapeRef = useRef<HTMLDivElement>(null);
  const springRef = useRef<{ cancel: () => void } | null>(null);
  const setPhase = (next: ZonePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  };
  const setLayout = (next: ZoneLayout) => {
    layoutRef.current = next;
    setLayoutState(next);
  };
  const paintShape = (values: number[]) => {
    const node = shapeRef.current;
    if (!node) return;
    node.style.left = `${values[0]}px`;
    node.style.top = `${values[1]}px`;
    node.style.width = `${values[2]}px`;
    node.style.height = `${values[3]}px`;
    node.style.borderRadius = `${Math.max(0, values[4])}px`;
  };  // 收起竖条上的小指示：当前阶段的色点 + 当前项目的文件数。
  const capsule = resolveCapsule({ workspace, files });
  const markStage = stageTone(workspace?.folders.find((folder) => folder.id === workspace.currentStageId)?.name);
  const markCount = capsule.trail ?? "";
  const dock = useZone((s) => s.dock);
  const setDock = useZone((s) => s.setDock);
  const dockRef = useRef(dock);
  dockRef.current = dock;
  // 悬停 / 展开 / 收起的计时与状态：transient 表示这次展开是悬停或拖文件触发的，
  // 鼠标离开一段时间后会自己收回去；点一下面板就算用户接手了，不再自动收。
  const transientRef = useRef(false);
  const showTimer = useRef(0);
  const hideTimer = useRef(0);
  const collapsedAt = useRef(0);
  const holdUntilLeave = useRef(false);
  const leaveRef = useRef<() => void>(() => {});
  const hoverDropRef = useRef<(over: boolean, position?: { x: number; y: number }) => void>(() => {});
  const draggingRef = useRef(false);
  const dragQuietUntil = useRef(0);
  const zoneHoverRef = useRef<(inside: boolean) => void>(() => {});  const toggleRef = useRef<(collapse: boolean) => void>(() => {});
  const [shell, setShell] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
    radius: number;
  } | null>(null);
  const [booted, setBooted] = useState(false);
  const ingestRef = useRef<(list: File[], shelfId: string | null, transfer?: DataTransfer | null) => void>(() => {});

  const pos = draftPos ?? panel;

  useLayoutEffect(() => {
    // 静止态：形状停在胶囊或面板的矩形上。形变进行中由弹簧每帧接管，这里不插手。
    if (!desktop || !layout || morphingRef.current) return;
    const resting = phase === "collapsed" ? shapeValues(layout.capsule, CAPSULE_RADIUS) : shapeValues(layout.panel, PANEL_RADIUS);
    paintShape(resting);
  }, [desktop, layout, phase]);

  useEffect(() => {
    setMotion(readMotion());
  }, []);

  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;
      if (useZone.getState().capturePaused) return;
      const text = document.getSelection()?.toString() ?? "";
      if (!text.trim()) return;
      const result = useZone.getState().addClipText(text);
      setStatus(clipResultMessage(result, result === "added" ? textKind(text) : undefined));
    };
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea")) return;
      if (useZone.getState().capturePaused) return;
      const data = event.clipboardData;
      if (!data) return;
      const imageItem = [...data.items].find((item) => item.type.startsWith("image/"));
      if (imageItem) {
        const file = imageItem.getAsFile();
        if (!file) return;
        event.preventDefault();
        void ingestImageBlob(file, "粘贴的图片");
        return;
      }
      const text = data.getData("text/plain");
      if (text.trim()) {
        event.preventDefault();
        const result = useZone.getState().addClipText(text);
        setStatus(clipResultMessage(result, result === "added" ? textKind(text) : undefined));
      }
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) {
        if (event.key === "Escape") target.blur();
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        focusSearch.current = true;
        toggleRef.current(false);
      }
      if (event.key === "`") {
        event.preventDefault();
        toggleRef.current(!useZone.getState().collapsed);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCollapsed]);

  useEffect(() => bindPackageAutosave(), []);

  useEffect(() => {
    if (localStorage.getItem("za-surface") === "solid") setGlass(false);
    document.documentElement.classList.toggle("is-desktop", desktop);
    const timer = window.setTimeout(() => setSummon((value) => (value === "in" ? "idle" : value)), 260);
    return () => window.clearTimeout(timer);
  }, [desktop]);

  useEffect(() => {
    const id = requestAnimationFrame(() => setBooted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (collapsed || !focusSearch.current) return;
    focusSearch.current = false;
    searchRef.current?.focus();
  }, [collapsed]);

  useEffect(() => () => dragCleanup.current?.(), []);

  useEffect(() => {
    const over = (event: globalThis.DragEvent) => event.preventDefault();
    const drop = (event: globalThis.DragEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      event.preventDefault();
      const list = [...(event.dataTransfer?.files ?? [])];
      if (list.length > 0) ingestRef.current(list, null, event.dataTransfer);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  useEffect(() => {
    if (!panel || morphingRef.current || draftPos) return;
    const clamp = () => {
      const frameW = frameRef.current.width;
      const visualW = collapsed ? 36 : frameW;
      const visualH = Math.min(frameRef.current.height, window.innerHeight - 16);
      const visualLeft = collapsed ? panel.x + frameW - 36 : panel.x;
      const left = Math.min(Math.max(8, visualLeft), Math.max(8, window.innerWidth - visualW - 8));
      const top = Math.min(Math.max(8, panel.y), Math.max(8, window.innerHeight - visualH - 8));
      const x = collapsed ? left - (frameW - 36) : left;
      if (x !== panel.x || top !== panel.y) setPanel({ x, y: top });
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [panel, collapsed, setPanel]);

  async function ingestImageBlob(file: Blob, name: string) {
    let originalPath: string | undefined;
    if (isDesktop()) {
      try {
        const buf = await file.arrayBuffer();
        originalPath = (await clipKeepOriginal(buf, file.type || "image/png")) || undefined;
      } catch {
        originalPath = undefined;
      }
    }
    const made = await makeThumb(file);
    if (!made.thumb) {
      setStatus("这张图片没有留下。");
      return;
    }
    const result = addClipImage(made.thumb, name, made.dominant, originalPath);
    setStatus(
      made.dominant && result === "added"
        ? `图片已留下，主色 ${made.dominant}${originalPath ? "（原图已存）" : ""}。`
        : clipResultMessage(result, "image"),
    );
  }

  async function ingestFiles(list: File[], shelfId: string | null) {
    if (list.length === 0) return;
    for (const file of list) {
      const made = file.type.startsWith("image/") ? await makeThumb(file) : undefined;
      const result = addFile({
        name: file.name,
        size: file.size,
        modifiedAt: file.lastModified,
        thumb: made?.thumb,
        dominant: made?.dominant,
        folderId: shelfId,
      });
      if (result.fileId) rememberFile(result.fileId, file);
      setStatus(result.message);
    }
  }

  async function receiveFiles(list: File[], shelfId: string | null, transfer?: DataTransfer | null) {
    if (list.length === 0) return;
    try {
      const opened = transfer ? await openDroppedTransfer(transfer) : await importFolderFiles(list);
      if (opened) {
        setIntake(null);
        setStatus(opened);
        return;
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "这不是项目包。");
      return;
    }
    const live = packageSession();
    const active = useZone.getState();
    const current = active.workspaces.find((item) => item.id === active.activeWorkspaceId);
    if (live && current?.packageId !== live.packageId) {
      setStatus("先切回打开的项目包，再把文件放进来。");
      return;
    }
    if (live?.readonly) {
      setStatus("这个项目包正在另一个窗口里编辑。");
      return;
    }
    if (live) {
      setIntake((prev) => ({
        files: prev && prev.shelfId === shelfId ? [...prev.files, ...list] : list,
        shelfId,
      }));
      setStatus(`放进来 ${list.length} 个。默认复制进项目包。`);
      return;
    }
    await ingestFiles(list, shelfId);
    const mode = useZone.getState().workspaces.find((item) => item.id === useZone.getState().activeWorkspaceId)?.ingestMode ?? "copy";
    if (mode !== "link") {
      setStatus(`${list.length} 个文件只记在清单里：这里写不进你电脑的文件夹，没法${MODE_LABEL[mode]}。先「新建项目包」，文件才会真的放进去。`);
    }
  }

  async function addByDialog() {
    try {
      const paths = await pickFiles();
      if (paths.length > 0) queueIncoming(paths, null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "没能打开选文件的窗口。");
    }
  }

  async function commitIntake(mode: "copy" | "move" | "link") {
    if (!intake) return;
    const batch = intake;
    setIntake(null);
    try {
      useZone.getState().setIngestMode(mode);
      setStatus(await ingestIntoPackage(batch.files, mode, batch.shelfId));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "没有放进项目包。");
    }
  }

  ingestRef.current = (list, shelfId, transfer) => {
    void receiveFiles(list, shelfId, transfer);
  };

  const dropRef = useRef<(paths: string[]) => void>(() => {});
  dropRef.current = (paths) => {
    const shelf = dragShelf;
    setDragging(false);
    setDragShelf(null);
    const active = useZone.getState();
    const mode = active.workspaces.find((item) => item.id === active.activeWorkspaceId)?.ingestMode ?? "copy";
    setStatus(mode === "link" ? "正在记录路径…" : `正在${MODE_LABEL[mode]}…`);
    queueIncoming(paths, shelf);
  };

  useEffect(() => {
    if (!desktop) return;
    let stop = false;
    const unlisten: Array<() => void> = [];
    const boot = () => {
      const state = useZone.getState();
      // 摆好固定最大尺寸的透明窗口（胶囊落在停靠位置），再按持久化状态决定停在胶囊还是面板。
      void bindPromise
        .then(() => applyLayout(state.dock))
        .then((lay) => {
          if (stop) return;
          const start: ZonePhase = state.collapsed ? "collapsed" : "expanded";
          setLayout(lay);
          setPhase(start);
          setHitRects([start === "collapsed" ? lay.capsule : lay.panel]);
        })
        .catch(() => {});
      void syncIgnoredApps(state.ignoredApps);
      void setClipboardPaused(state.capturePaused);
      const known = state.files.filter((file) => file.path);
      if (known.length === 0) return;
      void missingPaths(known.map((file) => file.path as string)).then((gone) => {
        useZone.getState().markMissing(known.filter((file) => file.path && gone.includes(file.path)).map((file) => file.id));
      });
    };
    const bindPromise = bindDesktopWindow({
      isCollapsed: () => useZone.getState().collapsed,
      onDock: (next) => useZone.getState().setDock(next),
      onLayout: (lay) => {
        setLayout(lay);
        setHitRects([phaseRef.current === "collapsed" ? lay.capsule : lay.panel]);
      },
    });
    void bindPromise.then((fn) => {
      if (stop) fn();
      else unlisten.push(fn);
    });
    if (useZone.persist.hasHydrated()) boot();
    const unsub = useZone.persist.onFinishHydration(boot);
    void onFileDrop((paths) => dropRef.current(paths), (over, position) => hoverDropRef.current(over, position)).then((fn) => {
      if (stop) fn();
      else unlisten.push(fn);
    });
    void onDesktopEvent("zone-drag-end", () => {
      draggingRef.current = false;
      window.setTimeout(() => {
        ignoreClick.current = false;
      }, 250);
      dragQuietUntil.current = Date.now() + 1200;
      if (phaseRef.current === "collapsed") holdUntilLeave.current = true;
    }).then((fn) => {
      if (stop) fn();
      else unlisten.push(fn);
    });
    void onZoneHover((inside) => zoneHoverRef.current(inside)).then((fn) => {
      if (stop) fn();
      else unlisten.push(fn);
    });
    void onDesktopEvent<CapturePayload>("clipboard-capture", (payload) => {
      const state = useZone.getState();
      if (state.capturePaused) return;
      if (payload.sourceApp && sourceIgnored(payload.sourceApp, state.ignoredApps)) return;
      if (payload.kind === "text" && payload.text) {
        if (state.addClipText(payload.text) === "added") setStatus("剪贴板已留下。");
        return;
      }
      if (payload.kind === "image" && payload.image) {
        const originalPath = payload.originalPath || undefined;
        if (state.addClipImage(payload.image, "剪贴图片", undefined, originalPath) === "added") {
          setStatus(originalPath ? "剪贴图片已留下（原图已存）。" : "剪贴图片已留下。");
        }
        return;
      }
      if (payload.kind === "files" && payload.text && state.addClipText(payload.text) === "added") {
        setStatus("复制的文件已留在剪贴板。");
      }
    }).then((fn) => {
      if (stop) fn();
      else unlisten.push(fn);
    });
    void onDesktopEvent<{ paused: boolean }>("clipboard-paused", ({ paused }) => {
      useZone.getState().setPaused(paused);
    }).then((fn) => {
      if (stop) fn();
      else unlisten.push(fn);
    });
    void onDesktopEvent("window-shown", () => {
      setSummon("in");
      window.setTimeout(() => setSummon("idle"), 260);
    }).then((fn) => {
      if (stop) fn();
      else unlisten.push(fn);
    });
    void onDesktopEvent("window-will-hide", () => {
      setSummon("out");
    }).then((fn) => {
      if (stop) fn();
      else unlisten.push(fn);
    });
    // 原图目录清理：未钉住超 7 天 / 总占用压到 500MB
    const pinnedPaths = useZone
      .getState()
      .clips.filter((c) => c.pinned && c.originalPath)
      .map((c) => c.originalPath!);
    void clipCleanup(pinnedPaths).catch(() => {});

    const bootCapture = () => {
      void setShellMenuEnabled(useZone.getState().shellMenu).catch((error: unknown) => {
        const reason = typeof error === "string" ? error : error instanceof Error ? error.message : "";
        if (reason) setStatus(reason);
      });
      void takePendingSends().then((paths) => {
        if (paths.length > 0) queueIncoming(paths);
      });
    };
    if (useZone.persist.hasHydrated()) bootCapture();
    const unsubCapture = useZone.persist.onFinishHydration(bootCapture);
    void onDesktopEvent("paths-incoming", () => {
      void takePendingSends().then((paths) => {
        if (paths.length > 0) queueIncoming(paths);
      });
    }).then((fn) => {
      if (stop) fn();
      else unlisten.push(fn);
    });
    void onDesktopEvent<string>("paths-failed", (reason) => {
      setStatus(reason);
      setToast(reason);
      window.setTimeout(() => setToast((current) => (current === reason ? null : current)), 3200);
    }).then((fn) => {
      if (stop) fn();
      else unlisten.push(fn);
    });
    bindIncoming((notice) => {
      setStatus(notice.message);
      setToast(notice.message);
      window.setTimeout(() => setToast((current) => (current === notice.message ? null : current)), 3200);
      if (notice.added > 0) {
        setEdge(true);
        window.setTimeout(() => setEdge(false), 720);
      }
    });
    const flush = () => void flushDesktopState();
    window.addEventListener("pagehide", flush);
    return () => {
      stop = true;
      unsub();
      unsubCapture();
      unlisten.forEach((fn) => fn());
      window.removeEventListener("pagehide", flush);
    };
  }, [desktop]);

  function onDragEnter(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
    const shelf = (event.target as HTMLElement).closest("[data-folder-id]")?.getAttribute("data-folder-id");
    if (shelf) setDragShelf(shelf);
  }

  function onDragOver(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    const shelf = (event.target as HTMLElement).closest("[data-folder-id]")?.getAttribute("data-folder-id") ?? null;
    setDragShelf(shelf);
  }

  function onDragLeave() {
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
      setDragShelf(null);
    }
  }

  function onDrop(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const shelf = (event.target as HTMLElement).closest("[data-folder-id]")?.getAttribute("data-folder-id") ?? dragShelf;
    setDragShelf(null);
    const dropped = [...(event.dataTransfer?.files ?? [])];
    if (dropped.length > 0) {
      void receiveFiles(dropped, shelf, event.dataTransfer);
      return;
    }
    const text = event.dataTransfer?.getData("text/plain") ?? "";
    if (!text.trim() || capturePaused) return;
    const result = addClipText(text);
    setStatus(clipResultMessage(result, result === "added" ? textKind(text) : undefined));
  }

  function clampPoint(x: number, y: number) {
    const node = panelRef.current;
    const width = node?.offsetWidth ?? 64;
    const height = node?.offsetHeight ?? 64;
    return {
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - width - 8)),
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - height - 8)),
    };
  }

  /** 拖窗口期间不触发悬停展开；松手（Rust 发 zone-drag-end）后要鼠标离开再进来才算悬停。 */
  function beginWindowDrag() {
    draggingRef.current = true;
    // 松手时浏览器还会补一个 click：别让它把刚拖完的胶囊展开。
    ignoreClick.current = true;
    window.clearTimeout(showTimer.current);
    showTimer.current = 0;
    void startWindowDrag().catch(() => {
      draggingRef.current = false;
      ignoreClick.current = false;
    });
  }

  function onHeaderPointerDown(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const control = (event.target as HTMLElement).closest("button, input, a, textarea, select");
    if (control && control !== event.currentTarget) return;
    if (desktop) {
      // 桌面端不能在 pointerdown 里立刻 startWindowDrag：系统接手鼠标后，随后的 click 永远
      // 不会派发，而收起态的 ZA 条既是拖动把手又是「点我展开」按钮 —— 真鼠标就再也点不开。
      // 改成移动超过 5px 才启动系统拖动（拖窗口照旧），轻点仍走 click。
      const pointerId = event.pointerId;
      const originX = event.clientX;
      const originY = event.clientY;
      const end = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if ((ev.buttons & 1) === 0) {
          end(ev);
          return;
        }
        if (Math.hypot(ev.clientX - originX, ev.clientY - originY) > 5) {
          end(ev);
          beginWindowDrag();
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      return;
    }
    const node = panelRef.current;
    if (!node) return;
    dragCleanup.current?.();
    const rect = node.getBoundingClientRect();
    morphingRef.current = false;
    setDraftPos({ x: rect.left, y: rect.top });
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const pointerId = event.pointerId;
    const originX = event.clientX;
    const originY = event.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if ((ev.buttons & 1) === 0) {
        end(ev);
        return;
      }
      if (Math.hypot(ev.clientX - originX, ev.clientY - originY) > 5) moved = true;
      setDraftPos(clampPoint(ev.clientX - offsetX, ev.clientY - offsetY));
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      dragCleanup.current = null;
      ignoreClick.current = moved;
      const visual = clampPoint(ev.clientX - offsetX, ev.clientY - offsetY);
      setDraftPos(null);
      if (useZone.getState().collapsed) {
        const frameW = frameRef.current.width;
        setShell({ left: visual.x, top: visual.y, width: 36, height: Math.max(220, frameRef.current.height), radius: 16 });
        setPanel({ x: visual.x - (frameW - 36), y: visual.y });
        return;
      }
      setShell(null);
      setPanel(visual);
    };
    dragCleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  const clipSeen = useRef("");
  const clipAllowed = useRef(false);

  async function takeClipboard(announce: boolean) {
    if (useZone.getState().capturePaused) {
      if (announce) setStatus("记录已暂停。");
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      clipAllowed.current = true;
      let saw = false;
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          let originalPath: string | undefined;
          if (isDesktop()) {
            try {
              originalPath = (await clipKeepOriginal(await blob.arrayBuffer(), imageType)) || undefined;
            } catch {
              originalPath = undefined;
            }
          }
          const made = await makeThumb(blob);
          if (!made.thumb || made.thumb === clipSeen.current) {
            saw = Boolean(made.thumb);
            continue;
          }
          clipSeen.current = made.thumb;
          const result = useZone.getState().addClipImage(made.thumb, "剪贴板图片", made.dominant, originalPath);
          if (result === "added" || announce) {
            setStatus(
              made.dominant && result === "added"
                ? `图片已留下，主色 ${made.dominant}${originalPath ? "（原图已存）" : ""}。`
                : clipResultMessage(result, "image"),
            );
          }
          saw = true;
          continue;
        }
        if (item.types.includes("text/plain")) {
          const text = (await (await item.getType("text/plain")).text()).trim();
          if (!text || text === clipSeen.current) {
            saw = Boolean(text);
            continue;
          }
          clipSeen.current = text;
          const result = useZone.getState().addClipText(text);
          if (result === "added" || announce) setStatus(clipResultMessage(result, result === "added" ? textKind(text) : undefined));
          saw = true;
        }
      }
      if (!saw && announce) setStatus("剪贴板里没有文字或图片。");
    } catch {
      if (announce) setStatus("读不到系统剪贴板。选中文字复制，或在页面上按 Ctrl+V。");
    }
  }

  useEffect(() => {
    const pull = () => {
      if (!clipAllowed.current || document.visibilityState === "hidden" || useZone.getState().capturePaused) return;
      void takeClipboard(false);
    };
    const clipboard = navigator.clipboard as Clipboard & {
      addEventListener?: (type: string, fn: () => void) => void;
      removeEventListener?: (type: string, fn: () => void) => void;
    };
    try {
      clipboard.addEventListener?.("clipboardchange", pull);
    } catch {
      // not supported
    }
    void navigator.permissions
      ?.query({ name: "clipboard-read" as PermissionName })
      .then((perm) => {
        const allow = () => {
          clipAllowed.current = perm.state === "granted";
          if (clipAllowed.current) pull();
        };
        allow();
        perm.onchange = allow;
      })
      .catch(() => {
        clipAllowed.current = false;
      });
    const timer = window.setInterval(pull, 2000);
    window.addEventListener("focus", pull);
    document.addEventListener("visibilitychange", pull);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", pull);
      document.removeEventListener("visibilitychange", pull);
      try {
        clipboard.removeEventListener?.("clipboardchange", pull);
      } catch {
        // not supported
      }
    };
  }, []);

  async function readClipboard() {
    await takeClipboard(true);
  }

  async function launchFile(file: ZoneFile) {
    openFile(file.id);
    const onDisk =
      Boolean(file.path) &&
      (file.external || /^[a-zA-Z]:[\\/]/.test(file.path ?? "") || (file.path ?? "").startsWith("\\\\") || (file.path ?? "").startsWith("/"));
    if (desktop && file.path && onDisk) {
      const gone = await missingPaths([file.path]);
      if (gone.length > 0) {
        useZone.getState().markMissing([file.id]);
        setStatus(`${file.name} 的路径不存在，已标成失效。`);
        return;
      }
      try {
        await openPath(file.path);
        setStatus(`${file.name} 已用系统程序打开。`);
      } catch {
        setStatus("系统没有打开这个文件。");
      }
      return;
    }
    const blob = recallFile(file.id) ?? (await readPackedBlob(file.path, file.external));
    if (!blob) {
      setStatus(file.stale ? `${file.name} 不在了。点重新定位，换一个文件挂上。` : `${file.name} 这次还打不开。先拖进来，或点重新定位。`);
      return;
    }
    const url = URL.createObjectURL(blob);
    const lower = file.name.toLowerCase();
    const preview =
      blob.type.startsWith("image/") ||
      blob.type === "application/pdf" ||
      blob.type.startsWith("text/") ||
      /\.(svg|txt|md|json|csv|log)$/.test(lower);
    if (preview) {
      window.open(url, "_blank", "noopener");
      setStatus(`${file.name} 已打开预览。`);
      return;
    }
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    setStatus(`${file.name} 已下载。`);
  }

  function reduceMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** 把形状弹簧到目标矩形；结束时精确落在 to 上，之后不再有任何动画。 */
  function springShape(from: number[], to: number[], options?: SpringOptions) {
    springRef.current?.cancel();
    const run = animateSpring(from, to, paintShape, options);
    springRef.current = run;
    return run.done;
  }

  /** 静止态下可交互的矩形（窗口内逻辑像素）。 */
  function restHit(lay: ZoneLayout, at: ZonePhase): ZoneBox[] {
    return [at === "collapsed" ? lay.capsule : lay.panel];
  }

  /**
   * 桌面端收/展：窗口一直是最大尺寸的透明窗口，不再改原生窗口。
   * 展开：形状从胶囊弹簧到面板（朝屏幕内侧长出来），到位后内容才淡入（模糊 6px -> 0，逐项错开 30ms）。
   * 收起：内容先淡出（120ms），再让形状弹簧收回胶囊。
   */
  async function windowMorph(collapse: boolean, transient = false) {
    if (morphingRef.current) return;
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    showTimer.current = 0;
    hideTimer.current = 0;
    transientRef.current = !collapse && transient;
    const lay = layoutRef.current;
    if (!lay) {
      setCollapsed(collapse);
      return;
    }
    const reduced = reduceMotion();
    const capsuleShape = shapeValues(lay.capsule, CAPSULE_RADIUS);
    const panelShape = shapeValues(lay.panel, PANEL_RADIUS);
    morphingRef.current = true;
    // 形变期间胶囊和面板都得能点（也避免光标在边缘时穿透状态来回抖）。
    setHitRects([unionBox(lay.capsule, lay.panel)]);
    try {
      if (collapse) {
        setPhase("fading");
        if (!reduced) await new Promise<void>((resolve) => window.setTimeout(resolve, CONTENT_OUT_MS));
        setPhase("collapsing");
        if (reduced) paintShape(capsuleShape);
        else await springShape(panelShape, capsuleShape, COLLAPSE_SPRING);
        morphingRef.current = false;
        setCollapsed(true);
        setPhase("collapsed");
        collapsedAt.current = Date.now();
        setHitRects(restHit(lay, "collapsed"));
        // 展开时用户可能把窗口拖到了别的边：收起后顺手吸附回去，返回新的窗口内布局。
        const snap = await snapCollapsed();
        if (snap) {
          if (snap.dock.edge !== dockRef.current.edge || snap.dock.t !== dockRef.current.t) setDock(snap.dock);
          if (snap.layout) {
            setLayout(snap.layout);
            setHitRects(restHit(snap.layout, "collapsed"));
          }
        }
      } else {
        setCollapsed(false);
        setPhase("expanding");
        if (reduced) paintShape(panelShape);
        else await springShape(capsuleShape, panelShape);
        morphingRef.current = false;
        setPhase("expanded");
        setHitRects(restHit(lay, "expanded"));
      }
    } catch {
      // 出岔子也要落到目标形态，别卡在半截。
      springRef.current?.cancel();
      morphingRef.current = false;
      setCollapsed(collapse);
      setPhase(collapse ? "collapsed" : "expanded");
      setHitRects(restHit(layoutRef.current ?? lay, collapse ? "collapsed" : "expanded"));
    } finally {
      morphingRef.current = false;
    }
  }

  /** 悬停第一步：停留 CAPSULE_TIMING.showMs 才展开；前台是全屏应用时不展开。 */
  function onCapsuleEnter() {
    if (!desktop || !useZone.getState().collapsed || morphingRef.current || draggingRef.current) return;
    // 刚收起时鼠标多半还停在原地，胶囊就在光标下：这种进入不算数，等鼠标离开再说。
    if (Date.now() - collapsedAt.current < 500 || Date.now() < dragQuietUntil.current) {
      holdUntilLeave.current = true;
      return;
    }
    if (holdUntilLeave.current) return;
    // 鼠标事件和 Rust 的光标轮询都会报“进入”，已经在计时就别重来。
    if (showTimer.current) return;
    showTimer.current = window.setTimeout(() => {
      showTimer.current = 0;
      void (async () => {
        if (!useZone.getState().collapsed || morphingRef.current || draggingRef.current) return;
        if (await fullscreenActive()) return;
        void windowMorph(false, true);
      })();
    }, CAPSULE_TIMING.showMs);
  }

  function onCapsuleLeave() {
    holdUntilLeave.current = false;
    window.clearTimeout(showTimer.current);
    showTimer.current = 0;
  }

  /** 悬停展开后的收回：鼠标离开 CAPSULE_TIMING.hideMs（比显示慢）才收；正在输入或拖拽时不收。 */
  function onPanelLeave() {
    if (!desktop || !transientRef.current) return;
    window.clearTimeout(hideTimer.current);
    const check = () => {
      hideTimer.current = 0;
      if (!transientRef.current || useZone.getState().collapsed) return;
      // 形变还没结束：不丢这次收回，等一会儿再看。
      if (morphingRef.current) {
        hideTimer.current = window.setTimeout(check, 150);
        return;
      }
      const node = panelRef.current;
      const active = document.activeElement;
      if (dragDepth.current > 0 || (node && active && active !== document.body && node.contains(active))) {
        transientRef.current = false;
        return;
      }
      collapseToOrb();
    };
    hideTimer.current = window.setTimeout(check, CAPSULE_TIMING.hideMs);
  }

  function onPanelEnter() {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = 0;
  }

  leaveRef.current = onPanelLeave;
  // Rust 的光标轮询：光标进出可交互形状。穿透状态下前端收不到 pointer 事件，所以靠这个。
  zoneHoverRef.current = (inside) => {
    if (!desktop) return;
    if (phaseRef.current === "collapsed") {
      if (inside) onCapsuleEnter();
      else onCapsuleLeave();
    } else if (inside) onPanelEnter();
    else onPanelLeave();
  };
  // 文件拖到胶囊上：自动展开接住；拖离窗口后和悬停一样延迟收回。position 是物理像素。
  hoverDropRef.current = (over, position) => {
    if (!desktop) return;
    if (over) {
      const lay = layoutRef.current;
      const ratio = window.devicePixelRatio || 1;
      const target = phaseRef.current === "collapsed" ? lay?.capsule : lay?.panel;
      const onTarget = !lay || !position || !target || inBox(target, position.x / ratio, position.y / ratio, 10);
      if (!onTarget) {
        leaveRef.current();
        return;
      }
      window.clearTimeout(hideTimer.current);
      hideTimer.current = 0;
      if (useZone.getState().collapsed && !morphingRef.current) void windowMorph(false, true);
    } else {
      leaveRef.current();
    }
  };
  function collapseToOrb() {
    if (isDesktop()) {
      void windowMorph(true);
      return;
    }
    const node = panelRef.current;
    if (!node || useZone.getState().collapsed) return;
    const rect = node.getBoundingClientRect();
    frameRef.current = { width: rect.width, height: rect.height };
    const barH = Math.max(220, Math.min(rect.height, window.innerHeight - 16));
    const next = { left: rect.right - 36, top: rect.top, width: 36, height: barH, radius: 16 };
    setPanel({ x: rect.left, y: rect.top });
    setCollapsed(true);
    if (reduceMotion()) {
      morphingRef.current = false;
      setShell(next);
      return;
    }
    morphingRef.current = true;
    setShell({ left: rect.left, top: rect.top, width: rect.width, height: rect.height, radius: 24 });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShell(next));
    });
  }

  function expandFromOrb() {
    if (isDesktop()) {
      void windowMorph(false);
      return;
    }
    const node = panelRef.current;
    if (!node || !useZone.getState().collapsed) {
      setCollapsed(false);
      return;
    }
    const rect = node.getBoundingClientRect();
    const { width, height } = frameRef.current;
    const left = Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8));
    const top = Math.min(Math.max(8, rect.top), Math.max(8, window.innerHeight - Math.min(height, window.innerHeight - 16) - 8));
    const next = { left, top, width, height, radius: 24 };
    setPanel({ x: left, y: top });
    setCollapsed(false);
    if (reduceMotion()) {
      morphingRef.current = false;
      setShell(null);
      return;
    }
    morphingRef.current = true;
    setShell({ left: rect.left, top: rect.top, width: rect.width, height: rect.height, radius: 16 });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShell(next));
    });
  }

  toggleRef.current = (collapse) => {
    if (collapse) collapseToOrb();
    else expandFromOrb();
  };

  // 收起态不再换成另一根 zone-bar：面板自己就是那根竖条（.zone-mark 负责显示 ZA），
  // 这样收/展时面板元素始终存在，桌面端才有东西可以做「从左往右缩」的动画。
  const visual = draftPos
    ? { left: draftPos.x, top: draftPos.y }
    : shell
      ? { left: shell.left, top: shell.top }
      : pos
        ? {
            left: collapsed ? pos.x + frameRef.current.width - 36 : pos.x,
            top: pos.y,
          }
        : null;

  return (
    <aside
      ref={panelRef}
      className={cn(
        "zone-panel absolute z-10 flex min-h-0 flex-col overflow-hidden rounded-xl p-3",
        desktop && "zone-window",
        !desktop && !visual && "zone-panel-dock",
        !booted && "no-motion",
        !desktop && collapsed && "is-collapsed",
        shell && "has-shell",
        draftPos && "is-dragging",
        dragging && "is-file-drag",
        edge && "is-flash",
        !glass && "is-solid",
        summon === "in" && "is-entering",
        summon === "out" && "is-leaving",
      )}
      data-phase={desktop ? phase : undefined}
      data-ready={desktop ? (layout ? "1" : "0") : undefined}
      style={
        desktop || !visual
          ? undefined
          : {
              left: visual.left,
              top: visual.top,
              width: shell ? shell.width : undefined,
              height: shell ? shell.height : undefined,
              maxHeight: shell ? shell.height : undefined,
              borderRadius: shell ? shell.radius : undefined,
            }
      }
      role="region"
      aria-label="ZAのWork-Zone"
      onTransitionEnd={(event) => {
        if (event.target !== panelRef.current || event.propertyName !== "width") return;
        morphingRef.current = false;
        if (!useZone.getState().collapsed) setShell(null);
      }}
      onPointerEnter={onPanelEnter}
      onPointerLeave={onPanelLeave}
      onPointerDownCapture={() => {
        transientRef.current = false;
      }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {desktop ? <div ref={shapeRef} className="zone-shape" aria-hidden /> : null}
      <button
        type="button"
        className="zone-mark font-display text-base font-medium touch-none"
        aria-label="展开工作区"
        title={capsule.title || "展开工作区"}
        tabIndex={(desktop ? phase === "collapsed" : collapsed) ? 0 : -1}
        style={desktop && layout ? boxStyle(layout.capsule) : undefined}
        onPointerEnter={onCapsuleEnter}
        onPointerLeave={onCapsuleLeave}
        onPointerDown={(event) => {
          window.clearTimeout(showTimer.current);
          showTimer.current = 0;
          onHeaderPointerDown(event);
        }}
        onClick={() => {
          if (ignoreClick.current) {
            ignoreClick.current = false;
            return;
          }
          expandFromOrb();
        }}
      >
        {desktop ? (
          <>
            <span className="capsule-dot" data-stage={capsule.lead?.tone ?? "none"} aria-hidden />
            <span className="capsule-brand">ZA</span>
            <span className="capsule-text">{capsule.text ?? ""}</span>
            {capsule.trail ? <span className="capsule-trail" aria-hidden>{capsule.trail}</span> : null}
          </>
        ) : (
          <>
            <span className="zone-mark-dot" data-stage={markStage.tone} aria-hidden />
            <span className="zone-mark-text">ZA</span>
            <span className="zone-mark-count" aria-hidden>{markCount}</span>
          </>
        )}
      </button>
      <div
        className="zone-body"
        ref={bodyRef}
        style={desktop && layout ? boxStyle(layout.panel) : undefined}
        inert={(desktop ? phase !== "expanded" : collapsed) ? true : undefined}
      >
      <div
        className="flex h-11 cursor-grab items-center gap-1 touch-none active:cursor-grabbing"
        onPointerDown={onHeaderPointerDown}
      >
        <GripHorizontal className="size-4 shrink-0 text-faint" aria-hidden />
        <Wordmark />
        <span className="ml-auto" />
        <Button
          size="icon"
          variant="ghost"
          aria-label={`动效强度：${motion === "full" ? "完整" : motion === "lite" ? "精简" : "关闭"}`}
          onClick={() => {
            const next = nextMotion(motion);
            setMotion(next);
            writeMotion(next);
            setStatus(`动效强度：${next === "full" ? "完整" : next === "lite" ? "精简" : "关闭"}。`);
          }}
        >
          <span className="flex items-end gap-0.5" aria-hidden>
            <span className={cn("w-0.5 rounded-full bg-paper", motion === "off" ? "h-1 opacity-30" : "h-1.5")} />
            <span className={cn("w-0.5 rounded-full bg-paper", motion === "full" ? "h-2.5" : "h-2.5 opacity-30")} />
            <span className={cn("w-0.5 rounded-full bg-paper", motion === "full" ? "h-3.5" : "h-3.5 opacity-30")} />
          </span>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={glass ? "改用纯色背景" : "改用毛玻璃"}
          aria-pressed={!glass}
          onClick={() => {
            const next = !glass;
            setGlass(next);
            localStorage.setItem("za-surface", next ? "glass" : "solid");
          }}
        >
          <span className={cn("size-3 rounded-full border border-line", glass ? "bg-accent/40" : "bg-raised")} />
        </Button>
        <Button size="icon" variant="ghost" aria-label="收起工作区" onClick={() => collapseToOrb()}>
          <Minus className="size-4" />
        </Button>
      </div>
      {workspace ? <WorkspaceBar workspaceId={workspace.id} onStatus={setStatus} /> : null}
      <div className="zone-tools">
        <label className="zone-search-tool">
          <Search className="zone-search-icon" aria-hidden />
          <span className="sr-only">搜索文件和剪贴板</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文件、备注、文案、色值"
            className="zone-search-input"
          />
          <kbd className="zone-search-hint" aria-hidden>/</kbd>
        </label>
      </div>
      <div className="zone-scroll mt-3 zone-sections flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto pr-1">
        {workspace ? <ProjectBrief /> : null}
        <PackageBar onStatus={setStatus} />
        {workspace ? <ImportMode /> : null}
        <RulesPanel onStatus={setStatus} />
        <FileSection
          query={query}
          dragging={dragging}
          dragShelf={dragShelf}
          packaged={Boolean(packageSession())}
          motion={motion}
          hidden={collapsed}
          onAdd={() => (desktop ? void addByDialog() : fileRef.current?.click())}
          onOpen={(file) => void launchFile(file)}
          onStatus={setStatus}
          onKeepColor={(hex) => setStatus(clipResultMessage(addClipText(hex), "color"))}
        />
        <ClipSection
          query={query}
          filter={clipFilter}
          onFilter={setClipFilter}
          paused={capturePaused}
          onRead={() => void readClipboard()}
          onStatus={setStatus}
        />
      </div>
      <p className="pt-2 text-xs text-faint" aria-live="polite">
        {status}
      </p>
      {intake ? (
        <div className="flex flex-col gap-1 pt-2">
          <p className="text-xs text-muted">
            {intake.files.length} 个文件。放进项目包？
            {intake.files.some((file) => file.size > BIG_FILE) ? " 有超过 500 MB 的文件。" : ""}
          </p>
          <div className="flex flex-wrap gap-1">
            <Button variant="primary" className="min-w-0 flex-1" onClick={() => void commitIntake("copy")}>
              复制进来
            </Button>
            <Button variant="quiet" className="min-w-0 flex-1" onClick={() => void commitIntake("move")}>
              移动进来
            </Button>
            <Button variant="quiet" className="min-w-0 flex-1" onClick={() => void commitIntake("link")}>
              只记录路径
            </Button>
            <Button variant="ghost" onClick={() => setIntake(null)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <p className="text-xs text-faint">/ 搜索 · ` 收起</p>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            onClick={() => {
              resetDemo();
              setStatus("已恢复示例工作区。");
              setQuery("");
            }}
          >
            恢复示例
          </Button>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        className="sr-only"
        onChange={(event) => {
          const list = [...(event.target.files ?? [])];
          event.target.value = "";
          void receiveFiles(list, null);
        }}
      />
      {desktop && toast ? <p className="zone-toast">{toast}</p> : null}
      </div>
      {!desktop && toast ? <p className="zone-toast">{toast}</p> : null}
    </aside>
  );
}

function WorkspaceBar({ workspaceId, onStatus }: { workspaceId: string; onStatus: (message: string) => void }) {
  const workspaces = useZone((s) => s.workspaces);
  const setActive = useZone((s) => s.setActiveWorkspace);
  const addWorkspace = useZone((s) => s.addWorkspace);
  const renameWorkspace = useZone((s) => s.renameWorkspace);
  const removeWorkspace = useZone((s) => s.removeWorkspace);
  const current = workspaces.find((w) => w.id === workspaceId);
  const setProgress = useZone((s) => s.setProgress);
  const [open, setOpen] = useState(false);
  const [armDelete, setArmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(current?.name ?? "");
  const [recent, setRecent] = useState<RecentPackage[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const commitLock = useRef(false);

  useEffect(() => {
    setDraft(current?.name ?? "");
  }, [current?.name]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setArmDelete(false);
      }
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  if (!current) return null;

  function commitWorkspace() {
    if (commitLock.current) return;
    commitLock.current = true;
    const title = draft.trim();
    if (creating) {
      if (title) addWorkspace(title);
      setCreating(false);
    } else if (renaming) {
      if (title) renameWorkspace(current!.id, title);
      setRenaming(false);
    }
    window.setTimeout(() => {
      commitLock.current = false;
    }, 0);
  }

  const stageFolder = current.folders.find((folder) => folder.id === current.currentStageId);
  const stage = stageTone(stageFolder?.name);
  const stageLabel = stage.label || stageFolder?.name || "";

  return (
    <div ref={boxRef} className="zone-project-head relative">
      <div className="zone-project-row flex items-center gap-1.5">
        {creating || renaming ? (
          <form
            className="min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              commitWorkspace();
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitWorkspace}
              aria-label={creating ? "新工作区名称" : "工作区名称"}
              placeholder={creating ? "新工作区" : "工作区名称"}
              className="zone-project-title-input w-full outline-none"
            />
          </form>
        ) : (
          <button
            type="button"
            className="zone-project-title min-w-0 flex-1"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label="切换工作区"
            onClick={() => {
              setArmDelete(false);
              setRecent(recentPackages());
              setOpen((value) => !value);
            }}
          >
            <span className="zone-project-name truncate">
              {current.name}
              {current.archived ? " · 已归档" : ""}
            </span>
            <ChevronDown className="zone-project-chevron size-4 shrink-0" aria-hidden />
          </button>
        )}
        {stageLabel ? (
          <span className="zone-stage-chip" data-stage={stage.tone}>
            {stageLabel}
          </span>
        ) : null}
        {!creating && !renaming ? (
          <Button
            size="icon"
            variant="ghost"
            className="zone-head-icon"
            aria-label="重命名工作区"
            onClick={() => {
              setDraft(current.name);
              setRenaming(true);
            }}
          >
            <PenTool className="size-3.5" />
          </Button>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          className="zone-head-icon"
          aria-label="新建工作区"
          onClick={() => {
            setDraft("");
            setCreating(true);
            setOpen(false);
          }}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      <label className="zone-project-progress">
        <span className="sr-only">当前进度</span>
        <input
          key={`${current.id}:${current.progress ?? ""}`}
          defaultValue={current.progress ?? ""}
          aria-label="当前进度"
          placeholder="写一句当前进度…"
          maxLength={80}
          className="zone-project-progress-input"
          onBlur={(event) => setProgress(event.target.value)}
        />
      </label>
      {open ? (
        <ul className="zone-menu absolute top-full right-0 left-0 z-20 mt-1 rounded-md border border-line bg-raised p-1" role="listbox">
          {workspaces.map((ws) => (
            <li key={ws.id}>
              <button
                type="button"
                role="option"
                aria-selected={ws.id === current.id}
                className={cn("zone-menu-item", ws.id === current.id && "is-current")}
                onClick={() => {
                  setActive(ws.id);
                  setOpen(false);
                }}
              >
                <span className="truncate">
                  {ws.name}
                  {ws.archived ? " · 已归档" : ""}
                  {ws.packageId ? " · 项目包" : ""}
                </span>
                {ws.id === current.id ? <Check className="zone-menu-check size-4 shrink-0" aria-hidden="true" /> : null}
              </button>
            </li>
          ))}
          {recent.length > 0 ? (
            <>
              <li className="px-3 pt-2 text-xs text-faint">最近的项目包</li>
              {recent.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="zone-menu-item"
                    onClick={() => {
                      setOpen(false);
                      void openRecentPackage(item.id)
                        .then(onStatus)
                        .catch((error: unknown) => onStatus(error instanceof Error ? error.message : "打不开这个项目包。"));
                    }}
                  >
                    <span className="truncate">{item.name}</span>
                  </button>
                </li>
              ))}
            </>
          ) : null}
          <li role="separator" className="zone-menu-sep" aria-hidden="true" />
          <li role="presentation">
            <button
              type="button"
              className="zone-menu-action"
              onClick={() => {
                setDraft("");
                setCreating(true);
                setOpen(false);
              }}
            >
              <Plus className="size-4 shrink-0" aria-hidden="true" />
              <span>新建工作区</span>
            </button>
          </li>
          <li role="presentation">
            <button
              type="button"
              className="zone-menu-action"
              onClick={() => {
                setDraft(current.name);
                setRenaming(true);
                setOpen(false);
              }}
            >
              <Pencil className="size-4 shrink-0" aria-hidden="true" />
              <span>重命名工作区</span>
            </button>
          </li>
          {workspaces.length > 1 ? (
            <>
              <li role="separator" className="zone-menu-sep zone-menu-sep-soft" aria-hidden="true" />
              <li role="presentation">
                <button
                  type="button"
                  className={cn("zone-menu-action is-danger", armDelete && "is-armed")}
                  onClick={() => {
                    if (!armDelete) {
                      setArmDelete(true);
                      return;
                    }
                    removeWorkspace(current.id);
                    setArmDelete(false);
                    setOpen(false);
                  }}
                >
                  <Trash2 className="size-4 shrink-0" aria-hidden="true" />
                  <span>{armDelete ? "再点一次删除" : "删除此工作区"}</span>
                </button>
              </li>
            </>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function RulesPanel({ onStatus }: { onStatus: (message: string) => void }) {
  const workspaces = useZone((s) => s.workspaces);
  const activeId = useZone((s) => s.activeWorkspaceId);
  const addRule = useZone((s) => s.addRule);
  const removeRule = useZone((s) => s.removeRule);
  const workspace = workspaces.find((w) => w.id === activeId);
  const [open, setOpen] = useState(false);
  const [match, setMatch] = useState("");
  const [purpose, setPurpose] = useState<ClassRule["purpose"]>("active");
  if (!workspace) return null;
  const rules = workspace.rules ?? [];

  return (
    <section>
      <button
        type="button"
        className="zone-section-title flex h-11 w-full items-center gap-2 rounded-md px-1 text-left text-sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown className="size-4 text-faint" /> : <ChevronRight className="size-4 text-faint" />}
        <span className="font-medium">规则</span>
        <span className="text-xs text-faint">{rules.length}</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2 px-1 pb-1">
          <ul className="flex flex-col gap-1">
            {BUILTIN_NOTES.map((note) => (
              <li key={note} className="text-xs text-muted">
                {note}
              </li>
            ))}
            {rules.map((rule) => (
              <li key={rule.id} className="flex min-h-11 items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  「{rule.match}」→ {RULE_STAGE[rule.purpose]}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`删除规则${rule.match}`}
                  onClick={() => {
                    removeRule(rule.id);
                    onStatus(`已删除规则「${rule.match}」。未固定的文件已按剩下的规则重排。`);
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
          <form
            className="flex flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              const text = match.trim().toLowerCase();
              if (!text) return;
              if (addRule(text, purpose) === "short") {
                onStatus("规则至少两个字；纯英文至少三个字母，避免 a、re 这种误伤。");
                return;
              }
              setMatch("");
              onStatus(`之后文件名含「${text}」会盖过扩展名，放进${RULE_STAGE[purpose]}。已在同名文件夹里的不动。未固定的文件已重排。`);
            }}
          >
            <input
              value={match}
              onChange={(event) => setMatch(event.target.value)}
              placeholder="至少两个字，例如 手板 或 step"
              aria-label="规则关键词"
              className="h-11 rounded-md bg-raised px-3 text-sm outline-none placeholder:text-faint"
            />
            <div className="flex gap-1">
              <select
                value={purpose}
                aria-label="放入的层"
                onChange={(event) => setPurpose(event.target.value as ClassRule["purpose"])}
                className="h-11 min-w-0 flex-1 rounded-md bg-raised px-3 text-sm outline-none"
              >
                {(Object.keys(RULE_STAGE) as ClassRule["purpose"][]).map((key) => (
                  <option key={key} value={key}>
                    {RULE_STAGE[key]}
                  </option>
                ))}
              </select>
              <Button type="submit" variant="primary" disabled={!match.trim()}>
                添加规则
              </Button>
            </div>
          </form>
          <p className="text-xs text-faint">同名父文件夹优先。你的关键词盖过扩展名。拖进某一层后就固定，不再自动搬走。</p>
        </div>
      ) : null}
    </section>
  );
}

function ProjectBrief() {
  const workspace = useZone((s) => s.workspaces.find((item) => item.id === s.activeWorkspaceId) ?? s.workspaces[0]);
  const files = useZone((s) => s.files);
  if (!workspace) return null;
  const brief = resumeBrief(workspace, files);
  if (!brief) return null;
  return (
    <section className="flex flex-col gap-1" aria-label="进度摘要">
      <div className="rounded-md bg-raised px-3 py-2 text-xs text-muted">
        <p className="text-paper">上次做到哪 · {brief.stageName}</p>
        {brief.files.length > 0 ? <p className="mt-1 truncate">最近打开 {brief.files.join("、")}</p> : null}
        {brief.todos.map((todo) => (
          <p key={todo} className="mt-1 truncate">未完成 · {todo}</p>
        ))}
      </div>
    </section>
  );
}

function ImportMode() {
  const workspace = useZone((s) => s.workspaces.find((item) => item.id === s.activeWorkspaceId) ?? s.workspaces[0]);
  const setIngestMode = useZone((s) => s.setIngestMode);
  const setStoreDir = useZone((s) => s.setStoreDir);
  if (!workspace) return null;
  const mode = workspace.ingestMode ?? "copy";
  const modes = (["copy", "move", "link"] as const).map((value) => [value, MODE_LABEL[value]] as const);
  const live = packageSession();
  const inPackage = Boolean(live && live.packageId === workspace.packageId);
  const canPick = isDesktop() && !inPackage && mode !== "link";
  const dir = workspace.storeDir?.trim();
  const where =
    mode === "link"
      ? null
      : inPackage
        ? "文件会存进打开的项目包里"
        : !isDesktop()
          ? "浏览器里写不进你的电脑，先新建项目包才会真的放进去"
          : dir
            ? `存到：${dir}`
            : "还没选存放文件夹，第一次放文件时会让你选";
  async function chooseDir() {
    const picked = await pickFolder(`选一个文件夹，存放「${workspace?.name ?? ""}」的文件`);
    if (!picked || !workspace) return;
    setStoreDir(workspace.id, picked);
    window.dispatchEvent(new CustomEvent("zone-status", { detail: `存放文件夹已设为 ${picked}。已经放进去的文件不会搬动。` }));
  }
  return (
    <section className="zone-import flex flex-col gap-2" aria-label="导入方式">
      <div className="flex items-baseline justify-between gap-2">
        <span className="zone-import-title">导入方式</span>
        <span className="zone-import-note">拖文件进来时默认这样存</span>
      </div>
      <div role="radiogroup" aria-label="导入方式" className="zone-seg">
        {modes.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            className="zone-seg-item"
            onClick={() => setIngestMode(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="zone-import-hint" aria-live="polite">
        {MODE_HINT[mode]}
      </p>
      {where ? (
        <div className="zone-import-where">
          <span className="zone-import-path" title={dir || where}>
            {where}
          </span>
          {canPick ? (
            <button type="button" className="zone-import-pick" onClick={() => void chooseDir()}>
              {dir ? "更改" : "选择"}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function FileSection({
  query,
  dragging,
  dragShelf,
  packaged,
  motion,
  hidden,
  onAdd,
  onOpen,
  onStatus,
  onKeepColor,
}: {
  query: string;
  dragging: boolean;
  dragShelf: string | null;
  packaged: boolean;
  motion: MotionLevel;
  hidden: boolean;
  onAdd: () => void;
  onOpen: (file: ZoneFile) => void;
  onStatus: (message: string) => void;
  onKeepColor: (hex: string) => void;
}) {
  const workspaces = useZone((s) => s.workspaces);
  const activeId = useZone((s) => s.activeWorkspaceId);
  const files = useZone((s) => s.files);
  const addFolder = useZone((s) => s.addFolder);
  const renameFolder = useZone((s) => s.renameFolder);
  const moveFolder = useZone((s) => s.moveFolder);
  const removeFolder = useZone((s) => s.removeFolder);
  const moveFile = useZone((s) => s.moveFile);
  const togglePinFile = useZone((s) => s.togglePinFile);
  const removeFile = useZone((s) => s.removeFile);
  const setFileTags = useZone((s) => s.setFileTags);
  const focusStage = useZone((s) => s.focusStage);
  const confirmStage = useZone((s) => s.confirmStage);
  const reopenStage = useZone((s) => s.reopenStage);
  const resetStages = useZone((s) => s.resetStages);
  const workspace = workspaces.find((item) => item.id === activeId);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<{ parentId: string | null; name: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [armDelete, setArmDelete] = useState<string | null>(null);
  const [armReset, setArmReset] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<Kind | "all">("all");
  const [overId, setOverId] = useState<string | null>(null);
  const [landedId, setLandedId] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const knownFiles = useRef<Set<string>>(new Set());
  const commitLock = useRef(false);
  const skipRename = useRef(false);
  const shipLock = useRef(false);
  const [shipToken, setShipToken] = useState(0);

  const needle = query.trim().toLowerCase();
  const folders = workspace?.folders ?? [];
  const rules = workspace?.rules ?? [];
  const wsFiles = files.filter((file) => file.workspaceId === workspace?.id);
  const visibleFiles = wsFiles.filter((file) => (kindFilter === "all" || file.kind === kindFilter) && (!needle || fileMatches(file, needle, folders)));
  const kinds = KIND_ORDER.filter((kind) => wsFiles.some((file) => file.kind === kind));

  useEffect(() => {
    const ids = wsFiles.map((file) => file.id);
    if (knownFiles.current.size === 0) {
      ids.forEach((id) => knownFiles.current.add(id));
      return;
    }
    const born = ids.filter((id) => !knownFiles.current.has(id));
    if (born.length === 0) return;
    born.forEach((id) => knownFiles.current.add(id));
    setFresh((prev) => new Set([...prev, ...born]));
    const timer = window.setTimeout(() => {
      setFresh((prev) => {
        const next = new Set(prev);
        born.forEach((id) => next.delete(id));
        return next;
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [wsFiles]);

  const deliveryDone = Boolean(
    workspace &&
      workspace.folders.some(
        (folder) => folder.parentId == null && /交付/.test(folder.name) && (workspace.doneStageIds ?? []).includes(folder.id),
      ),
  );

  useEffect(() => {
    if (!armReset) return;
    const timer = window.setTimeout(() => setArmReset(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armReset]);

  useEffect(() => {
    setArmReset(false);
  }, [workspace?.id]);

  useEffect(() => {
    if (!workspace || !deliveryDone) return;
    localStorage.setItem(shipSeenKey(workspace.id), "1");
  }, [workspace, deliveryDone]);

  if (!workspace) return null;
  const stage = stageCursor(workspace);
  const stageLabel = stageActionLabel(workspace);

  function beginShip() {
    if (!workspace || shipLock.current) return;
    localStorage.setItem(shipSeenKey(workspace.id), "1");
    if (effectiveMotion(motion) === "off") return;
    shipLock.current = true;
    setShipToken((value) => value + 1);
  }
  const inUse = visibleFiles
    .filter((file) => !isRhinoBackup(file.name) && file.openedAt != null && Date.now() - file.openedAt < IN_USE_MS)
    .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
  const loosePeers = versionCards(
    wsFiles.filter((file) => !folders.some((folder) => folder.id === file.folderId) && (kindFilter === "all" || file.kind === kindFilter)),
  ).sort((a, b) => sortFiles(a.head, b.head));
  const looseCards = loosePeers.filter((card) => !needle || card.members.some((file) => fileMatches(file, needle, folders)));

  function commitDraft() {
    if (!draft || commitLock.current) return;
    commitLock.current = true;
    const title = draft.name.trim();
    const parentId = draft.parentId;
    if (title) {
      addFolder(title, parentId);
      void ensurePackedFolder(parentId, title);
    }
    setDraft(null);
    window.setTimeout(() => {
      commitLock.current = false;
    }, 0);
  }

  function renderBranch(parentId: string | null, depth: number): ReactNode {
    const nodes = folders.filter((folder) => folder.parentId === parentId);
    return nodes.map((folder, index) => {
      const peers = versionCards(wsFiles.filter((file) => file.folderId === folder.id && (kindFilter === "all" || file.kind === kindFilter))).sort(
        (a, b) => sortFiles(a.head, b.head),
      );
      const cards = peers.filter((card) => !needle || card.members.some((file) => fileMatches(file, needle, folders)));
      const childCount = folders.filter((item) => item.parentId === folder.id).length;
      const folded = closed[folder.id] ?? false;
      const isClosed = folded && !needle;
      return (
        <div
          key={folder.id}
          className={cn("tree-node", depth > 0 && "ml-3 border-l border-line pl-2")}
          style={{ ["--i" as string]: index }}
        >
          <section
            data-folder-id={folder.id}
            className={cn("rounded-md", (dragShelf === folder.id || overId === folder.id) && "drop-well", landedId === folder.id && "did-land")}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (overId !== folder.id) setOverId(folder.id);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node)) return;
              setOverId((id) => (id === folder.id ? null : id));
            }}
            onDrop={(event) => {
              const movingFile = event.dataTransfer.getData("application/x-zone-file");
              const movingFolder = event.dataTransfer.getData("application/x-zone-folder");
              if (!movingFile && !movingFolder) return;
              event.preventDefault();
              event.stopPropagation();
              setOverId(null);
              setLandedId(folder.id);
              window.setTimeout(() => setLandedId((id) => (id === folder.id ? null : id)), 320);
              if (movingFile) {
                for (const id of movingFile.split(",").filter(Boolean)) moveFile(id, folder.id);
                onStatus("已移过去，之后不再自动归类。");
              } else if (movingFolder && movingFolder !== folder.id) {
                moveFolder(movingFolder, folder.id);
              }
            }}
          >
            <div
              className="lift-card flex items-center gap-1 rounded-md"
              draggable
              onPointerMove={trackGlow}
              onDragStart={(event) => {
              event.stopPropagation();
              event.currentTarget.classList.add("is-lifted");
              event.dataTransfer.setData("application/x-zone-folder", folder.id);
              event.dataTransfer.effectAllowed = "move";
            }}
              onDragEnd={(event) => event.currentTarget.classList.remove("is-lifted")}
            >
              {renaming === folder.id ? (
                <input
                  autoFocus
                  defaultValue={folder.name}
                  aria-label="文件夹名称"
                  className="h-11 min-w-0 flex-1 rounded-md bg-raised px-3 text-sm outline-none"
                  onBlur={(event) => {
                    if (skipRename.current) {
                      skipRename.current = false;
                      setRenaming(null);
                      return;
                    }
                    const title = event.target.value.trim();
                    const previous = folder.name;
                    setRenaming(null);
                    if (!title || title === previous) return;
                    void (async () => {
                      const ok = await renamePackedFolder(folder.id, previous, title);
                      if (!ok) {
                        onStatus("文件夹没有改名，项目包里的目录还是原来的名字。");
                        return;
                      }
                      renameFolder(folder.id, title);
                    })();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      skipRename.current = true;
                      setRenaming(null);
                      event.currentTarget.blur();
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm"
                  aria-expanded={!isClosed}
                  onClick={() => setClosed((prev) => ({ ...prev, [folder.id]: !folded }))}
                  onDoubleClick={() => setRenaming(folder.id)}
                >
                  {isClosed ? <ChevronRight className="size-4 text-faint" /> : <ChevronDown className="size-4 text-faint" />}
                  <span className="truncate font-medium">{folder.name}</span>
                  {folder.parentId == null && stage.done.has(folder.id) ? (
                    <span className="text-xs text-faint">已确认</span>
                  ) : folder.parentId == null && folder.id === stage.current?.id ? (
                    <span className="text-xs text-faint">当前</span>
                  ) : null}
                  <span className="text-xs text-faint">{cards.length + childCount}</span>
                </button>
              )}
              <Button size="icon" variant="ghost" aria-label={`在${folder.name}里新建分组`} onClick={() => setDraft({ parentId: folder.id, name: "" })}>
                <Plus className="size-4" />
              </Button>
              <Button size="icon" variant="ghost" aria-label={`删除${folder.name}`} onClick={() => setPendingDelete(folder.id)}>
                <Trash2 className="size-4" />
              </Button>
            </div>
            {pendingDelete === folder.id ? (
              <div className="mb-1 flex flex-wrap gap-1 px-2">
                <Button variant="quiet" onClick={() => {
                  removeFolder(folder.id, true);
                  setPendingDelete(null);
                  onStatus(`${folder.name}已从清单拿掉，文件还在原来的位置。`);
                }}>
                  只去掉记录
                </Button>
                <Button variant="quiet" onClick={() => {
                  const ids = new Set(descendantIds(folders, folder.id));
                  const victims = useZone.getState().files.filter((file) => file.workspaceId === workspace?.id && ids.has(file.folderId));
                  const snapshot = snapshotForRemoval(workspace?.id, victims);
                  for (const victim of victims) forgetFile(victim.id);
                  removeFolder(folder.id, true);
                  setPendingDelete(null);
                  onStatus(`${folder.name}已从清单拿掉，正在移到回收站…`);
                  trashInBackground(victims, snapshot, onStatus, (message) => `${folder.name}已从清单拿掉。${message}`);
                }}>
                  同时删除文件
                </Button>
                <Button variant="quiet" onClick={() => { removeFolder(folder.id, false); setPendingDelete(null); onStatus(`${folder.name}已删除，内容留在上一级。`); }}>
                  只删除这一层
                </Button>
                <Button variant="quiet" onClick={() => setPendingDelete(null)}>取消</Button>
              </div>
            ) : null}
            {draft?.parentId === folder.id ? (
              <form className="mb-1" onSubmit={(event) => { event.preventDefault(); commitDraft(); }}>
                <input
                  autoFocus
                  value={draft.name}
                  onChange={(event) => setDraft({ parentId: folder.id, name: event.target.value })}
                  onBlur={commitDraft}
                  placeholder="分组名称"
                  aria-label="分组名称"
                  className="h-11 w-full rounded-md bg-raised px-3 text-sm outline-none"
                />
              </form>
            ) : null}
            {isClosed ? null : (
              <FolderFiles
                cards={cards}
                peers={peers}
                folders={folders}
                rules={rules}
                expanded={expanded}
                armDelete={armDelete}
                fresh={fresh}
                needle={needle}
                onExpand={setExpanded}
                onArm={setArmDelete}
                onOpen={onOpen}
                onMove={moveFile}
                onPin={togglePinFile}
                onKeepColor={onKeepColor}
                onTags={setFileTags}
                onNote={(id, note) => useZone.getState().setFileNote(id, note)}
                onStatus={onStatus}
                onRemove={(id) => {
                  forgetFile(id);
                  removeFile(id);
                  setExpanded(null);
                  setArmDelete(null);
                  onStatus("只去掉了记录，文件还在原来的位置。");
                }}
                onTrash={(id) => {
                  const target = useZone.getState().files.find((item) => item.id === id);
                  setExpanded(null);
                  setArmDelete(null);
                  if (!target) {
                    onStatus("只去掉了记录，文件还在原来的位置。");
                    return;
                  }
                  const snapshot = snapshotForRemoval(target.workspaceId, [target]);
                  forgetFile(id);
                  removeFile(id);
                  onStatus("记录已拿掉，正在移到回收站…");
                  trashInBackground([target], snapshot, onStatus, (message) => message);
                }}
              />
            )}
          </section>
          {isClosed ? null : renderBranch(folder.id, depth + 1)}
        </div>
      );
    });
  }

  return (
    <section>
      <div className="zone-sticky sticky top-0 z-10 mb-1 flex items-center gap-1 rounded-md px-1">
        <h2 className="zone-section-title flex h-11 min-w-0 flex-1 items-center gap-2 px-2 text-md font-medium tracking-tight text-paper">
          文件
          <span className="num text-sm text-faint">{wsFiles.filter((file) => !isRhinoBackup(file.name)).length}</span>
        </h2>
        <Button size="sm" variant="quiet" className="bg-panel hover:bg-desk" onClick={onAdd}>
          <FilePlus className="size-3.5" aria-hidden="true" />
          添加
        </Button>
        <Button size="icon" variant="ghost" className="size-8 rounded-sm bg-panel hover:bg-desk" aria-label="新建阶段" title="新建阶段" onClick={() => setDraft({ parentId: null, name: "" })}>
          <Plus className="size-3.5" />
        </Button>
      </div>
      <div className="mb-2">
        <ChipRail signature={kindFilter} className="flex flex-wrap gap-1" label="按种类筛选">
          <FilterChip active={kindFilter === "all"} onClick={() => setKindFilter("all")}>全部</FilterChip>
          {kinds.map((kind) => (
            <FilterChip key={kind} active={kindFilter === kind} onClick={() => setKindFilter(kind)}>{KIND_LABEL[kind]}</FilterChip>
          ))}
        </ChipRail>
      </div>
      {wsFiles.length === 0 ? (
        <EmptyMark title="这一层还空着" hint="把文件拖进来，会按文件夹、扩展名和关键词归好。" />
      ) : null}
      {needle && visibleFiles.length === 0 ? (
        <p className="swap-in mb-2 text-sm text-muted">没有对得上的文件。</p>
      ) : null}
      {inUse.length > 0 ? (
        <div className="mb-2">
          <p className="zone-sub px-2 pb-1 text-xs text-faint">正在使用</p>
          <div className="flex gap-1 overflow-x-auto">
            {inUse.map((file) => (
              <button key={file.id} type="button" className="h-11 shrink-0 rounded-md bg-raised px-3 text-sm" onClick={() => onOpen(file)}>
                {file.stale ? "失效 · " : ""}
                {file.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {dragging ? (
        <p className="mb-2 rounded-md border border-dashed border-paper px-3 py-2 text-xs text-muted">
          {dragShelf ? "松手放入这一层，并固定不再自动搬走。" : packaged && !isDesktop() ? "松手后选择复制、移动或只记录路径。默认是复制。" : "松手后按文件夹、扩展名和关键词归类，并写明原因。"}
        </p>
      ) : null}
      {draft?.parentId === null ? (
        <form className="mb-2" onSubmit={(event) => { event.preventDefault(); commitDraft(); }}>
          <input
            autoFocus
            value={draft.name}
            onChange={(event) => setDraft({ parentId: null, name: event.target.value })}
            onBlur={commitDraft}
            placeholder="阶段名称"
            aria-label="阶段名称"
            className="h-11 w-full rounded-md bg-raised px-3 text-sm outline-none"
          />
        </form>
      ) : null}
      {stage.roots.length > 0 ? (
        <div className="mb-2 flex min-w-0 flex-col gap-2">
          <StageRail
            key={workspace.id}
            roots={stage.roots}
            currentId={stage.current?.id}
            done={stage.done}
            counts={Object.fromEntries(stage.roots.map((folder) => [folder.id, openTodoCount(boardFor(workspace, folder.id))]))}
            shipToken={shipToken}
            motion={effectiveMotion(motion)}
            shipped={deliveryDone}
            hidden={hidden}
            onReplay={beginShip}
            onShipHold={() => {
              shipLock.current = true;
            }}
            onShipEnd={() => {
              shipLock.current = false;
            }}
            onPick={(id) => {
              setArmReset(false);
              if (stage.done.has(id)) {
                const result = reopenStage(id);
                setClosed((prev) => ({ ...prev, [id]: false }));
                onStatus(result.message);
                return;
              }
              focusStage(id);
              setClosed((prev) => ({ ...prev, [id]: false }));
              onStatus(`现在是${stage.roots.find((folder) => folder.id === id)?.name ?? ""}`);
            }}
          />
          {stageLabel ? (
            <Button
              variant="primary"
              className="h-auto min-h-11 w-full whitespace-normal px-3 py-2 text-center"
              onClick={() => {
                const finishing = Boolean(stage.current && !stage.done.has(stage.current.id) && /交付/.test(stage.current.name));
                const result = confirmStage();
                if (result.openId) setClosed((prev) => ({ ...prev, [result.openId as string]: false }));
                onStatus(result.message);
                if (finishing && !localStorage.getItem(shipSeenKey(workspace.id))) beginShip();
              }}
            >
              {stageLabel}
            </Button>
          ) : (
            <div className="stage-done-row">
              <p className="text-xs text-faint">各阶段都已确认。</p>
              <button
                type="button"
                className={cn("stage-reset", armReset && "is-armed")}
                onBlur={() => setArmReset(false)}
                onClick={() => {
                  if (!armReset) {
                    setArmReset(true);
                    return;
                  }
                  const result = resetStages();
                  localStorage.removeItem(shipSeenKey(workspace.id));
                  if (result.openId) setClosed((prev) => ({ ...prev, [result.openId as string]: false }));
                  setArmReset(false);
                  onStatus(result.message);
                }}
              >
                <RotateCcw className="size-3" aria-hidden="true" />
                <span>{armReset ? "再点一次重置" : "重置阶段"}</span>
              </button>
            </div>
          )}
          {stage.current ? <StagePad folderId={stage.current.id} name={stage.current.name} /> : null}
        </div>
      ) : (
        <p className="mb-2 rounded-md bg-raised px-3 py-4 text-sm text-muted">还没有阶段。新项目会先放上草图、建模、渲染、交付。</p>
      )}
      <div key={needle} className="swap-in flex flex-col gap-1">{renderBranch(null, 0)}</div>
      {looseCards.length > 0 ? (
        <div className="mt-2">
          <p className="zone-sub px-2 pb-1 text-xs text-faint">未归类</p>
          <FolderFiles
            cards={looseCards}
            peers={loosePeers}
            folders={folders}
            rules={rules}
            expanded={expanded}
            armDelete={armDelete}
            fresh={fresh}
            needle={needle}
            onExpand={setExpanded}
            onArm={setArmDelete}
            onOpen={onOpen}
            onMove={moveFile}
            onPin={togglePinFile}
            onKeepColor={onKeepColor}
            onTags={setFileTags}
            onNote={(id, note) => useZone.getState().setFileNote(id, note)}
            onStatus={onStatus}
            onRemove={(id) => {
              forgetFile(id);
              removeFile(id);
              onStatus("只去掉了记录，文件还在原来的位置。");
            }}
            onTrash={(id) => {
              const target = useZone.getState().files.find((item) => item.id === id);
              if (!target) {
                onStatus("只去掉了记录，文件还在原来的位置。");
                return;
              }
              const snapshot = snapshotForRemoval(target.workspaceId, [target]);
              forgetFile(id);
              removeFile(id);
              onStatus("记录已拿掉，正在移到回收站…");
              trashInBackground([target], snapshot, onStatus, (message) => message);
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

function fileMatches(file: ZoneFile, needle: string, folders: Folder[]): boolean {
  return [file.name, file.note ?? "", file.path ?? "", folderPath(folders, file.folderId), file.tags.join(" "), file.dominant ?? "", KIND_LABEL[file.kind], ROLE_LABEL[file.role]]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

function sortFiles(a: ZoneFile, b: ZoneFile): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const ao = a.openedAt ?? 0;
  const bo = b.openedAt ?? 0;
  if (ao !== bo) return bo - ao;
  return b.createdAt - a.createdAt;
}

function FolderFiles({
  cards,
  peers,
  folders,
  rules,
  expanded,
  armDelete,
  fresh,
  needle,
  onExpand,
  onArm,
  onOpen,
  onMove,
  onPin,
  onKeepColor,
  onTags,
  onNote,
  onStatus,
  onRemove,
  onTrash,
}: {
  cards: VersionCard[];
  peers: VersionCard[];
  folders: Folder[];
  rules: ClassRule[];
  expanded: string | null;
  armDelete: string | null;
  fresh: Set<string>;
  needle: string;
  onExpand: (id: string | null) => void;
  onArm: (id: string | null) => void;
  onOpen: (file: ZoneFile) => void;
  onMove: (id: string, folderId: string) => void;
  onPin: (id: string) => void;
  onKeepColor: (hex: string) => void;
  onTags: (id: string, tags: string[]) => void;
  onNote: (id: string, note: string) => void;
  onStatus: (message: string) => void;
  onRemove: (id: string) => void;
  onTrash: (id: string) => void;
}) {
  const relinkFile = useZone((s) => s.relinkFile);
  const setVersionCurrent = useZone((s) => s.setVersionCurrent);
  const splitVersion = useZone((s) => s.splitVersion);
  const mergeVersionGroups = useZone((s) => s.mergeVersionGroups);
  const [menu, setMenu] = useState<{ x: number; y: number; file: ZoneFile } | null>(null);
  const [showBak, setShowBak] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  async function relocate(file: ZoneFile) {
    if (!isDesktop()) {
      onStatus("重新定位需要桌面版。");
      return;
    }
    const path = await pickFile();
    if (!path) return;
    const name = path.split(/[/\\]/).pop() || file.name;
    const size = await fileSize(path);
    const thumb = await imageThumb(path);
    relinkFile(file.id, { name, path, size: size ?? undefined, thumb: thumb ?? undefined });
  }

  if (cards.length === 0) return null;
  return (
    <div className="pb-1">
      <ul className="flex flex-col">
        {cards.map((card, index) => {
          const file = card.head;
          const Icon = KIND_ICON[file.kind];
          const placed = file.folderLocked ? null : placeFile({ name: file.name, path: file.path, folders, rules });
          const inUse = file.openedAt != null && Date.now() - file.openedAt < IN_USE_MS;
          const open = expanded === card.groupKey;
          const hex = file.dominant && isColor(file.dominant) ? file.dominant : undefined;
          const arrived = card.members.some((member) => fresh.has(member.id));
          const rows = card.members.filter((member) => showBak[card.groupKey] || !versionIdentity(member.name).backup);
          const others = peers.filter((peer) => peer.groupKey !== card.groupKey);
          return (
            <li
              key={card.groupKey}
              className={cn("lift-card tree-node rounded-sm", arrived && "arrive")}
              style={{ ["--i" as string]: index }}
              draggable
              onPointerMove={trackGlow}
              onDragStart={(event) => {
                event.stopPropagation();
                event.currentTarget.classList.add("is-lifted");
                event.dataTransfer.setData("application/x-zone-file", card.members.map((member) => member.id).join(","));
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={(event) => event.currentTarget.classList.remove("is-lifted")}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, file });
              }}
            >
              <div className="flex min-h-11 items-center gap-1 pr-1">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1 text-left"
                  onClick={() => onExpand(open ? null : card.groupKey)}
                  onDoubleClick={() => onOpen(file)}
                >
                  {file.thumb ? (
                    <img src={file.thumb} alt="" className="size-8 rounded-sm object-cover" />
                  ) : (
                    <span className={cn("kind-chip", `kind-${file.kind}`)}>
                      <Icon className="size-4" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1">
                      <span className={cn("min-w-0 flex-1 truncate text-sm", file.stale && "text-[#e15b4a]")}>{Mark({ text: file.name, needle })}</span>
                      {card.visibleCount > 1 ? <span className="ver-badge">共 {card.visibleCount} 版</span> : null}
                    </span>
                    <span className="block truncate text-xs text-faint">
                      {file.stale ? "失效 · " : ""}
                      {file.external ? "外部 · " : ""}
                      {inUse ? "在用 · " : ""}
                      {card.manual ? "当前版 · " : card.visibleCount > 1 ? "最新 · " : ""}
                      {file.folderLocked ? "已固定" : placed?.short || "自动归类"}
                      {" · "}
                      {ROLE_LABEL[file.role]}
                      {file.note ? (
                        <>
                          {" · "}
                          <Mark text={file.note} needle={needle} />
                        </>
                      ) : null}
                      {file.tags.length ? ` · ${file.tags.join(" ")}` : ""}
                    </span>
                  </span>
                </button>
                <Button size="icon" variant="ghost" aria-label={file.pinned ? "取消固定" : "固定"} aria-pressed={file.pinned} onClick={() => onPin(file.id)}>
                  <Pin className={cn("size-4", file.pinned ? "text-paper" : "text-faint")} />
                </Button>
              </div>
              {open ? (
                <div className="flex flex-col gap-1 px-2 pb-2">
                  <p className="text-xs text-muted">
                    {file.folderLocked ? "已固定在这一层，不再自动搬走。" : placed?.label}
                    {card.visibleCount > 1 ? " 旧版留在原处，没有改名。" : ""}
                  </p>
                  {card.visibleCount > 1 || card.backupCount > 0 ? (
                    <ul className="flex flex-col gap-1">
                      {rows.map((member) => {
                        const backup = versionIdentity(member.name).backup;
                        const when = member.modifiedAt ?? member.createdAt;
                        return (
                          <li key={member.id} className="rounded-md bg-raised px-2 py-1">
                            <p className="truncate text-sm text-paper">
                              {member.name}
                              {member.versionCurrent ? " · 当前" : member.id === file.id && !card.manual ? " · 最新" : ""}
                              {backup ? " · 备份" : ""}
                              {member.stale ? " · 失效" : ""}
                            </p>
                            <p className="text-xs text-faint">
                              {when ? formatWhen(when) : "时间未知"}
                              {member.size != null ? ` · ${formatBytes(member.size)}` : ""}
                            </p>
                            <div className="mt-1 flex flex-wrap gap-1">
                              <Button variant="quiet" onClick={() => onOpen(member)}>打开</Button>
                              <Button
                                variant="quiet"
                                disabled={backup || member.versionCurrent === true}
                                onClick={() => {
                                  setVersionCurrent(member.id);
                                  onStatus(`${member.name} 已设为当前版，之后不会被自动换掉。`);
                                }}
                              >
                                设为当前版
                              </Button>
                              <Button variant="quiet" disabled={!member.path} onClick={() => { if (member.path) void revealPath(member.path); }}>
                                在资源管理器中显示
                              </Button>
                              {card.members.length > 1 ? (
                                <Button
                                  variant="quiet"
                                  onClick={() => {
                                    splitVersion(member.id);
                                    onStatus(`${member.name} 已从这一组拆出。`);
                                  }}
                                >
                                  拆出
                                </Button>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  {card.backupCount > 0 ? (
                    <Button variant="quiet" onClick={() => setShowBak((prev) => ({ ...prev, [card.groupKey]: !prev[card.groupKey] }))}>
                      {showBak[card.groupKey] ? "隐藏 Rhino 备份" : `显示 Rhino 备份 ${card.backupCount}`}
                    </Button>
                  ) : null}
                  <div className="flex flex-wrap gap-1">
                    <Button variant="quiet" onClick={() => onOpen(file)}><Play className="size-4" />打开</Button>
                    <Button variant="quiet" onClick={() => void relocate(file)}>重新定位</Button>
                    {file.path ? <Button variant="quiet" onClick={() => void revealPath(file.path as string)}>在资源管理器中显示</Button> : null}
                    {file.path ? <Button variant="quiet" onClick={() => void copyText(file.path as string)}>复制路径</Button> : null}
                    {hex ? (
                      <Button variant="quiet" onClick={() => onKeepColor(hex)}>
                        <span className="size-4 rounded-xs border border-line" style={{ background: hex }} />
                        主色 {hex}
                      </Button>
                    ) : null}
                    <Button variant="quiet" onClick={() => { if (armDelete === `record:${file.id}`) onRemove(file.id); else onArm(`record:${file.id}`); }}>
                      {armDelete === `record:${file.id}` ? "再点一次，只去掉记录" : "移除记录"}
                    </Button>
                    <Button variant="quiet" className="zone-btn-danger" onClick={() => { if (armDelete === `trash:${file.id}`) onTrash(file.id); else onArm(`trash:${file.id}`); }}>
                      {armDelete === `trash:${file.id}` ? "再点一次，放进回收站" : "同时删除文件"}
                    </Button>
                  </div>
                  {others.length > 0 ? (
                    <label className="zone-field flex h-11 items-center gap-2 rounded-md bg-raised px-3">
                      <span className="shrink-0 text-xs text-faint">合并</span>
                      <select
                        aria-label={`把其他文件并进${file.name}`}
                        className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                        value=""
                        onChange={(event) => {
                          const other = others.find((peer) => peer.groupKey === event.target.value);
                          if (!other) return;
                          mergeVersionGroups([...card.members, ...other.members].map((member) => member.id));
                          onStatus(`已把 ${other.head.name} 并进 ${file.name}。`);
                        }}
                      >
                        <option value="">并进其他文件</option>
                        {others.map((peer) => (
                          <option key={peer.groupKey} value={peer.groupKey}>{peer.head.name}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label className="zone-field flex h-11 items-center gap-2 rounded-md bg-raised px-3">
                    <span className="shrink-0 text-xs text-faint">备注</span>
                    <input
                      key={`${file.id}:${file.note ?? ""}`}
                      defaultValue={file.note ?? ""}
                      aria-label={`${file.name}的备注`}
                      placeholder="差背景"
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
                      onBlur={(event) => onNote(file.id, event.target.value)}
                    />
                  </label>
                  <label className="zone-field flex h-11 items-center gap-2 rounded-md bg-raised px-3">
                    <span className="shrink-0 text-xs text-faint">移到</span>
                    <select
                      aria-label={`把${file.name}移到`}
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                      value={file.folderId}
                      onChange={(event) => {
                        for (const member of card.members) onMove(member.id, event.target.value);
                      }}
                    >
                      {folders.map((folder) => (
                        <option key={folder.id} value={folder.id}>{folderPath(folders, folder.id)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="zone-field flex h-11 items-center gap-2 rounded-md bg-raised px-3">
                    <span className="shrink-0 text-xs text-faint">标签</span>
                    <input
                      key={file.tags.join("|")}
                      defaultValue={file.tags.join(", ")}
                      aria-label={`${file.name}的标签`}
                      placeholder="用逗号分开"
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                      onBlur={(event) => onTags(file.id, event.target.value.split(/[,，]/))}
                    />
                  </label>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {menu ? (
        <div
          className="fixed z-30 min-w-44 rounded-md border border-line bg-panel p-1"
          style={{ left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 180) }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" className="block h-10 w-full rounded-sm px-3 text-left text-sm hover:bg-raised" onClick={() => { onOpen(menu.file); setMenu(null); }}>打开</button>
          <button type="button" className="block h-10 w-full rounded-sm px-3 text-left text-sm hover:bg-raised disabled:text-faint" disabled={!menu.file.path} onClick={() => { if (menu.file.path) void revealPath(menu.file.path); setMenu(null); }}>在资源管理器中显示</button>
          <button type="button" className="block h-10 w-full rounded-sm px-3 text-left text-sm hover:bg-raised disabled:text-faint" disabled={!menu.file.path} onClick={() => { if (menu.file.path) void copyText(menu.file.path); setMenu(null); }}>复制路径</button>
          <button type="button" className="block h-10 w-full rounded-sm px-3 text-left text-sm hover:bg-raised" onClick={() => { void relocate(menu.file); setMenu(null); }}>重新定位</button>
        </div>
      ) : null}
    </div>
  );
}

function ClipSection({
  query,
  filter,
  onFilter,
  paused,
  onRead,
  onStatus,
}: {
  query: string;
  filter: ClipKind | "all";
  onFilter: (kind: ClipKind | "all") => void;
  paused: boolean;
  onRead: () => void;
  onStatus: (message: string) => void;
}) {
  const clips = useZone((s) => s.clips);
  const addClipText = useZone((s) => s.addClipText);
  const touchClip = useZone((s) => s.touchClip);
  const togglePinClip = useZone((s) => s.togglePinClip);
  const removeClip = useZone((s) => s.removeClip);
  const setPaused = useZone((s) => s.setPaused);
  const ignoredApps = useZone((s) => s.ignoredApps);
  const setIgnoredApps = useZone((s) => s.setIgnoredApps);
  const [note, setNote] = useState("");
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; clip: Clip } | null>(null);
  const knownClips = useRef<Set<string>>(new Set());
  const dragLock = useRef(false);
  const needle = query.trim().toLowerCase();
  const kinds = (Object.keys(CLIP_LABEL) as ClipKind[]).filter((kind) => clips.some((clip) => clip.kind === kind));
  const filtered = clips
    .filter((clip) => filter === "all" || clip.kind === filter)
    .filter((clip) => !needle || `${clip.name} ${clip.text ?? ""} ${clip.dominant ?? ""} ${CLIP_LABEL[clip.kind]}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.usedAt - a.usedAt);

  useEffect(() => {
    const ids = clips.map((clip) => clip.id);
    if (knownClips.current.size === 0) {
      ids.forEach((id) => knownClips.current.add(id));
      return;
    }
    const born = ids.filter((id) => !knownClips.current.has(id));
    if (born.length === 0) return;
    born.forEach((id) => knownClips.current.add(id));
    setFresh((prev) => new Set([...prev, ...born]));
    const timer = window.setTimeout(() => {
      setFresh((prev) => {
        const next = new Set(prev);
        born.forEach((id) => next.delete(id));
        return next;
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [clips]);

  async function writeBack(clip: Clip) {
    if (dragLock.current) {
      dragLock.current = false;
      return;
    }
    touchClip(clip.id);
    try {
      if (isDesktop()) {
        if (clip.kind === "image" && clip.thumb) {
          await copyImage(clip.thumb, clip.originalPath);
          onStatus(clip.originalPath ? "已复制回去（原图）。" : "已复制回去。");
        } else {
          await copyText(clip.text ?? clip.dominant ?? clip.name);
          onStatus("已复制回去。");
        }
        return;
      }
      if (clip.kind === "image" && clip.thumb) {
        const blob = await thumbToPngBlob(clip.thumb);
        if (blob && typeof ClipboardItem !== "undefined") {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          onStatus("图片已复制回去。");
          return;
        }
      }
      const text = clip.text ?? clip.dominant ?? clip.name;
      await navigator.clipboard.writeText(text);
      onStatus("已复制回去。");
    } catch {
      onStatus("写不回剪贴板。");
    }
  }

  /** 导出文件名主干（不含序号与扩展名）：项目_阶段 或 剪贴板_日期。序号由 Rust 在目标目录递增。 */
  function clipFileName(_clip: Clip) {
    const sanitize = (raw: string) => {
      const cleaned = raw
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
        .replace(/[. ]+$/g, "")
        .trim();
      return cleaned.slice(0, 40) || "未命名";
    };
    const state = useZone.getState();
    const workspace =
      state.workspaces.find((item) => item.id === state.activeWorkspaceId) ?? state.workspaces[0];
    if (workspace?.name) {
      const stage =
        workspace.folders.find((folder) => folder.id === workspace.currentStageId)?.name ?? "阶段";
      return `${sanitize(workspace.name)}_${sanitize(stage)}`;
    }
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `剪贴板_${y}${m}${d}`;
  }

  async function saveClipImage(clip: Clip) {
    if (clip.kind !== "image" || !clip.thumb) {
      onStatus("只有图片可以另存为文件。");
      return;
    }
    if (!isDesktop()) {
      onStatus("另存为只在桌面版可用。");
      return;
    }
    touchClip(clip.id);
    try {
      const path = await clipSaveAs(clip.thumb, clipFileName(clip), clip.originalPath);
      onStatus(path ? `已另存为 ${path}` : "已取消另存为。");
    } catch (error) {
      onStatus(typeof error === "string" && error ? error : "另存为失败。");
    }
  }

  async function copyClipToProject(clip: Clip) {
    if (clip.kind !== "image" || !clip.thumb) {
      onStatus("只有图片可以复制到项目。");
      return;
    }
    if (!isDesktop()) {
      onStatus("复制到项目只在桌面版可用。");
      return;
    }
    const state = useZone.getState();
    const workspace = state.workspaces.find((item) => item.id === state.activeWorkspaceId) ?? state.workspaces[0];
    if (!workspace) {
      onStatus("还没有项目。");
      return;
    }
    const stageFolder =
      workspace.folders.find((folder) => folder.id === workspace.currentStageId) ??
      folderByName(workspace.folders, "草图");
    touchClip(clip.id);
    try {
      const tempPath = await clipWriteTemp(clip.thumb, clipFileName(clip), clip.originalPath);
      const result = await ingestPaths([tempPath], { shelfId: stageFolder?.id ?? null });
      onStatus(result.message || "已复制到当前项目。");
    } catch (error) {
      onStatus(typeof error === "string" && error ? error : "没能复制到项目。");
    }
  }

  function startImageDrag(clip: Clip) {
    if (clip.kind !== "image" || !clip.thumb || !isDesktop()) return;
    dragLock.current = true;
    touchClip(clip.id);
    void clipStartDrag(clip.thumb, clipFileName(clip), clip.originalPath)
      .catch((error) => {
        onStatus(typeof error === "string" && error ? error : "拖不出去。");
      })
      .finally(() => {
        window.setTimeout(() => {
          dragLock.current = false;
        }, 200);
      });
  }

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  function leaveNote() {
    const result: ClipResult = addClipText(note);
    if (result === "added" || result === "duplicate") setNote("");
    onStatus(clipResultMessage(result, result === "added" ? textKind(note) : undefined));
  }

  return (
    <section>
      <div className="zone-sticky sticky top-0 z-10 mb-1 flex items-center gap-1 rounded-md px-1">
        <h2 className="zone-section-title flex h-11 min-w-0 flex-1 items-center gap-2 px-2 text-md font-medium tracking-tight text-paper">
          剪贴板
          <span className="num text-sm text-faint">{clips.length}</span>
        </h2>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 rounded-sm bg-panel hover:bg-desk"
          aria-label={paused ? "继续记录" : "暂停"}
          aria-pressed={paused}
          onClick={() => {
            const next = !paused;
            setPaused(next);
            void setClipboardPaused(next);
          }}
        >
          {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
        </Button>
        <Button size="icon" variant="ghost" className="size-8 rounded-sm bg-panel hover:bg-desk" aria-label="读取剪贴板" onClick={onRead}>
          <ClipboardPaste className="size-3.5" />
        </Button>
      </div>
      <p className="px-1 text-xs text-faint">本页复制和 Ctrl+V 会留下。点读取并允许后，系统剪贴板也会自动跟上。图片可拖到桌面 / PPT，右键可另存为或复制到当前项目。</p>
      <form
        className="mt-1 flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (!note.trim()) return;
          leaveNote();
        }}
      >
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="记下一句、一个色值或链接"
          aria-label="快速记下"
          className="h-11 min-w-0 flex-1 rounded-md bg-raised px-3 text-sm outline-none placeholder:text-faint"
        />
        <Button type="submit" variant="primary" disabled={!note.trim()}>
          留下
        </Button>
      </form>
      <ShellMenuRow onStatus={onStatus} />
      <label className="mt-2 flex h-11 items-center gap-2 rounded-md bg-raised px-3">
        <span className="shrink-0 text-xs text-faint">忽略来源</span>
        <input
          key={ignoredApps.join("|")}
          defaultValue={ignoredApps.join(", ")}
          aria-label="忽略来源应用"
          placeholder="1password, bitwarden"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          onBlur={(event) => {
            const names = event.target.value.split(/[,，]/);
            setIgnoredApps(names);
            void syncIgnoredApps(names);
          }}
        />
      </label>
      <div className="mt-2">
        <ChipRail signature={filter} className="flex flex-wrap gap-1" label="剪贴板分类">
          <FilterChip active={filter === "all"} onClick={() => onFilter("all")}>
            全部
          </FilterChip>
          {kinds.map((kind) => (
            <FilterChip key={kind} active={filter === kind} onClick={() => onFilter(kind)}>
              {CLIP_LABEL[kind]}
            </FilterChip>
          ))}
        </ChipRail>
      </div>
      {filtered.length === 0 ? (
        clips.length === 0 ? (
          <EmptyMark title="剪贴板还是空的" hint="在这一页复制，或按 Ctrl+V。也可以自己写下一句。" />
        ) : (
          <p className="swap-in mt-2 text-sm text-muted">没有对得上的记录。</p>
        )
      ) : (
        <ul key={needle} className="swap-in mt-2 flex flex-col">
          {filtered.map((clip) => (
            <li
              key={clip.id}
              draggable={clip.kind === "image" && !!clip.thumb && isDesktop()}
              className={cn("lift-card flex min-h-11 items-center gap-1 pr-1", fresh.has(clip.id) && "arrive")}
              onPointerMove={trackGlow}
              onDragStart={(event) => {
                if (clip.kind !== "image" || !clip.thumb || !isDesktop()) {
                  event.preventDefault();
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                startImageDrag(clip);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, clip });
              }}
            >
              <button
                type="button"
                title={
                  clip.kind === "image" && isDesktop()
                    ? "点击复制回去；拖出去是文件；右键另存为 / 复制到项目"
                    : clip.text || clip.name
                }
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1 text-left"
                onClick={() => void writeBack(clip)}
              >
                <ClipMark clip={clip} />
                <span className="min-w-0 flex-1 overflow-hidden">
                  <span className="block truncate text-sm">{Mark({ text: clip.name, needle })}</span>
                  <span className="num block truncate text-xs text-faint">
                    {CLIP_LABEL[clip.kind]} · {formatWhen(clip.usedAt)}
                    {clip.kind === "image" && isDesktop() ? " · 可拖出" : ""}
                  </span>
                </span>
              </button>
              {clip.kind === "image" && clip.thumb && isDesktop() ? (
                <>
                  <Button size="icon" variant="ghost" aria-label="另存为图片" onClick={() => void saveClipImage(clip)}>
                    <Download className="size-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="复制到当前项目" onClick={() => void copyClipToProject(clip)}>
                    <FolderInput className="size-4" />
                  </Button>
                </>
              ) : null}
              {clip.dominant && isColor(clip.dominant) ? (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`留下主色 ${clip.dominant}`}
                  onClick={() => {
                    const hex = clip.dominant;
                    if (!hex) return;
                    onStatus(clipResultMessage(addClipText(hex), "color"));
                  }}
                >
                  <span className="size-4 rounded-xs border border-line" style={{ background: clip.dominant }} />
                </Button>
              ) : null}
              <Button
                size="icon"
                variant="ghost"
                aria-label={clip.pinned ? "取消钉住" : "钉住"}
                aria-pressed={clip.pinned}
                onClick={() => togglePinClip(clip.id)}
              >
                <Pin className={cn("size-4", clip.pinned ? "text-paper" : "text-faint")} />
              </Button>
              <Button size="icon" variant="ghost" aria-label="删除这条记录" onClick={() => removeClip(clip.id)}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {menu ? (
        <div
          className="fixed z-30 min-w-44 rounded-md border border-line bg-panel p-1"
          style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 220) }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="block h-10 w-full rounded-sm px-3 text-left text-sm hover:bg-raised"
            onClick={() => {
              void writeBack(menu.clip);
              setMenu(null);
            }}
          >
            复制回去
          </button>
          {menu.clip.kind === "image" && menu.clip.thumb && isDesktop() ? (
            <>
              <button
                type="button"
                className="block h-10 w-full rounded-sm px-3 text-left text-sm hover:bg-raised"
                onClick={() => {
                  void saveClipImage(menu.clip);
                  setMenu(null);
                }}
              >
                另存为…
              </button>
              <button
                type="button"
                className="block h-10 w-full rounded-sm px-3 text-left text-sm hover:bg-raised"
                onClick={() => {
                  void copyClipToProject(menu.clip);
                  setMenu(null);
                }}
              >
                复制到当前项目
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="block h-10 w-full rounded-sm px-3 text-left text-sm hover:bg-raised"
            onClick={() => {
              togglePinClip(menu.clip.id);
              setMenu(null);
            }}
          >
            {menu.clip.pinned ? "取消钉住" : "钉住"}
          </button>
          <button
            type="button"
            className="block h-10 w-full rounded-sm px-3 text-left text-sm hover:bg-raised"
            onClick={() => {
              removeClip(menu.clip.id);
              setMenu(null);
            }}
          >
            删除这条记录
          </button>
        </div>
      ) : null}
    </section>
  );
}

function StagePad({ folderId, name }: { folderId: string; name: string }) {
  const workspace = useZone((s) => s.workspaces.find((item) => item.id === s.activeWorkspaceId));
  const setStageNote = useZone((s) => s.setStageNote);
  const addTodo = useZone((s) => s.addTodo);
  const toggleTodo = useZone((s) => s.toggleTodo);
  const removeTodo = useZone((s) => s.removeTodo);
  const reorderTodos = useZone((s) => s.reorderTodos);
  const [draft, setDraft] = useState("");
  if (!workspace) return null;
  const board = boardFor(workspace, folderId);
  return (
    <div className="flex flex-col gap-1 rounded-md px-1">
      <label className="zone-field flex h-11 items-center gap-2 rounded-md bg-raised px-3">
        <span className="shrink-0 text-xs text-faint">备注</span>
        <input
          key={`${folderId}:${board.note}`}
          defaultValue={board.note}
          aria-label={`${name}的备注`}
          placeholder={`${name}的备注`}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          onBlur={(event) => setStageNote(folderId, event.target.value)}
        />
      </label>
      {board.todos.length > 0 ? (
        <ul className="flex flex-col">
          {board.todos.map((todo) => (
            <li
              key={todo.id}
              draggable
              className="flex min-h-11 items-center gap-2 rounded-sm px-1"
              onDragStart={(event) => {
                event.stopPropagation();
                event.dataTransfer.setData("application/x-zone-todo", todo.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onDrop={(event) => {
                const from = event.dataTransfer.getData("application/x-zone-todo");
                if (!from) return;
                event.preventDefault();
                event.stopPropagation();
                reorderTodos(folderId, from, todo.id);
              }}
            >
              <GripHorizontal className="size-3.5 shrink-0 text-faint" aria-hidden />
              <input
                type="checkbox"
                className="size-4 accent-paper"
                checked={todo.done}
                aria-label={todo.done ? `标为未完成 ${todo.text}` : `完成 ${todo.text}`}
                onChange={() => toggleTodo(folderId, todo.id)}
              />
              <span className={cn("min-w-0 flex-1 truncate text-sm", todo.done && "text-faint line-through")}>{todo.text}</span>
              <button type="button" className="shrink-0 text-xs text-faint" aria-label={`删除待办 ${todo.text}`} onClick={() => removeTodo(folderId, todo.id)}>
                删除
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) return;
          addTodo(folderId, draft);
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={`${name}的新待办`}
          placeholder="加一条待办"
          className="h-11 min-w-0 flex-1 rounded-md bg-raised px-3 text-sm outline-none placeholder:text-faint"
        />
        <Button type="submit" variant="quiet" disabled={!draft.trim()}>
          添加
        </Button>
      </form>
    </div>
  );
}

function ShellMenuRow({ onStatus }: { onStatus: (message: string) => void }) {
  const enabled = useZone((s) => s.shellMenu);
  const setShellMenu = useZone((s) => s.setShellMenu);
  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex h-11 items-center justify-between gap-2 rounded-md bg-raised px-3">
        <span className="min-w-0 truncate text-sm">发送到 ZAのWork-Zone</span>
        <button
          type="button"
          aria-pressed={enabled}
          className={cn("h-8 shrink-0 rounded-sm px-2 text-xs", enabled ? "bg-panel text-paper" : "text-faint")}
          onClick={() => {
            const next = !enabled;
            setShellMenu(next);
            void setShellMenuEnabled(next)
              .then((message) => onStatus(message))
              .catch((error: unknown) => {
                const reason = typeof error === "string" ? error : error instanceof Error ? error.message : "右键菜单没有改成。";
                onStatus(reason);
              });
          }}
        >
          {enabled ? "开" : "关"}
        </button>
      </div>
      <p className="px-1 text-xs text-faint">Windows 上对文件和文件夹右键，或按 Ctrl+Alt+A。旧菜单在「显示更多选项」里。</p>
    </div>
  );
}

function stageGlyph(name: string) {
  if (/草图|sketch/i.test(name)) return PenTool;
  if (/建模|模型|model/i.test(name)) return Box;
  if (/渲染|render/i.test(name)) return ImageIcon;
  if (/交付|deliver/i.test(name)) return Archive;
  if (/参考|ref/i.test(name)) return Layers;
  return DraftingCompass;
}

function DeliveryBox() {
  return (
    <svg viewBox="0 0 16 16" className="ship-box stage-glyph size-3.5 shrink-0" aria-hidden>
      <path className="ship-base" d="M2.8 6.6h10.4V13H2.8z" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path className="ship-lid" d="M2.6 6.6 8 3.2 13.4 6.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function StageRail({
  roots,
  currentId,
  done,
  counts,
  shipToken,
  motion,
  shipped,
  hidden,
  onPick,
  onReplay,
  onShipHold,
  onShipEnd,
}: {
  roots: Folder[];
  currentId?: string;
  done: Set<string>;
  counts: Record<string, number>;
  shipToken: number;
  motion: MotionLevel;
  shipped: boolean;
  hidden: boolean;
  onPick: (id: string) => void;
  onReplay: () => void;
  onShipHold: () => void;
  onShipEnd: () => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const endRef = useRef(onShipEnd);
  const holdLock = useRef(onShipHold);
  const holdRef = useRef(0);
  const swallowed = useRef(false);
  const seenToken = useRef(0);
  const [phase, setPhase] = useState<"idle" | "run" | "rest">("idle");
  endRef.current = onShipEnd;
  holdLock.current = onShipHold;
  if (shipToken !== seenToken.current) {
    seenToken.current = shipToken;
    if (shipToken > 0) setPhase(motion === "off" ? "rest" : "run");
  }
  if (!shipped && phase === "rest") setPhase("idle");

  const signature = `${currentId}|${phase}|${shipped ? 1 : 0}|${roots.map((folder) => `${folder.id}:${folder.name}:${done.has(folder.id) ? 1 : 0}:${counts[folder.id] ?? 0}`).join(",")}`;

  useEffect(() => {
    if (hidden && phase === "run") setPhase("rest");
  }, [hidden, phase]);

  useEffect(() => {
    if (phase !== "run") return;
    holdLock.current();
    let stop = () => {};
    const end = window.setTimeout(() => setPhase("rest"), SHIP_FX.duration);
    const spawn =
      motion === "full"
        ? window.setTimeout(() => {
            stop = startShipParticles(railRef.current);
          }, SHIP_FX.particleStart)
        : 0;
    const halt = () => setPhase("rest");
    const onHide = () => {
      if (document.visibilityState === "hidden") halt();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", halt);
    return () => {
      window.clearTimeout(end);
      window.clearTimeout(spawn);
      stop();
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", halt);
      endRef.current();
    };
  }, [phase, motion]);

  useLayoutEffect(() => {
    const root = railRef.current;
    const wash = washRef.current;
    const track = trackRef.current;
    const fill = fillRef.current;
    const line = lineRef.current;
    if (!root || !wash || !track || !fill || !line) return;
    const place = () => {
      const buttons = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
      const rootBox = root.getBoundingClientRect();
      const active = root.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!active || buttons.length === 0) {
        wash.style.opacity = "0";
        track.style.opacity = "0";
        fill.style.opacity = "0";
        return;
      }
      const box = active.getBoundingClientRect();
      const shipping = root.classList.contains("is-shipping");
      wash.style.opacity = shipping && active.dataset.ship === "delivery" ? "0" : "1";
      wash.style.width = `${box.width}px`;
      wash.style.height = `${box.height}px`;
      wash.style.transform = `translate(${box.left - rootBox.left}px, ${box.top - rootBox.top}px)`;
      const first = buttons[0].getBoundingClientRect();
      const last = buttons[buttons.length - 1].getBoundingClientRect();
      const start = first.left - rootBox.left;
      const span = Math.max(0, last.right - first.left);
      track.style.opacity = "1";
      track.style.transform = `translateX(${start}px)`;
      track.style.width = `${span}px`;
      line.style.transform = `translateX(${start}px)`;
      line.style.width = `${span}px`;
      const lastDone = buttons.filter((button) => button.dataset.done === "true").at(-1);
      fill.style.opacity = "1";
      fill.style.transform = `translateX(${start}px)`;
      fill.style.width = lastDone ? `${Math.max(0, lastDone.getBoundingClientRect().right - first.left)}px` : "0px";
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(root);
    for (const button of root.querySelectorAll<HTMLElement>('[role="tab"]')) observer.observe(button);
    return () => observer.disconnect();
  }, [signature]);

  const resting = shipped && phase !== "run";

  return (
    <div
      ref={railRef}
      role="tablist"
      aria-label="阶段"
      className={cn("stage-rail", phase === "run" && "is-shipping", phase === "run" && motion === "lite" && "is-lite", resting && "is-shipped")}
    >
      <span ref={trackRef} className="stage-track" />
      <span ref={fillRef} className="stage-fill" />
      <span ref={lineRef} className="ship-line">
        <span className="ship-line-bar" />
      </span>
      <span ref={washRef} className="stage-wash">
        <span className="stage-wash-face" />
      </span>
      <span className="ship-sweep" />
      {roots.map((folder, index) => {
        const confirmed = done.has(folder.id);
        const delivery = /交付/.test(folder.name);
        const Icon = stageGlyph(folder.name);
        return (
          <button
            key={folder.id}
            type="button"
            role="tab"
            data-done={confirmed ? "true" : undefined}
            data-state={folder.id === currentId ? "current" : confirmed ? "done" : "future"}
            title={confirmed ? "回到此阶段" : undefined}
            data-ship={delivery ? "delivery" : undefined}
            aria-selected={folder.id === currentId}
            style={{ ["--i" as string]: index }}
            onPointerDown={() => {
              if (!delivery || !confirmed) return;
              swallowed.current = false;
              window.clearTimeout(holdRef.current);
              holdRef.current = window.setTimeout(() => {
                swallowed.current = true;
                onReplay();
              }, 480);
            }}
            onPointerUp={() => window.clearTimeout(holdRef.current)}
            onPointerLeave={() => window.clearTimeout(holdRef.current)}
            onClick={() => {
              if (swallowed.current) {
                swallowed.current = false;
                return;
              }
              onPick(folder.id);
            }}
          >
            {confirmed ? delivery ? <DeliveryBox /> : <Icon className="stage-glyph size-3.5 shrink-0" aria-hidden /> : null}
            {confirmed ? <Check className="stage-check size-3 shrink-0" aria-hidden /> : null}
            <span className="stage-name">{folder.name}</span>
            {(counts[folder.id] ?? 0) > 0 ? (
              <span className="stage-count num" aria-label={`${counts[folder.id]} 件未完成`}>
                {counts[folder.id]}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="h-11 rounded-md px-3 text-sm"
    >
      {children}
    </button>
  );
}

function ChipRail({
  signature,
  className,
  label,
  children,
}: {
  signature: string;
  className?: string;
  label: string;
  children: ReactNode;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const root = railRef.current;
    const wash = washRef.current;
    if (!root || !wash) return;
    const place = () => {
      const active = root.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!active) {
        wash.style.opacity = "0";
        return;
      }
      const rootBox = root.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      wash.style.opacity = "1";
      wash.style.width = `${box.width}px`;
      wash.style.height = `${box.height}px`;
      wash.style.transform = `translate(${box.left - rootBox.left + root.scrollLeft}px, ${box.top - rootBox.top + root.scrollTop}px)`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(root);
    root.addEventListener("scroll", place, { passive: true });
    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", place);
    };
  }, [signature, children]);
  return (
    <div ref={railRef} role="tablist" aria-label={label} className={cn("chip-rail", className)}>
      <span ref={washRef} className="chip-wash" />
      {children}
    </div>
  );
}

function trackGlow(event: React.PointerEvent<HTMLElement>) {
  const node = event.currentTarget;
  const box = node.getBoundingClientRect();
  node.style.setProperty("--mx", `${event.clientX - box.left}px`);
  node.style.setProperty("--my", `${event.clientY - box.top}px`);
}

function Mark({ text, needle }: { text: string; needle: string }) {
  const query = needle.trim().toLowerCase();
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let guard = 0;
  while (cursor < text.length && guard < 20) {
    const at = lower.indexOf(query, cursor);
    if (at < 0) {
      parts.push(text.slice(cursor));
      break;
    }
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(
      <mark key={`${at}-${guard}`} className="match">
        {text.slice(at, at + query.length)}
      </mark>,
    );
    cursor = at + query.length;
    guard += 1;
  }
  return <>{parts}</>;
}

function EmptyMark({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="empty-state">
      <svg viewBox="0 0 80 56" className="empty-art" aria-hidden>
        <rect x="6" y="12" width="26" height="34" rx="4" />
        <rect x="38" y="6" width="30" height="18" rx="4" />
        <rect x="42" y="32" width="26" height="14" rx="3" />
      </svg>
      <p className="text-md font-medium tracking-tight">{title}</p>
      <p className="text-xs text-faint">{hint}</p>
    </div>
  );
}

function ClipMark({ clip }: { clip: Clip }) {
  if (clip.kind === "color" && clip.text && isColor(clip.text)) {
    return <span className="size-8 shrink-0 rounded-sm border border-line" style={{ background: clip.text }} />;
  }
  if (clip.kind === "image" && clip.thumb) {
    return <img src={clip.thumb} alt="" className="size-8 shrink-0 rounded-sm object-cover" />;
  }
  const Icon = clip.kind === "link" ? Link2 : Type;
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-raised text-muted">
      <Icon className="size-4" />
    </span>
  );
}

function textKind(text: string): ClipKind | undefined {
  const kind = classifyText(text);
  if (kind === "empty" || kind === "sensitive") return;
  return kind;
}
