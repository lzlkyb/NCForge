import { describe, expect, it } from "vitest";
import { statementTitle } from "./sqlStatementTitle";

describe("语句标题取紧贴的注释", () => {
  it("单行注释就是标题", () => {
    expect(statementTitle("-- 物料主档\nselect * from bd_material")).toBe("物料主档");
    expect(statementTitle("  --   期初余额  \nselect 1 from dual")).toBe("期初余额");
  });

  it("显式 name: / 名称： 前缀优先", () => {
    expect(statementTitle("-- name: 库存查询\nselect 1 from dual")).toBe("库存查询");
    expect(statementTitle("-- 名称：库存查询\nselect 1 from dual")).toBe("库存查询");
  });

  it("块注释取第一行，剥掉行首的 *", () => {
    expect(statementTitle("/* 期初余额 */\nselect 1 from dual")).toBe("期初余额");
    expect(statementTitle("/*\n * 物料主档\n * 第二行不算\n */\nselect 1 from dual")).toBe("物料主档");
  });

  it("块注释里多行只取第一行有内容的", () => {
    expect(statementTitle("/*\n\n   盘点差异\n*/\nselect 1 from dual")).toBe("盘点差异");
  });

  it("注释与语句之间有空行 = 段落说明，不做标题", () => {
    expect(statementTitle("-- 2026-11 升级脚本\n\nselect * from bd_material")).toBeNull();
    expect(statementTitle("-- 分组标题\n\n\nselect 1 from dual")).toBeNull();
  });

  it("装饰线与空注释不算标题", () => {
    expect(statementTitle("-----\nselect 1 from dual")).toBeNull();
    expect(statementTitle("-- =====\nselect 1 from dual")).toBeNull();
    expect(statementTitle("--   \nselect 1 from dual")).toBeNull();
  });

  it("没有注释就不给标题", () => {
    expect(statementTitle("select * from bd_material")).toBeNull();
    expect(statementTitle("")).toBeNull();
  });

  it("hint 注释不是标题（`/*+ ... */` 是给优化器的）", () => {
    expect(statementTitle("/*+ index(bd_material idx_code) */\nselect * from bd_material")).toBeNull();
    // 单行注释形式的 hint（`--+`）同样不算
    expect(statementTitle("--+ parallel(4)\nselect count(*) from bd_material")).toBeNull();
  });

  it("超长标题按码点截断并加省略号", () => {
    const long = `-- ${"物料主档".repeat(10)}\nselect 1 from dual`;
    const title = statementTitle(long, 6)!;
    expect([...title]).toHaveLength(7);
    expect(title.endsWith("…")).toBe(true);
  });
});
