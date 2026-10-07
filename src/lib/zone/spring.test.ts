import assert from "node:assert/strict";
import test from "node:test";
import { COLLAPSE_SPRING, MORPH_SPRING, springDuration, springProgress } from "./spring.ts";

test("spring starts at 0, settles at 1 and overshoots only slightly", () => {
  assert.equal(springProgress(0), 0);
  let peak = 0;
  for (let t = 0; t < 1.5; t += 0.005) peak = Math.max(peak, springProgress(t));
  assert.ok(peak > 1 && peak < 1.04, "peak " + peak);
  assert.ok(Math.abs(springProgress(springDuration()) - 1) < 0.003);
});

test("default spring settles in roughly 350-600ms", () => {
  const seconds = springDuration(MORPH_SPRING);
  assert.ok(seconds > 0.25 && seconds < 0.6, "duration " + seconds);
});

test("a critically damped spring never overshoots", () => {
  for (let t = 0; t < 2; t += 0.01) assert.ok(springProgress(t, { damping: 2 * Math.sqrt(300) }) <= 1);
});
test("collapse spring never overshoots and settles quickly", () => {
  for (let t = 0; t < 2; t += 0.005) assert.ok(springProgress(t, COLLAPSE_SPRING) <= 1);
  assert.ok(springDuration(COLLAPSE_SPRING) < 0.45);
});

