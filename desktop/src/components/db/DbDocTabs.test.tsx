// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ showDocument: vi.fn(), requestCloseTab: vi.fn(), newConsole: vi.fn() }));
vi.mock("../../lib/dbActions", () => ({ requestCloseTab: mocks.requestCloseTab, newConsole: mocks.newConsole }));
vi.mock("../workspace/WorkbenchDock", () => ({ DockRegion: ({ children }: { children: ReactNode }) => children, useWorkbenchDock: () => ({ documentOpen: true, showDocument: mocks.showDocument }) }));
import { DbDocTabs } from "./DbDocTabs";
import { __resetDbForTest, activateTab, closeTab, getDb, openSqlTab, openTableTab, setConns } from "../../lib/dbStore";
import { dbPanelId, dbTabId } from "../../lib/dbPendingSessions";
import type { DbConn } from "../../lib/dbApi";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  __resetDbForTest();
  mocks.showDocument.mockReset();
  mocks.requestCloseTab.mockReset().mockImplementation((id: string) => { closeTab(id); return Promise.resolve(); });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); __resetDbForTest(); });
const render = () => act(() => root.render(<div role="tablist"><DbDocTabs /></div>));
const key = (id: string, value: string) => act(() => document.getElementById(dbTabId(id))!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
describe("数据库文档标签键盘规则", () => {
  it("没有打开的文档时也有「数据库」占位标签和新建控制台按钮", () => {
    render();
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].textContent).toBe("数据库");
    expect(tabs[0].getAttribute("aria-controls")).toBe("dbx-panel-empty");
    expect(host.querySelector('[aria-label="新建 SQL 控制台"]')).not.toBeNull();
  });
  it("只有活动标签可Tab停靠，方向键循环并同步激活，Home/End定位", () => {
    const first = openSqlTab("c1"); const second = openSqlTab("c1"); const last = openTableTab("c1", "BD_MATERIAL");
    activateTab(first); render();
    expect([...host.querySelectorAll<HTMLElement>('[role="tab"]')].filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
    key(first, "ArrowLeft"); expect(getDb().active).toBe(last); expect(document.activeElement?.id).toBe(dbTabId(last));
    key(last, "ArrowRight"); expect(getDb().active).toBe(first);
    key(first, "End"); expect(getDb().active).toBe(last);
    key(last, "Home"); expect(getDb().active).toBe(first);
    key(second, " "); expect(getDb().active).toBe(second);
    expect(document.getElementById(dbTabId(second))?.getAttribute("aria-controls")).toBe(dbPanelId(second));
    expect(mocks.showDocument).toHaveBeenCalled();
  });
  it("同名表以连接和文字环境区分，关闭名称包含标签名，关闭键不激活标签", async () => {
    const conn: DbConn = { id: "c1", name: "开发库", env: "dev", source: "manual", url: "", user: "u", propDs: null, autoCommit: false, note: "", hasPassword: false, engine: "java" };
    setConns([conn, { ...conn, id: "c2", name: "生产库", env: "prod" }]);
    const first = openTableTab("c1", "BD_MATERIAL"); const second = openTableTab("c2", "BD_MATERIAL");
    activateTab(first); render();
    const tab = document.getElementById(dbTabId(second))!;
    expect(tab.textContent).toContain("生产库"); expect(tab.textContent).toContain("生产");
    const close = tab.querySelector<HTMLButtonElement>("button")!;
    expect(close.getAttribute("aria-label")).toContain("bd_material");
    act(() => close.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })));
    expect(getDb().active).toBe(first);
    await act(async () => close.click());
    expect(mocks.requestCloseTab).toHaveBeenCalledWith(second);
    expect(getDb().tabs.some((t) => t.id === second)).toBe(false);
  });
});
