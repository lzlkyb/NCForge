// @vitest-environment jsdom
/**
 * SQL 控制台结果页「双击改数据」的判定链。
 *
 * 这条链路里所有失败都是**静默**的：判定不成立就没有 `edit`，双击退回「打开详情」，
 * 用户看到的就是「双击没反应」。所以每个拒绝理由都必须能说清，并且有测试守着——
 * 0.2.0 之前 `select * from aier633.bd_material` 因为把整串当表名查不到主键，
 * 就被判成「没有主键」，界面上只写「只读」两个字。
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../lib/tauri", () => ({ invoke: mocks.invoke }));

import { useResultSetEdit } from "./useResultSetEdit";
import { __resetDbForTest, connect, setConns } from "../lib/dbStore";
import type { Cell, ColumnMeta } from "../lib/dbApi";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const columns: ColumnMeta[] = [
  { name: "ID", type: "NUMBER", precision: 10, scale: 0 },
  { name: "CODE", type: "VARCHAR2(40)", precision: 40, scale: 0 },
];
const rows: Cell[][] = [[1, "a"]];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let latest: ReturnType<typeof useResultSetEdit>;
let tableArg: string | null = null;

function Probe({ sql }: { sql: string }) {
  latest = useResultSetEdit({ tabId: "s1", connId: "c", sql, columns, rows });
  return null;
}

/** 让 hook 里的两个异步（只读状态 + 表结构）落地。 */
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(async () => {
  localStorage.clear();
  mocks.invoke.mockReset();
  __resetDbForTest();
  tableArg = null;
  mocks.invoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (cmd === "db_connect") return Promise.resolve({ url: "jdbc:oracle:thin:@h:1521/t", user: "u", autoCommit: false });
    if (cmd === "db_read_only") return Promise.resolve({ readOnly: false, tx: { autoCommit: false, statements: 0, rows: 0, since: 0 } });
    if (cmd === "db_meta" && args.kind === "columns") {
      tableArg = String(args.arg);
      return Promise.resolve({ columns: columns.map((c, i) => ({ ...c, pk: i === 0, size: 0, full: c.type, nullable: true, default: null, comment: null, zh: null })) });
    }
    return Promise.resolve(null);
  });
  setConns([{ id: "c", name: "Test", env: "test", source: "manual", url: "jdbc:oracle:thin:@h:1521/t", user: "u", propDs: null, autoCommit: false, note: "", hasPassword: false, engine: "rust" }]);
  await connect("c");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); });

it("单表 SELECT 且有主键时可改，主键列本身仍锁住", async () => {
  await act(async () => root.render(<Probe sql="select * from bd_material" />));
  await flush();
  expect(latest.blocked).toBe("");
  expect(latest.edit).toBeTruthy();
  expect(latest.edit!.canEdit(1, 0)).toBe(true);
  expect(latest.edit!.canEdit(0, 0)).toBe(false);
});

it("带 schema 的表名原样交给后端拆分，不在前端丢掉 owner", async () => {
  await act(async () => root.render(<Probe sql="select * from aier633.bd_material" />));
  await flush();
  expect(tableArg).toBe("aier633.bd_material");
  expect(latest.edit).toBeTruthy();
});

it("表没有主键时只读，并说清是「没有主键」而不是「读不到表」", async () => {
  mocks.invoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (cmd === "db_connect") return Promise.resolve({ url: "jdbc:oracle:thin:@h:1521/t", user: "u", autoCommit: false });
    if (cmd === "db_read_only") return Promise.resolve({ readOnly: false, tx: { autoCommit: false, statements: 0, rows: 0, since: 0 } });
    if (cmd === "db_meta" && args.kind === "columns") {
      return Promise.resolve({ columns: columns.map(c => ({ ...c, pk: false, size: 0, full: c.type, nullable: true, default: null, comment: null, zh: null })) });
    }
    return Promise.resolve(null);
  });
  await act(async () => root.render(<Probe sql="select * from t" />));
  await flush();
  expect(latest.edit).toBeUndefined();
  expect(latest.blocked).toContain("没有主键");
});

it("表结构读不到时明确报「读不到列信息」，不冒充「没有主键」", async () => {
  mocks.invoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (cmd === "db_connect") return Promise.resolve({ url: "jdbc:oracle:thin:@h:1521/t", user: "u", autoCommit: false });
    if (cmd === "db_read_only") return Promise.resolve({ readOnly: false, tx: { autoCommit: false, statements: 0, rows: 0, since: 0 } });
    if (cmd === "db_meta" && args.kind === "columns") return Promise.resolve({ columns: [] });
    return Promise.resolve(null);
  });
  await act(async () => root.render(<Probe sql="select * from t" />));
  await flush();
  expect(latest.edit).toBeUndefined();
  expect(latest.blocked).toContain("读不到表");
});

it("连接是只读模式时说「只读」，不让人以为双击坏了", async () => {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === "db_connect") return Promise.resolve({ url: "jdbc:oracle:thin:@h:1521/t", user: "u", autoCommit: false });
    if (cmd === "db_read_only") return Promise.resolve({ readOnly: true, tx: { autoCommit: false, statements: 0, rows: 0, since: 0 } });
    return Promise.resolve(null);
  });
  await act(async () => root.render(<Probe sql="select * from bd_material" />));
  await flush();
  expect(latest.edit).toBeUndefined();
  expect(latest.blocked).toContain("只读模式");
});

it("多表关联 / 聚合 / 子查询一律拒绝，并给出面向用户的原因", async () => {
  const cases: [string, string][] = [
    ["select a.* from t a join u b on a.id = b.id", "多表关联"],
    ["select count(*) from t", "聚合"],
    ["select * from (select * from t)", "子查询"],
    ["select distinct code from t", "去重"],
  ];
  for (const [sql, hint] of cases) {
    await act(async () => root.render(<Probe sql={sql} />));
    await flush();
    expect(latest.edit, sql).toBeUndefined();
    expect(latest.blocked, sql).toContain(hint);
  }
});

it("行级增删：草稿行用虚拟行号，主键列可填、可撤销、可标记待删", async () => {
  await act(async () => root.render(<Probe sql="select * from bd_material" />));
  await flush();
  // 调用用捕获的 edit；读状态要重新取 `latest.edit`——它是每次渲染的快照。
  const edit = latest.edit!;
  // rows.length = 1，所以第 1 个虚拟行号是 1。
  edit.onCloneRow!(0);
  await act(async () => {});
  expect(latest.rows.length).toBe(2);
  expect(latest.rows[1]).toEqual([null, "a"]);   // 主键留空，其余列照抄
  expect(latest.edit!.isDraftRow!(1)).toBe(true);
  expect(latest.edit!.rowState!(1)).toBe("added");
  // 草稿行的主键列要能填：新行的定位靠它。
  expect(latest.edit!.canEdit(0, 1)).toBe(true);
  edit.onEdit(1, 0, 9);
  await act(async () => {});
  expect(latest.rows[1][0]).toBe(9);
  // 撤销这行新增：草稿消失，回到只有真实行。
  edit.onRestoreRow!(1);
  await act(async () => {});
  expect(latest.rows.length).toBe(1);

  // 删除只做标记，行还在显示里；恢复则撤标记。
  edit.onDeleteRow!(0);
  await act(async () => {});
  expect(latest.edit!.rowState!(0)).toBe("deleted");
  expect(latest.rows.length).toBe(1);
  expect(latest.count).toBe(1);                   // 待删计入待写回条数
  edit.onRestoreRow!(0);
  await act(async () => {});
  expect(latest.edit!.rowState!(0)).toBeUndefined();
  expect(latest.count).toBe(0);
});

it("批量赋值与单格撤回都按虚拟行号分流：草稿行进草稿，真实行进 changed", async () => {
  await act(async () => root.render(<Probe sql="select * from bd_material" />));
  await flush();
  const edit = latest.edit!;
  edit.onCloneRow!(0);
  await act(async () => {});
  edit.onEditMany!([
    { row: 0, col: 1, value: "x" },     // 真实行 → changed
    { row: 1, col: 1, value: "y" },     // 草稿行 → drafts
  ]);
  await act(async () => {});
  expect(latest.edit!.changed.get("0:1")).toBe("x");
  expect(latest.rows[1][1]).toBe("y");
  // 撤回真实行走「删键」，草稿行走「置 NULL 等于没填」。
  edit.onResetCell!(0, 1);
  edit.onResetCell!(1, 1);
  await act(async () => {});
  expect(latest.edit!.changed.has("0:1")).toBe(false);
  expect(latest.rows[1][1]).toBe(null);
});

it("同一格连改两次：第二次的原值守卫用第一次写回后的值，不是初始快照", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  mocks.invoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (cmd === "db_connect") return Promise.resolve({ url: "jdbc:oracle:thin:@h:1521/t", user: "u", autoCommit: false });
    if (cmd === "db_read_only") return Promise.resolve({ readOnly: false, tx: { autoCommit: false, statements: 0, rows: 0, since: 0 } });
    if (cmd === "db_meta" && args.kind === "columns") {
      return Promise.resolve({ columns: columns.map((c, i) => ({ ...c, pk: i === 0, size: 0, full: c.type, nullable: true, default: null, comment: null, zh: null })) });
    }
    if (cmd === "db_exec_bound") {
      calls.push({ sql: String(args.sql), params: (args.params as unknown[]) ?? [] });
      return Promise.resolve({ kind: "update", updateCount: 1 });
    }
    return Promise.resolve(null);
  });
  await act(async () => root.render(<Probe sql="select * from bd_material" />));
  await flush();
  const save = async () => { await act(async () => { latest.save(); await new Promise(r => setTimeout(r, 0)); }); };

  // 第一次把 CODE 从 a 改成 b 并落库。
  latest.edit!.onEdit(0, 1, "b");
  await act(async () => {});
  await save();
  expect(latest.rows[0][1]).toBe("b");   // 写回成功的值就地覆盖显示行
  expect(latest.count).toBe(0);

  // 同一格再改成 c：原值守卫必须拿 b（库里现在的值），拿初始快照的 a 会 0 行命中。
  latest.edit!.onEdit(0, 1, "c");
  await act(async () => {});
  expect(latest.count).toBe(1);
  await save();
  expect(calls.length).toBe(2);
  expect(calls[1].params).toContain("b");
  expect(calls[1].params).toContain("c");
  expect(calls[1].params).not.toContain("a");
});
