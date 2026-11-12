import { describe, expect, it } from "vitest";
import { columnHover, keywordHover, tableHover } from "./sqlHoverText";
import type { ColumnInfo } from "./dbApi";

const col = (patch: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name: "CODE", type: "VARCHAR2", size: 40, full: "VARCHAR2(40)", nullable: false, pk: true, default: null, comment: null, zh: "物料编码", ...patch,
});

describe("表名悬停", () => {
  it("带 NC 中文名、类型与字段数", () => {
    const text = tableHover({ name: "bd_material", zh: "物料主档", kind: "TABLE", columns: 87, loaded: true });
    expect(text).toContain("bd_material");
    expect(text).toContain("物料主档");
    expect(text).toContain("表 · 87 个字段");
    expect(text).toContain("Ctrl+点击");
  });

  it("结构没加载就说没加载，不能空着让人以为没有字段", () => {
    const text = tableHover({ name: "bd_material", loaded: false });
    expect(text).toContain("结构还没加载");
    expect(text).not.toContain("个字段");
  });

  it("知道它是表、但结构没加载时，两句话都要有", () => {
    // `kind` 通常总是有值：写成 else-if 的话「结构还没加载」永远不显示
    const text = tableHover({ name: "bd_material", kind: "TABLE", loaded: false });
    expect(text).toContain("表");
    expect(text).toContain("结构还没加载");
  });

  it("视图不写成表", () => {
    expect(tableHover({ name: "v_mat", kind: "VIEW", columns: 3, loaded: true })).toContain("视图 · 3 个字段");
  });
});

describe("字段悬停", () => {
  it("类型、中文名、主键与可空", () => {
    const text = columnHover(col(), "bd_material");
    expect(text).toContain("CODE");
    expect(text).toContain("VARCHAR2(40)");
    expect(text).toContain("物料编码");
    expect(text).toContain("主键");
    expect(text).toContain("不可空");
    expect(text).toContain("来自 `bd_material`");
  });

  it("普通可空列不出现「主键」", () => {
    const text = columnHover(col({ pk: false, nullable: true, zh: null }));
    expect(text).not.toContain("主键");
    expect(text).toContain("可为空");
    // 没有中文名就整段不渲染，不写占位
    expect(text).not.toContain("· ");
  });

  it("注释与默认值", () => {
    const text = columnHover(col({ comment: "物料唯一编码", default: "'X'" }));
    expect(text).toContain("物料唯一编码");
    expect(text).toContain("默认 'X'");
  });
});

describe("关键字悬停", () => {
  it("常用关键字给一句话，且大小写无关", () => {
    expect(keywordHover("delete")).toContain("删已有行");
    expect(keywordHover("DELETE")).toContain("整张表");
    expect(keywordHover("rowid")).toContain("物理地址");
  });

  it("不收的关键字不弹空卡片", () => {
    expect(keywordHover("ASDF")).toBeNull();
  });
});
