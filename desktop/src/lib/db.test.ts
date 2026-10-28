import { describe, expect, it } from "vitest";
import {
  cellText,
  friendlyDbError,
  isNumericType,
  oraCode,
  parseDbError,
  precheckSql,
  similarTables,
  splitJdbcUrl,
  tableRefs,
  thousands,
  toTsv,
  type DbColumn,
} from "./db";

/**
 * 数据库页的纯函数。
 *
 * 重点是两处「说错话代价很大」的地方：
 * - `precheckSql` 只该挡手滑，**不能**把合法查询挡在外面（用户会以为面板坏了）；
 * - `similarTables` 推荐的必须真的像，否则用户会照着一个错表名再错一次。
 */

describe("parseDbError / friendlyDbError", () => {
  it("拆出四个已知码", () => {
    expect(parseDbError("auth|ORA 1017：用户名/口令无效").code).toBe("auth");
    expect(parseDbError("unreachable|ORA-12541: TNS:no listener").code).toBe("unreachable");
    expect(parseDbError("sql|ORA 942：表或视图不存在").code).toBe("sql");
    expect(parseDbError("need-password|还没输入数据库密码").code).toBe("need-password");
  });

  it("不认识的码整体当消息", () => {
    expect(parseDbError("boom|坏了")).toEqual({ code: "other", message: "boom|坏了" });
    expect(parseDbError(undefined).code).toBe("other");
  });

  it("auth / unreachable 给人话，sql 保留原文（要 ORA 号）", () => {
    expect(friendlyDbError("auth|x")).toContain("口令");
    expect(friendlyDbError("unreachable|x")).toContain("VPN");
    expect(friendlyDbError("sql|ORA-00942: 表或视图不存在")).toBe("ORA-00942: 表或视图不存在");
  });
});

describe("oraCode", () => {
  it("抠出 ORA 号并大写", () => {
    expect(oraCode("ORA 1017：ora-01017: 用户名/口令无效")).toBe("ORA-01017");
    expect(oraCode("没有任何错误号")).toBeNull();
  });
});

describe("tableRefs", () => {
  it("取 from / join 后的表名，兼容 schema 前缀", () => {
    expect(tableRefs("select * from bd_material m left join aier.bd_marbasclass c on 1=1")).toEqual([
      "bd_material",
      "bd_marbasclass",
    ]);
  });

  it("子查询里的 from 也算", () => {
    expect(tableRefs("select * from (select * from bd_material) t")).toEqual(["bd_material"]);
  });
});

describe("similarTables", () => {
  const known = ["bd_material", "bd_materialstock", "bd_marbasclass", "org_dept", "ic_general_h"];

  it("多打了个字母 → 推出去掉它的那个", () => {
    expect(similarTables("select * from bd_materialx", known)[0]).toBe("bd_material");
  });

  it("截断了 → 两个候选都给（短的在前，长的在后）", () => {
    const got = similarTables("select * from bd_material_st", known);
    expect(got[0]).toBe("bd_material");
    expect(got).toContain("bd_materialstock");
  });

  it("完全不相干时不给建议（宁可不推，也别推错）", () => {
    expect(similarTables("select * from zzz_nothing_here", known)).toEqual([]);
  });

  it("表名写对时不推自己（说明不是这类错误）", () => {
    expect(similarTables("select * from bd_material", known)).toEqual([]);
  });

  it("SQL 里没有表名就无从推荐", () => {
    expect(similarTables("select 1 from dual", known)).toEqual([]);
  });
});

describe("precheckSql", () => {
  it("放行单条 select / with（含末尾分号）", () => {
    expect(precheckSql("select 1 from dual")).toBeNull();
    expect(precheckSql("  SELECT * FROM bd_material;  ")).toBeNull();
    expect(precheckSql("with t as (select 1 from dual) select * from t")).toBeNull();
  });

  it("注释不影响判断", () => {
    expect(precheckSql("-- 查物料\nselect * from bd_material")).toBeNull();
    expect(precheckSql("/* 改数据 */ update bd_material set name='x'")).toContain("update");
  });

  it("空 SQL 要拦住", () => {
    expect(precheckSql("   \n  ")).toBe("SQL 是空的");
    expect(precheckSql("-- 只有注释")).toBe("SQL 是空的");
  });

  it("写操作直接拒，并把词说给用户看", () => {
    expect(precheckSql("update bd_material set name = 'x' where code = 'CL04'")).toContain("update");
    expect(precheckSql("delete from bd_material")).toContain("delete");
  });

  it("多语句要拦住（分号只允许在末尾）", () => {
    expect(precheckSql("select 1 from dual; select 2 from dual")).toContain("单条");
    expect(precheckSql("select 1 from dual; drop table x")).toContain("单条");
  });

  it("select ... for update 交给后端判（前端不当解析器）", () => {
    // 前端刻意不拦：字符串常量里出现 for update 会造成误伤，
    // 后端的 stripLiterals 版本才是准的。
    expect(precheckSql("select * from bd_material for update")).toBeNull();
  });
});

describe("单元格与导出", () => {
  const cols: DbColumn[] = [
    { name: "PK_MATERIAL", type: "CHAR(20)" },
    { name: "MATERIALMNY", type: "NUMBER" },
    { name: "NAME", type: "VARCHAR2(300)" },
  ];

  it("NULL 与空串要能分开", () => {
    expect(cellText(null)).toBe("NULL");
    expect(cellText("")).toBe("");
    expect(cellText(0)).toBe("0");
  });

  it("超长文本截断并留标记", () => {
    expect(cellText("x".repeat(405), 400)).toBe(`${"x".repeat(400)}…`);
  });

  it("数字列按类型判断（不按值，NULL 也要右对齐）", () => {
    expect(isNumericType("NUMBER")).toBe(true);
    expect(isNumericType("NUMBER(20,4)")).toBe(true);
    expect(isNumericType("VARCHAR2(40)")).toBe(false);
  });

  it("TSV 里 NULL 写成空（粘进 Excel 才不会变成字符串 NULL）", () => {
    const tsv = toTsv(cols, [["1001A", 128, "视光镜片"], ["1001B", null, ""]]);
    expect(tsv.split("\n")).toEqual([
      "PK_MATERIAL\tMATERIALMNY\tNAME",
      "1001A\t128\t视光镜片",
      "1001B\t\t",
    ]);
  });

  it("千分位与连接串拆分", () => {
    expect(thousands(3128)).toBe("3,128");
    expect(splitJdbcUrl("jdbc:oracle:thin:@10.200.22.144:1521/aier260824")).toEqual({
      host: "10.200.22.144:1521",
      database: "aier260824",
    });
  });
});
