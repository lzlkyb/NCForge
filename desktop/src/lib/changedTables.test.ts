import { describe, expect, it } from "vitest";
import { checkChangedTables, tableRefsInChangedLines } from "./changedTables";

describe("tableRefsInChangedLines", () => {
  it("从 SQL 字符串里抽出 from / join 后的表名", () => {
    const rows = [{ line: 12, text: 'String sql = "select * from md_material m left join bd_stordoc s on m.id=s.id";' }];
    const refs = tableRefsInChangedLines(rows);
    expect(refs.map((r) => r.name.toLowerCase())).toContain("md_material");
    expect(refs.map((r) => r.name.toLowerCase())).toContain("bd_stordoc");
    expect(refs[0].line).toBe(12);
  });

  it("Java 标识符不算表名，只有字符串里的才算", () => {
    const rows = [{ line: 3, text: "private String md_fake;" }];
    expect(tableRefsInChangedLines(rows)).toEqual([]);
  });

  it("NC 前缀表名即使不在关键字后也能认出", () => {
    const rows = [{ line: 7, text: 'String t = "md_material";' }];
    expect(tableRefsInChangedLines(rows).map((r) => r.name)).toEqual(["md_material"]);
  });

  it("同一行同一张表不重复", () => {
    const rows = [{ line: 9, text: '"from md_material where md_material.id=1"' }];
    const refs = tableRefsInChangedLines(rows);
    expect(refs.filter((r) => r.name === "md_material")).toHaveLength(1);
  });

  it("普通 Java 代码行不产生候选", () => {
    expect(tableRefsInChangedLines([{ line: 5, text: "public class A { int update = 1; }" }])).toEqual([]);
  });
});

describe("checkChangedTables", () => {
  it("没有表结构缓存时不下「不存在」的结论", () => {
    const r = checkChangedTables([{ line: 1, name: "md_material" }]);
    expect(r[0].exists).toBeNull();
  });
});
