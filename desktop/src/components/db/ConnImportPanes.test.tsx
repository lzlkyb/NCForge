// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const propSources = vi.fn();
const propImport = vi.fn();
vi.mock("../../lib/dbApi", () => ({
  dbApi: { propSources: () => propSources(), propImport: (...a: unknown[]) => propImport(...a) },
  ENVS: ["dev", "test", "prod", "other"],
  ENV_LABEL: { dev: "开发", test: "测试", prod: "生产", other: "其他" },
}));

const beginOperation = vi.fn(() => ({ finish: vi.fn() }));
vi.mock("../../lib/operations", () => ({ beginOperation: () => beginOperation() }));
vi.mock("../../lib/dbOperations", () => ({ dbTaskSpec: () => ({}) }));
vi.mock("../../lib/dbStore", () => ({ closeConnDialog: vi.fn(), loadConns: vi.fn() }));
const requestSettingsSection = vi.fn();
vi.mock("../../lib/settingsJump", () => ({ requestSettingsSection: (s: string) => requestSettingsSection(s) }));

import { PropImportPane } from "./ConnImportPanes";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  propSources.mockReset();
  propImport.mockReset();
  beginOperation.mockClear();
  requestSettingsSection.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async () => {
  await act(async () => {
    root.render(<PropImportPane />);
  });
  // propSources 的 Promise 还要再排一轮微任务才落 state
  await act(async () => {});
};

const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];

describe("prop.xml 导入页：没有 NC home 时给引导而不是裸错误", () => {
  it("propSources 报 need-nc-home：显示引导卡、隐藏数据源列表、来源行标注需要 NC home", async () => {
    propSources.mockRejectedValue("need-nc-home|读 NC prop.xml 需要 NC 安装目录");
    await render();
    const guide = host.querySelector<HTMLElement>(".dbx-homeguide");
    expect(guide, "要出引导卡片").toBeTruthy();
    expect(guide?.textContent).toContain("ierp/bin/prop.xml");
    expect(guide?.textContent).toContain("纯 Rust 驱动不依赖 NC home");
    expect(host.querySelector(".dbx-dslist")).toBeNull();
    expect(host.querySelector(".dbx-badline")).toBeNull();
    // 来源行说明白「为什么空着」
    const bd = host.querySelector<HTMLElement>(".bd")!;
    expect(bd.textContent).toContain("未读取（需要 NC home）");
    // 环境选择也收起（选了也没用，整页功能不可用）
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it("引导卡的跳转按钮带用户去设置 → 开发 →「NC 环境」", async () => {
    propSources.mockRejectedValue("need-nc-home|读 NC prop.xml 需要 NC 安装目录");
    await render();
    const nav: CustomEvent[] = [];
    const onNav = (e: Event) => nav.push(e as CustomEvent);
    window.addEventListener("ncforge-navigate", onNav);
    try {
      const go = buttons().find((b) => b.textContent?.includes("NC 环境"))!;
      expect(go).toBeTruthy();
      act(() => go.click());
      expect(requestSettingsSection).toHaveBeenCalledWith("NC 环境");
      expect(nav).toHaveLength(1);
      expect(nav[0].detail).toBe("settings");
    } finally {
      window.removeEventListener("ncforge-navigate", onNav);
    }
  });

  it("导入动作本身报 need-nc-home（连接阶段才需要 home）：也走引导卡", async () => {
    propSources.mockResolvedValue({
      source: "D:\\ncc\\1909home\\ierp\\bin\\prop.xml",
      sources: [{ name: "design", url: "jdbc:oracle:thin:@h:1521/a", user: "u", isBase: true, hasPassword: true, added: false }],
    });
    propImport.mockRejectedValue("need-nc-home|prop.xml 数据源的口令由 NC 自带的 PropXMLReader 解密");
    await render();
    // 先勾一个数据源，让「添加」按钮可用
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => box.click());
    const addBtn = buttons().find((b) => b.textContent?.includes("添加"))!;
    await act(async () => { addBtn.click(); });
    expect(propImport).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".dbx-homeguide")?.textContent).toContain("需要先配置 NC home");
  });

  it("正常读到数据源：列表照常渲染，不出引导卡", async () => {
    propSources.mockResolvedValue({
      source: "D:\\ncc\\1909home\\ierp\\bin\\prop.xml",
      sources: [{ name: "design", url: "jdbc:oracle:thin:@h:1521/a", user: "u", isBase: true, hasPassword: true, added: false }],
    });
    await render();
    expect(host.querySelector(".dbx-homeguide")).toBeNull();
    expect(host.querySelector(".dbx-dslist")?.textContent).toContain("design");
    expect(host.querySelector('[role="radiogroup"]')).toBeTruthy();
  });
});
