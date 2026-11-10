import { beforeEach, expect, it } from "vitest";
import {
  __resetEditsForTest, clearEditsForTab, pendingEdits, pendingForTab,
  reportEditCount, resultEditKey, tableEditKey,
} from "./dbDirtyEdits";

beforeEach(() => __resetEditsForTest());

it("标签的总计数 = 表页 + 该标签下所有结果标签", () => {
  reportEditCount(tableEditKey("t1"), 2);
  reportEditCount(resultEditKey("t1", "r1"), 1);
  reportEditCount(resultEditKey("t1", "r2"), 3);
  reportEditCount(resultEditKey("t2", "r9"), 5);
  expect(pendingForTab("t1")).toBe(6);
  expect(pendingForTab("t2")).toBe(5);
  clearEditsForTab("t1");
  expect(pendingForTab("t1")).toBe(0);
  expect(pendingForTab("t2")).toBe(5);
});

it("计数归零就删除条目，负数按 0 处理，重复上报不改变结果", () => {
  reportEditCount(tableEditKey("t"), 3);
  reportEditCount(tableEditKey("t"), 3);
  expect(pendingEdits(tableEditKey("t"))).toBe(3);
  reportEditCount(tableEditKey("t"), -1);
  expect(pendingEdits(tableEditKey("t"))).toBe(0);
  expect(pendingForTab("t")).toBe(0);
});
