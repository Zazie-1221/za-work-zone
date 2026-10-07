import type { Folder, IngestMode } from "./model.ts";
import { dirPrefix } from "./package.ts";

// Windows 文件夹名里不能有的字符，用户自建的阶段名可能带。
const BAD_SEGMENT = /[<>:"|?*\u0000-\u001f]/g;

function cleanSegment(part: string): string {
  const cleaned = part.replace(BAD_SEGMENT, "-").replace(/[. ]+$/, "").trim();
  return cleaned || "未命名";
}

/** 存放文件夹 + 阶段子文件夹（relative 用 / 分隔）→ 磁盘上的完整路径，沿用存放文件夹自己的分隔符。 */
export function joinStorePath(storeDir: string, relative: string): string {
  const windows = storeDir.includes("\\") || /^[a-zA-Z]:/.test(storeDir);
  const sep = windows ? "\\" : "/";
  const base = storeDir.replace(/[\\/]+$/, "");
  const rel = relative
    .split("/")
    .filter(Boolean)
    .map(cleanSegment)
    .join(sep);
  return rel ? `${base}${sep}${rel}` : base;
}

/** 某个阶段在存放文件夹里的子目录（和项目包里的目录同一套命名）。 */
export function stageSubdir(folders: Folder[], folderId: string): string {
  return dirPrefix(folders, folderId);
}

export const MODE_LABEL: Record<IngestMode, string> = {
  copy: "复制进来",
  move: "移动进来",
  link: "只记录路径",
};

export const MODE_HINT: Record<IngestMode, string> = {
  copy: "原文件留在原处，复制一份到项目文件夹",
  move: "把原文件移进项目文件夹，原处不再有",
  link: "不动文件，只记一条路径",
};

export type IngestTally = { copied: number; moved: number; linked: number };

/** 一批文件处理完之后给状态栏的一句话（各种结果合在一起说清楚）。 */
export function tallyLine(tally: IngestTally, where: string): string {
  const parts: string[] = [];
  if (tally.copied > 0) parts.push(`已复制 ${tally.copied} 个到${where}，原文件还在`);
  if (tally.moved > 0) parts.push(`已移动 ${tally.moved} 个到${where}，原文件已不在原位置`);
  if (tally.linked > 0) parts.push(`只记录了路径（${tally.linked} 个），文件没动`);
  return parts.length > 0 ? `${parts.join("；")}。` : "";
}
