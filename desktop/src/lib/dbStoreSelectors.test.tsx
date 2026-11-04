// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke }));

import { __resetDbForTest, openSqlTab, patchTab, setTx, useActiveDbTab, useConnRt, useDbSelector, type SqlTab } from "./dbStore";

/**
 * 轻量化方案第三批：数据库组件只订阅自己的切片。
 * 验收口径：连接 B 的变化不触发只看连接 A 的组件重渲染。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const TX = (statements: number) => ({ autoCommit: false, statements, rows: statements, since: 0 });

let root: Root;
let host: HTMLDivElement;
/** 挂一个只调用 `hook` 的组件，返回「渲染次数」与「最近一次的返回值」。 */
function mount<T>(hook: () => T) {
  const probe = { renders: 0, value: undefined as T };
  function Probe() {
    probe.renders++;
    probe.value = hook();
    return null;
  }
  act(() => root.render(<Probe />));
  return probe;
}

beforeEach(() => {
  mocks.invoke.mockReset();
  __resetDbForTest();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("数据库仓库切片订阅", () => {
  it("连接 B 的运行态变化不重渲染只看连接 A 的组件；A 自己变了才重渲染", () => {
    const p = mount(() => useConnRt("A"));
    const first = p.renders;
    act(() => setTx("B", TX(1)));
    act(() => setTx("B", TX(2)));
    expect(p.renders).toBe(first);
    // 没连过的连接也是稳定引用，否则每次快照都算「变了」
    expect(p.value.status).toBe("idle");
    act(() => setTx("A", TX(3)));
    expect(p.renders).toBe(first + 1);
    expect(p.value.tx?.statements).toBe(3);
  });

  it("别的标签写回查询状态时，只看活动标签的组件不重渲染", () => {
    const bg = openSqlTab(null, "select 1 from dual");
    const fg = openSqlTab(null, "select 2 from dual"); // 后开的成为活动标签
    const p = mount(() => useActiveDbTab());
    expect(p.value?.id).toBe(fg);
    const first = p.renders;
    act(() => patchTab<SqlTab>(bg, { running: true }));
    act(() => patchTab<SqlTab>(bg, { running: false }));
    expect(p.renders).toBe(first);
    act(() => patchTab<SqlTab>(fg, { running: true }));
    expect(p.renders).toBe(first + 1);
  });

  it("表行只订阅「是不是当前表」的布尔值：连接状态变化、新开 SQL 标签都不重渲染", () => {
    openSqlTab(null, "");
    const p = mount(() => useDbSelector((s) => s.tabs.find((t) => t.id === s.active)?.kind === "table"));
    const first = p.renders;
    act(() => setTx("A", TX(1)));
    act(() => { openSqlTab(null, "select 3 from dual"); });
    expect(p.renders).toBe(first);
  });
});
