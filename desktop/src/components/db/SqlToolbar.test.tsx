// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SQL_FORMAT, getSqlFormatPrefs, setSqlFormatPrefs } from "../../lib/sqlFormatPrefs";
import type { SqlTab } from "../../lib/dbStore";
import type { ContextMenuItem } from "../workspace/ContextMenu";
const mocks = vi.hoisted(() => ({ switchConn: vi.fn(), readOnly: false as boolean | null }));
vi.mock("../../lib/dbActions", () => ({ switchConn: mocks.switchConn }));
vi.mock("../../lib/dbStore", () => ({ isRunning: (t: { run?: unknown } | null | undefined) => !!t?.run, useConnOf: (id: string | null) => id ? ({ name: "测试库", env: "test", user:"NC", url:"jdbc:oracle:thin:@localhost:1521/test", autoCommit: false }) : null, useConnRt: () => ({ status: "connected" }), rtOf: () => ({ status: "connected" }) }));
vi.mock("../../lib/dbReadOnly", () => ({ useDbReadOnly: () => mocks.readOnly, useDbReadOnlyState: () => ({ value: mocks.readOnly, error: "", retry: () => {} }) }));
vi.mock("./ConnPicker", () => ({ ConnPicker: ({ disabled }: { disabled: boolean }) => <button disabled={disabled} aria-label="选择连接">测试库</button> }));
vi.mock("../workspace/ContextMenu", () => ({ ContextMenu: ({ items, onClose }: { items: ContextMenuItem[]; onClose: () => void }) => <div role="menu">{items.map((item) => <button key={item.label} disabled={item.disabled} onClick={() => { item.onSelect(); onClose(); }}>{item.label}</button>)}</div> }));
import { SqlToolbar } from "./SqlToolbar";
import { beginOperation } from "../../lib/operations";
import type { SqlExecutionScope } from "./SqlEditor";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tab: SqlTab = { id: "t1", kind: "sql", title: "SQL 1", connId: "c1", sql: "", maxRows: 200, timeoutSec: 30, results: [], output: [], plan: null, view: null, slot: "1", tx: { autoCommit: false, statements: 0, rows: 0, since: 0 } };
const scope: SqlExecutionScope = { tabId: tab.id, selected: false, statements: [{ text: "select 1 from dual", startLine: 2, endLine: 6 }] };
type Props = Parameters<typeof SqlToolbar>[0];
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { setSqlFormatPrefs(DEFAULT_SQL_FORMAT); mocks.readOnly = false; vi.clearAllMocks(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const runButton = () => host.querySelector<HTMLButtonElement>(".dbx-run-action")!;
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent) === text)!;
function render(overrides: Partial<Props> = {}) {
  const props: Props = { tab, scope, onRun: vi.fn(), onStop: vi.fn(), onExplain: vi.fn(), onFormat: vi.fn(), onExport: vi.fn(), onValueSearch: vi.fn(), onScriptReplay: vi.fn(), historyOpen: false, onHistory: vi.fn(), snipsOpen: false, onSnips: vi.fn(), sessionsOpen: false, onSessions: vi.fn(), ...overrides };
  act(() => root.render(<SqlToolbar {...props} />));
  return props;
}

describe("SQL 执行范围", () => {
  it("执行统计由工具菜单单次开启", () => {
    const props = render();
    act(() => button("更多执行方式").click());
    act(() => button("执行当前语句并采集统计").click());
    expect(props.onRun).toHaveBeenCalledWith("current", true);
  });

  it("执行名称、行范围和语句数来自当前文档的真实目标", () => {
    const props = render();
    expect(host.querySelector(".dbx-scope")?.textContent).toBe("第 2–6 行");
    expect(runButton().textContent).toContain("执行");
    act(() => runButton().click());
    expect(props.onRun).toHaveBeenCalledWith("auto");
    render({ scope: { ...scope, selected: true, statements: [{ text: "select 1", startLine: 2, endLine: 3 }, { text: "select 2", startLine: 5, endLine: 8 }] } });
    expect(runButton().disabled).toBe(false);
    expect(host.querySelector(".dbx-scope")?.textContent).toBe("第 2–8 行");
    expect(host.querySelector(".dbx-execution-primary")?.textContent).not.toMatch(/Ctrl\+Enter|Alt\+X/);
    expect(host.querySelector(".dbx-execution-primary")?.textContent).not.toMatch(/\d+ 条/);
    act(() => runButton().click());
    expect(props.onRun).toHaveBeenLastCalledWith("auto");
  });
  it("空白 SQL 禁用主执行并就地说明，历史和片段仍然可用", () => {
    render({ scope: { ...scope, statements: [] } });
    expect(runButton().disabled).toBe(true);
    expect(host.querySelector(".dbx-scope")?.textContent).toContain("光标处没有可执行 SQL");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="执行历史"]')?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="SQL 片段"]')?.disabled).toBe(false);
    render({ scope: { ...scope, selected: true, statements: [] } });
    expect(runButton().disabled).toBe(true);
    expect(host.querySelector(".dbx-scope")?.textContent).toContain("选中内容没有可执行 SQL");
  });
  it("切标签不能显示或执行上一份标签的范围", () => {
    render({ tab: { ...tab, id: "t2" } });
    expect(runButton().disabled).toBe(true);
    expect(host.querySelector(".dbx-scope")?.textContent).toBe("正在读取执行范围…");
  });
  it("执行期间原位保留停止入口", () => {
    const props = render({ tab: { ...tab, run: { id: 1, connId: "c1", at: 0, slot: null, kind: "execute" } } });
    expect(button("停止").disabled).toBe(false);
    expect(runButton().disabled).toBe(true);
    act(() => button("停止").click());
    expect(props.onStop).toHaveBeenCalledOnce();
  });

  /**
   * 回归：v0.4.0 里「执行」按钮从 `beginOperation` 那一刻就灰了，而「停止」只看标签上
   * 那个更晚落地的执行身份——建连接、等口令、申请独立会话这段窗口里两个按钮都是灰的，
   * 用户以为整个执行都停不下来。执行入口与停止入口必须共用同一个「正在执行」判据。
   */
  it("任务一登记，停止入口就可用，不等标签上的执行身份落地", () => {
    let task: ReturnType<typeof beginOperation> = null;
    act(() => { task = beginOperation({ key: "db.sql:t1", label: "执行 SQL" }); });
    render();
    expect(runButton().disabled).toBe(true);
    expect(button("停止").disabled).toBe(false);
    act(() => task?.finish("cancelled"));
    render();
    expect(button("停止").disabled).toBe(true);
  });
});

describe("会话上下文与事务", () => {
  it("空闲时显示模式，提交回滚收进带禁用原因的会话菜单", () => {
    render();
    expect(host.querySelector(".dbx-context-session")?.textContent).toContain("手动提交");
    expect(host.querySelector<HTMLButtonElement>('.dbx-command-header [aria-label="提交当前会话"]')?.disabled).toBe(true);
    expect(host.querySelector(".dbx-txbar")).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>(".dbx-session-trigger")!.click());
    expect(host.querySelector('[role="menu"]')?.textContent).toContain("当前会话没有待提交的写入");
    expect(button("提交当前会话").disabled).toBe(true);
    expect(button("回滚当前会话").disabled).toBe(true);
  });
  it("待提交状态在所属会话的事务条内提供可用操作", () => {
    render({ tab: { ...tab, tx: { autoCommit: false, statements: 2, rows: 20, since: 1 } } });
    const transaction = host.querySelector(".dbx-txbar")!;
    expect(host.querySelector(".dbx-session-trigger")?.getAttribute("title")).toContain("独立会话");
    expect(transaction.textContent).toContain("2 条写入 · 影响 20 行");
    expect([...host.querySelectorAll<HTMLButtonElement>(".dbx-command-header .dbx-tx-actions button")].map(item => [item.getAttribute("aria-label"), item.disabled])).toEqual([["提交当前会话", false], ["回滚当前会话", false]]);
  });
  it("未知事务禁止继续执行，核对入口保留在原位", () => {
    render({ tab: { ...tab, txNotice: { kind: "lost", verify: true, text: "提交结果待核对" } } });
    expect(runButton().disabled).toBe(true);
    expect(host.querySelector(".dbx-scope")?.textContent).toContain("事务结果待核对");
    expect(host.querySelector(".dbx-txbar")?.textContent).toContain("核对事务");
    expect(button("核对事务").disabled).toBe(false);
  });
  it("连接只读明确覆盖全部会话，账号和 URL 留在详情里", () => {
    mocks.readOnly = true;
    render();
    expect(host.querySelector(".dbx-connection-readonly")?.textContent).toBe("连接只读：开启此连接全部会话");
    expect(host.querySelector(".dbx-context-session")?.textContent).toContain("只读查询");
    expect(host.querySelector(".dbx-connection-detail")?.textContent).toContain("账号 · NC");
    expect(host.querySelector(".dbx-connection-detail")?.textContent).toContain("jdbc:oracle:thin:");
    expect(host.querySelector(".dbx-context-account")).toBeNull();
  });
});

it.each([
  ["更多执行方式", "执行整个脚本", "onRun", "script"],
  ["更多数据库操作", "回放 .sql 文件", "onScriptReplay", undefined],
  ["更多数据库操作", "导出 INSERT（光标处查询）", "onExport", undefined],
  ["更多数据库操作", "按值反查（只读）", "onValueSearch", undefined],
  ["更多数据库操作", "会话与锁", "onSessions", undefined],
] as const)("保留 %s 中的 %s", (menu, label, callback, argument) => {
  const props = render();
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="' + menu + '"]')!.click());
  act(() => button(label).click());
  if (argument) expect(props[callback]).toHaveBeenCalledWith(argument);
  else expect(props[callback]).toHaveBeenCalledOnce();
});

it("可专注结果、专注编辑器并还原布局", () => {
  const onFocusChange = vi.fn();
  render({ onFocusChange });
  act(() => button("编辑器与结果布局").click());
  act(() => button("专注结果").click());
  expect(onFocusChange).toHaveBeenLastCalledWith("results");
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="编辑器与结果布局"]')!.click());
  act(() => button("专注编辑器").click());
  expect(onFocusChange).toHaveBeenLastCalledWith("editor");
  render({ onFocusChange, focusMode: "editor" });
  act(() => button("编辑器与结果布局").click());
  act(() => button("还原布局").click());
  expect(onFocusChange).toHaveBeenLastCalledWith("split");
});

it("常用编辑工具无需菜单，执行按钮显示文字并保留范围提示", () => {
  const props = render();
  expect(runButton().textContent).toBe("执行当前语句");
  expect(runButton().title).toContain("第 2–6 行");
  act(() => button("格式化 SQL").click());
  act(() => button("执行计划").click());
  expect(props.onFormat).toHaveBeenCalledOnce();
  expect(props.onExplain).toHaveBeenCalledOnce();
  expect(button("停止").disabled).toBe(true);
});
it("无连接仍可格式化 SQL，数据库操作禁用", () => {
  const props = render({tab: {...tab, connId:null}});
  act(() => button("格式化 SQL").click());
  expect(props.onFormat).toHaveBeenCalledOnce();
  expect(button("执行历史").disabled).toBe(true);
  expect(runButton().disabled).toBe(true);
  expect(button("执行计划").disabled).toBe(true);
});
it("格式化范围下拉把三档范围交给编辑器", () => {
  const props = render();
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="格式化选项"]')!.click());
  act(() => button("仅格式化当前语句").click());
  expect(props.onFormat).toHaveBeenLastCalledWith("current");
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="格式化选项"]')!.click());
  act(() => button("格式化整个脚本").click());
  expect(props.onFormat).toHaveBeenLastCalledWith("script");
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="格式化选项"]')!.click());
  act(() => button("格式化整个编辑器").click());
  expect(props.onFormat).toHaveBeenLastCalledWith("auto");
});
it("窄栏把辅助功能收入更多菜单，释放观察器", () => {
  let resize!: ResizeObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {constructor(callback: ResizeObserverCallback) {resize=callback;} observe() {} disconnect=disconnect;});
  const props = render();
  act(() => resize([{contentRect:{width:700}}] as ResizeObserverEntry[], {} as ResizeObserver));
  expect(button("执行历史")).toBeUndefined();
  expect(button("格式化 SQL")).toBeDefined();
  act(() => button("更多数据库操作").click());
  act(() => button("执行计划（不真正执行）").click());
  expect(props.onExplain).toHaveBeenCalledOnce();
  act(() => root.unmount());
  expect(disconnect).toHaveBeenCalledOnce();
  root=createRoot(host);
  vi.unstubAllGlobals();
});

it("排版菜单只更改偏好，下次格式化使用当前方式", () => {
  const props = render();
  act(() => button("格式化选项").click());
  act(() => button("排版：结构展开").click());
  expect(getSqlFormatPrefs().layout).toBe("expanded");
  expect(props.onFormat).not.toHaveBeenCalled();
  expect(button("格式化 SQL").title).toContain("结构展开");
  act(() => button("格式化选项").click());
  act(() => button("排版：阅读优先").click());
  expect(getSqlFormatPrefs().layout).toBe("reading");
  expect(props.onFormat).not.toHaveBeenCalled();
  act(() => button("格式化 SQL").click());
  expect(props.onFormat).toHaveBeenCalledOnce();
});
