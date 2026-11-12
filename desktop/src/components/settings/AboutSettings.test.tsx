// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../contexts/UpdateContext";
const mocks = vi.hoisted(() => ({
  info: { data: { version: "9.8.7", platform: "windows" } as { version?: string; platform?: string } | undefined,
    isPending: false, isFetching: false, isError: false, refetch: vi.fn() },
  update: { status: "idle" as UpdateStatus, preparing: false, restarting: false, update: null, progress: 0,
    progressIndeterminate: false, downloadedBytes: 0, totalBytes: null, bytesPerSec: 0,
    error: null, errorCode: null, manualCheckForUpdate: vi.fn(), openUpdateNotes: vi.fn(), restart: vi.fn() },
  invoke: vi.fn(), write: vi.fn(),
}));
vi.mock("../../hooks/useAppInfo", () => ({ useAppInfo: () => mocks.info }));
vi.mock("../../contexts/UpdateContext", () => ({ useUpdate: () => mocks.update, friendlyError: (raw: string) => ({ friendly: raw }) }));
vi.mock("../../lib/tauri", () => ({ invoke: mocks.invoke }));
import { AboutSettings } from "./AboutSettings";

let root: Root, host: HTMLDivElement;
const history = vi.fn();
const buttons = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent === text);
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  Object.assign(mocks.info, { data: { version: "9.8.7", platform: "windows" }, isPending: false, isFetching: false, isError: false });
  Object.assign(mocks.update, { status: "idle", preparing: false, restarting: false, progress: 0, progressIndeterminate: false, downloadedBytes: 0, totalBytes: null, bytesPerSec: 0 });
  mocks.write.mockResolvedValue(undefined); mocks.invoke.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.write } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); Reflect.deleteProperty(navigator, "clipboard"); vi.unstubAllGlobals(); });
const render = () => act(() => root.render(<AboutSettings onOpenHistory={history} />));
it("未知运行版本不拿随包版本冒充；平台、仓库与许可使用真实信息", () => {
  render();
  expect(host.querySelector("#about-version")?.textContent).toContain("v9.8.7");
  expect(host.querySelector("#about-version")?.textContent).toContain("Windows");
  expect(host.querySelector("#about-history-title")?.textContent).toBe("随包更新记录");
  expect(host.textContent).not.toContain("your-name");
  expect(host.querySelector("#about-license")?.textContent).toContain("MIT License");
});
it("字段缺失显示恢复操作，成功响应也不会一直读取中", () => {
  mocks.info.data = { platform: "windows" }; render();
  expect(host.textContent).toContain("版本信息不完整");
  expect(buttons("重新读取版本")).toHaveLength(1);
  expect(buttons("检查更新")[0].disabled).toBe(true);
  expect(buttons("复制版本信息")[0].disabled).toBe(true);
  expect(host.querySelector('[aria-label="正在读取版本"]')).toBeNull();
});
it("加载显示骨架，失败可重试且不禁用更新历史", async () => {
  mocks.info.data = undefined; mocks.info.isPending = true; render();
  expect(host.querySelector('[aria-label="正在读取版本"]')).not.toBeNull();
  mocks.info.isPending = false; mocks.info.isError = true; render();
  expect(host.textContent).toContain("版本信息读取失败");
  await act(async () => buttons("重新读取版本")[0].click());
  expect(mocks.info.refetch).toHaveBeenCalledOnce();
  act(() => buttons("查看更新历史")[0].click()); expect(history).toHaveBeenCalledOnce();
});
it("复制完成才反馈成功，失败提示权限问题并恢复可重试", async () => {
  render(); await act(async () => buttons("复制版本信息")[0].click());
  expect(mocks.write).toHaveBeenCalledWith(expect.stringContaining("版本：9.8.7\n平台：Windows"));
  expect(host.textContent).toContain("版本信息已复制");
  mocks.write.mockRejectedValueOnce(new Error("denied"));
  await act(async () => buttons("复制版本信息")[0].click());
  expect(host.textContent).toContain("复制失败"); expect(buttons("复制版本信息")[0].disabled).toBe(false);
});
it("打开外链期间防止重复触发，失败显示恢复反馈", async () => {
  let reject!: (error: Error) => void;
  mocks.invoke.mockReturnValue(new Promise((_, fail) => { reject = fail; })); render();
  act(() => { buttons("打开仓库")[0].click(); buttons("打开仓库")[0].click(); });
  expect(mocks.invoke).toHaveBeenCalledOnce(); expect(host.textContent).toContain("打开中");
  await act(async () => reject(new Error("browser unavailable")));
  expect(host.textContent).toContain("打开链接失败"); expect(buttons("打开仓库")[0].disabled).toBe(false);
});
it("就绪时提供安装操作和独立的更新内容入口", () => {
  mocks.update.status = "ready"; render();
  act(() => buttons("安装并重启")[0].click());
  act(() => buttons("查看更新内容")[0].click());
  expect(mocks.update.openUpdateNotes).toHaveBeenCalledOnce(); expect(mocks.update.restart).toHaveBeenCalledOnce();
  mocks.update.status = "checking"; render();
  expect(host.querySelector('[data-loading="true"]')).not.toBeNull();
});
it("下载显示百分比与速率，完成进入校验，未知大小有明确说明", () => {
  Object.assign(mocks.update, { status: "downloading", progress: 50, downloadedBytes: 524288, totalBytes: 1048576, bytesPerSec: 262144 }); render();
  expect(host.textContent).toContain("50%"); expect(host.textContent).toContain("256 KB/s");
  expect(buttons("查看进度")).toHaveLength(1);
  mocks.update.progress = 100; render(); expect(host.textContent).toContain("正在验证更新包");
  mocks.update.progressIndeterminate = true; render(); expect(host.textContent).toContain("总大小未知");
});

it("隐藏的关于页不清除提醒，本版亮点可见后持久标记且不展示技术记录", () => {
  let visible!: (entries: {isIntersecting:boolean}[]) => void;
  const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof visible) { visible = callback; }
    observe() {} disconnect = disconnect;
  });
  mocks.info.data = {version:"0.3.0", platform:"windows"};
  host.hidden = true; render();
  visible([{isIntersecting:true}]);
  expect(localStorage.getItem("shell_changelog_last_seen")).toBeNull();
  host.hidden = false;
  visible([{isIntersecting:false}]);
  expect(localStorage.getItem("shell_changelog_last_seen")).toBeNull();
  visible([{isIntersecting:true}]);
  expect(localStorage.getItem("shell_changelog_last_seen")).toBe("0.3.0");
  expect(disconnect).toHaveBeenCalled();
  expect(host.querySelectorAll(".release-feature-list > li")).toHaveLength(4);
  expect(host.textContent).not.toContain("技术记录");
  expect(host.textContent).not.toContain("技术与版本信息");
  expect(host.querySelector("#about-history")?.textContent).not.toContain("缓存里的列定义");
});
it("未知运行版本的随包内容不会替用户标记已读", () => {
  const observe = vi.fn();
  vi.stubGlobal("IntersectionObserver", class { observe = observe; disconnect() {} });
  render(); expect(observe).not.toHaveBeenCalled();
  expect(localStorage.getItem("shell_changelog_last_seen")).toBeNull();
});
