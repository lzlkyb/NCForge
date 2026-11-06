import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Cell, ColumnMeta } from "./dbApi";
import {
  defaultTransferOptions, serializeTransfer, transferExtension, transferJsonKeys, transferMime, validateTransfer,
  type TransferData, type TransferFormat, type TransferOptions,
} from "./resultTransfer";
import { transferSqlLiteral } from "./resultTransferSql";
import { selectionText } from "./dbResultTools";

const column = (name: string, type = "VARCHAR2(80)"): ColumnMeta => ({ name, type, precision: 0, scale: 0 });
const columns = [column("ID"), column("AMOUNT", "NUMBER(28,18)"), column("TEXT"), column("STAMP", "TIMESTAMP(9)")];
const sample: TransferData = {
  columns,
  rows: [["00012345678901234567890", "1234567890.123456789012345678", "中文\t引号\"\r\n第二行", "2026-11-06 08:09:10.123456789"], ["00002", "12.5", "", null]],
};
const options = (format: TransferFormat, extra: Partial<TransferOptions> = {}): TransferOptions => ({ ...defaultTransferOptions(format), bom: false, ...extra });

const sharedFixtures = JSON.parse(readFileSync(new URL("../../src-tauri/tests/fixtures/db-transfer/格式样本.json", import.meta.url), "utf8")) as {
  version: number;
  cases: { name: string; data: TransferData; options: TransferOptions; expected: string }[];
};
describe("TS / Rust 共享格式样本", () => {
  it.each(sharedFixtures.cases)("$name", sample => {
    expect(validateTransfer(sample.data, sample.options)).toBeNull();
    expect(serializeTransfer(sample.data, sample.options)).toBe(sample.expected);
  });
});

describe("统一格式输出", () => {
  it("TSV 引用制表符和换行，保留 NULL 与空串的区别", () => {
    const data = { columns: [column("TEXT"), column("EMPTY")], rows: [["a\tb\n\"c", null], ["", ""]] };
    expect(serializeTransfer(data, options("tsv", { nullText: "\\N", spreadsheetSafe: false }))).toBe('TEXT\tEMPTY\n"a\tb\n""c"\t\\N\n\t');
  });

  it("CSV 对表头和值统一转义并防护公式，机器交换模式保持原文", () => {
    const data = { columns: [column("=HEADER"), column("A;B")], rows: [[" \t@SUM(A1)", "x;\"y\n中文"]] };
    expect(serializeTransfer(data, options("csv", { delimiter: ";" }))).toBe('"\'=HEADER";"A;B"\r\n"\' \t@SUM(A1)";"x;""y\n中文"');
    expect(serializeTransfer(data, options("csv", { spreadsheetSafe: false, delimiter: ";" }))).toBe('=HEADER;"A;B"\r\n \t@SUM(A1);"x;""y\n中文"');
  });

  it("Excel 预设将前导零和超出 15 位的数值写文本，保留普通负数", () => {
    const data = { columns: [column("CODE"), column("LONG"), column("DECIMAL"), column("N")], rows: [["0010", "12345678901234567890", "0.123456789012345678", "-12.5"]] };
    expect(serializeTransfer(data, options("csv", { header: "none" }))).toBe('"\'0010","\'12345678901234567890","\'0.123456789012345678",-12.5');
    expect(serializeTransfer(data, options("csv", { header: "none", spreadsheetSafe: false }))).toBe("0010,12345678901234567890,0.123456789012345678,-12.5");
  });

  it("选列与列顺序在所有文本格式中保持一致，JSON 与 SQL 保留技术名", () => {
    const selected = { columnIndices: [2, 0], columnLabels: ["编号", "金额", "说明"], header: "zh" as const, spreadsheetSafe: false };
    const json = JSON.parse(serializeTransfer(sample, options("json", selected)));
    expect(Object.keys(json[0])).toEqual(["TEXT", "ID"]);
    expect(json[0].ID).toBe("00012345678901234567890");
    expect(serializeTransfer(sample, options("csv", selected)).startsWith("说明,编号\r\n")).toBe(true);
    expect(serializeTransfer(sample, options("markdown", selected)).startsWith("| 说明 | 编号 |")).toBe(true);
    expect(serializeTransfer(sample, options("html", selected)).startsWith('<meta charset="utf-8"><table><thead><tr><th>说明</th><th>编号</th>')).toBe(true);
    expect(serializeTransfer(sample, options("insert", { ...selected, table: "T" }))).toContain("INSERT INTO T (TEXT, ID)");
  });

  it("双行表头和转置按原始列索引读取中文标签", () => {
    const data = { columns: [column("A"), column("B")], rows: [["1", "2"]] };
    expect(serializeTransfer(data, options("tsv", { header: "both", columnLabels: ["甲", "乙"], columnIndices: [1, 0] }))).toBe("B\tA\n乙\t甲\n2\t1");
    expect(serializeTransfer(data, options("tsv", { transpose: true, columnIndices: [1, 0] }))).toBe("B\t2\nA\t1");
  });

  it("旧选区复制与共享 TSV 使用同样的引用、公式和长编码保护", () => {
    const rows = [["hidden", "0012345678901234567890", "a\tb\n\"c"], ["hidden", "@SUM(A1)", null]];
    const selected = selectionText(rows, [1, 0], [2, 1], { anchor: { r: 1, c: 2 }, end: { r: 0, c: 1 } });
    const data = { columns: [column("TEXT"), column("ID")], rows: [[null, "@SUM(A1)"], ["a\tb\n\"c", "0012345678901234567890"]] };
    expect(selected).toBe(serializeTransfer(data, options("tsv", { header: "none", lineEnding: "crlf" })));
  });

  it("JSON 保持长主键、高精度小数、NULL、空串及时间的小数秒", () => {
    const rows = JSON.parse(serializeTransfer(sample, options("json")));
    expect(rows[0]).toEqual({ ID: "00012345678901234567890", AMOUNT: "1234567890.123456789012345678", TEXT: "中文\t引号\"\r\n第二行", STAMP: "2026-11-06 08:09:10.123456789" });
    expect(rows[1]).toEqual({ ID: "00002", AMOUNT: 12.5, TEXT: "", STAMP: null });
  });

  it("安全整数可转 JSON 数字，不安全整数、前导零和下溢小数保持字符串", () => {
    const data = { columns: [column("N", "NUMBER")], rows: [["9007199254740991"], ["9007199254740992"], ["0010"], ["1e-999"], ["0.123456789012345"]] };
    expect(JSON.parse(serializeTransfer(data, options("json")))).toEqual([{ N: 9007199254740991 }, { N: "9007199254740992" }, { N: "0010" }, { N: "1e-999" }, { N: 0.123456789012345 }]);
    expect(validateTransfer({ columns: data.columns, rows: [[9007199254740992]] }, options("json"))).toContain("安全精度");
    expect(validateTransfer({ columns: data.columns, rows: [[Infinity]] }, options("json"))).toContain("安全精度");
  });

  it("重复 JSON 列名不会覆盖已有带后缀的字段", () => {
    const names = ["ID", "ID", "ID_2", "ID", "__proto__"];
    const data = { columns: names.map(name => column(name)), rows: [["a", "b", "c", "d", "e"]] };
    expect(transferJsonKeys(data.columns)).toEqual(["ID", "ID_3", "ID_2", "ID_4", "__proto__"]);
    expect(JSON.parse(serializeTransfer(data, options("json")))[0]).toEqual({ ID: "a", ID_3: "b", ID_2: "c", ID_4: "d", ["__proto__"]: "e" });
    expect(JSON.parse(serializeTransfer(data, options("json", { jsonStructure: "columns" })))).toEqual({ columns: names, rows: data.rows });
  });

  it("JSONL 每行可独立解析，支持列结构、CRLF，空结果为零行", () => {
    const jsonl = serializeTransfer(sample, options("jsonl", { lineEnding: "crlf" }));
    expect(jsonl.split("\r\n").map(line => JSON.parse(line))[1].AMOUNT).toBe(12.5);
    const lines = serializeTransfer(sample, options("jsonl", { jsonStructure: "columns" })).split("\n").map(line => JSON.parse(line));
    expect(lines[0].columns).toEqual(columns.map(c => c.name));
    expect(lines[0].row[1]).toBe("1234567890.123456789012345678");
    expect(serializeTransfer({ columns, rows: [] }, options("jsonl"))).toBe("");
  });

  it("HTML 转义脚本、属性、引号并保留换行，查询只进入转义后的标题", () => {
    const data = { columns: [column('<img src="x">')], rows: [["<script>alert('x')</script>&\n下一行"]], query: "select '<unsafe>'" };
    const html = serializeTransfer(data, options("html", { includeQuery: true }));
    expect(html.startsWith('<meta charset="utf-8">')).toBe(true);
    expect(html.match(/<meta charset="utf-8">/g)).toHaveLength(1);
    expect(html).toContain("&lt;img src=&quot;x&quot;&gt;");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;<br>下一行");
    expect(html).toContain("<caption>select &#39;&lt;unsafe&gt;&#39;</caption>");
    expect(html).not.toContain("<script>");
  });

  it("Markdown 转义管道与反斜杠，统一 CR/LF 换行为 br", () => {
    const data = { columns: [column("A|B")], rows: [["x\\y|z\r\n下一行\r第三行\n<unsafe>"]] };
    expect(serializeTransfer(data, options("markdown"))).toBe("| A\\|B |\n| --- |\n| x\\\\y\\|z<br>下一行<br>第三行<br>&lt;unsafe&gt; |");
  });

  it("只为 CSV/TSV 加一次 BOM，XLSX 必须生成真实文件", () => {
    expect(serializeTransfer(sample, defaultTransferOptions("csv"))[0]).toBe("\uFEFF");
    expect(serializeTransfer(sample, options("json", { bom: true }))[0]).toBe("[");
    expect(validateTransfer(sample, options("xlsx"))).toBeNull();
    expect(() => serializeTransfer(sample, options("xlsx"))).toThrow("需要保存文件");
    expect(transferExtension("update")).toBe("sql");
    expect(transferExtension("markdown")).toBe("md");
    expect(transferMime("jsonl")).toBe("application/x-ndjson");
    expect(transferMime("xlsx")).toContain("spreadsheetml");
  });

  it("拒绝缺列、重复选择、失效索引、非法分隔符和未经证明的 NC 转换", () => {
    expect(validateTransfer({ columns: [], rows: [] }, options("tsv"))).toContain("没有");
    expect(validateTransfer(sample, options("json", { columnIndices: [5] }))).toContain("无效");
    expect(validateTransfer(sample, options("json", { columnIndices: [0, 0] }))).toContain("重复");
    expect(validateTransfer({ columns, rows: [["x"]] }, options("json"))).toContain("缺少");
    expect(validateTransfer(sample, options("csv", { delimiter: "\n" }))).toContain("分隔符");
    expect(validateTransfer(sample, options("json", { transpose: true }))).toContain("不支持转置");
    expect(validateTransfer(sample, options("insert", { table: "T", nc: true }))).toContain("迁移入口");
  });
});

describe("Oracle SQL 输出", () => {
  it("INSERT 原样写高精度数字，字符串引号转义，默认不自动提交", () => {
    const data = { columns: [column("ID"), column("N", "NUMBER")], rows: [["A'1", "12345678901234567890.123456789"]] };
    expect(serializeTransfer(data, options("insert", { table: "T", schema: "APP" }))).toBe("INSERT INTO APP.T (ID, N) VALUES ('A''1', 12345678901234567890.123456789);");
    expect(serializeTransfer(data, options("insert", { table: '"T.with.dot"' }))).toContain('INSERT INTO "T.with.dot"');
    expect(validateTransfer(data, options("insert", { table: "T; delete from T" }))).toContain("目标表名");
    expect(validateTransfer(data, options("insert", { table: "T", schema: "APP.T" }))).toContain("Schema");
    expect(validateTransfer({ columns: [column("N", "NUMBER")], rows: [["1);delete from T;"]] }, options("insert", { table: "T" }))).toContain("无法生成");
  });

  it("DATE、TIMESTAMP 小数秒和时区使用对应 Oracle 函数", () => {
    expect(transferSqlLiteral("2026-11-06", "DATE")).toBe("TO_DATE('2026-11-06', 'YYYY-MM-DD')");
    expect(transferSqlLiteral("2026-11-06 08:09:10", "DATE")).toBe("TO_DATE('2026-11-06 08:09:10', 'YYYY-MM-DD HH24:MI:SS')");
    expect(transferSqlLiteral("2026-11-06T08:09:10.123456789", "TIMESTAMP(9)")).toBe("TO_TIMESTAMP('2026-11-06 08:09:10.123456789', 'YYYY-MM-DD HH24:MI:SS.FF')");
    expect(transferSqlLiteral("2026-11-06 08:09:10.123+08:00", "TIMESTAMP WITH TIME ZONE")).toBe("TO_TIMESTAMP_TZ('2026-11-06 08:09:10.123 +08:00', 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM')");
    expect(transferSqlLiteral("2026-11-06T08:09:10Z", "TIMESTAMP WITH TIME ZONE")).toContain("+00:00");
  });

  it("IN 去重并拆 Oracle 1000 项，NOT IN 用 AND 连接，空值策略显式", () => {
    const data = { columns: [column("ID", "NUMBER")], rows: [...Array.from({ length: 1001 }, (_, i): Cell[] => [String(i)]), ["0"], [null]] };
    const include = serializeTransfer(data, options("where", { includeNull: true }));
    expect(include).toContain("\nOR ID IN (1000)\nOR ID IS NULL");
    expect(include.match(/ID IN \(/g)).toHaveLength(2);
    const exclude = serializeTransfer(data, options("where", { condition: "notIn", includeNull: true }));
    expect(exclude).toContain("\nAND ID NOT IN (1000)\nAND ID IS NOT NULL");
    expect(exclude).not.toContain(" OR ");
    expect(serializeTransfer({ columns: data.columns, rows: [[null]] }, options("where"))).toBe("1 = 0");
    expect(serializeTransfer({ columns: data.columns, rows: [[null]] }, options("where", { includeNull: true }))).toBe("ID IS NULL");
    expect(serializeTransfer({ columns: data.columns, rows: [[null]] }, options("where", { condition: "notIn", includeNull: true }))).toBe("ID IS NOT NULL");
  });

  it("多列 WHERE 的 NULL 使用 IS NULL，行内 AND、行间 OR", () => {
    const data = { columns: [column("A"), column("B")], rows: [["x'1", null], ["", "y"], ["x'1", null]] };
    expect(serializeTransfer(data, options("where", { condition: "where" }))).toBe("WHERE (A = 'x''1' AND B IS NULL)\nOR (A IS NULL AND B = 'y')");
    expect(validateTransfer(data, options("where"))).toContain("只能选择一列");
  });

  it("UPDATE 的键绑定原始完整列索引，SET 用编辑值，原始键用于 WHERE", () => {
    const data = { columns: [column("NOTE"), column("ID"), column("AMOUNT", "NUMBER")], originalRows: [["old", "00012345678901234567890", "1"]], rows: [["new'v", "changed", "2.123456789012345678"]] };
    const config = options("update", { table: "T", keys: [1], keysConfirmed: true, columnIndices: [2, 0] });
    expect(serializeTransfer(data, config)).toBe("UPDATE T SET AMOUNT = 2.123456789012345678, NOTE = 'new''v' WHERE ID = '00012345678901234567890';");
    expect(serializeTransfer(data, { ...config, columnIndices: [1] })).toBe("UPDATE T SET ID = 'changed' WHERE ID = '00012345678901234567890';");
  });

  it("UPDATE 拒绝未确认的键、缺少原始值、NULL/重复键或没有更新字段", () => {
    const data = { columns: [column("ID", "NUMBER"), column("VALUE")], rows: [["1", "new"]], originalRows: [["1", "old"]] };
    const config = options("update", { table: "T", keys: [0], keysConfirmed: true });
    expect(validateTransfer(data, { ...config, keysConfirmed: false })).toContain("确认唯一键");
    expect(validateTransfer(data, { ...config, keys: [5] })).toContain("索引无效");
    expect(validateTransfer({ ...data, originalRows: undefined }, config)).toContain("原始值");
    expect(validateTransfer({ ...data, originalRows: [[null, "old"]] }, config)).toContain("NULL");
    expect(validateTransfer({ ...data, rows: [["1", "new"], ["1.00", "newer"]], originalRows: [["1", "old"], ["1.00", "older"]] }, config)).toContain("键值重复");
    expect(validateTransfer(data, { ...config, columnIndices: [0] })).toContain("没有可更新");
    expect(validateTransfer({ ...data, originalRows: [["oops", "old"]] }, config)).toContain("原始键值无法");
  });

  it("仅显式提交间隔追加 COMMIT，原始查询每行作为注释", () => {
    const data = { columns: [column("ID")], rows: [["a"], ["b"], ["c"]], query: "select ID\nfrom T; -- source" };
    const sql = serializeTransfer(data, options("insert", { table: "T", commitEvery: 2, includeQuery: true }));
    expect(sql.startsWith("-- select ID\n-- from T; -- source\n")).toBe(true);
    expect(sql.match(/COMMIT;/g)).toHaveLength(2);
    expect(serializeTransfer(data, options("insert", { table: "T" }))).not.toContain("COMMIT");
  });
});
