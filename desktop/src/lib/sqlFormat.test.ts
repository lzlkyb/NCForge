import { describe, expect, it } from "vitest";
import { formatSql } from "./sqlFormat";

describe("formatSql", () => {
  it("主子句、join、and 换行", () => {
    const out = formatSql("select h.a, b.c from t h left join u b on b.id = h.id where h.x = 1 and h.y = 'a and b' order by h.a");
    expect(out).toBe(
      [
        "select h.a,",
        "       b.c",
        "from t h",
        "  left join u b on b.id = h.id",
        "where h.x = 1",
        "   and h.y = 'a and b'",
        "order by h.a",
      ].join("\n"),
    );
  });

  it("括号里原样保留", () => {
    const out = formatSql("select count(*), nvl(a, 0) from (select a from t where b = 1) x");
    expect(out).toContain("(select a from t where b = 1)");
    expect(out).toContain("nvl(a, 0)");
  });

  it("关键字大小写不改", () => {
    expect(formatSql("SELECT A FROM T WHERE B=1")).toBe("SELECT A\nFROM T\nWHERE B=1");
  });

  it("行注释后面换行", () => {
    expect(formatSql("select a -- 说明\nfrom t")).toBe("select a -- 说明\nfrom t");
  });
});
