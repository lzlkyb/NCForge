// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./tauri", () => ({ invoke: mocks.invoke }));

import { __resetDbForTest, closeTab, connect, disconnect, ensureSlot, execOne, getDb, loadMeta, openSqlTab, patchTab, sqlTabOf, summaryOf, type ResultEntry, type SqlTab } from "./dbStore";

describe("首次查询优先", () => {
  beforeEach(()=>{__resetDbForTest();mocks.invoke.mockReset();});
  it("后端并行准备好的槽直接复用，首查不再次申请会话",async()=>{
    mocks.invoke.mockImplementation(()=>Promise.resolve({autoCommit:false,schema:"TARGET",preparedSlot:"ready",tables:[],names:{},schemas:[],current:"TARGET"}));
    const tab=openSqlTab("c1");await connect("c1");
    expect(await ensureSlot(tab,"c1")).toBe("ready");
    expect(getDb().rt.c1.currentSchema).toBe("TARGET");
    expect(mocks.invoke.mock.calls.find(([cmd])=>cmd==="db_connect")?.[1]).toMatchObject({prepareSql:true});
    expect(mocks.invoke.mock.calls.some(([cmd])=>cmd==="db_slot_acquire")).toBe(false);
    await new Promise(resolve=>setTimeout(resolve,0));
  });
  it("并行建连期间关闭标签会释放返回的槽",async()=>{
    let release!: (value:unknown)=>void;
    mocks.invoke.mockImplementation((cmd:string)=>cmd==="db_connect" ? new Promise(resolve=>{release=resolve;}) : Promise.resolve({tables:[],names:{},schemas:[],current:"NC"}));
    const tab=openSqlTab("c1");const connecting=connect("c1");
    await new Promise(resolve=>setTimeout(resolve,0));closeTab(tab);
    release({autoCommit:false,preparedSlot:"unused"});await connecting;
    expect(mocks.invoke.mock.calls.find(([cmd])=>cmd==="db_slot_release")?.[1]).toMatchObject({slot:"unused"});
    await new Promise(resolve=>setTimeout(resolve,0));
  });
  it("同一连接的并发元数据加载合并为一轮",async()=>{
    mocks.invoke.mockImplementation(()=>Promise.resolve({tables:[],names:{},schemas:[],current:"NC"}));
    await Promise.all([loadMeta("c1"),loadMeta("c1"),loadMeta("c1")]);
    expect(mocks.invoke.mock.calls.filter(([cmd,args])=>cmd==="db_meta" && args.kind==="tables")).toHaveLength(1);
  });
  it("断开后迟到的元数据不能恢复旧表清单或留下加载状态",async()=>{
    let release!: (value:unknown)=>void;
    const tables=new Promise(resolve=>{release=resolve;});
    mocks.invoke.mockImplementation((cmd:string,args:{kind?:string})=>cmd==="db_meta" && args.kind==="tables" ? tables : Promise.resolve({names:{},schemas:[],current:"NC"}));
    const loading=loadMeta("c1");await disconnect("c1");
    release({tables:[{name:"STALE",kind:"TABLE"}]});await loading;
    expect(getDb().rt.c1.status).toBe("idle");
    expect(getDb().rt.c1.tablesLoading).toBe(false);
    expect((getDb().rt.c1.tables ?? []).some(t=>t.name==="STALE")).toBe(false);
  });
  it("连接后先准备当前 SQL 会话，执行与预热共享申请，元数据不抢先", async()=>{
    let release!: (value:{slot:string})=>void;
    const slot=new Promise<{slot:string}>(resolve=>{release=resolve;});
    mocks.invoke.mockImplementation((cmd:string)=>cmd==="db_slot_acquire" ? slot : Promise.resolve({autoCommit:false,tables:[],names:{},schemas:[],current:"NC"}));
    const tab=openSqlTab("c1");
    await connect("c1");
    const executionSlot=ensureSlot(tab,"c1");
    expect(mocks.invoke.mock.calls.filter(([cmd])=>cmd==="db_slot_acquire")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.some(([cmd])=>cmd==="db_meta")).toBe(false);
    release({slot:"warm"});
    expect(await executionSlot).toBe("warm");
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(mocks.invoke.mock.calls.some(([cmd])=>cmd==="db_meta")).toBe(true);
  });
  it("中文名尚未返回时，表清单已经可见",async()=>{
    let release!: (value:{names:Record<string,string>})=>void;
    const names=new Promise<{names:Record<string,string>}>(resolve=>{release=resolve;});
    mocks.invoke.mockImplementation((cmd:string,args:{kind?:string})=>cmd==="db_meta" && args.kind==="ncNames" ? names : Promise.resolve({tables:[{name:"T",kind:"TABLE"}],schemas:[],current:"NC"}));
    const loading=loadMeta("c1");
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(getDb().rt.c1.tables?.[0].name).toBe("T");
    expect(getDb().rt.c1.tablesLoading).toBe(false);
    release({names:{t:"测试"}});await loading;
  });
});

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
    const exec = mocks.invoke.mock.calls.find((c) => c[0] === "db_exec_result");
    expect(exec?.[1]).toMatchObject({ id: "c1", slot: "2", collectStats: false });
    expect(mocks.invoke.mock.calls.filter((c) => c[0] === "db_slot_acquire")).toHaveLength(1);
  });

  it("只有明确请求诊断的执行才采集统计", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "db_slot_acquire" ? { slot: "2" } : rowsBody),
    );
    const tabId = openSqlTab("c1", "select 1 from dual");
    await execOne(tabId, "select 1 from dual", 1, undefined, true);
    expect(mocks.invoke.mock.calls.find((c) => c[0] === "db_exec_result")?.[1]).toMatchObject({ collectStats: true });
  });

  it("申请不到槽时退回 primary，执行不失败", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "db_slot_acquire") return Promise.reject("slots-full|最多 3 个独立会话");
      return Promise.resolve(rowsBody);
    });
    const tabId = openSqlTab("c1", "select 1 from dual");
    const e = await execOne(tabId, "select 1 from dual", 1);
    expect(e.kind).toBe("rows");
    const exec = mocks.invoke.mock.calls.find((c) => c[0] === "db_exec_result");
    expect(exec?.[1]).toMatchObject({ slot: null });
  });

  it("槽被空闲回收（slot-gone）后自动重开再试一次", async () => {
    // 槽空闲 10 分钟就被后端收掉，而标签上的槽名还在。这时报错让用户「再点一次运行」
    // 是最差的做法——他自己并不知道发生了什么。这里必须自动换新槽重跑。
    let acquired = 0;
    let execs = 0;
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "db_slot_acquire") return Promise.resolve({ slot: String(++acquired) });
      if (cmd === "db_exec_result") {
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
    const execCalls = mocks.invoke.mock.calls.filter((c) => c[0] === "db_exec_result");
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

/**
 * 闲置过久再查询：会话被服务端收掉之后必须能自己恢复。
 *
 * 现场症状是「第一次报 unable to recover from error，之后每次 9ms 报 not connected
 * to database」，而连接状态一直是 connected —— 于是每次点执行都直接发、每次都失败，
 * 只能手动断开重连。两条断言分别守着「后端自动重连」与「状态置错让下次真重连」。
 */
describe("闲置超时后的连接恢复", () => {
  beforeEach(() => { mocks.invoke.mockReset(); __resetDbForTest(); });

  const body = {
    kind: "rows",
    columns: [{ name: "A", type: "NUMBER", precision: 10, scale: 0 }],
    rows: [["1"]],
    rowCount: 1,
    hasMore: false,
    ms: 4,
    output: [],
    tx: { autoCommit: true, statements: 0, rows: 0, since: 0 },
  };

  it("撞上会话丢失时把连接置回 error，下一次执行才会真正走重连", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "db_slot_acquire") return Promise.resolve({ slot: "1" });
      if (cmd === "db_exec_result") {
        return Promise.reject("session-lost|数据库会话已断开，本次操作尚未发出。这条会话可能有未提交事务，请先核对再手动重连");
      }
      return Promise.resolve(body);
    });
    const tabId = openSqlTab("c1", "update t set x = 1");
    const e = await execOne(tabId, "update t set x = 1", 1);
    expect(e.kind).toBe("error");
    // 停在 connected 的话 `ensureConnected` 下次仍然直接发，用户连点几次都是同一句失败。
    expect(getDb().rt.c1?.status).toBe("error");
    expect(getDb().rt.c1?.error).toContain("会话已断开");
  });

  it("后端自动重连后照常展示结果，并提示会话设置已重置", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "db_slot_acquire" ? { slot: "1" } : { ...body, reconnected: true }),
    );
    const tabId = openSqlTab("c1", "select 1 from dual");
    const e = await execOne(tabId, "select 1 from dual", 1);
    expect(e.kind).toBe("rows");
    expect(e.rows).toHaveLength(1);
    expect(getDb().rt.c1?.status).not.toBe("error");
    const lines = sqlTabOf(tabId)?.output.map((l) => l.text) ?? [];
    expect(lines.some((t) => t.includes("已自动重连"))).toBe(true);
  });

  // 启动脚本失败不该让语句判失败（连接是好的），但必须写进输出区：
  // 脚本里的 alter session 没生效，同一句 SQL 的结果可能和预期不一样。
  it("启动脚本失败时写一行警告，语句本身照常出结果", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "db_slot_acquire"
          ? { slot: "1" }
          : { ...body, initError: "ORA-00911: invalid character（语句：alter session set x=1）" },
      ),
    );
    const tabId = openSqlTab("c1", "select 1 from dual");
    const e = await execOne(tabId, "select 1 from dual", 1);
    expect(e.kind).toBe("rows");
    expect(getDb().rt.c1?.status).not.toBe("error");
    const lines = sqlTabOf(tabId)?.output.map((l) => l.text) ?? [];
    expect(lines.some((t) => t.includes("启动脚本执行失败") && t.includes("ORA-00911"))).toBe(true);
  });

  // 元数据取数现在也会「闲置 → 探测 → 重连」。重连要口令时如果只把清单留空，
  // 界面看不到任何要操作的入口，用户只能猜；置回 error 才会出现重连/输口令。
  it("元数据撞上「要口令」时把连接置回 error，而不是只留一份空清单", async () => {
    mocks.invoke.mockImplementation(() => Promise.reject("need-password|这个连接还没存口令"));
    await loadMeta("c1");
    expect(getDb().rt.c1?.status).toBe("error");
    expect(getDb().rt.c1?.error).toContain("口令");
  });

  // 反过来：ORA-00942 是表名或权限的问题，连接是好的，不能把人弹去重连。
  it("表结构查不到但连接还活着时不动连接状态", async () => {
    mocks.invoke.mockImplementation(() =>
      Promise.reject("sql|ORA-00942: table or view does not exist"),
    );
    await loadMeta("c1");
    expect(getDb().rt.c1?.status).not.toBe("error");
  });
});
