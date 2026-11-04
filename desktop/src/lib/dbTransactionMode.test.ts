// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), ask: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke }));
vi.mock("./dbConfirm", () => ({ ask: mocks.ask }));
import { setSqlTransactionMode } from "./dbTransactionMode";
import { __resetDbForTest, connect, openSqlTab, patchTab, sqlTabOf, type SqlTab } from "./dbStore";

const clean = { autoCommit: true, statements: 0, rows: 0, since: 0 };
const pending = { autoCommit: false, statements: 2, rows: 4, since: 1 };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
async function setup(slot: string | null = "1") {
  await connect("c1");
  const id = openSqlTab("c1");
  patchTab<SqlTab>(id, { slot, tx: pending });
  mocks.invoke.mockClear();
  return id;
}
beforeEach(() => {
  __resetDbForTest();
  mocks.ask.mockReset().mockResolvedValue(true);
  mocks.invoke.mockReset().mockImplementation((cmd: string) => Promise.resolve(
    cmd === "db_connect" ? { autoCommit: false } : cmd === "db_slot_acquire" ? { slot: "2" } : cmd === "db_tx" ? { tx: clean } : {},
  ));
});
describe("SQL事务模式的确认与会话身份", () => {
  it("取消确认既不申请新槽，也不发送自动提交命令", async () => {
    const id = await setup();
    mocks.ask.mockResolvedValue(false);
    await setSqlTransactionMode(id, "c1", true);
    expect(mocks.ask).toHaveBeenCalledWith("切换到自动提交？", expect.stringContaining("无法再通过回滚撤销"), "切换到自动提交", true);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(sqlTabOf(id)?.tx).toEqual(pending);
  });
  it("确认完成后仅切换原独立槽并写回该标签", async () => {
    const id = await setup();
    const decision = deferred<boolean>();
    mocks.ask.mockReturnValue(decision.promise);
    const task = setSqlTransactionMode(id, "c1", true);
    expect(mocks.invoke).not.toHaveBeenCalled();
    decision.resolve(true);
    await task;
    expect(mocks.invoke).toHaveBeenCalledWith("db_tx", { id: "c1", action: "autocommit-on", slot: "1" });
    expect(sqlTabOf(id)?.tx).toEqual(clean);
  });
  it.each(["tab", "conn"])("确认期间切换%s后停止旧操作", async (change) => {
    const id = await setup();
    const decision = deferred<boolean>();
    mocks.ask.mockReturnValue(decision.promise);
    const task = setSqlTransactionMode(id, "c1", true);
    if (change === "tab") openSqlTab("c1");
    else patchTab<SqlTab>(id, { connId: "c2", slot: null, tx: undefined });
    decision.resolve(true);
    await task;
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("申请独立槽期间离开标签，不发送事务模式命令", async () => {
    const id = await setup(null);
    const acquired = deferred<{ slot: string }>();
    mocks.invoke.mockImplementation((cmd: string) => cmd === "db_slot_acquire" ? acquired.promise : Promise.resolve({}));
    const task = setSqlTransactionMode(id, "c1", true);
    openSqlTab("c1");
    acquired.resolve({ slot: "2" });
    await task;
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "db_tx")).toBe(false);
    expect(sqlTabOf(id)?.slot).toBe("2");
  });
  it("事务返回期间更换连接，不将旧事务写进新连接标签", async () => {
    const id = await setup();
    const answer = deferred<{ tx: typeof clean }>();
    mocks.invoke.mockImplementation((cmd: string) => cmd === "db_tx" ? answer.promise : Promise.resolve({}));
    patchTab<SqlTab>(id, { tx: clean });
    const switching = setSqlTransactionMode(id, "c1", false);
    await Promise.resolve();
    patchTab<SqlTab>(id, { connId: "c2", slot: null, tx: undefined });
    answer.resolve({ tx: { ...clean, autoCommit: false } });
    await switching;
    expect(sqlTabOf(id)?.tx).toBeUndefined();
  });
});
