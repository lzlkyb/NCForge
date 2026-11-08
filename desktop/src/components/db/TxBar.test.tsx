// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({invoke:vi.fn(), reconnect:vi.fn()}));
vi.mock("../../lib/tauri", () => ({invoke:mocks.invoke}));
vi.mock("../../lib/dbConfirm", () => ({reconnectSession:mocks.reconnect}));
import { TransactionButtons, TxBar, useDbTransaction } from "./TxBar";
import { __resetDbForTest, connect, openSqlTab, patchTab, setConns, setTx, useDbSelector, type SqlTab } from "../../lib/dbStore";
import type { DbConn } from "../../lib/dbApi";
import { clearCompletedOperations } from "../../lib/operations";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const conn: DbConn = {id:"c1",name:"测试",env:"test",source:"manual",url:"jdbc:oracle:thin:@host:1521/test",user:"NC",propDs:null,autoCommit:false,note:"",hasPassword:false,engine:"rust"};
const empty = {autoCommit:false,statements:0,rows:0,since:0};
const pending = {...empty,statements:3,rows:240};
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  __resetDbForTest();
  clearCompletedOperations();
  mocks.reconnect.mockReset();
  mocks.invoke.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === "db_connect") return {autoCommit:false};
    if (cmd === "db_meta") return {tables:[],names:{}};
    return {};
  });
  setConns([conn]);
  await connect(conn.id);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); __resetDbForTest(); });

function Harness({id, slot, actions = false}: {id?: string; slot?: string; actions?: boolean}) {
  const tab = useDbSelector(s => s.tabs.find((t):t is SqlTab => t.kind === "sql" && t.id === id));
  const transaction = useDbTransaction({connId:conn.id, tabId:id, slot, tx:tab?.tx, notice:tab?.txNotice});
  return <>{!actions && <TransactionButtons transaction={transaction}/>}<TxBar transaction={transaction} actions={actions}/></>;
}

const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!;

it("固定按钮只操作当前槽，同一帧点击两种动作也只提交一次", async () => {
  setTx(conn.id,{...pending,statements:2,rows:50});
  const first = openSqlTab(conn.id), second = openSqlTab(conn.id);
  patchTab<SqlTab>(first,{slot:"1",tx:pending});
  patchTab<SqlTab>(second,{slot:"2",tx:empty});
  let finish!: (value:{tx:typeof empty})=>void;
  mocks.invoke.mockImplementation(() => new Promise(resolve => { finish=resolve; }));
  act(() => root.render(<Harness id={first} slot="1"/>));
  act(() => { button("提交").click(); button("回滚").click(); });
  expect(button("提交中…").disabled).toBe(true);
  expect(button("回滚").disabled).toBe(true);
  await act(async () => {});
  expect(mocks.invoke).toHaveBeenLastCalledWith("db_tx",{id:"c1",slot:"1",action:"commit"});
  act(() => root.render(<Harness id={second} slot="2"/>));
  expect(button("提交").disabled).toBe(true);
  expect(host.querySelector('[role="status"]')).toBeNull();
  await act(async () => finish({tx:empty}));
  act(() => root.render(<Harness id={first} slot="1"/>));
  expect(host.textContent).toContain("已提交 · 240 行");
  expect(button("提交").disabled).toBe(true);
  act(() => root.render(<Harness/>));
  expect(host.textContent).toContain("50 行");
});

it("保存自动提交后，当前会话有待提交写入时仍允许回滚并禁止重连", async () => {
  setTx(conn.id,pending);
  act(() => root.render(<Harness/>));
  act(() => setConns([{...conn,autoCommit:true}]));
  expect(button("提交").disabled).toBe(false);
  expect(button("重新连接").disabled).toBe(true);
  expect(host.textContent).toContain("处理事务后可重连");
  act(() => setTx(conn.id,empty));
  mocks.reconnect.mockImplementation(async () => { setTx(conn.id,{...empty,autoCommit:true}); return true; });
  await act(async () => button("重新连接").click());
  expect(mocks.reconnect).toHaveBeenCalledWith(conn.id,null,undefined,false,true);
  expect(button("提交").disabled).toBe(true);
  expect(host.textContent).toContain("连接设置已生效");
});

it("提交途中断连，停用事务按钮并显示待核对", async () => {
  setTx(conn.id,pending);
  mocks.invoke.mockRejectedValue("session-lost|连接断开");
  act(() => root.render(<Harness/>));
  await act(async () => button("提交").click());
  expect(button("提交").disabled).toBe(true);
  expect(button("回滚").disabled).toBe(true);
  expect(host.textContent).toContain("提交结果待核对");
});

it("提交超时先核对现存会话，状态回读前锁定提交与回滚", async () => {
  setTx(conn.id,pending);
  mocks.invoke.mockRejectedValueOnce("bridge|等待提交超时");
  act(() => root.render(<Harness/>));
  await act(async () => button("提交").click());
  expect(button("回滚").disabled).toBe(true);
  mocks.invoke.mockResolvedValueOnce({tx:pending,alive:true});
  await act(async () => button("核对事务").click());
  expect(mocks.invoke).toHaveBeenLastCalledWith("db_tx",{id:"c1",action:"status",slot:null});
  expect(host.textContent).toContain("事务状态已刷新");
  expect(button("回滚").disabled).toBe(false);
});

it("SQL 原位事务条沿用当前槽的回滚和数据库确认反馈", async () => {
  const id = openSqlTab(conn.id);
  patchTab<SqlTab>(id, {slot:"slot-a",tx:pending});
  mocks.invoke.mockResolvedValue({tx:empty});
  act(() => root.render(<Harness id={id} slot="slot-a" actions/>));
  expect(host.querySelector(".dbx-txbar .dbx-tx-actions")).not.toBeNull();
  await act(async () => button("回滚").click());
  expect(mocks.invoke).toHaveBeenLastCalledWith("db_tx",{id:"c1",slot:"slot-a",action:"rollback"});
  expect(host.textContent).toContain("已回滚 · 240 行");
  expect(host.querySelector(".dbx-tx-actions")).toBeNull();
});

it("SQL 原位提交确认未知时替换为核对入口，不能重复提交", async () => {
  setTx(conn.id,pending);
  mocks.invoke.mockRejectedValueOnce("bridge|等待提交超时");
  act(() => root.render(<Harness actions/>));
  await act(async () => button("提交").click());
  expect(host.querySelector(".dbx-tx-actions")).toBeNull();
  expect(button("核对事务").disabled).toBe(false);
  mocks.invoke.mockResolvedValueOnce({tx:pending,alive:true});
  await act(async () => button("核对事务").click());
  expect(mocks.invoke).toHaveBeenLastCalledWith("db_tx",{id:"c1",action:"status",slot:null});
  expect(button("提交").disabled).toBe(false);
  expect(button("回滚").disabled).toBe(false);
});
