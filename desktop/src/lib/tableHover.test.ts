import { describe, expect, it } from "vitest";
import { agoText, buildTableHover, columnForTable, inStringLiteral, wordAt } from "./tableHover";
import type { TableLookup } from "./tableLookup";

describe("wordAt", () => {
  it("光标在词中间取整个词", () => {
    const line = `    sb.append(" pam_status where dr = 0");`;
    const at = line.indexOf("pam_status") + 4;
    expect(wordAt(line, at + 1)).toBe("pam_status");
  });

  it("光标在词首与词尾都能取到", () => {
    const line = "pam_equip";
    expect(wordAt(line, 1)).toBe("pam_equip");
    expect(wordAt(line, line.length + 1)).toBe("pam_equip");
  });

  it("中间有下划线不断开", () => {
    expect(wordAt("a.pk_used_status = 1", 5)).toBe("pk_used_status");
  });

  it("空白处返回空串", () => {
    expect(wordAt("a  b", 3)).toBe("");
  });
});

describe("inStringLiteral", () => {
  it("两个引号之间算在字符串里", () => {
    const line = `    String s = " select * from fa_card ";`;
    expect(inStringLiteral(line, line.indexOf("from") + 1)).toBe(true);
  });

  it("引号外不算", () => {
    const line = `    String s = dao.query("x"); // from fa_card`;
    expect(inStringLiteral(line, line.indexOf("fa_card"))).toBe(false);
  });

  it("转义的引号不切换状态", () => {
    const line = `    String s = "a \\" b from fa_card ";`;
    expect(inStringLiteral(line, line.indexOf("fa_card") + 1)).toBe(true);
  });

  it("没有引号时一律在字符串外", () => {
    expect(inStringLiteral("// from fa_card", 10)).toBe(false);
  });
});

describe("columnForTable", () => {
  it("带别名时能用别名找列", () => {
    const line = `    String sql = " select e.pk_used_status from pam_equip e where e.dr = 0 ";`;
    expect(columnForTable(line, "pam_equip")).toBe("pk_used_status");
  });

  it("as 别名也认", () => {
    const line = `"select x.code from bd_material as x"`;
    expect(columnForTable(line, "bd_material")).toBe("code");
  });

  it("没有别名时用表名找列", () => {
    const line = `"select fa_card.asset_code from fa_card"`;
    expect(columnForTable(line, "fa_card")).toBe("asset_code");
  });

  it("where 不会被当成别名", () => {
    const line = `"select * from pam_equip where 1=1"`;
    expect(columnForTable(line, "pam_equip")).toBeNull();
  });

  it("表名不匹配不硬凑", () => {
    const line = `"select e.x from other_table e"`;
    expect(columnForTable(line, "pam_equip")).toBeNull();
  });

  it("大小写不敏感", () => {
    const line = `"select E.PK_EQUIP from PAM_EQUIP E"`;
    expect(columnForTable(line, "pam_equip")).toBe("PK_EQUIP");
  });
});

describe("agoText", () => {
  it("一分钟内是刚刚", () => {
    expect(agoText(0)).toBe("刚刚");
    expect(agoText(59)).toBe("刚刚");
  });

  it("分钟与小时与天", () => {
    expect(agoText(60)).toBe("1 分钟前");
    expect(agoText(3599)).toBe("59 分钟前");
    expect(agoText(3600)).toBe("1 小时前");
    expect(agoText(86400 * 2)).toBe("2 天前");
  });
});

describe("buildTableHover", () => {
  const mk = (cols: { name: string; type: string }[], age = "2 小时前"): TableLookup => ({
    has: (t) => t.toLowerCase() === "pam_equip",
    columns: async () => cols,
    cacheAge: () => age,
  });

  const line = `    String sql = " select e.pk_used_status from pam_equip e where e.dr = 0 ";`;
  const at = line.indexOf("pam_equip") + 2;

  it("命中表名时给出词的范围与字段表", async () => {
    const r = await buildTableHover(line, at, mk([
      { name: "pk_equip", type: "CHAR(20)" },
      { name: "pk_used_status", type: "CHAR(20)" },
    ]));
    expect(r).not.toBeNull();
    expect(line.slice(r!.start, r!.end)).toBe("pam_equip");
    expect(r!.markdown).toContain("| `pk_used_status` | CHAR(20) |");
    expect(r!.markdown).toContain("2 个字段");
  });

  it("同句里被点出来的列排最前", async () => {
    const r = await buildTableHover(line, at, mk([
      { name: "pk_equip", type: "CHAR(20)" },
      { name: "pk_used_status", type: "CHAR(20)" },
    ]));
    const order = r!.markdown.indexOf("pk_used_status") < r!.markdown.indexOf("pk_equip");
    expect(order).toBe(true);
  });

  it("字段多于上限时写明还有几个", async () => {
    const cols = Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, type: "NUMBER" }));
    const r = await buildTableHover(line, at, mk(cols));
    expect(r!.markdown).toContain("还有 8 个字段");
  });

  it("不在字符串里不弹", async () => {
    const code = `    String pam_equip = dao.get();`;
    expect(await buildTableHover(code, 12, mk([]))).toBeNull();
  });

  it("不是表名不弹", async () => {
    expect(await buildTableHover(line, line.indexOf("String") + 2, mk([]))).toBeNull();
  });

  it("拿不到字段不弹", async () => {
    const lookup: TableLookup = { has: () => true, columns: async () => null, cacheAge: () => "" };
    expect(await buildTableHover(line, at, lookup)).toBeNull();
  });

  it("没有缓存时间就不写那一行", async () => {
    const r = await buildTableHover(line, at, mk([{ name: "dr", type: "NUMBER" }], ""));
    expect(r!.markdown).not.toContain("表结构缓存");
  });
});
