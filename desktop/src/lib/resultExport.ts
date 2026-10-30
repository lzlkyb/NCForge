import type { Cell, ColumnMeta } from "./dbApi";

/**
 * 结果表的「复制为…」与导出。
 *
 * NULL 的处理每种格式各有讲究：TSV / CSV 写空（粘进 Excel 才不会变成字符串 `NULL`），
 * INSERT 写 `null` 关键字，IN 列表直接跳过（`in (null)` 永远不命中，放进去只会误导）。
 */

/** 数字列（按类型判断，不按值——一列里混了 NULL 也要对齐）。 */
export function isNumericType(type: string): boolean {
  return /^(NUMBER|FLOAT|INTEGER|INT|DECIMAL|NUMERIC|BINARY_DOUBLE|BINARY_FLOAT)/i.test(type);
}

const plain = (v: Cell) => (v === null || v === undefined ? "" : String(v));

export function toTsv(columns: ColumnMeta[], rows: Cell[][], header = true): string {
  const body = rows.map((r) => r.map((v) => plain(v).replace(/[\t\r\n]+/g, " ")).join("\t"));
  return (header ? [columns.map((c) => c.name).join("\t"), ...body] : body).join("\n");
}

function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: ColumnMeta[], rows: Cell[][]): string {
  const lines = [columns.map((c) => csvField(c.name)), ...rows.map((r) => r.map((v) => csvField(plain(v))))];
  return lines.map((l) => l.join(",")).join("\r\n");
}

/** SQL 字面量：数字列不加引号，其余加单引号并转义。 */
export function sqlLiteral(v: Cell, type: string): string {
  if (v === null || v === undefined) return "null";
  // 桥里日期统一格式化成 yyyy-MM-dd HH:mm:ss，写回 DATE 列要转回来
  if (/^(DATE|TIMESTAMP)/i.test(type) && /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(String(v))) {
    return `to_date('${v}', 'yyyy-mm-dd hh24:mi:ss')`;
  }
  if (typeof v === "number" || (isNumericType(type) && /^-?\d+(\.\d+)?$/.test(String(v)))) return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
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
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const head = `| ${columns.map((c) => esc(c.name)).join(" | ")} |`;
  const sep = `| ${columns.map((c) => (isNumericType(c.type) ? "---:" : "---")).join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map((v) => (v === null ? "NULL" : esc(String(v)))).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

/** 从 SQL 里猜单表查询的表名（生成 INSERT 用）；猜不出给 `表名`。 */
export function guessTable(sql: string): string {
  const m = /\bfrom\s+([A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)?)/i.exec(sql);
  return m ? m[1] : "表名";
}

/** 浏览器下载一个文本文件（导出 CSV 用；带 BOM，Excel 打开中文不乱码）。 */
export function downloadText(name: string, text: string, mime = "text/csv"): void {
  const blob = new Blob(["﻿", text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
