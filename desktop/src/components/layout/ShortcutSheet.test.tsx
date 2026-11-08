// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShortcutSheet } from "./ShortcutSheet";
import { clearAllBindings, setBindingOverride } from "../../lib/keybindings";
import { clearSettingsRequest, getSettingsRequest } from "../../lib/settingsJump";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  clearAllBindings();
  clearSettingsRequest();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearAllBindings();
  clearSettingsRequest();
});

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="快捷键一览"]');

function press(target: EventTarget, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function render(): ReactElement {
  const el = <ShortcutSheet />;
  act(() => root.render(el));
  return el;
}

describe("快捷键一览", () => {
  it("外壳里按 ? 打开，列出当前方案的分组与固定键", () => {
    render();
    expect(dialog()).toBeNull();
    press(window, "?");
    const sheet = dialog()!;
    expect(sheet).not.toBeNull();
    const text = sheet.textContent ?? "";
    expect(text).toContain("快速导航");
    expect(text).toContain("编辑器");
    expect(text).toContain("保存当前文件");
    expect(text).toContain("Eclipse");
    // 执行按钮上不再印 Ctrl+Enter 之后，这里成了用户唯一能查到它的地方，别被顺手删掉
    expect(text).toContain("SQL 控制台");
    expect(text).toContain("执行当前语句");
    expect(text).toContain("Ctrl+Enter");
  });

  it("输入框与编辑器里按 ? 不抢键（代码里的三元符要能打出来）", () => {
    render();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    press(input, "?");
    expect(dialog()).toBeNull();

    const editor = document.createElement("div");
    editor.className = "monaco-editor";
    const textarea = document.createElement("textarea");
    editor.appendChild(textarea);
    document.body.appendChild(editor);
    press(textarea, "?");
    expect(dialog()).toBeNull();
    input.remove();
    editor.remove();
  });

  it("Esc 收起（与关闭按钮同一关闭路径）", () => {
    render();
    press(window, "?");
    const close = dialog()!.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!;
    press(close, "Escape");
    expect(dialog()?.getAttribute("data-exiting")).toBe("true");
  });

  it("搜索按动作名过滤；没有命中时给出清除入口", () => {
    render();
    press(window, "?");
    const input = dialog()!.querySelector<HTMLInputElement>('input[aria-label="搜索快捷键"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "侧栏");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(dialog()!.textContent).toContain("切换侧栏");
    expect(dialog()!.textContent).not.toContain("保存当前文件");
    expect(dialog()!.textContent).toContain("匹配 1 项");

    act(() => {
      setter.call(input, "完全不存在");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(dialog()!.textContent).toContain("没有找到");
  });

  it("同一个组合键被两个动作占用时标「冲突」", () => {
    // Ctrl+Alt+H 是固定键「调用层级」；把布局键也改成它，一览里两边都要标出来
    setBindingOverride("layout.panel", "ctrl+alt+h");
    render();
    press(window, "?");
    expect(dialog()!.textContent).toContain("冲突");
  });

  it("点「修改」关掉一览，并把快捷键分类 + 键位 id 交给设置页", () => {
    const nav = vi.fn((_: Event) => {});
    window.addEventListener("ncforge-navigate", nav);
    render();
    press(window, "?");
    const edit = Array.from(dialog()!.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "修改",
    )!;
    act(() => edit.click());
    expect(getSettingsRequest()?.section).toBe("快捷键");
    expect(getSettingsRequest()?.binding).toBeTruthy();
    expect(nav).toHaveBeenCalledTimes(1);
    window.removeEventListener("ncforge-navigate", nav);
  });
});
