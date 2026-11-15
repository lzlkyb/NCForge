import { describe, expect, it } from "vitest";
import { sqlJoinMeanings, type MeaningEdit } from "./sqlJoinMeaning";

const prefix = "SELECT a.*, b.* FROM head a LEFT JOIN lines b ON a.id=b.head_id ";
const apply = (sql: string, edits: MeaningEdit[]) => [...edits].sort((a, b) => b.start - a.start).reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), sql);
describe("LEFT JOIN 条件含义", () => {
  it("提示确定排除空关联的字段，手动选择可移入ON或明确INNER JOIN", () => {
    const sql = prefix + "WHERE b.qty > 1;", [m] = sqlJoinMeanings(sql);
    expect(sql.slice(m.start, m.end)).toBe("b.qty");
    expect(m.message).toContain("会排除没有匹配 b 记录");
    expect(apply(sql, m.move!)).toContain("ON (a.id=b.head_id) AND (b.qty > 1)\n;");
    expect(apply(sql, [m.inner!])).toContain("INNER JOIN lines b");
  });
  it.each(["b.qty > 1 AND a.org='1'", "a.org='1' AND b.qty > 1", "a.org='1' AND b.qty > 1 AND a.dr=0"])("移除当前完整AND条件但保留其余过滤：%s", condition => {
    const sql = prefix + "WHERE " + condition + " ORDER BY a.id;", [m] = sqlJoinMeanings(sql), moved = apply(sql, m.move!);
    expect(moved).toContain("(b.qty > 1)"); expect(moved).toContain("a.org='1'");
    expect(moved).toContain("ORDER BY a.id;"); expect(moved).not.toMatch(/WHERE\s+AND|AND\s+ORDER/);
  });
  it("已有ON含OR时明确分组，IN/BETWEEN和IS NOT NULL保留完整谓词", () => {
    for (const condition of ["b.qty BETWEEN 1 AND 2", "b.item IN ('A', 'B')", "b.item IS NOT NULL"]) {
      const sql = "SELECT * FROM head a LEFT JOIN lines b ON a.id=b.head_id OR a.old_id=b.head_id WHERE " + condition;
      const [m] = sqlJoinMeanings(sql);
      expect(apply(sql, m.move!)).toContain("ON (a.id=b.head_id OR a.old_id=b.head_id) AND (" + condition + ")");
    }
  });
  it.each(["b.qty IS NULL", "b.qty > 1 OR a.org='1'", "NOT b.qty > 1", "coalesce(b.qty,0)=0", "a.qty=1", "b.qty IN (SELECT qty FROM other)"])("不猜复杂或能保留未匹配行的条件：%s", condition => {
    expect(sqlJoinMeanings(prefix + "WHERE " + condition)).toEqual([]);
  });
  it("表达式右侧引用别名不误当成直接子表过滤", () => {
    expect(sqlJoinMeanings(prefix + "WHERE a.qty + b.qty > 1")).toEqual([]);
    expect(sqlJoinMeanings("SELECT * FROM head a INNER JOIN lines b ON a.id=b.head_id WHERE b.qty>1")).toEqual([]);
    expect(sqlJoinMeanings(prefix + "WHERE (b.qty>1 AND a.org='1')")).toEqual([]);
  });
  it.each(["b.flag = TRUE IS NULL", "b.qty > 1 IS NULL", "b.qty > 1 IS UNKNOWN", "b.flag = TRUE IS FALSE", "b.qty > 1 ISNULL", "b.item IN ('A') ISNULL", "b.qty BETWEEN 1 AND 2 ISNULL", "b.qty > 1 NOTNULL"])("比较结果再做布尔真值测试不猜空关联含义：%s", condition => {
    expect(sqlJoinMeanings(prefix + "WHERE " + condition, "postgresql")).toEqual([]);
  });
  it("多层/后续关联仅提示；带注释不提供可能删除注释的编辑", () => {
    const sql = prefix.replace(" ON", " ON") + "JOIN tax c ON b.id=c.line_id WHERE b.qty>1";
    const [m] = sqlJoinMeanings(sql); expect(m).toBeDefined(); expect(m.move).toBeUndefined();
    const [comment] = sqlJoinMeanings(prefix + "WHERE b.qty > 1 /* keep */"); expect(comment).toBeDefined(); expect(comment.move).toBeUndefined();
  });
  it("保留前后语句、引用别名和关键词大小写", () => {
    const sql = 'select 1 from dual; select a.*, "b".* from head a left outer join lines "b" on a.id="b".head_id where "b".qty>1; select 2 from dual;';
    const [m] = sqlJoinMeanings(sql), inner = apply(sql, [m.inner!]);
    expect(inner).toContain('inner join lines "b"');
    expect(inner).toContain("select 1 from dual;"); expect(inner).toContain("; select 2 from dual;");
  });
});
