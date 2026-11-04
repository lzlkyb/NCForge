// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlTab } from "../../lib/dbStore";
import type { ContextMenuItem } from "../workspace/ContextMenu";
const mocks = vi.hoisted(() => ({ setMode: vi.fn(), switchConn: vi.fn() }));
vi.mock("../../lib/dbTransactionMode", () => ({ setSqlTransactionMode: mocks.setMode }));
vi.mock("../../lib/dbActions", () => ({ switchConn: mocks.switchConn }));
vi.mock("../../lib/dbStore", () => ({ useDb: () => ({}), connOf: () => ({ name: "测试库", env: "test", autoCommit: false }), rtOf: () => ({ status: "connected" }) }));
vi.mock("./ConnPicker", () => ({ ConnPicker: ({ disabled }: { disabled: boolean }) => <button disabled={disabled} aria-label="选择连接">测试库</button> }));
vi.mock("../workspace/ContextMenu", () => ({ ContextMenu: ({ items }: { items: ContextMenuItem[] }) => <div>{items.map((item) => <button key={item.label} onClick={item.onSelect}>{item.label}</button>)}</div> }));
import { SqlToolbar } from "./SqlToolbar";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tab: SqlTab = { id: "t1", kind: "sql", title: "SQL 1", connId: "c1", sql: "", maxRows: 200, timeoutSec: 30, results: [], output: [], plan: null, view: null, running: false, slot: "1", tx: { autoCommit: false, statements: 2, rows: 2, since: 1 } };
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { mocks.setMode.mockReset(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
describe("事务模式切换期间的操作锁", () => {
  it("连续选择只发一次请求，并锁定连接与执行，结束后恢复", async () => {
    let finish!: () => void;
    mocks.setMode.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const onRun = vi.fn();
    const noop = () => {};
    act(() => root.render(<SqlToolbar tab={tab} onRun={onRun} onStop={noop} onExplain={noop} onFormat={noop} onExport={noop} onValueSearch={noop} onScriptReplay={noop} historyOpen={false} onHistory={noop} snipsOpen={false} onSnips={noop} sessionsOpen={false} onSessions={noop} />));
    act(() => host.querySelector<HTMLButtonElement>(".dbx-txchip")!.click());
    const auto = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "自动提交")!;
    act(() => { auto.click(); auto.click(); });
    expect(mocks.setMode).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="选择连接"]')?.disabled).toBe(true);
    const run = host.querySelector<HTMLButtonElement>(".dbx-runsplit > button")!;
    expect(run.disabled).toBe(true);
    act(() => run.click()); expect(onRun).not.toHaveBeenCalled();
    await act(async () => { finish(); await Promise.resolve(); });
    expect(run.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="选择连接"]')?.disabled).toBe(false);
  });
});
