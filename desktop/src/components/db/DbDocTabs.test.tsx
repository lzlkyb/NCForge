// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ showDocument: vi.fn(), requestCloseTab: vi.fn(), requestActivateTab: vi.fn(), requestRestoreClosedTab: vi.fn(), newConsole: vi.fn() }));
vi.mock("../../lib/dbActions", () => ({ requestActivateTab: mocks.requestActivateTab, requestCloseTab: mocks.requestCloseTab, requestRestoreClosedTab: mocks.requestRestoreClosedTab, newConsole: mocks.newConsole }));
vi.mock("../workspace/WorkbenchDock", () => ({ DockRegion: ({ children }: { children: ReactNode }) => children, useWorkbenchDock: () => ({ documentOpen: true, showDocument: mocks.showDocument }) }));
import { DbDocTabs } from "./DbDocTabs";
import { __resetDbForTest, activateTab, closeTab, getDb, openSqlTab, openTableTab, restoreClosedTab, setConns, sqlTabOf } from "../../lib/dbStore";
import { dbPanelId, dbTabId } from "../../lib/dbPendingSessions";
import type { DbConn } from "../../lib/dbApi";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  __resetDbForTest();
  mocks.showDocument.mockReset();
  mocks.requestCloseTab.mockReset().mockImplementation((id: string) => { closeTab(id); return Promise.resolve(); });
  mocks.requestActivateTab.mockReset().mockImplementation((id: string) => { activateTab(id); });
  mocks.requestRestoreClosedTab.mockReset().mockImplementation((id?: string) => restoreClosedTab(id));
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

describe("数据库标签的够得着、找得回与排序", () => {
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]')!;
  const setInput = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const drag = (el: Element, type: string, dt: { effectAllowed: string; dropEffect: string; setData: ReturnType<typeof vi.fn> }) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    act(() => { el.dispatchEvent(ev); });
  };
  const tabEl = (id: string) => document.getElementById(dbTabId(id))!;

  it("标签被裁掉时仍能从「所有标签」下拉里按表名搜索并激活", async () => {
    const first = openSqlTab("c1");
    const table = openTableTab("c1", "BD_MATERIAL");
    openSqlTab("c1");
    activateTab(first);
    render();
    expect(host.querySelector(".wb-tabs-scroll")).not.toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="所有数据库标签"]')!;
    expect(trigger.disabled).toBe(false);
    await act(async () => trigger.click());
    expect(menu().querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    const input = menu().querySelector<HTMLInputElement>('input[aria-label="搜索打开的数据库标签"]')!;
    await act(async () => setInput(input, "bd_material"));
    expect(menu().querySelectorAll('[role="menuitem"]')).toHaveLength(1);
    await act(async () => menu().querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(getDb().active).toBe(table);
    expect(mocks.showDocument).toHaveBeenCalled();
  });

  it("关闭后能从「最近关闭」下拉恢复草稿", async () => {
    const sql = openSqlTab("c1", "select * from t");
    closeTab(sql);
    render();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="最近关闭的数据库标签"]')!;
    await act(async () => trigger.click());
    const item = menu().querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(item.textContent).toContain("SQL");
    await act(async () => item.click());
    expect(getDb().tabs.some((t) => t.id === sql)).toBe(true);
    expect(sqlTabOf(sql)?.sql).toBe("select * from t");
    expect(mocks.showDocument).toHaveBeenCalled();
  });

  it("文档面的恢复快捷键能把刚关掉的 SQL 找回来", () => {
    const sql = openSqlTab("c1", "draft");
    closeTab(sql);
    render();
    // 默认 Eclipse 方案：Ctrl+Alt+T（Ctrl+Shift+T 留给转到类型）
    const ev = new KeyboardEvent("keydown", { key: "t", ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(getDb().active).toBe(sql);
    expect(getDb().tabs.some((t) => t.id === sql)).toBe(true);
  });

  it("拖拽排序：插到目标前，拖到空白 /「+」落到末尾", () => {
    const a = openSqlTab("c1"), b = openTableTab("c1", "T"), c = openSqlTab("c1");
    render();
    const dt = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
    drag(tabEl(c), "dragstart", dt);
    drag(tabEl(a), "dragover", dt);
    drag(tabEl(a), "drop", dt);
    expect(getDb().tabs.map((t) => t.id)).toEqual([c, a, b]);
    drag(tabEl(a), "dragstart", dt);
    drag(host.querySelector(".dbx-tabadd")!, "drop", dt);
    expect(getDb().tabs.map((t) => t.id)).toEqual([c, b, a]);
  });
});
