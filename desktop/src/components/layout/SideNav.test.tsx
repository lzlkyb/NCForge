// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SideNav, WORKSPACE_NAV } from "./SideNav";

const h = vi.hoisted(() => ({ checkUpdate: vi.fn() }));
vi.mock("./UpdateBadge", () => ({ UpdateBadge: () => <span className="update-slot"><button aria-label="检查更新" onClick={h.checkUpdate}>v0.1.0</button></span> }));
vi.mock("./UpdateCollapsedDot", () => ({ UpdateCollapsedDot: () => null }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("低频日志保留页面和原快捷键位置，主导航只显示常用工作区", () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const navigate = vi.fn();
  try {
    act(() => root.render(<SideNav activeTab="logs" onNavigate={navigate} unreadCount={0} collapsed />));
    const nav = host.querySelector('nav[aria-label="主导航"]')!;
    expect([...nav.querySelectorAll("button")].map(button => button.getAttribute("aria-label"))).toEqual(["代码", "版本控制", "数据库", "元数据"]);
    expect(host.querySelector('[aria-label="日志排查"]')).toBeNull();
    expect(WORKSPACE_NAV[3]).toMatchObject({ key: "logs", showInRail: false });
    // 元数据追加在数组末尾（rail 上紧跟数据库），旧快捷键位因此不动
    expect(WORKSPACE_NAV[4]).toMatchObject({ key: "meta" });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="数据库"]')!.click());
    expect(navigate).toHaveBeenCalledExactlyOnceWith("db");
  } finally { act(() => root.unmount()); host.remove(); }
});

it("未读提示保留数量说明，设置和版本按钮分别触发各自操作", () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), navigate = vi.fn(); h.checkUpdate.mockClear();
  try {
    act(() => root.render(<SideNav activeTab="files" onNavigate={navigate} unreadCount={99} collapsed={false} />));
    const settings = host.querySelector<HTMLButtonElement>('[aria-label="设置，99 项更新记录未读"]')!;
    expect(settings.textContent).toContain("设置");
    expect(settings.title).toContain("99 项更新记录未读");
    act(() => settings.click());
    expect(navigate).toHaveBeenCalledExactlyOnceWith("settings");
    expect(h.checkUpdate).not.toHaveBeenCalled();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="检查更新"]')!.click());
    expect(h.checkUpdate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledTimes(1);
  } finally { act(() => root.unmount()); host.remove(); }
});
