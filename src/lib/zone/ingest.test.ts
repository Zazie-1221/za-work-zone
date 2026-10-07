import assert from "node:assert/strict";
import test from "node:test";
import { joinStorePath, MODE_HINT, MODE_LABEL, stageSubdir, tallyLine } from "./ingest.ts";
import { defaultFolders } from "./model.ts";

test("store paths keep the store folder's own separator and spaces", () => {
  assert.equal(joinStorePath("D:\\My Projects\\first project", "03建模"), "D:\\My Projects\\first project\\03建模");
  assert.equal(joinStorePath("D:\\store\\", "03建模/子 文件夹"), "D:\\store\\03建模\\子 文件夹");
  assert.equal(joinStorePath("/home/me/proj", "渲染"), "/home/me/proj/渲染");
  assert.equal(joinStorePath("D:\\store", ""), "D:\\store");
});

test("characters Windows rejects in a stage name are replaced", () => {
  assert.equal(joinStorePath("D:\\store", 'a:b?/c*'), "D:\\store\\a-b-\\c-");
  assert.equal(joinStorePath("D:\\store", "end. "), "D:\\store\\end");
});

test("every stage maps to a sub-folder of the store folder", () => {
  const folders = defaultFolders();
  for (const folder of folders.filter((item) => item.parentId == null)) {
    assert.equal(stageSubdir(folders, folder.id), folder.name);
  }
});

test("the summary says what really happened to the files", () => {
  assert.equal(tallyLine({ copied: 0, moved: 0, linked: 0 }, "X"), "");
  assert.match(tallyLine({ copied: 2, moved: 0, linked: 0 }, "「D:\\p」"), /已复制 2 个到「D:\\p」，原文件还在/);
  assert.match(tallyLine({ copied: 0, moved: 1, linked: 0 }, "项目包"), /已移动 1 个到项目包，原文件已不在原位置/);
  assert.match(tallyLine({ copied: 0, moved: 0, linked: 3 }, "x"), /只记录了路径（3 个），文件没动/);
  assert.equal(Object.keys(MODE_LABEL).length, 3);
  assert.match(MODE_HINT.move, /原处不再有/);
});
