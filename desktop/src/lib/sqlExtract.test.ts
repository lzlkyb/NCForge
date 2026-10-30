import { describe, expect, it } from "vitest";
import { extractSql, fillParams, gapExpr, paramName } from "./sqlExtract";

const JAVA = [
  "  public List<SaleOutVO> queryRecent(String pkOrg, String beginDate) {",
  "    StringBuilder sql = new StringBuilder();",
  '    sql.append("select h.vbillcode, b.nnum ");',
  '    sql.append(" from ic_saleout_h h join ic_saleout_b b on b.cgeneralhid = h.cgeneralhid ");',
  "    sql.append(\" where h.pk_org = '\").append(pkOrg).append(\"'\");",
  "    // 只取未删除",
  "    sql.append(\" and h.dbilldate >= '\").append(vo.getBeginDate()).append(\"' and h.dr = 0\");",
  "    return getQuery().SelectListSQL(sql.toString(), SaleOutVO.class);",
  "  }",
].join("\n");

describe("extractSql", () => {
  it("拼起 append 链，变量变成参数", () => {
    const at = JAVA.indexOf("from ic_saleout_h");
    const r = extractSql(JAVA, at)!;
    expect(r.sql).toBe(
      "select h.vbillcode, b.nnum from ic_saleout_h h join ic_saleout_b b on b.cgeneralhid = h.cgeneralhid where h.pk_org = ':pkOrg' and h.dbilldate >= ':beginDate' and h.dr = 0",
    );
    expect(r.params.map((p) => p.name)).toEqual(["pkOrg", "beginDate"]);
    expect(r.params[1].expr).toBe("vo.getBeginDate()");
    expect(r.startLine).toBe(2);
    expect(r.endLine).toBe(7);
    expect(r.pieces).toBe(6);
  });

  it("加号拼接跨行", () => {
    const code = ['String sql = "select * from bd_material "', "    + \" where code = '\" + code + \"'\";", "query(sql);"].join("\n");
    const r = extractSql(code, code.indexOf("where"))!;
    expect(r.sql).toBe("select * from bd_material where code = ':code'");
    expect(r.endLine).toBe(2);
  });

  it("不是拼 SQL 的地方返回 null", () => {
    expect(extractSql("int a = 1;\nfoo(a);", 3)).toBeNull();
  });

  it("填参数", () => {
    const r = extractSql(JAVA, JAVA.indexOf("pk_org"))!;
    const sql = fillParams(r.sql, r.params, { pkOrg: "0001A1", beginDate: "2026-10-01" });
    expect(sql).toContain("h.pk_org = '0001A1'");
    expect(sql).toContain("'2026-10-01'");
  });
});

describe("表达式与参数名", () => {
  it("去掉拼接胶水", () => {
    expect(gapExpr(").append(pkOrg).append(")).toBe("pkOrg");
    expect(gapExpr(");\n    sql.append(")).toBe("");
    expect(gapExpr(" + SqlUtils_Pub.getInStr(pks) + ")).toBe("SqlUtils_Pub.getInStr(pks)");
  });

  it("getter 去掉 get", () => {
    expect(paramName("vo.getPk_org()")).toBe("pk_org");
    expect(paramName("head.getCode()")).toBe("code");
    expect(paramName("pkOrg")).toBe("pkOrg");
  });
});
