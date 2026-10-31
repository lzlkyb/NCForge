// @vitest-environment jsdom
/**
 * 片段库的存储与作用域。
 *
 * 三个必须锁住的行为：**作用域别串**（本连接的片段不能在别的库上冒出来）、
 * **快照引用别变**（`useSyncExternalStore` 拿到新数组就无限重渲染，界面会直接卡死）、
 * **坏数据别炸**（localStorage 里可能是上一个版本写的、或者被手改烂的 JSON）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 每次拿一份干净的模块（模块内有 localStorage 缓存，测试之间不清会互相污染）。 */
async function fresh() {
  vi.resetModules();
  return import("./dbSnippets");
}

beforeEach(() => {
  localStorage.clear();
});

describe("dbSnippets", () => {
  it("存一条并读回来，名字留空时用 SQL 第一行兜底", async () => {
    const m = await fresh();
    m.addSnippet({ name: "  ", sql: "-- 查锁\nselect * from v$lock", connId: "c1" });
    const list = m.listSnippets("c1");
    expect(list).toHaveLength(1);
    // 行注释符要去掉，否则列表里每条都以 "--" 开头
    expect(list[0].name).toBe("查锁");
    expect(list[0].connId).toBe("c1");
  });

  it("作用域：专属片段在前、全局在后，且不在别的连接里出现", async () => {
    const m = await fresh();
    m.addSnippet({ name: "通用", sql: "select 1 from dual", connId: null });
    m.addSnippet({ name: "本库", sql: "select * from t_a", connId: "c1" });
    expect(m.listSnippets("c1").map((s) => s.name)).toEqual(["本库", "通用"]);
    // 另一个连接只看得到全局那条
    expect(m.listSnippets("c2").map((s) => s.name)).toEqual(["通用"]);
  });

  it("改名字 / 改作用域 / 删掉", async () => {
    const m = await fresh();
    const s = m.addSnippet({ name: "旧名", sql: "select 1 from dual", connId: "c1" });
    m.updateSnippet(s.id, { name: "新名", connId: null });
    expect(m.listSnippets("c1")[0].name).toBe("新名");
    expect(m.listSnippets("c1")[0].connId).toBeNull();
    m.removeSnippet(s.id);
    expect(m.listSnippets("c1")).toEqual([]);
  });

  it("搜索：名字或内容命中都算，多关键词要求全中", async () => {
    const m = await fresh();
    m.addSnippet({ name: "看锁", sql: "select * from v$lock where type = 'TM'", connId: null });
    m.addSnippet({ name: "看会话", sql: "select sid from v$session", connId: null });
    const list = m.listSnippets(null);
    expect(m.filterSnippets(list, "锁").map((s) => s.name)).toEqual(["看锁"]);
    // 「v$lock」只出现在 SQL 里，名字里没有 —— 说明搜的是名字 + 内容两处
    expect(m.filterSnippets(list, "v$lock").map((s) => s.name)).toEqual(["看锁"]);
    expect(m.filterSnippets(list, "v$lock TM").map((s) => s.name)).toEqual(["看锁"]);
    expect(m.filterSnippets(list, "v$lock sid")).toEqual([]);
    expect(m.filterSnippets(list, "  ")).toHaveLength(2);
  });

  it("快照：没写入时返回同一个引用，写入后才换", async () => {
    const m = await fresh();
    const a = m.snippetsSnapshot("c1");
    expect(m.snippetsSnapshot("c1")).toBe(a); // 引用相同，useSyncExternalStore 才不会死循环
    m.addSnippet({ name: "x", sql: "select 1 from dual", connId: "c1" });
    const b = m.snippetsSnapshot("c1");
    expect(b).not.toBe(a);
    expect(b).toHaveLength(1);
    expect(m.snippetsSnapshot("c1")).toBe(b);
  });

  it("localStorage 里是坏数据时当空库处理，不抛", async () => {
    localStorage.setItem("ncforge-db-snippets", "{ not json");
    let m = await fresh();
    expect(m.listSnippets(null)).toEqual([]);

    localStorage.setItem("ncforge-db-snippets", JSON.stringify([{ id: 1 }, { id: "ok", name: "n", sql: "s", connId: null, at: 1 }]));
    m = await fresh();
    // 结构不对的条目被丢掉，好的留下
    expect(m.listSnippets(null).map((s) => s.name)).toEqual(["n"]);
  });
});
