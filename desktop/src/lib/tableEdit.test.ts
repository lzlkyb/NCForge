import { describe, expect, it } from "vitest";
import { pageSql, stripPage, updateSql, PAGE } from "./tableEdit";

const cols = [
  { name: "PK_ID", type: "CHAR(20)", precision: 20, scale: 0 },
  { name: "NAME", type: "VARCHAR2(40)", precision: 40, scale: 0 },
  { name: "QTY", type: "NUMBER(28,8)", precision: 28, scale: 8 },
];

describe("表页分页", () => {
  it("第二页多取一行判断下一页", () => {
    const s = pageSql("bd_x", "dr = 0", "pk_id", 1);
    expect(s).toContain("where dr = 0 order by pk_id");
    expect(s).toContain(`rownum <= ${PAGE * 2 + 1}`);
    expect(s).toContain(`RN__ > ${PAGE}`);
  });

  it("去掉行号列", () => {
    const r = stripPage([...cols, { name: "RN__", type: "NUMBER", precision: 0, scale: 0 }], [["1", "a", "2", "1"]]);
    expect(r.columns).toHaveLength(3);
    expect(r.rows[0]).toEqual(["1", "a", "2"]);
    expect(r.hasNext).toBe(false);
  });
});

describe("写回 SQL", () => {
  it("同一行的改动合并，用主键定位，数字不加引号", () => {
    const changed = new Map<string, string | null>([["0:1", "b'c"], ["0:2", "3"], ["1:1", null]]);
    const out = updateSql("BD_X", cols, [["k1", "a", "1"], ["k2", "x", "2"]], ["PK_ID"], changed);
    expect(out).toEqual([
      "update bd_x set name = 'b''c', qty = 3 where pk_id = 'k1'",
      "update bd_x set name = null where pk_id = 'k2'",
    ]);
  });

  it("没有主键不生成", () => {
    expect(updateSql("t", cols, [["k", "a", "1"]], [], new Map([["0:1", "b"]]))).toEqual([]);
  });
});
