import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SEARCH_CHAR,
  WORKSPACE_SEARCH_KEY,
  editorCommand,
  isTypeHierarchyKey,
  isWorkspaceSearch,
  layoutKeyOf,
  paletteKeyLabel,
  paletteModeOf,
  workspaceSearchLabel,
} from "./keymap";

const key = (name: string, shiftKey = false) => ({ key: name, ctrlKey: true, metaKey: false, altKey: false, shiftKey, isComposing: false });

describe("workspace search keymaps", () => {
  it("routes the conflicting combinations according to the selected keymap", () => {
    expect(isWorkspaceSearch(key("h"), "eclipse")).toBe(true);
    expect(isWorkspaceSearch(key("F", true), "eclipse")).toBe(false);
    expect(isWorkspaceSearch(key("h"), "idea")).toBe(false);
    expect(isWorkspaceSearch(key("F", true), "idea")).toBe(true);
  });
  it("does not intercept composition or modified combinations", () => {
    expect(isWorkspaceSearch({ ...key("h"), isComposing: true }, "eclipse")).toBe(false);
    expect(isWorkspaceSearch({ ...key("h"), altKey: true }, "eclipse")).toBe(false);
  });
  it("keeps the advertised search label in sync with the scheme keys the handler accepts", () => {
    // 顶栏 kbd、设置页说明、App 的 handler 必须同源：标签里出现的方案键都要真的能进搜索页。
    // Ctrl+K 是各方案通用的固定入口，由 App 自己接线，不走 isWorkspaceSearch。
    expect(WORKSPACE_SEARCH_KEY).toBe(`Ctrl+${WORKSPACE_SEARCH_CHAR}`);
    for (const [keymap, schemeKey, shift] of [["eclipse", "h", false], ["idea", "F", true]] as const) {
      const label = workspaceSearchLabel(keymap);
      expect(label).toContain(WORKSPACE_SEARCH_KEY);
      expect(label).toContain(`Ctrl+${shift ? "Shift+" : ""}${schemeKey.toUpperCase()}`);
      expect(isWorkspaceSearch(key(schemeKey, shift), keymap)).toBe(true);
    }
  });
  it("类型层级只占当前方案的那一个键，Eclipse 的 Ctrl+H 仍归全工程搜索", () => {
    expect(isTypeHierarchyKey(key("h"), "idea")).toBe(true);
    expect(isTypeHierarchyKey(key("t"), "eclipse")).toBe(true);
    expect(isTypeHierarchyKey(key("h"), "eclipse")).toBe(false);
    expect(isTypeHierarchyKey(key("t"), "idea")).toBe(false);
    // 带 Alt / Shift / 组字中都不算，免得吃掉 Ctrl+Alt+H（调用层级）这类组合
    expect(isTypeHierarchyKey({ ...key("h"), altKey: true }, "idea")).toBe(false);
    expect(isTypeHierarchyKey(key("T", true), "eclipse")).toBe(false);
    expect(isTypeHierarchyKey({ ...key("h"), isComposing: true }, "idea")).toBe(false);
    expect(isTypeHierarchyKey({ ...key("h"), ctrlKey: false }, "idea")).toBe(false);
  });

  it("resolves deletion and redo conflicts without combining schemes", () => {
    expect(editorCommand(key("y"), "eclipse")).toBe("redo");
    expect(editorCommand(key("y"), "idea")).toBe("editor.action.deleteLines");
    expect(editorCommand(key("d"), "eclipse")).toBe("editor.action.deleteLines");
    expect(editorCommand({ ...key("F3"), ctrlKey: false }, "eclipse")).toBe("editor.action.revealDefinition");
    expect(editorCommand({ ...key("y"), isComposing: true }, "idea")).toBeUndefined();
  });
});

describe("快速导航快捷键", () => {
  it("Eclipse 方案：Ctrl+Shift+R / T、Ctrl+O、Ctrl+Shift+P；Ctrl+P 两套通用", () => {
    expect(paletteModeOf(key("R", true), "eclipse")).toBe("file");
    expect(paletteModeOf(key("p"), "eclipse")).toBe("file");
    expect(paletteModeOf(key("T", true), "eclipse")).toBe("type");
    expect(paletteModeOf(key("o"), "eclipse")).toBe("symbol");
    expect(paletteModeOf(key("P", true), "eclipse")).toBe("cmd");
  });

  it("IDEA 方案：Ctrl+Shift+N、Ctrl+N、Ctrl+F12、Ctrl+Shift+A", () => {
    expect(paletteModeOf(key("N", true), "idea")).toBe("file");
    expect(paletteModeOf(key("n"), "idea")).toBe("type");
    expect(paletteModeOf(key("F12"), "idea")).toBe("symbol");
    expect(paletteModeOf(key("A", true), "idea")).toBe("cmd");
  });

  it("不属于当前方案的键、没按 Ctrl、输入法组字中都不触发", () => {
    expect(paletteModeOf(key("n"), "eclipse")).toBeNull();
    expect(paletteModeOf({ ...key("p"), ctrlKey: false }, "eclipse")).toBeNull();
    expect(paletteModeOf({ ...key("p"), isComposing: true }, "eclipse")).toBeNull();
    expect(paletteModeOf({ ...key("p"), altKey: true }, "eclipse")).toBeNull();
  });

  it("工作区符号（方法 / 字段级）必须带 Alt：Ctrl+Alt+N，IDEA 还接受再加 Shift", () => {
    const alt = (name: string, shiftKey = false) => ({ ...key(name), altKey: true, shiftKey });
    expect(paletteModeOf(alt("n"), "eclipse")).toBe("sym");
    expect(paletteModeOf(alt("n"), "idea")).toBe("sym");
    expect(paletteModeOf(alt("n", true), "idea")).toBe("sym");
    // 不带 Alt 的 Ctrl+N / Ctrl+Shift+N 仍是原语义，不能被 Alt 分支吃掉
    expect(paletteModeOf(key("n"), "idea")).toBe("type");
    expect(paletteModeOf(key("N", true), "idea")).toBe("file");
    // Eclipse 下 Ctrl+Alt+N 只有一个键，带 Shift 不认
    expect(paletteModeOf(alt("n", true), "eclipse")).toBeNull();
  });

  it("展示用的首选键", () => {
    expect(paletteKeyLabel("file", "eclipse")).toBe("Ctrl+Shift+R");
    expect(paletteKeyLabel("symbol", "idea")).toBe("Ctrl+F12");
    expect(paletteKeyLabel("sym", "eclipse")).toBe("Ctrl+Alt+N");
  });

  it("Ctrl+B / Ctrl+J 切侧栏与底部面板，带 Shift 不算", () => {
    expect(layoutKeyOf(key("b"))).toBe("side");
    expect(layoutKeyOf(key("J"))).toBe("panel");
    expect(layoutKeyOf(key("b", true))).toBeNull();
  });
});
