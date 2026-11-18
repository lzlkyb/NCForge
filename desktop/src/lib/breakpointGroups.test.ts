// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  MAX_GROUP_NAME,
  cleanGroupName,
  clearGroupInList,
  groupInfos,
  isGroupEnabled,
  normalizeStored,
  pruneDisabledGroups,
  renameGroupInList,
} from "./breakpointGroups";

describe("断点分组纯函数", () => {
  it("组名清洗：去空白截断，空串无效", () => {
    expect(cleanGroupName("  支付流程 ")).toBe("支付流程");
    expect(cleanGroupName("")).toBeUndefined();
    expect(cleanGroupName("   ")).toBeUndefined();
    expect(cleanGroupName(null)).toBeUndefined();
    expect(cleanGroupName("x".repeat(MAX_GROUP_NAME + 10))).toHaveLength(MAX_GROUP_NAME);
  });

  it("组启用判定：默认组（无组名）永远启用", () => {
    expect(isGroupEnabled([], undefined)).toBe(true);
    expect(isGroupEnabled(["a"], undefined)).toBe(true);
    expect(isGroupEnabled(["a"], "a")).toBe(false);
    expect(isGroupEnabled(["a"], "b")).toBe(true);
  });

  it("存盘兼容：v1 裸数组 → 不静音、无禁用组", () => {
    expect(normalizeStored([{ path: "a", line: 1 }])).toEqual({
      items: [{ path: "a", line: 1 }],
      muted: false,
      disabledGroups: [],
    });
    expect(normalizeStored(null)).toEqual({ items: [], muted: false, disabledGroups: [] });
    expect(normalizeStored("垃圾")).toEqual({ items: [], muted: false, disabledGroups: [] });
  });

  it("存盘读取：v2 形状，脏字段兜底", () => {
    expect(normalizeStored({ items: [{ path: "a", line: 1 }], muted: true, disabledGroups: ["g"] })).toEqual({
      items: [{ path: "a", line: 1 }],
      muted: true,
      disabledGroups: ["g"],
    });
    // muted 只认 true；disabledGroups 过滤非字符串与空白串
    expect(normalizeStored({ items: "x", muted: 1, disabledGroups: ["g", "", 3, "  "] })).toEqual({
      items: [],
      muted: false,
      disabledGroups: ["g"],
    });
  });

  it("幽灵组名清理：断点清空后禁用清单不留空组", () => {
    const withGroup = [{ path: "p", line: 1, group: "a" }];
    expect(pruneDisabledGroups(["a", "b"], withGroup)).toEqual(["a"]);
    expect(pruneDisabledGroups(["a"], [])).toEqual([]);
  });

  it("组摘要：按名字排序，count 含组内禁用项", () => {
    const items = [
      { path: "p", line: 1, group: "b" },
      { path: "p", line: 2, group: "a" },
      { path: "p", line: 3, group: "a", enabled: false },
      { path: "p", line: 4 },
    ];
    expect(groupInfos(items, ["a"])).toEqual([
      { name: "a", count: 2, enabled: false },
      { name: "b", count: 1, enabled: true },
    ]);
    expect(groupInfos([], [])).toEqual([]);
  });

  it("重命名/解散：返回新清单，不改原引用", () => {
    const items = [
      { path: "p", line: 1, group: "a" },
      { path: "p", line: 2 },
    ];
    const renamed = renameGroupInList(items, "a", "z");
    expect(renamed[0]).toEqual({ path: "p", line: 1, group: "z" });
    expect(items[0]).toEqual({ path: "p", line: 1, group: "a" });
    expect(renameGroupInList(items, "a", "a")).toBe(items);
    expect(clearGroupInList(items, "a")[0]).toEqual({ path: "p", line: 1, group: undefined });
  });
});
