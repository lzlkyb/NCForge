// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { getSvnDiffPrefs, setSvnDiffPrefs } from "./svnDiffPrefs";
import { diffSummary, changedLine } from "./svnDiffState";

describe("SVN 差异阅读偏好与差异统计", () => {
  it("默认显示全部空白差异，按工作副本独立保存", () => {
    expect(getSvnDiffPrefs("C:/prefs/a").ignoreWhitespace).toBe(false);
    setSvnDiffPrefs("C:/prefs/a", { ignoreWhitespace: true, layout: "inline", fontSize: 14 });
    expect(getSvnDiffPrefs("c:\\prefs\\a")).toMatchObject({ ignoreWhitespace: true, layout: "inline", fontSize: 14 });
    expect(getSvnDiffPrefs("C:/prefs/b")).toMatchObject({ ignoreWhitespace: false, layout: "auto", fontSize: 12 });
    expect(JSON.parse(localStorage.getItem("ncforge.svn.diff:c:/prefs/a")!)).toMatchObject({ fontSize: 14 });
  });

  it("无效持久化值不进入 Monaco 配置", () => {
    localStorage.setItem("ncforge.svn.diff:c:/prefs/invalid", JSON.stringify({ layout: "bad", wrap: "yes", ignoreWhitespace: "false", fontSize: 1 }));
    expect(getSvnDiffPrefs("C:/prefs/invalid")).toEqual({ layout: "auto", wrap: true, ignoreWhitespace: false, fontSize: 12, collapseUnchanged: true });
  });

  it("纯新增或删除不会把空的另一侧计成一行", () => {
    expect(diffSummary([
      { originalStartLineNumber: 0, originalEndLineNumber: 0, modifiedStartLineNumber: 1, modifiedEndLineNumber: 3 },
      { originalStartLineNumber: 5, originalEndLineNumber: 6, modifiedStartLineNumber: 4, modifiedEndLineNumber: 0 },
    ], 0)).toEqual({ ready: true, add: 3, del: 2, at: 0, total: 2 });
    expect(diffSummary(null, 5).ready).toBe(false);
    expect(diffSummary([], 5)).toEqual({ ready: true, add: 0, del: 0, at: 0, total: 0 });
  });

  it("删除块定位到存在的工作副本行，不使用零行号", () => {
    expect(changedLine({ modifiedStartLineNumber: 0 })).toBe(1);
    expect(changedLine({ modifiedStartLineNumber: 4 })).toBe(4);
  });
});
