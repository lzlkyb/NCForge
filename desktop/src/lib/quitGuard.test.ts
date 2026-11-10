import { beforeEach, describe, expect, it } from "vitest";
import { backendCleanRows, mergePending } from "./quitGuard";
import { __resetDbForTest, openSqlTab, patchTab, setConns, setTx } from "./dbStore";
import type { DbConn } from "./dbApi";

/**
 * 退出前的事务清单合并逻辑。
 *
 * 这块只测纯函数：后端数据由参数传入，界面数据从 dbStore 读（测试里用 `setConns`
 * / `setTx` 摆好）。真正的退出链路（弹框、提交、放行）在 Rust 侧，见
 * `src-tauri/src/commands/quit_cmds.rs` 的单测与手工验收清单。
 */

const conn = (id: string, name = id): DbConn => ({
  id,
  name,
  env: "test",
  source: "manual",
  url: "jdbc:oracle:thin:@10.0.0.1:1521/orcl",
  user: "u",
  propDs: null,
  autoCommit: false,
  note: "",
  hasPassword: true,
  engine: "java",
});

describe("退出前的未提交事务清单", () => {
  beforeEach(() => __resetDbForTest());

  it("后端说有事务：带上连接名与环境", () => {
    setConns([conn("c1", "测试库")]);
    const rows = mergePending([
      { id: "c1", state: "pending", statements: 2, rows: 10, since: 1_700_000_000_000 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connId: "c1",
      name: "测试库",
      env: "test",
      kind: "pending",
      statements: 2,
      rows: 10,
    });
  });

  it("界面知道但后端还没回传的也算（后一条语句可能刚落）", () => {
    setConns([conn("c1", "测试库")]);
    setTx("c1", { autoCommit: false, statements: 1, rows: 3, since: 1_700_000_000_000 });
    const rows = mergePending([{ id: "c1", state: "clean" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "pending", statements: 1, rows: 3 });
  });

  it("后端真源确认没有事务时，界面的脏计数不能把人拦住", () => {
    setConns([conn("c1", "测试库")]);
    // 手写 COMMIT / PL/SQL 内部提交都不会让本地 statements 归零；只要数据库
    // 用 v$transaction 确认过没有未提交事务（active:false），就不该再拦。
    setTx("c1", { autoCommit: false, statements: 3, rows: 9, since: 1_700_000_000_000 });
    const rows = mergePending([{ id: "c1", state: "clean", active: false }]);
    expect(rows).toHaveLength(0);
  });

  it("两边都有取大的（更保守）", () => {
    setConns([conn("c1")]);
    setTx("c1", { autoCommit: false, statements: 1, rows: 100, since: 1_700_000_000_000 });
    const rows = mergePending([
      { id: "c1", state: "pending", statements: 3, rows: 5, since: 1_700_000_500_000 },
    ]);
    expect(rows[0].statements).toBe(3);
    expect(rows[0].rows).toBe(100);
    // 开始时间取早的：显示的持续时长更长，不会低估
    expect(rows[0].since).toBe(1_700_000_000_000);
  });

  it("探测超时保持 unknown，不被界面的旧数据洗白", () => {
    setConns([conn("c1")]);
    setTx("c1", { autoCommit: false, statements: 5, rows: 50, since: 1 });
    const rows = mergePending([{ id: "c1", state: "unknown", message: "探测超时" }]);
    expect(rows[0].kind).toBe("unknown");
    expect(rows[0].message).toBe("探测超时");
  });

  it("探测超时但两边都没有写入证据时不算事务（只跑过 SELECT）", () => {
    setConns([conn("c1")]);
    const rows = mergePending([
      { id: "c1", state: "unknown", reason: "timeout", statements: 0 },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("探测超时且界面还有写入证据时保留，原因一起带上", () => {
    setConns([conn("c1", "测试库")]);
    setTx("c1", { autoCommit: false, statements: 2, rows: 8, since: 1 });
    const rows = mergePending([
      { id: "c1", state: "unknown", reason: "timeout", statements: 0 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "unknown", reason: "timeout", name: "测试库" });
  });

  it("标签里还有执行中的语句时不按超时降级（写入可能正在路上）", () => {
    setConns([conn("c1")]);
    const tabId = openSqlTab("c1", "update t set x = 1");
    patchTab(tabId, { run: { id: 1, connId: "c1", at: 0, slot: null, kind: "execute" } });
    const rows = mergePending([
      { id: "c1", state: "unknown", reason: "timeout", statements: 0 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("unknown");
  });

  it("会话已断且写计数为 0：界面上的旧计数不能再把它拉回来", () => {
    setConns([conn("c1", "测试库")]);
    // 后端探测时连接已断，但本会话 statements=0 —— 只跑过 SELECT。
    // 界面 rt.tx 还留着几小时前的写入计数（切标签/重连都不会清），不能当证据。
    setTx("c1", { autoCommit: false, statements: 4, rows: 40, since: 1 });
    const raw = [
      { id: "c1", state: "clean" as const, reason: "disconnected" as const, statements: 0 },
    ];
    expect(mergePending(raw)).toHaveLength(0);
    expect(backendCleanRows(raw).has("c1")).toBe(true);
  });

  it("断连但有写语句：保持 unknown，原因与计数都留着", () => {
    setConns([conn("c1", "测试库")]);
    const rows = mergePending([
      {
        id: "c1",
        state: "unknown",
        reason: "disconnected",
        message: "连接已断开",
        statements: 3,
        rows: 12,
      },
    ]);
    expect(rows[0]).toMatchObject({
      kind: "unknown",
      reason: "disconnected",
      message: "连接已断开",
      statements: 3,
      rows: 12,
    });
  });

  it("只有活连接的事务才算 backend 确认干净", () => {
    expect(
      backendCleanRows([
        { id: "a", state: "clean", active: false },
        { id: "b", state: "clean", reason: "unreachable" },
        { id: "c", state: "clean" }, // 没去查真源，界面新语句还要算进来
        { id: "d", state: "pending" },
      ]),
    ).toEqual(new Set(["a", "b"]));
  });

  it("自动提交/没有事务的连接不进清单", () => {
    setConns([conn("c1"), conn("c2")]);
    setTx("c2", { autoCommit: true, statements: 9, rows: 90, since: 1 });
    const rows = mergePending([
      { id: "c1", state: "clean" },
      { id: "c2", state: "clean" },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("连接已从配置里删掉时用 id 兜底，不丢提醒", () => {
    const rows = mergePending([{ id: "gone", state: "pending", statements: 1, rows: 1 }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("gone");
    expect(rows[0].env).toBe("other");
  });
});
