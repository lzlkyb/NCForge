import { describe, expect, it } from "vitest";
import {
  dedupeNames,
  dictDocOf,
  scopeEmpty,
  scopeFilter,
  scopeLabel,
  sqlTables,
  stampText,
  type MdDictOut,
  type Scope,
} from "./mdDict";

/**
 * 数据字典的纯函数。
 *
 * 重点在两处「错了也不报错」的地方：
 * ① `sqlTables` 漏表 —— 补丁涉及的表少读一张，字典就缺一张表的中文名，而人不会发现；
 * ② `scopeFilter` 把两路条件混着发 —— 后端取交集，勾了 20 张只出 5 张，无从解释。
 */

const names = (sql: string) => sqlTables([sql]).map((t) => t.name);

describe("sqlTables 认得出各种 DML", () => {
  it("from / join，含子查询", () => {
    expect(
      names("select * from bd_material m left join bd_marbasclass c on m.pk=c.pk"),
    ).toEqual(["bd_material", "bd_marbasclass"]);
    // from 后面是括号时不匹配，但内层的 from 要照常命中
    expect(names("select * from (select * from bd_material) t")).toEqual(["bd_material"]);
  });

  it("update / insert into / merge into / truncate / alter", () => {
    expect(names("update bd_billtype set enablestate = 2 where pk_billtype = 'x'")).toEqual([
      "bd_billtype",
    ]);
    expect(names("insert into bd_billtype_b (pk) values ('1')")).toEqual(["bd_billtype_b"]);
    expect(names("merge into ic_onhanddim t using (...) s on (1=1)")).toEqual(["ic_onhanddim"]);
    expect(names("truncate table tmp_check_1102")).toEqual(["tmp_check_1102"]);
    expect(names("alter table bd_material add (vdef1 varchar2(50))")).toEqual(["bd_material"]);
    // delete 靠 from 捕获
    expect(names("delete from bd_deptdoc where 1=1")).toEqual(["bd_deptdoc"]);
  });

  it("`for update` 不是 DML，别把 nowait 当表名", () => {
    expect(names("select * from bd_material where 1=1 for update nowait")).toEqual([
      "bd_material",
    ]);
    // 大写同理
    expect(names("select 1 from bd_material FOR UPDATE")).toEqual(["bd_material"]);
  });

  it("schema 前缀取末段，dual 不算表", () => {
    expect(names("select * from aier.bd_material")).toEqual(["bd_material"]);
    expect(names("select sysdate from dual")).toEqual([]);
  });
});

describe("sqlTables 不把注释与字符串里的表名算进去", () => {
  it("行注释 / 块注释都剥掉", () => {
    expect(names("-- 参考 from bd_fake\nselect * from bd_material")).toEqual(["bd_material"]);
    expect(names("/* update bd_fake set a=1 */ select * from bd_material")).toEqual([
      "bd_material",
    ]);
  });

  it("单引号字面量里的语句不算", () => {
    // 动态拼 SQL 在补丁脚本里很常见
    expect(
      names("execute immediate 'select * from bd_hidden'; select * from bd_material"),
    ).toEqual(["bd_material"]);
  });

  it("两个连续单引号是转义，不会提前结束字面量", () => {
    expect(names("select * from bd_material where name = 'it''s from bd_x'")).toEqual([
      "bd_material",
    ]);
  });
});

describe("sqlTables 的段落归属", () => {
  it("记下是从第几段 SQL 扫到的", () => {
    const r = sqlTables(["select * from bd_a", "update bd_b set x=1"]);
    expect(r).toEqual([
      { name: "bd_a", fromSql: 1 },
      { name: "bd_b", fromSql: 2 },
    ]);
  });

  it("跨段重复只留第一次（大小写不敏感）", () => {
    const r = sqlTables(["select * from bd_a", "UPDATE BD_A SET x=1", "select * from bd_b"]);
    expect(r).toEqual([
      { name: "bd_a", fromSql: 1 },
      { name: "bd_b", fromSql: 3 },
    ]);
  });

  it("空输入不炸", () => {
    expect(sqlTables([])).toEqual([]);
    expect(sqlTables(["", "   "])).toEqual([]);
  });
});

describe("Scope 三入口只发一路条件", () => {
  it("勾选只带 names，不带前缀与关键词", () => {
    const f = scopeFilter({ kind: "picked", names: ["BD_Material", "bd_billtype", " "] });
    expect(f).toEqual({ names: ["BD_Material", "bd_billtype"], prefix: "", keyword: "" });
  });

  it("前缀只带 prefix，names 为空（否则后端会取交集）", () => {
    const f = scopeFilter({ kind: "prefix", prefix: " bd_ " });
    expect(f).toEqual({ names: [], prefix: "bd_", keyword: "" });
  });

  it("补丁涉及落到 names", () => {
    const f = scopeFilter({ kind: "patch", names: ["bd_a", "bd_b"] });
    expect(f.names).toEqual(["bd_a", "bd_b"]);
    expect(f.prefix).toBe("");
  });

  it("空的判得出来", () => {
    const cases: [Scope, boolean][] = [
      [{ kind: "picked", names: [] }, true],
      [{ kind: "picked", names: ["  "] }, true],
      [{ kind: "picked", names: ["bd_a"] }, false],
      [{ kind: "prefix", prefix: "" }, true],
      [{ kind: "prefix", prefix: "  " }, true],
      [{ kind: "prefix", prefix: "bd_" }, false],
      [{ kind: "patch", names: [] }, true],
    ];
    for (const [s, empty] of cases) expect(scopeEmpty(s)).toBe(empty);
  });

  it("摘要读得懂", () => {
    expect(scopeLabel({ kind: "picked", names: ["a", "b"] })).toBe("2 张表");
    expect(scopeLabel({ kind: "prefix", prefix: "bd_" })).toBe("前缀 bd_");
    expect(scopeLabel({ kind: "picked", names: [] })).toBe("还没选表");
  });
});

describe("dedupeNames", () => {
  it("去空、大小写不敏感去重、保留首次写法", () => {
    expect(dedupeNames([" bd_A ", "BD_a", "", "bd_b", "bd_b"])).toEqual(["bd_A", "bd_b"]);
  });
});

describe("导出请求", () => {
  it("时间戳固定补零，格式是能直接进文件名的 YYYY-MM-DD HH:mm", () => {
    expect(stampText(new Date(2026, 10, 2, 9, 5))).toBe("2026-11-02 09:05");
    // 12 月、23 点：别出现 2026-12-1 这种少一位的
    expect(stampText(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31 23:59");
  });

  it("打包时把 selection / source 一起带上，时间可注入", () => {
    const data = {
      tables: [{ name: "bd_material" }],
      tableCount: 1,
      columnCount: 2,
      columnsWithoutName: 0,
      missing: [],
      selection: "前缀 bd_",
      source: "nc@db",
      elapsedMs: 10,
    } as unknown as MdDictOut;
    const doc = dictDocOf(data, "2026-11-02 12:20");
    expect(doc.generated).toBe("2026-11-02 12:20");
    expect(doc.selection).toBe("前缀 bd_");
    expect(doc.source).toBe("nc@db");
    // 必须是同一个数组引用：导出的是屏幕上这一份，不重新查
    expect(doc.tables).toBe(data.tables);
  });
});
