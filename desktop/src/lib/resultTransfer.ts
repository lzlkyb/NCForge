import type { Cell, ColumnMeta } from "./dbApi";
import { isTransferNumericType, serializeTransferSql, validateTransferSql } from "./resultTransferSql";

export type TransferFormat = "tsv" | "csv" | "json" | "jsonl" | "markdown" | "html" | "insert" | "where" | "update" | "xlsx";
export interface TransferOptions {
  format: TransferFormat;
  header: "name" | "zh" | "both" | "none";
  nullText: string;
  delimiter: string;
  lineEnding: "lf" | "crlf";
  bom: boolean;
  spreadsheetSafe: boolean;
  transpose: boolean;
  jsonStructure: "objects" | "columns";
  table: string;
  schema: string;
  /** Keys and selected columns always index the original columns, before projection. */
  keys: number[];
  keysConfirmed: boolean;
  /** An empty list selects every column. */
  columnIndices: number[];
  /** Chinese labels indexed by the original columns. */
  columnLabels: string[];
  includeQuery: boolean;
  nc: boolean;
  commitEvery: number;
  condition?: "in" | "notIn" | "where";
  includeNull?: boolean;
}
export interface TransferData {
  columns: ColumnMeta[];
  rows: Cell[][];
  originalRows?: Cell[][];
  query?: string;
}

export function defaultTransferOptions(format: TransferFormat = "tsv"): TransferOptions {
  return {
    format, header: "name", nullText: "", delimiter: format === "tsv" ? "\t" : ",",
    lineEnding: format === "csv" ? "crlf" : "lf", bom: format === "csv", spreadsheetSafe: true,
    transpose: false, jsonStructure: "objects", table: "", schema: "", keys: [], keysConfirmed: false,
    columnIndices: [], columnLabels: [], includeQuery: false, nc: false, commitEvery: 0,
    condition: "in", includeNull: false,
  };
}

export function transferColumnIndices(data: TransferData, options: TransferOptions): number[] {
  return options.columnIndices.length ? options.columnIndices : data.columns.map((_, i) => i);
}

const sqlFormat = (format: TransferFormat) => ["insert", "update", "where"].includes(format);

export function validateTransfer(data: TransferData, options: TransferOptions): string | null {
  if (!data.columns.length) return "没有可输出的列";
  const indices = transferColumnIndices(data, options);
  if (indices.some(i => !Number.isInteger(i) || i < 0 || i >= data.columns.length)) return "选择的列索引无效";
  if (new Set(indices).size !== indices.length) return "选择的列不能重复";
  if (data.rows.some(row => indices.some(i => i >= row.length))) return "结果行缺少选中列的原始值";
  if (data.rows.some(row => indices.some(i => typeof row[i] === "number" && (!Number.isFinite(row[i]) || (Number.isInteger(row[i]) && !Number.isSafeInteger(row[i])))))) {
    return "存在已超出 JavaScript 安全精度的数值，请重新读取为字符串后输出";
  }
  if ((options.format === "tsv" || options.format === "csv") && (!options.delimiter || /["\r\n]/.test(options.delimiter))) return "分隔符不能为空或包含引号、换行";
  if (options.transpose && !["tsv", "csv", "markdown", "html", "xlsx"].includes(options.format)) return "此格式不支持转置，请选择表格格式";
  if (options.nc) return "NC 转换需要使用 NC INSERT 迁移入口，通用输出不会改写多语字段";
  if (!Number.isInteger(options.commitEvery) || options.commitEvery < 0) return "提交间隔必须为非负整数";
  return sqlFormat(options.format) ? validateTransferSql(data, options, indices) : null;
}

/** Keep codes and precision beyond Excel's 15 digits as text in the spreadsheet preset. */
function safeSpreadsheetText(value: string): string {
  const start = value.replace(/^[ \t\r\n]+/, "");
  if (/^[=@]/.test(start) || /^[+-]/.test(start) && !Number.isFinite(Number(start))) return `'${value}`;
  const trimmed = value.trim();
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) {
    const mantissa = trimmed.replace(/^[+-]/, "").split(/[eE]/)[0];
    const digits = mantissa.replace(".", "").replace(/^0+/, "");
    if (/^0\d/.test(mantissa) || digits.length > 15 || !Number.isFinite(Number(trimmed))) return `'${value}`;
  }
  return value;
}

function jsonCell(value: Cell, column: ColumnMeta): Cell {
  if (typeof value !== "string" || !isTransferNumericType(column.type)) return value;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  if (!/[.eE]/.test(value)) return Number.isSafeInteger(number) ? number : value;
  const digits = value.replace(/^-/, "").split(/[eE]/)[0].replace(".", "").replace(/^0+/, "");
  return digits.length <= 15 && (number !== 0 || !/[1-9]/.test(digits)) && (!Number.isInteger(number) || Number.isSafeInteger(number)) ? number : value;
}

/** Reserve original names before suffixing duplicates so an existing ID_2 cannot be lost. */
export function transferJsonKeys(columns: ColumnMeta[]): string[] {
  const reserved = new Set(columns.map(c => c.name));
  const used = new Set<string>();
  return columns.map(column => {
    let key = column.name;
    if (used.has(key)) {
      let suffix = 2;
      do { key = `${column.name}_${suffix++}`; } while (used.has(key) || reserved.has(key));
    }
    used.add(key);
    return key;
  });
}

function headerRows(data: TransferData, options: TransferOptions, indices: number[]): string[][] {
  const names = indices.map(i => data.columns[i].name);
  const labels = indices.map(i => options.columnLabels[i]?.trim() || data.columns[i].name);
  switch (options.header) {
    case "none": return [];
    case "zh": return [labels];
    case "both": return [names, labels];
    default: return [names];
  }
}

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const escapeMarkdown = (value: string) => escapeHtml(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");

function tableText(data: TransferData, options: TransferOptions, indices: number[]): string {
  const eol = options.lineEnding === "crlf" ? "\r\n" : "\n";
  let headers = headerRows(data, options, indices);
  let rows = data.rows.map(row => indices.map(i => row[i] == null ? options.nullText : String(row[i])));
  if (options.transpose) {
    const matrix = [...headers, ...rows];
    rows = indices.map((_, i) => matrix.map(row => row[i]));
    headers = [];
  }
  if (options.format === "csv" || options.format === "tsv") {
    const field = (value: string) => {
      const text = options.spreadsheetSafe ? safeSpreadsheetText(value) : value;
      return text.includes(options.delimiter) || /["\r\n]/.test(text) || text !== value
        ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [...headers, ...rows].map(row => row.map(field).join(options.delimiter)).join(eol);
  }
  if (options.format === "html") {
    const rowHtml = (row: string[], tag: "th" | "td") => `<tr>${row.map(value => `<${tag}>${escapeHtml(value).replace(/\r\n|\r|\n/g, "<br>")}</${tag}>`).join("")}</tr>`;
    const query = options.includeQuery && data.query ? `<caption>${escapeHtml(data.query)}</caption>` : "";
    return `<table>${query}${headers.length ? `<thead>${headers.map(row => rowHtml(row, "th")).join("")}</thead>` : ""}<tbody>${rows.map(row => rowHtml(row, "td")).join("")}</tbody></table>`;
  }
  const width = options.transpose ? (rows[0]?.length ?? 0) : indices.length;
  const head = headers.length ? headers[0].map((value, i) => headers.map(row => escapeMarkdown(row[i] ?? value)).join("<br>")) : Array.from({ length: width }, () => "");
  const markdownRow = (row: string[]) => `| ${row.join(" | ")} |`;
  const separator = Array.from({ length: width }, (_, i) => !options.transpose && isTransferNumericType(data.columns[indices[i]].type) ? "---:" : "---");
  return [markdownRow(head), markdownRow(separator), ...rows.map(row => markdownRow(row.map(escapeMarkdown)))].join(eol);
}

export function serializeTransfer(data: TransferData, options: TransferOptions): string {
  const error = validateTransfer(data, options);
  if (error) throw new Error(error);
  if (options.format === "xlsx") throw new Error("XLSX 需要保存文件，由后端生成真实工作簿");
  const indices = transferColumnIndices(data, options);
  if (sqlFormat(options.format)) return serializeTransferSql(data, options, indices);
  if (options.format === "json" || options.format === "jsonl") {
    const columns = indices.map(i => data.columns[i]);
    const rows = data.rows.map(row => indices.map((i, j) => jsonCell(row[i], columns[j])));
    const keys = transferJsonKeys(columns);
    const objects = rows.map(row => Object.fromEntries(keys.map((key, i) => [key, row[i]])));
    const payload = options.jsonStructure === "columns" ? { columns: columns.map(c => c.name), rows } : objects;
    if (options.format === "jsonl") {
      const eol = options.lineEnding === "crlf" ? "\r\n" : "\n";
      // Each columns-mode line carries its own mapping so it remains independently readable.
      return rows.map((row, i) => JSON.stringify(options.jsonStructure === "columns" ? { columns: columns.map(c => c.name), row } : objects[i])).join(eol);
    }
    return JSON.stringify(payload, null, 2).replace(/\n/g, options.lineEnding === "crlf" ? "\r\n" : "\n");
  }
  const text = tableText(data, options, indices);
  if (options.format === "html") return `<meta charset="utf-8">${text}`;
  return options.bom && (options.format === "csv" || options.format === "tsv") ? `\uFEFF${text}` : text;
}

export function transferMime(format: TransferFormat): string {
  if (format === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (format === "json") return "application/json";
  if (format === "jsonl") return "application/x-ndjson";
  if (format === "html") return "text/html";
  if (format === "csv") return "text/csv";
  if (format === "tsv") return "text/tab-separated-values";
  if (format === "markdown") return "text/markdown";
  return "text/plain";
}

export function transferExtension(format: TransferFormat): string {
  return sqlFormat(format) ? "sql" : format === "markdown" ? "md" : format;
}
