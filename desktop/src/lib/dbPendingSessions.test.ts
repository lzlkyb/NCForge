// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { pendingDbSessions } from "./dbPendingSessions";
import { __resetDbForTest, activateTab, getDb, openDictTab, openSqlTab, openTableTab, patchTab, setTx, sqlTabOf, type SqlTab } from "./dbStore";
const tx = { autoCommit: false, statements: 2, rows: 3, since: 1 };
beforeEach(__resetDbForTest);
describe("待提交数据库会话", () => {
  it("多个primary标签和重复槽引用各只计一次，排除其他连接", () => {
    const primary = openSqlTab("c1");
    const first = openSqlTab("c1");
    const duplicate = openSqlTab("c1");
    const other = openSqlTab("c2");
    openSqlTab("c1");
    setTx("c1", tx);
    patchTab<SqlTab>(first, { slot: "1", tx });
    patchTab<SqlTab>(duplicate, { slot: "1", tx });
    patchTab<SqlTab>(other, { slot: "1", tx });
    activateTab(duplicate);
    expect(pendingDbSessions(getDb(), "c1")).toEqual([
      { slot: null, tabId: primary, label: "主会话", statements: 2 },
      { slot: "1", tabId: duplicate, label: `${sqlTabOf(duplicate)!.title} · 独立会话 1`, statements: 2 },
    ]);
  });
  it("主会话优先定位表页；没有对应文档时不误定位到独立槽或字典", () => {
    const sql = openSqlTab("c1");
    patchTab<SqlTab>(sql, { slot: "1", tx: { ...tx, statements: 0 } });
    openDictTab("c1");
    setTx("c1", tx);
    expect(pendingDbSessions(getDb(), "c1")[0].tabId).toBeNull();
    const table = openTableTab("c1", "BD_MATERIAL");
    expect(pendingDbSessions(getDb(), "c1")[0].tabId).toBe(table);
  });
  it("已自动提交、干净和没有槽的标签事务不增加会话数", () => {
    setTx("c1", { ...tx, autoCommit: true });
    const id = openSqlTab("c1");
    patchTab<SqlTab>(id, { tx });
    expect(pendingDbSessions(getDb(), "c1")).toEqual([]);
    patchTab<SqlTab>(id, { slot: "1", tx: { ...tx, autoCommit: true } });
    expect(pendingDbSessions(getDb(), "c1")).toEqual([]);
  });
});
