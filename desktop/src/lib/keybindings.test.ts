// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BINDINGS_EVENT,
  chordOfEvent,
  clearAllBindings,
  clearBindingOverride,
  getBindingOverride,
  normalizeChord,
  setBindingOverride,
} from "./keybindings";
import {
  bindingRows,
  editorCommand,
  isReopenTabKey,
  isTypeHierarchyKey,
  isWorkspaceSearch,
  layoutKeyOf,
  paletteKeyLabel,
  paletteModeOf,
} from "./keymap";

const ev = (key: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key,
  ctrlKey: mods.ctrlKey ?? true,
  altKey: mods.altKey ?? false,
  shiftKey: mods.shiftKey ?? false,
  metaKey: false,
  isComposing: false,
  keyCode: 0,
});

beforeEach(() => {
  localStorage.clear();
  clearAllBindings();
});

describe("组合键的规范化", () => {
  it("大小写、修饰键顺序统一；没有 Ctrl/Alt 的不收", () => {
    expect(normalizeChord("Ctrl+Shift+R")).toBe("ctrl+shift+r");
    expect(normalizeChord("shift+ctrl+f")).toBe("ctrl+shift+f");
    expect(normalizeChord("Ctrl+Alt+Space")).toBe("ctrl+alt+space");
    expect(normalizeChord("Ctrl+/")).toBe("ctrl+/");
    expect(normalizeChord("Shift+R")).toBeNull();
    expect(normalizeChord("Ctrl+")).toBeNull();
    expect(normalizeChord("Meta+K")).toBeNull();
    expect(normalizeChord("Ctrl+Control+K")).toBeNull();
  });

  it("从键盘事件取键，修饰键本身与输入法组词不算", () => {
    expect(chordOfEvent(ev("F", { shiftKey: true }))).toBe("ctrl+shift+f");
    expect(chordOfEvent(ev(" "))).toBe("ctrl+space");
    expect(chordOfEvent(ev("Shift"))).toBeNull();
    expect(chordOfEvent(ev("k", { ctrlKey: false }))).toBeNull();
    expect(chordOfEvent({ ...ev("k"), isComposing: true })).toBeNull();
    expect(chordOfEvent({ ...ev("k"), metaKey: true })).toBeNull();
  });
});

describe("自定义键位覆盖默认行为", () => {
  it("快速导航：改后的键生效，原默认键让出来", () => {
    expect(paletteModeOf(ev("P", { shiftKey: true }), "eclipse")).toBe("cmd");
    expect(setBindingOverride("palette.cmd", "ctrl+alt+k")).toEqual({ ok: true, chord: "ctrl+alt+k" });
    expect(paletteModeOf(ev("k", { altKey: true }), "eclipse")).toBe("cmd");
    expect(paletteModeOf(ev("P", { shiftKey: true }), "eclipse")).toBeNull();
    expect(paletteKeyLabel("cmd", "eclipse")).toBe("Ctrl+Alt+K");
  });

  it("布局键：改 Ctrl+B 后原键不再切侧栏，新键生效", () => {
    setBindingOverride("layout.side", "ctrl+alt+b");
    expect(layoutKeyOf(ev("b", { altKey: true }))).toBe("side");
    expect(layoutKeyOf(ev("b"))).toBeNull();
    // 没改的另一个布局键照旧
    expect(layoutKeyOf(ev("j"))).toBe("panel");
  });

  it("布局键：导航栏默认 Ctrl+Shift+B，改后旧键让出", () => {
    expect(layoutKeyOf(ev("b", { shiftKey: true }))).toBe("rail");
    setBindingOverride("layout.rail", "ctrl+alt+r");
    expect(layoutKeyOf(ev("r", { altKey: true }))).toBe("rail");
    expect(layoutKeyOf(ev("b", { shiftKey: true }))).toBeNull();
  });

  it("编辑器动作：旧键释放、新键触发，Eclipse 下原本没有的替换也能绑", () => {
    setBindingOverride("editor.actions.find", "ctrl+alt+f");
    expect(editorCommand(ev("f", { altKey: true }), "eclipse")).toBe("actions.find");
    expect(editorCommand(ev("f"), "eclipse")).toBeUndefined();

    setBindingOverride("editor.editor.action.startFindReplaceAction", "ctrl+alt+r");
    expect(editorCommand(ev("r", { altKey: true }), "eclipse")).toBe("editor.action.startFindReplaceAction");
  });

  it("搜索与类型层级：改后只认新键，且不影响另一项", () => {
    setBindingOverride("search.workspace", "ctrl+alt+s");
    expect(isWorkspaceSearch(ev("s", { altKey: true }), "eclipse")).toBe(true);
    expect(isWorkspaceSearch(ev("h"), "eclipse")).toBe(false);
    expect(isTypeHierarchyKey(ev("t"), "eclipse")).toBe(true);

    setBindingOverride("hierarchy.type", "ctrl+alt+t");
    expect(isTypeHierarchyKey(ev("t", { altKey: true }), "eclipse")).toBe(true);
    expect(isTypeHierarchyKey(ev("t"), "eclipse")).toBe(false);
  });

  it("重新打开标签：两套方案各有默认键，改过只认新键", () => {
    expect(isReopenTabKey(ev("t", { altKey: true }), "eclipse")).toBe(true);
    expect(isReopenTabKey(ev("T", { shiftKey: true }), "eclipse")).toBe(false);
    expect(isReopenTabKey(ev("T", { shiftKey: true }), "idea")).toBe(true);

    setBindingOverride("tab.reopen", "ctrl+alt+r");
    expect(isReopenTabKey(ev("r", { altKey: true }), "eclipse")).toBe(true);
    expect(isReopenTabKey(ev("t", { altKey: true }), "eclipse")).toBe(false);
    expect(isReopenTabKey(ev("T", { shiftKey: true }), "idea")).toBe(false);
  });

  it("Ctrl+S 固定保存，拒绝覆盖", () => {
    expect(setBindingOverride("editor.actions.find", "ctrl+s")).toEqual({
      ok: false,
      error: "Ctrl+S 固定用于保存，不能占用",
    });
    expect(getBindingOverride("editor.actions.find")).toBeUndefined();
  });

  it("保存、广播、恢复默认", () => {
    let fired = 0;
    const on = () => fired++;
    window.addEventListener(BINDINGS_EVENT, on);
    setBindingOverride("layout.panel", "ctrl+alt+j");
    expect(fired).toBe(1);
    expect(localStorage.getItem("ncforge-keybindings")).toContain("ctrl+alt+j");

    clearBindingOverride("layout.panel");
    expect(fired).toBe(2);
    expect(layoutKeyOf(ev("j"))).toBe("panel");

    setBindingOverride("layout.panel", "ctrl+alt+j");
    clearAllBindings();
    expect(getBindingOverride("layout.panel")).toBeUndefined();
    window.removeEventListener(BINDINGS_EVENT, on);
  });

  it("坏存储数据被丢弃，默认键照常可用", async () => {
    localStorage.setItem(
      "ncforge-keybindings",
      JSON.stringify({ "layout.side": "B", "layout.panel": "ctrl+s", "palette.cmd": "ctrl+alt+k" }),
    );
    // 模块内有读缓存，重置后用新实例重新解析存储
    vi.resetModules();
    const fresh = await import("./keybindings");
    expect(fresh.getBindingOverride("layout.side")).toBeUndefined();
    expect(fresh.getBindingOverride("layout.panel")).toBeUndefined();
    expect(fresh.getBindingOverride("palette.cmd")).toBe("ctrl+alt+k");
  });
});

describe("bindingRows", () => {
  it("改过的行标记 overridden；搜索行始终保留固定的 Ctrl+K", () => {
    setBindingOverride("palette.file", "ctrl+alt+o");
    setBindingOverride("search.workspace", "ctrl+alt+s");
    const rows = bindingRows("eclipse");
    const file = rows.find((r) => r.id === "palette.file");
    expect(file).toMatchObject({ overridden: true, display: ["Ctrl+Alt+O"] });
    const search = rows.find((r) => r.id === "search.workspace");
    expect(search?.display).toEqual(["Ctrl+Alt+S", "Ctrl+K"]);
    // 默认键位没改的行仍在
    expect(rows.find((r) => r.id === "layout.side")?.display).toEqual(["Ctrl+B"]);
    // Eclipse 下重新打开标签让出 Ctrl+Shift+T 给「转到类型」
    expect(rows.find((r) => r.id === "tab.reopen")?.display).toEqual(["Ctrl+Alt+T"]);
  });
});
