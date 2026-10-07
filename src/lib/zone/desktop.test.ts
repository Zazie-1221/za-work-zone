import assert from "node:assert/strict";
import test from "node:test";
import { isSensitive, legacyState, sourceIgnored } from "./model.ts";

test("sqlite import keeps an existing database and otherwise copies local storage", () => {
  assert.deepEqual(legacyState('{"state":1}', '{"state":2}'), { value: '{"state":1}', write: false });
  assert.deepEqual(legacyState(null, '{"state":2}'), { value: '{"state":2}', write: true });
  assert.deepEqual(legacyState("  ", null), { value: null, write: false });
});

test("password managers are ignored and short names are not", () => {
  assert.equal(sourceIgnored("1Password.exe", ["1password", "bitwarden"]), true);
  assert.equal(sourceIgnored("WINWORD.EXE", ["1password"]), false);
  assert.equal(sourceIgnored("a.exe", ["x"]), false);
});

test("existing secret filter still drops keys and card numbers", () => {
  assert.equal(isSensitive("sk-live-abcdefghij123456"), true);
  assert.equal(isSensitive("把安静做成像完成过的事。"), false);
});
