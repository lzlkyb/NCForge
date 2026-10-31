// @vitest-environment jsdom
/**
 * 多结果集的接线（`dbms_sql.return_result`）。
 *
 * 驱动能取行、引擎能拼 `sets`，但如果结果区只读 `entry.rows`，用户在界面上还是
 * 只看到第一张表——这条测试盯的就是「后端给了 `sets`，界面真的用了它」：
 * ① 多于一个结果集时出小标签；
 * ② 点第二个标签换的是**列名与行**，不是同一张表换个标题。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResultSet } from "../../lib/dbApi";
import type { ResultEntry, SqlTab } from "../../lib/dbStore";
import { ResultPanel } from "./ResultPanel";

// ResultGrid 的虚拟滚动靠 ResizeObserver，`scrollTo` 在 jsdom 上也不存在
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
(HTMLElement.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const set = (name: string, rows: unknown[][], hasMore = false): ResultSet => ({
  columns: [{ name, type: "VARCHAR2(10)", precision: 10, scale: 0 }],
  rows: rows as ResultSet["rows"],
  rowCount: rows.length,
  hasMore,
});

const entry = (over: Partial<ResultEntry> = {}): ResultEntry => ({
  id: "r1",
  index: 1,
  sql: "declare rc sys_refcursor; begin open rc for select ...; dbms_sql.return_result(rc); end;",
  kind: "rows",
  columns: [],
  rows: [],
  hasMore: false,
  updateCount: -1,
  ms: 21,
  ...over,
});

function tabWith(e: ResultEntry): SqlTab {
  return {
    kind: "sql",
    id: "s1",
    title: "SQL 1",
    connId: "c1",
    sql: e.sql,
    maxRows: 500,
    timeoutSec: 30,
    results: [e],
    view: e.id,
    output: [],
    plan: null,
    running: false,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => {});

async function mount(e: ResultEntry) {
  await act(async () => {
    root.render(<ResultPanel tab={tabWith(e)} height={300} />);
  });
  await flush();
}

const text = () => host.textContent ?? "";
const click = async (label: string) => {
  const btn = [...host.querySelectorAll<HTMLElement>(".dbx-settab")].find((b) => b.textContent?.includes(label));
  if (!btn) throw new Error(`找不到「${label}」小标签`);  await act(async () => btn!.click());
  await flush();
};

describe("ResultPanel 多结果集", () => {
  it("两个结果集：出小标签，切换后列名与行都跟着换", async () => {
    const sets = [set("A", [["1"]]), set("S", [["x"], ["y"]])];
    await mount(entry({ sets, columns: sets[0].columns, rows: sets[0].rows }));

    expect(text()).toContain("结果集 1");
    expect(text()).toContain("结果集 2");
    // 默认显示第一个
    expect(host.querySelector(".dbx-gh .nm")?.textContent).toBe("a");
    // 结果标签上的摘要报「几个结果集」，不是第一个的行数
    expect(host.querySelector(".dbx-rtab")?.textContent).toContain("2 个结果集");

    await click("结果集 2");
    const heads = [...host.querySelectorAll(".dbx-gh .nm")].map((e) => e.textContent);
    // 切到第二个结果集要换成它的列（不是同一张表换个标题）
    expect(heads).toEqual(["s"]);
    expect(text()).toContain("第 2/2 个结果集");
  });

  it("只有一个结果集：不出小标签，按普通结果处理", async () => {
    const sets = [set("A", [["1"]])];
    await mount(entry({ sets, columns: sets[0].columns, rows: sets[0].rows }));
    expect(host.querySelector(".dbx-settab")).toBeNull();
    expect(host.querySelector(".dbx-gh .nm")?.textContent).toBe("a");
  });

  it("取到上限截断：提示调大行数重跑，且不给「加载下 N 行」", async () => {
    const sets = [set("A", [["1"]], true)];
    await mount(entry({ sets, columns: sets[0].columns, rows: sets[0].rows }));
    expect(text()).toContain("调大");
    expect(text()).not.toContain("加载下");
  });

  it("普通查询仍给「加载下 N 行」入口（没有被多结果集改动带坏）", async () => {
    const cols = [{ name: "N", type: "NUMBER", precision: 10, scale: 0 }];
    await mount(entry({ columns: cols, rows: [["1"]], hasMore: true }));
    expect(host.querySelector(".dbx-settab")).toBeNull();
    expect(text()).toContain("加载下");
  });
});
