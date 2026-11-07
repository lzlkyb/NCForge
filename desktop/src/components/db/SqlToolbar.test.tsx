// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlTab } from "../../lib/dbStore";
import type { ContextMenuItem } from "../workspace/ContextMenu";
const mocks = vi.hoisted(() => ({ switchConn: vi.fn() }));
vi.mock("../../lib/dbActions", () => ({ switchConn: mocks.switchConn }));
vi.mock("../../lib/dbStore", () => ({ useConnOf: () => ({ name: "测试库", env: "test", user:"NC", url:"jdbc:oracle:thin:@localhost:1521/test", autoCommit: false }), useConnRt: () => ({ status: "connected" }), rtOf: () => ({ status: "connected" }) }));
vi.mock("../../lib/dbReadOnly", () => ({ useDbReadOnly: () => false }));
vi.mock("./ConnPicker", () => ({ ConnPicker: ({ disabled }: { disabled: boolean }) => <button disabled={disabled} aria-label="选择连接">测试库</button> }));
vi.mock("../workspace/ContextMenu", () => ({ ContextMenu: ({ items }: { items: ContextMenuItem[] }) => <div>{items.map((item) => <button key={item.label} onClick={item.onSelect}>{item.label}</button>)}</div> }));
import { SqlToolbar } from "./SqlToolbar";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tab: SqlTab = { id: "t1", kind: "sql", title: "SQL 1", connId: "c1", sql: "", maxRows: 200, timeoutSec: 30, results: [], output: [], plan: null, view: null, running: false, slot: "1", tx: { autoCommit: false, statements: 2, rows: 2, since: 1 } };
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
describe("SQL 工具栏事务入口", () => {
  it("执行旁固定提交和回滚，提交方式只在连接详情中显示", () => {
    const onRun = vi.fn(), noop = () => {};
    act(() => root.render(<SqlToolbar tab={tab} scope="执行选中 SQL" onRun={onRun} onStop={noop} onExplain={noop} onFormat={noop} onExport={noop} onValueSearch={noop} onScriptReplay={noop} historyOpen={false} onHistory={noop} snipsOpen={false} onSnips={noop} sessionsOpen={false} onSessions={noop} />));
    const bar = host.querySelector(".dbx-sqlbar")!;
    expect([...bar.querySelectorAll(".dbx-tx-actions button")].map(button => button.textContent)).toEqual(["提交","回滚"]);
    expect(bar.textContent).not.toMatch(/手动提交|自动提交/);
    expect(host.querySelector(".dbx-connection-detail")?.textContent).toContain("当前会话 · 手动提交");
    expect(host.querySelector(".dbx-context [aria-label='选择连接']")).not.toBeNull();
    expect(host.querySelector(".dbx-scope")?.textContent).toBe("选中 SQL");
    expect(host.querySelector(".dbx-txbar")?.textContent).toContain("未提交事务");
    act(() => bar.querySelector<HTMLButtonElement>(".dbx-runsplit > button")!.click());
    expect(onRun).toHaveBeenCalledWith("current");
  });
});
