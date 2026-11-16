import { test } from "node:test";
import assert from "node:assert/strict";
import { BUDGETS, evaluate, formatTable, groupSamples, normalize } from "./interaction-budget.mjs";

test("sample 数组按 kind 分组，非法样本丢弃", () => {
  const summary = groupSamples([
    { kind: "keydown", ms: 10 },
    { kind: "keydown", ms: 30 },
    { kind: "keydown", ms: -1 },
    { kind: "command", ms: 90 },
  ]);
  assert.deepEqual(summary.keydown, { n: 2, p50: 10, p95: 30, max: 30 });
  assert.deepEqual(summary.command, { n: 1, p50: 90, p95: 90, max: 90 });
});

test("normalize 同时吃 summary 与 samples 两种形态", () => {
  assert.deepEqual(normalize({ summary: { keydown: { n: 1, p50: 5, p95: 5, max: 5 } } }).summary.keydown.n, 1);
  assert.equal(normalize({ samples: [{ kind: "command", ms: 40 }] }).summary.command.p95, 40);
  assert.deepEqual(normalize(null).summary, {});
});

test("超预算进 failed，达标不进", () => {
  const { rows, failed, unmeasured } = evaluate({
    keydown: { n: 10, p50: 40, p95: 60, max: 90 },
    command: { n: 5, p50: 30, p95: 80, max: 90 },
  });
  assert.equal(failed.length, 1);
  assert.match(failed[0], /keydown/);
  assert.deepEqual(unmeasured.sort(), ["drag", "tab-switch"]);
  const keydownRow = rows.find((r) => r.kind === "keydown");
  assert.equal(keydownRow.status, "超 10ms");
  assert.equal(rows.find((r) => r.kind === "command").status, "达标");
});

test("未定义预算的 kind 不静默消失", () => {
  const { rows } = evaluate({ keystroke: { n: 3, p50: 1, p95: 2, max: 3 } });
  const extra = rows.find((r) => r.kind === "keystroke");
  assert.ok(extra);
  assert.equal(extra.status, "待补预算");
});

test("表格按中文双宽对齐，含全部预算行", () => {
  const { rows } = evaluate({});
  const table = formatTable(rows);
  const lines = table.split("\n");
  assert.equal(lines.length, 2 + Object.keys(BUDGETS).length);
  assert.match(table, /编辑输入回显/);
});
