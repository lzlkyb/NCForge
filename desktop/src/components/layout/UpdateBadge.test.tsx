// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateBadge } from "./UpdateBadge";
import { UpdateRailItem } from "./UpdateRailItem";

const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>, toast: vi.fn(), open: vi.fn(), download: vi.fn(),
  restart: vi.fn(), check: vi.fn(), acknowledge: vi.fn(),
}));
vi.mock("../../contexts/UpdateContext", () => ({
  useUpdate: () => h.state,
  friendlyError: (raw: string) => ({ friendly: raw, raw }),
}));
vi.mock("../ui/toast", () => ({ useToast: () => ({ toast: h.toast }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  h.state = {
    status: "idle", update: { version: "0.1.1" }, progress: 42, progressIndeterminate: false,
    bytesPerSec: 100, downloadedBytes: 42, totalBytes: 100, preparing: false, restarting: false,
    notesOpen: false, error: null, errorCode: null, errorToastAllowed: true, manualCheck: false,
    openUpdateNotes: h.open, downloadAndInstall: h.download, restart: h.restart,
    manualCheckForUpdate: h.check, acknowledgeUptodate: h.acknowledge,
    // Even a previously ignored version must open details rather than directly download.
    isDismissed: () => true,
  };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(status: string) {
  h.state.status = status;
  await act(async () => root.render(<><UpdateBadge currentVersion="0.1.0" /><UpdateRailItem /></>));
}

describe("update entry points", () => {
  for (const status of ["available", "downloading", "ready", "installing", "error"]) {
    it(`${status}展开徽章与折叠项都只打开更新详情`, async () => {
      await render(status);
      const badge = host.querySelector('.update-slot button') as HTMLButtonElement;
      const rail = host.querySelector('.app-side-update') as HTMLButtonElement;
      expect(badge).not.toBeNull(); expect(rail).not.toBeNull();
      await act(async () => { badge.click(); rail.click(); });
      expect(h.open).toHaveBeenCalledTimes(2);
      expect(h.download).not.toHaveBeenCalled(); expect(h.restart).not.toHaveBeenCalled();
      expect(h.check).not.toHaveBeenCalled();
      expect(host.querySelectorAll('.update-slot')).toHaveLength(1);
    });
  }
  it("未知大小的徽章不显示伪百分比", async () => {
    h.state.progressIndeterminate = true; h.state.totalBytes = null;
    await render("downloading");
    expect(host.querySelector('.header-badge')?.textContent).toContain("下载中");
    expect(host.querySelector('.header-badge')?.textContent).not.toContain("%");
    expect(host.querySelector('.app-side-update')?.getAttribute("aria-label")).toContain("总大小未知");
  });
  it("没有更新时不占位：空闲/检查中/已是最新都不出现折叠项", async () => {
    for (const status of ["idle", "checking", "uptodate"]) {
      await render(status);
      expect(host.querySelector('.app-side-update')).toBeNull();
      expect(host.querySelector('.update-slot')).not.toBeNull();
    }
  });
  it("下载中把进度写进折叠项文字", async () => {
    await render("downloading");
    expect(host.querySelector('.app-side-update')?.textContent).toContain("42%");
  });
  it("自动新版本弹框不再叠加通知，自动检查失败保持安静", async () => {
    await render("idle"); await render("available"); expect(h.toast).not.toHaveBeenCalled();
    h.state.errorToastAllowed = false; h.state.error = "network";
    await render("error"); expect(h.toast).not.toHaveBeenCalled();
  });
  it("弹框可见时下载完成不再叠加提示，后台完成仍给出通知", async () => {
    h.state.notesOpen = true; await render("downloading"); await render("ready");
    expect(h.toast).not.toHaveBeenCalled();
    h.state.notesOpen = false; await render("downloading"); await render("ready");
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("点击更新入口查看变化"), "success");
    expect(h.restart).not.toHaveBeenCalled();
  });
  it("手动检查最新版本保留提示并消费标记", async () => {
    await render("idle"); h.state.manualCheck = true; await render("uptodate");
    expect(h.toast).toHaveBeenCalledWith("已是最新版本", "success");
    expect(h.acknowledge).toHaveBeenCalledOnce();
  });
  it("工作预检时入口禁用，不把更新弹框盖在保存确认之上", async () => {
    h.state.preparing = true; await render("ready");
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.every(button => button.disabled)).toBe(true);
    await act(async () => buttons.forEach(button => button.click()));
    expect(h.open).not.toHaveBeenCalled();
  });
});

it("下载100%显示校验中，安装失败显示重试而不是就绪成功", async () => {
  h.state.progress=100;
  await render("downloading");
  expect(host.querySelector(".header-badge")?.textContent).toContain("校验中");
  expect(host.querySelector(".app-side-update")?.textContent).toContain("校验中");
  h.state.error="install failed";
  await render("ready");
  expect(host.querySelector(".header-badge")?.textContent).toContain("安装重试");
  expect(host.querySelector(".header-badge")?.className).toContain("error");
  expect(h.restart).not.toHaveBeenCalled();
});
