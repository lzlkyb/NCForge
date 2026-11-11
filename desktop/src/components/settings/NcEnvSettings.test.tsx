// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ probe: vi.fn(), save: vi.fn(), scan: vi.fn(), status: vi.fn(), pick: vi.fn() }));
vi.mock("../../lib/server", () => ({ ncHomeProbe: mocks.probe, ncHomeSet: mocks.save, ncHomeCandidates: mocks.scan, serverStatus: mocks.status }));
vi.mock("../../lib/folderPicker", () => ({ pickFolder: mocks.pick, pickFolderError: () => "选择失败，请重试" }));
vi.mock("../ui/ConfirmDialog", () => ({ ConfirmDialog: ({ open, onCancel, onConfirm, confirmLabel }: { open: boolean; onCancel: () => void; onConfirm: () => void; confirmLabel: ReactNode }) =>
  open ? <div role="dialog"><button onClick={onCancel}>取消</button><button onClick={onConfirm}>{confirmLabel}</button></div> : null }));
import { NcEnvSettings } from "./NcEnvSettings";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const home = { root: "D:/nc", java: "D:/nc/ufjdk/bin/java.exe", moduleCount: 245, hasNcStarter: true, httpPort: 80, servicePort: 8005 };
let root: Root;
let host: HTMLDivElement;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label)!;
const input = () => host.querySelector<HTMLInputElement>('[aria-label="NC 安装目录"]')!;
const type = async (text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
  input().dispatchEvent(new Event("input", { bubbles: true }));
});
const click = async (label: string) => act(async () => { button(label).click(); });
const mount = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => root.render(<QueryClientProvider client={client}><NcEnvSettings /></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.probe.mockImplementation(async (path?: string) => path ? { ...home, root: path } : home);
  mocks.save.mockImplementation(async (path: string) => ({ ...home, root: path }));
  mocks.status.mockResolvedValue({ state: "stopped", ncHome: null });
  mocks.pick.mockResolvedValue("E:/nc-new");
  mocks.scan.mockResolvedValue([]);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("NC 目录检测与确认", () => {
  it("浏览、候选选择与输入都只形成草稿，检测与确认后才写入", async () => {
    await mount(); await click("浏览…");
    expect(input().value).toBe("E:/nc-new");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(button("保存并使用").disabled).toBe(true);
    await click("检测目录");
    expect(mocks.probe).toHaveBeenCalledWith("E:/nc-new");
    expect(host.textContent).toContain("检测通过");
    expect(mocks.save).not.toHaveBeenCalled();
    await click("保存并使用");
    expect(mocks.save).toHaveBeenCalledWith("E:/nc-new");
    expect(host.textContent).toContain("已保存");
  });
  it("已检测的草稿修改后需要重新检测，取消不会写入", async () => {
    await mount(); await type("E:/nc-new"); await click("检测目录");
    await type("E:/other"); expect(button("保存并使用").disabled).toBe(true);
    await click("取消修改"); expect(input().value).toBe(home.root); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("最新状态为运行中时确认后保存，取消保留草稿", async () => {
    await mount(); await type("E:/nc-new"); await click("检测目录");
    mocks.status.mockResolvedValue({ state: "running", ncHome: home.root });
    await click("保存并使用"); expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await click("取消"); expect(mocks.save).not.toHaveBeenCalled(); expect(input().value).toBe("E:/nc-new");
    await click("保存并使用"); await click("保存配置，稍后重启");
    expect(mocks.save).toHaveBeenCalledWith("E:/nc-new");
  });
  it("检测或保存失败就地显示原因并保留可重试的草稿", async () => {
    await mount(); await type("E:/bad");
    mocks.probe.mockRejectedValueOnce(new Error("缺少 modules 目录"));
    await click("检测目录"); expect(host.textContent).toContain("modules"); expect(button("保存并使用").disabled).toBe(true);
    await click("检测目录");
    mocks.save.mockRejectedValueOnce(new Error("磁盘只读"));
    await click("保存并使用"); expect(input().value).toBe("E:/bad"); expect(host.textContent).toContain("磁盘只读");
    await click("保存并使用"); expect(mocks.save).toHaveBeenCalledTimes(2);
  });
  it("服务状态未知时不写配置，允许重试", async () => {
    await mount(); await type("E:/nc-new"); await click("检测目录");
    mocks.status.mockRejectedValueOnce(new Error("读取状态失败"));
    await click("保存并使用"); expect(mocks.save).not.toHaveBeenCalled(); expect(host.textContent).toContain("读取状态失败");
  });
  it("输入改变后忽略较早的检测结果", async () => {
    await mount(); await type("E:/older");
    let finish!: (value: typeof home) => void;
    mocks.probe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await click("检测目录"); await type("E:/newer");
    await act(async () => finish({ ...home, root: "E:/older" }));
    expect(button("保存并使用").disabled).toBe(true);
    expect(input().value).toBe("E:/newer");
  });
  it("扫描空结果原位显示下一步，选择候选不自动保存", async () => {
    await mount(); await click("扫描常见位置");
    expect(host.textContent).toContain("没有找到候选");
    mocks.scan.mockResolvedValue([{ root: "E:/candidate", moduleCount: 20, source: "workspaceSibling" }]);
    await click("扫描常见位置"); await click("选择目录");
    expect(input().value).toBe("E:/candidate"); expect(mocks.save).not.toHaveBeenCalled();
    expect(host.querySelector("#nc-home-path")?.hasAttribute("data-settings-item")).toBe(true);
  });
});
