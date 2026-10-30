import { beforeEach, describe, expect, it } from "vitest";
import { mergePending } from "./quitGuard";
import { __resetDbForTest, setConns, setTx } from "./dbStore";
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
