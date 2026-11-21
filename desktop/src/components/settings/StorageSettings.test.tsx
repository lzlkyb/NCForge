// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageSettings } from "./StorageSettings";

const api = vi.hoisted(() => ({
  usage: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  memory: vi.fn(),
  release: vi.fn(),
}));
vi.mock("../../lib/storageMaintenance", () => ({
  currentStorageUsage: api.usage,
  previewStorage: api.preview,
  applyStorage: api.apply,
  sampleMemory: api.memory,
  releaseIdleCompilers: api.release,
  autoStorageEnabled: () => true,
  setAutoStorage: vi.fn(),
  storageReceipt: (report: { removed: number }) => `已移除 ${report.removed} 项`,
}));

let host: HTMLDivElement, root: Root;
function button(label: string) {
  return Array.from(host.querySelectorAll("button")).find(node => node.textContent?.trim() === label)!;
}
async function render(active = true) {
  await act(async () => root.render(<StorageSettings active={active} />));
}

describe("存储与性能", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const stat = { bytes: 1024, incomplete: false };
    api.usage.mockResolvedValue({ categories: { temporary: stat, cache: stat, components: stat, local: stat },
      freeBytes: 10 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, sampledAt: 0, languageBusy: false });
    api.preview.mockImplementation((scope: string) => Promise.resolve({ id: scope === "language" ? 2 : 1, entries: scope === "language"
      ? [{ key: 0, kind: "language", name: "index-A", bytes: 2048, workspace: "工程 A · 模块" }]
      : [{ key: 0, kind: "compile", name: "ecj-1.args", bytes: 1024 }, { key: 1, kind: "log", name: "frontend.log.1", bytes: 2048 }] }));
    api.apply.mockResolvedValue({ removed: 1, removedBytes: 1024, skipped: 0, reasons: {}, cancelled: false });
    api.memory.mockResolvedValue({ sampledAt: 1, rows: [{ group: "main", pid: 123, residentBytes: 8192, privateBytes: 6144 }],
      idleCompilers: 1, partial: false });
    api.release.mockResolvedValue(1);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("仅在进入时扫描，先预览再执行所选项目并显示回执", async () => {
    await render(false);
    expect(api.usage).not.toHaveBeenCalled();
    await render();
    expect(api.usage).toHaveBeenCalledTimes(1);
    await act(async () => button("建议清理").click());
    expect(api.apply).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="清理预览"]')?.textContent).toContain("预计释放 3.0 KB");
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click());
    expect(host.querySelector('[aria-label="清理预览"]')?.textContent).toContain("预计释放 1.0 KB");
    await act(async () => button("清理所选").click());
    expect(api.apply).toHaveBeenCalledWith(1, [0]);
    expect(host.textContent).toContain("已移除 1 项");
  });

  it("按 Escape 关闭预览并回到清理入口", async () => {
    await render();
    const trigger = button("建议清理");
    await act(async () => trigger.click());
    const preview = host.querySelector<HTMLElement>('[aria-label="清理预览"]')!;
    expect(document.activeElement).toBe(preview);
    await act(async () => preview.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector('[aria-label="清理预览"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("可重建索引由用户明确勾选，预览带出工作区", async () => {
    await render();
    await act(async () => button("查看可重建索引").click());
    expect(host.textContent).toContain("工程 A · 模块");
    expect(button("清理所选").disabled).toBe(true);
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => button("清理所选").click());
    expect(api.apply).toHaveBeenCalledWith(2, [0]);
  });

  it("显示独立内存指标并暂停隐藏页面采样", async () => {
    vi.useFakeTimers();
    await render();
    await act(async () => button("运行内存").click());
    expect(host.textContent).toContain("NCForge 主程序");
    expect(host.textContent).toContain("驻留内存");
    expect(host.textContent).toContain("私有提交");
    await act(async () => button("释放闲置进程").click());
    expect(api.release).toHaveBeenCalledOnce();
    await render(false);
    const count = api.memory.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(api.memory).toHaveBeenCalledTimes(count);
  });
});
