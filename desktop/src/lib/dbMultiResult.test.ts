// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke }));
vi.mock("./sqlModels", () => ({ disposeSqlModel: vi.fn() }));
vi.mock("./dbConfirm", () => ({ ensureConnected: vi.fn(async () => true), confirmProdWrite: vi.fn(async () => true) }));
import { dbApi, type DbConn } from "./dbApi";
import { runStatements } from "./dbActions";
import { __resetDbForTest, closeTab, execOne, loadMore, openSqlTab, ownsCursor, patchTab, setConns, sqlTabOf, type SqlTab } from "./dbStore";
import { clearCompletedOperations } from "./operations";
import { pendingResultId, resultPairOf } from "./dbResultLayout";

const rowResult = (value: number, hasMore = true) => ({ kind: "rows", columns: [{ name: "VALUE", type: "NUMBER", precision: 10, scale: 0 }], rows: [[value]], hasMore, ms: 1, output: [], tx: { autoCommit: true, statements: 0, rows: 0, since: 0 } });
const statements = [1, 2, 3].map(index => ({ text: `select ${index} from dual`, startLine: index }));
beforeEach(() => {
  __resetDbForTest(); clearCompletedOperations(); mocks.invoke.mockReset();
  setConns([{ id: "c", name: "测试", env: "test", source: "manual", url: "jdbc:test", user: "NC", engine: "java", propDs: null } as DbConn]);
  mocks.invoke.mockImplementation(async (command, args) => command === "db_slot_acquire" ? { slot: "1" } : command === "db_exec_result" ? rowResult(Number(/select (\d)/.exec(args.sql)?.[1])) : undefined);
});

it("后续结果完成不切走用户查看的页，仍按同一会话顺序执行", async () => {
  const id = openSqlTab("c");
  let resolveSecond!: (result: unknown) => void;
  let secondStarted!: () => void;
  const ready = new Promise<void>(resolve => { secondStarted = resolve; });
  const second = new Promise(resolve => { resolveSecond = resolve; });
  const initial = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "db_exec_result" && args.sql === statements[1].text ? (secondStarted(), second) : initial(command, args));
  const run = runStatements(id, statements);
  await ready;
  const firstId = sqlTabOf(id)!.results[0].id;
  expect(sqlTabOf(id)!.view).toBe(firstId);
  patchTab<SqlTab>(id, { view: "output" });
  resolveSecond(rowResult(2)); await run;
  expect(sqlTabOf(id)!.results.map(r => r.rows[0][0])).toEqual([1, 2, 3]);
  expect(sqlTabOf(id)!.view).toBe("output");
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "db_exec_result").map(([, args]) => args.slot)).toEqual(["1", "1", "1"]);
});

it("两份结果交错续取携带独立 resultId，行不混在一起", async () => {
  const id = openSqlTab("c"); await runStatements(id, statements.slice(0, 2));
  const [first, second] = sqlTabOf(id)!.results;
  expect(ownsCursor("c", "1", first.id)).toBe(true); expect(ownsCursor("c", "1", second.id)).toBe(true);
  mocks.invoke.mockImplementation(async (command, args) => command === "db_more_result" ? { rows: [[args.resultId === first.id ? 11 : 22]], hasMore: args.resultId === first.id } : undefined);
  await loadMore(id, first.id); await loadMore(id, second.id); await loadMore(id, first.id);
  expect(sqlTabOf(id)!.results.map(r => r.rows)).toEqual([[[1], [11], [11]], [[2], [22]]]);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "db_more_result").map(([, args]) => args.resultId)).toEqual([first.id, second.id, first.id]);
  expect(ownsCursor("c", "1", second.id)).toBe(false);
});

it("第二条失败保留成功结果与焦点，后续语句标为未执行", async () => {
  const id = openSqlTab("c");
  const initial = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "db_exec_result" && args.sql === statements[1].text ? Promise.reject("sql|ORA-00942") : initial(command, args));
  const outcome = await runStatements(id, statements);
  const tab = sqlTabOf(id)!;
  expect(outcome.done).toBe(2); expect(tab.results.map(r => r.kind)).toEqual(["rows", "error"]);
  expect(tab.view).toBe(tab.results[0].id); expect(tab.batch?.status).toBe("failed");
  expect(tab.batch?.completed).toBe(2); expect(ownsCursor("c", "1", tab.results[0].id)).toBe(true);
});

it("释放、重跑和关闭标签分别关闭所属结果游标", async () => {
  const id = openSqlTab("c"); await runStatements(id, statements.slice(0, 2));
  const [first, second] = sqlTabOf(id)!.results;
  patchTab<SqlTab>(id, { results: [second] });
  expect(ownsCursor("c", "1", first.id)).toBe(false);
  await runStatements(id, statements.slice(0, 1));
  expect(ownsCursor("c", "1", second.id)).toBe(false);
  const last = sqlTabOf(id)!.results[0]; closeTab(id);
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "db_result_close").map(([, args]) => args.resultId)).toEqual(expect.arrayContaining([first.id, second.id, last.id])));
});

it("查询等待期间关闭标签会释放新游标，旧响应不会重新创建结果", async () => {
  const id = openSqlTab("c"); let resolve!: (value: unknown) => void;
  const ready = new Promise<void>(started => mocks.invoke.mockImplementation((command) => command === "db_slot_acquire" ? Promise.resolve({ slot: "1" }) : command === "db_exec_result" ? (started(), new Promise(r => { resolve = r; })) : Promise.resolve()));
  const query = execOne(id, statements[0].text, 1); await ready; closeTab(id); resolve(rowResult(1)); await query;
  expect(sqlTabOf(id)).toBeNull(); expect(mocks.invoke.mock.calls.filter(([command]) => command === "db_result_close")).toHaveLength(2);
});

it("选中的等待结果完成后在原位替换，双栏可选择任意两份结果", () => {
  expect(pendingResultId(7, 2)).toBe("pending:7:2");
  expect(resultPairOf(["r1", "r2", "r3"], ["r3", "r1"])).toEqual(["r3", "r1"]);
  expect(resultPairOf(["r1", "r2", "r3"], ["gone", "r3"], "r2")).toEqual(["r2", "r3"]);
});

it("JVM 回退结果续取明确指向实际执行引擎", async () => {
  await dbApi.moreResult("c", 100, "1", "r-fallback", true);
  expect(mocks.invoke).toHaveBeenCalledWith("db_more_result", { id: "c", maxRows: 100, slot: "1", resultId: "r-fallback", fallback: true });
});
