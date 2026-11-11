import { expect, it } from "vitest";
import { txControlOf } from "./sqlTxControl";

it("认手写的 COMMIT / ROLLBACK（大小写、分号、前导注释都算）", () => {
  expect(txControlOf("commit")).toBe("commit");
  expect(txControlOf("COMMIT WORK;")).toBe("commit");
  expect(txControlOf("  -- 收尾\n  Commit;")).toBe("commit");
  expect(txControlOf("/* 事务 */ rollback")).toBe("rollback");
  expect(txControlOf("rollback work")).toBe("rollback");
});

it("rollback to savepoint 只回到保存点，事务还在", () => {
  expect(txControlOf("rollback to savepoint sp1")).toBeNull();
  expect(txControlOf("ROLLBACK TO SAVEPOINT \"SP1\"")).toBeNull();
});

it("Oracle 的 DDL / DCL 隐式提交也算事务结束（但不是「用户刚提交」）", () => {
  expect(txControlOf("create table t (id number)")).toBe("implicit");
  expect(txControlOf("alter table t add c number")).toBe("implicit");
  expect(txControlOf("truncate table t")).toBe("implicit");
  expect(txControlOf("comment on table t is 'x'")).toBe("implicit");
  expect(txControlOf("grant select on t to u")).toBe("implicit");
});

it("普通 DML / 查询 / 保存点不动事务", () => {
  for (const sql of [
    "update t set c = 1", "insert into t values (1)", "delete from t",
    "select * from t", "savepoint sp1", "begin update t set c = 1; end;",
    "set transaction read only", "",
  ]) expect(txControlOf(sql)).toBeNull();
});
