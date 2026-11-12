// @vitest-environment jsdom
/**
 * 表页视图记忆（localStorage + 7 天有效期）。
 *
 * 盯两条：① 切走再回来页面状态一致（条件、页号、绑定值）；② 常用筛选改过后，
 * 旧视图必须让位——否则点一次「查询」显示的还是上一次的条件，表格与筛选栏各说各话。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { loadFilterView, loadTableView, saveFilterView, saveTableView } from "./dbTableView";

beforeEach(() => localStorage.clear());

describe("TableView", () => {
  it("条件、页号、绑定值原样回读，表名大小写不敏感", () => {
    saveTableView("c1", "BD_MATERIAL", {
      where: "dr = 0 and code like :1",
      order: "pk_material",
      params: ["CG%"],
      page: 3,
      filterKey: "fp",
    });
    expect(loadTableView("c1", "bd_material", "fp")).toEqual({
      where: "dr = 0 and code like :1",
      order: "pk_material",
      params: ["CG%"],
      page: 3,
      filterKey: "fp",
    });
  });

  it("常用筛选改过（指纹不同）：旧视图作废，不顶替新条件", () => {
    saveTableView("c1", "bd_material", { where: "dr = 0", order: "", params: [], page: 2, filterKey: "old" });
    expect(loadTableView("c1", "bd_material", "new")).toBeNull();
  });

  it("连接 / 表不同互不串用；坏数据当没有", () => {
    saveTableView("c1", "bd_material", { where: "a", order: "", params: [], page: 1, filterKey: "k" });
    expect(loadTableView("c2", "bd_material", "k")).toBeNull();
    expect(loadTableView("c1", "bd_other", "k")).toBeNull();
    localStorage.setItem("ncforge.db.tableView:c1:bd_bad", "{oops");
    expect(loadTableView("c1", "bd_bad", "k")).toBeNull();
    localStorage.setItem("ncforge.db.tableView:c1:bd_neg", JSON.stringify({ where: "", order: "", params: [], page: -1, filterKey: "k", savedAt: Date.now() }));
    // 页号非法时回到第 1 页，而不是把 -1 交给分页 SQL
    expect(loadTableView("c1", "bd_neg", "k")?.page).toBe(0);
  });

  it("超过 7 天不再恢复：久未打开的表不该带着一个忘掉的筛选", () => {
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem("ncforge.db.tableView:c1:bd_material", JSON.stringify({ where: "dr = 0", order: "", params: [], page: 0, filterKey: "k", savedAt: old }));
    expect(loadTableView("c1", "bd_material", "k")).toBeNull();
  });

  it("没有时间戳的旧数据不恢复（换了存储位置所以不存在迁移问题）", () => {
    localStorage.setItem("ncforge.db.tableView:c1:bd_material", JSON.stringify({ where: "dr = 0", order: "", params: [], page: 0, filterKey: "k" }));
    expect(loadTableView("c1", "bd_material", "k")).toBeNull();
  });
});

describe("FilterView", () => {
  it("可视化条件与手写 WHERE 成对回读", () => {
    saveFilterView("c1", "bd_material", {
      filter: { conditions: [{ column: "DR", op: "eq", value: "0", end: "" }], join: "and", sort: "", descending: false },
      advanced: true,
      raw: { where: "1=1", order: "ts desc" },
    });
    expect(loadFilterView("c1", "bd_material")).toEqual({
      filter: { conditions: [{ column: "DR", op: "eq", value: "0", end: "" }], join: "and", sort: "", descending: false },
      advanced: true,
      raw: { where: "1=1", order: "ts desc" },
    });
  });

  it("缺字段时给可用的默认值（老版本存下来的视图）", () => {
    localStorage.setItem("ncforge.db.filterView:c1:t", JSON.stringify({ filter: { conditions: [] }, savedAt: Date.now() }));
    expect(loadFilterView("c1", "t")).toEqual({
      filter: { conditions: [] },
      advanced: false,
      raw: { where: "", order: "" },
    });
  });
});
