// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../contexts/UpdateContext";
import type { ResourcePhase } from "../../lib/resource";

const mocks = vi.hoisted(() => ({
  info: { data: { version: "9.8.7", platform: "windows" }, isError: false, refetch: vi.fn() },
  update: { status: "idle" as UpdateStatus, update: null, progress: 0, progressIndeterminate: false,
    downloadedBytes: 0, totalBytes: null as number | null, bytesPerSec: 0, preparing: false, restarting: false,
    error: null as string | null, errorCode: null, openUpdateNotes: vi.fn(), manualCheckForUpdate: vi.fn(), restart: vi.fn() },
  resources: { packs: [{ id: "jdtls", title: "Java 代码智能", notes: "语言服务", state: "installed", version: "0.57.0", size: 1024 }],
    phase: "idle" as ResourcePhase, error: null as string | null, errorCode: null, ensure: vi.fn(), refreshStatus: vi.fn(),
    currentId: null as string | null, requestedIds: [] as string[], lastInstalled: [] as { id: string; version: string }[],
    downloadedBytes: 0, totalBytesCurrent: null as number | null, bytesPerSec: 0, retry: vi.fn(), showDownloads: vi.fn() },
  invoke: vi.fn(), toast: vi.fn(),
}));
vi.mock("../../hooks/useAppInfo", () => ({ useAppInfo: () => mocks.info }));
vi.mock("../../contexts/UpdateContext", () => ({ useUpdate: () => mocks.update, friendlyError: (raw: string) => ({ friendly: raw, raw }) }));
vi.mock("../../contexts/ResourceContext", () => ({ useResources: () => mocks.resources }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke, invokeOrToast: mocks.invoke }));
vi.mock("../../lib/resultExport", () => ({ downloadText: vi.fn() }));
vi.mock("../ui/toast", () => ({ toast: mocks.toast }));
vi.mock("../ui/Modal", () => ({ Modal: ({ open, children }: { open: boolean; children: ReactNode }) =>
  open ? <div role="dialog" aria-label="导入配置预览">{children}</div> : null }));

import { AboutSettings } from "./AboutSettings";
import { UpdateSettings } from "./UpdateSettings";
import { ResourceSettings } from "./ResourceSettings";
import { ConfigTransferSettings } from "./ConfigTransferSettings";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
const mount = async (node: ReactNode) => { await act(async () => root.render(node)); };
const inputText = async (field: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.update, { status: "idle", progress: 0, progressIndeterminate: false, downloadedBytes: 0,
    totalBytes: null, bytesPerSec: 0, preparing: false, restarting: false, error: null });
  Object.assign(mocks.resources, { phase: "idle", error: null, currentId: null, requestedIds: [], lastInstalled: [],
    downloadedBytes: 0, totalBytesCurrent: null, bytesPerSec: 0,
    packs: [{ id: "jdtls", title: "Java 代码智能", notes: "语言服务", state: "installed", version: "0.57.0", size: 1024 }] });
  mocks.resources.refreshStatus.mockResolvedValue(mocks.resources.packs);
  mocks.resources.ensure.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("维护设置入口", () => {
  it("关于显示实际运行版本，并打开真实项目仓库", async () => {
    await mount(<AboutSettings onOpenHistory={vi.fn()} />);
    expect(container.querySelector("#about-version")?.textContent).toContain("v9.8.7");
    expect(button("打开仓库").disabled).toBe(false);
    await act(async () => button("打开仓库").click());
    expect(mocks.invoke).toHaveBeenCalledWith("open_external", { url: "https://github.com/lzlkyb/NCForge" });
  });

  it("就绪安装入口打开现有弹框，避免跳过确认立即重启", async () => {
    mocks.update.status = "ready";
    await mount(<UpdateSettings />);
    expect(button("检查更新").disabled).toBe(true);
    await act(async () => button("查看并安装").click());
    expect(mocks.update.openUpdateNotes).toHaveBeenCalledOnce();
    expect(mocks.update.restart).not.toHaveBeenCalled();
  });

  it("下载大小未知时不提供虚假的百分比，并禁用重新检查", async () => {
    Object.assign(mocks.update, { status: "downloading", progress: 23, progressIndeterminate: true, downloadedBytes: 1000 });
    await mount(<UpdateSettings />);
    const progress = container.querySelector('[role="progressbar"]')!;
    expect(progress.hasAttribute("aria-valuenow")).toBe(false);
    expect(progress.getAttribute("aria-valuetext")).toBe("总大小未知");
    expect(button("检查更新").disabled).toBe(true);
    expect(container.textContent).toContain("总大小未知");
  });

  it("组件维护明确重下全部，并调用原有 force 接口", async () => {
    await mount(<ResourceSettings />);
    await act(async () => button("重新下载全部组件").click());
    expect(mocks.resources.ensure).toHaveBeenCalledExactlyOnceWith(true, ["jdtls", "ecj", "svnkit", "cfr"]);
    expect(container.querySelector("#resource-jdtls")?.textContent).toContain("已安装");
  });

  it("本地组件状态读取失败提供重新读取入口", async () => {
    mocks.resources.refreshStatus.mockResolvedValue(null);
    await mount(<ResourceSettings />);
    expect(container.textContent).toContain("读取组件状态失败");
    await act(async () => button("重新读取").click());
    expect(mocks.resources.refreshStatus).toHaveBeenCalledTimes(2);
  });

  it("未下载组件可独立下载，也提供缺失组件批量入口", async () => {
    mocks.resources.packs[0].state = "missing";
    await mount(<ResourceSettings />);
    await act(async () => button("下载").click());
    expect(mocks.resources.ensure).toHaveBeenCalledWith(false, ["jdtls"]);
    await act(async () => button("下载缺失组件（1）").click());
    expect(mocks.resources.ensure).toHaveBeenLastCalledWith(false, ["jdtls"]);
  });

  it("设置页显示百分比与网速，安装期间禁止重复下载", async () => {
    Object.assign(mocks.resources, { phase: "downloading", currentId: "jdtls", requestedIds: ["jdtls"], downloadedBytes: 512, totalBytesCurrent: 1024, bytesPerSec: 256 });
    await mount(<ResourceSettings />);
    expect(container.textContent).toContain("50%");
    expect(container.textContent).toContain("256 B/s");
    Object.assign(mocks.resources, { phase: "installing" });
    await mount(<ResourceSettings />);
    expect(container.textContent).toContain("安装中");
    expect(button("重新下载全部组件").disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="重新下载Java 代码智能"]')?.disabled).toBe(true);
  });

  it("配置导入失败保留已修改路径和确认表单", async () => {
    mocks.invoke.mockRejectedValue(new Error("写入失败"));
    await mount(<ConfigTransferSettings />);
    const file = { text: async () => JSON.stringify({ app: "ncforge", schema: 1, from_version: "0.1.0", config: { workspace_root: "D:/old" } }) };
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, "files", { value: [file], configurable: true });
    await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
    const dialog = container.querySelector('[role="dialog"]')!;
    const path = dialog.querySelector<HTMLInputElement>('input:not([type="file"])')!;
    await inputText(path, "E:/new-workspace");
    await act(async () => button("确认导入").click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(path.value).toBe("E:/new-workspace");
    expect(dialog.textContent).toContain("写入失败");
    expect(dialog.textContent).toContain("口令不随配置导入");
    expect(mocks.invoke).toHaveBeenCalledWith("import_config", { json: expect.stringContaining('"workspace_root":"E:/new-workspace"') });
  });
});
