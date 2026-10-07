import assert from "node:assert/strict";
import test from "node:test";
import { planPaths, type PathFact } from "./incoming.ts";
import { advanceHint, clampProgress, matchesStoredPath, resumeBrief, splitIncoming } from "./notes.ts";
import { defaultFolders, type Workspace, type ZoneFile } from "./model.ts";

function fact(path: string, patch: Partial<PathFact> = {}): PathFact {
  const name = path.split(/[/\\]/).pop() || path;
  return { path, name, exists: true, isDir: false, readable: true, size: 12, ...patch };
}

test("the same path is not planned twice", () => {
  const plans = planPaths(
    ["D:/art/logo.ai"],
    [fact("D:\\art\\logo.ai"), fact("D:/art/logo.ai"), fact("D:/art/cover.psd")],
    "copy",
  );
  assert.equal(plans.filter((plan) => plan.kind === "duplicate").length, 2);
  assert.equal(plans.find((plan) => plan.kind === "copy")?.name, "cover.psd");
});

test("missing files and folders stay explicit; big files are still copied", () => {
  const plans = planPaths(
    [],
    [
      fact("D:/gone.png", { exists: false, readable: false, reason: "找不到 D:/gone.png。" }),
      fact("D:/refs", { isDir: true }),
      fact("D:/huge.mp4", { size: 40 * 1024 * 1024 }),
      fact("D:/locked.txt", { readable: false, reason: "没有权限读取 D:/locked.txt。" }),
    ],
    "copy",
  );
  assert.deepEqual(
    plans.map((plan) => plan.kind),
    ["fail", "record", "copy", "fail"],
  );
  assert.match(plans[0]?.kind === "fail" ? plans[0].reason : "", /找不到/);
  assert.match(plans[1]?.kind === "record" ? plans[1].because : "", /文件夹/);
  assert.match(plans[3]?.kind === "fail" ? plans[3].reason : "", /没有权限/);
});

test("copy and move plans keep their mode; only link records", () => {
  const facts = [fact("D:/my files/shubiao new.3dm"), fact("D:/my files/first.ksp")];
  assert.deepEqual(
    planPaths([], facts, "copy").map((plan) => (plan.kind === "copy" ? plan.mode : plan.kind)),
    ["copy", "copy"],
  );
  assert.deepEqual(
    planPaths([], facts, "move").map((plan) => (plan.kind === "copy" ? plan.mode : plan.kind)),
    ["move", "move"],
  );
});

test("dropping a file that is already known still honours the chosen mode", () => {
  const src = "C:/Users/me/My Files/a b.3dm";
  const linked = { id: "L", path: src, sourcePath: src, external: true };
  const copied = { id: "C", path: "D:/store/03 建模/a b.3dm", sourcePath: src, external: false };
  const existing = [src, "D:/store/03 建模/a b.3dm"];
  const kinds = (plans: ReturnType<typeof planPaths>) => plans.map((plan) => (plan.kind === "copy" ? `${plan.mode}:${plan.replaceId ?? ""}` : plan.kind));

  // 以前只记了路径 → 现在选复制/移动，要真的放进去，并替换那条旧记录
  assert.deepEqual(kinds(planPaths([src], [fact(src)], "move", [linked])), ["move:L"]);
  assert.deepEqual(kinds(planPaths([src], [fact(src)], "copy", [linked])), ["copy:L"]);
  assert.deepEqual(kinds(planPaths([src], [fact(src)], "link", [linked])), ["duplicate"]);

  // 以前复制进来、原文件还在 → 选移动，要把原文件移走；选复制/只记录仍然是重复
  const settle = planPaths(existing, [fact(src)], "move", [copied])[0];
  assert.equal(settle?.kind, "settle");
  assert.equal(settle?.kind === "settle" ? settle.keptPath : "", "D:/store/03 建模/a b.3dm");
  assert.deepEqual(kinds(planPaths(existing, [fact(src)], "copy", [copied])), ["duplicate"]);
  assert.deepEqual(kinds(planPaths(existing, [fact(src)], "link", [copied])), ["duplicate"]);

  // 项目包里的相对路径不是磁盘路径，不会去“移走”
  const pkg = { id: "P", path: "03 建模/a b.3dm", sourcePath: src, external: false };
  assert.deepEqual(kinds(planPaths([src, "03 建模/a b.3dm"], [fact(src)], "move", [pkg])), ["duplicate"]);

  // 文件夹或读不了的文件，即使“已知”也不会走复制/移动
  assert.deepEqual(kinds(planPaths([src], [fact(src, { isDir: true })], "move", [linked])), ["duplicate"]);
});
test("link mode records every readable file", () => {
  const plans = planPaths([], [fact("D:/a.ai"), fact("D:/b.psd")], "link");
  assert.equal(plans.every((plan) => plan.kind === "record"), true);
});

test("progress, dedupe, and the resume card stay within the limits", () => {
  assert.equal(clampProgress(`  ${"字".repeat(90)}  `).length, 80);
  const split = splitIncoming(["C:/A/one.png"], ["c:/a/one.png", "C:/A/two.png"]);
  assert.deepEqual(split.duplicate, ["c:/a/one.png"]);
  assert.deepEqual(split.fresh, ["C:/A/two.png"]);
  assert.equal(matchesStoredPath({ path: "01草图/one.png", sourcePath: "C:/A/one.png" }, "c:/a/one.png"), true);

  const folders = defaultFolders();
  const sketch = folders[0];
  assert.ok(sketch);
  const workspace: Workspace = {
    id: "ws",
    name: "品牌",
    folders,
    rules: [],
    currentStageId: sketch.id,
    stageNotes: [
      {
        folderId: sketch.id,
        note: "三稿",
        updatedAt: 5,
        todos: [
          { id: "a", text: "补背景", done: false },
          { id: "b", text: "已定标题", done: true },
          { id: "c", text: "导出封面", done: false },
        ],
      },
    ],
  };
  assert.match(advanceHint(workspace, sketch.id), /2 件待办/);
  const files: ZoneFile[] = [
    {
      id: "f1",
      workspaceId: "ws",
      folderId: sketch.id,
      folderLocked: false,
      kind: "image",
      role: "wip",
      name: "hero.png",
      tags: [],
      pinned: false,
      createdAt: 1,
      openedAt: 9,
      note: "差背景",
    },
  ];
  const brief = resumeBrief(workspace, files);
  assert.equal(brief?.stageName, sketch.name);
  assert.deepEqual(brief?.files, ["hero.png"]);
  assert.deepEqual(brief?.todos, ["补背景", "导出封面"]);
});
