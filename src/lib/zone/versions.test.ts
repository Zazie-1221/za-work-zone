import assert from "node:assert/strict";
import test from "node:test";
import type { ZoneFile } from "./model.ts";
import {
  backupOrder,
  dailyBackupName,
  isRhinoBackup,
  pruneBackupNames,
  versionCards,
  versionIdentity,
} from "./versions.ts";

function file(partial: Partial<ZoneFile> & Pick<ZoneFile, "id" | "name">): ZoneFile {
  return {
    workspaceId: "w",
    folderId: partial.folderId ?? "sketch",
    folderLocked: false,
    kind: "model",
    role: "wip",
    tags: [],
    pinned: false,
    createdAt: partial.createdAt ?? 1,
    ...partial,
  };
}

test("version markers collapse to one key, including dates, copies, and rhino backups", () => {
  const keys = [
    "logo-v1.3dm",
    "logo-v02.3dm",
    "logo_v3.3dm",
    "logo-final.3dm",
    "logofinal2.3dm",
    "logo最终.3dm",
    "logo-终版.3dm",
    "logo - 副本 (2).3dm",
    "logo copy.3dm",
    "logo (1).3dm",
    "logo(1).3dm",
    "logo_20261004.3dm",
    "logo-2026-10-04.3dm",
  ].map((name) => versionIdentity(name).key);
  assert.equal(new Set(keys).size, 1);
  assert.equal(keys[0], "logo.3dm");
  assert.equal(versionIdentity("logo-v2.3dm.rhl").backup, true);
  assert.equal(versionIdentity("logo-v2.3dmbak").key, "logo.3dm");
  assert.equal(isRhinoBackup("logo.3dm.rhl"), true);
  assert.equal(versionIdentity("rev1.3dm").key, "rev1.3dm");
  assert.equal(versionIdentity("logo-v1.3dm").key === versionIdentity("logo-v1.ai").key, false);
});

test("logo-v1, logo-v2 and logo-final show as one card with three versions", () => {
  const cards = versionCards([
    file({ id: "a", name: "logo-v1.3dm", modifiedAt: 10, size: 1 }),
    file({ id: "b", name: "logo-v2.3dm", modifiedAt: 20, size: 2 }),
    file({ id: "c", name: "logo-final.3dm", modifiedAt: 15, size: 3 }),
    file({ id: "d", name: "logo-final.3dm.rhl", modifiedAt: 16, size: 1 }),
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.visibleCount, 3);
  assert.equal(cards[0]?.backupCount, 1);
  assert.equal(cards[0]?.head.name, "logo-v2.3dm");
  assert.equal(cards[0]?.members.some((item) => item.name.endsWith(".rhl")), true);
});

test("same modified time falls back to the version rank, and a chosen current stays", () => {
  const tied = versionCards([
    file({ id: "a", name: "logo-v1.3dm", modifiedAt: 10 }),
    file({ id: "b", name: "logo-v2.3dm", modifiedAt: 10 }),
    file({ id: "c", name: "logo-final.3dm", modifiedAt: 10 }),
  ]);
  assert.equal(tied[0]?.head.name, "logo-final.3dm");
  assert.equal(tied[0]?.manual, false);
  const pinned = versionCards([
    file({ id: "a", name: "logo-v1.3dm", modifiedAt: 10, versionCurrent: true }),
    file({ id: "b", name: "logo-v2.3dm", modifiedAt: 50 }),
    file({ id: "c", name: "logo-final.3dm", modifiedAt: 40 }),
  ]);
  assert.equal(pinned[0]?.head.id, "a");
  assert.equal(pinned[0]?.manual, true);
});

test("split and merge override the automatic group", () => {
  const split = versionCards([
    file({ id: "a", name: "logo-v1.3dm", versionSolo: true }),
    file({ id: "b", name: "logo-v2.3dm" }),
    file({ id: "c", name: "logo-final.3dm" }),
    file({ id: "d", name: "logo-v1.3dm.rhl" }),
  ]);
  assert.equal(split.length, 2);
  const alone = split.find((card) => card.head.id === "a");
  assert.equal(alone?.members.some((item) => item.id === "d"), true);
  const merged = versionCards([
    file({ id: "a", name: "logo.3dm", versionGroup: "g1" }),
    file({ id: "b", name: "mark.ai", versionGroup: "g1" }),
    file({ id: "c", name: "other.3dm" }),
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((card) => card.groupKey === "group:g1")?.visibleCount, 2);
});

test("files in another folder are not part of this group", () => {
  const here = versionCards([file({ id: "a", name: "logo-v1.3dm", folderId: "a" })]);
  const there = versionCards([file({ id: "b", name: "logo-v2.3dm", folderId: "b" })]);
  assert.equal(here.length, 1);
  assert.equal(there.length, 1);
  assert.equal(here[0]?.visibleCount, 1);
});

test("rolling backups keep ten and daily backups keep seven days", () => {
  const rolling = Array.from({ length: 12 }, (_, index) => `20261001-120000-${String(index).padStart(3, "0")}.json`);
  const daily = ["20260901", "20260920", "20260927", "20260928", "20260929", "20260930", "20261001", "20261002", "20261003"].map(
    (day) => `daily-${day}.json`,
  );
  const drop = pruneBackupNames([...rolling, ...daily], new Date(2026, 9, 3, 12));
  const keptRolling = rolling.filter((name) => !drop.includes(name));
  assert.equal(keptRolling.length, 10);
  assert.equal(drop.includes(rolling[0] ?? ""), true);
  assert.equal(drop.includes(rolling[11] ?? ""), false);
  const keptDaily = daily.filter((name) => !drop.includes(name));
  assert.equal(keptDaily.length, 7);
  assert.equal(drop.includes("daily-20260901.json"), true);
  assert.equal(drop.includes("daily-20261003.json"), false);
  assert.equal(dailyBackupName(new Date(2026, 9, 4)), "daily-20261004.json");
  assert.deepEqual(backupOrder(["daily-20261003.json", "20261004-010000-000.json", "notes.txt"]).slice(0, 2), [
    "20261004-010000-000.json",
    "daily-20261003.json",
  ]);
});
