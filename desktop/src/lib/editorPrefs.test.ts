// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFS,
  getEditorPrefs,
  monacoOptionsOf,
  setEditorPrefs,
  PREFS_EVENT,
} from "./editorPrefs";

/**
 * 编辑器偏好：本机显示习惯，存 localStorage 不跟配置走。
 *
 * 重点在三条：字段缺了要补齐（老版本存的对象）、值没变不要惊动编辑器、
 * Monaco 选项的映射不能把 false 写成 undefined（否则关了又"自己打开"）。
 */
describe("editorPrefs", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    localStorage.clear();
    setEditorPrefs({ ...DEFAULT_PREFS });
  });

  it("默认值：NC 代码用制表符、不用空格，自动保存默认关", () => {
    expect(DEFAULT_PREFS.insertSpaces).toBe(false);
    expect(DEFAULT_PREFS.autoSave).toBe(false);
    expect(DEFAULT_PREFS.errorLens).toBe(true);
  });

  it("落盘并按字段合并；老版本缺的字段用默认值补齐", async () => {
    localStorage.setItem("ncforge-editor-prefs", JSON.stringify({ fontSize: 18 }));
    vi.resetModules();
    const fresh = await import("./editorPrefs");
    expect(fresh.getEditorPrefs().fontSize).toBe(18);
    // 缺失的字段不塌成 undefined：否则 Monaco 会拿到不认识的选项
    expect(fresh.getEditorPrefs().tabSize).toBe(DEFAULT_PREFS.tabSize);
    expect(fresh.getEditorPrefs().autoSaveDelayMs).toBe(DEFAULT_PREFS.autoSaveDelayMs);
  });

  it("坏数据不把设置页顶崩", async () => {
    localStorage.setItem("ncforge-editor-prefs", "{ not json");
    vi.resetModules();
    const fresh = await import("./editorPrefs");
    expect(fresh.getEditorPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("值没变就不写盘不广播（滑块连续触发不该每次都惊动编辑器）", () => {
    const spy = vi.fn();
    window.addEventListener(PREFS_EVENT, spy);
    setEditorPrefs({ fontSize: getEditorPrefs().fontSize });
    expect(spy).not.toHaveBeenCalled();

    setEditorPrefs({ fontSize: 17 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getEditorPrefs().fontSize).toBe(17);
    window.removeEventListener(PREFS_EVENT, spy);
  });

  it("Monaco 选项：关掉的项写 false 而不是省略", () => {
    const o = monacoOptionsOf({ ...DEFAULT_PREFS, minimap: false, stickyScroll: false, wordWrap: true, fontFamily: "" });
    expect(o).toMatchObject({
      wordWrap: "on",
      minimap: { enabled: false },
      stickyScroll: { enabled: false },
      tabSize: DEFAULT_PREFS.tabSize,
      insertSpaces: false,
    });
    // 空字体名要用内置字体栈，不能把空串塞给 Monaco
    expect(String(o.fontFamily)).toContain("monospace");
  });

  it("写入失败返回 false，保持本次生效，并允许重试同一个值", () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("quota"); });
    expect(setEditorPrefs({ fontSize: 19 })).toBe(false);
    expect(getEditorPrefs().fontSize).toBe(19);
    expect(setEditorPrefs({ fontSize: 19 })).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem("ncforge-editor-prefs")!).fontSize).toBe(19);
  });
});
