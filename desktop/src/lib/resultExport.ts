import type { Cell, ColumnMeta } from "./dbApi";
import { defaultTransferOptions, serializeTransfer } from "./resultTransfer";
import { transferSqlLiteral } from "./resultTransferSql";

/**
 * 结果表的「复制为…」与导出。
 *
 * 旧入口复用统一序列化引擎，TSV / CSV 默认 NULL 写空，
 * INSERT 写 `null` 关键字，IN 列表直接跳过（`in (null)` 永远不命中，放进去只会误导）。
 */

/** 数字列（按类型判断，不按值——一列里混了 NULL 也要对齐）。 */
export function isNumericType(type: string): boolean {
  return /^(NUMBER|FLOAT|INTEGER|INT|DECIMAL|NUMERIC|BINARY_DOUBLE|BINARY_FLOAT)/i.test(type);
}

/**
 * Excel / Sheets 会把以 `=` `@` 开头的格当公式执行（CSV 注入，CWE-1236）。
 * `-` `+` 只在后面不是纯数字时才算风险：负数太常见，给每个 `-1` 加撇号
 * 会把整列数字变成文本。防护方式是在值前加 `'`（Excel 的按文本处理标记）。
 * 前导空白先剥掉再判：导入器带「去前导空格」选项时 ` =1+1` 会先变成 `=1+1` 再求值。
 */
function formulaRisk(s: string): boolean {
  const t = s.replace(/^[ \t\r\n]+/, "");
  if (/^[=@]/.test(t)) return true;
  if (/^[+-]/.test(t)) return !Number.isFinite(Number(t));
  return false;
}

export const spreadsheetCell = (s: string) => (formulaRisk(s) ? `'${s}` : s);

export function toTsv(columns: ColumnMeta[], rows: Cell[][], header = true): string {
  if (!columns.length) return "";
  return serializeTransfer({ columns, rows }, { ...defaultTransferOptions("tsv"), header: header ? "name" : "none" });
}

export function toCsv(columns: ColumnMeta[], rows: Cell[][]): string {
  if (!columns.length) return "";
  // downloadText owns the BOM in this legacy file path.
  return serializeTransfer({ columns, rows }, { ...defaultTransferOptions("csv"), bom: false });
}

/** SQL 字面量：数字列不加引号，其余加单引号并转义。 */
export function sqlLiteral(v: Cell, type: string): string {
  // Keep the legacy boolean and lowercase SQL-token contract used by tableEdit.
  if (typeof v === "boolean") return `'${String(v)}'`;
  const literal = transferSqlLiteral(v, type);
  return literal === "NULL" ? "null" : literal.replace(/^TO_(?:TIMESTAMP_TZ|TIMESTAMP|DATE)/, name => name.toLowerCase());
}

export function toInsert(table: string, columns: ColumnMeta[], rows: Cell[][]): string {
  const cols = columns.map((c) => c.name).join(", ");
  return rows
    .map((r) => `insert into ${table} (${cols}) values (${r.map((v, i) => sqlLiteral(v, columns[i]?.type ?? "")).join(", ")});`)
    .join("\n");
}

/** 某一列的值拼成 `in (...)`，去重、跳过 NULL；超过 1000 个按 Oracle 限制拆成 `or col in (...)`。 */
export function toInList(columns: ColumnMeta[], rows: Cell[][], col: number): string {
  const c = columns[col];
  if (!c) return "";
  const seen = new Set<string>();
  const vals: string[] = [];
  for (const r of rows) {
    const v = r[col];
    if (v === null || v === undefined) continue;
    const lit = sqlLiteral(v, c.type);
    if (seen.has(lit)) continue;
    seen.add(lit);
    vals.push(lit);
  }
  if (vals.length === 0) return "";
  const chunks: string[] = [];
  for (let i = 0; i < vals.length; i += 1000) chunks.push(`${c.name} in (${vals.slice(i, i + 1000).join(", ")})`);
  return chunks.length === 1 ? chunks[0] : `(${chunks.join("\n or ")})`;
}

export function toMarkdown(columns: ColumnMeta[], rows: Cell[][]): string {
  if (!columns.length) return "";
  return serializeTransfer({ columns, rows }, { ...defaultTransferOptions("markdown"), nullText: "NULL" });
}

/** 从 SQL 里猜单表查询的表名（生成 INSERT 用）；猜不出给 `表名`。 */
export function guessTable(sql: string): string {
  const m = /\bfrom\s+([A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)?)/i.exec(sql);
  return m ? m[1] : "表名";
}

/** 浏览器下载一个文本文件。`bom` 只给 CSV 用（Excel 认它）；`.sql` 不能带，否则脚本头部多出不可见字符。 */
export function downloadText(name: string, text: string, mime = "text/csv", bom = true): void {
  const blob = new Blob([bom ? `﻿${text}` : text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
