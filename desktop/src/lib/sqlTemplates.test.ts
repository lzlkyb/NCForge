import { describe, expect, it } from "vitest";
import {
  getSqlTemplatesEnabled,
  setSqlTemplatesEnabled,
  snippetEscape,
  subscribeSqlTemplates,
  tableTemplates,
} from "./sqlTemplates";

describe("表名 → 整条查询模板", () => {
  it("默认给三条：整条查询、只数行数、锁定行", () => {
    const list = tableTemplates("bd_material", true);
    expect(list.map((t) => t.label)).toEqual([
      "SELECT * FROM bd_material",
      "SELECT COUNT(*) FROM bd_material",
      "SELECT * FROM bd_material FOR UPDATE",
    ]);
    // 落点固定在语句末尾，插入后光标就在能继续敲的地方
    expect(list.every((t) => t.insertText.endsWith(";$0"))).toBe(true);
  });

  it("关键字大小写跟格式化偏好", () => {
    expect(tableTemplates("bd_material", false)[0].insertText).toBe("select * from bd_material;$0");
    expect(tableTemplates("bd_material", false)[2].insertText).toBe(
      "select * from bd_material for update;$0",
    );
  });

  it("tsql 不给 FOR UPDATE——SQL Server 要写 WITH (UPDLOCK)，照抄会直接报错", () => {
    expect(tableTemplates("t", true, "tsql")).toHaveLength(2);
    expect(tableTemplates("t", true, "plsql")).toHaveLength(3);
  });

  it("带引号/元字符的表名不会破坏 snippet", () => {
    const quoted = tableTemplates('"Item$X}"', true)[0];
    // `$` 与 `}` 是 Monaco snippet 的元字符，必须转义成字面量
    expect(quoted.insertText).toBe('SELECT * FROM "Item\\$X\\}";$0');
    expect(snippetEscape("a\\b")).toBe("a\\\\b");
  });
});

describe("模板开关", () => {
  it("默认开，切换后立刻生效并广播", () => {
    expect(getSqlTemplatesEnabled()).toBe(true);
    let calls = 0;
    const off = subscribeSqlTemplates(() => calls++);
    setSqlTemplatesEnabled(false);
    expect(getSqlTemplatesEnabled()).toBe(false);
    expect(calls).toBe(1);
    off();
    setSqlTemplatesEnabled(true);
    expect(calls).toBe(1);
    expect(getSqlTemplatesEnabled()).toBe(true);
  });
});
