import type { ZoneFile } from "./model.ts";

export const ROLLING_KEEP = 10;
export const DAILY_KEEP = 7;

export type VersionIdentity = {
  key: string;
  backup: boolean;
  rank: number;
};

export type VersionCard = {
  groupKey: string;
  head: ZoneFile;
  members: ZoneFile[];
  visibleCount: number;
  backupCount: number;
  manual: boolean;
};

type Parsed = VersionIdentity & { file: ZoneFile };

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function backupStamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

export function dailyBackupName(date: Date): string {
  return `daily-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.json`;
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

const ROLLING_NAME = /^\d{8}-\d{6}-\d{3}\.json$/;
const DAILY_NAME = /^daily-\d{8}\.json$/;

export function isRollingBackup(name: string): boolean {
  return ROLLING_NAME.test(name);
}

export function isDailyBackup(name: string): boolean {
  return DAILY_NAME.test(name);
}

export function backupLabel(name: string): string {
  const daily = name.match(/^daily-(\d{4})(\d{2})(\d{2})\.json$/);
  if (daily) return `${Number(daily[2])}月${Number(daily[3])}日的每日备份`;
  const rolling = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (rolling) return `${Number(rolling[2])}月${Number(rolling[3])}日 ${rolling[4]}:${rolling[5]}`;
  if (name === "workzone.json.bak") return "迁移前的清单";
  return name;
}

export function backupOrder(names: string[]): string[] {
  const rolling = names.filter(isRollingBackup).sort().reverse();
  const daily = names.filter(isDailyBackup).sort().reverse();
  const rest = names.filter((name) => !isRollingBackup(name) && !isDailyBackup(name) && name.endsWith(".json"));
  return [...rolling, ...daily, ...rest];
}

export function pruneBackupNames(names: string[], now = new Date()): string[] {
  const rolling = names.filter(isRollingBackup).sort();
  const drop = new Set(rolling.slice(0, Math.max(0, rolling.length - ROLLING_KEEP)));
  const daily = names.filter(isDailyBackup).sort();
  const cutoff = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DAILY_KEEP - 1)));
  const keep = new Set(daily.slice(-DAILY_KEEP).filter((name) => name.slice(6, 14) >= cutoff));
  for (const name of daily) {
    if (!keep.has(name)) drop.add(name);
  }
  return [...drop];
}

function cleanStem(stem: string): string {
  return stem.replace(/[-_\s.]+$/g, "").replace(/^[-_\s.]+/g, "").trim();
}

function takeDate(stem: string): { stem: string; rank: number } | null {
  const dashed = stem.match(/^(.*?)(?:[-_\s.])?((?:19|20)\d{2})-(\d{2})-(\d{2})$/);
  const compact = dashed ? null : stem.match(/^(.*?)(?:[-_\s.])?((?:19|20)\d{2})(\d{2})(\d{2})$/);
  const match = dashed ?? compact;
  if (!match) return null;
  const month = Number(match[3]);
  const day = Number(match[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const next = cleanStem(match[1] ?? "");
  if (!next) return null;
  return { stem: next, rank: Number(match[2]) * 10000 + month * 100 + day };
}

function takeToken(stem: string): { stem: string; rank: number } | null {
  const patterns: { re: RegExp; rank: (match: RegExpMatchArray) => number }[] = [
    { re: /^(.*?)(?:\s*)[(（](\d+)[)）]$/, rank: (match) => Number(match[2]) || 0 },
    { re: /^(.*?)(?:^|[-_\s.])v(?:er(?:sion)?)?\s*(\d+)$/i, rank: (match) => Number(match[2]) || 0 },
    { re: /^(.*?)(?:^|[-_\s.])copy\s*(\d*)$/i, rank: (match) => Number(match[2] || 0) },
    { re: /^(.*?)(?:[-_\s.])?(?:final)\s*(\d*)$/i, rank: (match) => 100000 + Number(match[2] || 0) },
    { re: /^(.*?)(?:[-_\s.])?(?:最终|终版)\s*(\d*)$/, rank: (match) => 100000 + Number(match[2] || 0) },
    { re: /^(.*?)(?:[-_\s.])?副本\s*(\d*)$/, rank: (match) => Number(match[2] || 0) },
  ];
  for (const pattern of patterns) {
    const match = stem.match(pattern.re);
    if (!match) continue;
    const next = cleanStem(match[1] ?? "");
    if (!next || next === stem) continue;
    return { stem: next, rank: pattern.rank(match) };
  }
  return null;
}

function stripOnce(stem: string): { stem: string; rank: number } | null {
  return takeDate(stem) ?? takeToken(stem);
}

export function versionIdentity(filename: string): VersionIdentity {
  let backup = false;
  let name = filename.trim();
  if (/\.rhl$/i.test(name)) {
    backup = true;
    name = name.replace(/\.rhl$/i, "");
  }
  if (/\.3dmbak$/i.test(name)) {
    backup = true;
    name = name.replace(/\.3dmbak$/i, ".3dm");
  }
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  let stem = dot > 0 ? name.slice(0, dot) : name;
  let rank = 0;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = stripOnce(stem);
    if (!next) break;
    stem = next.stem;
    rank = Math.max(rank, next.rank);
  }
  return { key: `${stem.toLowerCase()}${ext}`, backup, rank };
}

export function isRhinoBackup(filename: string): boolean {
  return versionIdentity(filename).backup;
}

function timeOf(file: ZoneFile): number {
  return file.modifiedAt ?? file.createdAt ?? 0;
}

function byNewest(a: Parsed, b: Parsed): number {
  const delta = timeOf(b.file) - timeOf(a.file);
  if (delta !== 0) return delta;
  if (b.rank !== a.rank) return b.rank - a.rank;
  return a.file.name.localeCompare(b.file.name, "zh");
}

function restoredName(filename: string): string {
  return filename.trim().replace(/\.rhl$/i, "").replace(/\.3dmbak$/i, ".3dm").toLowerCase();
}

export function versionCards(files: ZoneFile[]): VersionCard[] {
  const parsed: Parsed[] = files.map((file) => ({ file, ...versionIdentity(file.name) }));
  const buckets: { key: string; items: Parsed[] }[] = [];
  const index = new Map<string, { key: string; items: Parsed[] }>();
  const put = (key: string, item: Parsed) => {
    let bucket = index.get(key);
    if (!bucket) {
      bucket = { key, items: [] };
      index.set(key, bucket);
      buckets.push(bucket);
    }
    bucket.items.push(item);
  };
  const backups: Parsed[] = [];
  for (const item of parsed) {
    if (item.file.versionGroup) put(`group:${item.file.versionGroup}`, item);
    else if (item.file.versionSolo) put(`solo:${item.file.id}`, item);
    else if (item.backup) backups.push(item);
    else put(`auto:${item.file.folderId}:${item.key}`, item);
  }
  for (const item of backups) {
    const base = restoredName(item.file.name);
    const exact = buckets.find((bucket) =>
      bucket.items.some((other) => !other.backup && other.file.name.toLowerCase() === base),
    );
    const keyed = buckets.find((bucket) =>
      bucket.items.some((other) => !other.backup && !other.file.versionSolo && other.key === item.key),
    );
    const target = exact ?? keyed;
    if (target) target.items.push(item);
    else put(`backup:${item.file.folderId}:${item.file.id}`, item);
  }
  return buckets.map((bucket) => {
    const hidden = bucket.items.filter((item) => item.backup);
    const visible = bucket.items.filter((item) => !item.backup);
    const pool = visible.length > 0 ? visible : bucket.items;
    const pinned = pool.find((item) => item.file.versionCurrent);
    const head = pinned ?? [...pool].sort(byNewest)[0];
    if (!head) {
      const fallback = bucket.items[0];
      if (!fallback) throw new Error("空的版本组");
      return {
        groupKey: bucket.key,
        head: fallback.file,
        members: [fallback.file],
        visibleCount: 1,
        backupCount: 0,
        manual: false,
      };
    }
    const ordered = [
      head,
      ...visible.filter((item) => item.file.id !== head.file.id).sort(byNewest),
      ...hidden.filter((item) => item.file.id !== head.file.id).sort(byNewest),
    ];
    return {
      groupKey: bucket.key,
      head: head.file,
      members: ordered.map((item) => item.file),
      visibleCount: visible.length > 0 ? visible.length : bucket.items.length,
      backupCount: hidden.length,
      manual: Boolean(pinned),
    };
  });
}
