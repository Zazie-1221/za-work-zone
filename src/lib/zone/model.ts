export type Kind =
  | "image"
  | "vector"
  | "design"
  | "model"
  | "drawing"
  | "video"
  | "audio"
  | "document"
  | "font"
  | "archive"
  | "code";

export type ClipKind = "text" | "color" | "link" | "image";

export type Role = "source" | "reference" | "export" | "wip";

export type ShelfPurpose = "active" | "hold" | "ref" | "archive" | "custom";

export type StageTodo = {
  id: string;
  text: string;
  done: boolean;
};

export type StageBoard = {
  folderId: string;
  note: string;
  todos: StageTodo[];
  updatedAt: number;
};

export type IngestMode = "copy" | "move" | "link";

export type Folder = {
  id: string;
  parentId: string | null;
  name: string;
};

export type ClassRule = {
  id: string;
  match: string;
  purpose: "active" | "hold" | "ref" | "archive";
};

export type Workspace = {
  id: string;
  name: string;
  folders: Folder[];
  rules: ClassRule[];
  currentStageId?: string;
  doneStageIds?: string[];
  packageId?: string;
  archived?: boolean;
  progress?: string;
  stageNotes?: StageBoard[];
  ingestMode?: IngestMode;
  /** 复制/移动进来的文件放在这台电脑的哪个文件夹（里面按阶段分子文件夹）。 */
  storeDir?: string;
  dismissedPaths?: string[];
};

export type ZoneFile = {
  id: string;
  workspaceId: string;
  folderId: string;
  folderLocked: boolean;
  kind: Kind;
  role: Role;
  name: string;
  size?: number;
  thumb?: string;
  dominant?: string;
  stale?: boolean;
  path?: string;
  sourcePath?: string;
  external?: boolean;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  openedAt?: number;
  modifiedAt?: number;
  note?: string;
  versionGroup?: string;
  versionSolo?: boolean;
  versionCurrent?: boolean;
};

export type Clip = {
  id: string;
  kind: ClipKind;
  text?: string;
  thumb?: string;
  /** Desktop full-res file under APPDATA/.../clips; missing on old thumbs. */
  originalPath?: string;
  dominant?: string;
  name: string;
  pinned: boolean;
  createdAt: number;
  usedAt: number;
};

export type PanelPos = { x: number; y: number };

export const KIND_LABEL: Record<Kind, string> = {
  image: "图片",
  vector: "矢量",
  design: "设计稿",
  model: "模型",
  drawing: "图纸",
  video: "视频",
  audio: "音频",
  document: "文档",
  font: "字体",
  archive: "压缩包",
  code: "代码",
};

export const KIND_ORDER: Kind[] = [
  "design",
  "model",
  "drawing",
  "vector",
  "image",
  "font",
  "document",
  "video",
  "audio",
  "code",
  "archive",
];

export const ROLE_LABEL: Record<Role, string> = {
  source: "源文件",
  reference: "参考",
  export: "导出",
  wip: "草稿",
};

export const CLIP_LABEL: Record<ClipKind, string> = {
  text: "文案",
  color: "色值",
  link: "链接",
  image: "图片",
};

const EXT_KIND: Record<string, Kind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  avif: "image",
  heic: "image",
  tif: "image",
  tiff: "image",
  svg: "vector",
  ai: "vector",
  eps: "vector",
  psd: "design",
  psb: "design",
  afdesign: "design",
  afphoto: "design",
  sketch: "design",
  fig: "design",
  xd: "design",
  sldprt: "model",
  sldasm: "model",
  prt: "model",
  asm: "model",
  ipt: "model",
  iam: "model",
  ipn: "model",
  catpart: "model",
  catproduct: "model",
  cgr: "model",
  "3dxml": "model",
  "3dm": "model",
  gh: "model",
  ghx: "model",
  f3d: "model",
  f3z: "model",
  wire: "model",
  stl: "model",
  obj: "model",
  fbx: "model",
  glb: "model",
  gltf: "model",
  "3mf": "model",
  ply: "model",
  abc: "model",
  dae: "model",
  usd: "model",
  usda: "model",
  usdc: "model",
  usdz: "model",
  step: "model",
  stp: "model",
  iges: "model",
  igs: "model",
  x_t: "model",
  x_b: "model",
  sat: "model",
  jt: "model",
  "3ds": "model",
  blend: "model",
  c4d: "model",
  max: "model",
  ma: "model",
  mb: "model",
  ztl: "model",
  bip: "model",
  ksp: "model",
  kmp: "model",
  kbp: "model",
  kcm: "model",
  vrscene: "model",
  ifc: "model",
  rvt: "model",
  rfa: "model",
  fcstd: "model",
  lxo: "model",
  zpr: "model",
  sldlfp: "model",
  svgz: "vector",
  cdr: "vector",
  emf: "vector",
  wmf: "vector",
  indd: "design",
  kra: "design",
  xcf: "design",
  clip: "design",
  hdr: "image",
  exr: "image",
  hdri: "image",
  dng: "image",
  ico: "image",
  jpe: "image",
  mkv: "video",
  m4v: "video",
  wmv: "video",
  m4a: "audio",
  ogg: "audio",
  gz: "archive",
  tar: "archive",
  tgz: "archive",
  skp: "model",
  slddrw: "drawing",
  idw: "drawing",
  drw: "drawing",
  catdrawing: "drawing",
  dwg: "drawing",
  dxf: "drawing",
  dwf: "drawing",
  dwt: "drawing",
  mp4: "video",
  mov: "video",
  webm: "video",
  avi: "video",
  mp3: "audio",
  wav: "audio",
  aac: "audio",
  flac: "audio",
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  pdf: "document",
  doc: "document",
  docx: "document",
  md: "document",
  txt: "document",
  rtf: "document",
  ppt: "document",
  pptx: "document",
  key: "document",
  js: "code",
  ts: "code",
  tsx: "code",
  jsx: "code",
  css: "code",
  json: "code",
  html: "code",
};

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function extOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const parts = base.split(".");
  if (parts.length < 2) return "";
  const last = parts[parts.length - 1]?.toLowerCase() ?? "";
  if (/^\d+$/.test(last) && parts.length >= 3) {
    return parts[parts.length - 2]?.toLowerCase() ?? "";
  }
  return last;
}

// KeyShot / V-Ray scene files are 3D files (they show under the 模型 filter)
// but they are render-stage work, so they override the 模型 -> 建模 stage.
const STAGE_BY_EXT: Record<string, string> = {
  ksp: "渲染",
  bip: "渲染",
  kmp: "渲染",
  kbp: "渲染",
  kcm: "渲染",
  vrscene: "渲染",
};

export function stageOverrideForName(name: string): string | undefined {
  return STAGE_BY_EXT[extOf(name)];
}

export function kindFromName(name: string): Kind {
  return EXT_KIND[extOf(name)] ?? "document";
}

export function roleFromName(name: string): Role {
  const n = name.toLowerCase();
  if (/参考|moodboard|mood[-_.]|inspo|inspiration|references?|(^|[^a-z])ref([^a-z]|$)/.test(n)) {
    return "reference";
  }
  if (/final|export|交付|导出/.test(n)) return "export";
  if (/wip|draft|草稿|(^|[^a-z])v\d+([^a-z]|$)/.test(n)) return "wip";
  return "source";
}

export function purposeForRole(role: Role): ShelfPurpose {
  if (role === "reference") return "ref";
  if (role === "export") return "hold";
  return "active";
}

export const RULE_STAGE: Record<ClassRule["purpose"], string> = {
  active: "草图",
  hold: "建模",
  ref: "渲染",
  archive: "交付",
};

export const KIND_STAGE: Partial<Record<Kind, string>> = {
  drawing: "草图",
  vector: "草图",
  design: "草图",
  model: "建模",
  image: "渲染",
  video: "渲染",
  audio: "渲染",
  document: "交付",
  font: "交付",
  archive: "交付",
  code: "交付",
};

export const STAGE_NAMES = ["草图", "建模", "渲染", "交付"] as const;

export function rootFolders(folders: Folder[]): Folder[] {
  return folders.filter((folder) => folder.parentId == null);
}

export function stageCursor(workspace: Workspace): {
  roots: Folder[];
  current?: Folder;
  next?: Folder;
  done: Set<string>;
} {
  const roots = rootFolders(workspace.folders);
  const done = new Set(workspace.doneStageIds ?? []);
  const current =
    roots.find((folder) => folder.id === workspace.currentStageId) ??
    roots.find((folder) => !done.has(folder.id)) ??
    roots[0];
  const index = roots.findIndex((folder) => folder.id === current?.id);
  const next = index >= 0 ? roots[index + 1] : undefined;
  return { roots, current, next, done };
}

export function stageActionLabel(workspace: Workspace): string | null {
  const { roots, current, next, done } = stageCursor(workspace);
  if (!current) return null;
  if (!done.has(current.id)) return next ? `确认${current.name}，开始${next.name}` : `确认${current.name}`;
  const upcoming = roots.slice(roots.findIndex((folder) => folder.id === current.id) + 1).find((folder) => !done.has(folder.id));
  return upcoming ? `下一步 · ${upcoming.name}` : null;
}

export function advanceStage(workspace: Workspace): { workspace: Workspace; message: string; openId?: string } {
  const { roots, current, next, done } = stageCursor(workspace);
  if (!current) return { workspace, message: "还没有阶段" };
  if (!done.has(current.id)) {
    const doneStageIds = [...(workspace.doneStageIds ?? []), current.id];
    const currentStageId = next?.id ?? current.id;
    return {
      workspace: { ...workspace, doneStageIds, currentStageId },
      message: next ? `${current.name}已确认，开始${next.name}` : `${current.name}已确认`,
      openId: currentStageId,
    };
  }
  const upcoming = roots.slice(roots.findIndex((folder) => folder.id === current.id) + 1).find((folder) => !done.has(folder.id));
  if (!upcoming) return { workspace, message: `${current.name}已确认` };
  return {
    workspace: { ...workspace, currentStageId: upcoming.id },
    message: `现在是${upcoming.name}`,
    openId: upcoming.id,
  };
}

/** 点已确认的阶段：回到那一段，它和它之后的阶段都变回未确认。 */
export function reopenStage(workspace: Workspace, id: string): { workspace: Workspace; message: string; openId?: string } {
  const roots = rootFolders(workspace.folders);
  const index = roots.findIndex((folder) => folder.id === id);
  if (index < 0) return { workspace, message: "没有这个阶段" };
  const keep = new Set(roots.slice(0, index).map((folder) => folder.id));
  const doneStageIds = (workspace.doneStageIds ?? []).filter((doneId) => keep.has(doneId));
  return {
    workspace: { ...workspace, doneStageIds, currentStageId: id },
    message: `已回到${roots[index].name}`,
    openId: id,
  };
}

/** 清空所有阶段确认，回到第一个阶段。 */
export function resetStages(workspace: Workspace): { workspace: Workspace; message: string; openId?: string } {
  const first = rootFolders(workspace.folders)[0];
  if (!first) return { workspace, message: "还没有阶段" };
  return {
    workspace: { ...workspace, doneStageIds: [], currentStageId: first.id },
    message: `阶段已重置，回到${first.name}`,
    openId: first.id,
  };
}

export function defaultFolders(): Folder[] {
  return STAGE_NAMES.map((name) => ({ id: uid(), parentId: null, name }));
}

export function parentDirName(path?: string): string {
  if (!path) return "";
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length < 2) return "";
  return parts[parts.length - 2] ?? "";
}

export function folderDepth(folders: Folder[], id: string): number {
  let depth = 0;
  let current = folders.find((folder) => folder.id === id);
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    depth += 1;
    current = folders.find((folder) => folder.id === current?.parentId);
  }
  return depth;
}

export function folderPath(folders: Folder[], id: string): string {
  const names: string[] = [];
  let current = folders.find((folder) => folder.id === id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? folders.find((folder) => folder.id === current?.parentId) : undefined;
  }
  return names.join(" / ");
}

export function folderByName(folders: Folder[], name: string): Folder | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return folders
    .filter((folder) => folder.name.trim().toLowerCase() === needle)
    .sort((a, b) => folderDepth(folders, b.id) - folderDepth(folders, a.id))[0];
}

export function descendantIds(folders: Folder[], id: string): string[] {
  const ids = [id];
  for (const child of folders.filter((folder) => folder.parentId === id)) {
    ids.push(...descendantIds(folders, child.id));
  }
  return ids;
}

export function isFolderInside(folders: Folder[], id: string, parentId: string | null): boolean {
  if (!parentId) return false;
  if (parentId === id) return true;
  return descendantIds(folders, id).includes(parentId);
}

export type Placement = {
  folderId: string;
  locked: boolean;
  via: "chosen" | "parent" | "kind" | "keyword" | "name" | "fallback";
  label: string;
  short: string;
};

const GENERIC_DIRS = new Set([
  "desktop",
  "downloads",
  "download",
  "documents",
  "document",
  "users",
  "user",
  "public",
  "home",
  "temp",
  "tmp",
  "new folder",
  "files",
  "file",
  "output",
  "outputs",
  "onedrive",
  "dropbox",
  "下载",
  "桌面",
  "文档",
  "新建文件夹",
  "未命名文件夹",
]);

const NAME_STAGE: { test: RegExp; stage: (typeof STAGE_NAMES)[number] }[] = [
  { test: /交付/, stage: "交付" },
  { test: /渲染/, stage: "渲染" },
  { test: /建模/, stage: "建模" },
  { test: /草图/, stage: "草图" },
  { test: /handoff/, stage: "交付" },
  { test: /(^|[^a-z])sketch([^a-z]|$)/, stage: "草图" },
  { test: /(^|[^a-z])renders?([^a-z]|$)|(^|[^a-z])rendering([^a-z]|$)/, stage: "渲染" },
  { test: /(^|[^a-z])models?([^a-z]|$)|(^|[^a-z])modelling([^a-z]|$)/, stage: "建模" },
];

function folderForStage(folders: Folder[], stage: string): Folder | undefined {
  const aliases: Record<string, string[]> = {
    草图: ["01草图", "草图", "进行中"],
    建模: ["02建模", "建模", "待用"],
    渲染: ["03渲染", "渲染", "参考"],
    交付: ["04交付", "交付", "归档"],
  };
  for (const name of aliases[stage] ?? [stage]) {
    const found = folderByName(folders, name);
    if (found) return found;
  }
  return undefined;
}

function usefulParent(path: string | undefined, folders: Folder[]): Folder | undefined {
  const name = parentDirName(path);
  const key = name.trim().toLowerCase();
  if (key.length < 2 || GENERIC_DIRS.has(key)) return undefined;
  return folderByName(folders, name);
}

function stageNamedInFile(name: string, folders: Folder[]): { folder: Folder; token: string } | undefined {
  const text = name.toLowerCase();
  for (const item of NAME_STAGE) {
    const found = text.match(item.test);
    if (!found) continue;
    const folder = folderForStage(folders, item.stage);
    if (!folder) continue;
    const token = found[0].replace(/^[^a-z\u4e00-\u9fa5]+|[^a-z\u4e00-\u9fa5]+$/g, "") || item.stage;
    return { folder, token };
  }
  return undefined;
}

function wantsDelivery(name: string, kind: Kind): boolean {
  if (kind === "model" || kind === "drawing") return false;
  return /交付|导出|handoff|(^|[^a-z])(final|export)([^a-z]|$)/i.test(name);
}

export function placeFile(input: {
  name: string;
  path?: string;
  folders: Folder[];
  rules: ClassRule[] | undefined;
  chosenId?: string | null;
}): Placement {
  const folders = input.folders;
  const fallback = folders.find((folder) => folder.parentId == null) ?? folders[0];
  const empty: Placement = { folderId: fallback?.id ?? "", locked: false, via: "fallback", label: "没有可放入的阶段", short: "" };
  if (!fallback) return empty;
  const put = (
    folder: Folder,
    via: Placement["via"],
    label: string,
    short: string,
    locked = false,
  ): Placement => ({ folderId: folder.id, locked, via, label, short });

  if (input.chosenId && folders.some((folder) => folder.id === input.chosenId)) {
    const chosen = folders.find((folder) => folder.id === input.chosenId) ?? fallback;
    return put(chosen, "chosen", `放入${folderPath(folders, chosen.id)}`, "已放入", true);
  }

  const kind = kindFromName(input.name);
  const sceneStage = stageOverrideForName(input.name);
  const kindName = sceneStage ?? KIND_STAGE[kind];
  const kindLabel = sceneStage ? "渲染场景" : KIND_LABEL[kind];
  const byKind = kindName ? folderForStage(folders, kindName) : undefined;
  const parent = usefulParent(input.path, folders);
  const named = stageNamedInFile(input.name, folders);
  const hit = ruleHit(input.name, input.rules);
  const byRule = hit ? folderForStage(folders, RULE_STAGE[hit.purpose]) : undefined;
  const deliver = wantsDelivery(input.name, kind) ? folderForStage(folders, "交付") : undefined;

  if (parent) {
    const skipped =
      named && named.folder.id !== parent.id
        ? `文件名里的${named.folder.name}`
        : byRule && byRule.id !== parent.id
          ? `规则「${hit?.match}」`
          : byKind && byKind.id !== parent.id
            ? kindLabel
            : "";
    return put(
      parent,
      "parent",
      skipped ? `按所在文件夹「${parent.name}」归类，不跟${skipped}` : `按所在文件夹「${parent.name}」归类`,
      `文件夹 · ${parent.name}`,
    );
  }

  const referenceFolder = folderByName(folders, "05参考");
  if (referenceFolder && roleFromName(input.name) === "reference") {
    return put(referenceFolder, "kind", `按参考归到${referenceFolder.name}`, `参考 · ${referenceFolder.name}`);
  }

  if (named && (!byKind || named.folder.id !== byKind.id)) {
    return put(
      named.folder,
      "name",
      byKind
        ? `文件名含「${named.token}」，盖过${kindLabel}，归到${named.folder.name}`
        : `文件名含「${named.token}」，归到${named.folder.name}`,
      `文件名 · ${named.folder.name}`,
    );
  }

  if (byRule && (!byKind || byRule.id !== byKind.id)) {
    return put(
      byRule,
      "keyword",
      byKind
        ? `规则「${hit?.match}」盖过${kindLabel}，归到${byRule.name}`
        : `按规则「${hit?.match}」归到${byRule.name}`,
      `规则 · ${hit?.match}`,
    );
  }

  if (deliver && (!byKind || deliver.id !== byKind.id)) {
    return put(deliver, "keyword", `文件名含交付，盖过${kindLabel}，归到${deliver.name}`, "文件名 · 交付");
  }

  if (byKind) {
    return put(byKind, "kind", `按${kindLabel}归到${byKind.name}`, `扩展名 · ${kindLabel}`);
  }
  if (named) return put(named.folder, "name", `文件名含「${named.token}」，归到${named.folder.name}`, `文件名 · ${named.folder.name}`);
  if (byRule) return put(byRule, "keyword", `按规则「${hit?.match}」归到${byRule.name}`, `规则 · ${hit?.match}`);
  if (deliver) return put(deliver, "keyword", `文件名含交付，归到${deliver.name}`, "文件名 · 交付");

  const purpose = purposeForName(input.name, input.rules);
  const stageName = purpose === "custom" ? undefined : RULE_STAGE[purpose];
  const byWord = stageName ? folderForStage(folders, stageName) : undefined;
  if (byWord) return put(byWord, "keyword", `自动归类到${byWord.name}`, `扩展名 · ${byWord.name}`);
  return put(fallback, "fallback", `自动归类到${fallback.name}`, `归到${fallback.name}`);
}

export const BUILTIN_NOTES = [
  "父文件夹名对得上某一层时以文件夹为准。下载、桌面、文档不算。",
  "否则按扩展名：模型进建模，KeyShot、V-Ray 场景进渲染，图纸和设计稿进草图，图片和视频进渲染，文档进交付。",
  "文件名写了阶段，或设计稿、图片、文档含交付、final、export，以文件名为准。模型和图纸的 final 仍留在建模或草图。",
  "你加的关键词盖过扩展名，但盖不过已经对上的父文件夹。拖进去就固定。",
];

export const PURPOSE_LABEL: Record<ClassRule["purpose"], string> = {
  active: "进行中",
  hold: "待用",
  ref: "参考",
  archive: "归档",
};

export const IN_USE_MS = 2 * 60 * 60 * 1000;

export function ruleHit(name: string, rules: ClassRule[] | undefined): ClassRule | undefined {
  const n = name.toLowerCase();
  return (rules ?? []).find((rule) => rule.match.length > 0 && n.includes(rule.match.toLowerCase()));
}

export function ruleMatchOk(match: string): boolean {
  const text = match.trim().toLowerCase();
  if (text.length < 2 || text.length > 40) return false;
  if (/^[a-z0-9]{1,2}$/.test(text)) return false;
  return true;
}

export function roleForRule(purpose: ClassRule["purpose"], name: string): Role {
  if (purpose === "ref") return "reference";
  if (purpose === "hold") return "export";
  if (purpose === "archive") return "source";
  const named = roleFromName(name);
  if (named === "reference" || named === "export") return "wip";
  return named;
}

export function purposeForName(name: string, rules: ClassRule[] | undefined): ShelfPurpose {
  return ruleHit(name, rules)?.purpose ?? purposeForRole(roleFromName(name));
}

export function isColor(text: string): boolean {
  return /^(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)|hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/.test(
    text.trim(),
  );
}

export function isLink(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export const DEFAULT_IGNORED_APPS = [
  "1password",
  "bitwarden",
  "keepass",
  "keepassxc",
  "lastpass",
  "dashlane",
  "enpass",
];

export function sourceIgnored(source: string, ignored: string[]): boolean {
  const hay = source.toLowerCase();
  return ignored.some((item) => {
    const needle = item.trim().toLowerCase();
    return needle.length > 1 && hay.includes(needle);
  });
}

export function legacyState(
  dbValue: string | null,
  localValue: string | null,
): { value: string | null; write: boolean } {
  if (dbValue && dbValue.trim()) return { value: dbValue, write: false };
  if (localValue && localValue.trim()) return { value: localValue, write: true };
  return { value: null, write: false };
}

export function isSensitive(text: string): boolean {
  const t = text.trim();
  if (/^(password|passwd|pwd|secret|token)\s*[:=]/i.test(t)) return true;
  if (/\b(?:sk|ghp|gho|github_pat|xox[baprs]|AKIA)[A-Za-z0-9_-]{8,}/.test(t)) return true;
  const digits = t.replace(/[\s-]/g, "");
  if (/^\d{13,19}$/.test(digits) && luhn(digits)) return true;
  return false;
}

export type TextClass = ClipKind | "sensitive" | "empty";

export function classifyText(raw: string): TextClass {
  const text = raw.trim();
  if (!text) return "empty";
  if (isSensitive(text)) return "sensitive";
  if (isColor(text)) return "color";
  if (isLink(text)) return "link";
  return "text";
}

export function clipTitle(kind: ClipKind, text: string): string {
  if (kind === "color") return text.toUpperCase();
  if (kind === "link") {
    try {
      const url = new URL(text);
      return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return text;
    }
  }
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 32 ? `${line.slice(0, 32)}…` : line;
}

export function formatBytes(size?: number): string {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatWhen(ts: number, now = Date.now()): string {
  const delta = Math.max(0, now - ts);
  const min = Math.floor(delta / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

const MARK_SVG = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="#132e35"/><circle cx="64" cy="64" r="28" fill="none" stroke="#afb3b7" stroke-width="4"/></svg>`,
)}`;

export function seedContent(now = Date.now()): {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  files: ZoneFile[];
  clips: Clip[];
} {
  const brand = "ws-brand";
  const pack = "ws-pack";
  const product = "ws-id";
  const stages = (prefix: string): Folder[] => [
    { id: `${prefix}-sketch`, parentId: null, name: "草图" },
    { id: `${prefix}-model`, parentId: null, name: "建模" },
    { id: `${prefix}-render`, parentId: null, name: "渲染" },
    { id: `${prefix}-deliver`, parentId: null, name: "交付" },
  ];
  const brandFolders: Folder[] = [...stages("br"), { id: "br-mark", parentId: "br-sketch", name: "标志" }];
  const productFolders: Folder[] = [...stages("id"), { id: "id-shell", parentId: "id-model", name: "外壳" }];
  const file = (
    partial: Pick<ZoneFile, "id" | "folderId" | "name"> &
      Partial<
        Pick<ZoneFile, "pinned" | "openedAt" | "modifiedAt" | "thumb" | "dominant" | "size" | "folderLocked" | "stale" | "workspaceId" | "path" | "tags">
      >,
  ): ZoneFile => ({
    workspaceId: partial.workspaceId ?? brand,
    folderLocked: partial.folderLocked ?? false,
    kind: kindFromName(partial.name),
    role: roleFromName(partial.name),
    pinned: partial.pinned ?? false,
    createdAt: now - 1000 * 60 * 50,
    size: partial.size,
    thumb: partial.thumb,
    dominant: partial.dominant,
    stale: partial.stale,
    openedAt: partial.openedAt,
    modifiedAt: partial.modifiedAt,
    path: partial.path,
    tags: partial.tags ?? [],
    id: partial.id,
    folderId: partial.folderId,
    name: partial.name,
  });

  return {
    activeWorkspaceId: brand,
    workspaces: [
      { id: brand, name: "品牌视觉 Q4", folders: brandFolders, rules: [{ id: "rule-noto", match: "noto", purpose: "hold" }], currentStageId: "br-sketch", doneStageIds: [] },
      { id: pack, name: "包装延展", folders: stages("pk"), rules: [], currentStageId: "pk-sketch", doneStageIds: [] },
      { id: product, name: "产品外壳", folders: productFolders, rules: [], currentStageId: "id-sketch", doneStageIds: [] },
    ],
    files: [
      file({
        id: "f-logo",
        folderId: "br-mark",
        name: "logo-v3.ai",
        size: 2_400_000,
        pinned: true,
        openedAt: now - 1000 * 60 * 12,
        thumb: MARK_SVG,
        dominant: "#1C2B26",
        tags: ["标志"],
        folderLocked: true,
      }),
      file({ id: "f-logo-v1", folderId: "br-mark", name: "logo-v1.3dm", size: 1_100_000, modifiedAt: now - 1000 * 60 * 80 }),
      file({ id: "f-logo-v2", folderId: "br-mark", name: "logo-v2.3dm", size: 1_240_000, modifiedAt: now - 1000 * 60 * 40 }),
      file({
        id: "f-logo-final",
        folderId: "br-mark",
        name: "logo-final.3dm",
        size: 1_360_000,
        modifiedAt: now - 1000 * 60 * 8,
      }),
      file({
        id: "f-logo-rhl",
        folderId: "br-mark",
        name: "logo-final.3dm.rhl",
        size: 48_000,
        modifiedAt: now - 1000 * 60 * 7,
      }),
      file({ id: "f-copy", folderId: "br-deliver", name: "brand-copy.md", size: 12_400, tags: ["文案"] }),
      file({ id: "f-cover", folderId: "br-deliver", name: "cover-final.psd", size: 48_000_000 }),
      file({ id: "f-font", folderId: "br-model", name: "NotoSans-Regular.otf", size: 680_000 }),
      file({
        id: "f-mood",
        folderId: "br-render",
        name: "mood-forest.png",
        size: 3_200_000,
        thumb: MARK_SVG,
        dominant: "#1C2B26",
      }),
      file({
        id: "f-zip",
        folderId: "br-deliver",
        name: "handoff-export.zip",
        size: 18_000_000,
        stale: true,
        folderLocked: true,
      }),
      file({
        id: "f-sld",
        workspaceId: product,
        folderId: "id-shell",
        name: "housing-v3.sldprt",
        size: 12_800_000,
        openedAt: now - 1000 * 60 * 20,
        path: "D:/产品外壳/外壳/housing-v3.sldprt",
      }),
      file({
        id: "f-step",
        workspaceId: product,
        folderId: "id-model",
        name: "shell-final.step",
        size: 4_600_000,
      }),
      file({
        id: "f-nx",
        workspaceId: product,
        folderId: "id-shell",
        name: "bracket.prt.1",
        size: 2_200_000,
      }),
      file({
        id: "f-dwg",
        workspaceId: product,
        folderId: "id-sketch",
        name: "section-a.dwg",
        size: 860_000,
        folderLocked: true,
      }),
    ],
    clips: [
      {
        id: "c-color",
        kind: "color",
        text: "#1C2B26",
        name: "#1C2B26",
        pinned: true,
        createdAt: now - 1000 * 60 * 40,
        usedAt: now - 1000 * 60 * 8,
      },
      {
        id: "c-line",
        kind: "text",
        text: "把安静做成像完成过的事。",
        name: "把安静做成像完成过的事。",
        pinned: false,
        createdAt: now - 1000 * 60 * 30,
        usedAt: now - 1000 * 60 * 30,
      },
      {
        id: "c-link",
        kind: "link",
        text: "https://za.studio/brand/q4",
        name: "za.studio/brand/q4",
        pinned: false,
        createdAt: now - 1000 * 60 * 20,
        usedAt: now - 1000 * 60 * 20,
      },
      {
        id: "c-mark",
        kind: "image",
        thumb: MARK_SVG,
        dominant: "#1C2B26",
        name: "标记草图",
        pinned: false,
        createdAt: now - 1000 * 60 * 15,
        usedAt: now - 1000 * 60 * 15,
      },
    ],
  };
}

/** 收起胶囊停靠在哪条屏幕边，以及沿这条边的相对位置（0 到 1，0.5 是正中）。 */
export type DockEdge = "top" | "bottom" | "left" | "right";
export type Dock = { edge: DockEdge; t: number };
export const DEFAULT_DOCK: Dock = { edge: "top", t: 0.5 };
