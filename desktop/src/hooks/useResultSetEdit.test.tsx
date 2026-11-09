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
  latest = useResultSetEdit({ tabId: "s1", connId: "c", sql, columns, rows, onApplied: () => {} });
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
