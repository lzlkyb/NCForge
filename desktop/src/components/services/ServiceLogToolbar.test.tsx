// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceLogToolbar } from "./ServiceLogToolbar";
import type { LogPanelForm } from "../../lib/logPanelStore";

vi.mock("../../hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, container: HTMLDivElement;
const onClear = vi.fn(), onPurge = vi.fn();
const form: LogPanelForm = { level: "all", keyword: "", follow: true, wrap: true, query: "", findOpen: false, filterOpen: false, scrollTop: 0, expanded: new Set<number>(), fontSize: 12, seen: null };
const render = async (logSize = 2048, previous = false) => act(async () => root.render(<ServiceLogToolbar form={form} set={() => {}} counts={{ all: 12, warn: 1, error: 1 }} matchedCount={0} matchIndex={0} matchCount={0}
  onMatch={() => {}} findRef={{ current: null }} previous={previous} busy={null} selected="" onCopy={() => {}} onCopySelection={() => {}} onClear={onClear}
  onExport={() => {}} onReload={() => {}} onFollow={() => {}} target="middleware" logSize={logSize} onPurge={onPurge} />));
const click = async (element: Element) => act(async () => (element as HTMLButtonElement).click());
const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.includes(label));

beforeEach(() => { vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("控制台日志的两种清除", () => {
  it("清屏只推视图：菜单项明确写着磁盘文件保留，点了不弹确认框", async () => {
    await render(); await click(container.querySelector('[aria-label="更多日志操作"]')!);
    const screen = menuItem("清屏");
    expect(screen?.textContent).toContain("磁盘文件保留");
    await click(screen!);
    expect(onClear).toHaveBeenCalledOnce();
    expect(onPurge).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("清除日志必须先确认，默认连上次运行归档一起清", async () => {
    await render(2048); await click(container.querySelector('[aria-label="更多日志操作"]')!);
    await click(menuItem("清除日志文件")!);
    expect(onPurge).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("middleware.log");
    expect(dialog.textContent).toContain("2.0 KB");
    await click([...dialog.querySelectorAll("button")].find(button => button.textContent === "清除日志")!);
    expect(onPurge).toHaveBeenCalledWith(true);
  });
  it("取消勾选归档只清当前文件；空日志的菜单项不再暗示有内容", async () => {
    await render(0); await click(container.querySelector('[aria-label="更多日志操作"]')!);
    expect(menuItem("清除日志文件")?.textContent).toContain("已是空的");
    await click(menuItem("清除日志文件")!);
    const dialog = document.querySelector('[role="dialog"]')!;
    await click(dialog.querySelector('input[type="checkbox"]')!);
    await click([...dialog.querySelectorAll("button")].find(button => button.textContent === "清除日志")!);
    expect(onPurge).toHaveBeenCalledWith(false);
  });
  it("上次运行视图里清除项禁用：归档是唯一的历史副本，不该从这里销毁", async () => {
    await render(2048, true); await click(container.querySelector('[aria-label="更多日志操作"]')!);
    expect(menuItem("清除日志文件")?.disabled).toBe(true);
  });
});
