import { describe, expect, it } from "vitest";
import { txPending } from "./txState";
import type { TxInfo } from "./dbApi";

const tx = (over: Partial<TxInfo> = {}): TxInfo => ({
  autoCommit: false, statements: 0, rows: 0, since: 0, ...over,
});

describe("事务真源裁决", () => {
  it("还没核对时按本地 DML 计数", () => {
    expect(txPending(undefined)).toEqual({ pending: false, dbConfirmed: null });
    expect(txPending(tx()).pending).toBe(false);
    expect(txPending(tx({ statements: 3 })).pending).toBe(true);
    expect(txPending(tx({ statements: 3, autoCommit: true })).pending).toBe(false);
  });

  it("字典不可读（null）退回本地推断，不误判成没有事务", () => {
    expect(txPending(tx({ active: null, statements: 2 }))).toEqual({ pending: true, dbConfirmed: null });
    expect(txPending(tx({ active: null })).pending).toBe(false);
  });

  it("数据库说没有事务：本地脏计数一票否决不了", () => {
    expect(txPending(tx({ active: false, statements: 9 }))).toEqual({ pending: false, dbConfirmed: false });
  });

  it("数据库说有事务：本地计数为 0 也要认", () => {
    expect(txPending(tx({ active: true, statements: 0 }))).toEqual({ pending: true, dbConfirmed: true });
  });

  it("自动提交模式下真源仍优先（只读会话也可能被别处开了事务）", () => {
    expect(txPending(tx({ active: true, autoCommit: true })).pending).toBe(true);
    expect(txPending(tx({ active: false, autoCommit: false, statements: 1 })).pending).toBe(false);
  });
});
