import assert from "node:assert/strict";
import test from "node:test";
import { kindFromName, placeFile, type ClassRule, type Folder } from "./model.ts";

const folders: Folder[] = [
  { id: "sketch", parentId: null, name: "草图" },
  { id: "model", parentId: null, name: "建模" },
  { id: "render", parentId: null, name: "渲染" },
  { id: "deliver", parentId: null, name: "交付" },
  { id: "shell", parentId: "model", name: "外壳" },
];

const noto: ClassRule[] = [{ id: "r", match: "noto", purpose: "hold" }];

test("a real parent folder beats the extension, and dumps do not", () => {
  const housed = placeFile({
    name: "housing.sldprt",
    path: "D:/产品外壳/外壳/housing.sldprt",
    folders,
    rules: [],
  });
  assert.equal(housed.folderId, "shell");
  assert.match(housed.label, /外壳/);
  assert.match(housed.label, /模型/);

  const dumped = placeFile({
    name: "logo.ai",
    path: "C:/Users/me/Downloads/logo.ai",
    folders,
    rules: [],
  });
  assert.equal(dumped.folderId, "sketch");
  assert.equal(dumped.short, "扩展名 · 矢量");
});

test("a user keyword overrides the extension and says so", () => {
  const font = placeFile({ name: "NotoSans-Regular.otf", folders, rules: noto });
  assert.equal(font.folderId, "model");
  assert.match(font.label, /规则「noto」/);
  assert.match(font.label, /字体/);
  assert.equal(font.short, "规则 · noto");
});

test("final on a design file goes to delivery, final on a model stays a model", () => {
  const cover = placeFile({ name: "cover-final.psd", folders, rules: [] });
  assert.equal(cover.folderId, "deliver");
  assert.match(cover.short, /交付/);

  const step = placeFile({ name: "shell-final.step", folders, rules: [] });
  assert.equal(step.folderId, "model");
  assert.equal(step.via, "kind");
});

test("an explicit stage word in the name beats the extension", () => {
  const named = placeFile({ name: "mood-草图.png", folders, rules: [] });
  assert.equal(named.folderId, "sketch");
  assert.match(named.label, /图片/);
  const drawing = placeFile({ name: "board-交付.dwg", folders, rules: [] });
  assert.equal(drawing.folderId, "deliver");
  assert.match(drawing.label, /图纸/);
});

test("legacy shelf names still receive the same stages", () => {
  const legacy: Folder[] = [
    { id: "active", parentId: null, name: "进行中" },
    { id: "hold", parentId: null, name: "待用" },
    { id: "ref", parentId: null, name: "参考" },
    { id: "archive", parentId: null, name: "归档" },
  ];
  assert.equal(placeFile({ name: "logo.ai", folders: legacy, rules: [] }).folderId, "active");
  assert.equal(placeFile({ name: "cover-final.psd", folders: legacy, rules: [] }).folderId, "archive");
  assert.equal(placeFile({ name: "mood-forest.png", folders: legacy, rules: [] }).folderId, "ref");
  assert.equal(
    placeFile({ name: "NotoSans-Regular.otf", folders: legacy, rules: noto }).folderId,
    "hold",
  );
});

test("dropping onto a folder still locks that choice", () => {
  const chosen = placeFile({ name: "logo.ai", folders, rules: [], chosenId: "render" });
  assert.equal(chosen.locked, true);
  assert.equal(chosen.folderId, "render");
});

test("KeyShot and V-Ray scene files go to the render stage but stay model files", () => {
  for (const name of ["demo.ksp", "scene.bip", "pack.KMP", "bundle.kbp", "wood.kcm", "room.vrscene"]) {
    const placed = placeFile({ name, folders, rules: [] });
    assert.equal(placed.folderId, "render", name);
    assert.equal(placed.via, "kind", name);
    assert.match(placed.label, /渲染场景/, name);
    assert.equal(kindFromName(name), "model", name);
  }
  assert.equal(placeFile({ name: "demo-final.ksp", folders, rules: [] }).folderId, "render");
  assert.equal(placeFile({ name: "demo.step", folders, rules: [] }).folderId, "model");
  assert.equal(placeFile({ name: "demo.blend", folders, rules: [] }).folderId, "model");
  // a real parent folder still wins
  assert.equal(
    placeFile({ name: "demo.ksp", path: "D:/产品外壳/外壳/demo.ksp", folders, rules: [] }).folderId,
    "shell",
  );
  // legacy shelf names
  const legacy: Folder[] = [
    { id: "active", parentId: null, name: "进行中" },
    { id: "hold", parentId: null, name: "待用" },
    { id: "ref", parentId: null, name: "参考" },
  ];
  assert.equal(placeFile({ name: "demo.ksp", folders: legacy, rules: [] }).folderId, "ref");
});

test("render inputs and common media are not dumped into delivery", () => {
  for (const name of ["sky.hdr", "env.exr", "clip.mkv"]) {
    assert.equal(placeFile({ name, folders, rules: [] }).folderId, "render", name);
  }
  assert.equal(kindFromName("a.3dm"), "model");
  assert.equal(kindFromName("a.gh"), "model");
  assert.equal(kindFromName("a.psd"), "design");
  assert.equal(kindFromName("a.fig"), "design");
  assert.equal(kindFromName("a.svg"), "vector");
});

