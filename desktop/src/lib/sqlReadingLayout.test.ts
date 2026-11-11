import { describe, expect, it } from "vitest";
import type { SqlLanguage } from "sql-formatter";
import pagination from "./__fixtures__/sqlReadingPagination.sql?raw";
import { formatSql } from "./sqlFormat";
import { layoutTokens } from "./sqlLayoutTokens";

const read = (sql: string, language: SqlLanguage = "plsql", lineWidth = 120) =>
  formatSql(sql, language, { layout: "reading", lineWidth, tabWidth: 2, keywordCase: "preserve" });
const tokenText = (sql: string, language: SqlLanguage = "plsql") => {
  const tokens = layoutTokens(sql, language);
  expect(tokens).not.toBeNull();
  return tokens!.map(t => [t.kind, t.text]);
};

describe("SQL 阅读布局", () => {
  it("真实 NC 分页 SQL 填充字段，保留括号、别名及逻辑，第二次排版稳定", async () => {
    const out = await read(pagination);
    const lines = out.split("\n");
    expect(lines.length).toBeLessThanOrEqual(55);
    expect(lines.length).toBeGreaterThan(20);
    expect(Math.max(...lines.map(l => l.length))).toBeLessThanOrEqual(120);
    expect(out).toContain("project_code, project_reportname, institution_code");
    expect(out).toContain("  select row_.*, rownum rownum_ from (");
    expect(out).toContain("left outer join");
    expect(tokenText(out)).toEqual(tokenText(pagination));
    expect(await read(out)).toBe(out);
  });

  it("默认入口使用阅读布局，短子句收拢，顶层 AND 保留层次", async () => {
    const sql = "select pk_org, name from org where enable = 1 and name is not null order by name";
    expect(await formatSql(sql)).toBe("select pk_org, name from org\nwhere enable = 1\n  and name is not null\norder by name");
  });

  it("宽度基于固定设置，在字段之间换行，不拆函数或别名", async () => {
    const sql = "select project_code, project_reportname, institution_code, nvl(nconstructionarea, 0) area, pk_workcalendar, pk_projectclass from bd_project";
    const narrow = await read(sql, "plsql", 60), wide = await read(sql, "plsql", 120);
    expect(narrow.split("\n").length).toBeGreaterThan(wide.split("\n").length);
    expect(narrow).toContain("nvl(nconstructionarea, 0) area");
    expect(tokenText(narrow)).toEqual(tokenText(sql));
    expect(await read(narrow, "plsql", 60)).toBe(narrow);
  });

  it("长 token 可以超过软宽度，字符串及引号中的 SQL 单词不参与重排", async () => {
    const literal = "'" + "from and ( " + "x".repeat(150) + " )'";
    const sql = `select ${literal} as "ON", nvl(dr, 0) from t where a = 1`;
    const out = await read(sql, "plsql", 60);
    expect(out).toContain(literal);
    expect(tokenText(out)).toEqual(tokenText(sql));
    expect(await read(out, "plsql", 60)).toBe(out);
  });

  const cases: [string, string, SqlLanguage][] = [
    ["混合AND/OR与BETWEEN", "select a, b from t where a between 1 and 10 and (b = 1 or c = 2) and d = 3", "plsql"],
    ["CASE与窗口函数", "select case when a = 1 then 'x' else 'y' end c, sum(v) over (partition by pk_org order by id) total from t", "plsql"],
    ["CTE与UNION", "with x as (select a, b from t where a = 1) select a from x union all select a from u order by a", "plsql"],
    ["长函数与IN列表", "select coalesce(very_long_column_name_1, very_long_column_name_2, very_long_column_name_3, 'default') v from t where a in (111,222,333,444,555,666,777,888,999)", "plsql"],
    ["Oracle提示和行注释", "select /*+ INDEX(p idx_project) */ p.project_code, p.name -- 关联字段\nfrom bd_project p where p.dr = 0", "plsql"],
    ["Oracle特殊引号和外连接", "select q'[a,b and c]', nq'{where ( )}', nvl(p.dr, 0) from bd_project p where p.pk_org = :pk_org and p.dr(+) = 0", "plsql"],
    ["Oracle层次查询", "select pk_project, level from bd_project start with parent_id is null connect by prior pk_project = parent_id", "plsql"],
    ["MySQL转义与反引号", "select `from`, 'a\\'b, from ( )' s from `table` where dr = 0 # 说明\nand enabled = 1", "mysql"],
    ["PostgreSQL dollar字符串", "select $$a, b\nfrom ( t )$$ v, a::text from t where a = $1", "postgresql"],
    ["SQL Server方括号标识符", "select [from], [a]]b], name from [table] where dr = @dr", "tsql"],
    ["SQLite多行方括号标识符", "select [one\n two] v, name from t where dr = 0", "sqlite"],
    ["多行字符串", "select 'one\n  two, from\nthree' v, pk_org from org where dr = 0", "plsql"],
    ["多行注释", "select pk_org, /* line1\n  line2 */ name from org where dr = 0", "plsql"],
  ];
  it.each(cases)("%s 不丢文本，幂等", async (_, sql, language) => {
    const expanded = await formatSql(sql, language, { layout: "expanded", keywordCase: "preserve", tabWidth: 2 });
    const out = await read(sql, language);
    expect(tokenText(out, language)).toEqual(tokenText(expanded, language));
    expect(await read(out, language)).toBe(out);
  });

  it("阅读布局只由目标行宽控制，结构展开的括号宽度仍保留", async () => {
    const sql = "select nvl(a, 0) first_value, nvl(b, 0) second_value from t where a = 1 and b = 2";
    const a = await formatSql(sql, "plsql", { layout: "reading", lineWidth: 120, expressionWidth: 1 });
    const b = await formatSql(sql, "plsql", { layout: "reading", lineWidth: 120, expressionWidth: 200 });
    expect(a).toBe(b);
  });

  it.each([1, 4])("%s空格缩进与行尾运算符仍保留查询层级", async tabWidth => {
    const sql = "select * from (select a, b from t where a between 1 and 3 and (b = 1 or c = 2)) x where rownum <= 500";
    const opts = { layout: "reading" as const, tabWidth, logicalOperatorNewline: "after" as const };
    const out = await formatSql(sql, "plsql", opts);
    expect(out).toContain("\n" + " ".repeat(tabWidth) + "select");
    expect(tokenText(out)).toEqual(tokenText(sql));
    expect(await formatSql(out, "plsql", opts)).toBe(out);
  });

  it("保留用户关闭格式化的区域，未验证的方言不做额外布局", async () => {
    const sql = "/* sql-formatter-disable */\nselect\n  a,\n  b\nfrom\n  t\n/* sql-formatter-enable */";
    expect(await read(sql)).toBe(await formatSql(sql, "plsql", { layout: "expanded" }));
    const snowflake = "select $$first\n  second from ( )$$ v, name from t";
    expect(await formatSql(snowflake, "snowflake", { layout: "reading" })).toBe(await formatSql(snowflake, "snowflake", { layout: "expanded", expressionWidth: 120 }));
  });

  it("CASE 保留分支，注释结束后必须换行", async () => {
    const out = await read("select case when a = 1 then 'x' else 'y' end c from t");
    expect(out).toContain("case\n");
    expect(out).toContain("when a = 1 then 'x'\n");
    const commented = await read("select a -- from t\nfrom real_table where dr = 0");
    expect(commented).toMatch(/-- from t\n/);
    expect(commented).toContain("from real_table");
  });

  it("显式大小写只影响引擎识别的关键字，结构展开仍保留表格风格", async () => {
    expect(await formatSql("select a, b from t", "sql", { layout: "reading", keywordCase: "upper" })).toBe("SELECT a, b FROM t");
    const out = await formatSql("select a, b from t", "sql", { layout: "expanded", indentStyle: "tabularLeft" });
    expect(out).toContain("\n");
    expect(out).not.toBe(await read("select a, b from t", "sql"));
  });

  it("脚本语句间空行沿用设置，坏语句由调用方保留原文", async () => {
    expect(await formatSql("select a from t; select b from u;", "sql", { layout: "reading", linesBetweenQueries: 2 })).toBe("select a from t;\n\n\nselect b from u;");
    await expect(read("select a from t where b in (1,2")).rejects.toThrow();
  });
});
