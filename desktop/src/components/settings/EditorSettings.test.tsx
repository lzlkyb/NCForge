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

import { EditorSettings } from "./EditorSettings";
import { DEFAULT_PREFS, setEditorPrefs } from "../../lib/editorPrefs";

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
      "小地图 开 · 粘性滚动 关 · Error Lens 开",
      "自动保存关 · 保存时格式化 关",
    ]);
  });

  it("默认只展开第一组，其余折叠", () => {
    const groups = [...container.querySelectorAll("details")];
    expect(groups.map((g) => g.hasAttribute("open"))).toEqual([true, false, false]);
  });

  it("改偏好后摘要跟着变（摘要与控件同一份状态）", async () => {
    await act(async () => setEditorPrefs({ fontSize: 16, wordWrap: true, autoSave: true }));
    expect(summaries()[0]).toBe("16px · Tab 4 制表符 · 自动换行 开 · 默认字体");
    expect(summaries()[2]).toBe("自动保存 2000ms · 保存时格式化 关");
  });
});
