import { test } from "node:test";
import assert from "node:assert/strict";
import { diffHashes } from "../visual-baseline.mjs";

test("哈希一致时无差异", () => {
  assert.deepEqual(diffHashes({ a: "1", b: "2" }, { a: "1", b: "2" }), { changed: [], added: [], missing: [] });
});

test("分别报出变化 / 新增 / 消失，且排序稳定", () => {
  const r = diffHashes({ b: "1", a: "2" }, { b: "9", c: "3", a: "2" });
  assert.deepEqual(r.changed, ["b"]);
  assert.deepEqual(r.added, ["c"]);
  assert.deepEqual(r.missing, []);
});

test("基线缺失时全部算新增（不会误判成一致）", () => {
  const r = diffHashes({}, { x: "1", y: "2" });
  assert.deepEqual(r.added, ["x", "y"]);
  assert.deepEqual(r.changed, []);
});
