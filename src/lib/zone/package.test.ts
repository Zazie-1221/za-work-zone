import assert from "node:assert/strict";
import test from "node:test";
import {
  copyTree,
  externalRows,
  includeInPackageZip,
  lockBlocks,
  materialize,
  newManifest,
  packFit,
  placeCopiedFile,
  readTree,
  recoverManifest,
  renameFolderInManifest,
  unzipTree,
  zipTree,
  BIG_FILE,
} from "./package.ts";

test("a copied project folder opens with the same tree and files", () => {
  let manifest = newManifest("品牌视觉 Q4");
  const sketch = manifest.folders[0];
  assert.ok(sketch);
  const placed = placeCopiedFile(manifest, { name: "logo.ai", folderId: sketch.id, size: 1200 });
  manifest = placed.manifest;
  const mood = manifest.folders.find((folder) => folder.name === "05参考");
  assert.ok(mood);
  const second = placeCopiedFile(manifest, { name: "mood.png", folderId: mood.id, size: 80 });
  manifest = second.manifest;
  const tree = materialize(manifest, {
    [placed.relativePath]: new TextEncoder().encode("logo"),
    [second.relativePath]: new TextEncoder().encode("mood"),
  });
  const opened = readTree(copyTree(tree));
  assert.equal(opened.workspace.name, "品牌视觉 Q4");
  assert.deepEqual(
    opened.workspace.folders.map((folder) => folder.name),
    ["01草图", "02建模", "03渲染", "04交付", "05参考"],
  );
  assert.equal(opened.files.length, 2);
  assert.equal(opened.files.every((file) => file.stale !== true), true);
  assert.equal(opened.files.find((file) => file.name === "logo.ai")?.path, placed.relativePath);
});

test("a deleted file is marked missing and can be retargeted", () => {
  let manifest = newManifest("外壳");
  const sketch = manifest.folders[0];
  assert.ok(sketch);
  const placed = placeCopiedFile(manifest, { name: "section.dwg", folderId: sketch.id, size: 40 });
  manifest = placed.manifest;
  const tree = materialize(manifest, { [placed.relativePath]: new Uint8Array([1, 2, 3]) });
  tree.delete(placed.relativePath);
  const opened = readTree(tree);
  const file = opened.files[0];
  assert.ok(file);
  assert.equal(file.stale, true);
  assert.equal(file.name, "section.dwg");
});

test("renaming a stage rewrites the folder and the relative paths", () => {
  let manifest = newManifest("包装");
  const sketch = manifest.folders[0];
  assert.ok(sketch);
  manifest = placeCopiedFile(manifest, { name: "cover.psd", folderId: sketch.id }).manifest;
  const renamed = renameFolderInManifest(manifest, sketch.id, "草图初稿");
  assert.equal(renamed.folders[0]?.name, "草图初稿");
  assert.equal(renamed.files[0]?.relativePath, "草图初稿/cover.psd");
});

test("an older manifest is migrated and the previous json is kept", () => {
  const manifest = newManifest("旧项目");
  const legacy = { ...manifest, format: undefined };
  const tree = new Map<string, Uint8Array>([["workzone.json", new TextEncoder().encode(JSON.stringify(legacy))]]);
  const opened = readTree(tree);
  assert.equal(opened.migrated, true);
  assert.equal(opened.manifest.format, 2);
  assert.ok(tree.has("workzone.json.bak"));
});

test("progress, stage notes, and file notes round-trip through the package", () => {
  let manifest = newManifest("进度");
  const sketch = manifest.folders[0];
  assert.ok(sketch);
  manifest = {
    ...manifest,
    progress: `  ${"进".repeat(90)}`,
    ingestMode: "link",
    stageNotes: [
      {
        folderId: sketch.id,
        note: "先出三稿",
        todos: [{ id: "t1", text: "补背景", done: false }],
        updatedAt: 10,
      },
    ],
  };
  const placed = placeCopiedFile(manifest, { name: "hero.png", folderId: sketch.id, size: 20 });
  manifest = placed.manifest;
  const file = manifest.files[0];
  assert.ok(file);
  file.note = "差背景";
  file.sourcePath = "D:/art/hero.png";
  const opened = readTree(materialize(manifest));
  assert.equal(opened.workspace.progress?.length, 80);
  assert.equal(opened.workspace.ingestMode, "link");
  assert.equal(opened.workspace.stageNotes?.[0]?.note, "先出三稿");
  assert.equal(opened.workspace.stageNotes?.[0]?.todos[0]?.text, "补背景");
  assert.equal(opened.files[0]?.note, "差背景");
  assert.equal(opened.files[0]?.sourcePath, "D:/art/hero.png");
  const again = readTree(materialize(opened.manifest));
  assert.equal(again.migrated, false);
  assert.equal(again.files[0]?.note, "差背景");
  assert.equal(again.workspace.stageNotes?.[0]?.todos.length, 1);
});

test("zip roundtrip skips the lock and temp files", () => {
  const manifest = newManifest("可带走");
  const tree = materialize(manifest);
  tree.set("workzone.lock", new TextEncoder().encode("1"));
  tree.set("workzone.json.tmp", new TextEncoder().encode("x"));
  tree.set(".cache/thumb.bin", new Uint8Array([9]));
  const zip = zipTree(tree);
  const back = unzipTree(zip);
  assert.equal(back.has("workzone.json"), true);
  assert.equal(back.has("workzone.lock"), false);
  assert.equal(back.has("workzone.json.tmp"), false);
  assert.equal(back.has(".cache/thumb.bin"), false);
  assert.equal(includeInPackageZip("01草图/a.png"), true);
  assert.equal(includeInPackageZip(".workzone/backups/daily-20261004.json"), false);
});

test("external files list size and a missing one does not block the rest", () => {
  const rows = externalRows([
    {
      id: "a",
      workspaceId: "w",
      folderId: "f",
      folderLocked: false,
      kind: "image",
      role: "reference",
      name: "scan.tif",
      external: true,
      path: "D:/扫描/scan.tif",
      size: BIG_FILE + 1,
      tags: [],
      pinned: false,
      createdAt: 0,
    },
    {
      id: "b",
      workspaceId: "w",
      folderId: "f",
      folderLocked: false,
      kind: "document",
      role: "source",
      name: "gone.pdf",
      external: true,
      stale: true,
      tags: [],
      pinned: false,
      createdAt: 0,
    },
  ]);
  assert.equal(rows[0]?.big, true);
  assert.equal(rows[1]?.missing, true);
  const fit = packFit(rows, ["a", "b"], BIG_FILE);
  assert.equal(fit.short, true);
  assert.equal(fit.total, BIG_FILE + 1);
});

test("version choice and a broken manifest come back from the newest backup", () => {
  let manifest = newManifest("标志");
  const sketch = manifest.folders[0];
  assert.ok(sketch);
  manifest = placeCopiedFile(manifest, { name: "logo-v1.3dm", folderId: sketch.id, size: 10 }).manifest;
  manifest = placeCopiedFile(manifest, { name: "logo-final.3dm", folderId: sketch.id, size: 12 }).manifest;
  const first = manifest.files[0];
  assert.ok(first);
  first.versionCurrent = true;
  first.modifiedAt = 10;
  const opened = readTree(materialize(manifest));
  assert.equal(opened.files.find((file) => file.name === "logo-v1.3dm")?.versionCurrent, true);
  assert.equal(opened.manifest.files[0]?.versionCurrent, true);
  const good = JSON.stringify(opened.manifest);
  const recovered = recoverManifest("{", [
    { name: "20261003-090000-000.json", raw: JSON.stringify({ ...opened.manifest, name: "旧" }) },
    { name: "20261004-120000-000.json", raw: good },
  ]);
  assert.equal(recovered.recoveredFrom, "10月4日 12:00");
  assert.equal(recovered.manifest.name, "标志");
  assert.throws(() => recoverManifest(null, []), /不是项目包/);
  assert.throws(() => recoverManifest("{}", []), /没有可用的备份/);
});

test("another window's fresh lock blocks editing", () => {
  assert.equal(lockBlocks({ id: "other", at: 1_000 }, "self", 2_000), true);
  assert.equal(lockBlocks({ id: "self", at: 1_000 }, "self", 2_000), false);
  assert.equal(lockBlocks({ id: "other", at: 1_000 }, "self", 30_000), false);
});
