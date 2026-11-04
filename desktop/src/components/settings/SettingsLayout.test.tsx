// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsLayout } from "./SettingsLayout";
import { SettingsRow } from "../ui/SettingsRow";
import { ToggleRow } from "../ui/ToggleRow";
import { SettingsGroup } from "./SettingsGroup";
import { clearSettingsRequest, getSettingsRequest, requestSettingsSection } from "../../lib/settingsJump";
import { getSideOpen, setSideOpen } from "../../lib/layoutStore";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let wasSideOpen: boolean;
beforeEach(() => {
  wasSideOpen = getSideOpen();
  clearSettingsRequest();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearSettingsRequest();
  setSideOpen(wasSideOpen);
  vi.unstubAllGlobals();
});

async function render(): Promise<ReactElement> {
  const el = <SettingsLayout sections={[
    { label: "外观与常规", aliases: ["外观", "常规"], group: "工作台", content: <SettingsRow id="density" label="界面密度" keywords={["density"]} valueText="标准" control={<button>标准</button>} /> },
    { label: "编辑器", group: "工作台", content: <>
      <SettingsRow id="font" label="字体" keywords={["font"]} valueText="默认字体" control={<input aria-label="字体草稿" defaultValue="" />} />
      <SettingsGroup title="保存" summary="自动保存关"><ToggleRow id="autosave" label="自动保存" checked={false} onChange={() => {}} /></SettingsGroup>
    </> },
    { label: "关于", group: "维护", content: <SettingsRow id="version" label="运行版本" valueText="v1.2.3" /> },
  ]} />;
  await act(async () => root.render(<section className="wb-main">{el}</section>));
  return el;
}
async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索设置"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const visiblePage = () => container.querySelector<HTMLElement>(".wb-settings-pages > section:not([hidden])");
const results = () => [...container.querySelectorAll<HTMLButtonElement>(".wb-settings-result")];

describe("设置中心搜索与导航", () => {
  it("窄窗口选分类自动收起侧栏，并将焦点移到正文标题", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    setSideOpen(true);
    await render();
    const editor = [...container.querySelectorAll<HTMLButtonElement>(".wb-settings-nav button")].find(b => b.textContent === "编辑器")!;
    await act(async () => { editor.focus(); editor.click(); });
    expect(getSideOpen()).toBe(false);
    expect(document.activeElement).toBe(visiblePage()?.querySelector("h1"));
    expect(visiblePage()?.className).not.toContain("wb-settings-flash");
  });
  it("宽窗口选分类保留侧栏，窄窗口搜索结果定位后收起侧栏", async () => {
    const media = vi.fn(() => ({ matches: false }));
    vi.stubGlobal("matchMedia", media);
    setSideOpen(true);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(".wb-settings-nav button")!.click());
    expect(getSideOpen()).toBe(true);
    media.mockReturnValue({ matches: true });
    await search("字体");
    await act(async () => results()[0].click());
    expect(getSideOpen()).toBe(false);
    expect(document.activeElement?.id).toBe("font");
  });
  it("搜索具体设置及当前值，点击后直达并强调目标", async () => {
    await render();
    await search("密度");
    expect(results()).toHaveLength(1);
    expect(results()[0].textContent).toContain("标准");
    await act(async () => results()[0].click());
    expect(visiblePage()?.dataset.settingsSection).toBe("外观与常规");
    expect(container.querySelector("#density")?.className).toContain("wb-settings-flash");
    expect(document.activeElement?.id).toBe("density");
  });
  it("搜索折叠组内项目，定位时自动展开", async () => {
    await render();
    expect(container.querySelector("details")?.open).toBe(false);
    await search("编辑器 自动保存");
    expect(results()).toHaveLength(1);
    await act(async () => results()[0].click());
    expect(container.querySelector("details")?.open).toBe(true);
    expect(document.activeElement?.id).toBe("autosave");
  });
  it("拼音首字母及英文关键词可以定位具体项", async () => {
    await render();
    await search("jmmd");
    expect(results()[0]?.textContent).toContain("界面密度");
    await search("font");
    expect(results()[0]?.textContent).toContain("字体");
  });
  it("无结果可清除并返回原分类，菜单始终完整", async () => {
    await render();
    await search("不存在的设置");
    expect(results()).toHaveLength(0);
    expect(container.textContent).toContain("没有找到");
    expect(container.querySelectorAll(".wb-settings-nav button")).toHaveLength(3);
    const clear = [...container.querySelectorAll("button")].find(b => b.textContent === "清除搜索")!;
    await act(async () => clear.click());
    expect(visiblePage()?.dataset.settingsSection).toBe("外观与常规");
  });
  it("旧分类入口仍能跳转，重复请求会重新定位", async () => {
    await render();
    await act(async () => requestSettingsSection("外观"));
    expect(visiblePage()?.dataset.settingsSection).toBe("外观与常规");
    expect(getSettingsRequest()?.section).toBe("外观");
    await act(async () => requestSettingsSection("编辑器"));
    expect(visiblePage()?.dataset.settingsSection).toBe("编辑器");
    expect(visiblePage()?.className).toContain("wb-settings-flash");
  });
  it("切换分类及搜索不会重挂控件或丢弃输入草稿", async () => {
    await render();
    const font = container.querySelector<HTMLInputElement>("#font input")!;
    font.value = "Consolas";
    const editor = [...container.querySelectorAll<HTMLButtonElement>(".wb-settings-nav button")].find(b => b.textContent === "编辑器")!;
    await act(async () => editor.click());
    await search("版本");
    await search("");
    expect(visiblePage()?.dataset.settingsSection).toBe("编辑器");
    expect(container.querySelector("#font input")).toBe(font);
    expect(font.value).toBe("Consolas");
  });
});
