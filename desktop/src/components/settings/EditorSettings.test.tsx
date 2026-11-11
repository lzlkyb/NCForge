// @vitest-environment jsdom
/**
 * 编辑器设置折成三组后，折叠态也得能读出当前值：
 * 摘要不是「显示与排版」这种分类名，而是字号/缩进/开关的真实读数。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// liveTemplates 会拉进整个 Monaco（jsdom 里 queryCommandSupported 不存在），
// 本用例只验证设置分组，模板清单给个占位即可。
vi.mock("../../lib/liveTemplates", () => ({ TEMPLATE_PREFIXES: ["sout", "souf"] }));
vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));

import { EditorSettings } from "./EditorSettings";
import { DEFAULT_PREFS, getEditorPrefs, setEditorPrefs } from "../../lib/editorPrefs";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const mount = async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<EditorSettings />));
};

const summaries = () =>
  [...container.querySelectorAll(".settings-group-sum")].map((n) => n.textContent ?? "");

beforeEach(async () => {
  setEditorPrefs(DEFAULT_PREFS);
  await mount();
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("EditorSettings 渐进披露", () => {
  it("Esc 清除预览草稿，确认恢复默认同时清除字段草稿", async () => {
    const type = async (value: string) => act(async () => {
      const field = container.querySelector<HTMLInputElement>('[aria-label="代码字号"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type("20"); expect(container.textContent).toContain("预览草稿");
    await act(async () => container.querySelector<HTMLInputElement>('[aria-label="代码字号"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.textContent).not.toContain("预览草稿");
    await type("21");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "恢复编辑器默认设置")!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "恢复默认")!.click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="代码字号"]')!.value).toBe("13");
    expect(container.textContent).not.toContain("预览草稿");
  });
  it("字体标签关联输入，完成输入后才保存并更新摘要", async () => {
    const label = [...container.querySelectorAll("label")].find((n) => n.textContent === "字体")!;
    const field = label.control as HTMLInputElement;
    expect(field).toBeInstanceOf(HTMLInputElement);
    expect(label.htmlFor).toBe(field.id);
    expect([...field.labels!]).toContain(label);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "Consolas");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(summaries()[0]).toContain("默认字体");
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(summaries()[0]).toContain("Consolas");
  });

  it("摘要行写当前值，而不是分类名", () => {
    expect(summaries()).toEqual([
      "13px · Tab 4 制表符 · 自动换行 关 · 默认字体",
      "小地图 关 · 粘性滚动 开 · Error Lens 开",
      "自动保存关 · 保存时格式化 关",
      "提取参数范围：窄档",
    ]);
  });

  it("默认只展开第一组，其余折叠", () => {
    const groups = [...container.querySelectorAll("details")];
    expect(groups.map((g) => g.hasAttribute("open"))).toEqual([true, false, false, false]);
  });

  it("提取参数默认窄档，开关改的是编辑器偏好并同步摘要", async () => {
    expect(getEditorPrefs().extractParamWide).toBe(false);
    await act(async () => setEditorPrefs({ extractParamWide: true }));
    expect(summaries()[3]).toBe("提取参数范围：宽档");
  });

  it("改偏好后摘要跟着变（摘要与控件同一份状态）", async () => {
    await act(async () => setEditorPrefs({ fontSize: 16, wordWrap: true, autoSave: true }));
    expect(summaries()[0]).toBe("16px · Tab 4 制表符 · 自动换行 开 · 默认字体");
    expect(summaries()[2]).toBe("自动保存 2000ms · 保存时格式化 关");
  });
});
