import { describe, expect, it } from "vitest";
import { ACTION_COMMANDS, keywordFor, sqlActionsAt, type SqlActionInput } from "./sqlAssistActions";

const base: SqlActionInput = { plsql: true, templatesEnabled: true, bare: false, table: "po_order", relations: 3, wildcard: false, insertable: true };
const bare: SqlActionInput = { ...base, bare: true };

describe("当前位置可用的 SQL 动作", () => {
  // 语句内只能追加：替换整条会把用户写好的 SELECT/WHERE 一起抹掉。
  it("语句内的表名上只给「追加 LEFT JOIN」", () => {
    expect(sqlActionsAt(base).map(a => a.id)).toEqual(["bill.join"]);
  });
  // 裸表名位置替换的是表名本身，整条联查放得进去；INSERT 模板也只在这个位置出现。
  it("裸表名上给整条联查替换与 INSERT 模板", () => {
    expect(sqlActionsAt(bare).map(a => a.id)).toEqual(["bill.query", "insert.template"]);
  });
  // 关系还没解析出来之前不给：说了「支持主子表联查」却点不动，比不说更糟。
  it("关系未知或表名没命中时不给联查，INSERT 模板照给", () => {
    expect(sqlActionsAt({ ...bare, relations: 0 }).map(a => a.id)).toEqual(["insert.template"]);
    expect(sqlActionsAt({ ...bare, table: "" })).toEqual([]);
  });
  it("非 Oracle 方言时不给联查与 INSERT", () => {
    expect(sqlActionsAt({ ...bare, plsql: false })).toEqual([]);
  });
  it("模板开关关闭时只留「展开 *」", () => {
    expect(sqlActionsAt(bare)).toHaveLength(2);
    expect(sqlActionsAt({ ...bare, templatesEnabled: false })).toEqual([]);
    expect(sqlActionsAt({ ...bare, templatesEnabled: false, wildcard: true }).map(a => a.id)).toEqual(["star.expand"]);
  });
  // 挂在 * 上是最常见的误入位置：这条必须排第一，否则 31 个字段会把面板占满。
  it("光标在 * 上时「展开字段」排在最前", () => {
    expect(sqlActionsAt({ ...base, wildcard: true }).map(a => a.id)).toEqual(["star.expand", "bill.join"]);
  });
  it("PL/SQL 块里不给 INSERT 模板", () => {
    expect(sqlActionsAt({ ...bare, insertable: false }).map(a => a.id)).toEqual(["bill.query"]);
  });
  // 每个动作都要有能执行的入口，否则点下去只是一个空菜单。
  it("每个动作都有执行入口", () => {
    const ids = sqlActionsAt({ ...bare, wildcard: true }).map(a => a.id);
    expect(ids.every(id => id in ACTION_COMMANDS)).toBe(true);
  });
});

describe("关键词直搜", () => {
  const expand = sqlActionsAt({ ...bare, wildcard: true })[0];
  const insert = sqlActionsAt(bare).find(a => a.id === "insert.template")!;
  const join = sqlActionsAt(base)[0];

  it("少打一个字符也算命中", () => {
    expect(keywordFor(expand, "ex")).toBe("exp");
    expect(keywordFor(expand, "EXP")).toBe("exp");
    expect(keywordFor(insert, "insert")).toBe("insert");
  });
  // `in` 是 SQL 的 IN 操作符，让它命中 insert 会把操作符从列表首位挤走。
  it("两字符以下的短前缀不命中", () => {
    expect(keywordFor(expand, "e")).toBe("");
    expect(keywordFor(insert, "in")).toBe("");
    expect(keywordFor(insert, "i")).toBe("");
  });
  it("联查类不给关键词：join 会抢掉 SQL 关键字的位置", () => {
    expect(join.keys).toEqual([]);
    expect(keywordFor(join, "join")).toBe("");
  });
  it("无关的词不命中", () => {
    expect(keywordFor(expand, "po_order")).toBe("");
  });
});
