// @vitest-environment jsdom
/**
 * 设置 → 开发 →「NC 环境」页（NC home 的唯一配置入口，2026-11-06）：
 * - 展示已配置 home 的探测结果（模块数 / java / 端口）；
 * - 浏览（pickFolder）与扫描候选两条路都能落库；
 * - 服务在跑时先确认再保存，取消就不写；
 * - 保存失败要可见（toast），不假装成功。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ncHomeProbe: vi.fn(),
  ncHomeSet: vi.fn(),
  ncHomeCandidates: vi.fn(),
  serverStatus: vi.fn(),
  pickFolder: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../lib/server", () => ({
  ncHomeProbe: mocks.ncHomeProbe,
  ncHomeSet: mocks.ncHomeSet,
  ncHomeCandidates: mocks.ncHomeCandidates,
  serverStatus: mocks.serverStatus,
}));
vi.mock("../../lib/folderPicker", () => ({ pickFolder: mocks.pickFolder }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));

import { NcEnvSettings } from "./NcEnvSettings";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const home = {
  root: "D:\\ncc\\1909home",
  java: "D:\\ncc\\1909home\\ufjdk\\bin\\java.exe",
  moduleCount: 245,
  hasNcStarter: true,
  httpPort: 80,
  servicePort: 8005,
};

let root: Root;
let container: HTMLDivElement;

const render = async () => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })}>
        <NcEnvSettings />
      </QueryClientProvider>,
    );
  });
  // react-query 首轮落地要跨 microtask + 一轮重渲染，单轮 act 拿不到 data
  //（probe / server-status 各一条查询，漏了这轮会看到「未配置」假象）。
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const btn = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

const input = () => container.querySelector<HTMLInputElement>('input[aria-label="NC 安装目录"]');

beforeEach(() => {
  mocks.ncHomeProbe.mockReset();
  mocks.ncHomeSet.mockReset();
  mocks.ncHomeCandidates.mockReset();
  mocks.serverStatus.mockReset();
  mocks.pickFolder.mockReset();
  mocks.toast.mockReset();
  mocks.serverStatus.mockResolvedValue({ state: "stopped" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("NC 环境：安装目录展示", () => {
  it("已配置时展示路径与探测结果（模块数 / java / 端口）", async () => {
    mocks.ncHomeProbe.mockResolvedValue(home);
    await render();
    expect(container.textContent).toContain("D:\\ncc\\1909home");
    expect(container.textContent).toContain("245 个模块");
    expect(container.textContent).toContain("完整安装");
    expect(container.textContent).toContain("端口 80");
  });

  it("探测失败时显示原因并给重试，不显示假路径", async () => {
    mocks.ncHomeProbe.mockRejectedValue(new Error("D:\\ncc 下没有 modules 目录"));
    await render();
    expect(container.textContent).toContain("没有 modules 目录");
    expect(btn("重试")).toBeDefined();
  });

  it("未配置时行内提示未配置", async () => {
    mocks.ncHomeProbe.mockResolvedValue({ ...home, root: "", moduleCount: 0 });
    await render();
    expect(container.textContent).toContain("未配置");
  });
});

describe("NC 环境：两条写入路径", () => {
  it("浏览选中的目录直接验证并保存", async () => {
    mocks.ncHomeProbe.mockResolvedValue(home);
    mocks.pickFolder.mockResolvedValue("D:\\NC65\\home");
    await render();
    await act(async () => { btn("浏览…")!.click(); });
    expect(mocks.pickFolder).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("NC 安装目录"), defaultPath: home.root }),
    );
    expect(mocks.ncHomeSet).toHaveBeenCalledWith("D:\\NC65\\home");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("已切换"), "success");
  });

  it("手输路径回车保存", async () => {
    mocks.ncHomeProbe.mockResolvedValue(home);
    await render();
    await act(async () => { btn("更改")!.click(); });
    const el = input()!;
    await act(async () => {
      // React 受控输入：直接改 value 不触发 onChange，走原生 setter
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, "D:\\ncc\\1909home2");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(mocks.ncHomeSet).toHaveBeenCalledWith("D:\\ncc\\1909home2");
  });

  it("扫描出候选后可点「使用」落库", async () => {
    mocks.ncHomeProbe.mockResolvedValue(home);
    mocks.ncHomeCandidates.mockResolvedValue([
      { root: "D:\\NC65\\home", moduleCount: 12, source: "driveRoot" },
      { root: "E:\\ws-sibling\\nchome", moduleCount: 3, source: "workspaceSibling" },
    ]);
    await render();
    await act(async () => { btn("扫描")!.click(); });
    expect(container.textContent).toContain("D:\\NC65\\home");
    expect(container.textContent).toContain("工作区同级");
    const use = [...container.querySelectorAll("button")].filter((b) => b.textContent === "使用");
    expect(use).toHaveLength(2);
    await act(async () => { use[0].click(); });
    expect(mocks.ncHomeSet).toHaveBeenCalledWith("D:\\NC65\\home");
  });

  it("扫不到候选时提示手动浏览，不报错", async () => {
    mocks.ncHomeProbe.mockResolvedValue(home);
    mocks.ncHomeCandidates.mockResolvedValue([]);
    await render();
    await act(async () => { btn("扫描")!.click(); });
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("没扫到"), "info");
  });
});

describe("NC 环境：保存的前置守卫", () => {
  it("服务在跑时先确认，取消就不写配置", async () => {
    mocks.ncHomeProbe.mockResolvedValue(home);
    mocks.serverStatus.mockResolvedValue({ state: "running" });
    mocks.pickFolder.mockResolvedValue("D:\\NC65\\home");
    await render();
    await act(async () => { btn("浏览…")!.click(); });
    // 确认框（portal 到 body）出现，且 set 尚未调用
    const confirm = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "仍然切换");
    expect(confirm).toBeDefined();
    expect(mocks.ncHomeSet).not.toHaveBeenCalled();
    await act(async () => {
      [...document.body.querySelectorAll("button")].find((b) => b.textContent === "取消")!.click();
    });
    expect(mocks.ncHomeSet).not.toHaveBeenCalled();
  });

  it("服务在跑时确认后照常保存，并提示重启后生效", async () => {
    mocks.ncHomeProbe.mockResolvedValue(home);
    mocks.serverStatus.mockResolvedValue({ state: "running" });
    mocks.pickFolder.mockResolvedValue("D:\\NC65\\home");
    await render();
    await act(async () => { btn("浏览…")!.click(); });
    await act(async () => {
      [...document.body.querySelectorAll("button")].find((b) => b.textContent === "仍然切换")!.click();
    });
    // 确认框的 onConfirm 排在退场动画（rAF + MOTION.exit=140ms）之后，要等它跑完
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(mocks.ncHomeSet).toHaveBeenCalledWith("D:\\NC65\\home");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("重启服务后生效"), "success");
  });

  it("保存失败时弹错误，不显示成功", async () => {
    mocks.ncHomeProbe.mockResolvedValue(home);
    mocks.ncHomeSet.mockRejectedValue(new Error("D:\\ncc 下没有 ufjdk/bin/java.exe"));
    mocks.pickFolder.mockResolvedValue("D:\\bad");
    await render();
    await act(async () => { btn("浏览…")!.click(); });
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("ufjdk"), "error", { raw: "D:\\ncc 下没有 ufjdk/bin/java.exe" });
  });
});
