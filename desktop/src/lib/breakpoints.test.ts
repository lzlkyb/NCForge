// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  bpKey,
  breakpointGroupSig,
  breakpointItemsIn,
  breakpointLinesIn,
  clearAllBreakpoints,
  clearFileBreakpoints,
  getBreakpoints,
  groupBreakpoints,
  loadBreakpoints,
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
