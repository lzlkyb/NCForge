import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSql, sqlLanguageOf, sqlLanguageOfUrl } from "./sqlFormat";
import { DEFAULT_SQL_FORMAT, setSqlFormatPrefs } from "./sqlFormatPrefs";

// The original snapshots continue to verify the user-selectable expanded layout.
beforeEach(() => setSqlFormatPrefs({ ...DEFAULT_SQL_FORMAT, layout: "expanded" }));
afterEach(() => setSqlFormatPrefs(DEFAULT_SQL_FORMAT));

describe("sqlLanguageOfUrl", () => {
  it("JDBC 子协议映射到 sql-formatter 方言", () => {
    expect(sqlLanguageOfUrl("jdbc:oracle:thin:@h:1521/orcl")).toBe("plsql");
    expect(sqlLanguageOfUrl("jdbc:mysql://h:3306/db")).toBe("mysql");
    expect(sqlLanguageOfUrl("jdbc:mariadb://h/db")).toBe("mariadb");
    expect(sqlLanguageOfUrl("jdbc:postgresql://h/db")).toBe("postgresql");
    expect(sqlLanguageOfUrl("jdbc:sqlserver://h:1433;database=x")).toBe("tsql");
    expect(sqlLanguageOfUrl("jdbc:db2://h:50000/db")).toBe("db2");
    expect(sqlLanguageOfUrl("jdbc:sqlite:/tmp/x.db")).toBe("sqlite");
  });
  it("大小写与前后空白不敏感", () => {
    expect(sqlLanguageOfUrl("  JDBC:ORACLE:thin:@h  ")).toBe("plsql");
  });
  it("国产库 / 未知 / 空串回退标准 sql", () => {
    expect(sqlLanguageOfUrl("jdbc:dm://h:5236")).toBe("sql");
    expect(sqlLanguageOfUrl("jdbc:kingbase8://h/db")).toBe("sql");
    expect(sqlLanguageOfUrl("")).toBe("sql");
    expect(sqlLanguageOfUrl("不是url")).toBe("sql");
  });
});

describe("formatSql（sql-formatter 语法级排版）", () => {
  it("主子句、join、and 拆行，字符串里的 and 不拆", async () => {
    const out = await formatSql(
      "select h.a, b.c from t h left join u b on b.id = h.id where h.x = 1 and h.y = 'a and b' order by h.a",
      "plsql",
    );
    expect(out).toBe(
      "select\n  h.a,\n  b.c\nfrom\n  t h\n  left join u b on b.id = h.id\nwhere\n  h.x = 1\n  and h.y = 'a and b'\norder by\n  h.a",
    );
  });

  it("括号里的子查询逐层缩进（旧实现整坨原样保留）", async () => {
    const out = await formatSql("select count(*), nvl(a, 0) from (select a from t where b = 1) x", "plsql");
    expect(out).toBe(
      "select\n  count(*),\n  nvl(a, 0)\nfrom\n  (\n    select\n      a\n    from\n      t\n    where\n      b = 1\n  ) x",
    );
  });

  it("关键字大小写保留", async () => {
    expect(await formatSql("SELECT A FROM T WHERE B=1")).toBe("SELECT\n  A\nFROM\n  T\nWHERE\n  B = 1");
  });

  it("行注释保留", async () => {
    expect(await formatSql("select a -- 说明\nfrom t")).toBe("select\n  a -- 说明\nfrom\n  t");
  });

  it("CASE WHEN 展开", async () => {
    expect(await formatSql("select case when a = 1 then 'x' else 'y' end c from t", "plsql")).toBe(
      "select\n  case\n    when a = 1 then 'x'\n    else 'y'\n  end c\nfrom\n  t",
    );
  });

  it("多层嵌套分页 SQL 不再压成一行（旧实现 3 行 / 最长 1938 字符）", async () => {
    const sql =
      "select * from (select row_.*, rownum rownum_ from (select a.pk, a.name from (select distinct pk, name from bd_project left outer join bd_region r on r.pk = bd_project.address where enablestate = 2 and level not in ('5','6')) where 11=11 and pk in (select pk from pim_h where nvl(dr,0)=0 and flag=1) order by pk) row_ where rownum <= 500) where rownum_ > 0";
    const out = await formatSql(sql, "plsql");
    const lines = out.split("\n");
    expect(lines.length).toBeGreaterThan(15);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(100);
  });

  it("显式选项生效：关键字大写不影响标识符", async () => {
    expect(await formatSql("select a from t", "sql", { keywordCase: "upper" })).toBe("SELECT\n  a\nFROM\n  t");
  });
});

describe("sqlLanguageOf（方言覆盖）", () => {
  it("auto 跟随连接，手动覆盖优先", () => {
    expect(sqlLanguageOf("jdbc:oracle:thin:@h:1521/orcl")).toBe("plsql");
    expect(sqlLanguageOf("jdbc:oracle:thin:@h:1521/orcl", { ...DEFAULT_SQL_FORMAT, dialect: "mysql" })).toBe("mysql");
    expect(sqlLanguageOf("jdbc:oracle:thin:@h:1521/orcl", { ...DEFAULT_SQL_FORMAT, dialect: "auto" })).toBe("plsql");
  });
});
