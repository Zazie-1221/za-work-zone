import { legacyState, type Dock } from "@/lib/zone/model";

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function core() {
  return import("@tauri-apps/api/core");
}

export async function loadDesktopState(name: string): Promise<string | null> {
  const { invoke } = await core();
  const dbValue = await invoke<string | null>("state_load");
  const picked = legacyState(dbValue, localStorage.getItem(name));
  if (picked.write && picked.value) await invoke("state_save", { value: picked.value });
  return picked.value;
}

let saveTimer = 0;
let pendingSave = "";

export function saveDesktopState(value: string) {
  pendingSave = value;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const snapshot = pendingSave;
    void core().then(({ invoke }) => invoke("state_save", { value: snapshot }));
  }, 400);
}

export async function flushDesktopState() {
  if (!pendingSave) return;
  window.clearTimeout(saveTimer);
  const snapshot = pendingSave;
  const { invoke } = await core();
  await invoke("state_save", { value: snapshot });
}

export async function openPath(path: string) {
  const { invoke } = await core();
  await invoke("open_path", { path });
}

export async function revealPath(path: string): Promise<string | null> {
  if (!/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith("\\\\") && !path.startsWith("/")) {
    const message = "这个文件在项目包里，没有记下电脑上的位置。请到你选的项目包文件夹里找。";
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("zone-status", { detail: message }));
    return message;
  }
  const { invoke } = await core();
  try {
    await invoke("reveal_path", { path });
    return null;
  } catch (err) {
    const message = typeof err === "string" && err ? err : "没能打开这个位置。";
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("zone-status", { detail: message }));
    return message;
  }
}

export async function copyText(text: string) {
  if (!isDesktop()) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const { invoke } = await core();
  await invoke("copy_text", { text });
}

/** 写回系统剪贴板；有原图路径时优先原图（Rust 后台解码，不卡 UI）。 */
export async function copyImage(dataUrl: string, originalPath?: string | null) {
  const { invoke } = await core();
  await invoke("copy_image", { dataUrl, originalPath: originalPath ?? null });
}

export async function pickFile(): Promise<string | null> {
  const { invoke } = await core();
  return invoke<string | null>("pick_file");
}

export async function missingPaths(paths: string[]): Promise<string[]> {
  const { invoke } = await core();
  return invoke<string[]>("missing_paths", { paths });
}

export async function fileSize(path: string): Promise<number | null> {
  const { invoke } = await core();
  return invoke<number | null>("file_size", { path });
}

export async function imageThumb(path: string): Promise<string | null> {
  const { invoke } = await core();
  return invoke<string | null>("image_thumb", { path });
}

export async function setClipboardPaused(paused: boolean) {
  if (!isDesktop()) return;
  const { invoke } = await core();
  await invoke("set_clipboard_paused", { paused });
}

export async function syncIgnoredApps(names: string[]) {
  if (!isDesktop()) return;
  const { invoke } = await core();
  await invoke("set_ignored_apps", { names });
}

export type Box = { x: number; y: number; w: number; h: number };
export type ZoneLayout = { dock: Dock; capsule: Box; panel: Box; winW: number; winH: number };

// 摆放窗口期间，位置会变；onMoved 的吸附逻辑要等这一小段时间过去再跑，
// 避免把我们自己的摆放当成用户拖动。
let windowMorphing = false;
let morphGrace = 0;

export function isWindowMorphing() {
  return windowMorphing;
}

const PANEL_HEIGHT_KEY = "za-panel-height";

function savedPanelHeight(): number {
  const value = Number(localStorage.getItem(PANEL_HEIGHT_KEY));
  return Number.isFinite(value) && value >= 320 ? value : 760;
}

/**
 * 摆放“固定最大尺寸”的透明窗口，让胶囊正好落在停靠位置。
 * 窗口尺寸只在这里确定（不超过工作区），之后收/展不再改动原生窗口，
 * 形变完全发生在窗口里面（见 work-zone.tsx）。返回窗口内的胶囊/面板矩形（逻辑像素）。
 */
export async function applyLayout(dock: Dock): Promise<ZoneLayout> {
  const { invoke } = await core();
  windowMorphing = true;
  window.clearTimeout(morphGrace);
  try {
    return await invoke<ZoneLayout>("zone_window_layout", { dock, height: savedPanelHeight() });
  } finally {
    morphGrace = window.setTimeout(() => {
      windowMorphing = false;
    }, 600);
  }
}

/** 告诉 Rust 当前哪些矩形（窗口内逻辑像素）可交互；其余透明区域点击穿透。 */
export function setHitRects(rects: Box[]) {
  if (!isDesktop()) return;
  void core().then(({ invoke }) => invoke("zone_set_hit", { rects }).catch(() => undefined));
}

/** Rust 轮询光标：光标进入/离开可交互矩形时回调（穿透状态下前端收不到 pointer 事件）。 */
export async function onZoneHover(handler: (inside: boolean) => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<boolean>("zone-hover", (event) => handler(Boolean(event.payload)));
}

/** 收起态下重新吸附：如有位移，返回新的窗口内布局。 */
export async function snapCollapsed(): Promise<{ dock: Dock; layout: ZoneLayout | null } | null> {
  try {
    const { invoke } = await core();
    windowMorphing = true;
    window.clearTimeout(morphGrace);
    const result = await invoke<SnapResult>("zone_dock_snap", { collapsed: true });
    morphGrace = window.setTimeout(() => {
      windowMorphing = false;
    }, 600);
    return { dock: result.dock, layout: result.layout ?? null };
  } catch {
    windowMorphing = false;
    return null;
  }
}
/** 前台是不是全屏应用：是的话悬停不弹出面板。查询失败当作不是。 */
export async function fullscreenActive(): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    const { invoke } = await core();
    return await invoke<boolean>("zone_fullscreen_active");
  } catch {
    return false;
  }
}

/**
 * 拖动窗口。不用系统自带的 startDragging：它会把窗口夹在工作区里，而窗口恒为最大尺寸，
 * 胶囊就拖不到屏幕上半部分/顶边。这里由 Rust 按光标位置直接摆窗口，松手后再吸附。
 */
export async function startWindowDrag() {
  const { invoke } = await core();
  await invoke("zone_drag_begin");
}

let snapTimer = 0;

type SnapResult = { dock: Dock; held: boolean; layout?: ZoneLayout | null };

/**
 * 绑定窗口：拖动结束后做停靠吸附。
 * 停靠在 Rust 层：按胶囊在屏幕上的位置找最近的边；收起态下顺手把窗口摆回去（尺寸不变），展开态只记录停靠。
 * 结果通过 onDock / onLayout 回传，由调用方持久化。
 */
export async function bindDesktopWindow(opts: {
  isCollapsed: () => boolean;
  onDock: (dock: Dock) => void;
  onLayout?: (layout: ZoneLayout) => void;
}) {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { invoke } = await core();
  const win = getCurrentWindow();
  await win.setAlwaysOnTop(true);
  const settle = (delay: number) => {
    window.clearTimeout(snapTimer);
    snapTimer = window.setTimeout(async () => {
      if (windowMorphing) return;
      try {
        const result = await invoke<SnapResult>("zone_dock_snap", { collapsed: opts.isCollapsed() });
        // 鼠标还按着（拖动中停顿）：先不动窗口，过一会儿再看。
        if (result.held) settle(150);
        else {
          opts.onDock(result.dock);
          if (result.layout) opts.onLayout?.(result.layout);
        }
      } catch {
        // 停靠失败就留在原地。
      }
    }, delay);
  };
  return win.onMoved(() => settle(250));
}
export type CapturePayload = {
  kind: "text" | "image" | "files";
  text?: string | null;
  image?: string | null;
  files?: string[];
  sourceApp?: string | null;
  originalPath?: string | null;
};

export async function onDesktopEvent<T>(name: string, handler: (payload: T) => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(name, (event) => handler(event.payload));
}

export async function onFileDrop(
  handler: (paths: string[]) => void,
  onHover?: (over: boolean, position?: { x: number; y: number }) => void,
) {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "drop") handler(payload.paths);
    else if (payload.type === "enter" || payload.type === "over") onHover?.(true, payload.position);
    else if (payload.type === "leave") onHover?.(false);
  });
}
export async function setShellMenuEnabled(enabled: boolean): Promise<string> {
  if (!isDesktop()) return enabled ? "这项会在 Windows 上注册右键菜单。设置已记下。" : "右键菜单已关闭。设置已记下。";
  const { invoke } = await core();
  await invoke("shell_menu_set", { enabled });
  return enabled ? "已加上「发送到 ZAのWork-Zone」。" : "已去掉右键菜单。";
}

export async function takePendingSends(): Promise<string[]> {
  if (!isDesktop()) return [];
  const { invoke } = await core();
  return invoke<string[]>("take_pending_sends");
}

export async function probePaths(paths: string[]) {
  const { invoke } = await core();
  return invoke<
    { path: string; name: string; exists: boolean; isDir: boolean; size?: number; readable: boolean; reason?: string }[]
  >("probe_paths", { paths });
}

export async function readUserFile(path: string): Promise<string> {
  const { invoke } = await core();
  return invoke<string>("read_user_file", { path });
}

export async function pickFolder(title?: string): Promise<string | null> {
  const { invoke } = await core();
  return invoke<string | null>("pick_folder", { title: title ?? null });
}

export async function pickFiles(): Promise<string[]> {
  const { invoke } = await core();
  return invoke<string[]>("pick_files");
}

export type IngestResult = {
  path: string;
  name: string;
  size: number;
  moved: boolean;
  originalLeft: boolean;
  inPlace: boolean;
  note?: string | null;
};

/** 真正把一个文件复制/移动进 destDir（Rust 里核对过再删原件，重名自动加后缀）。 */
export async function ingestFile(src: string, destDir: string, mode: "copy" | "move"): Promise<IngestResult> {
  const { invoke } = await core();
  return invoke<IngestResult>("ingest_file", { src, destDir, mode });
}

export type SettleResult = { removed: boolean; note?: string | null };

/** 项目里已有这份的副本、原文件还在：内容一样才删原文件（Rust 里逐字节核对）。 */
export async function settleMove(src: string, kept: string): Promise<SettleResult> {
  const { invoke } = await core();
  return invoke<SettleResult>("settle_move", { src, kept });
}
/** 读文件的一段（最多 8 MB），给边读边写进项目包用。 */
export async function readFileChunk(path: string, offset: number, len: number): Promise<Uint8Array> {
  const { invoke } = await core();
  const encoded = await invoke<string>("read_file_chunk", { path, offset, len });
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function trashPaths(paths: string[]): Promise<number> {
  const { invoke } = await core();
  return invoke<number>("trash_paths", { paths });
}

export async function removeUserFile(path: string): Promise<void> {
  const { invoke } = await core();
  await invoke("remove_user_file", { path });
}

/** 写成临时文件（优先原图），返回真实路径。 */
export async function clipWriteTemp(
  dataUrl: string,
  name: string,
  originalPath?: string | null,
): Promise<string> {
  const { invoke } = await core();
  return invoke<string>("clip_write_temp", { dataUrl, name, originalPath: originalPath ?? null });
}

/** 另存为对话框；取消时返回 null。优先原图。 */
export async function clipSaveAs(
  dataUrl: string,
  defaultName: string,
  originalPath?: string | null,
): Promise<string | null> {
  const { invoke } = await core();
  return invoke<string | null>("clip_save_as", {
    dataUrl,
    defaultName,
    originalPath: originalPath ?? null,
  });
}

/** 写成临时文件后走 Windows 原生文件拖放（优先原图）。会阻塞到拖放结束。 */
export async function clipStartDrag(
  dataUrl: string,
  name: string,
  originalPath?: string | null,
): Promise<void> {
  const { invoke } = await core();
  await invoke("clip_start_drag", { dataUrl, name, originalPath: originalPath ?? null });
}

/** 网页粘贴等：把原图像素存进 APPDATA/clips（>8MB 跳过）。 */
export async function clipKeepOriginal(
  bytes: ArrayBuffer | Uint8Array,
  mime?: string,
): Promise<string | null> {
  if (!isDesktop()) return null;
  const { invoke } = await core();
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  const dataBase64 = btoa(binary);
  return invoke<string | null>("clip_keep_original", { dataBase64, mime: mime ?? null });
}

/** 删除 clips 目录里的原图文件。 */
export async function clipForgetOriginal(path: string): Promise<void> {
  if (!isDesktop() || !path) return;
  const { invoke } = await core();
  await invoke("clip_forget_original", { path });
}

/** 按钉住列表清理 clips：7 天未钉住 / 总上限 500MB。 */
export async function clipCleanup(pinnedPaths: string[]): Promise<{ removed: number; bytes: number; dir: string }> {
  if (!isDesktop()) return { removed: 0, bytes: 0, dir: "" };
  const { invoke } = await core();
  return invoke("clip_cleanup", { pinnedPaths });
}
