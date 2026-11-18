// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  bpKey,
  breakpointGroupSig,
  breakpointGroups,
  breakpointInactiveReason,
  breakpointItemsIn,
  breakpointLinesIn,
  clearAllBreakpoints,
  clearBreakpointGroup,
  clearFileBreakpoints,
  getBreakpoints,
  groupBreakpoints,
  isBreakpointActive,
  isMuted,
  loadBreakpoints,
  renameBreakpointGroup,
  setBreakpointGroup,
  setBreakpointGroupEnabled,
  setMuted,
  toggleBreakpointAt,
  updateBreakpointAt,
} from "./breakpoints";

const KEY = (root: string) => `ncforge-breakpoints:${root.toLowerCase()}`;

let seq = 0;
/** 每个用例用独立工作区：模块内的 currentRoot 只在变化时才重新读盘。 */
function useRoot(raw: unknown[]): string {
  seq += 1;
  const root = `C:/bp-test-${seq}`;
  localStorage.setItem(KEY(root), JSON.stringify(raw));
  loadBreakpoints(root);
  return root;
}

/** 直接写 v2 存盘形状（静音 / 禁用组），再切过去。 */
function useStored(stored: unknown): string {
  seq += 1;
  const root = `C:/bp-test-${seq}`;
  localStorage.setItem(KEY(root), JSON.stringify(stored));
  loadBreakpoints(root);
  return root;
}

beforeEach(() => {
  localStorage.clear();
});

describe("断点清单", () => {
  it("读盘时补默认值、清洗可选字段并丢弃非法条目", () => {
    useRoot([
      { path: "C:/ws/A.java", line: 3 },
      { path: "C:/ws/A.java", line: 5, enabled: false, condition: "  ok  ", logMessage: "x" },
      { path: "C:/ws/A.java", line: 0 },
      { path: "  ", line: 1 },
      { path: "C:/ws/A.java", line: 1.5 },
      { path: "C:/ws/A.java", line: 9, condition: "   " },
    ]);

    expect(getBreakpoints()).toEqual([
      { path: "C:/ws/A.java", line: 3, enabled: true },
      { path: "C:/ws/A.java", line: 5, enabled: false, condition: "ok", logMessage: "x" },
      // 空白条件不算条件，但不能把整条断点丢掉
      { path: "C:/ws/A.java", line: 9, enabled: true },
    ]);
  });

  it("启用/禁用与条件字段：空串清字段，undefined 不动", () => {
    useRoot([{ path: "C:/ws/A.java", line: 3 }]);

    expect(updateBreakpointAt("C:/ws/A.java", 3, { condition: " a > b ", hitCondition: ">=5" })).toBe(true);
    expect(getBreakpoints()[0]).toMatchObject({ condition: "a > b", hitCondition: ">=5" });
    expect(updateBreakpointAt("C:/ws/A.java", 3, { condition: "" })).toBe(true);
    expect(getBreakpoints()[0].condition).toBeUndefined();
    expect(getBreakpoints()[0].hitCondition).toBe(">=5");

    updateBreakpointAt("C:/ws/A.java", 3, { enabled: false });
    expect(breakpointLinesIn("C:/ws/A.java")).toEqual([]);
    expect(breakpointItemsIn("c:\\WS\\a.JAVA")).toHaveLength(1);
    expect(updateBreakpointAt("C:/ws/A.java", 99, { enabled: true })).toBe(false);
  });

  it("增删与清空按路径不区分大小写", () => {
    useRoot([]);
    expect(toggleBreakpointAt("C:/ws/A.java", 2)).toBe("added");
    expect(toggleBreakpointAt("c:\\WS\\a.JAVA", 2)).toBe("removed");
    expect(getBreakpoints()).toEqual([]);

    toggleBreakpointAt("C:/ws/A.java", 2);
    toggleBreakpointAt("C:/ws/B.java", 4);
    clearFileBreakpoints("c:/WS/a.java");
    expect(getBreakpoints().map((b) => b.path)).toEqual(["C:/ws/B.java"]);
    clearAllBreakpoints();
    expect(getBreakpoints()).toEqual([]);
  });

  it("按文件分组：只发启用项，全禁用文件发空组，签名跟随触发字段", () => {
    useRoot([
      { path: "C:/ws/B.java", line: 9 },
      { path: "C:/ws/A.java", line: 5, condition: "x > 0", hitCondition: "%3", logMessage: "v={x}" },
      { path: "C:/ws/A.java", line: 2 },
      { path: "C:/ws/A.java", line: 7, enabled: false },
    ]);

    const groups = groupBreakpoints(getBreakpoints());
    expect([...groups.keys()]).toEqual(["c:/ws/b.java", "c:/ws/a.java"]);
    expect(groups.get("c:/ws/a.java")).toEqual({
      path: "C:/ws/A.java",
      breakpoints: [
        { line: 2 },
        { line: 5, condition: "x > 0", hitCondition: "%3", logMessage: "v={x}" },
      ],
    });

    const onlyDisabled = groupBreakpoints([
      { path: "C:/ws/C.java", line: 1, enabled: false },
    ]);
    expect(onlyDisabled.get("c:/ws/c.java")).toEqual({ path: "C:/ws/C.java", breakpoints: [] });

    const before = breakpointGroupSig(groups.get("c:/ws/a.java")!);
    const after = breakpointGroupSig({
      path: "C:/ws/A.java",
      breakpoints: [
        { line: 2 },
        { line: 5, condition: "x > 1", hitCondition: "%3", logMessage: "v={x}" },
      ],
    });
    expect(after).not.toBe(before);
    // 行号键统一口径：反斜杠 / 大小写 / 行号
    expect(bpKey("C:\\WS\\a.JAVA", 5)).toBe("c:/ws/a.java#5");
  });
});

describe("静音（Mute）", () => {
  it("静音时所有断点进入 muted 原因，取消后恢复", () => {
    useRoot([{ path: "C:/ws/A.java", line: 3 }]);
    expect(isMuted()).toBe(false);
    expect(breakpointInactiveReason(getBreakpoints()[0])).toBeNull();

    setMuted(true);
    expect(isMuted()).toBe(true);
    expect(breakpointInactiveReason(getBreakpoints()[0])).toBe("muted");
    // 静音不删清单：行号清单与面板照旧
    expect(breakpointItemsIn("C:/ws/A.java")).toHaveLength(1);

    setMuted(false);
    expect(breakpointInactiveReason(getBreakpoints()[0])).toBeNull();
  });

  it("静音偏好按工作区存盘（v2 形状），换工作区不串", () => {
    useRoot([{ path: "C:/ws/A.java", line: 3 }]);
    setMuted(true);
    // 落盘形状：items + muted + disabledGroups
    const raw = JSON.parse(localStorage.getItem(KEY(`C:/bp-test-${seq}`))!);
    expect(raw.muted).toBe(true);
    expect(raw.disabledGroups).toEqual([]);

    useStored({ items: [{ path: "C:/ws/B.java", line: 1 }], muted: true, disabledGroups: [] });
    expect(isMuted()).toBe(true);
    useStored({ items: [{ path: "C:/ws/C.java", line: 1 }], muted: false, disabledGroups: [] });
    expect(isMuted()).toBe(false);
  });
});

describe("断点分组", () => {
  it("分组字段：设置/清除，读盘白名单清洗", () => {
    useStored({
      items: [
        { path: "C:/ws/A.java", line: 3, group: "  支付流程 " },
        { path: "C:/ws/A.java", line: 5, group: "" },
        { path: "C:/ws/A.java", line: 7, group: 42 },
        { path: "C:/ws/A.java", line: 9 },
      ],
      muted: false,
      disabledGroups: [],
    });
    expect(getBreakpoints()).toEqual([
      { path: "C:/ws/A.java", line: 3, enabled: true, group: "支付流程" },
      { path: "C:/ws/A.java", line: 5, enabled: true },
      { path: "C:/ws/A.java", line: 7, enabled: true },
      { path: "C:/ws/A.java", line: 9, enabled: true },
    ]);

    expect(setBreakpointGroup("C:/ws/A.java", 9, " 登录 ")).toBe(true);
    expect(getBreakpoints()[3]).toMatchObject({ group: "登录" });
    // 空串 = 回默认组
    expect(updateBreakpointAt("C:/ws/A.java", 9, { group: "" })).toBe(true);
    expect(getBreakpoints()[3].group).toBeUndefined();
    expect(setBreakpointGroup("C:/ws/A.java", 99, "x")).toBe(false);
  });

  it("组启用/禁用：组内不下发，文件保留空组信号", () => {
    useStored({
      items: [
        { path: "C:/ws/A.java", line: 3, group: "g1" },
        { path: "C:/ws/A.java", line: 5 },
      ],
      muted: false,
      disabledGroups: [],
    });
    expect(isBreakpointActive(getBreakpoints()[0])).toBe(true);
    expect(breakpointGroups()).toEqual([{ name: "g1", count: 1, enabled: true }]);

    setBreakpointGroupEnabled("g1", false);
    expect(breakpointInactiveReason(getBreakpoints()[0])).toBe("group");
    // 组禁用 ≠ 单个禁用：isBreakpointActive 已含组判定
    expect(isBreakpointActive(getBreakpoints()[0])).toBe(false);
    const groups = groupBreakpoints(getBreakpoints());
    // A.java 只剩行 5；行 3 被组过滤掉，但文件组还在（还有启用项）
    expect(groups.get("c:/ws/a.java")?.breakpoints).toEqual([{ line: 5 }]);

    // 整个文件的断点都在禁用组里 → 空组（适配器那边的删除信号）
    setBreakpointGroupEnabled("g1", true);
    updateBreakpointAt("C:/ws/A.java", 5, { enabled: false });
    setBreakpointGroupEnabled("g1", false);
    const onlyDisabledGroup = groupBreakpoints(getBreakpoints());
    expect(onlyDisabledGroup.get("c:/ws/a.java")).toEqual({ path: "C:/ws/A.java", breakpoints: [] });
  });

  it("重命名/解散组：断点数与禁用状态跟着迁移", () => {
    useStored({
      items: [
        { path: "C:/ws/A.java", line: 3, group: "old" },
        { path: "C:/ws/A.java", line: 5, group: "old" },
        { path: "C:/ws/A.java", line: 7, group: "keep" },
      ],
      muted: false,
      disabledGroups: ["old"],
    });
    expect(renameBreakpointGroup("old", "new")).toBe(2);
    expect(breakpointGroups()).toEqual([
      { name: "keep", count: 1, enabled: true },
      { name: "new", count: 2, enabled: false },
    ]);
    // 目标名已存在 → 拒绝（-1），原组不动
    expect(renameBreakpointGroup("new", "keep")).toBe(-1);
    expect(breakpointGroups().find((g) => g.name === "new")?.count).toBe(2);

    expect(clearBreakpointGroup("new")).toBe(2);
    expect(breakpointGroups()).toEqual([{ name: "keep", count: 1, enabled: true }]);
    // 解散后禁用清单里的幽灵组名被清掉（重组同名不会莫名被禁用）
    const raw = JSON.parse(localStorage.getItem(KEY(`C:/bp-test-${seq}`))!);
    expect(raw.disabledGroups).toEqual([]);
  });

  it("清空全部断点时禁用组一并清理", () => {
    useStored({
      items: [{ path: "C:/ws/A.java", line: 3, group: "g1" }],
      muted: false,
      disabledGroups: ["g1"],
    });
    clearAllBreakpoints();
    const raw = JSON.parse(localStorage.getItem(KEY(`C:/bp-test-${seq}`))!);
    expect(raw).toEqual({ items: [], muted: false, disabledGroups: [] });
  });
});
