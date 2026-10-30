import { describe, expect, it } from "vitest";
import { aliasMap, completionContext, tablesIn } from "./sqlComplete";

describe("aliasMap", () => {
  it("from / join 的别名", () => {
    const m = aliasMap("select h.a from ic_saleout_h h left join ic_saleout_b b on b.id = h.id join bd_material as m on 1=1 where h.x = 'from t z'");
    expect(m.get("h")).toBe("ic_saleout_h");
    expect(m.get("b")).toBe("ic_saleout_b");
    expect(m.get("m")).toBe("bd_material");
    expect(m.has("z")).toBe(false);
    expect(m.has("left")).toBe(false);
  });

  it("from 里的逗号列表与 schema 前缀", () => {
    const m = aliasMap("select * from aier.bd_material a, org_orgs o where a.pk_org = o.pk_org");
    expect(m.get("a")).toBe("bd_material");
    expect(m.get("o")).toBe("org_orgs");
  });

  it("没有别名时表名映射到自己", () => {
    expect(aliasMap("update bd_material set code = 1").get("bd_material")).toBe("bd_material");
    expect(tablesIn("select * from a x join b y on 1=1")).toEqual(["a", "b"]);
  });
});

describe("completionContext", () => {
  it("别名后的点补字段", () => {
    expect(completionContext("select m.na")).toEqual({ kind: "column", qualifier: "m", prefix: "na" });
  });

  it("from / join 后补表名", () => {
    expect(completionContext("select * from bd_ma")).toEqual({ kind: "table", prefix: "bd_ma" });
    expect(completionContext("select * from a x, ")).toEqual({ kind: "table", prefix: "" });
    expect(completionContext("select * from a x left join ")).toEqual({ kind: "table", prefix: "" });
  });

  it("其它位置什么都补", () => {
    expect(completionContext("select co").kind).toBe("any");
  });
});
