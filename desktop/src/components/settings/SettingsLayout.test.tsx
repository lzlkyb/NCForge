// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsLayout } from "./SettingsLayout";
import { clearSettingsRequest, getSettingsRequest, requestSettingsSection } from "../../lib/settingsJump";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  clearSettingsRequest();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearSettingsRequest();
});

function render(): ReactElement {
  const el = (
    <SettingsLayout
      sections={[
        { label: "外观", keywords: ["材质", "主题", "theme"], content: <div>外观内容</div> },
        { label: "编辑器", keywords: ["字体", "自动保存", "font"], content: <div>编辑器内容</div> },
        { label: "关于", keywords: ["版本", "仓库"], content: <div>关于内容</div> },
      ]}
    />
  );
  act(() => root.render(el));
  return el;
}

function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索设置"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const menuLabels = () =>
  Array.from(container.querySelectorAll(".wb-settings-nav button")).map((b) => b.textContent);

// 未选中的分类仍挂在 DOM 里（hidden），只断言当前可见的分类正文。
const visibleText = () =>
  Array.from(container.querySelectorAll(".wb-settings-body > section:not([hidden])"))
    .map((s) => s.textContent)
    .join("");

describe("设置搜索", () => {
  it("按标签 / 关键词过滤分类，命中项自动成为当前页", () => {
    render();
    search("字体");
    expect(menuLabels()).toEqual(["编辑器"]);
    expect(visibleText()).toContain("编辑器内容");
    expect(visibleText()).not.toContain("外观内容");
  });

  it("拼音首字母也能命中中文关键词", () => {
    render();
    search("cz");
    expect(menuLabels()).toEqual(["外观"]);
    expect(visibleText()).toContain("外观内容");
  });

  it("多个词按「且」组合；没有命中时给出空状态和清除入口", () => {
    render();
    search("编辑器 字体");
    expect(menuLabels()).toEqual(["编辑器"]);
    search("不存在的设置");
    expect(menuLabels()).toEqual([]);
    expect(container.textContent).toContain("没有找到");
    const clear = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "清除搜索");
    act(() => clear?.click());
    expect(menuLabels()).toEqual(["外观", "编辑器", "关于"]);
    expect(container.textContent).toContain("外观内容");
  });

  it("外部请求跳到指定分类，并闪一下目标区块", () => {
    render();
    act(() => requestSettingsSection("编辑器"));
    expect(visibleText()).toContain("编辑器内容");
    const section = container.querySelector(".wb-settings-body > section:not([hidden])")!;
    expect(section.className).toContain("wb-settings-flash");
    // 请求在闪完之前不能被提前清掉，否则 2 秒计时器会被一起撤掉
    expect(getSettingsRequest()?.section).toBe("编辑器");
  });

  it("点击分类切页，搜索清空后回到手动选中的分类", () => {
    render();
    const editor = Array.from(container.querySelectorAll<HTMLButtonElement>(".wb-settings-nav button")).find(
      (b) => b.textContent === "编辑器",
    )!;
    act(() => editor.click());
    expect(visibleText()).toContain("编辑器内容");
    search("版本");
    expect(visibleText()).toContain("关于内容");
    search("");
    expect(visibleText()).toContain("编辑器内容");
  });
});
