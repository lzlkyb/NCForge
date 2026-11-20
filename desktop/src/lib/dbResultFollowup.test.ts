import { describe, expect, it } from "vitest";
import { readQueryBody, resultFilterQuery, resultRelationQuery } from "./dbResultFollowup";
import { analyzeSql } from "./sqlSource";
import type { ColumnMeta } from "./dbApi";
import type { Relation } from "./dbRelations";

const col = (name: string, type = "VARCHAR2"): ColumnMeta => ({ name, type, precision: 0, scale: 0 });

describe("数据库结果追查", () => {
  it("重查保留来源条件，单引号和通配符通过绑定传递", () => {
    const plan = resultFilterQuery('SELECT d.code AS "编码" FROM PO_ORDER d WHERE d.dr = 0; -- old', [col("编码")], { column: 0, value: "O'Brien_%" });
    expect(plan).toMatchObject({ executable: true, params: ["O'Brien_%"] });
    expect(plan?.sql).toBe('SELECT * FROM (\nSELECT d.code AS "编码" FROM PO_ORDER d WHERE d.dr = 0\n)\nWHERE "编码" = :1');
    expect(resultFilterQuery("SELECT code FROM po_order", [col("CODE")], { keyword: "x_%" })).toMatchObject({ params: ["x_%"], executable: true });
  });

  it("只给复杂或已绑定结果条件预览，重复输出列无法猜测", () => {
    expect(resultFilterQuery("SELECT a.code FROM a JOIN b ON a.id=b.id", [col("CODE")], { column: 0, value: null }))
      .toMatchObject({ executable: false, sql: "WHERE CODE IS NULL", params: [] });
    expect(resultFilterQuery("SELECT code FROM a", [col("CODE")], { column: 0, value: "x" }, true)?.executable).toBe(false);
    expect(resultFilterQuery("SELECT a.*, b.* FROM a, b", [col("CODE"), col("CODE")], { column: 0, value: "x" })).toBeNull();
    for (const unsafe of ["DELETE FROM a", "SELECT * FROM a FOR UPDATE", "SELECT * FROM a; SELECT * FROM b",
      "WITH FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; SELECT f FROM dual", "SELECT * FROM a where id = :id"]) {
      expect(readQueryBody(unsafe)).toBeNull();
    }
    expect(readQueryBody("SELECT ';' FROM dual; -- tail")).toBe("SELECT ';' FROM dual");
  });

  it("复合关系按投影映射取得本行全部键值，并验证 Schema", () => {
    const relation: Relation = { id: "line", source: "PO_ORDER_B", target: "PO_ORDER", from: ["PK_ORDER", "TENANT"], to: ["ID", "TENANT"], kind: "外键" };
    const source = analyzeSql("SELECT id AS doc, tenant FROM NC.PO_ORDER");
    expect(resultRelationQuery(relation, source, "NC", [col("DOC", "NUMBER"), col("TENANT")], [19, "T-1"]))
      .toMatchObject({ sql: "SELECT * FROM NC.PO_ORDER_B\nWHERE PK_ORDER = :1 and TENANT = :2", params: [{ number: "19" }, "T-1"] });
    expect(() => resultRelationQuery(relation, source, "OTHER", [col("DOC"), col("TENANT")], ["19", "T-1"])).toThrow("Schema");
    expect(() => resultRelationQuery(relation, source, "NC", [col("DOC")], ["19"])).toThrow("TENANT");
  });
});
