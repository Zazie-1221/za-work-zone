import assert from "node:assert/strict";
import test from "node:test";
import { advanceStage, reopenStage, resetStages, stageActionLabel, type Folder, type Workspace } from "./model.ts";

const folders: Folder[] = [
  { id: "sketch", parentId: null, name: "草图" },
  { id: "model", parentId: null, name: "建模" },
  { id: "shell", parentId: "model", name: "外壳" },
  { id: "render", parentId: null, name: "渲染" },
  { id: "deliver", parentId: null, name: "交付" },
];

function zone(currentStageId: string, doneStageIds: string[] = []): Workspace {
  return { id: "ws", name: "品牌", folders, rules: [], currentStageId, doneStageIds };
}

test("confirming a stage starts the next root, and groups are not stages", () => {
  const first = advanceStage(zone("sketch"));
  assert.equal(first.message, "草图已确认，开始建模");
  assert.equal(first.workspace.currentStageId, "model");
  assert.deepEqual(first.workspace.doneStageIds, ["sketch"]);
  assert.equal(stageActionLabel(first.workspace), "确认建模，开始渲染");

  const last = advanceStage(zone("deliver", ["sketch", "model", "render"]));
  assert.equal(last.message, "交付已确认");
  assert.equal(last.workspace.currentStageId, "deliver");
  assert.equal(stageActionLabel(last.workspace), null);
});

test("a confirmed stage still has a next step until the rest are done", () => {
  const started = zone("sketch", ["sketch"]);
  assert.equal(stageActionLabel(started), "下一步 · 建模");
  const moved = advanceStage(started);
  assert.equal(moved.workspace.currentStageId, "model");
  assert.equal(moved.message, "现在是建模");
});

test("reopening a confirmed stage returns to it and clears everything after", () => {
  const all = zone("deliver", ["sketch", "model", "render", "deliver"]);
  const back = reopenStage(all, "model");
  assert.equal(back.workspace.currentStageId, "model");
  assert.deepEqual(back.workspace.doneStageIds, ["sketch"]);
  assert.equal(back.message, "已回到建模");
  assert.equal(stageActionLabel(back.workspace), "确认建模，开始渲染");
  const first = reopenStage(all, "sketch");
  assert.deepEqual(first.workspace.doneStageIds, []);
  assert.equal(reopenStage(all, "nope").workspace, all);
});

test("resetting stages clears confirmations and returns to the first stage", () => {
  const all = zone("deliver", ["sketch", "model", "render", "deliver"]);
  const reset = resetStages(all);
  assert.equal(reset.workspace.currentStageId, "sketch");
  assert.deepEqual(reset.workspace.doneStageIds, []);
  assert.equal(stageActionLabel(reset.workspace), "确认草图，开始建模");
});