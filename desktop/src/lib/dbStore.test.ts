// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke }));

import { __resetDbForTest, closeTab, ensureSlot, execOne, openSqlTab, patchTab, sqlTabOf, summaryOf, type ResultEntry, type SqlTab } from "./dbStore";

/**
 * 结果摘要（结果标签上那截小字）。
 *
 * 重点是**多结果集**：`dbms_sql.return_result` 一次能带回好几张表，
 * 这时按第一个结果集报行数会让用户以为其它结果集也是这么点行。
 */

const base: ResultEntry = {
  id: "r1",
  index: 1,
  sql: "select 1 from dual",
  kind: "rows",
  columns: [],
  rows: [],
  hasMore: false,
  updateCount: -1,
  ms: 12,
};

describe("独立槽申请期间的标签身份", () => {
  beforeEach(() => { mocks.invoke.mockReset(); __resetDbForTest(); });
  it.each(["close", "switch"])("申请完成前%s标签会释放旧槽，避免错绑或遗留会话", async (change) => {
    let acquired!: (value: { slot: string }) => void;
    const waiting = new Promise<{ slot: string }>((resolve) => { acquired = resolve; });
    mocks.invoke.mockImplementation((cmd: string) => cmd === "db_slot_acquire" ? waiting : Promise.resolve(null));
    const id = openSqlTab("c1");
    const task = ensureSlot(id, "c1");
    if (change === "close") closeTab(id);
    else patchTab<SqlTab>(id, { connId: "c2", slot: null, tx: undefined });
    acquired({ slot: "7" });
    expect(await task).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("db_slot_release", { id: "c1", slot: "7" });
    expect(sqlTabOf(id)?.slot).not.toBe("7");
  });
});

describe("summaryOf", () => {
  it("单结果集报行数，取满加 +", () => {
    expect(summaryOf({ ...base, rows: [[1], [2]] })).toBe("2 行");
    expect(summaryOf({ ...base, rows: [[1]], hasMore: true })).toBe("1+ 行");
  });

  it("多结果集报个数（不是第一个的行数）", () => {
    const sets = [
      { columns: [], rows: [[1]], rowCount: 1, hasMore: false },
      { columns: [], rows: [[1], [2], [3]], rowCount: 3, hasMore: false },
    ];
    // 顶层 rows 是第一个结果集，若照旧报「1 行」就漏掉了后面那两张表
    expect(summaryOf({ ...base, rows: [[1]], sets })).toBe("2 个结果集");
  });

  it("只有一个结果集时仍报行数（`return_result` 一次也算普通结果）", () => {
    const sets = [{ columns: [], rows: [[1], [2]], rowCount: 2, hasMore: false }];
    expect(summaryOf({ ...base, rows: [[1], [2]], sets })).toBe("2 行");
  });

  it("写语句与出错各给人话", () => {
    expect(summaryOf({ ...base, kind: "update", updateCount: 3 })).toBe("更新 3 行");
    expect(summaryOf({ ...base, kind: "update", updateCount: -1 })).toBe("已执行");
    expect(summaryOf({ ...base, kind: "error", error: "ORA-00942: 表或视图不存在" })).toBe("ORA-00942");
  });
});

describe("execOne 把 sets 带到结果条目上", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    __resetDbForTest();
  });

  const rowsBody = {
    kind: "rows",
    columns: [{ name: "A", type: "NUMBER", precision: 10, scale: 0 }],
    rows: [["1"]],
    rowCount: 1,
    hasMore: false,
    sets: [
      { columns: [{ name: "A", type: "NUMBER", precision: 10, scale: 0 }], rows: [["1"]], rowCount: 1, hasMore: false },
      { columns: [{ name: "S", type: "VARCHAR2(10)", precision: 10, scale: 0 }], rows: [["x"]], rowCount: 1, hasMore: true },
    ],
    ms: 5,
    output: [],
    tx: { autoCommit: true, statements: 0, rows: 0, since: 0 },
  };

  it("后端给了 sets 就不能丢（丢了界面只剩第一张表）", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "db_slot_acquire" ? { slot: "1" } : rowsBody),
    );
    const tabId = openSqlTab("c1", "select 1 from dual");
    const e = await execOne(tabId, "select 1 from dual", 1);
    expect(e.kind).toBe("rows");
    expect(e.sets).toHaveLength(2);
    expect(e.sets?.[1].hasMore).toBe(true);
    expect(summaryOf(e)).toBe("2 个结果集");
  });

  it("标签第一次执行先申请独立会话，并把槽名带进后续每条命令", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "db_slot_acquire" ? { slot: "2" } : rowsBody),
    );
    const tabId = openSqlTab("c1", "select 1 from dual");
    await execOne(tabId, "select 1 from dual", 1);
    // A0 的核心：执行必须落到自己那条会话上，否则长查询还是会把别的标签堵住
    const exec = mocks.invoke.mock.calls.find((c) => c[0] === "db_exec");
    expect(exec?.[1]).toMatchObject({ id: "c1", slot: "2" });
    expect(mocks.invoke.mock.calls.filter((c) => c[0] === "db_slot_acquire")).toHaveLength(1);
  });

  it("申请不到槽时退回 primary，执行不失败", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "db_slot_acquire") return Promise.reject("slots-full|最多 3 个独立会话");
      return Promise.resolve(rowsBody);
    });
    const tabId = openSqlTab("c1", "select 1 from dual");
    const e = await execOne(tabId, "select 1 from dual", 1);
    expect(e.kind).toBe("rows");
    const exec = mocks.invoke.mock.calls.find((c) => c[0] === "db_exec");
    expect(exec?.[1]).toMatchObject({ slot: null });
  });

  it("槽被空闲回收（slot-gone）后自动重开再试一次", async () => {
    // 槽空闲 10 分钟就被后端收掉，而标签上的槽名还在。这时报错让用户「再点一次运行」
    // 是最差的做法——他自己并不知道发生了什么。这里必须自动换新槽重跑。
    let acquired = 0;
    let execs = 0;
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "db_slot_acquire") return Promise.resolve({ slot: String(++acquired) });
      if (cmd === "db_exec") {
        execs += 1;
        if (execs === 1) return Promise.reject("slot-gone|会话 1 已被回收，请重试");
        return Promise.resolve(rowsBody);
      }
      return Promise.resolve(null);
    });
    const tabId = openSqlTab("c1", "select 1 from dual");
    const e = await execOne(tabId, "select 1 from dual", 1);
    expect(e.kind).toBe("rows");
    // 两次申请 = 第一次的槽 1 作废，重开拿到槽 2
    expect(mocks.invoke.mock.calls.filter((c) => c[0] === "db_slot_acquire")).toHaveLength(2);
    const execCalls = mocks.invoke.mock.calls.filter((c) => c[0] === "db_exec");
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0][1]).toMatchObject({ slot: "1" });
    expect(execCalls[1][1]).toMatchObject({ slot: "2" });
  });

  it("改走 JVM 桥执行的结果要在输出区留一行说明", async () => {
    // P0 能力路由：Rust 引擎跑不了的 REF CURSOR 语句被搬到 JVM 桥的临时会话上执行。
    // 那条会话**不归事务条管**——不说明的话，用户点了回滚会以为它也撤掉了。
    mocks.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "db_slot_acquire"
          ? { slot: "1" }
          : {
              ...rowsBody,
              sets: undefined,
              fallback: { engine: "java", reason: "游标是 OUT 绑定参数（`open :1 for …`），纯 Rust 驱动没有 OUT 绑定" },
            },
      ),
    );
    const tabId = openSqlTab("c1", "begin open :1 for select 1 from dual; end;");
    await execOne(tabId, "begin open :1 for select 1 from dual; end;", 1);
    const tab = sqlTabOf(tabId);
    const lines = tab ? tab.output.map((l: { text: string }) => l.text) : [];
    expect(lines.some((t: string) => t.includes("JVM 桥") && t.includes("不受本连接"))).toBe(true);
  });
});
