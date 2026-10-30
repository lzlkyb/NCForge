import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SEARCH_CHAR,
  WORKSPACE_SEARCH_KEY,
  editorCommand,
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

  it("展示用的首选键", () => {
    expect(paletteKeyLabel("file", "eclipse")).toBe("Ctrl+Shift+R");
    expect(paletteKeyLabel("symbol", "idea")).toBe("Ctrl+F12");
  });

  it("Ctrl+B / Ctrl+J 切侧栏与底部面板，带 Shift 不算", () => {
    expect(layoutKeyOf(key("b"))).toBe("side");
    expect(layoutKeyOf(key("J"))).toBe("panel");
    expect(layoutKeyOf(key("b", true))).toBeNull();
  });
});
