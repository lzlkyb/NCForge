// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOTION } from "../../lib/motion";
import { ResourceDownloadReadout } from "./ResourceDownloadReadout";
import { ResourceSetupDialog } from "./ResourceSetupDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const progress = { currentId: "ecj", downloadedBytes: 1024 * 1024, totalBytesCurrent: 2 * 1024 * 1024, bytesPerSec: 512 * 1024 };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("下载进度与面板", () => {
  it("已知大小展示真实百分比、下载量和网速", async () => {
    await act(async () => root.render(<ResourceDownloadReadout {...progress} phase="downloading" title="Java 编译器" />));
    expect(host.textContent).toContain("50%");
    expect(host.textContent).toContain("1.0 MB / 2.0 MB");
    expect(host.textContent).toContain("512 KB/s");
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50");
  });
  it("大小未知时使用不确定进度，不伪造百分比", async () => {
    await act(async () => root.render(<ResourceDownloadReadout {...progress} totalBytesCurrent={null} phase="downloading" />));
    expect(host.textContent).toContain("总大小未知");
    expect(host.textContent).not.toContain("%");
    expect(host.querySelector('[role="progressbar"]')?.hasAttribute("aria-valuenow")).toBe(false);
    expect(host.querySelector(".is-indeterminate")).not.toBeNull();
  });
  it("校验与安装保留等待反馈，下载 100% 不显示成已就绪", async () => {
    await act(async () => root.render(<ResourceDownloadReadout {...progress} phase="verifying" downloadedBytes={progress.totalBytesCurrent} />));
    expect(host.textContent).toContain("校验中");
    expect(host.textContent).not.toContain("100%");
    expect(host.textContent).not.toContain("KB/s");
    await act(async () => root.render(<ResourceDownloadReadout {...progress} phase="installing" />));
    expect(host.textContent).toContain("解压并安装");
  });
  it("关闭走 Modal 退场动画，重开保留已完成记录", async () => {
    const props = { ...progress, phase: "ready" as const, currentId: null,
      packs: [{ id: "ecj", title: "Java 编译器", notes: "编译", state: "installed" as const, version: "v1", size: 10 }],
      batch: [{ id: "ecj", title: "Java 编译器", notes: "编译", size: 10 }], requestedIds: ["ecj"],
      lastInstalled: [{ id: "ecj", version: "v1" }], error: null, errorCode: null,
      onDownload: vi.fn(async () => {}), onRetry: vi.fn(), onDismiss: vi.fn() };
    await act(async () => root.render(<ResourceSetupDialog {...props} open />));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("已就绪 1/1");
    await act(async () => root.render(<ResourceSetupDialog {...props} open={false} />));
    expect(document.querySelector('[role="dialog"]')?.getAttribute("data-exiting")).toBe("true");
    await act(async () => vi.advanceTimersByTime(MOTION.exit));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.render(<ResourceSetupDialog {...props} open />));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("已就绪 1/1");
    expect(props.onDownload).not.toHaveBeenCalled();
  });
});
