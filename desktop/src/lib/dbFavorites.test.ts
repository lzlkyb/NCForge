// @vitest-environment jsdom
/**
 * 数据库收藏的存储、迁移与快照。
 *
 * 锁住四件事：旧版表收藏要迁过来、同名对象按「类型 + 名称」去重、
 * 清连接只清自己的、快照引用不变（否则 `useSyncExternalStore` 会死循环）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

async function fresh() {
  vi.resetModules();
  return import("./dbFavorites");
}

beforeEach(() => {
  localStorage.clear();
});

describe("dbFavorites", () => {
  it("旧版 {connId: string[]} 自动迁移成 v2 表收藏", async () => {
    localStorage.setItem("ncforge-db-fav", JSON.stringify({ c1: ["T_B", "T_A"], c2: ["V_X"] }));
    const m = await fresh();
    expect(m.listFavorites().map((f) => `${f.connId}:${f.kind}:${f.name}`)).toEqual([
      "c1:table:T_B",
      "c1:table:T_A",
      "c2:table:V_X",
    ]);
    expect(JSON.parse(localStorage.getItem("ncforge-db-fav-v2")!)).toMatchObject({ v: 2 });
  });

  it("已有 v2 时不再读旧 key，避免复活已删除的收藏", async () => {
    localStorage.setItem("ncforge-db-fav", JSON.stringify({ c1: ["OLD"] }));
    localStorage.setItem(
      "ncforge-db-fav-v2",
      JSON.stringify({ v: 2, items: [{ connId: "c1", kind: "table", name: "NEW", at: 1 }] }),
    );
    const m = await fresh();
    expect(m.listFavorites().map((f) => f.name)).toEqual(["NEW"]);
  });

  it("v2 是坏 JSON 时当空库，不把旧 key 捞回来", async () => {
    localStorage.setItem("ncforge-db-fav", JSON.stringify({ c1: ["OLD"] }));
    localStorage.setItem("ncforge-db-fav-v2", "{ not json");
    const m = await fresh();
    expect(m.listFavorites()).toEqual([]);
  });

  it("收藏 / 取消 / 大小写与类型去重", async () => {
    const m = await fresh();
    expect(m.toggleFavorite("c1", "table", "t_a")).toBe(true);
    expect(m.toggleFavorite("c1", "table", "T_A")).toBe(false);
    expect(m.listFavorites()).toEqual([]);

    expect(m.toggleFavorite("c1", "object", "pkg_x", "package")).toBe(true);
    expect(m.listFavorites()[0]).toMatchObject({
      connId: "c1",
      kind: "object",
      name: "PKG_X",
      otype: "PACKAGE",
    });
    expect(m.toggleFavorite("c1", "object", "PKG_X", "PACKAGE")).toBe(false);
    expect(m.listFavorites()).toEqual([]);
  });

  it("同名表和对象可以各自收藏", async () => {
    const m = await fresh();
    m.toggleFavorite("c1", "table", "PKG_X");
    m.toggleFavorite("c1", "object", "PKG_X", "PACKAGE");
    expect(m.listFavorites()).toHaveLength(2);
  });

  it("清某个连接的收藏不影响别的连接", async () => {
    const m = await fresh();
    m.toggleFavorite("c1", "table", "T_A");
    m.toggleFavorite("c1", "object", "PKG_X", "PACKAGE");
    m.toggleFavorite("c2", "table", "T_B");
    m.clearFavorites("c1");
    expect(m.listFavorites().map((f) => `${f.connId}:${f.name}`)).toEqual(["c2:T_B"]);
  });

  it("快照引用稳定：没写入时返回同一份，写入后才换", async () => {
    const m = await fresh();
    const a = m.listFavorites();
    expect(m.listFavorites()).toBe(a);
    m.toggleFavorite("c1", "table", "T_A");
    const b = m.listFavorites();
    expect(b).not.toBe(a);
    expect(m.listFavorites()).toBe(b);
  });
});
